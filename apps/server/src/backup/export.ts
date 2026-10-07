import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KEPT_VERSION } from '@kept/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { audited } from '../audit/audited.js';
import * as schema from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import type { BlobStore } from '../storage/blob-store.js';
import { type BlobEntry, blobToFile, ownedTables, referencedBlobs } from './manifest.js';
import { assertBackupName } from './target.js';

// `kept admin export --out <dir>` (T31c, D207): the raw escape hatch until step 7's readable
// export. As kept_owner, in one REPEATABLE READ snapshot:
//   tables/<schema>.<table>.ndjson   every row of every table kept_owner owns in the schemas
//                                    below, one JSON object per line, exactly as stored
//   files/<blob key>                 every file the rows reference, SHA-256 checked
//   manifest.json                    row counts, files with sizes and checksums
// Secret values stay sealed: a row holds the ciphertext it holds in the database, and only the
// keys in the recovery kit open it. The directory is 0700 and every file 0600.
//
// Left out: pg-boss's queue (not data), and the auth tables that hold live credentials or
// throttling state (sessions, their second-factor marks, one-time tokens, rate limits, sign-in
// failures), which are worthless off this server and dangerous on it.

export const EXPORT_SCHEMAS = ['public', 'auth', 'kept_meta'] as const;
export const EXPORT_SKIPPED = [
  'auth.session',
  'auth.session_mfa',
  'auth.verification',
  'auth.rate_limit',
  'auth.sign_in_failures',
] as const;

const BATCH = 1000;

export type ExportDeps = {
  ownerUrl: string;
  outDir: string;
  blobs: BlobStore;
  print?: (line: string) => void;
};

export type ExportReport = {
  outDir: string;
  tables: Record<string, number>;
  files: BlobEntry[];
  missing: string[];
};

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

async function emptyOrAbsent(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length > 0) {
      throw new ExportError(`${dir} is not empty; export into a new or empty directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function writeLines(
  file: string,
  fill: (write: (line: string) => Promise<void>) => Promise<void>,
) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const out = createWriteStream(tmp, { mode: 0o600 });
  const write = async (line: string) => {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  };
  try {
    await fill(write);
    out.end();
    await once(out, 'close');
    await rename(tmp, file);
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function runExport(deps: ExportDeps): Promise<ExportReport> {
  const print = deps.print ?? (() => {});
  const outDir = path.resolve(deps.outDir);
  await emptyOrAbsent(outDir);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);
  await mkdir(path.join(outDir, 'tables'), { mode: 0o700 });
  await mkdir(path.join(outDir, 'files'), { mode: 0o700 });

  const client = new pg.Client({
    connectionString: deps.ownerUrl,
    application_name: 'kept-export',
  });
  client.on('error', () => {});
  await client.connect();
  const tables: Record<string, number> = {};
  const files: BlobEntry[] = [];
  const missing: string[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const skipped = new Set<string>(EXPORT_SKIPPED);
    for (const t of await ownedTables(client, EXPORT_SCHEMAS)) {
      if (skipped.has(t.name)) continue;
      let n = 0;
      await client.query(
        `DECLARE kept_export NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS row FROM ${t.ident} t`,
      );
      await writeLines(path.join(outDir, 'tables', `${t.name}.ndjson`), async (write) => {
        for (;;) {
          const { rows } = await client.query<{ row: unknown }>(`FETCH ${BATCH} FROM kept_export`);
          for (const r of rows) await write(JSON.stringify(r.row));
          n += rows.length;
          if (rows.length < BATCH) break;
        }
      });
      await client.query('CLOSE kept_export');
      tables[t.name] = n;
    }
    print(
      `Tables: ${Object.keys(tables).length}, rows: ${Object.values(tables).reduce((a, b) => a + b, 0)}.`,
    );

    for (const { key, sha256 } of await referencedBlobs(client)) {
      const dest = path.join(outDir, 'files', assertBackupName(key));
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const tmp = `${dest}.${randomUUID()}.tmp`;
      try {
        const got = await blobToFile(deps.blobs, key, tmp);
        if (sha256 && got.sha256 !== sha256) {
          throw new ExportError(`the file store's copy of ${key} does not match its checksum`);
        }
        await rename(tmp, dest);
        files.push({ key, bytes: got.bytes, sha256: got.sha256 });
      } catch (err) {
        await rm(tmp, { force: true });
        if ((err as Error).name === 'BlobNotFoundError') {
          missing.push(key);
          continue;
        }
        throw err;
      }
    }
    await client.query('COMMIT');
    print(
      `Files: ${files.length}${missing.length > 0 ? `, ${missing.length} missing from the file store` : ''}.`,
    );

    const manifest = {
      format: 'kept-raw-export',
      version: 1,
      createdAt: new Date().toISOString(),
      keptVersion: KEPT_VERSION,
      note: 'Raw rows as stored. Secret values are sealed; the recovery kit (KEPT_SECRET_KEY) opens them.',
      tables,
      skipped: EXPORT_SKIPPED,
      files,
      missing,
    };
    await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    await client.query('BEGIN');
    await audited(drizzle(client, { schema }) as unknown as Tx, {
      locationId: null,
      ownerAccountId: null,
      actor: { type: 'system', id: null },
      action: 'instance.export',
      entity: { type: 'instance', id: null },
      before: null,
      after: {
        tables: Object.keys(tables).length,
        rows: Object.values(tables).reduce((a, b) => a + b, 0),
        files: files.length,
      },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return { outDir, tables, files, missing };
}
