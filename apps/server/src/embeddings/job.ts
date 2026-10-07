import type pg from 'pg';
import { z } from 'zod';
import { FOREVER } from '../ai/breaker.js';
import { embedValues } from '../ai/call.js';
import type { AiDeps } from '../ai/routes.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { JobQueue } from '../jobs/queue.js';
import type { SystemJobDeps } from '../jobs/system.js';
import {
  embeddingsSource,
  MAX_STORED_DIMS,
  modelKeyOf,
  requestedDims,
  vectorLiteral,
} from './provider.js';

// `embed-thing` (D200, D206; step-6 plan T14), aggregated by jobs/step6.ts: a thing's embedding
// after a create or an edit that changes what it is embedded from. A tenant job sent in the
// write's transaction (enqueueEmbed), debounced per thing, run in the editor's scope; `data` holds
// only `{thingId}` and the handler re-reads everything under row-level security (jobs/boss.ts).
//
// 1. The source is `provider` (provider.ts), the thing is live and visible, and its location's
//    cascade has an embeddings model (else the location is keyword-only: nothing to do).
// 2. Its text and hash from `kept.embedding_backlog_thing` (0099; the SQL builds the text: never a
//    secret or money, D116, D200); nothing to do when its vector is current.
// 3. `embedValues` (`embed_thing`, the thing linked, the editor as the user) with no transaction
//    open (D166), then `kept.embedding_store`.
// 4. A cap pause is left to the hourly backfill (it resumes once the cap resets, D206); a
//    provider's wait sends the job again for when it ends, no attempt spent; a retryable failure
//    throws for pg-boss's retries. Never an error the person sees: search stays on keywords.

export const EMBED_THING_JOB = 'embed-thing';
/** The debounce: one job per thing per slot, starting once more edits had time to land. */
export const EMBED_DEBOUNCE_SECONDS = 30;
const Data = z.object({ thingId: z.uuid() });

export type EmbedThingDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  ai: AiDeps | null;
  /** Sends the job again for `startAfter` (a provider's wait), on the given transaction. */
  sendLater?: (client: pg.ClientBase, thingId: string, startAfter: Date) => Promise<void>;
};

export type EmbedThingOutcome =
  | { status: 'stored'; modelKey: string; dims: number }
  | {
      status: 'skipped';
      why: 'off' | 'no_ai' | 'missing' | 'keyword_only' | 'current' | 'too_long';
    }
  | { status: 'paused'; kind: 'cap' | 'provider'; until: Date; resent: boolean }
  | { status: 'failed'; errorCode: string };

/** A failure pg-boss retries (the job's policy). */
export class RetryEmbed extends Error {
  constructor(readonly code: string) {
    super(`embed-thing will be retried: ${code}`);
    this.name = 'RetryEmbed';
  }
}

/** Enqueues a thing's embedding on the write's own scoped transaction, debounced per thing. */
export async function enqueueEmbed(
  jobs: JobQueue | null,
  client: pg.ClientBase,
  thingId: string,
): Promise<void> {
  await jobs?.sendTenant(
    client,
    EMBED_THING_JOB,
    { thingId },
    {
      singletonKey: `embed:${thingId}`,
      singletonSeconds: EMBED_DEBOUNCE_SECONDS,
      startAfter: EMBED_DEBOUNCE_SECONDS,
    },
  );
}

/** Embeds one thing as `scope`; see the header. */
export async function embedThing(
  deps: EmbedThingDeps,
  scope: Scope,
  thingId: string,
  job?: JobMeta,
): Promise<EmbedThingOutcome> {
  if ((await embeddingsSource(deps.pools)) !== 'provider') return { status: 'skipped', why: 'off' };
  if (!deps.ai) return { status: 'skipped', why: 'no_ai' };
  const id = thingId.toLowerCase();

  const located = await withScope(deps.pools.app, scope, async (_tx, client) => {
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return rows[0]?.location_id ?? null;
  });
  if (!located) return { status: 'skipped', why: 'missing' };

  const rt = await deps.ai.runtime(scope);
  const resolved = await rt.keys.resolve({
    locationId: located,
    userId: scope.userId,
    task: 'embeddings',
  });
  if (!resolved) return { status: 'skipped', why: 'keyword_only' };
  const modelKey = modelKeyOf(resolved);

  const pending = await withScope(deps.pools.app, scope, async (_tx, client) => {
    const { rows } = await client.query<{ thing_id: string; text: string; content_hash: string }>(
      'SELECT thing_id, text, content_hash FROM kept.embedding_backlog_thing($1, $2)',
      [id, modelKey],
    );
    return rows[0] ?? null;
  });
  if (!pending || pending.text === '') return { status: 'skipped', why: 'current' };

  const requestId = (job?.id ?? `embed:${id}`).slice(0, 64);
  const dims = requestedDims(resolved);
  const result = await embedValues(rt, {
    resolved,
    task: 'embed_thing',
    locationId: located,
    userId: scope.userId,
    links: { thingId: id },
    values: [pending.text],
    ...(dims ? { dimensions: dims } : {}),
    requestId,
    attempt: Math.min(20, (job?.retryCount ?? 0) + 1),
    jobId: job?.id ?? requestId,
  });

  if (result.status === 'paused') {
    const endless = result.until.getTime() >= FOREVER.getTime();
    const send = deps.sendLater;
    if (result.kind === 'provider' && !endless && send) {
      await withScope(deps.pools.app, scope, (_tx, client) => send(client, id, result.until));
      return { status: 'paused', kind: 'provider', until: result.until, resent: true };
    }
    return { status: 'paused', kind: result.kind, until: result.until, resent: false };
  }
  if (result.status === 'failed') {
    if (result.retryable && job && job.retryCount < job.retryLimit) {
      throw new RetryEmbed(result.errorCode);
    }
    return { status: 'failed', errorCode: result.errorCode };
  }
  const vector = result.vectors[0];
  if (!vector || vector.length === 0 || vector.length > MAX_STORED_DIMS) {
    return { status: 'skipped', why: 'too_long' };
  }
  await withScope(deps.pools.app, scope, async (_tx, client) => {
    await client.query('SELECT kept.embedding_store($1, $2, $3)', [
      located,
      modelKey,
      JSON.stringify([
        { thing_id: id, content_hash: pending.content_hash, embedding: vectorLiteral(vector) },
      ]),
    ]);
  });
  return { status: 'stored', modelKey, dims: vector.length };
}

export function embedThingJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: EMBED_THING_JOB,
      kind: 'tenant',
      policy: JOB_POLICIES[EMBED_THING_JOB],
      handler: async ({ data, scope, client, job }) => {
        const parsed = Data.safeParse(data);
        if (!parsed.success) throw new Error('embed-thing: data names no thing');
        const app = deps.pools.app;
        if (!app) throw new Error('embed-thing: the worker has no kept_app pool');
        // runJob() holds this scoped transaction open, unused, while each step commits on its own
        // connection around a provider call of up to 80 s.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '100s'`);
        const send = deps.sendTenant;
        const outcome = await embedThing(
          {
            pools: { app, system: deps.pools.system },
            ai: deps.ai ?? null,
            ...(send
              ? {
                  sendLater: (c: pg.ClientBase, thingId: string, startAfter: Date) =>
                    send(c, EMBED_THING_JOB, { thingId }, { startAfter }),
                }
              : {}),
          },
          scope,
          parsed.data.thingId,
          job,
        );
        deps.log.info({ thingId: parsed.data.thingId, outcome: outcome.status }, 'thing embedded');
      },
    }),
  ];
}
