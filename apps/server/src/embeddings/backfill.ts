import { EMBED_BATCH_MAX } from '@kept/shared';
import type pg from 'pg';
import { FOREVER } from '../ai/breaker.js';
import { embedValues } from '../ai/call.js';
import { resolveForSystem } from '../ai/db-keys.js';
import type { AiDeps } from '../ai/routes.js';
import type { Keyring } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import {
  embeddingsSource,
  MAX_STORED_DIMS,
  modelKeyOf,
  requestedDims,
  vectorLiteral,
} from './provider.js';

// The embeddings backfill (D200, D206, D207; step-6 plan T14), aggregated by jobs/step6.ts:
// `embed-backfill`, a system job hourly at :30 UTC and on demand (the admin's source switch sends
// it, routes.ts), as kept_system.
//
// Per location (every live one whose last pause has ended: `kept.embedding_backfill_locations`):
// 1. its payer for `embeddings` through `kept.ai_provider_for_system` ("Kept (background)", the
//    ledger row's user is null, D206). None anywhere in the cascade: keyword-only, marked so.
// 2. batches of EMBED_BATCH_MAX from `kept.embedding_backlog` (missing vectors first; a model
//    change makes every thing pending, since the backlog compares per model key), each one
//    `embedValues` request with no transaction open, then `kept.embedding_store`.
// 3. A cap pause stops that location (its payer is paused) and is marked; the next hourly run
//    resumes once the cap resets. A provider's wait or a failure stops the location too.
// 4. `kept.embedding_mark` records the model, the pending count (up to the backlog's scan) and
//    the pause's reason and end (`paused_until`; none for an endless one), for the status page
//    (status.ts); the next runs skip the location until that end.
// The run stops at its time budget, well inside the job's expiry; the next run carries on.

export const EMBED_BACKFILL_JOB = 'embed-backfill';
/** How much of one hourly run the backfill may use. */
export const BACKFILL_BUDGET_MS = 30 * 60_000;
/** Batches per location per run: a big location doesn't starve the rest. */
export const BATCHES_PER_LOCATION = 40;
/** The pending count is read up to this many (the door's own cap). */
const PENDING_SCAN = 500;

export type BackfillDeps = {
  pools: Pick<Pools, 'system'>;
  ai: AiDeps | null;
  /** The keyring that opens provider keys (crypto/keyring.ts). */
  keyring: () => Keyring;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** Wall-clock milliseconds, for the run's budget (tests). */
  clock?: () => number;
  budgetMs?: number;
  batchSize?: number;
};

export type LocationOutcome = {
  locationId: string;
  modelKey: string | null;
  stored: number;
  pending: number;
  stopped: null | 'keyword_only' | 'paused' | 'waiting' | 'failed' | 'budget';
};

type Pending = { thing_id: string; text: string; content_hash: string };

const system = <T>(deps: BackfillDeps, fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(deps.pools.system, (_tx, c) => fn(c));

async function backlog(
  deps: BackfillDeps,
  locationId: string,
  modelKey: string,
  limit: number,
): Promise<Pending[]> {
  return system(deps, async (c) => {
    const { rows } = await c.query<Pending>(
      'SELECT thing_id, text, content_hash FROM kept.embedding_backlog($1, $2, $3)',
      [locationId, modelKey, limit],
    );
    return rows;
  });
}

async function mark(
  deps: BackfillDeps,
  locationId: string,
  modelKey: string | null,
  pending: number,
  reason: string | null,
  until: Date | null = null,
): Promise<void> {
  await system(deps, (c) =>
    c.query('SELECT kept.embedding_mark($1, $2, $3, $4, $5, $6)', [
      locationId,
      modelKey,
      'provider',
      pending,
      reason?.slice(0, 60) ?? null,
      until && until.getTime() < FOREVER.getTime() ? until : null,
    ]),
  );
}

/** Embeds one location's backlog; see the header. */
export async function backfillLocation(
  deps: BackfillDeps,
  locationId: string,
  runId: string,
  deadline: number,
): Promise<LocationOutcome> {
  const clock = deps.clock ?? (() => Date.now());
  const out: LocationOutcome = {
    locationId,
    modelKey: null,
    stored: 0,
    pending: 0,
    stopped: null,
  };
  if (!deps.ai) return { ...out, stopped: 'keyword_only' };
  const resolved = await system(deps, (c) => resolveForSystem(c, deps.keyring(), locationId));
  if (!resolved) {
    await mark(deps, locationId, null, 0, 'keyword_only');
    return { ...out, stopped: 'keyword_only' };
  }
  const modelKey = modelKeyOf(resolved);
  out.modelKey = modelKey;
  // kept_system reads ai_model_prices (0099), so a background embedding is priced.
  const rt = await deps.ai.runtime(null);
  const dims = requestedDims(resolved);
  const size = Math.min(deps.batchSize ?? EMBED_BATCH_MAX, EMBED_BATCH_MAX);
  let reason: string | null = null;
  let until: Date | null = null;

  for (let batch = 0; batch < BATCHES_PER_LOCATION; batch++) {
    if (clock() > deadline) {
      out.stopped = 'budget';
      break;
    }
    const rows = (await backlog(deps, locationId, modelKey, size)).filter((r) => r.text !== '');
    if (rows.length === 0) break;
    const requestId = `${runId}:${locationId}:${batch}`.slice(0, 64);
    const result = await embedValues(rt, {
      resolved,
      task: 'embed_thing',
      locationId,
      userId: null,
      links: {},
      values: rows.map((r) => r.text),
      ...(dims ? { dimensions: dims } : {}),
      requestId,
      attempt: 1,
      jobId: requestId,
    });
    if (result.status === 'paused') {
      out.stopped = result.kind === 'cap' ? 'paused' : 'waiting';
      until = result.until;
      reason =
        result.kind === 'cap'
          ? result.reason
          : result.until.getTime() >= FOREVER.getTime()
            ? `provider_${result.reason}`
            : 'rate_limited';
      break;
    }
    if (result.status === 'failed') {
      out.stopped = 'failed';
      reason = `failed_${result.errorCode}`;
      deps.log.error(
        { locationId, errorCode: result.errorCode, outcome: result.outcome },
        'embeddings backfill failed',
      );
      break;
    }
    const stored = rows.flatMap((r, i) => {
      const v = result.vectors[i];
      return v && v.length > 0 && v.length <= MAX_STORED_DIMS
        ? [{ thing_id: r.thing_id, content_hash: r.content_hash, embedding: vectorLiteral(v) }]
        : [];
    });
    if (stored.length === 0) {
      out.stopped = 'failed';
      reason = 'failed_vector_length';
      break;
    }
    out.stored += await system(deps, async (c) => {
      const { rows: n } = await c.query<{ n: number }>(
        'SELECT kept.embedding_store($1, $2, $3) AS n',
        [locationId, modelKey, JSON.stringify(stored)],
      );
      return n[0]?.n ?? 0;
    });
  }
  out.pending = (await backlog(deps, locationId, modelKey, PENDING_SCAN)).length;
  await mark(deps, locationId, modelKey, out.pending, reason, until);
  return out;
}

/** The locations a backfill visits: live ones, less those still paused (0099). */
async function locationIds(deps: BackfillDeps): Promise<string[]> {
  return system(deps, async (c) => {
    const { rows } = await c.query<{ location_id: string }>(
      'SELECT location_id FROM kept.embedding_backfill_locations()',
    );
    return rows.map((r) => r.location_id);
  });
}

/** One run over every location; answers each location's outcome. */
export async function runBackfill(
  deps: BackfillDeps,
  job?: Pick<JobMeta, 'id'>,
): Promise<LocationOutcome[]> {
  if ((await embeddingsSource(deps.pools)) !== 'provider') return [];
  const clock = deps.clock ?? (() => Date.now());
  const deadline = clock() + (deps.budgetMs ?? BACKFILL_BUDGET_MS);
  const runId = (job?.id ?? `backfill:${new Date().toISOString()}`).slice(0, 40);
  const out: LocationOutcome[] = [];
  for (const id of await locationIds(deps)) {
    if (clock() > deadline) break;
    try {
      out.push(await backfillLocation(deps, id, runId, deadline));
    } catch (err) {
      // One location's trouble (a deleted location, a door's refusal) never stops the rest.
      deps.log.error({ err, locationId: id }, 'embeddings backfill: location skipped');
    }
  }
  return out;
}

export function embedBackfillJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: EMBED_BACKFILL_JOB,
      kind: 'system',
      schedule: '30 * * * *',
      policy: JOB_POLICIES[EMBED_BACKFILL_JOB],
      handler: async (_data, meta) => {
        const keys = deps.secretKeys;
        if (!keys) {
          deps.log.info({}, 'embeddings backfill: no keyring, nothing to do');
          return;
        }
        const outcomes = await runBackfill(
          {
            pools: deps.pools,
            ai: deps.ai ?? null,
            keyring: () => keys.get().keyring,
            log: deps.log,
          },
          meta,
        );
        deps.log.info(
          {
            locations: outcomes.length,
            stored: outcomes.reduce((n, o) => n + o.stored, 0),
            pending: outcomes.reduce((n, o) => n + o.pending, 0),
          },
          'embeddings backfill ran',
        );
      },
    }),
  ];
}
