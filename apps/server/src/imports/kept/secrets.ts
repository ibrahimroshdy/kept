import { EXPORT_PATHS, type ExportSecretRecord } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../../audit/audited.js';
import type { Sealed } from '../../crypto/envelope.js';
import type { SecretKeys } from '../../crypto/keyring.js';
import type { Pools } from '../../db/pools.js';
import { type Scope, type Tx, withScope } from '../../db/scope.js';
import { AppError, conflict, notFound } from '../../http/errors.js';
import {
  checkSecretsFile,
  decryptSecrets,
  keyForSecretsFile,
  openRunKey,
  PassphraseWrongError,
  SecretsFileError,
  sealRunKey,
} from '../../portability/passphrase.js';
import type { OpenArchive } from '../../portability/zip/read.js';
import { setSecret, subjectOf } from '../../secrets/service.js';
import type { FileStorage } from '../../storage/blob-store.js';
import type { IdMap } from './ids.js';
import { openKeptArchive, readManifest } from './read.js';

// A Kept export's secrets on import (D68; step-7 plan T14, Q7).
//
// POST /api/v1/imports/:id/passphrase {passphrase}: the passphrase is used once, in the request.
// The route reads `secrets.json`'s header from the uploaded archive, derives the key with the
// file's own KDF parameters, and checks it by decrypting the file (a wrong one is 400
// `passphrase_wrong`, at most 10 tries an hour per run, counted whether right or wrong). The key
// is then sealed under this server's keyring onto the run (`import_runs|<id>|secrets_key`) and
// both are dropped. No Idempotency-Key store (its body would be stored), nothing logged.
//
// Without it the import runs and the secrets are left out; the summary says how many. With it,
// the job opens the key, decrypts the values, and writes each through the secrets service
// (setSecret: sealed for its new row, audited `secret.set` with `{changed: true}`), then clears
// the column whatever the outcome.

/** Wrong-or-right passphrase tries per run per hour (plan Q7). */
export const PASSPHRASE_TRIES_PER_HOUR = 10;

export const PassphraseBody = z.strictObject({ passphrase: z.string().min(1).max(1024) });

type RunHead = {
  id: string;
  location_id: string | null;
  source: string;
  status: string;
  archive_bytes: number | null;
  archive_ready_at: Date | null;
};

async function runHead(client: pg.ClientBase, runId: string): Promise<RunHead> {
  const { rows } = await client.query<RunHead>(
    `SELECT id, location_id, source, status, archive_bytes::float8 AS archive_bytes,
            archive_ready_at
       FROM public.import_runs WHERE id = $1`,
    [runId],
  );
  const run = rows[0];
  if (run?.source !== 'kept_zip') throw notFound();
  return run;
}

/** The secrets file of an archive and the export id its AAD names; 409 when it has none. */
async function secretsFileOf(archive: OpenArchive) {
  const manifest = await readManifest(archive);
  if (!manifest.includesSecrets || !archive.has(EXPORT_PATHS.secrets)) {
    throw conflict('This export holds no secrets.');
  }
  let file: ReturnType<typeof checkSecretsFile>;
  try {
    file = checkSecretsFile(await archive.json(EXPORT_PATHS.secrets, z.unknown()));
  } catch (err) {
    if (err instanceof SecretsFileError) {
      throw new AppError('archive_invalid', 400, 'This export’s secrets file can’t be read.', {
        reason: 'truncated',
      });
    }
    throw err;
  }
  return { file, exportId: manifest.exportId };
}

export type UnlockDeps = {
  pools: Pick<Pools, 'app'>;
  files: FileStorage;
  keys: SecretKeys;
};

/**
 * Checks `passphrase` against run `runId`'s export and seals the key onto the run. The run must
 * be the caller's to see, a Kept export uploaded and not yet started. Throws 400
 * `passphrase_wrong` for a wrong one.
 */
export async function unlockSecrets(
  deps: UnlockDeps,
  scope: Scope,
  runId: string,
  passphrase: string,
  requestId: string,
): Promise<void> {
  const head = await withScope(deps.pools.app, scope, (_tx, client) => runHead(client, runId));
  if (!head.archive_ready_at || head.archive_bytes === null) {
    throw conflict('Upload the export first.');
  }
  if (head.status !== 'draft' && head.status !== 'checked') {
    throw conflict(`This import is ${head.status}; its passphrase is given before it starts.`);
  }
  // The archive and scrypt run with no transaction open (a second or so).
  const archive = await openKeptArchive(deps.files.blobs, runId, head.archive_bytes);
  let key: Buffer;
  try {
    const { file, exportId } = await secretsFileOf(archive);
    key = await keyForSecretsFile(passphrase, file);
    try {
      decryptSecrets(key, file, exportId);
    } catch (err) {
      if (err instanceof PassphraseWrongError) {
        throw new AppError('passphrase_wrong', 400, 'That passphrase doesn’t open these secrets.');
      }
      throw err;
    }
  } finally {
    archive.close();
  }
  const sealed = sealRunKey(deps.keys, 'import_runs', runId, key);
  key.fill(0);
  await withScope(deps.pools.app, scope, async (tx, client) => {
    const now = await runHead(client, runId);
    if (now.status !== 'draft' && now.status !== 'checked') {
      throw conflict(`This import is ${now.status}; its passphrase is given before it starts.`);
    }
    await client.query(
      `UPDATE public.import_runs SET secrets_key_ciphertext = $2, key_version = $3 WHERE id = $1`,
      [runId, JSON.stringify(sealed.ciphertext), sealed.keyVersion],
    );
    if (now.location_id) {
      await audited(tx, {
        locationId: now.location_id,
        actor: { type: 'user', id: scope.userId },
        action: 'import.passphrase',
        entity: { type: 'import_run', id: runId },
        after: { unlocked: true },
        requestId,
      });
    }
  });
}

/** Clears a run's sealed key (the job does, whatever the outcome). */
export async function clearRunKey(client: pg.ClientBase, runId: string): Promise<void> {
  await client.query(
    `UPDATE public.import_runs SET secrets_key_ciphertext = NULL, key_version = NULL
      WHERE id = $1 AND secrets_key_ciphertext IS NOT NULL`,
    [runId],
  );
}

const SecretRecord = z.object({
  subject: z.object({ kind: z.enum(['thing', 'place']), id: z.string() }),
  fieldKey: z.string().min(1).max(64),
  typeFieldId: z.string().nullable().optional(),
  value: z.string().min(1).max(4096),
  updatedAt: z.string().optional(),
});

/** The run's sealed key, or null without one. */
export async function sealedKeyOf(client: pg.ClientBase, runId: string): Promise<Sealed | null> {
  const { rows } = await client.query<{ c: Sealed | null }>(
    'SELECT secrets_key_ciphertext AS c FROM public.import_runs WHERE id = $1',
    [runId],
  );
  return rows[0]?.c ?? null;
}

/**
 * The export's secret values, decrypted with the run's sealed key: null when the run has no key
 * (no passphrase given) or the archive no secrets.
 */
export async function readSecrets(
  archive: OpenArchive,
  keys: SecretKeys,
  runId: string,
  sealed: Sealed | null,
): Promise<ExportSecretRecord[] | null> {
  if (!sealed || !archive.has(EXPORT_PATHS.secrets)) return null;
  const { file, exportId } = await secretsFileOf(archive);
  const { key } = await openRunKey(keys, 'import_runs', runId, sealed);
  let plain: Buffer;
  try {
    plain = decryptSecrets(key, file, exportId);
  } finally {
    key.fill(0);
  }
  const out: ExportSecretRecord[] = [];
  for (const line of plain.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = SecretRecord.safeParse(json);
    if (parsed.success) {
      out.push({
        subject: { kind: parsed.data.subject.kind, id: parsed.data.subject.id.toLowerCase() },
        fieldKey: parsed.data.fieldKey,
        typeFieldId: parsed.data.typeFieldId ?? null,
        value: parsed.data.value,
        updatedAt: parsed.data.updatedAt ?? '',
      });
    }
  }
  plain.fill(0);
  return out;
}

export type SecretsOutcome = { written: number; skipped: number };

/**
 * Writes the decrypted values onto the imported things and places, each through the secrets
 * service in a savepoint: a value whose subject or field isn't here (a type that resolved
 * differently, the module off) is skipped and counted, never fatal.
 */
export async function writeSecrets(
  c: { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string },
  keys: SecretKeys,
  ids: IdMap,
  records: readonly ExportSecretRecord[],
): Promise<SecretsOutcome> {
  let written = 0;
  let skipped = 0;
  for (const r of records) {
    await c.client.query('SAVEPOINT kept_secret');
    try {
      const subject = await subjectOf(c.client, r.subject.kind, ids.of(r.subject.id), r.fieldKey);
      await setSecret(c, keys, subject, r.value);
      await c.client.query('RELEASE SAVEPOINT kept_secret');
      written += 1;
    } catch {
      await c.client.query('ROLLBACK TO SAVEPOINT kept_secret');
      skipped += 1;
    }
  }
  return { written, skipped };
}
