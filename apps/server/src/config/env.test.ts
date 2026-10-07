import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import {
  backupKeepOf,
  defaultImageConcurrency,
  EnvError,
  embeddingsDir,
  loadEnv,
  loadMigrateEnv,
  localEmbeddingsInstalled,
  resticCacheDir,
  vapidSubject,
} from './env.js';

const validEnv = {
  KEPT_DATABASE_URL: 'postgres://kept_app:kept_app@localhost:5452/kept',
  KEPT_AUTH_DATABASE_URL: 'postgres://kept_auth:kept_auth@localhost:5452/kept',
  KEPT_SYSTEM_DATABASE_URL: 'postgres://kept_system:kept_system@localhost:5452/kept',
  KEPT_PUBLIC_URL: 'http://localhost:5173',
};

const tmpDirs: string[] = [];
async function freshConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-env-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** A path under a fresh temp dir that does not exist yet. */
async function unusedConfigDir(): Promise<string> {
  return path.join(await freshConfigDir(), 'config');
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tmpDirs.length = 0;
});

const key = () => randomBytes(32).toString('base64url');

describe('loadEnv', () => {
  it('throws and lists the required variables when they are missing', async () => {
    await expect(loadEnv({})).rejects.toThrow(EnvError);
    try {
      await loadEnv({});
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('KEPT_DATABASE_URL');
      expect(message).toContain('KEPT_AUTH_DATABASE_URL');
      expect(message).toContain('KEPT_SYSTEM_DATABASE_URL');
      expect(message).toContain('KEPT_PUBLIC_URL');
    }
  });

  it('generates both keys on first boot and reuses them on the next call', async () => {
    const configDir = await unusedConfigDir();
    const logged: string[] = [];

    const env1 = await loadEnv(validEnv, { configDir, logger: (line) => logged.push(line) });
    expect(typeof env1.KEPT_SECRET_KEY).toBe('string');
    expect(typeof env1.KEPT_AUTH_SECRET).toBe('string');
    expect(Buffer.from(env1.KEPT_SECRET_KEY, 'base64url').length).toBe(32);
    expect(Buffer.from(env1.KEPT_AUTH_SECRET, 'base64url').length).toBe(32);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('secrets.json');

    const dirStat = await stat(configDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const secretsPath = path.join(configDir, 'secrets.json');
    const fileStat = await stat(secretsPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await readFile(secretsPath, 'utf8'));
    expect(onDisk.KEPT_SECRET_KEY).toBe(env1.KEPT_SECRET_KEY);
    expect(onDisk.KEPT_AUTH_SECRET).toBe(env1.KEPT_AUTH_SECRET);

    const env2 = await loadEnv(validEnv, { configDir });
    expect(env2.KEPT_SECRET_KEY).toBe(env1.KEPT_SECRET_KEY);
    expect(env2.KEPT_AUTH_SECRET).toBe(env1.KEPT_AUTH_SECRET);
  });

  it('two concurrent first boots agree on one pair of keys and leave no temp files', async () => {
    const configDir = await unusedConfigDir();
    const logged: string[] = [];
    const logger = (line: string) => logged.push(line);

    const envs = await Promise.all(
      Array.from({ length: 4 }, () => loadEnv(validEnv, { configDir, logger })),
    );
    for (const env of envs) {
      expect(env.KEPT_SECRET_KEY).toBe(envs[0]?.KEPT_SECRET_KEY);
      expect(env.KEPT_AUTH_SECRET).toBe(envs[0]?.KEPT_AUTH_SECRET);
    }
    const onDisk = JSON.parse(await readFile(path.join(configDir, 'secrets.json'), 'utf8'));
    expect(onDisk.KEPT_SECRET_KEY).toBe(envs[0]?.KEPT_SECRET_KEY);
    expect(await readdir(configDir)).toEqual(['secrets.json']);
    // Only the caller whose file won logs the generation.
    expect(logged).toHaveLength(1);
  });

  it('refuses to boot on an existing but malformed secrets.json instead of regenerating', async () => {
    const configDir = await freshConfigDir();
    const secretsPath = path.join(configDir, 'secrets.json');

    for (const body of [
      '{ not json',
      '{}',
      '[]',
      JSON.stringify({ KEPT_SECRET_KEY: key() }),
      JSON.stringify({ KEPT_SECRET_KEY: key(), KEPT_AUTH_SECRET: 'short' }),
    ]) {
      await writeFile(secretsPath, body);
      await expect(loadEnv(validEnv, { configDir })).rejects.toMatchObject({
        code: 'secrets_file_invalid',
      });
      // The file is left exactly as found: regenerating would orphan everything it encrypted.
      expect(await readFile(secretsPath, 'utf8')).toBe(body);
    }
  });

  it('throws secret_key_too_short when a supplied key decodes under 32 bytes', async () => {
    const configDir = await unusedConfigDir();
    const shortKey = Buffer.from('too-short').toString('base64url');

    await expect(
      loadEnv({ ...validEnv, KEPT_SECRET_KEY: shortKey, KEPT_AUTH_SECRET: key() }, { configDir }),
    ).rejects.toMatchObject({ code: 'secret_key_too_short' });
  });

  it('throws secret_key_invalid on characters outside base64url or hex', async () => {
    const configDir = await unusedConfigDir();
    // Buffer.from(…, 'base64url') silently skips '!' and '+'; the contract must not.
    for (const bad of [`${key()}!!`, `${key().slice(0, 40)}+/==`, `${key()} `]) {
      await expect(
        loadEnv({ ...validEnv, KEPT_SECRET_KEY: bad, KEPT_AUTH_SECRET: key() }, { configDir }),
      ).rejects.toMatchObject({ code: 'secret_key_invalid' });
    }
  });

  it('refuses to boot with secret_keys_partial when only one key is supplied', async () => {
    const configDir = await unusedConfigDir();

    await expect(
      loadEnv({ ...validEnv, KEPT_SECRET_KEY: key() }, { configDir }),
    ).rejects.toMatchObject({ code: 'secret_keys_partial' });
    await expect(
      loadEnv({ ...validEnv, KEPT_AUTH_SECRET: key() }, { configDir }),
    ).rejects.toMatchObject({ code: 'secret_keys_partial' });
    // Nothing is generated alongside the one that was supplied.
    await expect(stat(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates the one supplied key before reporting the pair as partial', async () => {
    const configDir = await unusedConfigDir();
    await expect(
      loadEnv({ ...validEnv, KEPT_AUTH_SECRET: 'abc' }, { configDir }),
    ).rejects.toMatchObject({ code: 'secret_key_too_short' });
  });

  it('treats an empty string as unset', async () => {
    const configDir = await unusedConfigDir();
    const env = await loadEnv(
      { ...validEnv, KEPT_SECRET_KEY: '', KEPT_AUTH_SECRET: '', KEPT_LOG_LEVEL: '' },
      { configDir },
    );
    expect(env.secretKey.length).toBe(32);
    expect(env.KEPT_LOG_LEVEL).toBe('info');

    await expect(loadEnv({ ...validEnv, KEPT_PUBLIC_URL: '' })).rejects.toMatchObject({
      code: 'invalid_env',
    });
  });

  it('uses supplied keys as given and writes nothing to configDir', async () => {
    const configDir = await unusedConfigDir();
    const secretKey = key();
    const authSecret = key();

    const env = await loadEnv(
      { ...validEnv, KEPT_SECRET_KEY: secretKey, KEPT_AUTH_SECRET: authSecret },
      { configDir },
    );
    expect(env.KEPT_SECRET_KEY).toBe(secretKey);
    expect(env.KEPT_AUTH_SECRET).toBe(authSecret);

    await expect(stat(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a hex-encoded 32-byte key as an alternative to base64url', async () => {
    const configDir = await unusedConfigDir();
    const hexKey = randomBytes(32).toString('hex');

    const env = await loadEnv(
      { ...validEnv, KEPT_SECRET_KEY: hexKey, KEPT_AUTH_SECRET: key() },
      { configDir },
    );
    expect(env.secretKey.length).toBe(32);
    expect(env.secretKey.toString('hex')).toBe(hexKey);
  });

  it('keeps the keys off enumeration, JSON and inspect so logging env cannot leak them', async () => {
    const configDir = await unusedConfigDir();
    const secretKey = key();
    const authSecret = key();
    const env = await loadEnv(
      { ...validEnv, KEPT_SECRET_KEY: secretKey, KEPT_AUTH_SECRET: authSecret },
      { configDir },
    );

    expect(env.KEPT_SECRET_KEY).toBe(secretKey);
    expect(env.authSecret.length).toBe(32);
    for (const name of ['KEPT_SECRET_KEY', 'KEPT_AUTH_SECRET', 'secretKey', 'authSecret']) {
      expect(Object.keys(env)).not.toContain(name);
    }
    for (const text of [
      JSON.stringify(env),
      inspect(env, { depth: 5 }),
      JSON.stringify({ ...env }),
    ]) {
      expect(text).not.toContain(secretKey);
      expect(text).not.toContain(authSecret);
    }
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('restricts KEPT_ROLE to all, web or worker', async () => {
    await expect(loadEnv({ ...validEnv, KEPT_ROLE: 'bogus' })).rejects.toThrow(EnvError);
  });

  it('restricts KEPT_STORAGE to local or s3', async () => {
    await expect(loadEnv({ ...validEnv, KEPT_STORAGE: 'bogus' })).rejects.toThrow(EnvError);
  });

  it('restricts KEPT_LOG_LEVEL to pino levels', async () => {
    await expect(loadEnv({ ...validEnv, KEPT_LOG_LEVEL: 'verbose' })).rejects.toMatchObject({
      code: 'invalid_env',
    });
    const env = await loadEnv(
      { ...validEnv, KEPT_LOG_LEVEL: 'debug' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_LOG_LEVEL).toBe('debug');
  });

  it.each([
    ['KEPT_DATABASE_URL', 'not a url'],
    ['KEPT_DATABASE_URL', 'http://localhost:5452/kept'],
    ['KEPT_SYSTEM_DATABASE_URL', 'localhost:5452'],
    ['KEPT_OWNER_DATABASE_URL', 'mysql://root@localhost/kept'],
    ['KEPT_PUBLIC_URL', 'localhost:5173'],
    ['KEPT_PUBLIC_URL', 'ftp://example.com'],
    ['KEPT_SMTP_URL', 'mailpit:1025'],
  ])('rejects %s=%s', async (name, value) => {
    await expect(loadEnv({ ...validEnv, [name]: value })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining(name),
    });
  });

  it('accepts postgresql://, https and smtp URLs', async () => {
    const env = await loadEnv(
      {
        ...validEnv,
        KEPT_DATABASE_URL: 'postgresql://kept_app:x@db:5432/kept?sslmode=require',
        KEPT_PUBLIC_URL: 'https://kept.example.com',
        KEPT_SMTP_URL: 'smtp://user:pass@mailpit:1025',
      },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_PUBLIC_URL).toBe('https://kept.example.com');
  });

  it('KEPT_TRUSTED_PROXIES: empty by default, a frozen list of addresses and ranges when set', async () => {
    const plain = await loadEnv(validEnv, { configDir: await unusedConfigDir() });
    expect(plain.KEPT_TRUSTED_PROXIES).toEqual([]);

    const env = await loadEnv(
      { ...validEnv, KEPT_TRUSTED_PROXIES: '10.0.0.0/8, 172.18.0.1,fd00::/8' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '172.18.0.1', 'fd00::/8']);
    expect(Object.isFrozen(env.KEPT_TRUSTED_PROXIES)).toBe(true);
  });

  it.each(['10.0.0.0/33', 'proxy.local', '*'])('rejects KEPT_TRUSTED_PROXIES=%s', async (value) => {
    await expect(loadEnv({ ...validEnv, KEPT_TRUSTED_PROXIES: value })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_TRUSTED_PROXIES'),
    });
  });

  it('leaves an existing config dir mode alone', async () => {
    const configDir = await unusedConfigDir();
    await mkdir(configDir, { mode: 0o750 });
    await loadEnv(validEnv, { configDir });
    expect((await stat(configDir)).mode & 0o777).toBe(0o750);
  });

  it('requires KEPT_SOURCE_URL in production (D147)', async () => {
    await expect(loadEnv({ ...validEnv, NODE_ENV: 'production' })).rejects.toMatchObject({
      code: 'source_url_required',
    });

    const configDir = await unusedConfigDir();
    const env = await loadEnv(
      { ...validEnv, NODE_ENV: 'production', KEPT_SOURCE_URL: 'https://github.com/x/y@abc123' },
      { configDir },
    );
    expect(env.KEPT_SOURCE_URL).toBe('https://github.com/x/y@abc123');
  });
});

describe('loadEnv: files and storage (step 2; §3.4, D186)', () => {
  const GB = 1024 ** 3;

  it('KEPT_MAX_FILE_MB defaults to 25 and takes a whole number of megabytes', async () => {
    const plain = await loadEnv(validEnv, { configDir: await unusedConfigDir() });
    expect(plain.KEPT_MAX_FILE_MB).toBe(25);
    const set = await loadEnv(
      { ...validEnv, KEPT_MAX_FILE_MB: '100' },
      { configDir: await unusedConfigDir() },
    );
    expect(set.KEPT_MAX_FILE_MB).toBe(100);
  });

  it.each(['0', '-1', '2.5', 'lots', '5000'])('rejects KEPT_MAX_FILE_MB=%s', async (value) => {
    await expect(loadEnv({ ...validEnv, KEPT_MAX_FILE_MB: value })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_MAX_FILE_MB'),
    });
  });

  it('KEPT_IMAGE_CONCURRENCY defaults to 1 on a host under 3 GB, on any architecture, else 2', async () => {
    expect(defaultImageConcurrency(2 * GB)).toBe(1);
    expect(defaultImageConcurrency(4 * GB)).toBe(2);
    const small = await loadEnv(validEnv, {
      configDir: await unusedConfigDir(),
      host: { arch: 'x64', totalMemBytes: 2 * GB },
    });
    expect(small.KEPT_IMAGE_CONCURRENCY).toBe(1);
    const set = await loadEnv(
      { ...validEnv, KEPT_IMAGE_CONCURRENCY: '4' },
      { configDir: await unusedConfigDir(), host: { arch: 'arm64', totalMemBytes: 2 * GB } },
    );
    expect(set.KEPT_IMAGE_CONCURRENCY).toBe(4);
  });

  it.each(['0', '1.5', '64'])('rejects KEPT_IMAGE_CONCURRENCY=%s', async (value) => {
    await expect(loadEnv({ ...validEnv, KEPT_IMAGE_CONCURRENCY: value })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_IMAGE_CONCURRENCY'),
    });
  });

  const s3 = {
    KEPT_STORAGE: 's3',
    KEPT_S3_ENDPOINT: 'http://localhost:9452',
    KEPT_S3_BUCKET: 'kept',
    KEPT_S3_ACCESS_KEY_ID: 'kept-access',
    KEPT_S3_SECRET_ACCESS_KEY: 'kept-secret-access-key-value',
    KEPT_S3_FORCE_PATH_STYLE: 'true',
  };

  it('KEPT_STORAGE=s3 needs the bucket and both credentials, and names what is missing', async () => {
    const { KEPT_S3_BUCKET: _b, KEPT_S3_SECRET_ACCESS_KEY: _s, ...partial } = s3;
    await expect(loadEnv({ ...validEnv, ...partial })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringMatching(/KEPT_S3_BUCKET.*KEPT_S3_SECRET_ACCESS_KEY/),
    });
  });

  it('reads the S3 settings, with us-east-1 and virtual-host style by default', async () => {
    const env = await loadEnv({ ...validEnv, ...s3 }, { configDir: await unusedConfigDir() });
    expect(env).toMatchObject({
      KEPT_STORAGE: 's3',
      KEPT_S3_ENDPOINT: 'http://localhost:9452',
      KEPT_S3_REGION: 'us-east-1',
      KEPT_S3_BUCKET: 'kept',
      KEPT_S3_ACCESS_KEY_ID: 'kept-access',
      KEPT_S3_FORCE_PATH_STYLE: true,
    });
    expect(env.KEPT_S3_SECRET_ACCESS_KEY).toBe('kept-secret-access-key-value');
    const plain = await loadEnv(
      { ...validEnv, ...s3, KEPT_S3_FORCE_PATH_STYLE: '' },
      { configDir: await unusedConfigDir() },
    );
    expect(plain.KEPT_S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('reads KEPT_S3_PUBLIC_ENDPOINT, an http(s) URL, for presigned URLs (T18, T17)', async () => {
    const env = await loadEnv(
      { ...validEnv, ...s3, KEPT_S3_PUBLIC_ENDPOINT: 'https://files.example.com' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_S3_PUBLIC_ENDPOINT).toBe('https://files.example.com');
    await expect(
      loadEnv({ ...validEnv, ...s3, KEPT_S3_PUBLIC_ENDPOINT: 'ftp://files.example.com' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('KEPT_S3_PUBLIC_ENDPOINT') });
  });

  it('keeps the S3 secret off enumeration, JSON and inspect', async () => {
    const env = await loadEnv({ ...validEnv, ...s3 }, { configDir: await unusedConfigDir() });
    expect(Object.keys(env)).not.toContain('KEPT_S3_SECRET_ACCESS_KEY');
    for (const text of [JSON.stringify(env), inspect(env, { depth: 5 })]) {
      expect(text).not.toContain(s3.KEPT_S3_SECRET_ACCESS_KEY);
    }
  });

  it('ignores the S3 settings for local storage', async () => {
    const env = await loadEnv(
      { ...validEnv, KEPT_S3_BUCKET: 'kept' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_STORAGE).toBe('local');
  });
});

describe('loadEnv: capture, AI and barcodes (step 3, T2)', () => {
  it('KEPT_AI_MOCK is off unless set to 1', async () => {
    const plain = await loadEnv(validEnv, { configDir: await unusedConfigDir() });
    expect(plain.KEPT_AI_MOCK).toBe(false);
    const on = await loadEnv(
      { ...validEnv, KEPT_AI_MOCK: '1' },
      { configDir: await unusedConfigDir() },
    );
    expect(on.KEPT_AI_MOCK).toBe(true);
    const off = await loadEnv(
      { ...validEnv, KEPT_AI_MOCK: '0' },
      { configDir: await unusedConfigDir() },
    );
    expect(off.KEPT_AI_MOCK).toBe(false);
    await expect(loadEnv({ ...validEnv, KEPT_AI_MOCK: 'yes' })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_AI_MOCK'),
    });
  });

  it('refuses to boot in production with KEPT_AI_MOCK=1', async () => {
    const production = {
      ...validEnv,
      NODE_ENV: 'production',
      KEPT_SOURCE_URL: 'https://github.com/x/y@abc123',
    };
    await expect(
      loadEnv({ ...production, KEPT_AI_MOCK: '1' }, { configDir: await unusedConfigDir() }),
    ).rejects.toMatchObject({ code: 'ai_mock_in_production' });
    const off = await loadEnv(
      { ...production, KEPT_AI_MOCK: '0' },
      { configDir: await unusedConfigDir() },
    );
    expect(off.KEPT_AI_MOCK).toBe(false);
  });

  it('KEPT_BARCODE_LOOKUP locks the setting when set, like KEPT_SIGNUP_OPEN (D126)', async () => {
    const plain = await loadEnv(validEnv, { configDir: await unusedConfigDir() });
    expect(plain.KEPT_BARCODE_LOOKUP).toBeUndefined();
    for (const [value, parsed] of [
      ['true', true],
      ['false', false],
    ] as const) {
      const env = await loadEnv(
        { ...validEnv, KEPT_BARCODE_LOOKUP: value },
        { configDir: await unusedConfigDir() },
      );
      expect(env.KEPT_BARCODE_LOOKUP).toBe(parsed);
    }
    await expect(loadEnv({ ...validEnv, KEPT_BARCODE_LOOKUP: '1' })).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_BARCODE_LOOKUP'),
    });
  });

  it('KEPT_BARCODE_CONTACT is an email address, for the lookup User-Agent (D104)', async () => {
    const env = await loadEnv(
      { ...validEnv, KEPT_BARCODE_CONTACT: 'ops@example.org' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_BARCODE_CONTACT).toBe('ops@example.org');
    await expect(
      loadEnv({ ...validEnv, KEPT_BARCODE_CONTACT: 'not an address' }),
    ).rejects.toMatchObject({
      code: 'invalid_env',
      message: expect.stringContaining('KEPT_BARCODE_CONTACT'),
    });
  });

  it('KEPT_EVAL_DIR is read as given, and unset by default', async () => {
    const plain = await loadEnv(validEnv, { configDir: await unusedConfigDir() });
    expect(plain.KEPT_EVAL_DIR).toBeUndefined();
    const env = await loadEnv(
      { ...validEnv, KEPT_EVAL_DIR: '/photos/eval' },
      { configDir: await unusedConfigDir() },
    );
    expect(env.KEPT_EVAL_DIR).toBe('/photos/eval');
  });
});

describe('loadMigrateEnv', () => {
  it('needs only KEPT_OWNER_DATABASE_URL: no keys, no other URLs, no config dir', () => {
    const ownerUrl = 'postgres://kept_owner:kept_owner@localhost:5452/kept';
    expect(loadMigrateEnv({ KEPT_OWNER_DATABASE_URL: ownerUrl })).toEqual({ ownerUrl });
  });

  it.each([
    [{}],
    [{ KEPT_OWNER_DATABASE_URL: '' }],
    [{ KEPT_OWNER_DATABASE_URL: 'http://localhost/kept' }],
  ])('throws invalid_env for %j', (source) => {
    expect(() => loadMigrateEnv(source)).toThrow(
      expect.objectContaining({
        code: 'invalid_env',
        message: expect.stringContaining('KEPT_OWNER_DATABASE_URL'),
      }),
    );
  });
});

describe('the backup settings (T31c)', () => {
  const owner = 'postgres://kept_owner:kept_owner@localhost:5452/kept';
  const load = async (extra: Record<string, string>) =>
    loadEnv(
      { ...validEnv, KEPT_DATA_DIR: '/data', ...extra },
      { configDir: await unusedConfigDir() },
    );

  it('defaults: no target, keep 7, at 02:30 UTC', async () => {
    const env = await load({});
    expect(env.KEPT_BACKUP_DIR).toBeUndefined();
    expect(env.KEPT_BACKUP_KEEP).toBe(7);
    expect(env.KEPT_BACKUP_TIME).toBe('02:30');
  });

  it('a target on a worker needs the owner login, since the dump runs as kept_owner', async () => {
    await expect(load({ KEPT_BACKUP_DIR: '/backups' })).rejects.toMatchObject({
      code: 'backup_invalid',
      message: expect.stringContaining('KEPT_OWNER_DATABASE_URL'),
    });
    // A web-only process never runs the job.
    await expect(load({ KEPT_BACKUP_DIR: '/backups', KEPT_ROLE: 'web' })).resolves.toBeTruthy();
    const env = await load({ KEPT_BACKUP_DIR: '/backups', KEPT_OWNER_DATABASE_URL: owner });
    expect(env.KEPT_BACKUP_DIR).toBe('/backups');
  });

  it('refuses two targets, a relative or in-data-volume directory, a bucket without keys', async () => {
    const withOwner = { KEPT_OWNER_DATABASE_URL: owner };
    const cases: Record<string, string>[] = [
      { KEPT_BACKUP_DIR: '/backups', KEPT_BACKUP_S3_BUCKET: 'b' },
      { KEPT_BACKUP_DIR: 'backups' },
      { KEPT_BACKUP_DIR: '/data/backups' },
      { KEPT_BACKUP_DIR: '/data' },
      { KEPT_BACKUP_S3_BUCKET: 'b', KEPT_BACKUP_S3_ACCESS_KEY_ID: 'id' },
    ];
    for (const bad of cases) {
      await expect(load({ ...withOwner, ...bad }), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'backup_invalid',
      });
    }
    await expect(load({ ...withOwner, KEPT_BACKUP_TIME: '2:30' })).rejects.toThrow(EnvError);
    await expect(load({ ...withOwner, KEPT_BACKUP_KEEP: '0' })).rejects.toThrow(EnvError);
  });

  it("never shows the backup bucket's secret key", async () => {
    const env = await load({
      KEPT_OWNER_DATABASE_URL: owner,
      KEPT_BACKUP_S3_BUCKET: 'kept-backups',
      KEPT_BACKUP_S3_ACCESS_KEY_ID: 'id',
      KEPT_BACKUP_S3_SECRET_ACCESS_KEY: 'backup-secret-value',
    });
    expect(env.KEPT_BACKUP_S3_SECRET_ACCESS_KEY).toBe('backup-secret-value');
    expect(JSON.stringify(env)).not.toContain('backup-secret-value');
    expect(inspect(env)).not.toContain('backup-secret-value');
  });
});

describe('the step-8 operations settings (plan T2)', () => {
  const owner = 'postgres://kept_owner:kept_owner@localhost:5452/kept';
  const withOwner = { KEPT_OWNER_DATABASE_URL: owner };
  const load = async (extra: Record<string, string>, logger?: (line: string) => void) =>
    loadEnv(
      { ...validEnv, KEPT_DATA_DIR: '/data', ...extra },
      { configDir: await unusedConfigDir(), ...(logger ? { logger } : {}) },
    );

  it('defaults: port 8080, no update-check lock, upgrade snapshots on, no forced downgrade', async () => {
    const env = await load({});
    expect(env.KEPT_PORT).toBe(8080);
    expect(env.KEPT_UPDATE_CHECK).toBeUndefined();
    expect(env.KEPT_UPGRADE_SNAPSHOT).toBe('auto');
    expect(env.KEPT_ALLOW_DOWNGRADE).toBe(false);
    expect(env.KEPT_BACKUP_PASSWORD).toBeUndefined();
    expect(backupKeepOf(env)).toEqual({ daily: 7, weekly: 4, monthly: 6 });
    expect(resticCacheDir(env)).toBe(path.join('/data', '.cache', 'restic'));
  });

  it('reads the port, the update-check lock and the retention counts', async () => {
    const env = await load({
      KEPT_PORT: '8091',
      KEPT_UPDATE_CHECK: 'false',
      KEPT_BACKUP_KEEP_DAILY: '14',
      KEPT_BACKUP_KEEP_WEEKLY: '0',
      KEPT_RESTIC_CACHE_DIR: '/cache/restic',
      KEPT_UPGRADE_SNAPSHOT: 'off',
      KEPT_ALLOW_DOWNGRADE: '1',
    });
    expect(env.KEPT_PORT).toBe(8091);
    expect(env.KEPT_UPDATE_CHECK).toBe(false);
    expect(backupKeepOf(env)).toEqual({ daily: 14, weekly: 0, monthly: 6 });
    expect(resticCacheDir(env)).toBe('/cache/restic');
    expect(env.KEPT_UPGRADE_SNAPSHOT).toBe('off');
    expect(env.KEPT_ALLOW_DOWNGRADE).toBe(true);
    const bads: Record<string, string>[] = [
      { KEPT_PORT: '0' },
      { KEPT_PORT: '70000' },
      { KEPT_BACKUP_KEEP_DAILY: '0' },
      { KEPT_UPGRADE_SNAPSHOT: 'maybe' },
    ];
    for (const bad of bads) {
      await expect(load(bad), JSON.stringify(bad)).rejects.toThrow(EnvError);
    }
  });

  it("reads the alpha's KEPT_BACKUP_KEEP as the daily count, with one deprecation line (Q7)", async () => {
    const logged: string[] = [];
    const env = await load({ KEPT_BACKUP_KEEP: '10' }, (line) => logged.push(line));
    expect(backupKeepOf(env).daily).toBe(10);
    expect(logged.filter((line) => line.includes('KEPT_BACKUP_KEEP is deprecated'))).toHaveLength(
      1,
    );
    const quiet: string[] = [];
    await load({ KEPT_BACKUP_KEEP_DAILY: '10' }, (line) => quiet.push(line));
    expect(quiet.some((line) => line.includes('deprecated'))).toBe(false);
  });

  it('takes SFTP as a third target, with its key and known_hosts files, and only one target', async () => {
    const sftp = {
      KEPT_BACKUP_SFTP: 'sftp:kept@nas.lan:/backups/kept',
      KEPT_BACKUP_SFTP_KEY_FILE: '/config/backup/id_ed25519',
      KEPT_BACKUP_SFTP_KNOWN_HOSTS: '/config/backup/known_hosts',
    };
    const env = await load({ ...withOwner, ...sftp });
    expect(env.KEPT_BACKUP_SFTP).toBe(sftp.KEPT_BACKUP_SFTP);
    for (const bad of [
      { ...sftp, KEPT_BACKUP_DIR: '/backups' },
      { ...sftp, KEPT_BACKUP_SFTP_KEY_FILE: '' },
      { ...sftp, KEPT_BACKUP_SFTP_KNOWN_HOSTS: 'known_hosts' },
    ]) {
      await expect(load({ ...withOwner, ...bad }), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'backup_invalid',
      });
    }
    await expect(load({ ...withOwner, KEPT_BACKUP_SFTP: 'nas.lan:/x' })).rejects.toThrow(EnvError);
    // The job dumps as kept_owner, so an SFTP target on a worker needs the owner login too.
    await expect(load(sftp)).rejects.toMatchObject({ code: 'backup_invalid' });
  });

  it('refuses a short backup password and never shows one', async () => {
    await expect(load({ KEPT_BACKUP_PASSWORD: 'short' })).rejects.toThrow(EnvError);
    const env = await load({ KEPT_BACKUP_PASSWORD: 'restic-password-value' });
    expect(env.KEPT_BACKUP_PASSWORD).toBe('restic-password-value');
    expect(Object.keys(env)).not.toContain('KEPT_BACKUP_PASSWORD');
    expect(JSON.stringify(env)).not.toContain('restic-password-value');
    expect(inspect(env)).not.toContain('restic-password-value');
  });
});

describe('the VAPID settings (step 4, T2; plan Q11)', () => {
  const load = async (extra: Record<string, string>, base: Record<string, string> = validEnv) =>
    loadEnv({ ...base, ...extra }, { configDir: await unusedConfigDir() });
  const pair = () => webpush.generateVAPIDKeys();

  it('are unset by default', async () => {
    const env = await load({});
    expect(env.KEPT_VAPID_PUBLIC_KEY).toBeUndefined();
    expect(env.KEPT_VAPID_PRIVATE_KEY).toBeUndefined();
    expect(env.KEPT_VAPID_SUBJECT).toBeUndefined();
  });

  it('takes a pair generateVAPIDKeys() made, and keeps the private half off JSON and inspect', async () => {
    const { publicKey, privateKey } = pair();
    const env = await load({
      KEPT_VAPID_PUBLIC_KEY: publicKey,
      KEPT_VAPID_PRIVATE_KEY: privateKey,
    });
    expect(env.KEPT_VAPID_PUBLIC_KEY).toBe(publicKey);
    expect(env.KEPT_VAPID_PRIVATE_KEY).toBe(privateKey);
    expect(Object.keys(env)).not.toContain('KEPT_VAPID_PRIVATE_KEY');
    expect(JSON.stringify(env)).not.toContain(privateKey);
    expect(inspect(env)).not.toContain(privateKey);
  });

  it('refuses half a pair, naming the missing half', async () => {
    const { publicKey, privateKey } = pair();
    await expect(load({ KEPT_VAPID_PUBLIC_KEY: publicKey })).rejects.toMatchObject({
      code: 'vapid_keys_partial',
      message: expect.stringContaining('KEPT_VAPID_PRIVATE_KEY is missing'),
    });
    await expect(load({ KEPT_VAPID_PRIVATE_KEY: privateKey })).rejects.toMatchObject({
      code: 'vapid_keys_partial',
      message: expect.stringContaining('KEPT_VAPID_PUBLIC_KEY is missing'),
    });
  });

  it('refuses keys of the wrong length or alphabet, never echoing them', async () => {
    const { publicKey, privateKey } = pair();
    const cases: Record<string, string>[] = [
      { KEPT_VAPID_PUBLIC_KEY: privateKey, KEPT_VAPID_PRIVATE_KEY: privateKey },
      { KEPT_VAPID_PUBLIC_KEY: publicKey, KEPT_VAPID_PRIVATE_KEY: publicKey },
      { KEPT_VAPID_PUBLIC_KEY: `${publicKey}=`, KEPT_VAPID_PRIVATE_KEY: privateKey },
      { KEPT_VAPID_PUBLIC_KEY: publicKey, KEPT_VAPID_PRIVATE_KEY: `${privateKey.slice(1)}+` },
    ];
    for (const bad of cases) {
      const err = await load(bad).catch((e: unknown) => e);
      expect(err, JSON.stringify(Object.keys(bad))).toBeInstanceOf(EnvError);
      expect((err as EnvError).code).toBe('invalid_env');
      expect((err as EnvError).message).not.toContain(privateKey.slice(1, 20));
    }
  });

  it('takes an https: or mailto: subject and nothing else', async () => {
    for (const ok of ['https://kept.example.org', 'mailto:ibrahim@example.org']) {
      expect((await load({ KEPT_VAPID_SUBJECT: ok })).KEPT_VAPID_SUBJECT).toBe(ok);
    }
    for (const bad of ['http://kept.example.org', 'ibrahim@example.org', 'ftp://x']) {
      await expect(load({ KEPT_VAPID_SUBJECT: bad }), bad).rejects.toThrow(EnvError);
    }
  });

  it('defaults the subject to the https public URL, else the From address, else none', () => {
    const base = { KEPT_VAPID_SUBJECT: undefined, KEPT_SMTP_FROM: undefined };
    expect(
      vapidSubject({
        ...base,
        KEPT_VAPID_SUBJECT: 'mailto:bruce@example.org',
        KEPT_PUBLIC_URL: 'https://kept.example.org',
      }),
    ).toBe('mailto:bruce@example.org');
    expect(vapidSubject({ ...base, KEPT_PUBLIC_URL: 'https://kept.example.org/app' })).toBe(
      'https://kept.example.org',
    );
    expect(
      vapidSubject({
        ...base,
        KEPT_PUBLIC_URL: 'http://kept.lan:8080',
        KEPT_SMTP_FROM: 'Kept <kept@example.org>',
      }),
    ).toBe('mailto:kept@example.org');
    expect(
      vapidSubject({
        ...base,
        KEPT_PUBLIC_URL: 'http://kept.lan:8080',
        KEPT_SMTP_FROM: 'kept@example.org',
      }),
    ).toBe('mailto:kept@example.org');
    // Apple's push service refuses a localhost subject (web-push warns): the From address instead.
    expect(
      vapidSubject({
        ...base,
        KEPT_PUBLIC_URL: 'https://localhost:5173',
        KEPT_SMTP_FROM: 'kept@example.org',
      }),
    ).toBe('mailto:kept@example.org');
    expect(vapidSubject({ ...base, KEPT_PUBLIC_URL: 'http://localhost:5173' })).toBeNull();
  });
});

describe('embeddings and OIDC (step 6, T2; D207, S6.7)', () => {
  const load = async (extra: Record<string, string>, available?: () => boolean) =>
    loadEnv(
      { ...validEnv, ...extra },
      {
        configDir: await unusedConfigDir(),
        ...(available ? { localEmbeddingsAvailable: available } : {}),
      },
    );

  it('embeds with the provider by default, in <data>/models when local', async () => {
    const env = await load({});
    expect(env.KEPT_EMBEDDINGS).toBe('provider');
    expect(env.KEPT_EMBEDDINGS_DIR).toBeUndefined();
    expect(embeddingsDir(env)).toBe(path.join('/data', 'models'));
    expect(embeddingsDir({ ...env, KEPT_EMBEDDINGS_DIR: '/models' })).toBe('/models');
    expect((await load({ KEPT_EMBEDDINGS: 'off' })).KEPT_EMBEDDINGS).toBe('off');
    await expect(load({ KEPT_EMBEDDINGS: 'semantic' })).rejects.toMatchObject({
      code: 'invalid_env',
    });
  });

  it('refuses local when its runtime is not installed, naming D207', async () => {
    // The runtime is not a dependency in 1.0 (spike S6.5): the real check says so.
    expect(localEmbeddingsInstalled()).toBe(false);
    await expect(load({ KEPT_EMBEDDINGS: 'local' })).rejects.toMatchObject({
      code: 'embeddings_unavailable',
      message: expect.stringContaining('D207'),
    });
    const env = await load({ KEPT_EMBEDDINGS: 'local' }, () => true);
    expect(env.KEPT_EMBEDDINGS).toBe('local');
  });

  it('reads the OIDC settings, with their defaults, and keeps the client secret hidden', async () => {
    const none = await load({});
    expect(none.KEPT_OIDC_ISSUER).toBeUndefined();
    expect(none.KEPT_OIDC_NAME).toBe('OIDC');
    expect(none.KEPT_OIDC_AUTOPROVISION_DOMAINS).toEqual([]);
    expect(none.KEPT_OIDC_AUTOPROVISION_GROUPS).toEqual([]);
    expect(none.KEPT_OIDC_GROUPS_CLAIM).toBe('groups');
    expect(none.KEPT_OIDC_SCOPES).toBe('openid email profile');

    const env = await load({
      KEPT_OIDC_ISSUER: 'https://id.example.org/realms/kept',
      KEPT_OIDC_CLIENT_ID: 'kept',
      KEPT_OIDC_CLIENT_SECRET: 'oidc-secret-value',
      KEPT_OIDC_NAME: 'Family ID',
      KEPT_OIDC_AUTOPROVISION_DOMAINS: 'example.org, family.example ,',
      KEPT_OIDC_AUTOPROVISION_GROUPS: 'kept-family',
    });
    expect(env.KEPT_OIDC_ISSUER).toBe('https://id.example.org/realms/kept');
    expect(env.KEPT_OIDC_AUTOPROVISION_DOMAINS).toEqual(['example.org', 'family.example']);
    expect(env.KEPT_OIDC_AUTOPROVISION_GROUPS).toEqual(['kept-family']);
    expect(env.KEPT_OIDC_CLIENT_SECRET).toBe('oidc-secret-value');
    expect(Object.keys(env)).not.toContain('KEPT_OIDC_CLIENT_SECRET');
    expect(JSON.stringify(env)).not.toContain('oidc-secret-value');
    expect(inspect(env)).not.toContain('oidc-secret-value');
  });

  it('refuses an issuer without a client id, and an issuer that is not http(s)', async () => {
    await expect(load({ KEPT_OIDC_ISSUER: 'https://id.example.org' })).rejects.toMatchObject({
      code: 'oidc_incomplete',
    });
    await expect(
      load({ KEPT_OIDC_ISSUER: 'ftp://id.example.org', KEPT_OIDC_CLIENT_ID: 'kept' }),
    ).rejects.toMatchObject({ code: 'invalid_env' });
  });
});
