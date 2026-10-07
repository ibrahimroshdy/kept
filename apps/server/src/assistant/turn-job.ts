import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { semanticPrep } from '../search/semantic.js';
import { runTurn, type TurnJobData } from './loop.js';
import { ASSISTANT_TURN_JOB } from './service.js';

// The assistant's jobs (D22, D23, D166; step-6 plan T13), aggregated by jobs/step6.ts:
// - `assistant-turn`: a tenant job sent by POST /api/v1/assistant/threads/:id/turns in its
//   transaction, run in the asker's scope; `data` is `{turnId, locale}` only, never the question
//   (jobs/boss.ts's rule). The handler re-reads the turn under row-level security (loop.ts), so a
//   job naming someone else's turn finds nothing and ends. A retryable failure throws for pg-boss's
//   one retry (JOB_POLICIES), which resumes after the last stored step.
// - `assistant-maintenance`: daily at 03:15 UTC, kept_system: threads past their expiry go with
//   everything in them, and open proposals past their 10 minutes are marked expired
//   (kept.prune_assistant, 0073).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's data, checked: a turn id and the question's interface language. */
export function turnJobData(raw: unknown): TurnJobData {
  const d = (raw ?? {}) as Partial<TurnJobData>;
  if (typeof d.turnId !== 'string' || !UUID.test(d.turnId)) {
    throw new Error('assistant-turn job: data names no turn');
  }
  const locale = typeof d.locale === 'string' && d.locale.length <= 20 ? d.locale : 'en';
  return { turnId: d.turnId.toLowerCase(), locale };
}

export function assistantJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: ASSISTANT_TURN_JOB,
      kind: 'tenant',
      policy: JOB_POLICIES[ASSISTANT_TURN_JOB],
      handler: async ({ data, scope, client, job }) => {
        const turn = turnJobData(data);
        const app = deps.pools.app;
        if (!app) throw new Error('assistant-turn job: the worker has no kept_app pool');
        // runJob() holds this scoped transaction open, unused, while each step commits on its own
        // connection; a turn may take up to 180 s (Q21).
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '210s'`);
        const send = deps.sendTenant;
        const outcome = await runTurn(
          {
            pools: { app },
            ai: deps.ai ?? null,
            tools: {
              pools: { app },
              jobs: null,
              files: deps.files ?? null,
              log: deps.log,
              // search_things and where_is search by meaning too (T14, D200).
              semantic: semanticPrep({
                pools: { app, system: deps.pools.system },
                ai: deps.ai ?? null,
                log: deps.log,
              }),
            },
            log: deps.log,
            ...(send
              ? {
                  sendLater: (c, d, startAfter) => send(c, ASSISTANT_TURN_JOB, d, { startAfter }),
                }
              : {}),
          },
          scope,
          turn,
          job,
        );
        deps.log.info({ turnId: turn.turnId, outcome: outcome.status }, 'assistant turn ran');
      },
    }),
    defineJob({
      name: 'assistant-maintenance',
      kind: 'system',
      schedule: '15 3 * * *',
      policy: JOB_POLICIES['assistant-maintenance'],
      handler: async () => {
        const rows = await withSystem(deps.pools.system, async (_tx, c) => {
          const r = await c.query<{ what: string; removed: string }>(
            'SELECT what, removed FROM kept.prune_assistant(now())',
          );
          return r.rows;
        });
        deps.log.info(
          Object.fromEntries(rows.map((r) => [r.what, Number(r.removed)])),
          'assistant pruned',
        );
      },
    }),
  ];
}
