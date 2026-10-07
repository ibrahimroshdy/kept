import { IMPORT_PRUNE_DAYS } from '@kept/shared';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { type FileStorage, importArchiveKey } from '../storage/blob-store.js';

// Pruning abandoned import runs (step-3 carry-over; step-7 plan T8, Q18), aggregated by
// jobs/portability.ts. `prune-imports` runs daily as kept_system: for each run from
// kept.stale_import_runs(now() - 7 days, 200) it deletes `i/<id>.zip` (importArchiveKey; a
// missing blob is fine), then calls kept.clear_import_run(id), which clears the rows, the archive
// columns, the inspection and any sealed key, and cancels a draft or checked run. A running run
// is never listed. The archive of a finished run is deleted when its job ends (T10, T14); this
// catches what a crash, an abandoned upload or a refused archive left behind.

/** Runs per door call. */
const PRUNE_BATCH = 200;
/** At most this many batches a run: 20,000 runs, far beyond a household's. */
const PRUNE_ROUNDS = 100;

export type ImportPrune = { runs: number; archives: number; failedBlobs: string[] };

export async function pruneImports(deps: {
  pools: Pick<Pools, 'system'>;
  files: FileStorage | null | undefined;
  log: SystemJobDeps['log'];
  /** Tests move the clock; production prunes what is a week old. */
  before?: Date;
}): Promise<ImportPrune> {
  const out: ImportPrune = { runs: 0, archives: 0, failedBlobs: [] };
  const before = deps.before ?? new Date(Date.now() - IMPORT_PRUNE_DAYS * 86_400_000);
  for (let round = 0; round < PRUNE_ROUNDS; round++) {
    const stale = await withSystem(deps.pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ id: string; has_archive: boolean }>(
        'SELECT id, has_archive FROM kept.stale_import_runs($1, $2)',
        [before, PRUNE_BATCH],
      );
      return rows;
    });
    let cleared = 0;
    for (const run of stale) {
      if (run.has_archive) {
        if (!deps.files) {
          // Without storage the blob can't be deleted, so the row keeps saying it exists.
          deps.log.info({ runId: run.id }, 'prune-imports: no file storage on this worker');
          continue;
        }
        const key = importArchiveKey(run.id);
        try {
          await deps.files.blobs.delete(key);
          out.archives += 1;
        } catch (err) {
          out.failedBlobs.push(key);
          deps.log.error({ err, key }, 'prune-imports: an import archive could not be deleted');
          continue;
        }
      }
      await withSystem(deps.pools.system, (_tx, c) =>
        c.query('SELECT kept.clear_import_run($1)', [run.id]),
      );
      cleared += 1;
    }
    out.runs += cleared;
    // A batch that cleared nothing (no storage, or every delete failed) would list the same runs
    // again: stop rather than spin.
    if (stale.length < PRUNE_BATCH || cleared === 0) break;
  }
  return out;
}

export function pruneImportJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'prune-imports',
      kind: 'system',
      schedule: '53 3 * * *',
      policy: JOB_POLICIES['prune-imports'],
      handler: async () => {
        const result = await pruneImports({ pools: deps.pools, files: deps.files, log: deps.log });
        if (result.runs > 0 || result.failedBlobs.length > 0) {
          deps.log.info(
            { runs: result.runs, archives: result.archives, failed: result.failedBlobs.length },
            'prune-imports: abandoned import runs cleared',
          );
        }
      },
    }),
  ];
}
