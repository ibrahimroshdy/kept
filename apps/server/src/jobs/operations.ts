import { backupOpsJobs } from '../backup/jobs.js';
import { updateCheckJobs } from '../updates/job.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 8's jobs (plan T2), as jobs/portability.ts gathers step 7's: each area declares its own
// with defineJob() and a policy in jobs/policies.ts, and systemJobs() spreads this list, so no
// task edits system.ts. The nightly `backup` itself stays in system.ts (T31c), and T5 rewrites
// its handler there. The rule in jobs/boss.ts holds: `data` never holds a password or a key.

export function operationsJobs(deps: SystemJobDeps): JobDefinition[] {
  return [...backupOpsJobs(deps), ...updateCheckJobs(deps)];
}
