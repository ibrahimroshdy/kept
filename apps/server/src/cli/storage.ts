import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { CliError } from '../admin/cli.js';
import { EnvError, envSchema } from '../config/env.js';
import type { BlobStore } from '../storage/blob-store.js';
import { blobsToCopy, type CopyEntry, copyBlobs, verifyBlobs } from '../storage/copy.js';
import { LocalBlobStore } from '../storage/local.js';
import { createUrlSigner } from '../storage/signed-url.js';

// `kept admin storage copy --to s3|local [--dry-run]` and `kept admin storage verify --store
// s3|local` (D186; step-8 plan T13; storage/copy.ts). The source of a copy is the store
// KEPT_STORAGE names now; the destination is the other one, from its own variables
// (KEPT_DATA_DIR for local, KEPT_S3_* for S3). The switch itself is the operator's:
//   1. `kept admin storage copy --to s3` while Kept runs;
//   2. stop Kept, run it again (only what arrived meanwhile is copied);
//   3. set KEPT_STORAGE=s3, start Kept;
//   4. `kept admin storage verify --store s3`.
// The old store is left as it was, for the operator to delete when satisfied.
//
// Logins: the owner login only (KEPT_OWNER_DATABASE_URL), to read which blobs the rows
// reference across every location. No keys: nothing here opens a sealed value or signs a URL.

type Source = Record<string, string | undefined>;
export type StoreKind = 'local' | 's3';

const storageSchema = envSchema
  .pick({
    KEPT_DATA_DIR: true,
    KEPT_STORAGE: true,
    KEPT_S3_ENDPOINT: true,
    KEPT_S3_REGION: true,
    KEPT_S3_BUCKET: true,
    KEPT_S3_ACCESS_KEY_ID: true,
    KEPT_S3_SECRET_ACCESS_KEY: true,
    KEPT_S3_FORCE_PATH_STYLE: true,
  })
  .extend({ KEPT_OWNER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });
type StorageEnv = z.infer<typeof storageSchema>;

export function loadStorageCliEnv(source: Source): StorageEnv {
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const parsed = storageSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new EnvError(`invalid environment for \`kept admin storage\`: ${names}`, 'invalid_env');
  }
  return parsed.data;
}

export function storeKindOf(raw: string, flag: string): StoreKind {
  if (raw !== 'local' && raw !== 's3') throw new CliError(`${flag} takes \`local\` or \`s3\``);
  return raw;
}

/** One of the two stores, from its variables. As a copy's destination, an S3 bucket is created
 * when missing, as the server does at boot. */
export async function storeOf(
  kind: StoreKind,
  env: StorageEnv,
  opts: { create?: boolean } = {},
): Promise<BlobStore> {
  if (kind === 'local') {
    return new LocalBlobStore({
      dataDir: env.KEPT_DATA_DIR,
      signer: createUrlSigner(randomBytes(32)),
    });
  }
  const { KEPT_S3_BUCKET: bucket, KEPT_S3_ACCESS_KEY_ID: id, KEPT_S3_SECRET_ACCESS_KEY: key } = env;
  if (!bucket || !id || !key) {
    throw new EnvError(
      'the S3 store needs KEPT_S3_BUCKET, KEPT_S3_ACCESS_KEY_ID and KEPT_S3_SECRET_ACCESS_KEY',
      'invalid_env',
    );
  }
  const { S3BlobStore } = await import('../storage/s3.js');
  const store = new S3BlobStore({
    bucket,
    region: env.KEPT_S3_REGION,
    endpoint: env.KEPT_S3_ENDPOINT,
    forcePathStyle: env.KEPT_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: id, secretAccessKey: key },
  });
  if (opts.create) await store.ensureBucket();
  return store;
}

function release(store: BlobStore) {
  if ('destroy' in store && typeof store.destroy === 'function') {
    (store as { destroy: () => void }).destroy();
  }
}

async function referenced(ownerUrl: string): Promise<CopyEntry[]> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'kept-admin' });
  client.on('error', () => {});
  await client.connect();
  try {
    // One snapshot for the whole list.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const entries = await blobsToCopy(client);
    await client.query('COMMIT');
    return entries;
  } finally {
    await client.end();
  }
}

const MIB = 1024 * 1024;
const progress = (print: (line: string) => void) => {
  let shown = 0;
  return (done: number, total: number) => {
    const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
    if (done === total || pct >= shown + 10) {
      shown = pct;
      print(`  ${done} of ${total}`);
    }
  };
};

export async function storageCopyCommand(
  source: Source,
  opts: { to: string; dryRun?: boolean },
  print: (line: string) => void,
): Promise<number> {
  const to = storeKindOf(opts.to, '--to');
  const env = loadStorageCliEnv(source);
  const fromKind: StoreKind = env.KEPT_STORAGE;
  if (fromKind === to) {
    throw new CliError(
      `KEPT_STORAGE is already ${to}: the copy reads from the store Kept uses now, so run it before switching KEPT_STORAGE`,
    );
  }
  const entries = await referenced(env.KEPT_OWNER_DATABASE_URL);
  const from = await storeOf(fromKind, env);
  const dest = await storeOf(to, env, { create: true });
  try {
    print(
      `${opts.dryRun ? 'Checking' : 'Copying'} ${entries.length} files from ${fromKind} to ${to}…`,
    );
    const report = await copyBlobs({
      from,
      to: dest,
      entries,
      tmpDir: path.join(env.KEPT_DATA_DIR, 'tmp'),
      ...(opts.dryRun ? { dryRun: true } : {}),
      onProgress: progress(print),
    });
    print(
      opts.dryRun
        ? `${report.copied} to copy (${report.replaced} of them over different bytes), ${report.present} already there.`
        : `${report.copied} copied (${(report.bytesCopied / MIB).toFixed(1)} MiB, ${report.replaced} over different bytes), ${report.present} already there.`,
    );
    for (const p of report.problems) print(`  ${p.reason}: ${p.key}`);
    if (report.problems.length > 0) {
      print(`${report.problems.length} files could not be copied; nothing was changed for them.`);
      return 1;
    }
    if (!opts.dryRun) {
      print(
        `Every referenced file is in ${to}. Stop Kept, run this again, set KEPT_STORAGE=${to}, start Kept, then run \`kept admin storage verify --store ${to}\`. The ${fromKind} store was left as it was.`,
      );
    }
    return 0;
  } finally {
    release(from);
    release(dest);
  }
}

export async function storageVerifyCommand(
  source: Source,
  opts: { store: string },
  print: (line: string) => void,
): Promise<number> {
  const kind = storeKindOf(opts.store, '--store');
  const env = loadStorageCliEnv(source);
  const entries = await referenced(env.KEPT_OWNER_DATABASE_URL);
  const store = await storeOf(kind, env);
  try {
    print(`Verifying ${entries.length} files in ${kind}…`);
    const report = await verifyBlobs({ store, entries, onProgress: progress(print) });
    for (const p of report.problems) print(`  ${p.reason}: ${p.key}`);
    print(`${report.ok} of ${report.total} files match what the database records.`);
    return report.problems.length > 0 ? 1 : 0;
  } finally {
    release(store);
  }
}
