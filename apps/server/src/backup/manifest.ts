import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import type { BlobStore } from '../storage/blob-store.js';

// What a backup (and an export) records about the database and the files it copied (T31c): the
// row count of every table Kept owns, read in the same snapshot pg_dump dumped, and every blob the
// rows reference with its size and SHA-256. A restore checks all of it.
//
// Version 2 (step 8, restic; plan T5) adds per-table data digests (digests.ts), the run's kind,
// and whether the snapshot holds the files (`blobs/`, local storage only, D144). It lives at
// `backup/db/manifest.json` inside each restic snapshot, beside `backup/db/db.dump`. Version 1 is
// the alpha's `runs/<id>/manifest.json`, read for `kept admin restore --legacy` (plan Q1).

export const MANIFEST_FORMAT = 'kept-backup';
export const MANIFEST_VERSION = 2;
export const LEGACY_MANIFEST_VERSION = 1;

export type BlobEntry = { key: string; bytes: number; sha256: string };

export type BackupManifest = {
  format: typeof MANIFEST_FORMAT;
  version: typeof MANIFEST_VERSION | typeof LEGACY_MANIFEST_VERSION;
  id: string;
  /** Version 2: the run's kind (`nightly`, `manual`, `pre_upgrade`). */
  kind?: string;
  createdAt: string;
  keptVersion: string;
  /** The server's version, and the major pg_dump had (always the server's, or it refused). */
  postgres: { server: string; dumpMajor: number };
  /** The extensions the database had; the dump leaves them out, restore requires them. */
  extensions: string[];
  database: { file: string; bytes: number; sha256: string };
  /** `schema.table` → rows, for every table kept_owner owns (partitions counted in their parent). */
  tables: Record<string, number>;
  /** Version 2: `schema.table` → its data digest (digests.ts), from the same snapshot. */
  digests?: Record<string, string>;
  /** Version 2: the snapshot holds every blob below under `/blobs/<key>` (local storage, not a
   * database-only run). False: they are in the S3 bucket (D144), or the run was database-only
   * (`blobs` is then empty). */
  filesInSnapshot?: boolean;
  /** KEPT_STORAGE when the backup was made. */
  storage: 'local' | 's3';
  blobs: BlobEntry[];
  /** Keys the rows reference that the file store did not have. */
  missing: string[];
};

/** The tables kept_owner owns, partitions left to their parent, as `schema.table` idents. */
export async function ownedTables(
  client: pg.ClientBase,
  schemas?: readonly string[],
): Promise<{ name: string; ident: string }[]> {
  const { rows } = await client.query<{ name: string; ident: string }>(
    `SELECT n.nspname || '.' || c.relname AS name, format('%I.%I', n.nspname, c.relname) AS ident
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_%'
        AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
      ORDER BY 1`,
    [schemas ?? null],
  );
  return rows;
}

/** Exact row counts, in the caller's transaction (and so its snapshot). */
export async function countRows(
  client: pg.ClientBase,
  tables: readonly { name: string; ident: string }[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.ident}`);
    out[t.name] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

/** Every blob key the rows reference: originals (with the SHA-256 the upload checked) and their
 * derivatives. A key shared by copies (D161) is listed once. */
export async function referencedBlobs(
  client: pg.ClientBase,
): Promise<{ key: string; sha256: string | null }[]> {
  const { rows } = await client.query<{ key: string; sha256: string | null }>(
    `SELECT storage_key AS key, min(sha256) AS sha256 FROM public.files GROUP BY storage_key
     UNION ALL
     SELECT DISTINCT storage_key, NULL FROM public.file_derivatives
     ORDER BY 1`,
  );
  return rows;
}

export async function extensionsOf(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`,
  );
  return rows.map((r) => r.extname);
}

/** SHA-256 and size of a local file. */
export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return { sha256: hash.digest('hex'), bytes: (await stat(file)).size };
}

/** A blob's SHA-256 and size, streamed from the file store (nothing written). */
export async function hashBlob(
  blobs: BlobStore,
  key: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of await blobs.stream(key)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Copies a blob out of the file store to a local file (0600), hashing it on the way. */
export async function blobToFile(
  blobs: BlobStore,
  key: string,
  file: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(await blobs.stream(key), tap, createWriteStream(file, { mode: 0o600 }));
  return { sha256: hash.digest('hex'), bytes };
}

export function parseManifest(raw: Buffer | string): BackupManifest {
  const data = JSON.parse(raw.toString()) as Partial<BackupManifest>;
  if (
    data.format !== MANIFEST_FORMAT ||
    (data.version !== MANIFEST_VERSION && data.version !== LEGACY_MANIFEST_VERSION)
  ) {
    throw new Error('not a Kept backup manifest (format kept-backup, version 1 or 2)');
  }
  if (data.version === MANIFEST_VERSION && (!data.digests || typeof data.digests !== 'object')) {
    throw new Error('a version-2 Kept backup manifest without its data digests');
  }
  return data as BackupManifest;
}
