import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BackupRun } from '@kept/shared';
import pg from 'pg';
import type { BlobStore } from '../storage/blob-store.js';
import { type BackupManifest, hashBlob, parseManifest } from './manifest.js';
import { openRepo } from './restic/repo.js';
import type { Restic } from './restic/restic.js';
import { resolveSnapshot } from './restore.js';
import { BACKUP_RUN_COLUMNS, type BackupRunRow, backupRunOf, GOOD_RUN_SQL } from './runs.js';
import type { ResolvedBackupSettings } from './settings.js';

// Repository verification (step-8 plan T7; D144): the weekly `backup-verify` job and
// `kept admin backup verify [--read-data <percent>] [--all-files]`.
// - `restic check` (with `--read-data-subset` when asked): the repository's structure, and that
//   share of its data, are sound;
// - with S3 file storage the files are not in the snapshot (D144), so the newest good snapshot's
//   manifest is checked against the bucket: every key there (a HEAD, with its size when the store
//   says it), and one in 20 read whole and its SHA-256 compared (every one with --all-files).
// It records a `verify` run (counts only; the missing keys are ids, printed, never stored).

export const VERIFY_HASH_EVERY = 20;

export type VerifyDeps = {
  ownerUrl: string;
  restic: Restic;
  settings: ResolvedBackupSettings;
  storage: 'local' | 's3';
  blobs: BlobStore;
  tmpDir: string;
  /** `restic check --read-data-subset`, e.g. `5%`. */
  readDataSubset?: string;
  allFiles?: boolean;
  print?: (line: string) => void;
};

export type VerifyReport = {
  run: BackupRun;
  checkOk: boolean;
  checkErrors: string[];
  /** S3 storage: keys in the manifest the bucket lacks, or whose size or SHA-256 differ. */
  missing: string[];
  mismatched: string[];
  filesChecked: number;
  filesHashed: number;
};

/** A blob's size as the S3 store reports it (HEAD), or null when the store won't say. */
async function sizeOf(blobs: BlobStore, key: string): Promise<number | null | 'missing'> {
  const s3 = blobs as Partial<{
    client: { send: (c: unknown) => Promise<unknown> };
    bucket: string;
  }>;
  if (!s3.client || typeof s3.bucket !== 'string') {
    return (await blobs.exists(key)) ? null : 'missing';
  }
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const out = (await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }))) as {
      ContentLength?: number;
    };
    return typeof out.ContentLength === 'number' ? out.ContentLength : null;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as Error).name === 'NotFound') return 'missing';
    throw err;
  }
}

export async function runVerify(deps: VerifyDeps): Promise<VerifyReport> {
  const print = deps.print ?? (() => {});
  const client = new pg.Client({
    connectionString: deps.ownerUrl,
    application_name: 'kept-verify',
  });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO public.backup_runs (kind, status, storage_mode, target)
       VALUES ('verify', 'running', $1, $2) RETURNING id`,
      [deps.storage, deps.settings.description],
    );
    const id = created[0]?.id as string;
    const missing: string[] = [];
    const mismatched: string[] = [];
    let filesChecked = 0;
    let filesHashed = 0;
    let check = { ok: false, errors: [] as string[] };
    let error: string | null = null;
    let snapshot: string | null = null;
    const opened = await openRepo(deps.settings.target, deps.settings.password, {
      tmpDir: deps.tmpDir,
    });
    try {
      check = await deps.restic.check(opened.repo, {
        ...(deps.readDataSubset ? { readDataSubset: deps.readDataSubset } : {}),
      });
      print(
        check.ok
          ? `restic check: the repository is sound${deps.readDataSubset ? ` (${deps.readDataSubset} of its data read)` : ''}.`
          : `restic check found problems: ${check.errors.slice(0, 5).join('; ')}`,
      );
      if (!check.ok) error = 'repository_check_failed';

      if (deps.storage === 's3') {
        const { rows } = await client.query<{ snapshot_id: string }>(
          `SELECT snapshot_id FROM public.backup_runs
            WHERE kind IN ('nightly', 'manual') AND ${GOOD_RUN_SQL} AND snapshot_id IS NOT NULL
            ORDER BY finished_at DESC LIMIT 1`,
        );
        snapshot = rows[0]?.snapshot_id ?? null;
        if (snapshot) {
          const manifest = await manifestOf(deps, opened.repo, snapshot);
          const blobs = manifest.blobs;
          for (const [i, blob] of blobs.entries()) {
            filesChecked += 1;
            const size = await sizeOf(deps.blobs, blob.key);
            if (size === 'missing') {
              missing.push(blob.key);
              continue;
            }
            if (size !== null && size !== blob.bytes) {
              mismatched.push(blob.key);
              continue;
            }
            if (deps.allFiles || i % VERIFY_HASH_EVERY === 0) {
              filesHashed += 1;
              const got = await hashBlob(deps.blobs, blob.key).catch(() => null);
              if (!got) missing.push(blob.key);
              else if (got.sha256 !== blob.sha256) mismatched.push(blob.key);
            }
          }
          print(
            `Files in the bucket: ${filesChecked} checked, ${filesHashed} read whole; ${missing.length} missing, ${mismatched.length} changed.`,
          );
          for (const key of [...missing, ...mismatched].slice(0, 20)) print(`  ${key}`);
          if ((missing.length > 0 || mismatched.length > 0) && !error) error = 'files_missing';
        } else {
          print('No good snapshot yet: the bucket was not checked against a manifest.');
        }
      }
    } catch (err) {
      error = 'verify_failed';
      print(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await opened.dispose();
    }
    const detail = {
      checkErrors: check.errors.length,
      ...(deps.readDataSubset ? { readData: deps.readDataSubset } : {}),
      ...(deps.storage === 's3'
        ? {
            filesChecked,
            filesHashed,
            mismatched: mismatched.length,
            snapshot: snapshot?.slice(0, 8) ?? null,
          }
        : {}),
    };
    const { rows } = await client.query<BackupRunRow>(
      `UPDATE public.backup_runs
          SET status = $2, finished_at = now(), verified_at = CASE WHEN $3::text IS NULL THEN now() END,
              error = $3, missing = $4, detail = $5::jsonb
        WHERE id = $1 RETURNING ${BACKUP_RUN_COLUMNS}`,
      [id, error ? 'failed' : 'ok', error, missing.length, JSON.stringify(detail)],
    );
    return {
      run: backupRunOf(rows[0] as BackupRunRow),
      checkOk: check.ok,
      checkErrors: check.errors,
      missing,
      mismatched,
      filesChecked,
      filesHashed,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/** The manifest inside a snapshot (`/backup/db/manifest.json`), restored alone. */
async function manifestOf(
  deps: Pick<VerifyDeps, 'restic' | 'tmpDir'>,
  repo: Parameters<Restic['restore']>[0],
  snapshot: string,
): Promise<BackupManifest> {
  const id = await resolveSnapshot(deps.restic, repo, snapshot);
  const work = path.join(deps.tmpDir, `verify-${randomUUID().slice(0, 8)}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    await deps.restic.restore(repo, id, {
      target: work,
      include: ['/backup/db/manifest.json'],
    });
    return parseManifest(await readFile(path.join(work, 'backup', 'db', 'manifest.json')));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
