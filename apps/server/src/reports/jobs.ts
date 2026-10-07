import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { purgeExpiredReports, runReport } from './service.js';

// The report's jobs (D201), aggregated by jobs/inventory.ts:
// - `report`, a tenant job sent by POST /api/v1/reports/inventory in its transaction: it runs in
//   the requester's scope (the payload's user, taken from the sending transaction, never from
//   `data`), and `data` only names the run, which the handler reads back under RLS. One at a time
//   per worker (pg-boss's default), so reports are paced; the render itself is a child process
//   with its own memory and time limits (render/render.ts).
// - `purge-reports`, hourly, kept_system: runs past their 24 hours and their files.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reportJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'report',
      kind: 'tenant',
      policy: JOB_POLICIES.report,
      handler: async ({ data, scope, client }) => {
        const runId = (data as { runId?: unknown } | null)?.runId;
        if (typeof runId !== 'string' || !UUID.test(runId)) {
          throw new Error('report job: data names no run');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('report job: the worker has no kept_app pool');
        // runJob() holds this (otherwise unused) scoped transaction open while the run's own
        // steps commit on their own connections, and a render may take up to a minute: past the
        // pool's 30 s idle-in-transaction limit the server would end it and fail the job.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '180s'`);
        await runReport(
          { pools: { app }, files: deps.files ?? null, publicUrl: deps.publicUrl, log: deps.log },
          scope,
          runId,
        );
      },
    }),
    defineJob({
      name: 'purge-reports',
      kind: 'system',
      schedule: '41 * * * *',
      policy: JOB_POLICIES['purge-reports'],
      handler: async () => {
        const purged = await purgeExpiredReports({
          pools: deps.pools,
          files: deps.files ?? null,
          log: deps.log,
        });
        if (purged.runs > 0) deps.log.info({ runs: purged.runs }, 'expired reports purged');
        if (purged.failedBlobs.length > 0) {
          throw new Error(
            `purge-reports: ${purged.failedBlobs.length} files not deleted: ${purged.failedBlobs.join(', ')}`,
          );
        }
      },
    }),
  ];
}
