import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeBackupTarget, type ResolvedBackupTarget } from '../settings.js';
import type { ResticRepo } from './restic.js';

// A backup target → the restic repository in it (step-8 plan T5; R1's "Repository locations").
// - A directory: `<dir>/restic`, beside the alpha's `runs/` and `blobs/` (plan Q2), which stay
//   until the operator removes them.
// - S3: `s3:<endpoint>/<bucket>/<prefix>restic`, or for AWS itself the regional endpoint restic's
//   docs give, `s3:s3.<region>.amazonaws.com/<bucket>/<prefix>restic` (restic expects path-style
//   URLs for AWS). The keys go in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, the region in
//   `-o s3.region`, and `-o s3.bucket-lookup=path` when forcePathStyle is set (R1).
// - SFTP from the environment: KEPT_BACKUP_SFTP as given, with the key and known_hosts files
//   KEPT_BACKUP_SFTP_KEY_FILE / KEPT_BACKUP_SFTP_KNOWN_HOSTS name.
// - SFTP from Admin → Backups: `sftp://<user>@<host>:<port>/<path>` (R1: the URL form takes a
//   port; a path starting with `/` makes the double slash of an absolute path). The private key
//   is written to a 0600 file under KEPT_DATA_DIR/tmp for the run's lifetime and deleted after;
//   the known_hosts file holds only the pinned host key.
// The ssh arguments are R1's: the pinned known_hosts only, strict checking, the key alone, batch
// mode, and restic's own keep-alive advice for long uploads.
// The target comes resolved from settings.ts (T10: the stored settings under the environment,
// secrets opened). `description` (logs, backup_runs.target) is settings.ts's
// describeBackupTarget(): never a credential.

export type OpenedRepo = {
  repo: ResticRepo;
  /** Removes what opening wrote (an SFTP key file). Safe to call twice. */
  dispose(): Promise<void>;
};

/** The repository location string (RESTIC_REPOSITORY), without any credential. */
export function repositoryLocation(target: ResolvedBackupTarget): string {
  switch (target.kind) {
    case 'dir':
      return path.join(target.path, 'restic');
    case 's3': {
      const base = target.endpoint
        ? target.endpoint.replace(/\/+$/, '')
        : `s3.${target.region}.amazonaws.com`;
      return `s3:${base}/${target.bucket}/${target.prefix}restic`;
    }
    case 'sftp':
      return (
        target.location ?? `sftp://${target.user}@${target.host}:${target.port}/${target.path}`
      );
  }
}

function sshArgs(keyFile: string, knownHostsFile: string): string {
  return [
    `-o UserKnownHostsFile=${knownHostsFile}`,
    '-o StrictHostKeyChecking=yes',
    '-o GlobalKnownHostsFile=/dev/null',
    `-i ${keyFile}`,
    '-o IdentitiesOnly=yes',
    '-o BatchMode=yes',
    '-o ServerAliveInterval=60',
    '-o ServerAliveCountMax=240',
  ].join(' ');
}

/** The known_hosts line pinning one host key: `[host]:port <type> <key>`, or `host` on 22. */
export function knownHostsLine(host: string, port: number, hostKey: string): string {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  const name = port === 22 ? (bare.includes(':') ? `[${bare}]` : bare) : `[${bare}]:${port}`;
  return `${name} ${hostKey.trim()}\n`;
}

/**
 * Opens a target's repository with `password`. `tmpDir` (KEPT_DATA_DIR/tmp) holds an SFTP key
 * written from the settings until dispose().
 */
export async function openRepo(
  target: ResolvedBackupTarget,
  password: string,
  opts: { tmpDir: string },
): Promise<OpenedRepo> {
  const location = repositoryLocation(target);
  const description = describeBackupTarget(target);
  const env: Record<string, string> = { RESTIC_PASSWORD: password };
  const options: Record<string, string> = {};
  let cleanup: string | null = null;
  switch (target.kind) {
    case 'dir':
      break;
    case 's3':
      env.AWS_ACCESS_KEY_ID = target.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = target.secretAccessKey;
      options['s3.region'] = target.region;
      if (target.forcePathStyle) options['s3.bucket-lookup'] = 'path';
      break;
    case 'sftp':
      if (target.keyFile && target.knownHostsFile) {
        options['sftp.args'] = sshArgs(target.keyFile, target.knownHostsFile);
      } else {
        if (!target.privateKey || !target.hostKey) {
          throw new Error('an SFTP target needs a private key and a pinned host key');
        }
        const dir = path.join(opts.tmpDir, `sftp-${randomUUID()}`);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        cleanup = dir;
        const keyFile = path.join(dir, 'key');
        const knownHosts = path.join(dir, 'known_hosts');
        const pk = target.privateKey;
        const key = pk.endsWith('\n') ? pk : `${pk}\n`;
        await writeFile(keyFile, key, { mode: 0o600 });
        await writeFile(knownHosts, knownHostsLine(target.host, target.port, target.hostKey), {
          mode: 0o600,
        });
        options['sftp.args'] = sshArgs(keyFile, knownHosts);
      }
      break;
  }
  const repo: ResticRepo = Object.freeze({
    location,
    env: Object.freeze(env),
    description,
    ...(Object.keys(options).length > 0 ? { options: Object.freeze(options) } : {}),
  });
  return {
    repo,
    dispose: async () => {
      if (!cleanup) return;
      const dir = cleanup;
      cleanup = null;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
