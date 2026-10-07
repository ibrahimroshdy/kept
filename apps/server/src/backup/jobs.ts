import path from 'node:path';
import pg from 'pg';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { isResolved, loadBackupSettings } from './settings.js';
import { runVerify } from './verify.js';
import { runOpsWatch } from './watch.js';

// Step 8's backup-side system jobs (plan T2), gathered by jobs/operations.ts. Stubs that do
// nothing until their tasks fill them in, so scheduling them now changes no behaviour:
// - `ops-watch`, hourly (T10, backup/watch.ts): statfs of KEPT_DATA_DIR and a directory target
//   (`disk_space_low` at DISK_WARN_RATIO), `backup_stale` after BACKUP_STALE_HOURS,
//   `bucket_versioning_off` (daily), `restore_drill_due` after DRILL_DUE_DAYS; each resolved when
//   it clears; writes `disk_status` into instance_settings.
// - `backup-verify`, weekly (T7, backup/verify.ts): `restic check`, and with S3 file storage the
//   manifest's hashes against the bucket (D144); records a `verify` run.
// Neither job's data ever holds a password or a credential: the settings are read when it runs.

export function backupOpsJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'ops-watch',
      kind: 'system',
      schedule: '37 * * * *',
      policy: JOB_POLICIES['ops-watch'],
      handler: async () => {
        const { raised, resolved } = await runOpsWatch({
          alerts: {
            pools: deps.pools,
            mailer: deps.mailer,
            log: deps.log,
            channels: deps.channels ?? null,
          },
          ownerUrl: deps.backup?.ownerUrl ?? null,
          // The raw environment: which variables the operator set (backup/settings.ts).
          raw: process.env,
        });
        if (raised.length > 0 || resolved.length > 0) {
          deps.log.info({ raised, resolved }, 'operations watch');
        }
      },
    }),
    defineJob({
      name: 'backup-verify',
      kind: 'system',
      schedule: '10 4 * * 0',
      policy: JOB_POLICIES['backup-verify'],
      handler: async () => {
        const b = deps.backup;
        if (!b?.ownerUrl || !deps.files) return;
        const ownerUrl = b.ownerUrl;
        const keyring = deps.secretKeys?.get().keyring ?? null;
        const client = new pg.Client({
          connectionString: ownerUrl,
          application_name: 'kept-verify',
        });
        client.on('error', () => {});
        await client.connect();
        let settings: Awaited<ReturnType<typeof loadBackupSettings>>;
        try {
          settings = await loadBackupSettings(client, b.rawEnv, keyring);
        } finally {
          await client.end().catch(() => {});
        }
        if (!isResolved(settings)) return;
        const report = await runVerify({
          ownerUrl,
          restic: b.restic,
          settings,
          storage: b.storage,
          blobs: deps.files.blobs,
          tmpDir: path.join(b.dataDir, 'tmp'),
        });
        deps.log.info(
          { status: report.run.status, error: report.run.error, missing: report.missing.length },
          'backup verify done',
        );
      },
    }),
  ];
}
