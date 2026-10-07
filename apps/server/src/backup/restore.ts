import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { audited } from '../audit/audited.js';
import * as schema from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import type { BlobStore } from '../storage/blob-store.js';
import { digestMismatches, digestSession, tableDigests } from './digests.js';
import {
  type BackupManifest,
  type BlobEntry,
  blobToFile,
  countRows,
  hashBlob,
  hashFile,
  ownedTables,
  parseManifest,
} from './manifest.js';
import type { PgTools } from './pg-tools.js';
import type { Restic, ResticRepo } from './restic/restic.js';
import type { BackupTarget } from './target.js';

// `kept admin restore` (D66: restore into a new database, verify, then swap; step-8 plan T7).
//
// Into an EMPTY database only (made the way setup makes one: owned by kept_owner, with the roles
// and the extensions in place; docs/runbooks/backup-restore.md). It refuses anything else, so it
// can never be pointed at the live database by mistake. Then:
//   1. the dump: from a restic snapshot (`restic restore --include /backup/db` into
//      KEPT_DATA_DIR/tmp/restore-…), or from an alpha run (`--legacy`); its size and SHA-256
//      checked against the manifest;
//   2. pg_restore's major version against the server's, and the extensions, before any data;
//   3. pg_restore, in one transaction (all or nothing);
//   4. every table's row count against the manifest and, for a restic snapshot, every table's
//      data digest (digests.ts, L78): a table whose digest differs is a mismatch even when its
//      count is the same;
//   5. the files: put back into the store KEPT_STORAGE names, each SHA-256 checked (from the
//      snapshot's /blobs with local storage); with S3 storage the files never left the bucket
//      (D144), and each one is checked to be there, unchanged. The drill checks a sample instead;
//   6. `instance.restore` audited in the restored database.
// Kept never swaps databases: renaming one needs the superuser (D66, Q13). The command prints
// the runbook's superuser commands. Secret values come back sealed as they were; the keys from
// the recovery kit open them.

export type RestoreReport = {
  /** The snapshot (short id) or the alpha run restored. */
  source: string;
  backupAt: string;
  tables: number;
  rows: number;
  /** Tables whose restored count differs from the manifest. */
  mismatches: { table: string; expected: number; actual: number }[];
  /** Tables whose data digest differs (a restic snapshot; the alpha's had none). */
  digestMismatches: string[];
  files: number;
  filesPut: number;
  /** Files checked against their SHA-256 (all when putting back, a sample in the drill). */
  filesChecked: number;
  /** Keys whose bytes are not there or don't match. */
  filesBad: string[];
};

/** Whether everything checked out. */
export function restoreVerified(r: RestoreReport): boolean {
  return r.mismatches.length === 0 && r.digestMismatches.length === 0 && r.filesBad.length === 0;
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** Every schema and relation a Kept database has, so "empty" means none of them. */
async function assertEmpty(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ what: string }>(
    `SELECT n.nspname || '.' || c.relname AS what
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = c.oid AND d.deptype = 'e')
     UNION ALL
     SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
        AND nspname NOT LIKE 'pg\\_%'
     LIMIT 3`,
  );
  if (rows.length > 0) {
    throw new RestoreError(
      `the target database is not empty (it has ${rows.map((r) => r.what).join(', ')}…); restore only into a new, empty database`,
    );
  }
}

/** Copies the backup's copy of a file to a local file; null when the backup doesn't hold the
 * files (S3 storage, a database-only snapshot). */
type FileSource = ((key: string, file: string) => Promise<void>) | null;

type FilesMode =
  | { mode: 'put'; blobs: BlobStore }
  | { mode: 'check'; blobs: BlobStore; sample: number | 'all' };

type CoreOptions = {
  ownerUrl: string;
  manifest: BackupManifest;
  dumpFile: string;
  source: string;
  files: FilesMode;
  fileSource: FileSource;
  pgTools: PgTools;
  work: string;
  print: (line: string) => void;
};

/** A spread sample of `n` items (every k-th), or all of them. */
export function sampleOf<T>(items: readonly T[], n: number | 'all'): T[] {
  if (n === 'all' || items.length <= n) return [...items];
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)] as T);
}

async function restoreCore(o: CoreOptions): Promise<RestoreReport> {
  const { manifest, print } = o;
  const got = await hashFile(o.dumpFile);
  if (got.sha256 !== manifest.database.sha256 || got.bytes !== manifest.database.bytes) {
    throw new RestoreError('the dump does not match its manifest (size or SHA-256); not restored');
  }
  print(`Backup ${o.source} of ${manifest.createdAt}: the dump checks out.`);

  const client = new pg.Client({ connectionString: o.ownerUrl, application_name: 'kept-restore' });
  client.on('error', () => {});
  await client.connect();
  try {
    await assertEmpty(client);
    const { rows } = await client.query<{ num: number }>(
      `SELECT current_setting('server_version_num')::int AS num`,
    );
    const serverMajor = Math.floor((rows[0]?.num ?? 0) / 10000);
    const { restore } = await o.pgTools.versions();
    if (restore !== serverMajor) {
      throw new RestoreError(
        `pg_restore is version ${restore} and the database ${serverMajor}; they must match`,
      );
    }
    if (serverMajor < manifest.postgres.dumpMajor) {
      throw new RestoreError(
        `the backup came from PostgreSQL ${manifest.postgres.dumpMajor}; this database is ${serverMajor}`,
      );
    }
    const have = new Set(
      (await client.query<{ extname: string }>('SELECT extname FROM pg_extension')).rows.map(
        (r) => r.extname,
      ),
    );
    const lacking = manifest.extensions.filter((e) => !have.has(e));
    if (lacking.length > 0) {
      throw new RestoreError(
        `the target database lacks the extension(s) ${lacking.join(', ')}; a superuser creates them first (see the runbook)`,
      );
    }
    await o.pgTools.restore(o.ownerUrl, o.dumpFile);
    print('Database restored.');

    // Counts and data digests, before anything else writes to the restored database.
    const owned = await ownedTables(client);
    const counts = await countRows(client, owned);
    const mismatches: RestoreReport['mismatches'] = [];
    for (const [table, expected] of Object.entries(manifest.tables)) {
      const actual = counts[table];
      if (actual !== expected) mismatches.push({ table, expected, actual: actual ?? -1 });
    }
    const rowsTotal = Object.values(counts).reduce((n, c) => n + c, 0);
    print(
      mismatches.length === 0
        ? `Row counts match the backup: ${Object.keys(manifest.tables).length} tables, ${rowsTotal} rows.`
        : `Row counts DIFFER in ${mismatches.length} table(s): ${mismatches.map((m) => `${m.table} ${m.actual}/${m.expected}`).join(', ')}`,
    );
    let digestsDiffer: string[] = [];
    if (manifest.digests) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await digestSession(client, true);
        digestsDiffer = digestMismatches(manifest.digests, await tableDigests(client, owned));
      } finally {
        await client.query('COMMIT').catch(() => {});
      }
      print(
        digestsDiffer.length === 0
          ? 'Data digests match the backup, table by table.'
          : `Data DIFFERS in ${digestsDiffer.length} table(s): ${digestsDiffer.join(', ')}`,
      );
    }

    // The files.
    const filesBad: string[] = [];
    let filesPut = 0;
    let filesChecked = 0;
    const blobs = o.files.blobs;
    const checkInStore = async (blob: BlobEntry) => {
      filesChecked += 1;
      try {
        const there = await hashBlob(blobs, blob.key);
        if (there.sha256 !== blob.sha256) filesBad.push(blob.key);
      } catch {
        filesBad.push(blob.key);
      }
    };
    if (o.files.mode === 'put') {
      const mimes = new Map(
        (
          await client.query<{ key: string; mime: string }>(
            'SELECT DISTINCT ON (storage_key) storage_key AS key, mime FROM public.files',
          )
        ).rows.map((r) => [r.key, r.mime]),
      );
      if ('ensureBucket' in blobs && typeof blobs.ensureBucket === 'function') {
        await (blobs as { ensureBucket: () => Promise<void> }).ensureBucket();
      }
      for (const blob of manifest.blobs) {
        if (!o.fileSource) {
          // S3 storage (D144): the files stayed in the bucket; each must be there, unchanged.
          await checkInStore(blob);
          continue;
        }
        const tmp = path.join(o.work, `blob-${randomUUID()}`);
        filesChecked += 1;
        try {
          if (await blobs.exists(blob.key)) {
            const there = await blobToFile(blobs, blob.key, tmp);
            if (there.sha256 !== blob.sha256) {
              throw new RestoreError(
                `the file store already holds ${blob.key} with other content; restore into an empty file store`,
              );
            }
            continue;
          }
          await o.fileSource(blob.key, tmp);
          const copy = await hashFile(tmp);
          if (copy.sha256 !== blob.sha256 || copy.bytes !== blob.bytes) {
            filesBad.push(blob.key);
            continue;
          }
          await blobs.put(blob.key, tmp, {
            contentType: mimes.get(blob.key) ?? 'image/jpeg',
            bytes: copy.bytes,
          });
          filesPut += 1;
        } catch (err) {
          if (err instanceof RestoreError) throw err;
          filesBad.push(blob.key);
        } finally {
          await rm(tmp, { force: true });
        }
      }
      print(`Files: ${manifest.blobs.length} checked, ${filesPut} put back.`);
    } else {
      for (const blob of sampleOf(manifest.blobs, o.files.sample)) {
        if (!o.fileSource) {
          await checkInStore(blob);
          continue;
        }
        const tmp = path.join(o.work, `blob-${randomUUID()}`);
        filesChecked += 1;
        try {
          await o.fileSource(blob.key, tmp);
          const copy = await hashFile(tmp);
          if (copy.sha256 !== blob.sha256) filesBad.push(blob.key);
        } catch {
          filesBad.push(blob.key);
        } finally {
          await rm(tmp, { force: true });
        }
      }
      print(`Files: ${filesChecked} of ${manifest.blobs.length} checked against their SHA-256.`);
    }
    if (filesBad.length > 0) {
      print(
        `${filesBad.length} file(s) missing or not matching: ${filesBad.slice(0, 10).join(', ')}`,
      );
    }
    if (manifest.missing.length > 0) {
      print(
        `${manifest.missing.length} file(s) were already missing from the file store when this backup was made; their rows show them as unavailable.`,
      );
    }

    // The restore, in the restored database's own audit.
    await client.query('BEGIN');
    try {
      await audited(drizzle(client, { schema }) as unknown as Tx, {
        locationId: null,
        ownerAccountId: null,
        actor: { type: 'system', id: null },
        action: 'instance.restore',
        entity: { type: 'instance', id: null },
        before: null,
        after: {
          backup: o.source,
          backup_at: manifest.createdAt,
          rows: rowsTotal,
          files: manifest.blobs.length,
          mismatches: mismatches.length + digestsDiffer.length,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    return {
      source: o.source,
      backupAt: manifest.createdAt,
      tables: Object.keys(manifest.tables).length,
      rows: rowsTotal,
      mismatches,
      digestMismatches: digestsDiffer,
      files: manifest.blobs.length,
      filesPut,
      filesChecked,
      filesBad,
    };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------------------------
// From restic

export type ResticRestoreDeps = {
  ownerUrl: string;
  restic: Restic;
  repo: ResticRepo;
  /** A snapshot id (8 hex or more), or `latest` (the newest Kept snapshot). */
  snapshot: string;
  blobs: BlobStore;
  pgTools: PgTools;
  /** KEPT_DATA_DIR/tmp: the snapshot's files wait here. */
  tmpDir: string;
  print?: (line: string) => void;
  /** The drill: check a sample of the files (or all), put nothing. Default: put them back. */
  checkFiles?: number | 'all';
};

/** The snapshot's full id; `latest` is the newest one Kept made. */
export async function resolveSnapshot(
  restic: Restic,
  repo: ResticRepo,
  snapshot: string,
): Promise<string> {
  const snaps = await restic.snapshots(repo, { tags: ['kept'] });
  if (snapshot === 'latest') {
    const newest = snaps[0];
    if (!newest) throw new RestoreError(`no snapshots in ${repo.description}`);
    return newest.id;
  }
  if (!/^[0-9a-f]{8,64}$/.test(snapshot)) {
    throw new RestoreError(`${snapshot} is not a snapshot id (kept admin backup --list)`);
  }
  const found = snaps.filter((s) => s.id.startsWith(snapshot));
  if (found.length !== 1) {
    throw new RestoreError(
      found.length === 0
        ? `no snapshot ${snapshot} in ${repo.description}`
        : `${snapshot} names more than one snapshot; give more of its id`,
    );
  }
  return (found[0] as { id: string }).id;
}

export async function runResticRestore(deps: ResticRestoreDeps): Promise<RestoreReport> {
  const print = deps.print ?? (() => {});
  const id = await resolveSnapshot(deps.restic, deps.repo, deps.snapshot);
  const work = path.join(deps.tmpDir, `restore-${id.slice(0, 8)}-${randomUUID().slice(0, 6)}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const dbTree = path.join(work, 'db');
    await mkdir(dbTree, { mode: 0o700 });
    await deps.restic.restore(deps.repo, id, { target: dbTree, include: ['/backup/db'] });
    const dbDir = path.join(dbTree, 'backup', 'db');
    let raw: Buffer;
    try {
      raw = await readFile(path.join(dbDir, 'manifest.json'));
    } catch {
      throw new RestoreError(`snapshot ${id.slice(0, 8)} holds no Kept backup manifest`);
    }
    const manifest = parseManifest(raw);
    if (!manifest.digests) {
      throw new RestoreError('a snapshot manifest without data digests: not a Kept restic backup');
    }
    let fileSource: FileSource = null;
    if (manifest.filesInSnapshot && manifest.blobs.length > 0) {
      const filesTree = path.join(work, 'files');
      await mkdir(filesTree, { mode: 0o700 });
      const wanted =
        deps.checkFiles === undefined
          ? ['/blobs']
          : sampleOf(manifest.blobs, deps.checkFiles).map((b) => `/blobs/${b.key}`);
      await deps.restic.restore(deps.repo, id, { target: filesTree, include: wanted });
      fileSource = async (key, file) => {
        await copyFile(path.join(filesTree, 'blobs', key), file);
      };
    }
    return await restoreCore({
      ownerUrl: deps.ownerUrl,
      manifest,
      dumpFile: path.join(dbDir, manifest.database.file),
      source: id.slice(0, 8),
      files:
        deps.checkFiles === undefined
          ? { mode: 'put', blobs: deps.blobs }
          : { mode: 'check', blobs: deps.blobs, sample: deps.checkFiles },
      fileSource,
      pgTools: deps.pgTools,
      work,
      print,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// From an alpha run (`--legacy`, plan Q1: for one release)

export type RestoreDeps = {
  ownerUrl: string;
  target: BackupTarget;
  runId: string;
  blobs: BlobStore;
  pgTools: PgTools;
  tmpDir: string;
  print?: (line: string) => void;
};

const RUN_ID = /^[0-9TZ]+-[0-9a-f]{6}$/;

export async function runRestore(deps: RestoreDeps): Promise<RestoreReport> {
  const print = deps.print ?? (() => {});
  if (!RUN_ID.test(deps.runId)) throw new RestoreError(`${deps.runId} is not a backup id`);
  const { target } = deps;
  const manifestName = `runs/${deps.runId}/manifest.json`;
  if (!(await target.exists(manifestName))) {
    throw new RestoreError(`no complete backup ${deps.runId} in ${target.description}`);
  }
  const manifest = parseManifest(await target.read(manifestName));
  const work = path.join(deps.tmpDir, `restore-${randomUUID()}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const dumpFile = path.join(work, 'db.dump');
    await target.get(`runs/${deps.runId}/${manifest.database.file}`, dumpFile);
    return await restoreCore({
      ownerUrl: deps.ownerUrl,
      manifest,
      dumpFile,
      source: deps.runId,
      files: { mode: 'put', blobs: deps.blobs },
      fileSource: (key, file) => target.get(`blobs/${key}`, file),
      pgTools: deps.pgTools,
      work,
      print,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The runbook's swap (D66, Q13), which needs the superuser: Kept prints it, never runs it. */
export function swapCommands(restoredUrl: string): string[] {
  const restored = decodeURIComponent(new URL(restoredUrl).pathname.replace(/^\//, ''));
  return [
    'To switch Kept to the restored database: stop Kept, then, as the database superuser,',
    '  ALTER DATABASE kept RENAME TO kept_before_restore;',
    `  ALTER DATABASE ${restored} RENAME TO kept;`,
    "(Use your live database's name if it isn't `kept`.) Start Kept with the keys from the",
    'recovery kit and this file store. Keep kept_before_restore until you are sure, then DROP it.',
  ];
}
