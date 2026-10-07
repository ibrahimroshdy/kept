import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Keyring, type MasterKey, open, type Sealed } from '../crypto/envelope.js';
import {
  applyBackupSettings,
  backupAad,
  backupEnvOverlay,
  backupSettingsView,
  describeBackupTarget,
  isResolved,
  parseSftpLocation,
  resolveBackupSettings,
  type StoredBackupSettings,
  type StoredBackupTarget,
} from './settings.js';

// Step-8 plan T10: the backup settings, sealed in instance_settings, overlaid by the environment.

const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const ring: Keyring = new Map([[1, master.key]]);
const base = { KEPT_DATA_DIR: '/data' };
const PASSWORD = 'a long backup passphrase';
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyBase64';

const s3Input = {
  target: {
    kind: 's3' as const,
    endpoint: 'https://s3.example.org',
    region: 'eu-central-1',
    bucket: 'kept-backups',
    prefix: 'kept/',
    forcePathStyle: true,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'the bucket secret',
  },
  password: PASSWORD,
  time: '03:15',
  keep: { daily: 7, weekly: 4, monthly: 6 },
};

describe('the environment overlay', () => {
  it('locks only what the operator set, read from the raw environment', () => {
    const none = backupEnvOverlay(base);
    expect(none).toMatchObject({
      target: null,
      password: null,
      time: null,
      keep: { daily: null, weekly: null, monthly: null },
      storageMode: 'local',
    });
    const set = backupEnvOverlay({
      ...base,
      KEPT_BACKUP_DIR: '/mnt/nas/kept',
      KEPT_BACKUP_TIME: '04:00',
      KEPT_BACKUP_KEEP_WEEKLY: '2',
      KEPT_BACKUP_PASSWORD: PASSWORD,
    });
    expect(set.target).toEqual({ kind: 'dir', path: '/mnt/nas/kept' });
    expect(set.time).toBe('04:00');
    expect(set.keep).toEqual({ daily: null, weekly: 2, monthly: null });
    expect(set.password).toBe(PASSWORD);
  });

  it("reads the alpha's KEPT_BACKUP_KEEP as the daily count (plan Q7)", () => {
    expect(backupEnvOverlay({ ...base, KEPT_BACKUP_KEEP: '9' }).keep.daily).toBe(9);
    expect(
      backupEnvOverlay({ ...base, KEPT_BACKUP_KEEP: '9', KEPT_BACKUP_KEEP_DAILY: '5' }).keep.daily,
    ).toBe(5);
  });

  it("parses restic's two SFTP forms (R1)", () => {
    expect(parseSftpLocation('sftp:kept@nas.lan:/srv/kept')).toEqual({
      user: 'kept',
      host: 'nas.lan',
      port: 22,
      path: '/srv/kept',
    });
    expect(parseSftpLocation('sftp://kept@sftp:2222//config/kept-target/restic')).toEqual({
      user: 'kept',
      host: 'sftp',
      port: 2222,
      path: '/config/kept-target/restic',
    });
    expect(parseSftpLocation('/not/sftp')).toBeNull();
  });
});

describe('saving and reading', () => {
  it('seals each secret under its own AAD and shows only that it is set', () => {
    const overlay = backupEnvOverlay(base);
    const { next, audit } = applyBackupSettings({}, s3Input, overlay, master);
    expect(JSON.stringify(next)).not.toContain(PASSWORD);
    expect(JSON.stringify(next)).not.toContain('the bucket secret');
    expect(open(ring, next.password as Sealed, backupAad('password')).toString()).toBe(PASSWORD);
    expect(() => open(ring, next.password as Sealed, backupAad('s3SecretAccessKey'))).toThrow();
    expect(audit).toEqual({
      targetKind: 's3',
      changed: { s3SecretAccessKey: true, target: true, password: true, time: true },
    });
    const view = backupSettingsView(next, 3, overlay);
    expect(view).toMatchObject({
      configured: true,
      target: { value: { kind: 's3', secretAccessKeySet: true, bucket: 'kept-backups' } },
      passwordSet: { value: true, locked: false },
      time: { value: '03:15', locked: false },
      version: 3,
    });
    expect(JSON.stringify(view)).not.toContain('bucket secret');
    const resolved = resolveBackupSettings(next, overlay, ring);
    expect(isResolved(resolved) && resolved.password).toBe(PASSWORD);
    expect(isResolved(resolved) && resolved.description).toBe(
      'S3 bucket kept-backups at s3.example.org, kept/',
    );
  });

  it('no password, no backup (plan Q6)', () => {
    const overlay = backupEnvOverlay(base);
    const { password: _p, ...input } = s3Input;
    const { next } = applyBackupSettings({}, input, overlay, master);
    expect(backupSettingsView(next, 1, overlay).configured).toBe(false);
    expect(resolveBackupSettings(next, overlay, ring)).toEqual({ reason: 'no_password' });
  });

  it('keeps a stored secret when the PUT leaves it out, and drops it with its kind', () => {
    const overlay = backupEnvOverlay(base);
    const first = applyBackupSettings({}, s3Input, overlay, master).next;
    const { secretAccessKey: _s, ...target } = s3Input.target;
    const again = applyBackupSettings(
      first,
      { ...s3Input, target, password: undefined },
      overlay,
      master,
    );
    expect(again.next.s3SecretAccessKey).toEqual(first.s3SecretAccessKey);
    expect(again.audit.changed).toEqual({});
    const dir = applyBackupSettings(
      first,
      { ...s3Input, target: { kind: 'dir', path: '/mnt/nas' } },
      overlay,
      master,
    );
    expect(dir.next.s3SecretAccessKey).toBeUndefined();
    expect(dir.audit.changed).toMatchObject({ s3SecretAccessKey: true, target: true });
  });

  it('refuses a new S3 or SFTP target without its credential, and a directory in the data', () => {
    const overlay = backupEnvOverlay(base);
    const { secretAccessKey: _s, ...target } = s3Input.target;
    expect(() => applyBackupSettings({}, { ...s3Input, target }, overlay, master)).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    const sftp = {
      kind: 'sftp' as const,
      host: 'nas.lan',
      port: 22,
      user: 'kept',
      path: '/srv/kept',
      hostKey: HOST_KEY,
    };
    expect(() => applyBackupSettings({}, { ...s3Input, target: sftp }, overlay, master)).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    const ok = applyBackupSettings(
      {},
      { ...s3Input, target: { ...sftp, privateKey: KEY } },
      overlay,
      master,
    );
    expect(describeBackupTarget(ok.next.target as StoredBackupTarget)).toBe(
      'SFTP kept@nas.lan:/srv/kept',
    );
    expect(() =>
      applyBackupSettings(
        {},
        { ...s3Input, target: { kind: 'dir', path: '/data/b' } },
        overlay,
        master,
      ),
    ).toThrow(expect.objectContaining({ code: 'validation' }));
  });

  it('400 setting_locked for a changed locked field; the same value passes', () => {
    const overlay = backupEnvOverlay({
      ...base,
      KEPT_BACKUP_DIR: '/mnt/nas/kept',
      KEPT_BACKUP_PASSWORD: PASSWORD,
      KEPT_BACKUP_TIME: '04:00',
    });
    const same = {
      target: { kind: 'dir' as const, path: '/mnt/nas/kept' },
      time: '04:00',
      keep: { daily: 7, weekly: 4, monthly: 6 },
    };
    const saved = applyBackupSettings({}, same, overlay, master);
    expect(saved.next.target).toBeUndefined();
    const view = backupSettingsView(saved.next, 1, overlay);
    expect(view).toMatchObject({
      configured: true,
      target: { locked: true },
      passwordSet: { value: true, locked: true },
      time: { locked: true },
      keep: { daily: { locked: false } },
    });
    const locked = expect.objectContaining({ code: 'setting_locked' });
    expect(() =>
      applyBackupSettings(
        {},
        { ...same, target: { kind: 'dir', path: '/mnt/other' } },
        overlay,
        master,
      ),
    ).toThrow(locked);
    expect(() =>
      applyBackupSettings({}, { ...same, password: 'another long one' }, overlay, master),
    ).toThrow(locked);
    expect(() => applyBackupSettings({}, { ...same, time: '05:00' }, overlay, master)).toThrow(
      locked,
    );
  });

  it('an environment target resolves without any keys; a saved secret needs them', () => {
    const env = backupEnvOverlay({
      ...base,
      KEPT_BACKUP_SFTP: 'sftp:kept@nas.lan:/srv/kept',
      KEPT_BACKUP_SFTP_KEY_FILE: '/run/secrets/kept-sftp',
      KEPT_BACKUP_SFTP_KNOWN_HOSTS: '/run/secrets/known_hosts',
      KEPT_BACKUP_PASSWORD: PASSWORD,
    });
    const resolved = resolveBackupSettings({}, env, null);
    expect(resolved).toMatchObject({
      target: {
        kind: 'sftp',
        location: 'sftp:kept@nas.lan:/srv/kept',
        keyFile: '/run/secrets/kept-sftp',
      },
      locked: true,
      keep: { daily: 7, weekly: 4, monthly: 6 },
      time: '02:30',
    });
    const stored: StoredBackupSettings = applyBackupSettings(
      {},
      s3Input,
      backupEnvOverlay(base),
      master,
    ).next;
    expect(resolveBackupSettings(stored, backupEnvOverlay(base), null)).toEqual({
      reason: 'no_credentials',
    });
  });
});
