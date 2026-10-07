import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { SecretKeys } from '../crypto/keyring.js';
import type { KitBackupHalf } from '../setup/recovery-kit-content.js';
import { knownHostsLine, repositoryLocation } from './restic/repo.js';
import { isResolved, loadBackupSettings } from './settings.js';

// The recovery kit's backup half (step-8 plan T9): the effective backup settings (settings.ts:
// the sealed `backup` row under the environment's locks, secrets opened with the keyring) as the
// restic repository (restic/repo.ts's location, R1's table), its password and its storage
// credentials, for the web download and `kept admin recovery-kit` alike.
//
// - no target, or a target without a password (no password, no backup: plan Q6) → `none`;
// - saved credentials this keyring can't open → `unavailable`, never a half-made kit;
// - S3: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION, the variables restic
//   reads (R1); SFTP: the private key and the pinned host key as a known_hosts line, from the
//   saved settings or read from the files KEPT_BACKUP_SFTP_KEY_FILE / _KNOWN_HOSTS name.
// Nothing here logs a value or puts one in an error.

export type KitBackupContext = {
  /** A transaction that can read instance_settings: an instance admin's kept_app, or kept_owner. */
  client: Pick<pg.ClientBase, 'query'>;
  /** The raw environment the server (or the CLI) runs with: the KEPT_BACKUP_* locks. */
  env: Readonly<Record<string, string | undefined>>;
  /** The keyring, to open the saved secrets; null where none was loaded. */
  secretKeys: SecretKeys | null;
};

async function fileText(file: string | null): Promise<string | null> {
  if (!file) return null;
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** The backup half of the kit. */
export async function readBackupForKit(ctx: KitBackupContext): Promise<KitBackupHalf> {
  const settings = await loadBackupSettings(
    ctx.client,
    ctx.env,
    ctx.secretKeys?.get().keyring ?? null,
  );
  if (!isResolved(settings)) {
    if (settings.reason === 'no_credentials') {
      return {
        state: 'unavailable',
        reason: "the saved storage credentials couldn't be opened with this server's key.",
      };
    }
    return { state: 'none' };
  }
  const t = settings.target;
  const environment: [string, string][] =
    t.kind === 's3'
      ? [
          ['AWS_ACCESS_KEY_ID', t.accessKeyId],
          ['AWS_SECRET_ACCESS_KEY', t.secretAccessKey],
          ['AWS_DEFAULT_REGION', t.region],
        ]
      : [];
  let sftp: { privateKey: string; knownHostsLine: string } | null = null;
  if (t.kind === 'sftp') {
    const privateKey = t.privateKey ?? (await fileText(t.keyFile));
    const knownHosts = t.hostKey
      ? knownHostsLine(t.host, t.port, t.hostKey)
      : await fileText(t.knownHostsFile);
    if (!privateKey || !knownHosts) {
      return {
        state: 'unavailable',
        reason: "the SFTP key or known_hosts file the environment names couldn't be read.",
      };
    }
    sftp = { privateKey, knownHostsLine: knownHosts.trim() };
  }
  return {
    state: 'configured',
    backup: {
      kind: t.kind,
      description: settings.description,
      repository: repositoryLocation(t),
      password: settings.password,
      environment,
      sftp,
      lockedByEnvironment: settings.locked,
    },
  };
}
