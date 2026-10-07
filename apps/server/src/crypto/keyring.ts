import { randomUUID } from 'node:crypto';
import { open as openFile, rename, unlink } from 'node:fs/promises';
import {
  decodeKey,
  type KeyMaterial,
  parseKeyVersion,
  parseRetiredKeys,
  readSecretKeyring,
  type SecretKeyring,
  type SecretsFile,
} from '../config/env.js';
import { generateKey, type Keyring, type MasterKey } from './envelope.js';

// The keyring (engineering spec §7.3, D182; plan Q19). The current master key seals; every key
// in the ring (the current one and the retired ones) opens what it sealed. Rotation
// (`kept admin rotate-key`, secrets/rotate.ts) makes a new current key, keeps the old one as
// retired, and re-wraps every stored data key under the new one.
//
// Where the keys live:
// - operator-set: KEPT_SECRET_KEY with KEPT_SECRET_KEY_VERSION (default 1) and
//   KEPT_SECRET_KEYS_RETIRED (`version:key,…`);
// - generated (D193): the config volume's secrets.json, under the same four names. A file
//   written before rotation existed has no version, which reads as 1.
//
// A running server holds the keyring it booted with. A rotation run beside it rewrites
// secrets.json and re-wraps rows to a version the server doesn't hold yet; SecretKeys.refresh()
// re-reads the file the first time a value names a version the ring lacks, so reveals keep
// working without a restart. Values the server seals meanwhile use its old current key, which
// the new ring holds as retired; `rotate-key --resume` re-wraps them later.

export type LoadedKeyring = Readonly<{ current: MasterKey; keyring: Keyring }>;

/** The ring of a SecretKeyring: the current key and every retired one, by version. */
export function keyringOf(k: Pick<SecretKeyring, 'version' | 'key' | 'retired'>): LoadedKeyring {
  const keyring: Keyring = new Map(k.retired);
  keyring.set(k.version, k.key);
  return Object.freeze({ current: { key: k.key, keyVersion: k.version }, keyring });
}

/** The keyring the environment resolved (loadEnv()). */
export function loadKeyring(env: { secretKeyring: SecretKeyring }): LoadedKeyring {
  return keyringOf(env.secretKeyring);
}

/** What a route needs: the keys, and a way to pick up a rotation made while it runs. */
export type SecretKeys = {
  get(): LoadedKeyring;
  /** Re-reads the keys' file when they came from one; true when the ring changed. */
  refresh(): Promise<boolean>;
};

/** Keys from the environment (loadEnv()), refreshed from secrets.json when that is the source. */
export function secretKeysOf(env: { secretKeyring: SecretKeyring }): SecretKeys {
  let ring = env.secretKeyring;
  let loaded = keyringOf(ring);
  return {
    get: () => loaded,
    async refresh() {
      if (ring.source === 'environment') return false;
      const next = await readSecretKeyring(ring.source);
      if (!next || (next.version === ring.version && next.retired.size === ring.retired.size)) {
        return false;
      }
      ring = next;
      loaded = keyringOf(next);
      return true;
    },
  };
}

/** Fixed keys (tests, and callers that hold a keyring already). */
export function fixedSecretKeys(loaded: LoadedKeyring): SecretKeys {
  return { get: () => loaded, refresh: async () => false };
}

// ---------------------------------------------------------------------------------------------
// Rotation's side of the key material (the CLI)
// ---------------------------------------------------------------------------------------------

/** The ring a KeyMaterial describes. Validates every key (the retired ones too). */
export function keyringOfMaterial(m: KeyMaterial): LoadedKeyring {
  const version = parseKeyVersion(m.KEPT_SECRET_KEY_VERSION, 'KEPT_SECRET_KEY_VERSION');
  return keyringOf({
    version,
    key: decodeKey(m.KEPT_SECRET_KEY, 'KEPT_SECRET_KEY'),
    retired: parseRetiredKeys(m.KEPT_SECRET_KEYS_RETIRED, version),
  });
}

/** `version:key` pairs as KEPT_SECRET_KEYS_RETIRED takes them, oldest first. */
export function formatRetired(pairs: ReadonlyMap<number, string>): string {
  return [...pairs]
    .sort(([a], [b]) => a - b)
    .map(([v, k]) => `${v}:${k}`)
    .join(',');
}

function retiredPairs(value: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    out.set(Number(entry.slice(0, colon)), entry.slice(colon + 1));
  }
  return out;
}

/**
 * The key material after a rotation: `newKey` (base64url or hex, as KEPT_SECRET_KEY takes it;
 * generated when omitted) becomes the current key at a version above every one in use, and the
 * old current key joins the retired ones. `atLeast` raises the new version past versions found
 * elsewhere (the database's key_version), so it never collides with one already used.
 */
export function rotatedMaterial(
  m: KeyMaterial,
  opts: { newKey?: string; atLeast?: number } = {},
): KeyMaterial {
  const ring = keyringOfMaterial(m);
  const newKey = opts.newKey ?? generateKey();
  decodeKey(newKey, 'the new key');
  const pairs = retiredPairs(m.KEPT_SECRET_KEYS_RETIRED);
  pairs.set(ring.current.keyVersion, m.KEPT_SECRET_KEY);
  for (const [, raw] of pairs) {
    if (raw === newKey) {
      throw new Error('the new key is one already in the keyring; generate a fresh one');
    }
  }
  const version = Math.max(...ring.keyring.keys(), opts.atLeast ?? 0) + 1;
  return {
    KEPT_SECRET_KEY: newKey,
    KEPT_AUTH_SECRET: m.KEPT_AUTH_SECRET,
    KEPT_SECRET_KEY_VERSION: version,
    KEPT_SECRET_KEYS_RETIRED: formatRetired(pairs),
    source: m.source,
  };
}

/** The retired versions of `m`, oldest first. */
export function retiredVersions(m: KeyMaterial): number[] {
  return [...retiredPairs(m.KEPT_SECRET_KEYS_RETIRED).keys()].sort((a, b) => a - b);
}

/** The key material without retired version `version` (`rotate-key --drop`; the caller checks
 * that no stored value uses it). The current key and the other retired ones are unchanged. */
export function withoutRetired(m: KeyMaterial, version: number): KeyMaterial {
  const pairs = retiredPairs(m.KEPT_SECRET_KEYS_RETIRED);
  pairs.delete(version);
  const rest = formatRetired(pairs);
  return { ...m, KEPT_SECRET_KEYS_RETIRED: rest === '' ? undefined : rest };
}

/**
 * Replaces secrets.json with `m`, atomically: written and fsynced under a temp name, then
 * renamed over the old file, so a reader sees the old file or the new one, never a torn one.
 * Mode 0600, like the file first boot writes.
 */
export async function replaceSecretsFile(filePath: string, m: KeyMaterial): Promise<void> {
  const data: SecretsFile = {
    KEPT_SECRET_KEY: m.KEPT_SECRET_KEY,
    KEPT_AUTH_SECRET: m.KEPT_AUTH_SECRET,
    KEPT_SECRET_KEY_VERSION: m.KEPT_SECRET_KEY_VERSION,
    ...(m.KEPT_SECRET_KEYS_RETIRED ? { KEPT_SECRET_KEYS_RETIRED: m.KEPT_SECRET_KEYS_RETIRED } : {}),
  };
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await openFile(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
