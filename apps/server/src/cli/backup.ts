import pg from 'pg';
import { CliError } from '../admin/cli.js';
import { type BackupCliEnv, loadBackupCliEnv } from '../backup/config.js';
import { runDrill } from '../backup/drill.js';
import { legacyRuns, legacyTargetOf } from '../backup/legacy.js';
import { backupLockHeld, bucketVersioningOf, runSnapshot } from '../backup/nightly.js';
import { type PgTools, pgTools } from '../backup/pg-tools.js';
import { readableCopy } from '../backup/readable/run.js';
import { openRepo } from '../backup/restic/repo.js';
import type { Restic } from '../backup/restic/restic.js';
import {
  type BackupNotConfigured,
  backupEnvOverlay,
  isResolved,
  loadBackupSettings,
  type ResolvedBackupSettings,
  resolveBackupSettings,
} from '../backup/settings.js';
import { runVerify } from '../backup/verify.js';
import { readableDepsOf } from './readable.js';

// `kept admin backup [--list] [--accept-size]` (step-8 plan T5, T7): a restic snapshot, now, to
// the configured repository, recorded and audited exactly like the nightly one (a `manual` run);
// or the snapshots the repository holds, newest first, with the alpha's old runs listed apart
// (`kept admin restore --legacy <id>` takes those, for one release). Below: verify, the drill
// and unlock.

type Source = Record<string, string | undefined>;

const NOT_CONFIGURED: Record<BackupNotConfigured['reason'], string> = {
  no_target:
    'backups are not set up: choose a target in Admin → Backups, or set KEPT_BACKUP_DIR, KEPT_BACKUP_S3_BUCKET or KEPT_BACKUP_SFTP',
  no_password:
    'backups have no password: set one in Admin → Backups, or KEPT_BACKUP_PASSWORD (no password, no backup)',
  no_credentials:
    "the saved backup credentials can't be opened here: run this where Kept's keys are (KEPT_SECRET_KEY, or the config volume's secrets.json)",
};

export type BackupCommandDeps = { tools?: PgTools; restic?: Restic };

/** The settings the commands use, or a CliError saying what is missing. */
export async function cliBackupSettings(env: BackupCliEnv): Promise<ResolvedBackupSettings> {
  const client = new pg.Client({ connectionString: env.ownerUrl, application_name: 'kept-cli' });
  client.on('error', () => {});
  await client.connect();
  try {
    let settings: Awaited<ReturnType<typeof loadBackupSettings>>;
    try {
      settings = await loadBackupSettings(client, env.source, env.keyring);
    } catch (err) {
      // A restore onto a new server points the owner login at an EMPTY database: nothing is
      // saved there, so the environment (the recovery kit's lines) is the whole configuration.
      if ((err as { code?: string }).code !== '42P01') throw err;
      settings = resolveBackupSettings({}, backupEnvOverlay(env.source), env.keyring);
    }
    if (!isResolved(settings)) throw new CliError(NOT_CONFIGURED[settings.reason]);
    return settings;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function backupCommand(
  source: Source,
  opts: { list?: boolean; acceptSize?: boolean } & BackupCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  const env = await loadBackupCliEnv(source);
  const settings = await cliBackupSettings(env);
  const restic = opts.restic ?? env.restic;
  if (opts.list) {
    const opened = await openRepo(settings.target, settings.password, { tmpDir: env.tmpDir });
    try {
      const snaps = await restic.snapshots(opened.repo).catch((err: unknown) => {
        if ((err as { reason?: string }).reason === 'no_repository') return [];
        throw err;
      });
      if (snaps.length === 0) print(`No snapshots in ${settings.description}.`);
      for (const s of snaps) {
        const kind = s.tags.find((t) => ['nightly', 'manual', 'pre_upgrade'].includes(t)) ?? '-';
        const version = s.tags.find((t) => /^v\d/.test(t)) ?? '';
        print(`${s.id.slice(0, 8)}  ${s.time.toISOString()}  ${kind}  ${version}`.trimEnd());
      }
    } finally {
      await opened.dispose();
    }
    const legacy = legacyTargetOf(settings.target);
    const old = legacy ? await legacyRuns(legacy).catch(() => []) : [];
    if (old.length > 0) {
      print('');
      print('Older backups from before restic (kept admin restore --legacy <id>):');
      for (const id of old) print(id);
    }
    return 0;
  }
  print(`Backing up to ${settings.description}…`);
  // The readable copy (T6, D159) needs the kept_app login too; without it the snapshot holds
  // the database and the files only, and says so.
  const readable = readableDepsOf(env, source, {
    info: () => {},
    error: (_obj, msg) => print(msg),
  });
  if (!readable) print('KEPT_DATABASE_URL is not set: this snapshot has no readable copy.');
  let run: Awaited<ReturnType<typeof runSnapshot>>;
  try {
    run = await runSnapshot(
      {
        ownerUrl: env.ownerUrl,
        restic,
        settings,
        dataDir: env.dataDir,
        storage: env.storage,
        blobs: env.blobs,
        pgTools: opts.tools ?? pgTools(),
        bucketVersioning: () => bucketVersioningOf(env.blobs),
        readable: readable ? readableCopy(readable.deps) : null,
      },
      { kind: 'manual', ...(opts.acceptSize ? { acceptSize: true } : {}) },
    );
  } finally {
    await readable?.pool.end().catch(() => {});
  }
  print(
    `Snapshot ${run.snapshotId?.slice(0, 8)}: ${run.filesTotal ?? 0} files, ${run.bytesAdded ?? 0} bytes added (${run.filesNew ?? 0} new files).`,
  );
  if (run.missing > 0) {
    print(`${run.missing} file(s) the database lists were missing from the file store.`);
  }
  if (run.error === 'backup_suspicious_size') {
    const shrank = (run.detail.shrank as string[] | undefined) ?? [];
    print(`Warning: much smaller than the last good backup (${shrank.join('; ')}).`);
    print(
      'Older snapshots were kept. If the shrink is real, run `kept admin backup --accept-size`.',
    );
  } else if (run.status === 'warning') {
    print(`Warning: ${run.error}.`);
  }
  if (run.sameVolume) {
    print('Warning: the backup directory is on the same disk as the data; use another disk.');
  }
  return run.status === 'warning' ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// `kept admin backup verify | drill | unlock` (step-8 plan T7)

/** `verify [--read-data <percent>] [--all-files]`: `restic check`, and with S3 storage the
 * newest manifest's files against the bucket (D144). Recorded as a `verify` run. */
export async function backupVerifyCommand(
  source: Source,
  opts: { readData?: string; allFiles?: boolean } & BackupCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  if (opts.readData !== undefined && !/^\d{1,3}(?:\.\d+)?%$/.test(opts.readData)) {
    throw new CliError('--read-data takes a percentage, e.g. 5%');
  }
  const env = await loadBackupCliEnv(source);
  const settings = await cliBackupSettings(env);
  const report = await runVerify({
    ownerUrl: env.ownerUrl,
    restic: opts.restic ?? env.restic,
    settings,
    storage: env.storage,
    blobs: env.blobs,
    tmpDir: env.tmpDir,
    ...(opts.readData ? { readDataSubset: opts.readData } : {}),
    ...(opts.allFiles ? { allFiles: true } : {}),
    print,
  });
  print(report.run.status === 'ok' ? 'Verified.' : `NOT verified: ${report.run.error}.`);
  return report.run.status === 'ok' ? 0 : 1;
}

/** `drill --into <database URL> [--all-files]`: the newest good snapshot restored into an empty
 * scratch database and checked; recorded in the live database as a `drill` run. */
export async function backupDrillCommand(
  source: Source,
  opts: { into: string; allFiles?: boolean } & BackupCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  if (!/^postgres(?:ql)?:\/\//.test(opts.into)) {
    throw new CliError('--into takes the scratch database as a postgres:// URL (kept_owner)');
  }
  const env = await loadBackupCliEnv(source);
  const settings = await cliBackupSettings(env);
  const result = await runDrill({
    liveOwnerUrl: env.ownerUrl,
    intoUrl: opts.into,
    restic: opts.restic ?? env.restic,
    settings,
    storage: env.storage,
    blobs: env.blobs,
    pgTools: opts.tools ?? pgTools(),
    tmpDir: env.tmpDir,
    ...(opts.allFiles ? { allFiles: true } : {}),
    print,
  });
  return result.verified ? 0 : 1;
}

/** `unlock`: removes a stale restic lock after a crash; refused while a backup runs. */
export async function backupUnlockCommand(
  source: Source,
  opts: BackupCommandDeps,
  print: (line: string) => void,
): Promise<number> {
  const env = await loadBackupCliEnv(source);
  const settings = await cliBackupSettings(env);
  const client = new pg.Client({ connectionString: env.ownerUrl, application_name: 'kept-cli' });
  client.on('error', () => {});
  await client.connect();
  try {
    if (await backupLockHeld(client)) {
      throw new CliError('a backup is running now; its lock is not stale. Try again when it ends.');
    }
  } finally {
    await client.end().catch(() => {});
  }
  const opened = await openRepo(settings.target, settings.password, { tmpDir: env.tmpDir });
  try {
    await (opts.restic ?? env.restic).unlock(opened.repo);
  } finally {
    await opened.dispose();
  }
  print(`Stale locks removed from ${settings.description}.`);
  return 0;
}
