import { assistantJobs } from '../assistant/turn-job.js';
import { embedBackfillJobs } from '../embeddings/backfill.js';
import { embedThingJobs } from '../embeddings/job.js';
import { transparencyJobs } from '../notices/transparency.js';
import { webhookJobs } from '../webhooks/deliver.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 6's jobs (plan T2), as jobs/household.ts gathers step 4's: each area declares its own with
// defineJob() and a policy in jobs/policies.ts, and systemJobs() spreads this list, so no task
// edits system.ts. The rule in jobs/boss.ts holds: `data` names what to work on, never whose
// rights to use, and never a question, a tool argument or a secret.

export function step6Jobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    ...assistantJobs(deps),
    ...embedThingJobs(deps),
    ...embedBackfillJobs(deps),
    ...webhookJobs(deps),
    ...transparencyJobs(deps),
  ];
}
