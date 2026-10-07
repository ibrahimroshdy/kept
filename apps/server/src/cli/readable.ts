import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { CliError } from '../admin/cli.js';
import { type BackupCliEnv, loadBackupCliEnv } from '../backup/config.js';
import { type ReadableTreeDeps, writeReadableTree } from '../backup/readable/run.js';
import type { FileStorage } from '../storage/blob-store.js';
import { createUrlSigner } from '../storage/signed-url.js';

// `kept admin readable --out <dir> [--location <id>]` (step-8 plan T6, D159): the readable copy
// every snapshot holds, written on demand into a directory, for an operator who wants to look
// before a backup exists. The same code as the snapshot's step 6 (backup/readable/run.ts): each
// location as its owner sees it, on the kept_app login (KEPT_DATABASE_URL) in the owner's scope,
// listed as kept_owner (KEPT_OWNER_DATABASE_URL). The files are hard links with local storage, so
// `--out` should be on the data's disk; elsewhere they are copied.

type Source = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a readable copy needs beyond `kept admin`'s backup environment, or null without the
 * kept_app login. The caller ends `pool`. */
export function readableDepsOf(
  env: BackupCliEnv,
  source: Source,
  log: ReadableTreeDeps['log'],
): { deps: ReadableTreeDeps; pool: pg.Pool } | null {
  const appUrl = source.KEPT_DATABASE_URL;
  if (!appUrl) return null;
  const pool = new pg.Pool({ connectionString: appUrl, max: 2, application_name: 'kept-cli' });
  pool.on('error', () => {});
  // These commands never sign a URL: the signer is a throwaway one.
  const files: FileStorage = {
    blobs: env.blobs,
    signer: createUrlSigner(randomBytes(32)),
    maxFileBytes: 0,
    imageConcurrency: 1,
    tmpDir: env.tmpDir,
  };
  return {
    pool,
    deps: {
      ownerUrl: env.ownerUrl,
      pools: { app: pool },
      files,
      storage: env.storage,
      publicUrl: source.KEPT_PUBLIC_URL ?? 'http://localhost',
      log,
    },
  };
}

export async function readableCommand(
  source: Source,
  opts: { out: string; location?: string; pdf?: boolean },
  print: (line: string) => void,
): Promise<number> {
  if (opts.location !== undefined && !UUID.test(opts.location)) {
    throw new CliError('--location takes a location id');
  }
  const env = await loadBackupCliEnv(source);
  const made = readableDepsOf(env, source, {
    info: () => {},
    error: (obj, msg) => print(`${msg} ${JSON.stringify(obj)}`),
  });
  if (!made) throw new CliError('KEPT_DATABASE_URL (the kept_app login) is not set');
  const out = path.resolve(opts.out);
  try {
    const result = await writeReadableTree(
      { ...made.deps, ...(opts.pdf === false ? { pdf: false } : {}) },
      out,
      opts.location ? { locationId: opts.location.toLowerCase() } : {},
    );
    if (opts.location && result.locations.length === 0) {
      throw new CliError('no such location');
    }
    for (const l of result.locations) {
      const what =
        l.state === 'failed'
          ? `not written (${l.error})`
          : l.state === 'deleted'
            ? 'being deleted: not written'
            : `${l.things ?? 0} things${l.state === 'unchanged' ? ', unchanged' : ''}`;
      print(`${l.locationId}  ${what}`);
    }
    print(`Written to ${out}${opts.location ? '' : ' (open index.html)'}.`);
    return result.failed.length > 0 ? 1 : 0;
  } finally {
    await made.pool.end().catch(() => {});
  }
}
