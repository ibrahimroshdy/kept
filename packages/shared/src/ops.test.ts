import { describe, expect, it } from 'vitest';
import {
  APP_LOCK,
  BACKUP_KEEP_DEFAULT,
  BACKUP_PASSWORD_MIN,
  BackupSettingsInput,
  BackupTargetInput,
  compareSemver,
  KEEP_OFFLINE,
  KEEP_OFFLINE_ROLES,
  parseSemver,
  RecoveryKitDownloadInput,
} from './ops.js';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOq0ZcXcGv0rqk1E1Hb0bq3Gk5t8Lz1A2b3C4d5E6f7G';
const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

describe('backup targets', () => {
  it('takes an absolute directory and refuses a relative one or `..`', () => {
    expect(BackupTargetInput.parse({ kind: 'dir', path: '/mnt/nas/kept' })).toEqual({
      kind: 'dir',
      path: '/mnt/nas/kept',
    });
    expect(BackupTargetInput.safeParse({ kind: 'dir', path: 'nas/kept' }).success).toBe(false);
    expect(BackupTargetInput.safeParse({ kind: 'dir', path: '/mnt/../etc' }).success).toBe(false);
    expect(BackupTargetInput.safeParse({ kind: 'dir', path: '/mnt/a\nb' }).success).toBe(false);
  });

  it('fills an S3 target’s defaults and keeps the secret write-only (optional)', () => {
    const target = BackupTargetInput.parse({
      kind: 's3',
      bucket: 'kept-backups',
      accessKeyId: 'AKIAEXAMPLE',
    });
    expect(target).toEqual({
      kind: 's3',
      bucket: 'kept-backups',
      accessKeyId: 'AKIAEXAMPLE',
      region: 'us-east-1',
      prefix: 'kept-backups/',
      forcePathStyle: false,
    });
    expect(
      BackupTargetInput.safeParse({ kind: 's3', bucket: 'Kept_Backups', accessKeyId: 'a' }).success,
    ).toBe(false);
    expect(
      BackupTargetInput.safeParse({
        kind: 's3',
        bucket: 'kept',
        accessKeyId: 'a',
        prefix: 'no-slash',
      }).success,
    ).toBe(false);
  });

  it('needs an SFTP target’s pinned host key and checks the private key’s shape', () => {
    const base = { kind: 'sftp', host: 'nas.lan', user: 'kept', path: 'backups/kept' };
    expect(BackupTargetInput.safeParse(base).success).toBe(false);
    const parsed = BackupTargetInput.parse({ ...base, hostKey: HOST_KEY });
    expect(parsed).toMatchObject({ port: 22, hostKey: HOST_KEY });
    expect(
      BackupTargetInput.safeParse({ ...base, hostKey: HOST_KEY, privateKey: PRIVATE_KEY }).success,
    ).toBe(true);
    expect(
      BackupTargetInput.safeParse({ ...base, hostKey: HOST_KEY, privateKey: 'hunter2' }).success,
    ).toBe(false);
    expect(BackupTargetInput.safeParse({ ...base, hostKey: 'not a key' }).success).toBe(false);
  });

  it('refuses unknown fields (strict) and an unknown kind', () => {
    expect(BackupTargetInput.safeParse({ kind: 'dir', path: '/mnt/kept', extra: 1 }).success).toBe(
      false,
    );
    expect(BackupTargetInput.safeParse({ kind: 'b2', path: '/x' }).success).toBe(false);
  });
});

describe('backup settings', () => {
  const settings = {
    target: { kind: 'dir', path: '/mnt/nas/kept' },
    time: '02:30',
    keep: BACKUP_KEEP_DEFAULT,
  };

  it('defaults retention to 7/4/6 (D66)', () => {
    expect(BACKUP_KEEP_DEFAULT).toEqual({ daily: 7, weekly: 4, monthly: 6 });
  });

  it('takes no password (keep the stored one) or one of at least 12 characters (Q6)', () => {
    expect(BackupSettingsInput.safeParse(settings).success).toBe(true);
    expect(BACKUP_PASSWORD_MIN).toBe(12);
    expect(BackupSettingsInput.safeParse({ ...settings, password: 'a'.repeat(11) }).success).toBe(
      false,
    );
    expect(BackupSettingsInput.safeParse({ ...settings, password: 'correct horse' }).success).toBe(
      true,
    );
  });

  it('checks the time as HH:MM and each retention count', () => {
    expect(BackupSettingsInput.safeParse({ ...settings, time: '2:30' }).success).toBe(false);
    expect(BackupSettingsInput.safeParse({ ...settings, time: '24:00' }).success).toBe(false);
    expect(
      BackupSettingsInput.safeParse({ ...settings, keep: { daily: 0, weekly: 4, monthly: 6 } })
        .success,
    ).toBe(false);
    expect(
      BackupSettingsInput.safeParse({ ...settings, keep: { daily: 7, weekly: 0, monthly: 0 } })
        .success,
    ).toBe(true);
  });
});

describe('the recovery kit download body', () => {
  it('defaults to text and refuses other formats', () => {
    expect(RecoveryKitDownloadInput.parse({ password: 'x' })).toEqual({
      password: 'x',
      format: 'text',
    });
    expect(RecoveryKitDownloadInput.safeParse({ format: 'pdf' }).success).toBe(false);
  });
});

describe('parseSemver', () => {
  it('reads versions, prereleases, build metadata and a leading v', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
    });
    expect(parseSemver('v1.0.0-rc.1+abc.5')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', 1],
      build: ['abc', '5'],
    });
  });

  it('refuses what semver 2.0 refuses', () => {
    for (const bad of ['1.2', '01.2.3', '1.2.3-', '1.2.3-01', '1.2.3-a..b', '1.2.3+', 'x']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
    expect(parseSemver('0.0.0-dev')).not.toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders by semver 2.0 §11, the spec’s own example chain', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareSemver(chain[i] as string, chain[i + 1] as string)).toBe(-1);
      expect(compareSemver(chain[i + 1] as string, chain[i] as string)).toBe(1);
    }
  });

  it('ignores build metadata and throws on a non-version', () => {
    expect(compareSemver('1.2.3+a', '1.2.3+b')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(() => compareSemver('1.2', '1.2.3')).toThrow(/not a semver/);
  });
});

describe('this device', () => {
  it('locks after 5 minutes, takes a 6+ digit PIN, wipes after 10 tries (D181)', () => {
    expect(APP_LOCK).toMatchObject({ idleMinutes: 5, pinMin: 6, maxPinTries: 10 });
    // L1's count (about 288 ms in Chromium on the laptop); OWASP's 600,000 is the floor.
    expect(APP_LOCK.pbkdf2Iterations).toBe(2_850_000);
  });

  it('keeps documents only, 25 MB a file and 250 MB a device (Q21)', () => {
    expect(KEEP_OFFLINE).toEqual({ deviceBytes: 250 * 1024 ** 2, fileBytes: 25 * 1024 ** 2 });
    expect(KEEP_OFFLINE_ROLES).not.toContain('photo');
  });
});
