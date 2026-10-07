import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BACKUP_KEEP_PRE_UPGRADE,
  type BackupRun,
  type BackupRunKind,
  type BackupRunState,
  KEPT_VERSION,
} from '@kept/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { type AlertDeps, raiseAlert, resolveAlert } from '../alerts/alerts.js';
import { audited } from '../audit/audited.js';
import * as schema from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import { BlobNotFoundError, type BlobStore } from '../storage/blob-store.js';
import { digestSession, tableDigests } from './digests.js';
import {
  type BackupManifest,
  type BlobEntry,
  countRows,
  extensionsOf,
  hashBlob,
  hashFile,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  ownedTables,
  parseManifest,
  referencedBlobs,
} from './manifest.js';
import { PgToolError, type PgTools, redact } from './pg-tools.js';
import { openRepo } from './restic/repo.js';
import { type Restic, ResticError } from './restic/restic.js';
import {
  BACKUP_RUN_COLUMNS,
  type BackupRunRow,
  backupRunOf,
  GOOD_RUN_SQL,
  SNAPSHOT_KINDS,
} from './runs.js';
import type { ResolvedBackupSettings } from './settings.js';
import { sizeCheck, watchedRows } from './size-check.js';

// The backup, on restic (step-8 plan T5; D64, D66, D144, D159; L78, L79). One run, as kept_owner,
// under a session advisory lock (BACKUP_LOCK_KEY) so a nightly, a manual and a pre-upgrade run
// never overlap (a second one is BackupRunningError, the route's 409 `backup_running`):
//   1. a `backup_runs` row, `running`;
//   2. unchanged from the alpha (T31c): a REPEATABLE READ READ ONLY transaction exports its
//      snapshot; in it, every table's row count, every blob key the rows reference, the
//      extensions, and pg_dump (custom format) of exactly that snapshot, into the stable
//      directory KEPT_DATA_DIR/backup/db/db.dump;
//   3. new: per-table data digests in the same snapshot (digests.ts);
//   4. new: the size check (size-check.ts) against the last good run;
//   5. the manifest (version 2: counts, digests, every referenced blob's key, bytes and SHA-256),
//      written last in backup/db/; a blob already in the previous manifest keeps its entry (keys
//      are never reused), a new one is hashed from the store;
//   6. the readable copy (T6, D159) into backup/readable/, through `readable`; until T6 lands
//      nothing is passed and the step does nothing;
//   7. `restic init` when the repository is new, then `restic backup` of `backup` and, with local
//      storage, `blobs` (never tmp/ or .cache/; never blobs' reports, export ZIPs or import
//      archives, which no row of `files` references), run from KEPT_DATA_DIR with relative paths
//      so the snapshot's paths never change (R1). Tags: `kept`, the kind, `v<version>`;
//   8. with local storage, `restic ls` of the new snapshot's /blobs against the manifest: a key
//      it lacks is `missing` (a purge that raced the run);
//   9. retention: nightly and manual runs each keep 7 daily, 4 weekly, 6 monthly of their own
//      series, `pre_upgrade` its last 3; grouped by host only (the version tag would otherwise
//      make each release a group of its own and escape retention), then pruned. Skipped when
//      the size check failed;
//  10. the row finishes (`ok`, `warning`, `failed`), `instance.backup` is audited as system with
//      figures only, `backup_failed` and `backup_suspicious_size` are raised or resolved.
// A database-only run (T8's pre-upgrade snapshot) does all but 6 and 8, with `backup/db` alone.
//
// Nothing secret reaches a row, a log line, the audit or an alert: the repository's password and
// credentials live only in the restic child's environment (restic/run.ts), and errors are
// recorded as codes. Secret values are in the dump as the sealed ciphertexts they are in the
// database; the recovery kit's keys open them after a restore.

/** pg_try_advisory_lock key of a running backup ('kbup'). */
export const BACKUP_LOCK_KEY = 0x6b627570;

/** The stable directory a snapshot adds beside the files: KEPT_DATA_DIR/backup. */
export const BACKUP_DIR_NAME = 'backup';

/** Under KEPT_DATA_DIR/blobs, what is never backed up: reports, export ZIPs, import archives
 * (storage/blob-store.ts key prefixes `r/`, `x/`, `i/`); each lives for days at most. */
const TRANSIENT_BLOB_DIRS = ['r', 'x', 'i'];

export type SnapshotKind = Extract<BackupRunKind, 'nightly' | 'manual' | 'pre_upgrade'>;

/** T6's readable copy (D159): writes every location's readable export into `dir`. */
export type ReadableCopy = (
  dir: string,
) => Promise<{ locations: number; bytes: number; failed: { locationId: string; error: string }[] }>;

export type SnapshotDeps = {
  /** kept_owner, on the live database. */
  ownerUrl: string;
  restic: Restic;
  settings: ResolvedBackupSettings;
  /** KEPT_DATA_DIR. */
  dataDir: string;
  /** KEPT_STORAGE. */
  storage: 'local' | 's3';
  blobs: BlobStore;
  pgTools: PgTools;
  /** The running image's version (the `v<version>` tag, the manifest). */
  version?: string;
  /** T6. Absent: the snapshot holds no readable copy. */
  readable?: ReadableCopy | null;
  /** S3 file storage (D144): whether the file bucket keeps versions; null when unknown. */
  bucketVersioning?: (() => Promise<boolean | null>) | null;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** The instance admins' alerts (D166). Absent: none raised. */
  alerts?: AlertDeps;
};

export type SnapshotOptions = {
  kind: SnapshotKind;
  /** The database alone: no files, no readable copy (T8's pre-upgrade snapshot). */
  databaseOnly?: boolean;
  /** A pre-upgrade snapshot's versions (T8). */
  fromVersion?: string | null;
  toVersion?: string | null;
  /** `kept admin backup --accept-size`: a real shrink becomes the new baseline. */
  acceptSize?: boolean;
  /** The run's id, chosen by Admin → Backups' "Run now" (T10: its 202 names it); absent, a new
   * one. */
  runId?: string;
  /** The snapshot's time (tests of retention over faked days: restic's `--time`). */
  time?: Date;
};

/** A run failed; `code` is what `backup_runs.error` records. */
export class BackupError extends Error {
  readonly code: string;
  constructor(message: string, code = 'backup_failed') {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** Another backup holds the lock (the route's 409 `backup_running`). */
export class BackupRunningError extends BackupError {
  constructor() {
    super('a backup is already running', 'backup_running');
    this.name = 'BackupRunningError';
  }
}

/** The error code a failure is recorded with: short, never a message with data. */
export function errorCodeOf(err: unknown): string {
  if (err instanceof BackupError) return err.code;
  if (err instanceof ResticError) {
    return err.reason === 'unreachable' ? 'backup_target_unreachable' : `restic_${err.reason}`;
  }
  if (err instanceof PgToolError) return 'pg_tool_failed';
  return 'backup_failed';
}

async function connect(url: string, name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  client.on('error', () => {});
  await client.connect();
  return client;
}

type Figures = {
  snapshotId: string | null;
  dbBytes: number;
  bytesAdded: number | null;
  bytesTotal: number | null;
  filesTotal: number | null;
  filesNew: number | null;
  missing: number;
  readableLocations: number | null;
  readableBytes: number | null;
  sameVolume: boolean | null;
  bucketVersioningOk: boolean | null;
  status: Exclude<BackupRunState, 'running'>;
  error: string | null;
  detail: Record<string, unknown>;
  /** The size check's reasons, for the alert. */
  shrank: string[];
};

const FAILED: Omit<Figures, 'error'> = {
  snapshotId: null,
  dbBytes: 0,
  bytesAdded: null,
  bytesTotal: null,
  filesTotal: null,
  filesNew: null,
  missing: 0,
  readableLocations: null,
  readableBytes: null,
  sameVolume: null,
  bucketVersioningOk: null,
  status: 'failed',
  detail: {},
  shrank: [],
};

/**
 * One snapshot, recorded. Returns the finished row (`ok` or `warning`); throws (after recording
 * the failure) when it fails, and BackupRunningError, recording nothing, when another run holds
 * the lock.
 */
export async function runSnapshot(deps: SnapshotDeps, opts: SnapshotOptions): Promise<BackupRun> {
  const lock = await connect(deps.ownerUrl, 'kept-backup');
  try {
    const { rows } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      BACKUP_LOCK_KEY,
    ]);
    if (!rows[0]?.ok) throw new BackupRunningError();
    try {
      return await recorded(deps, opts, lock);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [BACKUP_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await lock.end().catch(() => {});
  }
}

/** Whether a run holds the backup lock now (`kept admin backup unlock` refuses then). */
export async function backupLockHeld(client: pg.ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks
                     WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database
                                                                  WHERE datname = current_database())
                       AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted) AS held`,
    [BACKUP_LOCK_KEY],
  );
  return rows[0]?.held === true;
}

async function recorded(
  deps: SnapshotDeps,
  opts: SnapshotOptions,
  client: pg.Client,
): Promise<BackupRun> {
  const version = deps.version ?? KEPT_VERSION;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.backup_runs (id, kind, status, storage_mode, target, from_version,
                                     to_version)
     VALUES (coalesce($6::uuid, uuidv7()), $1, 'running', $2, $3, $4, $5) RETURNING id`,
    [
      opts.kind,
      deps.storage,
      deps.settings.description,
      opts.fromVersion ?? null,
      opts.toVersion ?? null,
      opts.runId ?? null,
    ],
  );
  const id = rows[0]?.id as string;
  const logErr = (what: string) => (err: unknown) =>
    deps.log?.error({ backup: id, err: String(err) }, `could not ${what}`);
  let figures: Figures;
  try {
    figures = await snapshotOnce(deps, opts, client, id, version);
  } catch (err) {
    const code = errorCodeOf(err);
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    deps.log?.error({ backup: id, kind: opts.kind, error: code, err: message }, 'backup failed');
    await finish(client, id, opts.kind, { ...FAILED, error: code }).catch(
      logErr('record the failed backup'),
    );
    if (deps.alerts) {
      const lastOk = await lastGoodFinishedAt(client).catch(() => null);
      await raiseAlert(deps.alerts, 'backup_failed', 'backup_failed', {
        error: code,
        lastOk,
      }).catch(logErr('raise the backup alert'));
    }
    throw err;
  }
  const run = await finish(client, id, opts.kind, figures);
  deps.log?.info(
    {
      backup: id,
      kind: opts.kind,
      status: run.status,
      snapshot: run.snapshotId?.slice(0, 8),
      bytesAdded: run.bytesAdded,
    },
    'backup done',
  );
  if (deps.alerts) {
    const alerts = deps.alerts;
    await resolveAlert(alerts.pools, 'backup_failed').catch(logErr('resolve the backup alert'));
    if (figures.error === 'backup_suspicious_size') {
      await raiseAlert(alerts, 'backup_suspicious_size', 'backup_suspicious_size', {
        shrank: figures.shrank,
        snapshot: run.snapshotId?.slice(0, 8) ?? null,
      }).catch(logErr('raise the size alert'));
    } else if (opts.kind !== 'pre_upgrade') {
      await resolveAlert(alerts.pools, 'backup_suspicious_size').catch(
        logErr('resolve the size alert'),
      );
    }
  }
  return run;
}

async function lastGoodFinishedAt(client: pg.ClientBase): Promise<string | null> {
  const { rows } = await client.query<{ at: Date }>(
    `SELECT finished_at AS at FROM public.backup_runs
      WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL}
      ORDER BY finished_at DESC LIMIT 1`,
    [SNAPSHOT_KINDS],
  );
  return rows[0]?.at.toISOString() ?? null;
}

/** The figures the size check compares with: the last good nightly or manual run's. */
async function lastGoodFigures(
  client: pg.ClientBase,
): Promise<{ dbBytes: number; rows: Record<string, number> } | null> {
  const { rows } = await client.query<{ db_bytes: string; detail: Record<string, unknown> }>(
    `SELECT db_bytes, detail FROM public.backup_runs
      WHERE kind = ANY($1::text[]) AND ${GOOD_RUN_SQL} AND db_bytes IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`,
    [['nightly', 'manual']],
  );
  const r = rows[0];
  if (!r) return null;
  const watched = r.detail.rows;
  const counts: Record<string, number> = {};
  if (watched && typeof watched === 'object') {
    for (const [k, v] of Object.entries(watched)) if (typeof v === 'number') counts[k] = v;
  }
  return { dbBytes: Number(r.db_bytes), rows: counts };
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.partial`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
}

async function snapshotOnce(
  deps: SnapshotDeps,
  opts: SnapshotOptions,
  client: pg.Client,
  id: string,
  version: string,
): Promise<Figures> {
  const started = new Date();
  const backupDir = path.join(deps.dataDir, BACKUP_DIR_NAME);
  const dbDir = path.join(backupDir, 'db');
  const tmpDir = path.join(deps.dataDir, 'tmp');
  await mkdir(dbDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(dbDir, 'manifest.json');
  const dumpFile = path.join(dbDir, 'db.dump');
  const filesInSnapshot = deps.storage === 'local' && !opts.databaseOnly;

  // The previous manifest's blob entries: a key is never reused, so its hash still holds.
  const known = new Map<string, BlobEntry>();
  try {
    for (const b of parseManifest(await readFile(manifestFile)).blobs) known.set(b.key, b);
  } catch {
    // None yet, or unreadable: every blob is hashed afresh.
  }

  // 2 and 3: one snapshot; its counts, keys, extensions, digests, and the dump of exactly that.
  const versions = await deps.pgTools.versions();
  const partialDump = `${dumpFile}.${randomUUID()}.partial`;
  const tx = await connect(deps.ownerUrl, 'kept-backup-snapshot');
  let snap: {
    server: string;
    tables: Record<string, number>;
    referenced: { key: string; sha256: string | null }[];
    extensions: string[];
    digests: Record<string, string>;
  };
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await digestSession(tx, true);
    const { rows } = await tx.query<{ snapshot: string; server: string; num: number }>(
      `SELECT pg_export_snapshot() AS snapshot, current_setting('server_version') AS server,
              current_setting('server_version_num')::int AS num`,
    );
    const head = rows[0];
    if (!head) throw new BackupError('the database returned no snapshot');
    const serverMajor = Math.floor(head.num / 10000);
    if (versions.dump !== serverMajor) {
      throw new BackupError(
        `pg_dump is version ${versions.dump} and the database ${serverMajor}; they must match (Kept's image ships the right one)`,
        'pg_version_mismatch',
      );
    }
    const owned = await ownedTables(tx);
    const tables = await countRows(tx, owned);
    const referenced = await referencedBlobs(tx);
    const extensions = await extensionsOf(tx);
    await deps.pgTools.dump(deps.ownerUrl, partialDump, { snapshot: head.snapshot });
    const digests = await tableDigests(tx, owned);
    await tx.query('COMMIT');
    snap = { server: head.server, tables, referenced, extensions, digests };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    await rm(partialDump, { force: true });
    throw err;
  } finally {
    await tx.end().catch(() => {});
  }
  await rename(partialDump, dumpFile);
  const db = await hashFile(dumpFile);

  // 4: the size check.
  const rows = watchedRows(snap.tables);
  const sized =
    opts.acceptSize || opts.kind === 'pre_upgrade'
      ? { ok: true, reasons: [] as string[] }
      : sizeCheck({ dbBytes: db.bytes, rows }, await lastGoodFigures(client));

  // 5: the files' entries, then the manifest, last.
  const entries: BlobEntry[] = [];
  const missing = new Set<string>();
  let corrupt = 0;
  if (!opts.databaseOnly) {
    for (const { key, sha256 } of snap.referenced) {
      const previous = known.get(key);
      if (previous) {
        entries.push(previous);
        continue;
      }
      try {
        const got = await hashBlob(deps.blobs, key);
        if (sha256 && got.sha256 !== sha256) {
          corrupt += 1;
          deps.log?.error({ backup: id, key }, "backup: a file's bytes don't match its checksum");
        }
        entries.push({ key, bytes: got.bytes, sha256: got.sha256 });
      } catch (err) {
        if (!(err instanceof BlobNotFoundError) && (err as Error).name !== 'BlobNotFoundError') {
          throw err;
        }
        missing.add(key);
        deps.log?.error({ backup: id, key }, 'backup: a file row has no blob in the store');
      }
    }
  }
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    id,
    kind: opts.kind,
    createdAt: started.toISOString(),
    keptVersion: version,
    postgres: { server: snap.server, dumpMajor: versions.dump },
    extensions: snap.extensions,
    database: { file: 'db.dump', bytes: db.bytes, sha256: db.sha256 },
    tables: snap.tables,
    digests: snap.digests,
    storage: deps.storage,
    filesInSnapshot,
    blobs: entries,
    missing: [...missing].sort(),
  };
  await writeAtomically(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  // 6: the readable copy (T6).
  let readable: Awaited<ReturnType<ReadableCopy>> | null = null;
  if (!opts.databaseOnly && deps.readable) {
    const dir = path.join(backupDir, 'readable');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    readable = await deps.readable(dir);
  }

  // 7–9: restic.
  const opened = await openRepo(deps.settings.target, deps.settings.password, { tmpDir });
  let summary: Awaited<ReturnType<Restic['backup']>>;
  let unreadable = 0;
  let removed = 0;
  let stats: Awaited<ReturnType<Restic['stats']>> | null = null;
  try {
    const { repo } = opened;
    const init = await deps.restic.init(repo);
    if (init.created) {
      deps.log?.info({ backup: id, target: repo.description }, 'restic repository created');
    }
    const paths = opts.databaseOnly
      ? [`${BACKUP_DIR_NAME}/db`]
      : [BACKUP_DIR_NAME, ...(filesInSnapshot ? ['blobs'] : [])];
    const exclude = filesInSnapshot
      ? TRANSIENT_BLOB_DIRS.map((d) => path.join(deps.dataDir, 'blobs', d))
      : [];
    try {
      summary = await deps.restic.backup(repo, {
        paths,
        cwd: deps.dataDir,
        tags: ['kept', opts.kind, `v${version}`],
        exclude,
        ...(opts.time ? { time: opts.time } : {}),
      });
    } catch (err) {
      if (!(err instanceof ResticError) || err.reason !== 'partial' || !err.partial) throw err;
      summary = err.partial.summary;
      unreadable = err.partial.unreadable;
    }

    // 8: what the snapshot holds of the files.
    if (filesInSnapshot && entries.length > 0) {
      const inSnapshot = new Set(
        (await deps.restic.ls(repo, summary.snapshotId, { path: '/blobs' }))
          .filter((n) => n.type === 'file')
          .map((n) => n.path),
      );
      for (const e of entries) if (!inSnapshot.has(`/blobs/${e.key}`)) missing.add(e.key);
    }

    // 9: retention, unless this run is suspect.
    if (sized.ok) {
      const result = await deps.restic.forget(repo, {
        tags: ['kept', opts.kind],
        keep:
          opts.kind === 'pre_upgrade'
            ? { last: BACKUP_KEEP_PRE_UPGRADE }
            : { ...deps.settings.keep },
        groupBy: ['host'],
        prune: true,
      });
      removed = result.removed.length;
    }
    stats = await deps.restic.stats(repo).catch((err: unknown) => {
      deps.log?.error({ backup: id, err: String(err) }, 'backup: restic stats failed');
      return null;
    });
  } finally {
    await opened.dispose();
  }

  let sameVolume: boolean | null = null;
  if (deps.settings.target.kind === 'dir') {
    const there = await stat(deps.settings.target.path).catch(() => null);
    if (there) sameVolume = there.dev === (await stat(deps.dataDir)).dev;
  }
  const bucketVersioningOk =
    deps.storage === 's3' && deps.bucketVersioning
      ? await deps.bucketVersioning().catch(() => null)
      : null;

  let status: Figures['status'] = 'ok';
  let error: string | null = null;
  const readableFailed = readable?.failed.length ?? 0;
  if (!sized.ok) {
    status = 'warning';
    error = 'backup_suspicious_size';
  } else if (unreadable > 0) {
    status = 'warning';
    error = 'files_unreadable';
  } else if (corrupt > 0) {
    status = 'warning';
    error = 'blob_checksum_mismatch';
  } else if (readableFailed > 0) {
    status = 'warning';
    error = 'readable_incomplete';
  }
  return {
    snapshotId: summary.snapshotId,
    dbBytes: db.bytes,
    bytesAdded: summary.bytesAdded,
    bytesTotal: summary.bytesTotal,
    filesTotal: summary.filesTotal,
    filesNew: summary.filesNew,
    missing: missing.size,
    readableLocations: readable ? readable.locations : null,
    readableBytes: readable ? readable.bytes : null,
    sameVolume,
    bucketVersioningOk,
    status,
    error,
    detail: {
      rows,
      tables: Object.keys(snap.tables).length,
      ...(stats ? { snapshots: stats.snapshots, repositoryBytes: stats.totalBytes } : {}),
      forgotten: removed,
      ...(sized.ok ? {} : { shrank: sized.reasons, retentionSkipped: true }),
      ...(unreadable > 0 ? { unreadable } : {}),
      ...(corrupt > 0 ? { corrupt } : {}),
      ...(readableFailed > 0 ? { readableFailed } : {}),
      ...(opts.databaseOnly ? { databaseOnly: true } : {}),
    },
    shrank: sized.reasons,
  };
}

/** Finishes the row and audits `instance.backup` as system, in one transaction. */
async function finish(
  client: pg.Client,
  id: string,
  kind: SnapshotKind,
  f: Figures,
): Promise<BackupRun> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<BackupRunRow>(
      `UPDATE public.backup_runs
          SET status = $2, finished_at = now(), snapshot_id = $3, db_bytes = $4,
              bytes_added = $5, bytes_total = $6, files_total = $7, files_new = $8, missing = $9,
              readable_locations = $10, readable_bytes = $11, same_volume = $12,
              bucket_versioning_ok = $13, error = $14, detail = $15::jsonb
        WHERE id = $1
        RETURNING ${BACKUP_RUN_COLUMNS}`,
      [
        id,
        f.status,
        f.snapshotId,
        f.status === 'failed' ? null : f.dbBytes,
        f.bytesAdded,
        f.bytesTotal,
        f.filesTotal,
        f.filesNew,
        f.missing,
        f.readableLocations,
        f.readableBytes,
        f.sameVolume,
        f.bucketVersioningOk,
        f.error,
        JSON.stringify(f.detail),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('the backup run row went missing');
    await audited(drizzle(client, { schema }) as unknown as Tx, {
      locationId: null,
      ownerAccountId: null,
      actor: { type: 'system', id: null },
      action: 'instance.backup',
      entity: { type: 'instance', id: null },
      before: null,
      after: {
        backup: id,
        kind,
        status: f.status,
        target: row.target,
        snapshot: f.snapshotId?.slice(0, 8) ?? null,
        db_bytes: f.status === 'failed' ? null : f.dbBytes,
        bytes_added: f.bytesAdded,
        files: f.filesTotal,
        new_files: f.filesNew,
        missing: f.missing,
        error: f.error,
      },
    });
    await client.query('COMMIT');
    return backupRunOf(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** With S3 file storage (D144): whether the file bucket keeps versions. Null when the store
 * isn't S3. */
export async function bucketVersioningOf(blobs: BlobStore): Promise<boolean | null> {
  const s3 = blobs as Partial<{
    client: { send: (c: unknown) => Promise<unknown> };
    bucket: string;
  }>;
  if (!s3.client || typeof s3.bucket !== 'string') return null;
  const { GetBucketVersioningCommand } = await import('@aws-sdk/client-s3');
  const out = (await s3.client.send(new GetBucketVersioningCommand({ Bucket: s3.bucket }))) as {
    Status?: string;
  };
  return out.Status === 'Enabled';
}

// ---------------------------------------------------------------------------------------------
// The alpha status page's line (admin/routes.ts), read from backup_runs until T10's status
// replaces it.

export type BackupRunSummary = {
  id: string;
  status: 'ok' | 'failed';
  startedAt: string;
  finishedAt: string;
  target: string;
  bytes: number;
  dbBytes: number;
  files: number;
  newFiles: number;
  missing: number;
  sameVolume: boolean;
  error: string | null;
};

export type BackupStatus = { last: BackupRunSummary | null; lastOk: BackupRunSummary | null };

function summaryOf(r: BackupRunRow): BackupRunSummary {
  const run = backupRunOf(r);
  return {
    id: run.id,
    status: run.status === 'failed' ? 'failed' : 'ok',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    target: run.target,
    bytes: run.bytesTotal ?? run.dbBytes ?? 0,
    dbBytes: run.dbBytes ?? 0,
    files: run.filesTotal ?? 0,
    newFiles: run.filesNew ?? 0,
    missing: run.missing,
    sameVolume: run.sameVolume ?? false,
    error: run.error,
  };
}

/** The last finished snapshot run and the last good one. Any login that reads backup_runs. */
export async function readBackupStatus(client: pg.ClientBase): Promise<BackupStatus> {
  const pick = async (good: boolean) => {
    const { rows } = await client.query<BackupRunRow>(
      `SELECT ${BACKUP_RUN_COLUMNS} FROM public.backup_runs
        WHERE kind = ANY($1::text[]) AND status <> 'running' ${good ? `AND ${GOOD_RUN_SQL}` : ''}
        ORDER BY finished_at DESC LIMIT 1`,
      [SNAPSHOT_KINDS],
    );
    return rows[0] ? summaryOf(rows[0]) : null;
  };
  return { last: await pick(false), lastOk: await pick(true) };
}
