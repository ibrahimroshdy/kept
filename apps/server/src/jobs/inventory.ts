import { fileJobs } from '../files/jobs.js';
import { reportJobs } from '../reports/jobs.js';
import { searchJobs } from '../search/jobs.js';
import { trashJobs } from '../trash/jobs.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 2's jobs (T2): each area declares its own in `src/<area>/jobs.ts` with defineJob() and a
// policy in jobs/policies.ts; systemJobs() spreads this list, so registerJobs() creates, schedules
// and works them like step 1's. Every handler follows the rule in jobs/boss.ts: `data` names what
// to work on, never whose rights to use. System jobs run on kept_system and only call definers
// (§7.14); SYSTEM_TABLES does not grow.

export function inventoryJobs(deps: SystemJobDeps): JobDefinition[] {
  return [...fileJobs(deps), ...searchJobs(deps), ...trashJobs(deps), ...reportJobs(deps)];
}
