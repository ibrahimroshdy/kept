import { statfs } from 'node:fs/promises';
import {
  BACKUP_STALE_HOURS,
  type BackupRunState,
  DISK_WARN_RATIO,
  type DiskUsage,
  DRILL_DUE_DAYS,
} from '@kept/shared';
import pg from 'pg';
import { type AlertDeps, raiseAlert, resolveAlert } from '../alerts/alerts.js';
import type { AdminAlertKind } from '../db/schema/alerts.js';
import { withSystem } from '../db/scope.js';
import { GOOD_RUN_SQL, SNAPSHOT_KINDS } from './runs.js';
import {
  backupEnvOverlay,
  backupSettingsView,
  type RawEnv,
  readStoredBackupSettings,
} from './settings.js';

// The operations watch (step-8 plan T10; D66, D144, D166): the hourly `ops-watch` system job.
//   - disk_space_low: the data volume (local file storage) or a directory backup target at or
//     over DISK_WARN_RATIO (85 %), one alert per volume (`disk_space_low:data`, `…:backup`);
//   - backup_stale: a target is configured and no good backup for BACKUP_STALE_HOURS (36);
//   - bucket_versioning_off: S3 file storage whose bucket the last backup found unversioned
//     (T5 checks it each run, D144);
//   - restore_drill_due: no restore drill for DRILL_DUE_DAYS (30) since the last one, or since
//     the first good backup (D66's monthly nudge);
// each resolved once its condition clears. It also writes what the status page and /metrics read
// without touching a disk or the backup table in the request: `instance_settings.disk_status`
// and `.backup_metrics`.
//
// backup_runs is the owner's (0091: nothing for kept_system), so its facts are read on the
// worker's owner login, as the backup itself is; a worker without one runs no backup either, and
// checks the disks only. Payloads hold counts, ratios and dates, never a path or a credential.

/** `instance_settings` keys this job writes (kept_system's, 0006's system_all). */
export const DISK_STATUS_KEY = 'disk_status';
export const BACKUP_METRICS_KEY = 'backup_metrics';

export type DiskStatus = { data: DiskUsage | null; backup: DiskUsage | null; at: string };

/** The last finished snapshot-making run, for `/metrics`. */
export type BackupMetrics = {
  lastSuccessAt: string | null;
  lastStatus: Exclude<BackupRunState, 'running'> | null;
  at: string;
};

export type DiskProbe = (dir: string) => Promise<DiskUsage | null>;

/** statfs as `df` counts it: used over what an unprivileged writer could have. Null when the
 * directory can't be read (a NAS mount that is down shows as unknown, not as full). */
export const probeDisk: DiskProbe = async (dir) => {
  try {
    const s = await statfs(dir);
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    const total = used + avail;
    if (total <= 0) return null;
    return { usedRatio: Math.round((used / total) * 10_000) / 10_000, freeBytes: avail };
  } catch {
    return null;
  }
};

export type OpsWatchDeps = {
  alerts: AlertDeps;
  /** The worker's KEPT_OWNER_DATABASE_URL; null: backup facts aren't read. */
  ownerUrl: string | null;
  /** The raw environment (backup/settings.ts): which target, and KEPT_STORAGE/KEPT_DATA_DIR. */
  raw: RawEnv;
  probe?: DiskProbe;
  now?: Date;
};

export type OpsWatchResult = {
  raised: string[];
  resolved: string[];
  disk: DiskStatus;
};

type BackupFacts = {
  lastOkAt: Date | null;
  firstOkAt: Date | null;
  firstRunAt: Date | null;
  last: { status: BackupRunState; finishedAt: Date | null } | null;
  versioningOk: boolean | null;
  lastDrillAt: Date | null;
};

async function readBackupFacts(ownerUrl: string): Promise<BackupFacts> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'kept-ops-watch' });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows } = await client.query<{
      last_ok: Date | null;
      first_ok: Date | null;
      first_run: Date | null;
      last_status: BackupRunState | null;
      last_finished: Date | null;
      versioning: boolean | null;
      last_drill: Date | null;
    }>(
      `SELECT
         (SELECT max(finished_at) FROM public.backup_runs
           WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL}) AS last_ok,
         (SELECT min(finished_at) FROM public.backup_runs
           WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL}) AS first_ok,
         (SELECT min(started_at) FROM public.backup_runs WHERE kind = ANY($1::text[])) AS first_run,
         l.status AS last_status, l.finished_at AS last_finished,
         (SELECT bucket_versioning_ok FROM public.backup_runs
           WHERE bucket_versioning_ok IS NOT NULL ORDER BY started_at DESC LIMIT 1) AS versioning,
         (SELECT max(finished_at) FROM public.backup_runs
           WHERE kind = 'drill' AND status = 'ok') AS last_drill
       FROM (SELECT 1) AS one
       LEFT JOIN LATERAL (SELECT status, finished_at FROM public.backup_runs
                           WHERE kind = ANY($1::text[]) AND status <> 'running'
                           ORDER BY started_at DESC LIMIT 1) AS l ON true`,
      [SNAPSHOT_KINDS],
    );
    const r = rows[0];
    return {
      lastOkAt: r?.last_ok ?? null,
      firstOkAt: r?.first_ok ?? null,
      firstRunAt: r?.first_run ?? null,
      last: r?.last_status ? { status: r.last_status, finishedAt: r.last_finished } : null,
      versioningOk: r?.versioning ?? null,
      lastDrillAt: r?.last_drill ?? null,
    };
  } finally {
    await client.end();
  }
}

const HOUR = 3_600_000;

/** One pass of the watch. */
export async function runOpsWatch(deps: OpsWatchDeps): Promise<OpsWatchResult> {
  const now = deps.now ?? new Date();
  const probe = deps.probe ?? probeDisk;
  const overlay = backupEnvOverlay(deps.raw);
  const { stored } = await withSystem(deps.alerts.pools.system, (_tx, client) =>
    readStoredBackupSettings(client),
  );
  const view = backupSettingsView(stored, 0, overlay);
  const dirTarget =
    overlay.target?.kind === 'dir'
      ? overlay.target.path
      : !overlay.target && stored.target?.kind === 'dir'
        ? stored.target.path
        : null;

  const result: OpsWatchResult = {
    raised: [],
    resolved: [],
    disk: { data: null, backup: null, at: now.toISOString() },
  };
  const step = async (
    kind: AdminAlertKind,
    key: string,
    holds: boolean,
    payload: () => Record<string, unknown>,
  ) => {
    if (holds) {
      await raiseAlert(deps.alerts, kind, key, payload());
      result.raised.push(key);
    } else if (await resolveAlert(deps.alerts.pools, key)) {
      result.resolved.push(key);
    }
  };

  // Disks (D166).
  result.disk.data = overlay.storageMode === 'local' ? await probe(overlay.dataDir) : null;
  result.disk.backup = dirTarget ? await probe(dirTarget) : null;
  for (const volume of ['data', 'backup'] as const) {
    const usage = result.disk[volume];
    await step(
      'disk_space_low',
      `disk_space_low:${volume}`,
      usage !== null && usage.usedRatio >= DISK_WARN_RATIO,
      () => ({ volume, usedRatio: usage?.usedRatio, freeBytes: usage?.freeBytes }),
    );
  }

  // Backups (D66, D144).
  let metrics: BackupMetrics | null = null;
  if (deps.ownerUrl) {
    const facts = await readBackupFacts(deps.ownerUrl);
    const since = (at: Date | null) => (at ? now.getTime() - at.getTime() : null);
    // Stale: hours since the last good backup, or since the first run when none was ever good
    // (a worker that never ran one leaves no row, and its own failure alerts say why).
    const staleRef = facts.lastOkAt ?? facts.firstRunAt;
    const staleFor = since(staleRef);
    await step(
      'backup_stale',
      'backup_stale',
      view.configured && staleFor !== null && staleFor > BACKUP_STALE_HOURS * HOUR,
      () => ({
        lastOkAt: facts.lastOkAt?.toISOString() ?? null,
        hours: Math.floor((staleFor ?? 0) / HOUR),
      }),
    );
    await step(
      'bucket_versioning_off',
      'bucket_versioning_off',
      overlay.storageMode === 's3' && facts.versioningOk === false,
      () => ({}),
    );
    const drillRef = facts.lastDrillAt ?? facts.firstOkAt;
    const drillFor = since(drillRef);
    await step(
      'restore_drill_due',
      'restore_drill_due',
      view.configured && drillFor !== null && drillFor > DRILL_DUE_DAYS * 24 * HOUR,
      () => ({ lastDrillAt: facts.lastDrillAt?.toISOString() ?? null }),
    );
    metrics = {
      lastSuccessAt: facts.lastOkAt?.toISOString() ?? null,
      lastStatus:
        facts.last && facts.last.status !== 'running'
          ? (facts.last.status as BackupMetrics['lastStatus'])
          : null,
      at: now.toISOString(),
    };
  }

  await withSystem(deps.alerts.pools.system, async (_tx, client) => {
    const write = (key: string, value: unknown) =>
      client.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)],
      );
    await write(DISK_STATUS_KEY, result.disk);
    if (metrics) await write(BACKUP_METRICS_KEY, metrics);
  });
  return result;
}

/** `instance_settings.disk_status`, or nulls before the first watch. */
export function diskStatusOf(value: unknown): { data: DiskUsage | null; backup: DiskUsage | null } {
  const usage = (v: unknown): DiskUsage | null => {
    if (!v || typeof v !== 'object') return null;
    const { usedRatio, freeBytes } = v as Record<string, unknown>;
    return typeof usedRatio === 'number' && typeof freeBytes === 'number'
      ? { usedRatio, freeBytes }
      : null;
  };
  const v = (value ?? {}) as Record<string, unknown>;
  return { data: usage(v.data), backup: usage(v.backup) };
}
