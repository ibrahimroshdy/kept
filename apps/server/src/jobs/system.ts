import pg from 'pg';
import { repairOrphanAccounts } from '../accounts/ensure-account.js';
import { aiJobs } from '../ai/jobs.js';
import type { AiDeps } from '../ai/routes.js';
import { checkAdminAlerts } from '../alerts/alerts.js';
import { backupCron } from '../backup/config.js';
import {
  BackupRunningError,
  bucketVersioningOf,
  type ReadableCopy,
  runSnapshot,
} from '../backup/nightly.js';
import type { PgTools } from '../backup/pg-tools.js';
import type { Restic } from '../backup/restic/restic.js';
import {
  backupEnvOverlay,
  backupTimeEffective,
  isResolved,
  loadBackupSettings,
  readStoredBackupSettings,
} from '../backup/settings.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Pools } from '../db/pools.js';
import { sendInviteMail } from '../invites/mail-job.js';
import { expireMemberships, notifyOwnerNewMember } from '../locations/membership-jobs.js';
import type { Mailer } from '../mail/mailer.js';
import type { ChannelSenders } from '../reminders/channel.js';
import type { FileStorage } from '../storage/blob-store.js';
import { defineJob, type JobDefinition } from './boss.js';
import { captureJobs } from './capture.js';
import { householdJobs } from './household.js';
import { inventoryJobs } from './inventory.js';
import { aiMaintenance, ensureAuditPartitions, pruneStaleRows } from './maintenance.js';
import { operationsJobs } from './operations.js';
import { JOB_POLICIES } from './policies.js';
import { portabilityJobs } from './portability.js';
import { step6Jobs } from './step6.js';

export type SystemJobDeps = {
  /** `app` (kept_app) for tenant jobs that commit their own steps as the sender (the report,
   * T32); a worker passes all its pools. */
  pools: Pick<Pools, 'system' | 'auth'> & Partial<Pick<Pools, 'app'>>;
  mailer: Mailer;
  /** KEPT_PUBLIC_URL, for the links mailed. */
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** File storage, for jobs that delete blobs (the purge, T21). Omitted: they skip the work
   * that would leave blobs behind, and say so in the log. */
  files?: FileStorage | null;
  /** The nightly backup (step 8, restic). Omitted, or with no target and password in the
   * settings: the job runs and does nothing, and the status page says "No backup configured". */
  backup?: BackupJobConfig | null;
  /** Step 3's AI provider layer (ai/routes.ts createAiDeps), for the `extract` job (T10).
   * Omitted: every extraction it runs ends `no_provider`, and the capture stays a draft (D19). */
  ai?: AiDeps | null;
  /** Sends a tenant job on a handler's own scoped transaction (jobs/boss.ts sendTenantJob): a
   * paused extraction sent again for when its pause ends (T10). The worker passes its pg-boss's. */
  sendTenant?: (
    client: pg.ClientBase,
    name: string,
    data: object,
    options: { startAfter: Date },
  ) => Promise<void>;
  /** Sends a system job on a handler's own kept_system transaction (jobs/boss.ts sendInTx): the
   * reminder scan's `reminder-deliver` jobs, in the transaction that writes the delivery (step 4,
   * T14). The worker passes its pg-boss's. Omitted: deliveries are recorded and nothing sends. */
  send?: (
    client: pg.ClientBase,
    name: string,
    data: object,
    options?: { startAfter?: Date },
  ) => Promise<void>;
  /** Step 4's channel senders (reminders/channel.ts; T15 builds them): email, web push and the
   * webhook. A missing one is a channel that is off on this instance (no SMTP: no email), and the
   * reminder scan makes no deliveries for it. Omitted: reminders reach the in-app centre only. */
  channels?: ChannelSenders | null;
  /** The keyring (crypto/keyring.ts), for jobs that open a sealed value: step 4's
   * `channel-webhook` (a webhook channel's URL and secret, T15). Omitted: that job fails. */
  secretKeys?: SecretKeys | null;
  /** Step 8 (T11, D65): the opt-in update check's inputs, KEPT_SOURCE_URL and KEPT_UPDATE_CHECK.
   * Omitted: the `update-check` job never asks. */
  updates?: { sourceUrl: string | null; updateCheck: boolean | undefined } | null;
};

export type BackupJobConfig = {
  /** When the job is scheduled, `HH:MM` UTC (KEPT_BACKUP_TIME). */
  time: string;
  /** The owner login the dump runs as (the worker's KEPT_OWNER_DATABASE_URL). */
  ownerUrl: string | null;
  storage: 'local' | 's3';
  /** KEPT_DATA_DIR: the stable backup directory and, with local storage, the files. */
  dataDir: string;
  pgTools: PgTools;
  restic: Restic;
  /** The raw environment the saved settings are overlaid with (backup/settings.ts): read at
   * each run, so a change in Admin → Backups needs no restart. */
  rawEnv: Readonly<Record<string, string | undefined>>;
  /** T6's readable copy (D159), once it lands. */
  readable?: ReadableCopy | null;
};

async function withOwnerClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'kept-backup' });
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** When the backup runs when nothing sets KEPT_BACKUP_TIME. */
export const DEFAULT_BACKUP_TIME = '02:30';

/**
 * The nightly backup's time at a worker's start, `HH:MM` UTC: KEPT_BACKUP_TIME when the operator
 * set it (it locks the field), else the time saved in Admin → Backups, else 02:30
 * (backup/settings.ts backupTimeEffective). The saved one is read on the owner login, as the
 * backup reads its settings; without that login, or if the read fails, the environment's or the
 * default (with `onError`). A time saved later moves the schedule at once (admin/backup-routes.ts
 * reschedules); this keeps a restart from putting the old one back.
 */
export async function nightlyBackupTime(
  ownerUrl: string | null,
  raw: Readonly<Record<string, string | undefined>>,
  onError?: (err: unknown) => void,
): Promise<string> {
  const overlay = backupEnvOverlay(raw);
  if (overlay.time !== null || !ownerUrl) return backupTimeEffective({}, overlay);
  try {
    const { stored } = await withOwnerClient(ownerUrl, (c) => readStoredBackupSettings(c));
    return backupTimeEffective(stored, overlay);
  } catch (err) {
    onError?.(err);
    return backupTimeEffective({}, overlay);
  }
}

/** Every system job, scheduled or sent by requests (jobs/queue.ts). Schedules are UTC. */
export function systemJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      // §7.14: auth users with no owner account (a failed or skipped sign-up hook) get one.
      name: 'repair-orphans',
      kind: 'system',
      schedule: '17 * * * *',
      policy: JOB_POLICIES['repair-orphans'],
      handler: async () => {
        const { repaired, removed, failed } = await repairOrphanAccounts(deps.pools);
        if (repaired.length > 0)
          deps.log.info({ repaired: repaired.length }, 'repaired orphaned users');
        if (removed.length > 0)
          deps.log.info({ removed: removed.length }, 'removed half-made managed accounts');
        for (const { userId, error } of failed) {
          deps.log.error({ userId, err: error }, 'could not repair an orphaned user');
        }
        if (failed.length > 0) throw new Error(`${failed.length} orphaned users not repaired`);
      },
    }),
    defineJob({
      // D46: memberships past their end date are removed and audited.
      name: 'expire-memberships',
      kind: 'system',
      schedule: '*/15 * * * *',
      policy: JOB_POLICIES['expire-memberships'],
      handler: async () => {
        await expireMemberships(deps.pools, deps.log, {
          mailer: deps.mailer,
          auth: deps.pools.auth,
        });
      },
    }),
    defineJob({
      // §7.13: next months' audit partitions, daily so a missed night or a long outage over a
      // month's turn is caught up well before the month starts.
      name: 'audit-partitions',
      kind: 'system',
      schedule: '5 3 * * *',
      policy: JOB_POLICIES['audit-partitions'],
      handler: async () => {
        const created = await ensureAuditPartitions(deps.pools);
        if (created > 0) deps.log.info({ created }, 'audit partitions created');
      },
    }),
    defineJob({
      // Rows nothing reads any more (step-1 carry-over; §3.3).
      name: 'prune-stale-rows',
      kind: 'system',
      schedule: '35 3 * * *',
      policy: JOB_POLICIES['prune-stale-rows'],
      handler: async () => {
        const pruned = await pruneStaleRows(deps.pools);
        deps.log.info({ pruned }, 'stale rows pruned');
      },
    }),
    defineJob({
      // D166, task 25: failed jobs rising, and audit rows in the default partition.
      name: 'check-admin-alerts',
      kind: 'system',
      schedule: '*/15 * * * *',
      policy: JOB_POLICIES['check-admin-alerts'],
      handler: async () => {
        const { raised, resolved } = await checkAdminAlerts(deps);
        if (raised.length > 0 || resolved.length > 0) {
          deps.log.info({ raised, resolved }, 'admin alerts checked');
        }
      },
    }),
    defineJob({
      // D180: sent by requests (jobs/queue.ts) when a membership is created.
      name: 'notify-owner-new-member',
      kind: 'system',
      policy: JOB_POLICIES['notify-owner-new-member'],
      handler: async (data) => {
        await notifyOwnerNewMember(deps.pools, data, deps.log, deps.mailer);
      },
    }),
    defineJob({
      // Security review M9: sent by the invite route in its transaction (invites/mail-job.ts).
      name: 'send-invite-mail',
      kind: 'system',
      policy: JOB_POLICIES['send-invite-mail'],
      handler: async (data) => {
        await sendInviteMail(deps, data);
      },
    }),
    // Step 2: files, search and trash (jobs/inventory.ts).
    ...inventoryJobs(deps),
    defineJob({
      // Step 3 (T6, D206): the AI call ledger's partitions ahead, partitions past the retention
      // (instance setting ai_ledger_months, 13) rolled up into monthly totals and dropped, and the
      // pacing counters pruned. The ledger holds no prompt or reply, so nothing else to prune.
      name: 'ai-maintenance',
      kind: 'system',
      schedule: '45 3 * * *',
      policy: JOB_POLICIES['ai-maintenance'],
      handler: async () => {
        const done = await aiMaintenance(deps.pools);
        deps.log.info(done, 'ai ledger maintained');
      },
    }),
    // Step 3 (T9): AI cap and rejected-key notices, and the daily pause rollover.
    ...aiJobs(deps),
    // Step 3: extraction, CSV import and PDF text (jobs/capture.ts).
    ...captureJobs(deps),
    // Step 4: reminders, channels and claim packs (jobs/household.ts).
    ...householdJobs(deps),
    // Step 7: exports, archive imports and their pruning, alias enrichment (jobs/portability.ts).
    ...portabilityJobs(deps),
    // Step 6: the assistant, embeddings and webhooks (jobs/step6.ts).
    ...step6Jobs(deps),
    // Step 8: the operations watch, the backup check and the update check (jobs/operations.ts).
    ...operationsJobs(deps),
    defineJob({
      // Step 8 (T5, D64): the restic snapshot, nightly at KEPT_BACKUP_TIME, and on demand with
      // `{kind: 'manual'}` (Admin → Backups' "Back up now"). Scheduled whether or not backups
      // are set up; without a target and a password it does nothing (plan Q6). The settings are
      // read at each run; the job's data never holds one.
      name: 'backup',
      kind: 'system',
      schedule: backupCron(deps.backup?.time ?? DEFAULT_BACKUP_TIME),
      policy: JOB_POLICIES.backup,
      handler: async (data) => {
        const b = deps.backup;
        if (!b) return;
        if (!b.ownerUrl) throw new Error('backup: KEPT_OWNER_DATABASE_URL is not set');
        if (!deps.files) throw new Error('backup: no file storage');
        const ownerUrl = b.ownerUrl;
        const keyring = deps.secretKeys?.get().keyring ?? null;
        const settings = await withOwnerClient(ownerUrl, (client) =>
          loadBackupSettings(client, b.rawEnv, keyring),
        );
        if (!isResolved(settings)) return;
        const job = (data ?? {}) as { kind?: unknown; runId?: unknown };
        const kind = job.kind === 'manual' ? 'manual' : 'nightly';
        // "Run now"'s id (admin/backup-routes.ts), so its 202 row is the one recorded.
        const runId =
          kind === 'manual' &&
          typeof job.runId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.runId)
            ? job.runId
            : undefined;
        const blobs = deps.files.blobs;
        try {
          await runSnapshot(
            {
              ownerUrl,
              restic: b.restic,
              settings,
              dataDir: b.dataDir,
              storage: b.storage,
              blobs,
              pgTools: b.pgTools,
              readable: b.readable ?? null,
              bucketVersioning: () => bucketVersioningOf(blobs),
              log: deps.log,
              alerts: { pools: deps.pools, mailer: deps.mailer, log: deps.log },
            },
            { kind, ...(runId ? { runId } : {}) },
          );
        } catch (err) {
          // Another run (a manual one, a pre-upgrade snapshot) holds the lock: this one's work
          // is being done; a retry would only queue behind it.
          if (err instanceof BackupRunningError) {
            deps.log.info({ kind }, 'backup skipped: another backup is running');
            return;
          }
          throw err;
        }
      },
    }),
  ];
}
