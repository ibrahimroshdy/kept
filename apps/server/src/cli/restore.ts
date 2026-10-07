import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../admin/cli.js';
import { loadBackupCliEnv } from '../backup/config.js';
import { legacyTargetOf } from '../backup/legacy.js';
import { type PgTools, pgTools } from '../backup/pg-tools.js';
import { openRepo } from '../backup/restic/repo.js';
import type { Restic } from '../backup/restic/restic.js';
import {
  type RestoreReport,
  restoreVerified,
  runResticRestore,
  runRestore,
  swapCommands,
} from '../backup/restore.js';
import { type BackupTarget, LocalDirTarget } from '../backup/target.js';
import { cliBackupSettings } from './backup.js';

// `kept admin restore <snapshot>` (step-8 plan T7; D66): into the EMPTY database
// KEPT_OWNER_DATABASE_URL names, and the file store KEPT_STORAGE names (backup/restore.ts).
// <snapshot> is a restic snapshot id from `kept admin backup --list` (8 hex or more), or
// `latest`. `--legacy <id>` restores one of the alpha's runs instead (plan Q1, for one
// release), from the configured target or from a run's directory (<dir>/runs/<id>) copied off a
// dead server's disk. Kept restores and verifies; the swap is printed for the superuser (Q13).

type Source = Record<string, string | undefined>;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function restoreCommand(
  source: Source,
  backup: string,
  opts: { legacy?: boolean; tools?: PgTools; restic?: Restic },
  print: (line: string) => void,
): Promise<number> {
  const env = await loadBackupCliEnv(source);
  let report: RestoreReport;
  if (opts.legacy || backup.includes('/')) {
    let target: BackupTarget | null;
    let runId: string;
    if (backup.includes('/') || (await isDir(backup))) {
      const dir = path.resolve(backup);
      if (path.basename(path.dirname(dir)) !== 'runs' || !(await isDir(dir))) {
        throw new CliError(`${backup} is not a backup run's directory (<backup dir>/runs/<id>)`);
      }
      target = new LocalDirTarget(path.dirname(path.dirname(dir)));
      runId = path.basename(dir);
    } else {
      target = legacyTargetOf((await cliBackupSettings(env)).target);
      runId = backup;
      if (!target) {
        throw new CliError(
          'no backup target with old runs is set: pass the run directory (<backup dir>/runs/<id>)',
        );
      }
    }
    report = await runRestore({
      ownerUrl: env.ownerUrl,
      target,
      runId,
      blobs: env.blobs,
      pgTools: opts.tools ?? pgTools(),
      tmpDir: env.tmpDir,
      print,
    });
  } else {
    const settings = await cliBackupSettings(env);
    const opened = await openRepo(settings.target, settings.password, { tmpDir: env.tmpDir });
    try {
      report = await runResticRestore({
        ownerUrl: env.ownerUrl,
        restic: opts.restic ?? env.restic,
        repo: opened.repo,
        snapshot: backup,
        blobs: env.blobs,
        pgTools: opts.tools ?? pgTools(),
        tmpDir: env.tmpDir,
        print,
      });
    } finally {
      await opened.dispose();
    }
  }
  if (!restoreVerified(report)) {
    print('The restore is NOT verified: do not switch Kept to this database.');
    return 1;
  }
  print('Verified: every table and every file matches the backup.');
  for (const line of swapCommands(env.ownerUrl)) print(line);
  print('If the kit holds retired keys, run `kept admin rotate-key --resume` afterwards.');
  return 0;
}
