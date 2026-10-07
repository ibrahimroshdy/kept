import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvError, loadEnv, readKeyMaterial } from '../config/env.js';
import { open, seal } from './envelope.js';
import {
  keyringOfMaterial,
  loadKeyring,
  replaceSecretsFile,
  rotatedMaterial,
  secretKeysOf,
} from './keyring.js';

// The keyring (plan Q19, §7.3): the current key with its version, and retired keys that still
// open what they sealed, from the environment or from the config volume's secrets.json.

const validEnv = {
  KEPT_DATABASE_URL: 'postgres://kept_app:kept_app@localhost:5452/kept',
  KEPT_AUTH_DATABASE_URL: 'postgres://kept_auth:kept_auth@localhost:5452/kept',
  KEPT_SYSTEM_DATABASE_URL: 'postgres://kept_system:kept_system@localhost:5452/kept',
  KEPT_PUBLIC_URL: 'http://localhost:5173',
};

const key = () => randomBytes(32).toString('base64url');
const AAD = {
  table: 'secret_values',
  rowId: '0192f000-0000-7000-8000-000000000001',
  fieldKey: 'pin',
};

const dirs: string[] = [];
async function configDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-keyring-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

describe('the keyring from the environment', () => {
  it('is version 1 with no retired keys when only the two keys are set', async () => {
    const secret = key();
    const env = await loadEnv(
      { ...validEnv, KEPT_SECRET_KEY: secret, KEPT_AUTH_SECRET: key() },
      { configDir: await configDir() },
    );
    const ring = loadKeyring(env);
    expect(ring.current.keyVersion).toBe(1);
    expect(ring.current.key.toString('base64url')).toBe(secret);
    expect([...ring.keyring.keys()]).toEqual([1]);
    expect(env.secretKeyring.source).toBe('environment');
  });

  it('takes KEPT_SECRET_KEY_VERSION and the retired `version:key` pairs', async () => {
    const [v1, v2, v3] = [key(), key(), key()];
    const env = await loadEnv(
      {
        ...validEnv,
        KEPT_SECRET_KEY: v3,
        KEPT_SECRET_KEY_VERSION: '3',
        KEPT_SECRET_KEYS_RETIRED: `1:${v1}, 2:${v2}`,
        KEPT_AUTH_SECRET: key(),
      },
      { configDir: await configDir() },
    );
    const ring = loadKeyring(env);
    expect(ring.current.keyVersion).toBe(3);
    expect([...ring.keyring.keys()].sort()).toEqual([1, 2, 3]);
    expect(ring.keyring.get(1)?.toString('base64url')).toBe(v1);
    // A value sealed under version 1 still opens with the ring that holds it as retired.
    const old = seal({ key: Buffer.from(v1, 'base64url'), keyVersion: 1 }, 'sesame', AAD);
    expect(open(ring.keyring, old, AAD).toString()).toBe('sesame');
  });

  it('keeps the retired keys off enumeration, JSON and inspect', async () => {
    const retired = key();
    const env = await loadEnv(
      {
        ...validEnv,
        KEPT_SECRET_KEY: key(),
        KEPT_SECRET_KEY_VERSION: '2',
        KEPT_SECRET_KEYS_RETIRED: `1:${retired}`,
        KEPT_AUTH_SECRET: key(),
      },
      { configDir: await configDir() },
    );
    expect(Object.keys(env)).not.toContain('KEPT_SECRET_KEYS_RETIRED');
    expect(Object.keys(env)).not.toContain('secretKeyring');
    for (const text of [JSON.stringify(env), inspect(env, { depth: 6 })]) {
      expect(text).not.toContain(retired);
    }
  });

  it.each([
    ['0', undefined, 'secret_key_version_invalid'],
    ['1.5', undefined, 'secret_key_version_invalid'],
    ['two', undefined, 'secret_key_version_invalid'],
    ['2', 'no-colon', 'secret_key_version_invalid'],
    ['2', `2:${key()}`, 'secret_key_version_invalid'],
    ['3', `1:${key()},1:${key()}`, 'secret_key_version_invalid'],
    ['2', `1:${randomBytes(16).toString('base64url')}`, 'secret_key_too_short'],
  ])('refuses version %s with retired %s (%s), naming no key', async (version, retired, code) => {
    const secret = key();
    const err = await loadEnv(
      {
        ...validEnv,
        KEPT_SECRET_KEY: secret,
        KEPT_SECRET_KEY_VERSION: version,
        ...(retired ? { KEPT_SECRET_KEYS_RETIRED: retired } : {}),
        KEPT_AUTH_SECRET: key(),
      },
      { configDir: await configDir() },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvError);
    expect(err).toMatchObject({ code });
    const message = (err as Error).message;
    expect(message).not.toContain(secret);
    for (const part of (retired ?? '').split(',')) {
      const k = part.split(':')[1];
      if (k && k.length > 8) expect(message).not.toContain(k);
    }
  });

  it('refuses the version or retired keys beside generated keys (they live in secrets.json)', async () => {
    const dir = await configDir();
    await expect(
      loadEnv({ ...validEnv, KEPT_SECRET_KEY_VERSION: '2' }, { configDir: dir }),
    ).rejects.toMatchObject({ code: 'secret_keys_partial' });
  });
});

describe('the keyring in secrets.json', () => {
  it('reads a step-1 file (no version) as version 1', async () => {
    const dir = await configDir();
    const first = await loadEnv(validEnv, { configDir: dir });
    const ring = loadKeyring(first);
    expect(ring.current.keyVersion).toBe(1);
    expect(first.secretKeyring.source).toBe(path.join(dir, 'secrets.json'));
    const onDisk = JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(['KEPT_AUTH_SECRET', 'KEPT_SECRET_KEY']);
  });

  it('reads a rotated file: version and retired keys', async () => {
    const dir = await configDir();
    const [v1, v2, auth] = [key(), key(), key()];
    await writeFile(
      path.join(dir, 'secrets.json'),
      JSON.stringify({
        KEPT_SECRET_KEY: v2,
        KEPT_AUTH_SECRET: auth,
        KEPT_SECRET_KEY_VERSION: 2,
        KEPT_SECRET_KEYS_RETIRED: `1:${v1}`,
      }),
    );
    const ring = loadKeyring(await loadEnv(validEnv, { configDir: dir }));
    expect(ring.current.keyVersion).toBe(2);
    expect(ring.keyring.get(1)?.toString('base64url')).toBe(v1);
    const material = await readKeyMaterial({ KEPT_CONFIG_DIR: dir });
    expect(material).toMatchObject({
      KEPT_SECRET_KEY: v2,
      KEPT_SECRET_KEY_VERSION: 2,
      KEPT_SECRET_KEYS_RETIRED: `1:${v1}`,
    });
  });

  it('refuses a file whose version is not a number, or whose retired keys are bad', async () => {
    for (const extra of [
      { KEPT_SECRET_KEY_VERSION: '2' },
      { KEPT_SECRET_KEY_VERSION: 0 },
      { KEPT_SECRET_KEYS_RETIRED: 5 },
      { KEPT_SECRET_KEYS_RETIRED: '1:short' },
    ]) {
      const dir = await configDir();
      await writeFile(
        path.join(dir, 'secrets.json'),
        JSON.stringify({ KEPT_SECRET_KEY: key(), KEPT_AUTH_SECRET: key(), ...extra }),
      );
      await expect(loadEnv(validEnv, { configDir: dir })).rejects.toMatchObject({
        code: 'secrets_file_invalid',
      });
    }
  });
});

describe('rotation of the key material', () => {
  it('makes the new key current one version up, and keeps the old one retired', async () => {
    const dir = await configDir();
    const first = await loadEnv(validEnv, { configDir: dir });
    const before = await readKeyMaterial({ KEPT_CONFIG_DIR: dir });
    const next = rotatedMaterial(before);
    expect(next.KEPT_SECRET_KEY_VERSION).toBe(2);
    expect(next.KEPT_SECRET_KEYS_RETIRED).toBe(`1:${before.KEPT_SECRET_KEY}`);
    expect(next.KEPT_AUTH_SECRET).toBe(before.KEPT_AUTH_SECRET);

    const file = path.join(dir, 'secrets.json');
    await replaceSecretsFile(file, next);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = await readKeyMaterial({ KEPT_CONFIG_DIR: dir });
    expect(again).toEqual({ ...next, source: file });

    const third = rotatedMaterial(again, { atLeast: 7 });
    expect(third.KEPT_SECRET_KEY_VERSION).toBe(8);
    expect(third.KEPT_SECRET_KEYS_RETIRED).toBe(
      `1:${before.KEPT_SECRET_KEY},2:${next.KEPT_SECRET_KEY}`,
    );
    expect([...keyringOfMaterial(third).keyring.keys()].sort()).toEqual([1, 2, 8]);

    // A server that booted on the old file picks the rotation up when asked to.
    const keys = secretKeysOf(first);
    expect(keys.get().current.keyVersion).toBe(1);
    expect(await keys.refresh()).toBe(true);
    expect(keys.get().current.keyVersion).toBe(2);
    expect(keys.get().keyring.has(1)).toBe(true);
    expect(await keys.refresh()).toBe(false);
  });

  it('takes a given new key, and refuses one already in the ring', async () => {
    const material = {
      KEPT_SECRET_KEY: key(),
      KEPT_AUTH_SECRET: key(),
      KEPT_SECRET_KEY_VERSION: 1,
      KEPT_SECRET_KEYS_RETIRED: undefined,
      source: 'environment',
    };
    const given = key();
    expect(rotatedMaterial(material, { newKey: given }).KEPT_SECRET_KEY).toBe(given);
    expect(() => rotatedMaterial(material, { newKey: material.KEPT_SECRET_KEY })).toThrow(
      /already in the keyring/,
    );
    expect(() => rotatedMaterial(material, { newKey: 'short' })).toThrow(EnvError);
  });
});
