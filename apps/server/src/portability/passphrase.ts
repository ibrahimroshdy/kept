import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import {
  EXPORT_SECRETS_FORMAT,
  type ExportSecretsFile,
  exportSecretsAad,
  kdfParamsAccepted,
  PASSPHRASE_KDF,
} from '@kept/shared';
import { type Aad, open, type Sealed, seal } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';

// Passphrase-protected secrets in a Kept export (D68; plan T12, T14, Q7; spike P1,
// docs/spikes/2026-09-30-step7-passphrase.md).
//
// - The route that takes a passphrase derives the key with scrypt during the request, seals it
//   under the keyring onto its run (`export_runs` or `import_runs`, AAD
//   `<table>|<runId>|secrets_key`, secrets/rotate.ts CIPHERTEXTS), and drops the passphrase and
//   the key. pg-boss's `data`, a log line and the Idempotency-Key store never see either.
// - The job opens the sealed key, and the run's finishing door clears the column.
// - `secrets.json` is AES-256-GCM over the NDJSON of the values, with the AAD
//   `kept-export|<exportId>|secrets`: a secrets file moved into another export fails to open.
//   The KDF's parameters travel in the file, so a changed default never breaks an old export;
//   an importer accepts only what kdfParamsAccepted() allows.
//
// Nothing here logs.

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type KdfParams = { name: 'scrypt'; N: number; r: number; p: number };

/** A wrong passphrase, or a file that isn't this export's: GCM can't tell them apart. */
export class PassphraseWrongError extends Error {
  constructor() {
    super('passphrase_wrong');
    this.name = 'PassphraseWrongError';
  }
}

/** A secrets file Kept doesn't read (format, version, cipher or KDF bounds). */
export class SecretsFileError extends Error {
  constructor(readonly reason: string) {
    super(`secrets file: ${reason}`);
    this.name = 'SecretsFileError';
  }
}

export const newSalt = (): Buffer => randomBytes(PASSPHRASE_KDF.saltBytes);

/** The key scrypt derives from `passphrase` and `salt` (`maxmem` 256 × N × r, spike P1). */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  kdf: KdfParams = PASSPHRASE_KDF as KdfParams,
): Promise<Buffer> {
  if (!kdfParamsAccepted(kdf)) return Promise.reject(new SecretsFileError('kdf'));
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFC'),
      salt,
      PASSPHRASE_KDF.keyBytes,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export type RunKeyTable = 'export_runs' | 'import_runs';

export const runKeyAad = (table: RunKeyTable, runId: string): Aad => ({
  table,
  rowId: runId,
  fieldKey: 'secrets_key',
});

/** The salt and parameters travel with the sealed key, so the job writes them into the file. */
type RunKeyPayload = { k: string; s?: string; N?: number; r?: number; p?: number };

/**
 * Seals a derived key (and, for an export, the salt it was derived with) onto its run. Returns
 * the two columns to write: `secrets_key_ciphertext` and `key_version`.
 */
export function sealRunKey(
  keys: SecretKeys,
  table: RunKeyTable,
  runId: string,
  key: Buffer,
  derivation?: { salt: Buffer; kdf: KdfParams },
): { ciphertext: Sealed; keyVersion: number } {
  const ring = keys.get();
  const payload: RunKeyPayload = { k: key.toString('base64url') };
  if (derivation) {
    payload.s = derivation.salt.toString('base64url');
    payload.N = derivation.kdf.N;
    payload.r = derivation.kdf.r;
    payload.p = derivation.kdf.p;
  }
  const ciphertext = seal(ring.current, JSON.stringify(payload), runKeyAad(table, runId));
  return { ciphertext, keyVersion: ring.current.keyVersion };
}

export type OpenedRunKey = { key: Buffer; salt: Buffer | null; kdf: KdfParams | null };

/** Opens a run's sealed key (refreshing the keyring once when a rotation named a newer version). */
export async function openRunKey(
  keys: SecretKeys,
  table: RunKeyTable,
  runId: string,
  sealed: Sealed,
): Promise<OpenedRunKey> {
  const read = () => open(keys.get().keyring, sealed, runKeyAad(table, runId)).toString('utf8');
  let text: string;
  try {
    text = read();
  } catch (err) {
    if (!(await keys.refresh())) throw err;
    text = read();
  }
  const payload = JSON.parse(text) as RunKeyPayload;
  return {
    key: Buffer.from(payload.k, 'base64url'),
    salt: payload.s ? Buffer.from(payload.s, 'base64url') : null,
    kdf:
      payload.N && payload.r && payload.p
        ? { name: 'scrypt', N: payload.N, r: payload.r, p: payload.p }
        : null,
  };
}

/** `secrets.json` for an export: `plaintext` (the NDJSON of ExportSecretRecord) under `key`. */
export function encryptSecrets(
  key: Buffer,
  derivation: { salt: Buffer; kdf: KdfParams },
  exportId: string,
  plaintext: Buffer,
): ExportSecretsFile {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(exportSecretsAad(exportId), 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: EXPORT_SECRETS_FORMAT,
    version: 1,
    kdf: {
      name: 'scrypt',
      N: derivation.kdf.N,
      r: derivation.kdf.r,
      p: derivation.kdf.p,
      salt: derivation.salt.toString('base64url'),
    },
    cipher: CIPHER,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

/** Checks a parsed `secrets.json`'s header; throws SecretsFileError for one Kept doesn't read. */
export function checkSecretsFile(file: unknown): ExportSecretsFile {
  const f = file as Partial<ExportSecretsFile> | null;
  if (!f || typeof f !== 'object' || f.format !== EXPORT_SECRETS_FORMAT) {
    throw new SecretsFileError('format');
  }
  if (f.version !== 1) throw new SecretsFileError('version');
  if (f.cipher !== CIPHER) throw new SecretsFileError('cipher');
  const kdf = f.kdf;
  if (
    !kdf ||
    typeof kdf.salt !== 'string' ||
    !kdfParamsAccepted({ name: kdf.name ?? '', N: kdf.N ?? 0, r: kdf.r ?? 0, p: kdf.p ?? 0 })
  ) {
    throw new SecretsFileError('kdf');
  }
  for (const k of ['iv', 'tag', 'data'] as const) {
    if (typeof f[k] !== 'string') throw new SecretsFileError(k);
  }
  return f as ExportSecretsFile;
}

/** The key a passphrase gives for this secrets file (its own salt and parameters). */
export function keyForSecretsFile(passphrase: string, file: ExportSecretsFile): Promise<Buffer> {
  const { name, N, r, p, salt } = file.kdf;
  return deriveKey(passphrase, Buffer.from(salt, 'base64url'), { name, N, r, p });
}

/** Decrypts `secrets.json` with `key`; PassphraseWrongError when the tag doesn't verify. */
export function decryptSecrets(key: Buffer, file: ExportSecretsFile, exportId: string): Buffer {
  const iv = Buffer.from(file.iv, 'base64url');
  const tag = Buffer.from(file.tag, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || key.length !== 32) {
    throw new PassphraseWrongError();
  }
  const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(exportSecretsAad(exportId), 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64url')), decipher.final()]);
  } catch {
    throw new PassphraseWrongError();
  }
}
