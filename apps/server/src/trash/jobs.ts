import { SYNC_LIMITS } from '@kept/shared';
import type pg from 'pg';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import type { BlobStore } from '../storage/blob-store.js';

// The `purge` system job (T21; D149, D161, D162; engineering spec §3.3), daily at 03:17 UTC.
// It runs on kept_system and only calls the maintenance doors of migration 0022, each in its own
// transaction:
// 1. kept.purge_trash(now() - 30 days, 500), again while a round fills its limit: things and
//    places trashed more than 30 days ago, innermost first, with tombstones. Their files lose
//    their attachments and wait for step 3.
// 2. kept.purge_deleted_locations(10), again while a round fills its limit: locations past
//    their 30-day grace, with everything in them. It returns the storage keys nothing else
//    references.
// 2b. kept.purge_deleted_accounts(10), again while a round fills its limit: accounts past their
//    30 days before deletion (D225), with their Personal location and any of their own still in
//    grace, then the sign-in user and what is only theirs. It returns the storage keys too.
// 3. kept.purge_orphan_files(now() - 1 day, now() - 90 days, 500), again while a round returns
//    keys: files no attachment holds. One attached once and let go (the files of what step 1
//    purged) goes after a day; one never attached may be a phone's upload whose op is still
//    queued (a held-back queue, D148, D210), so it waits out the sync op window first.
// The blobs of steps 2, 2b and 3 are deleted from the BlobStore after their transaction commits, so
// a rolled-back purge never loses a blob a row still names. A blob that won't delete is logged
// and fails the job once the rest is done (it shows in the failed-jobs view); its row is already
// gone, so a retry can't find the key again, which is why the error names it.
//
// Without file storage (a worker started with none configured) steps 2, 2b and 3 are skipped
// outright and logged: running them would delete the rows and orphan their blobs for good.

/** How long something stays in the trash before it is purged (D162, §3.3). */
export const TRASH_DAYS = 30;

const TRASH_BATCH = 500;
const LOCATION_BATCH = 10;
const ACCOUNT_BATCH = 10;
const FILE_BATCH = 500;
/** Rounds per step and run: enough for any real backlog, and a bound on a runaway loop. */
const MAX_ROUNDS = 100;

export type PurgeReport = {
  trashed: number;
  locations: number;
  accounts: number;
  blobs: number;
  failedBlobs: string[];
  skippedFiles: boolean;
};

type PurgeDeps = Pick<SystemJobDeps, 'pools' | 'log'> & { blobs: BlobStore | null };

async function once<T>(pools: PurgeDeps['pools'], fn: (c: pg.PoolClient) => Promise<T>) {
  return withSystem(pools.system, (_tx, client) => fn(client));
}

async function deleteBlobs(deps: PurgeDeps, keys: readonly string[], failed: string[]) {
  const blobs = deps.blobs;
  if (!blobs) return 0;
  let deleted = 0;
  for (const key of keys) {
    try {
      await blobs.delete(key);
      deleted += 1;
    } catch (err) {
      failed.push(key);
      deps.log.error({ err, key }, 'purge: a blob could not be deleted');
    }
  }
  return deleted;
}

/** One run of the purge. Exported for the tests and `kept admin`. */
export async function runPurge(deps: PurgeDeps): Promise<PurgeReport> {
  const report: PurgeReport = {
    trashed: 0,
    locations: 0,
    accounts: 0,
    blobs: 0,
    failedBlobs: [],
    skippedFiles: !deps.blobs,
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const n = await once(deps.pools, async (c) => {
      const { rows } = await c.query<{ n: number }>(
        `SELECT kept.purge_trash(now() - make_interval(days => $1), $2) AS n`,
        [TRASH_DAYS, TRASH_BATCH],
      );
      return rows[0]?.n ?? 0;
    });
    report.trashed += n;
    if (n < TRASH_BATCH) break;
  }

  if (!deps.blobs) {
    deps.log.info(
      {},
      'purge: no file storage configured for this worker; deleted locations and accounts and unattached files are left for a worker that has it',
    );
    return report;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const purged = await once(deps.pools, async (c) => {
      const { rows } = await c.query<{ location_id: string; storage_keys: string[] }>(
        'SELECT location_id, storage_keys FROM kept.purge_deleted_locations($1)',
        [LOCATION_BATCH],
      );
      return rows;
    });
    report.locations += purged.length;
    const keys = purged.flatMap((r) => r.storage_keys ?? []);
    report.blobs += await deleteBlobs(deps, keys, report.failedBlobs);
    if (purged.length < LOCATION_BATCH) break;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const purged = await once(deps.pools, async (c) => {
      const { rows } = await c.query<{ user_id: string; storage_keys: string[] }>(
        'SELECT user_id, storage_keys FROM kept.purge_deleted_accounts($1)',
        [ACCOUNT_BATCH],
      );
      return rows;
    });
    report.accounts += purged.length;
    const keys = purged.flatMap((r) => r.storage_keys ?? []);
    report.blobs += await deleteBlobs(deps, keys, report.failedBlobs);
    if (purged.length < ACCOUNT_BATCH) break;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const keys = await once(deps.pools, async (c) => {
      const { rows } = await c.query<{ storage_key: string }>(
        `SELECT storage_key FROM kept.purge_orphan_files(now() - interval '1 day',
                now() - make_interval(days => $2::int), $1)`,
        [FILE_BATCH, SYNC_LIMITS.clientIdPastDays],
      );
      return rows.map((r) => r.storage_key);
    });
    report.blobs += await deleteBlobs(deps, keys, report.failedBlobs);
    if (keys.length === 0) break;
  }
  return report;
}

/** This area's jobs, aggregated by jobs/inventory.ts. */
export function trashJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'purge',
      kind: 'system',
      schedule: '17 3 * * *',
      policy: JOB_POLICIES.purge,
      handler: async () => {
        const report = await runPurge({
          pools: deps.pools,
          log: deps.log,
          blobs: deps.files?.blobs ?? null,
        });
        deps.log.info(
          {
            trashed: report.trashed,
            locations: report.locations,
            blobs: report.blobs,
            failedBlobs: report.failedBlobs.length,
          },
          'purge done',
        );
        if (report.failedBlobs.length > 0) {
          throw new Error(
            `purge: ${report.failedBlobs.length} blobs not deleted: ${report.failedBlobs.join(', ')}`,
          );
        }
      },
    }),
  ];
}
