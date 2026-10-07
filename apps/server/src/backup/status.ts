import {
  type AdminOpsStatus,
  BACKUP_STALE_HOURS,
  type BucketVersioning,
  compareSemver,
  DRILL_DUE_DAYS,
  parseSemver,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { imageLastMigration, UPGRADE_WITHOUT_SNAPSHOT_KEY } from '../db/release-guard.js';
import { isHttps } from '../http/https-only.js';
import { recoveryKitStatus } from '../setup/recovery-kit.js';
import { readUpdateCheck, type UpdateCheckEnv } from '../updates/check.js';
import {
  BACKUP_RUN_COLUMNS,
  type BackupRunRow,
  backupRunOf,
  GOOD_RUN_SQL,
  SNAPSHOT_KINDS,
} from './runs.js';
import {
  backupEnvOverlay,
  backupSettingsView,
  describeBackupTarget,
  type RawEnv,
  readStoredBackupSettings,
} from './settings.js';
import { DISK_STATUS_KEY, diskStatusOf } from './watch.js';

// The status page's step-8 fields (AdminOpsStatus; step-8 plan T10; D66, D144, D166, §14), read
// on an instance admin's kept_app transaction from rows already kept: backup_runs,
// release_history and instance_settings (the backup settings, the watch's `disk_status`, the
// update check's state, the recovery kit's dates). Never a restic call, never a statfs.

export type OpsStatusInput = {
  /** The running image's version (KEPT_VERSION). */
  version: string;
  sourceUrl: string | null;
  publicUrl: string;
  raw: RawEnv;
  updateEnv: UpdateCheckEnv;
  /** Jobs that failed for good in the last 24 hours (jobs/failed.ts). */
  failedLastDay: number;
  now?: Date;
};

const HOUR = 3_600_000;
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
const numberOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function readOpsStatus(
  client: pg.ClientBase,
  input: OpsStatusInput,
): Promise<AdminOpsStatus> {
  const now = input.now ?? new Date();
  const overlay = backupEnvOverlay(input.raw);
  const { stored } = await readStoredBackupSettings(client);
  const view = backupSettingsView(stored, 0, overlay);

  const runs = await client.query<BackupRunRow & { which: string }>(
    `(SELECT 'last' AS which, ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = ANY($1::text[]) ORDER BY started_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT 'lastOk', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL} ORDER BY finished_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT 'firstOk', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL} ORDER BY finished_at, id LIMIT 1)
     UNION ALL
     (SELECT 'firstRun', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = ANY($1::text[]) ORDER BY started_at, id LIMIT 1)
     UNION ALL
     (SELECT 'drill', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = 'drill' AND status = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT 'verify', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE kind = 'verify' AND status = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT 'versioning', ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
       WHERE bucket_versioning_ok IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1)`,
    [SNAPSHOT_KINDS],
  );
  const by = new Map(runs.rows.map((r) => [r.which, r]));
  const last = by.get('last') ?? null;
  const lastOk = by.get('lastOk') ?? null;

  const settings = await client.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM public.instance_settings WHERE key = ANY($1::text[])`,
    [[DISK_STATUS_KEY, UPGRADE_WITHOUT_SNAPSHOT_KEY]],
  );
  const kv = new Map(settings.rows.map((r) => [r.key, r.value]));

  const releases = await client.query<{
    version: string;
    revision: string | null;
    last_migration: string;
  }>('SELECT version, revision, last_migration FROM public.release_history');
  const running = releases.rows.find((r) => r.version === input.version) ?? null;
  const recorded = releases.rows
    .filter((r) => parseSemver(r.version))
    .sort((a, b) => compareSemver(b.version, a.version));
  const newest = recorded[0] ?? null;
  const runningIsRelease = parseSemver(input.version) !== null && input.version !== '0.0.0-dev';
  const rolledBackFrom =
    runningIsRelease && newest && compareSemver(newest.version, input.version) > 0
      ? newest.version
      : null;

  // Backup facts.
  const lastOkAt = lastOk?.finished_at ?? null;
  const staleRef = lastOkAt ?? by.get('firstRun')?.started_at ?? null;
  const stale =
    view.configured &&
    staleRef !== null &&
    now.getTime() - staleRef.getTime() > BACKUP_STALE_HOURS * HOUR;
  const drill = by.get('drill')?.finished_at ?? null;
  const drillRef = drill ?? by.get('firstOk')?.finished_at ?? null;
  const drillDue =
    view.configured &&
    drillRef !== null &&
    now.getTime() - drillRef.getTime() > DRILL_DUE_DAYS * 24 * HOUR;
  const versioningRow = by.get('versioning');
  const bucketVersioning: BucketVersioning =
    overlay.storageMode !== 's3'
      ? 'not_applicable'
      : versioningRow?.bucket_versioning_ok === true
        ? 'on'
        : versioningRow?.bucket_versioning_ok === false
          ? 'off'
          : 'unknown';
  const upgrade = kv.get(UPGRADE_WITHOUT_SNAPSHOT_KEY) as
    | { fromVersion?: unknown; toVersion?: unknown; at?: unknown }
    | undefined;
  const upgradeAt = iso(upgrade?.at);
  const upgradeWithoutSnapshot =
    upgrade && upgradeAt && (!lastOkAt || lastOkAt.getTime() < new Date(upgradeAt).getTime())
      ? {
          fromVersion: String(upgrade.fromVersion ?? ''),
          toVersion: String(upgrade.toVersion ?? ''),
          at: upgradeAt,
        }
      : null;
  const target = overlay.target ?? stored.target ?? null;

  return {
    release: {
      version: input.version,
      revision: running?.revision ?? null,
      sourceUrl: input.sourceUrl,
      lastMigration: newest?.last_migration ?? imageLastMigration(),
      rolledBackFrom,
    },
    backup: {
      configured: view.configured,
      locked: view.target.locked,
      target: target ? describeBackupTarget(target) : null,
      storageMode: overlay.storageMode,
      last: last ? backupRunOf(last) : null,
      lastOk: lastOk ? backupRunOf(lastOk) : null,
      stale,
      snapshots: numberOr(lastOk?.detail.snapshots),
      repositoryBytes: numberOr(lastOk?.detail.repositoryBytes),
      readableBytes: lastOk?.readable_bytes == null ? null : Number(lastOk.readable_bytes),
      sameVolume: lastOk?.same_volume ?? null,
      bucketVersioning,
      lastDrillAt: drill?.toISOString() ?? null,
      drillDue,
      lastVerifyAt: by.get('verify')?.finished_at?.toISOString() ?? null,
      upgradeWithoutSnapshot,
    },
    recoveryKit: await recoveryKitStatus(client),
    disk: diskStatusOf(kv.get(DISK_STATUS_KEY)),
    updates: await readUpdateCheck(client, input.updateEnv),
    jobs: { failedLastDay: input.failedLastDay },
    https: isHttps(input.publicUrl),
  };
}

// ---------------------------------------------------------------------------------------------
// The response schema (admin/routes.ts AdminStatus): @kept/shared AdminOpsStatus as zod.

const Usage = z.object({ usedRatio: z.number(), freeBytes: z.number() }).nullable();
const RUN_KINDS = ['nightly', 'manual', 'pre_upgrade', 'drill', 'verify'] as const;
const RUN_STATES = ['running', 'ok', 'warning', 'failed'] as const;
const Run = z.object({
  id: z.string(),
  kind: z.enum(RUN_KINDS),
  status: z.enum(RUN_STATES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  storageMode: z.enum(['local', 's3']),
  target: z.string(),
  snapshotId: z.string().nullable(),
  dbBytes: z.number().nullable(),
  bytesAdded: z.number().nullable(),
  bytesTotal: z.number().nullable(),
  filesTotal: z.number().nullable(),
  filesNew: z.number().nullable(),
  missing: z.number(),
  readableLocations: z.number().nullable(),
  readableBytes: z.number().nullable(),
  sameVolume: z.boolean().nullable(),
  bucketVersioningOk: z.boolean().nullable(),
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  error: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});

export const AdminOpsStatusShape = {
  release: z.object({
    version: z.string(),
    revision: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    lastMigration: z.string().nullable(),
    rolledBackFrom: z.string().nullable(),
  }),
  backup: z.object({
    configured: z.boolean(),
    locked: z.boolean(),
    target: z.string().nullable(),
    storageMode: z.enum(['local', 's3']),
    last: Run.nullable(),
    lastOk: Run.nullable(),
    stale: z.boolean(),
    snapshots: z.number().nullable(),
    repositoryBytes: z.number().nullable(),
    readableBytes: z.number().nullable(),
    sameVolume: z.boolean().nullable(),
    bucketVersioning: z.enum(['on', 'off', 'unknown', 'not_applicable']),
    lastDrillAt: z.string().nullable(),
    drillDue: z.boolean(),
    lastVerifyAt: z.string().nullable(),
    upgradeWithoutSnapshot: z
      .object({ fromVersion: z.string(), toVersion: z.string(), at: z.string() })
      .nullable(),
  }),
  recoveryKit: z.object({
    acknowledgedAt: z.string().nullable(),
    downloadedAt: z.string().nullable(),
    stale: z.boolean(),
  }),
  disk: z.object({ data: Usage, backup: Usage }),
  updates: z.object({
    enabled: z.boolean(),
    locked: z.boolean(),
    lastCheckedAt: z.string().nullable(),
    latest: z.object({ version: z.string(), url: z.string(), publishedAt: z.string() }).nullable(),
    error: z.string().nullable(),
  }),
  jobs: z.object({ failedLastDay: z.number().int() }),
  https: z.boolean(),
};
