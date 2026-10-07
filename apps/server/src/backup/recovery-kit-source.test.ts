import { describe, expect, it } from 'vitest';
import { readBackupForKit } from './recovery-kit-source.js';

// Step-8 T9: the recovery kit's backup half from the effective backup settings (settings.ts),
// here from the environment alone (a client with no saved `backup` row).

const noRow = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
const read = (env: Record<string, string>) =>
  readBackupForKit({ client: noRow, env, secretKeys: null });

describe('the recovery kit backup half', () => {
  it('is "none" without a target, or with a target and no password', async () => {
    expect(await read({})).toEqual({ state: 'none' });
    expect(await read({ KEPT_BACKUP_DIR: '/mnt/nas/kept' })).toEqual({ state: 'none' });
  });

  it('a directory: the repository inside it and the password, locked by the environment', async () => {
    const half = await read({
      KEPT_BACKUP_DIR: '/mnt/nas/kept',
      KEPT_BACKUP_PASSWORD: 'a long backup passphrase',
    });
    expect(half).toMatchObject({
      state: 'configured',
      backup: {
        kind: 'dir',
        repository: '/mnt/nas/kept/restic',
        password: 'a long backup passphrase',
        environment: [],
        sftp: null,
        lockedByEnvironment: true,
      },
    });
  });

  it('S3: the bucket repository and the variables restic reads', async () => {
    const half = await read({
      KEPT_BACKUP_S3_BUCKET: 'kept-backups',
      KEPT_BACKUP_S3_ENDPOINT: 'https://s3.example.org',
      KEPT_BACKUP_S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      KEPT_BACKUP_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      KEPT_BACKUP_PASSWORD: 'a long backup passphrase',
    });
    if (half.state !== 'configured') throw new Error(half.state);
    expect(half.backup.repository).toMatch(/^s3:https:\/\/s3\.example\.org\/kept-backups\//);
    expect(half.backup.environment).toEqual(
      expect.arrayContaining([
        ['AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'],
        ['AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
      ]),
    );
  });
});
