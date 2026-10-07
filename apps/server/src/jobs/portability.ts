import { enrichJobs } from '../enrich/job.js';
import { exportJobs } from '../exports/job.js';
import { homeboxImportJobs } from '../imports/homebox/job.js';
import { keptImportJobs } from '../imports/kept/job.js';
import { pruneImportJobs } from '../imports/prune.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 7's jobs (plan T2), as jobs/household.ts gathers step 4's: each area declares its own with
// defineJob() and a policy in jobs/policies.ts, and systemJobs() spreads this list, so no task
// edits system.ts. The rule in jobs/boss.ts holds: `data` names what to work on, never whose
// rights to use, and never a passphrase or a key.

export function portabilityJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    ...exportJobs(deps),
    ...homeboxImportJobs(deps),
    ...keptImportJobs(deps),
    ...pruneImportJobs(deps),
    ...enrichJobs(deps),
  ];
}
