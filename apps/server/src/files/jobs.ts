import type { JobDefinition } from '../jobs/boss.js';
import type { SystemJobDeps } from '../jobs/system.js';

/** This area's jobs, aggregated by jobs/inventory.ts. None in step 2: derivatives are made in the
 * upload request (Q17), and unattached files are purged by trash/jobs.ts (T21,
 * kept.purge_orphan_files). Step 3's PDF extraction (Q8) lands here. */
export function fileJobs(_deps: SystemJobDeps): JobDefinition[] {
  return [];
}
