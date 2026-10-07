import type { BackupRun, BackupRunKind, BackupRunState, BackupStorageMode } from '@kept/shared';
import type pg from 'pg';

// `backup_runs` rows (step-8 plan T4) as the API shows them (@kept/shared BackupRun): Admin →
// Backups' list (admin/backup-routes.ts) and the status page (backup/status.ts). Instance admins
// read them on kept_app (0091's app_admin_select); only kept_owner writes them (the worker's
// backup login, the CLI, `kept migrate`). No column holds a credential (T4's checks).

export type BackupRunRow = {
  id: string;
  kind: BackupRunKind;
  status: BackupRunState;
  started_at: Date;
  finished_at: Date | null;
  storage_mode: BackupStorageMode;
  target: string;
  snapshot_id: string | null;
  db_bytes: string | number | null;
  bytes_added: string | number | null;
  bytes_total: string | number | null;
  files_total: number | null;
  files_new: number | null;
  missing: number;
  readable_locations: number | null;
  readable_bytes: string | number | null;
  same_volume: boolean | null;
  bucket_versioning_ok: boolean | null;
  from_version: string | null;
  to_version: string | null;
  verified_at: Date | null;
  error: string | null;
  detail: Record<string, unknown>;
};

export const BACKUP_RUN_COLUMNS = `id, kind, status, started_at, finished_at, storage_mode, target,
  snapshot_id, db_bytes, bytes_added, bytes_total, files_total, files_new, missing,
  readable_locations, readable_bytes, same_volume, bucket_versioning_ok, from_version,
  to_version, verified_at, error, detail`;

const num = (v: string | number | null) => (v === null ? null : Number(v));

export function backupRunOf(r: BackupRunRow): BackupRun {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    storageMode: r.storage_mode,
    target: r.target,
    snapshotId: r.snapshot_id,
    dbBytes: num(r.db_bytes),
    bytesAdded: num(r.bytes_added),
    bytesTotal: num(r.bytes_total),
    filesTotal: r.files_total,
    filesNew: r.files_new,
    missing: r.missing,
    readableLocations: r.readable_locations,
    readableBytes: num(r.readable_bytes),
    sameVolume: r.same_volume,
    bucketVersioningOk: r.bucket_versioning_ok,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    verifiedAt: r.verified_at?.toISOString() ?? null,
    error: r.error,
    detail: r.detail,
  };
}

/** The kinds that make a snapshot of the live data (a drill or verify only reads one). */
export const SNAPSHOT_KINDS: readonly BackupRunKind[] = ['nightly', 'manual', 'pre_upgrade'];

/** SQL: a run that left a good snapshot behind. A `warning` counts unless it is the size
 * check's, whose snapshot is suspect (plan Q25). */
export const GOOD_RUN_SQL = `(status = 'ok' OR (status = 'warning'
  AND error IS DISTINCT FROM 'backup_suspicious_size'))`;

/** A run holds the backup lock this long at most (the `backup` job's 4-hour expiry, §3.1b);
 * an older `running` row is a crashed run, not a running one. */
export const RUNNING_FOR_AT_MOST_HOURS = 4;

/** Whether a snapshot-making run is under way (the `409 backup_running` check). */
export async function backupRunning(client: Pick<pg.ClientBase, 'query'>): Promise<boolean> {
  const { rows } = await client.query<{ running: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.backup_runs
        WHERE status = 'running' AND kind = ANY($1::text[])
          AND started_at > now() - make_interval(hours => $2)) AS running`,
    [SNAPSHOT_KINDS, RUNNING_FOR_AT_MOST_HOURS],
  );
  return rows[0]?.running === true;
}

/**
 * Whether a `backup` job waits in pg-boss or is being worked: a "Run now" the worker hasn't
 * started yet has no backup_runs row, so backupRunning() can't see it. Read on kept_system (the
 * pg-boss login; kept_app may only send). A second "Run now" in that window is refused with
 * 409 backup_running rather than accepted and then skipped (decision in the spec's log).
 */
export async function backupQueued(system: Pick<pg.Pool, 'query'>): Promise<boolean> {
  const { rows } = await system.query<{ queued: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pgboss.job
        WHERE name = 'backup' AND state IN ('created', 'active')
          AND start_after <= now()
          AND created_on > now() - make_interval(hours => $1)) AS queued`,
    [RUNNING_FOR_AT_MOST_HOURS],
  );
  return rows[0]?.queued === true;
}
