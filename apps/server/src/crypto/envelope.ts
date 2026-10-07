/**
 * Envelope encryption for secrets at rest (engineering spec §7.3, D182).
 *
 * Each value gets its own random 32-byte data key (DEK). The DEK encrypts the value with
 * AES-256-GCM; the master key (KEPT_SECRET_KEY) encrypts the DEK, also with AES-256-GCM. Both
 * layers carry associated data (AAD) naming the row the value belongs to, `table|row_id|field_key`
 * (the DEK layer prefixes `dek|`), so a ciphertext copied into another row, table or field fails
 * to decrypt instead of quietly revealing its value there.
 *
 * Rotation only re-encrypts the small DEK (`rewrap`); the value's own ciphertext never changes.
 * `kv` records which master key wrapped the DEK, so old key versions stay usable for old backups.
 *
 * The master key is not used as the AES key directly: HKDF-SHA256 derives the key-encryption key
 * from it. That lets the env contract accept keys longer than 32 bytes (it requires >= 32) and
 * keeps this use of the key separate from any other.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type CryptoErrorCode =
  | 'crypto_aad_mismatch'
  | 'crypto_aad_invalid'
  | 'crypto_key_missing'
  | 'crypto_key_invalid'
  | 'crypto_format';

export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code: CryptoErrorCode,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** Master keys by version. The current version seals; every version in the ring can open. */
export type Keyring = Map<number, Buffer>;

export type MasterKey = { key: Buffer; keyVersion: number };

/** Where a ciphertext lives. Bound into the AAD: `table|row_id|field_key`. */
export type Aad = { table: string; rowId: string; fieldKey: string };

/** The stored form. JSON-safe and stable: base64 strings plus two integers. */
export type Sealed = {
  v: 1;
  /** Master key version that wrapped `dek`. */
  kv: number;
  /** The wrapped data key: iv(12) ‖ ciphertext(32) ‖ tag(16), base64. */
  dek: string;
  /** Content IV (12 bytes), base64. */
  iv: string;
  /** Content ciphertext, base64. */
  ct: string;
  /** Content GCM tag (16 bytes), base64. */
  tag: string;
};

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = IV_BYTES + KEY_BYTES + TAG_BYTES;
const KEK_INFO = 'kept/envelope/kek/v1';

/** 32 random bytes as unpadded base64url: the format KEPT_SECRET_KEY accepts. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/** Encrypts `plaintext` (UTF-8 if a string) for the row and field named by `aad`. */
export function seal(master: MasterKey, plaintext: string | Uint8Array, aad: Aad): Sealed {
  const kek = deriveKek(master.key, master.keyVersion);
  const bound = aadString(aad);
  const dek = randomBytes(KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALG, dek, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(bound, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      v: 1,
      kv: master.keyVersion,
      dek: wrapDek(kek, dek, bound).toString('base64'),
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypts a sealed value for the row and field named by `aad`. Throws `crypto_aad_mismatch` when
 * authentication fails: the value belongs to another row or field, was tampered with, or was
 * wrapped by a different key under the same version. GCM cannot tell these apart.
 */
export function open(keyring: Keyring, sealed: Sealed, aad: Aad): Buffer {
  const parts = parse(sealed);
  const bound = aadString(aad);
  const dek = unwrapDek(keyring, parts.kv, parts.dek, bound);
  try {
    const decipher = createDecipheriv(ALG, dek, parts.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(bound, 'utf8'));
    decipher.setAuthTag(parts.tag);
    return authenticated(() => Buffer.concat([decipher.update(parts.ct), decipher.final()]));
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wraps the data key under `next` (key rotation, §7.3). The content IV, ciphertext and tag
 * are unchanged; only `kv` and `dek` move. `aad` is needed because the DEK is bound to its row.
 */
export function rewrap(sealed: Sealed, keyring: Keyring, next: MasterKey, aad: Aad): Sealed {
  const parts = parse(sealed);
  const bound = aadString(aad);
  const kek = deriveKek(next.key, next.keyVersion);
  const dek = unwrapDek(keyring, parts.kv, parts.dek, bound);
  try {
    return { ...sealed, kv: next.keyVersion, dek: wrapDek(kek, dek, bound).toString('base64') };
  } finally {
    dek.fill(0);
  }
}

function deriveKek(master: Buffer, keyVersion: number): Buffer {
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new CryptoError('key version must be a positive integer', 'crypto_key_invalid');
  }
  if (!Buffer.isBuffer(master) || master.length < KEY_BYTES) {
    throw new CryptoError(`master key must be at least ${KEY_BYTES} bytes`, 'crypto_key_invalid');
  }
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), KEK_INFO, KEY_BYTES));
}

function wrapDek(kek: Buffer, dek: Buffer, bound: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, kek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`dek|${bound}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function unwrapDek(keyring: Keyring, kv: number, wrapped: Buffer, bound: string): Buffer {
  const master = keyring.get(kv);
  if (!master) throw new CryptoError(`no master key for version ${kv}`, 'crypto_key_missing');
  const kek = deriveKek(master, kv);
  const iv = wrapped.subarray(0, IV_BYTES);
  const ct = wrapped.subarray(IV_BYTES, IV_BYTES + KEY_BYTES);
  const tag = wrapped.subarray(IV_BYTES + KEY_BYTES);
  const decipher = createDecipheriv(ALG, kek, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(`dek|${bound}`, 'utf8'));
  decipher.setAuthTag(tag);
  return authenticated(() => Buffer.concat([decipher.update(ct), decipher.final()]));
}

/** Runs a GCM final() and maps its authentication failure to crypto_aad_mismatch. */
function authenticated(fn: () => Buffer): Buffer {
  try {
    return fn();
  } catch {
    throw new CryptoError(
      'ciphertext failed authentication: wrong row or field, wrong key, or tampered',
      'crypto_aad_mismatch',
    );
  }
}

function aadString({ table, rowId, fieldKey }: Aad): string {
  for (const part of [table, rowId, fieldKey]) {
    if (typeof part !== 'string' || part === '' || part.includes('|')) {
      throw new CryptoError("AAD parts must be non-empty and contain no '|'", 'crypto_aad_invalid');
    }
  }
  return `${table}|${rowId}|${fieldKey}`;
}

type Parts = { kv: number; dek: Buffer; iv: Buffer; ct: Buffer; tag: Buffer };

function parse(sealed: Sealed): Parts {
  const bad = (what: string) => new CryptoError(`sealed value: ${what}`, 'crypto_format');
  if (typeof sealed !== 'object' || sealed === null) throw bad('not an object');
  if (sealed.v !== 1) throw bad(`unknown format version ${String(sealed.v)}`);
  if (!Number.isInteger(sealed.kv) || sealed.kv < 1) throw bad('kv is not a positive integer');
  const dek = decode(sealed.dek, 'dek', WRAPPED_DEK_BYTES);
  const iv = decode(sealed.iv, 'iv', IV_BYTES);
  const tag = decode(sealed.tag, 'tag', TAG_BYTES);
  const ct = decode(sealed.ct, 'ct');
  return { kv: sealed.kv, dek, iv, ct, tag };
}

/** Strict base64: Buffer.from() skips junk characters silently, so require a canonical round trip. */
function decode(value: unknown, name: string, length?: number): Buffer {
  if (typeof value !== 'string') {
    throw new CryptoError(`sealed value: ${name} is not a string`, 'crypto_format');
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value || (length !== undefined && buf.length !== length)) {
    throw new CryptoError(`sealed value: ${name} is malformed`, 'crypto_format');
  }
  return buf;
}
