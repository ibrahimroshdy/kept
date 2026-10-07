import { extractionJobs } from '../extraction/job.js';
import { pdfTextJobs } from '../files/pdf-text.js';
import { importJobs } from '../imports/job.js';
import type { JobDefinition } from './boss.js';
import type { SystemJobDeps } from './system.js';

// Step 3's jobs (T2): extraction, CSV import and PDF text. Each is a `tenant` job sent by a
// request through JobQueue.sendTenant() to one of TENANT_REQUEST_QUEUES (jobs/queue.ts), so it
// runs in the sender's scope under row-level security; its policy is in jobs/policies.ts.
// systemJobs() spreads this list, as it does inventoryJobs(). A task that needs more from the
// app (the AI layer, the blob store) adds an optional field to SystemJobDeps.

export function captureJobs(deps: SystemJobDeps): JobDefinition[] {
  return [...extractionJobs(deps), ...importJobs(deps), ...pdfTextJobs(deps)];
}
