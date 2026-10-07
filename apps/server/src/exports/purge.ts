import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileStorage } from '../storage/blob-store.js';

// Step 7's part of step 4's hourly `purge-exports` (incidents/jobs.ts; plan T12): the run rows and
// their ZIPs are already purged by kept.purge_expired_exports() for every kind (claim packs and
// Kept exports alike: `x/<id>.zip`, and a step-7 run its job abandoned fails and loses its sealed
// key there). What a killed export job can leave behind is its scratch directory under
// KEPT_DATA_DIR/tmp: this removes the export's (`export-…`, `readable-pdf-…`) once they are older
// than the job could still be running (two hours, jobs/policies.ts), plus a margin.

const SCRATCH = /^(export|readable-pdf)-[A-Za-z0-9]{6}$/;
const STALE_MS = 3 * 3600 * 1000;

/** Removes abandoned export scratch directories; returns how many. */
export async function sweepExportScratch(
  files: Pick<FileStorage, 'tmpDir'>,
  now: () => Date = () => new Date(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(files.tmpDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SCRATCH.test(name)) continue;
    const at = path.join(files.tmpDir, name);
    try {
      const s = await stat(at);
      if (!s.isDirectory() || now().getTime() - s.mtimeMs < STALE_MS) continue;
      await rm(at, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone meanwhile.
    }
  }
  return removed;
}
