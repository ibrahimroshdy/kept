import { incidentJobs } from '../incidents/jobs.js';
import { notifyJobs } from '../notify/jobs.js';
import { reminderJobs } from '../reminders/jobs.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 4's jobs (plan T2), as jobs/inventory.ts gathers step 2's: each area declares its own in
// `src/<area>/jobs.ts` with defineJob() and a policy in jobs/policies.ts, and systemJobs()
// spreads this list, so no task edits system.ts. The rule in jobs/boss.ts holds: `data` names
// what to work on, never whose rights to use.

export function householdJobs(deps: SystemJobDeps): JobDefinition[] {
  return [...reminderJobs(deps), ...notifyJobs(deps), ...incidentJobs(deps)];
}
