/**
 * The app lock's keys (step-8 plan T23; D181, Q22; spike L1, docs/spikes/2026-10-06-step8-app-lock.md).
 * WebCrypto only; nothing here touches IndexedDB, so the lock screen's chunk can load it alone.
 *
 * - **One random data key per device** (AES-GCM-256) encrypts what "keep this location available
 *   offline" stores: each thing's money and each document's bytes (offline/extras.ts).
 * - **The PIN wraps it:** PBKDF2-SHA-256(PIN, a random salt, `APP_LOCK.pbkdf2Iterations`) → an
 *   AES-KW key → `wrapKey`. A wrong PIN fails `unwrapKey` (AES-KW's integrity check), so no PIN
 *   hash is stored (L1 finding 5). The salt and the count are stored beside the wrapped key, so
 *   the count can change for new wraps without breaking a device already set up (finding 3).
 * - **The passkey** (Face ID, fingerprint) is a WebAuthn credential with user verification
 *   required. Where its authenticator gives a PRF secret, HKDF-SHA-256 of it wraps the same data
 *   key, so the passkey opens the extras too; without PRF it unlocks the app only, and the extras
 *   ask for the PIN (Q22). PRF is detected from `create()`'s `prf.enabled`, never from
 *   `getClientCapabilities()` (finding 1); a secret that doesn't come back at creation is asked
 *   for with one `get()` (finding 2). The assertion is checked on this device only: the lock
 *   keeps out someone holding the phone, it isn't a sign-in (the session already exists).
 * - **What the PIN doesn't stop** (L1): someone who copies the browser's storage can try PINs
 *   offline at PBKDF2's pace; the PRF path has no such gap. The settings page says so.
 */
import { APP_LOCK } from '@kept/shared';

/** Stored per device in the person's database (offline/db.ts `lock`). Bytes as ArrayBuffers. */
export type LockRecord = {
  v: 1;
  /** The PIN's length: the lock screen tries it once that many digits are in. */
  pinLength: number;
  pin: { salt: ArrayBuffer; iterations: number; wrapped: ArrayBuffer };
  passkey: {
    credentialId: ArrayBuffer;
    prfSalt: ArrayBuffer;
    /** The data key wrapped under the PRF secret; null where the authenticator has no PRF. */
    wrapped: ArrayBuffer | null;
  } | null;
  /** Wrong PINs in a row; APP_LOCK.maxPinTries wipes this device's copy (D181, D210). */
  failedTries: number;
  createdAt: number;
};

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const HKDF_INFO = enc.encode('kept app lock v1');
const AAD_PREFIX = 'kept extras v1:';

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));
const buffer = (bytes: Uint8Array<ArrayBuffer>): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Only digits, APP_LOCK.pinMin to pinMax of them. */
export const validPin = (pin: string) =>
  /^\d+$/.test(pin) && pin.length >= APP_LOCK.pinMin && pin.length <= APP_LOCK.pinMax;

async function pinKey(pin: string, salt: ArrayBuffer, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function prfKey(secret: BufferSource): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    base,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

const wrap = (key: CryptoKey, kek: CryptoKey) => subtle().wrapKey('raw', key, kek, 'AES-KW');
/** The data key is extractable so a passkey or a new PIN can wrap it later; it lives in memory
 * only while the app is unlocked. */
const unwrap = (wrapped: ArrayBuffer, kek: CryptoKey) =>
  subtle().unwrapKey('raw', wrapped, kek, 'AES-KW', { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);

async function pinWrap(
  dataKey: CryptoKey,
  pin: string,
  iterations: number,
): Promise<LockRecord['pin']> {
  const salt = buffer(randomBytes(16));
  return { salt, iterations, wrapped: await wrap(dataKey, await pinKey(pin, salt, iterations)) };
}

/** A new lock: a fresh data key wrapped by `pin`. `iterations` is for tests only. */
export async function createLock(
  pin: string,
  iterations: number = APP_LOCK.pbkdf2Iterations,
): Promise<{ record: LockRecord; dataKey: CryptoKey }> {
  if (!validPin(pin)) throw new Error('invalid PIN');
  const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const record: LockRecord = {
    v: 1,
    pinLength: pin.length,
    pin: await pinWrap(dataKey, pin, iterations),
    passkey: null,
    failedTries: 0,
    createdAt: Date.now(),
  };
  return { record, dataKey };
}

/** The data key, or null for a wrong PIN. */
export async function unlockWithPin(record: LockRecord, pin: string): Promise<CryptoKey | null> {
  if (!/^\d+$/.test(pin)) return null;
  try {
    const kek = await pinKey(pin, record.pin.salt, record.pin.iterations);
    return await unwrap(record.pin.wrapped, kek);
  } catch {
    return null;
  }
}

/** The same data key under a new PIN (so what is kept stays readable). */
export async function changePin(
  record: LockRecord,
  dataKey: CryptoKey,
  pin: string,
  iterations: number = APP_LOCK.pbkdf2Iterations,
): Promise<LockRecord> {
  if (!validPin(pin)) throw new Error('invalid PIN');
  return {
    ...record,
    pinLength: pin.length,
    pin: await pinWrap(dataKey, pin, iterations),
    failedTries: 0,
  };
}

// ----- the passkey ------------------------------------------------------------------------------

type PrfOutputs = { enabled?: boolean; results?: { first?: BufferSource } };
type WithPrf = { prf?: PrfOutputs };

/** "Use Face ID or fingerprint" is offered only where the platform can verify the person (L1
 * finding 4). */
export async function passkeyAvailable(): Promise<boolean> {
  try {
    const pkc = globalThis.PublicKeyCredential;
    if (!pkc?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function prfInput(salt: ArrayBuffer) {
  return { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs;
}

async function assert(
  credentialId: ArrayBuffer,
  prfSalt: ArrayBuffer,
): Promise<PrfOutputs | undefined> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: prfInput(prfSalt),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no credential');
  return (credential.getClientExtensionResults() as WithPrf).prf;
}

/**
 * Adds a passkey with user verification to the lock, wrapping `dataKey` under its PRF secret
 * where the authenticator has one. Throws when the person cancels or verification fails.
 */
export async function enrolPasskey(
  record: LockRecord,
  dataKey: CryptoKey,
  name: string,
): Promise<LockRecord> {
  const prfSalt = buffer(randomBytes(32));
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Kept' },
      user: { id: randomBytes(16), name, displayName: name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60_000,
      extensions: prfInput(prfSalt),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no credential');
  const credentialId = credential.rawId;
  const created = (credential.getClientExtensionResults() as WithPrf).prf;
  let secret = created?.results?.first;
  if (created?.enabled && !secret) secret = (await assert(credentialId, prfSalt))?.results?.first;
  const wrapped = secret ? await wrap(dataKey, await prfKey(secret)) : null;
  return { ...record, passkey: { credentialId, prfSalt, wrapped } };
}

/**
 * Unlocks with the passkey: the data key where PRF wraps it, null where it unlocks the app only
 * (the extras then ask for the PIN). Throws when the person cancels or verification fails.
 */
export async function unlockWithPasskey(record: LockRecord): Promise<CryptoKey | null> {
  const passkey = record.passkey;
  if (!passkey) throw new Error('no passkey');
  const prf = await assert(passkey.credentialId, passkey.prfSalt);
  const secret = prf?.results?.first;
  if (!passkey.wrapped || !secret) return null;
  try {
    return await unwrap(passkey.wrapped, await prfKey(secret));
  } catch {
    return null;
  }
}

// ----- sealing what is kept --------------------------------------------------------------------

/** AES-GCM with a fresh IV; the row's id is the additional data, so a row can't be swapped. */
export type Sealed = { iv: ArrayBuffer; ct: ArrayBuffer };

export async function seal(key: CryptoKey, id: string, plain: BufferSource): Promise<Sealed> {
  const iv = buffer(randomBytes(12));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(AAD_PREFIX + id) },
    key,
    plain,
  );
  return { iv, ct };
}

export async function unseal(key: CryptoKey, id: string, sealed: Sealed): Promise<ArrayBuffer> {
  return subtle().decrypt(
    { name: 'AES-GCM', iv: sealed.iv, additionalData: enc.encode(AAD_PREFIX + id) },
    key,
    sealed.ct,
  );
}

export const sealJson = (key: CryptoKey, id: string, value: unknown) =>
  seal(key, id, enc.encode(JSON.stringify(value)));

export async function unsealJson<T>(key: CryptoKey, id: string, sealed: Sealed): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await unseal(key, id, sealed))) as T;
}

/** Lower-case hex SHA-256 of `bytes`: a downloaded document is checked against the server's. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
