import { sweepExportScratch } from '../exports/purge.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { buildClaimPack, type ClaimPackJobData, purgeExpiredExports } from './claim-pack.js';

// Claim packs' jobs (D158, D201; plan T18), aggregated by jobs/household.ts:
// - `claim-pack`, a tenant job sent by POST /api/v1/claim-packs in its transaction: the ZIP of
//   the insurance report and the files, built in the creator's scope (the payload's user, taken
//   from the sending transaction, never from `data`); `data` names the run, the reader's language
//   and the day the report is as of. No retry (policies.ts): a failed run shows `failed`.
// - `purge-exports`, hourly, kept_system: runs past their 7 days become `expired`, and their
//   ZIPs are deleted (§3.3), claim packs and step 7's Kept exports alike; step 7 adds the sweep of
//   an abandoned export's scratch directory (exports/purge.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `data` as the route sent it, or null when it isn't. */
export function claimPackData(data: unknown): ClaimPackJobData | null {
  const d = data as Partial<ClaimPackJobData> | null;
  if (typeof d?.runId !== 'string' || !UUID.test(d.runId)) return null;
  if (typeof d.asOf !== 'string' || !DAY.test(d.asOf)) return null;
  return {
    runId: d.runId,
    asOf: d.asOf,
    locale: d.locale === 'ar' ? 'ar' : 'en',
    digits: d.digits === 'eastern' ? 'eastern' : 'western',
  };
}

export function incidentJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'claim-pack',
      kind: 'tenant',
      policy: JOB_POLICIES['claim-pack'],
      handler: async ({ data, scope, client }) => {
        const parsed = claimPackData(data);
        if (!parsed) throw new Error('claim-pack job: data names no run');
        const app = deps.pools.app;
        if (!app) throw new Error('claim-pack job: the worker has no kept_app pool');
        // As the report job: runJob() holds this scoped transaction open while the pack's own
        // steps commit on their own connections, past the pool's idle-in-transaction limit.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '1800s'`);
        await buildClaimPack(
          {
            pools: { app, system: deps.pools.system },
            files: deps.files ?? null,
            publicUrl: deps.publicUrl,
            log: deps.log,
          },
          scope,
          parsed,
        );
      },
    }),
    defineJob({
      name: 'purge-exports',
      kind: 'system',
      schedule: '23 * * * *',
      policy: JOB_POLICIES['purge-exports'],
      handler: async () => {
        const purged = await purgeExpiredExports({
          pools: deps.pools,
          files: deps.files ?? null,
          log: deps.log,
        });
        if (purged.packs > 0) deps.log.info({ packs: purged.packs }, 'expired exports purged');
        // Step 7 (exports/purge.ts): a killed Kept export's scratch directory.
        if (deps.files) {
          const swept = await sweepExportScratch(deps.files);
          if (swept > 0) deps.log.info({ swept }, 'abandoned export scratch removed');
        }
        if (purged.failedBlobs.length > 0) {
          throw new Error(
            `purge-exports: ${purged.failedBlobs.length} files not deleted: ${purged.failedBlobs.join(', ')}`,
          );
        }
      },
    }),
  ];
}
