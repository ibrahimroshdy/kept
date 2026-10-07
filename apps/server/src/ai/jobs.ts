/**
 * The AI system jobs of plan T9 (D166, D188, D206): `ai-notice` (a cap crossed 80% or 100%, or
 * the instance key was rejected; sent by the runtime's hooks, ai/notices.ts) and `ai-rollover`
 * (00:05 UTC daily: day and month pauses that have ended are cleared), and step 4's `ai-summary`
 * (00:20 UTC on the 1st: last month's summary, ai/summary.ts). Spread into systemJobs() beside
 * `ai-maintenance`, which T6 scheduled.
 */
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { AI_NOTICE_JOB, aiRollover, runAiNotice } from './notices.js';
import { AI_SUMMARY_JOB, runAiSummary } from './summary.js';

export const AI_ROLLOVER_JOB = 'ai-rollover';

export function aiJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: AI_NOTICE_JOB,
      kind: 'system',
      policy: JOB_POLICIES[AI_NOTICE_JOB],
      handler: async (data) => {
        await runAiNotice(deps, data);
      },
    }),
    defineJob({
      name: AI_ROLLOVER_JOB,
      kind: 'system',
      schedule: '5 0 * * *',
      policy: JOB_POLICIES[AI_ROLLOVER_JOB],
      handler: async () => {
        const due = await aiRollover(deps);
        deps.log.info({ due }, 'AI pauses rolled over');
      },
    }),
    defineJob({
      name: AI_SUMMARY_JOB,
      kind: 'system',
      schedule: '20 0 1 * *',
      // The rollover's policy (a maintenance job's): the summary is once a month and idempotent.
      policy: JOB_POLICIES[AI_ROLLOVER_JOB],
      handler: async () => {
        const told = await runAiSummary(deps);
        deps.log.info({ told }, 'AI monthly summaries sent');
      },
    }),
  ];
}
