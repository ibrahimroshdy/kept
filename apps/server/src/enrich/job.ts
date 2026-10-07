/**
 * The `enrich-aliases` tenant job (D41, D69, D214; step-7 plan T15, Q21; spike E1). Sent by
 * POST /api/v1/imports/:id/enrich in the requester's scope, with `{runId, jobId}` only; each run
 * of the job is **one batch, one model call** (its policy is extraction's: 90 s, two retries),
 * and it sends itself again for the next batch with the id it stopped after. The run's state is
 * `import_runs.inspect.enrich` (no migration: the run's own summary column, kept_app's to write
 * for the location's owners and admins), which the estimate route answers with.
 *
 * Each batch:
 * 1. **Claim** (one short transaction): the run under the requester's row-level security (an
 *    owner or admin of its location, D180 re-checked every batch), `inspect.enrich.jobId` still
 *    this chain's (a new POST supersedes it), AI capture still `on` for them in the location. The
 *    next things after the cursor that still have no alias in the location's languages. None:
 *    `done`.
 * 2. **The call** through callModel (ai/call.ts) with the ledger task `enrich_aliases`: the
 *    reservation, pacing, caps, one ledger row. No transaction open (D166).
 * 3. **The outcome**, in one transaction:
 *    - ok → per answered index (never an id, L51): prompt.ts's checks, checks.ts `cleanAliases`
 *      and D214's `scriptAliases`; Latin-script aliases written where the thing still has none
 *      in that language (auto-accepted, D19), audited `thing.enrich`; the one alias of another
 *      script waits in the inbox as the thing's `alias_<lang>` suggestion (D214). Then the next
 *      batch is sent.
 *    - a cap → `paused` with its date ("AI paused until …"), the batch sent again for that date;
 *      a manual pause has no date and waits for a new POST. The provider's own wait → the same,
 *      `waiting` (never shown as paused, D206).
 *    - a retryable failure → thrown while pg-boss retries remain; after them, and for a final
 *      failure (`truncated`, `schema_invalid`…), the batch is skipped and counted, and the run
 *      continues with the next.
 */
import { aliasSuggestionField, can, newId, normalize, type Role } from '@kept/shared';
import type pg from 'pg';
import { FOREVER } from '../ai/breaker.js';
import { type CallResult, callModel } from '../ai/call.js';
import type { AiDeps } from '../ai/routes.js';
import { actorOf } from '../audit/actor.js';
import { auditedMany } from '../audit/audited.js';
import { aiCaptureState } from '../capture/service.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { cleanAliases, scriptAliases } from '../extraction/checks.js';
import { languagesOf } from '../extraction/job.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { type PendingThing, pendingThings, planCall } from './estimate.js';
import {
  batchSize,
  ENRICH_PROMPT_VERSION,
  ENRICH_WIRE_NAME,
  enrichResolved,
  enrichSchema,
  parseAnswer,
  screenAliases,
} from './prompt.js';

export const ENRICH_JOB = 'enrich-aliases';

export type EnrichJobData = { runId: string; jobId: string; after?: string | null };

/** `import_runs.inspect.enrich`: where a run's enrichment stands. */
export type EnrichState = {
  jobId: string;
  status: 'running' | 'paused' | 'waiting' | 'done' | 'failed';
  /** Things without aliases when it started. */
  things: number;
  /** Things sent so far (answered or not). */
  processed: number;
  /** Things that gained aliases, and things with a suggestion waiting in the inbox. */
  aliases: number;
  suggested: number;
  /** Batches whose call failed for good, skipped (their things keep no aliases). */
  failedBatches: number;
  pausedUntil: string | null;
  reason: string | null;
  startedAt: string;
  updatedAt: string;
};

export type EnrichJobDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  ai: AiDeps | null;
  /** Sends the job again on the given scoped transaction: the next batch now, or a paused one
   * for when its pause ends. */
  send: (client: pg.ClientBase, data: EnrichJobData, startAfter: Date) => Promise<void>;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

export type BatchOutcome =
  | { status: 'stopped'; why: 'missing' | 'superseded' | 'not_running' }
  | { status: 'done' | 'failed'; reason?: string }
  | { status: 'applied'; things: number; aliases: number; suggested: number; refused: number }
  | { status: 'skipped'; reason: string }
  | { status: 'paused' | 'waiting'; until: Date; reason: string; resent: boolean };

/** Thrown for pg-boss to retry the batch. */
export class RetryEnrichment extends Error {
  constructor(readonly reason: string) {
    super(`enrichment batch will be retried: ${reason}`);
    this.name = 'RetryEnrichment';
  }
}

type RunRow = { id: string; location_id: string | null; enrich: EnrichState | null };

export async function readEnrichRun(
  client: pg.ClientBase,
  runId: string,
  lock = false,
): Promise<RunRow | null> {
  const { rows } = await client.query<RunRow>(
    `SELECT id, location_id, inspect -> 'enrich' AS enrich
       FROM public.import_runs WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [runId],
  );
  return rows[0] ?? null;
}

export async function writeEnrichState(
  client: pg.ClientBase,
  runId: string,
  state: EnrichState,
): Promise<void> {
  await client.query(
    `UPDATE public.import_runs
        SET inspect = jsonb_set(coalesce(inspect, '{}'::jsonb), '{enrich}', $2::jsonb)
      WHERE id = $1`,
    [runId, JSON.stringify({ ...state, updatedAt: new Date().toISOString() })],
  );
}

export async function roleIn(client: pg.ClientBase, locationId: string): Promise<Role | null> {
  const { rows } = await client.query<{ role: Role }>(
    `SELECT role FROM public.memberships
      WHERE location_id = $1 AND user_id = kept.current_user_id()
        AND (expires_at IS NULL OR expires_at > now())`,
    [locationId],
  );
  return rows[0]?.role ?? null;
}

type Claimed = {
  locationId: string;
  state: EnrichState;
  languages: string[];
  things: PendingThing[];
};

async function claim(
  deps: EnrichJobDeps,
  scope: Scope,
  data: EnrichJobData,
): Promise<Claimed | BatchOutcome> {
  return withScope(deps.pools.app, scope, async (tx, client) => {
    const run = await readEnrichRun(client, data.runId, true);
    if (!run?.location_id) return { status: 'stopped', why: 'missing' } as const;
    const state = run.enrich;
    if (state?.jobId !== data.jobId) return { status: 'stopped', why: 'superseded' } as const;
    if (state.status === 'done' || state.status === 'failed') {
      return { status: 'stopped', why: 'not_running' } as const;
    }
    const role = await roleIn(client, run.location_id);
    const permitted = role !== null && can(role, 'location.export-import');
    const on =
      permitted &&
      deps.ai !== null &&
      (await aiCaptureState(tx, client, run.location_id, role as Role)) === 'on';
    if (!on) {
      const reason = permitted ? 'no_provider' : 'not_permitted';
      await writeEnrichState(client, run.id, { ...state, status: 'failed', reason });
      return { status: 'failed', reason } as const;
    }
    const languages = await languagesOf(client, run.location_id);
    const things = await pendingThings(client, run.id, languages, {
      after: data.after ?? null,
      limit: batchSize(languages),
    });
    if (things.length === 0) {
      await writeEnrichState(client, run.id, {
        ...state,
        status: 'done',
        pausedUntil: null,
        reason: state.failedBatches > 0 ? state.reason : null,
      });
      return { status: 'done' } as const;
    }
    const running: EnrichState = { ...state, status: 'running', pausedUntil: null };
    await writeEnrichState(client, run.id, running);
    return { locationId: run.location_id, state: running, languages, things };
  });
}

const retriesLeft = (job: JobMeta | undefined) =>
  job !== undefined && job.retryCount < job.retryLimit;

type Answer = Map<number, Record<string, string[]>>;
type AuditEvent = Parameters<typeof auditedMany>[1][number];

/** Writes one batch's answers as the requester; returns what landed. */
async function applyAnswers(
  client: pg.ClientBase,
  tx: Tx,
  scope: Scope,
  c: Claimed,
  answer: Answer,
  requestId: string,
): Promise<{ aliases: number; suggested: number; refused: number }> {
  let aliases = 0;
  let suggested = 0;
  let refused = 0;
  const events: AuditEvent[] = [];
  for (const [i, raw] of answer) {
    const thing = c.things[i - 1];
    if (!thing) continue; // an index outside the batch
    const screened = screenAliases(raw, thing.name);
    refused += screened.refused;
    const scripted = scriptAliases(cleanAliases(screened.aliases, c.languages), 1);
    const { rows } = await client.query<{ aliases: Record<string, string[]> }>(
      'SELECT aliases FROM public.things WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [thing.id],
    );
    const have = rows[0]?.aliases;
    if (!have) continue;
    // Only where the thing has none in that language (a person may have typed some meanwhile).
    const add = Object.fromEntries(
      Object.entries(scripted.aliases).filter(([lang]) => !(have[lang]?.length ?? 0)),
    );
    if (Object.keys(add).length > 0) {
      const after = { ...have, ...add };
      await client.query('UPDATE public.things SET aliases = $2 WHERE id = $1', [
        thing.id,
        JSON.stringify(after),
      ]);
      aliases += 1;
      events.push({
        locationId: c.locationId,
        actor: actorOf(scope),
        action: 'thing.enrich',
        entity: { type: 'thing', id: thing.id },
        before: { aliases: have },
        after: { aliases: after },
        rootThingId: thing.id,
        subjects: [thing.id],
        requestId,
      });
    }
    // D214: another script's one alias waits in the inbox, unless the thing has it already.
    const waiting = scripted.suggestions.filter(
      (s) => !(have[s.lang] ?? []).some((a) => normalize(a) === normalize(s.value)),
    );
    if (waiting.length > 0 && (await suggest(client, c.locationId, thing.id, waiting))) {
      suggested += 1;
    }
  }
  if (events.length > 0) await auditedMany(tx, events);
  return { aliases, suggested, refused };
}

/** Adds alias suggestions to the thing's open `draft` inbox item, or opens one (no extraction:
 * the suggestions carry no source). One already there for the same field stays. */
async function suggest(
  client: pg.ClientBase,
  locationId: string,
  thingId: string,
  waiting: { lang: string; value: string; confidence: number }[],
): Promise<boolean> {
  const { rows } = await client.query<{ id: string; payload: { suggestions?: unknown } }>(
    `SELECT id, payload FROM public.inbox_items
      WHERE kind = 'draft' AND thing_id = $1 AND resolved_at IS NULL FOR UPDATE`,
    [thingId],
  );
  const open = rows[0];
  const existing = Array.isArray(open?.payload.suggestions)
    ? (open.payload.suggestions as { field?: unknown }[])
    : [];
  const fields = new Set(existing.map((s) => s.field));
  const added = waiting
    .map((s) => ({ field: aliasSuggestionField(s.lang), value: s.value, confidence: s.confidence }))
    .filter((s) => !fields.has(s.field));
  if (added.length === 0) return false;
  if (open) {
    await client.query(
      `UPDATE public.inbox_items
          SET payload = payload || jsonb_build_object('suggestions', $2::jsonb)
        WHERE id = $1`,
      [open.id, JSON.stringify([...existing, ...added])],
    );
    return true;
  }
  await client.query(
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, created_by, payload)
     VALUES ($1, $2, 'draft', $3, kept.current_user_id(), $4)`,
    [newId(), locationId, thingId, JSON.stringify({ suggestions: added })],
  );
  return true;
}

/** One batch of the chain `data.jobId`, in `scope`. */
export async function runEnrichBatch(
  deps: EnrichJobDeps,
  scope: Scope,
  data: EnrichJobData,
  job?: JobMeta,
): Promise<BatchOutcome> {
  const claimed = await claim(deps, scope, data);
  if ('status' in claimed) return claimed;
  const ai = deps.ai as AiDeps;
  const last = (claimed.things.at(-1) as PendingThing).id;
  const next: EnrichJobData = { runId: data.runId, jobId: data.jobId, after: last };
  const requestId = (job?.id ?? `enrich:${data.jobId}`).slice(0, 64);
  const state = claimed.state;

  let result: CallResult<Answer> | null;
  try {
    const rt = await ai.runtime(scope);
    const resolved = await rt.keys.resolve({
      locationId: claimed.locationId,
      userId: scope.userId,
      task: 'extraction',
    });
    if (!resolved) {
      result = null;
    } else {
      const call = planCall(resolved, claimed.things, claimed.languages);
      result = await callModel<Answer>(rt, {
        resolved: enrichResolved(resolved),
        task: 'enrich_aliases',
        locationId: claimed.locationId,
        userId: scope.userId,
        links: {},
        instructions: call.system,
        text: call.text,
        images: [],
        output: {
          name: ENRICH_WIRE_NAME,
          schema: enrichSchema(claimed.languages),
          parse: (raw) => parseAnswer(raw),
        },
        maxOutputTokens: call.maxOutputTokens,
        expectedOutputTokens: call.expectedOutputTokens,
        promptVersion: ENRICH_PROMPT_VERSION,
        requestId,
        attempt: Math.min(20, (job?.retryCount ?? 0) + 1),
        jobId: job?.id ?? data.jobId,
      });
    }
  } catch (e) {
    deps.log.error({ err: e, runId: data.runId }, 'enrichment batch failed before a result');
    if (retriesLeft(job)) throw e;
    result = {
      status: 'failed',
      outcome: 'provider_error',
      errorCode: 'internal',
      retryable: false,
      callId: '',
    };
  }

  if (result === null) {
    await withScope(deps.pools.app, scope, (_tx, client) =>
      writeEnrichState(client, data.runId, { ...state, status: 'failed', reason: 'no_provider' }),
    );
    return { status: 'failed', reason: 'no_provider' };
  }
  if (result.status === 'paused') {
    const status = result.kind === 'cap' ? 'paused' : 'waiting';
    const endless = result.until.getTime() >= FOREVER.getTime();
    const paused = result;
    await withScope(deps.pools.app, scope, async (_tx, client) => {
      await writeEnrichState(client, data.runId, {
        ...state,
        status,
        pausedUntil: endless ? null : paused.until.toISOString(),
        reason: paused.reason,
      });
      // The same batch again when the pause ends (the cursor hasn't moved).
      if (!endless) await deps.send(client, data, paused.until);
    });
    return { status, until: result.until, reason: result.reason, resent: !endless };
  }
  if (result.status === 'failed') {
    if (result.retryable && retriesLeft(job)) throw new RetryEnrichment(result.outcome);
    // A batch that fails for good (a length stop, a schema miss…) is skipped; the run goes on.
    const reason = result.outcome;
    const moved = await withScope(deps.pools.app, scope, async (_tx, client) => {
      const run = await readEnrichRun(client, data.runId, true);
      if (run?.enrich?.jobId !== data.jobId) return false;
      await writeEnrichState(client, data.runId, {
        ...state,
        processed: state.processed + claimed.things.length,
        failedBatches: state.failedBatches + 1,
        reason,
      });
      await deps.send(client, next, new Date());
      return true;
    });
    return moved ? { status: 'skipped', reason } : { status: 'stopped', why: 'superseded' };
  }

  const answer = result.value;
  const landed = await withScope(deps.pools.app, scope, async (tx, client) => {
    const run = await readEnrichRun(client, data.runId, true);
    if (run?.enrich?.jobId !== data.jobId) return null;
    const out = await applyAnswers(client, tx, scope, claimed, answer, requestId);
    await writeEnrichState(client, data.runId, {
      ...state,
      processed: state.processed + claimed.things.length,
      aliases: state.aliases + out.aliases,
      suggested: state.suggested + out.suggested,
    });
    await deps.send(client, next, new Date());
    return out;
  });
  if (!landed) return { status: 'stopped', why: 'superseded' };
  return { status: 'applied', things: claimed.things.length, ...landed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `enrich-aliases` job, aggregated by jobs/portability.ts. */
export function enrichJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: ENRICH_JOB,
      kind: 'tenant',
      policy: JOB_POLICIES['enrich-aliases'],
      handler: async ({ data, scope, client, job }) => {
        const d = (data ?? {}) as Partial<EnrichJobData>;
        if (typeof d.runId !== 'string' || !UUID.test(d.runId)) {
          throw new Error('enrich-aliases: data names no import run');
        }
        if (typeof d.jobId !== 'string' || !UUID.test(d.jobId)) {
          throw new Error('enrich-aliases: data names no chain');
        }
        if (d.after != null && (typeof d.after !== 'string' || !UUID.test(d.after))) {
          throw new Error('enrich-aliases: a bad cursor');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('enrich-aliases: the worker has no kept_app pool');
        const send = deps.sendTenant;
        // runJob() holds this scoped transaction open, unused, while each step commits on its
        // own connection; the model call may take up to 80 s (§3.5).
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '180s'`);
        const outcome = await runEnrichBatch(
          {
            pools: { app, system: deps.pools.system },
            ai: deps.ai ?? null,
            send: async (c, next, startAfter) => {
              if (!send) throw new Error('enrich-aliases: the worker cannot send jobs');
              await send(c, ENRICH_JOB, next, { startAfter });
            },
            log: deps.log,
          },
          scope,
          {
            runId: d.runId.toLowerCase(),
            jobId: d.jobId.toLowerCase(),
            after: d.after?.toLowerCase() ?? null,
          },
          job,
        );
        deps.log.info({ runId: d.runId, outcome: outcome.status }, 'enrichment batch ran');
      },
    }),
  ];
}
