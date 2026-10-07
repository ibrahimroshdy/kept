import type { BackupRun } from '@kept/shared';
import pg from 'pg';
import type { BlobStore } from '../storage/blob-store.js';
import type { PgTools } from './pg-tools.js';
import { openRepo } from './restic/repo.js';
import type { Restic } from './restic/restic.js';
import { type RestoreReport, restoreVerified, runResticRestore } from './restore.js';
import { BACKUP_RUN_COLUMNS, type BackupRunRow, backupRunOf, GOOD_RUN_SQL } from './runs.js';
import type { ResolvedBackupSettings } from './settings.js';

// The restore drill (D66's monthly nudge, L78; step-8 plan T7): `kept admin backup drill --into
// <empty database>`. It restores the newest good snapshot into a scratch database the runbook's
// one superuser command made, compares every table's count and data digest with the manifest,
// checks a sample of 50 files' SHA-256 (every one with --all-files) without putting any back,
// and records a `drill` run in the LIVE database's backup_runs (the owner login), which resolves
// `restore_drill_due`. It ends by printing the command that drops the scratch database.

export const DRILL_SAMPLE = 50;

export type DrillDeps = {
  /** kept_owner on the live database: where the drill is recorded. */
  liveOwnerUrl: string;
  /** kept_owner on the new, empty scratch database. */
  intoUrl: string;
  restic: Restic;
  settings: ResolvedBackupSettings;
  storage: 'local' | 's3';
  /** The live file store (S3 storage: the sample is checked in the bucket). */
  blobs: BlobStore;
  pgTools: PgTools;
  tmpDir: string;
  allFiles?: boolean;
  print?: (line: string) => void;
};

export type DrillResult = { run: BackupRun; report: RestoreReport | null; verified: boolean };

export async function runDrill(deps: DrillDeps): Promise<DrillResult> {
  const print = deps.print ?? (() => {});
  if (sameDatabase(deps.liveOwnerUrl, deps.intoUrl)) {
    throw new Error('the drill restores into a scratch database, never the live one');
  }
  const live = new pg.Client({
    connectionString: deps.liveOwnerUrl,
    application_name: 'kept-drill',
  });
  live.on('error', () => {});
  await live.connect();
  try {
    const { rows: good } = await live.query<{ snapshot_id: string }>(
      `SELECT snapshot_id FROM public.backup_runs
        WHERE kind IN ('nightly', 'manual') AND ${GOOD_RUN_SQL} AND snapshot_id IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
    );
    const snapshot = good[0]?.snapshot_id;
    if (!snapshot) throw new Error('no good backup to drill yet: run `kept admin backup` first');
    const { rows: created } = await live.query<{ id: string }>(
      `INSERT INTO public.backup_runs (kind, status, storage_mode, target, snapshot_id)
       VALUES ('drill', 'running', $1, $2, $3) RETURNING id`,
      [deps.storage, deps.settings.description, snapshot],
    );
    const id = created[0]?.id as string;
    let report: RestoreReport | null = null;
    let error: string | null = null;
    const opened = await openRepo(deps.settings.target, deps.settings.password, {
      tmpDir: deps.tmpDir,
    });
    try {
      report = await runResticRestore({
        ownerUrl: deps.intoUrl,
        restic: deps.restic,
        repo: opened.repo,
        snapshot,
        blobs: deps.blobs,
        pgTools: deps.pgTools,
        tmpDir: deps.tmpDir,
        print,
        checkFiles: deps.allFiles ? 'all' : DRILL_SAMPLE,
      });
      if (!restoreVerified(report)) error = 'drill_mismatch';
    } catch (err) {
      error = 'drill_failed';
      print(`The drill failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await opened.dispose();
    }
    const detail = report
      ? {
          snapshot: snapshot.slice(0, 8),
          tables: report.tables,
          rows: report.rows,
          countMismatches: report.mismatches.length,
          digestMismatches: report.digestMismatches.length,
          filesChecked: report.filesChecked,
          filesBad: report.filesBad.length,
        }
      : { snapshot: snapshot.slice(0, 8) };
    const { rows } = await live.query<BackupRunRow>(
      `UPDATE public.backup_runs
          SET status = $2, finished_at = now(), verified_at = CASE WHEN $3::text IS NULL THEN now() END,
              error = $3, detail = $4::jsonb, missing = $5
        WHERE id = $1 RETURNING ${BACKUP_RUN_COLUMNS}`,
      [id, error ? 'failed' : 'ok', error, JSON.stringify(detail), report?.filesBad.length ?? 0],
    );
    if (!error) {
      // The watch (backup/watch.ts) resolves it on its next pass too; this is immediate.
      await live.query(
        `UPDATE public.admin_alerts SET resolved_at = now()
          WHERE dedupe_key = 'restore_drill_due' AND resolved_at IS NULL`,
      );
    }
    const scratch = decodeURIComponent(new URL(deps.intoUrl).pathname.replace(/^\//, ''));
    print(
      error
        ? 'The drill did NOT verify: the backup could not be restored as it was made.'
        : 'Drill passed: the newest backup restores, and its data matches.',
    );
    print('Drop the scratch database as the database superuser when you are done:');
    print(`  DROP DATABASE ${scratch};`);
    return { run: backupRunOf(rows[0] as BackupRunRow), report, verified: !error };
  } finally {
    await live.end().catch(() => {});
  }
}

function sameDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.hostname === ub.hostname && ua.port === ub.port && ua.pathname === ub.pathname;
}
