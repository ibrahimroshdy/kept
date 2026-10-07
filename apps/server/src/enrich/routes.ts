import { COST_SOURCES, newId, PROVIDER_KINDS } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { AiRuntime } from '../ai/call.js';
import type { Resolved } from '../ai/ports.js';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { aiCaptureState } from '../capture/service.js';
import type { Scope, Tx } from '../db/scope.js';
import { languagesOf } from '../extraction/job.js';
import type { KeptApp } from '../http/app.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { gateFor } from '../serialize/gates.js';
import { estimateRun, pendingThings } from './estimate.js';
import { ENRICH_JOB, type EnrichState, readEnrichRun, roleIn, writeEnrichState } from './job.js';

// Step 7: alias enrichment after an import (D41, D69, D206, D214; plan T15, Q21), in the shapes
// of apps/web/src/api/portability/types.ts (`EnrichEstimate`, `EnrichStarted`):
//
// GET  /api/v1/imports/:id/enrich/estimate → EnrichEstimate: the token cost shown first (D69)
// POST /api/v1/imports/:id/enrich          → 202 {jobId}; audited `import.enrich`
//
// Who: the run's location's owners and admins (import runs are theirs alone, 0038/0080: anyone
// else gets 404), with AI capture effective for them there (step 3); otherwise 400
// `ai_unavailable`, and the web makes no offer. Only a `done` run (409 before). The things are
// the run's that have no alias in the location's languages (estimate.ts). The cost is left out
// without a price, or where the money gate hides money (and the caller isn't the payer).
// Answered also, once it has run: `state`, where the enrichment stands (job.ts `EnrichState`),
// with `pausedUntil` for "AI paused until …".
//
// A second POST while one is running (or paused until a time still ahead) is 409; one whose job
// stopped moving for STALE_MINUTES may be started again, and supersedes it.

const STALE_MINUTES = 15;
const Params = z.object({ id: z.uuid() });

const State = z.object({
  jobId: z.string(),
  status: z.enum(['running', 'paused', 'waiting', 'done', 'failed']),
  things: z.number().int(),
  processed: z.number().int(),
  aliases: z.number().int(),
  suggested: z.number().int(),
  failedBatches: z.number().int(),
  pausedUntil: z.string().nullable(),
  reason: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

const Estimate = z.object({
  things: z.number().int(),
  calls: z.number().int(),
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
  cost: z.object({ amount: z.string(), currency: z.string() }).optional(),
  costSource: z.enum(COST_SOURCES),
  payer: z.object({ scope: z.enum(['instance', 'account', 'user']), label: z.string() }),
  provider: z.object({ kind: z.enum(PROVIDER_KINDS), model: z.string() }),
  state: State.optional(),
});
type Estimate = z.infer<typeof Estimate>;

const unavailable = () =>
  new AppError('ai_unavailable', 400, 'Connect AI and turn on AI capture for this location.');

type Ready = {
  runId: string;
  locationId: string;
  languages: string[];
  state: EnrichState | null;
  rt: AiRuntime;
  resolved: Resolved;
};

/** The run, if the caller may enrich it now, with the provider that would pay. */
async function ready(
  deps: InventoryDeps,
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  id: string,
  lock: boolean,
): Promise<Ready> {
  const run = await readEnrichRun(client, id, lock);
  if (!run?.location_id) throw notFound();
  const role = await roleIn(client, run.location_id);
  if (!role) throw notFound();
  if (role !== 'owner' && role !== 'admin') throw forbidden();
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM public.import_runs WHERE id = $1',
    [id],
  );
  if (rows[0]?.status !== 'done') throw conflict('Finish the import first.');
  if (!deps.ai || (await aiCaptureState(tx, client, run.location_id, role)) !== 'on') {
    throw unavailable();
  }
  const rt = await deps.ai.runtime(scope);
  const resolved = await rt.keys.resolve({
    locationId: run.location_id,
    userId: scope.userId,
    task: 'extraction',
  });
  if (!resolved) throw unavailable();
  return {
    runId: run.id,
    locationId: run.location_id,
    languages: await languagesOf(client, run.location_id),
    state: run.enrich,
    rt,
    resolved,
  };
}

/** "paid by …" as the AI line says it (extraction/routes.ts callSummaryOf). */
async function payerLabel(client: pg.ClientBase, r: Ready): Promise<string> {
  const p = r.resolved.payer;
  if (p.scope === 'instance') return '';
  if (p.scope === 'account') {
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM public.locations WHERE id = $1',
      [r.locationId],
    );
    return rows[0]?.name ?? '';
  }
  const { rows } = await client.query<{ display_name: string | null }>(
    'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
    [p.userId],
  );
  return rows[0]?.display_name ?? '';
}

/** Whether an enrichment is under way (or paused until a time still ahead). */
export function enrichBusy(state: EnrichState | null, now = Date.now()): boolean {
  if (!state) return false;
  if (state.status === 'done' || state.status === 'failed') return false;
  if (state.pausedUntil && Date.parse(state.pausedUntil) > now) return true;
  return now - Date.parse(state.updatedAt) < STALE_MINUTES * 60_000;
}

/** GET …/enrich/estimate and POST …/enrich (T15). Registered by http/routes.ts. */
export async function enrichRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/imports/:id/enrich/estimate',
    { schema: { params: Params, response: { 200: Estimate } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        const r = await ready(deps, tx, client, scope, req.params.id.toLowerCase(), false);
        const things = await pendingThings(client, r.runId, r.languages);
        const est = await estimateRun(r.rt, r.resolved, things, r.languages);
        const gate = await gateFor(tx, r.locationId, scope);
        const payer = r.resolved.payer;
        const showMoney =
          gate.showMoney || (payer.scope === 'user' && payer.userId === scope.userId);
        const body: Estimate = {
          things: est.things,
          calls: est.calls,
          tokens: est.tokens,
          ...(est.cost && showMoney ? { cost: est.cost } : {}),
          costSource: est.cost ? 'price_table' : 'unknown',
          payer: { scope: payer.scope, label: await payerLabel(client, r) },
          provider: { kind: r.resolved.provider.kind, model: r.resolved.provider.model },
          ...(r.state ? { state: r.state } : {}),
        };
        return body;
      }),
  );

  app.post(
    '/api/v1/imports/:id/enrich',
    { schema: { params: Params, response: { 202: z.object({ jobId: z.uuid() }) } } },
    async (req, reply) => {
      const jobs = deps.jobs;
      if (!jobs) throw new AppError('internal', 503, 'Alias enrichment needs the job queue.');
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const r = await ready(deps, tx, client, scope, req.params.id.toLowerCase(), true);
        if (enrichBusy(r.state)) {
          throw conflict('Search words are already being added for this import.');
        }
        const things = (await pendingThings(client, r.runId, r.languages)).length;
        const now = new Date().toISOString();
        const jobId = newId();
        const state: EnrichState = {
          jobId,
          status: 'running',
          things,
          processed: 0,
          aliases: 0,
          suggested: 0,
          failedBatches: 0,
          pausedUntil: null,
          reason: null,
          startedAt: now,
          updatedAt: now,
        };
        await writeEnrichState(client, r.runId, state);
        await jobs.sendTenant(client, ENRICH_JOB, { runId: r.runId, jobId });
        await audited(tx, {
          locationId: r.locationId,
          actor: actorOf(scope),
          action: 'import.enrich',
          entity: { type: 'import_run', id: r.runId },
          after: {
            things,
            languages: r.languages,
            provider: r.resolved.provider.kind,
            model: r.resolved.provider.model,
          },
          requestId: req.id,
        });
        return { status: 202, body: { jobId } };
      });
    },
  );
}
