import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { runDrill } from '../../src/backup/drill.js';
import { countRows, ownedTables } from '../../src/backup/manifest.js';
import { runSnapshot, type SnapshotDeps } from '../../src/backup/nightly.js';
import type { PgTools } from '../../src/backup/pg-tools.js';
import { FakeRestic } from '../../src/backup/restic/fake.js';
import { openRepo } from '../../src/backup/restic/repo.js';
import type { Restic } from '../../src/backup/restic/restic.js';
import { ResticCli } from '../../src/backup/restic/run.js';
import {
  RestoreError,
  restoreVerified,
  runResticRestore,
  sampleOf,
} from '../../src/backup/restore.js';
import type { ResolvedBackupSettings } from '../../src/backup/settings.js';
import { runVerify } from '../../src/backup/verify.js';
import { restoreCommand } from '../../src/cli/restore.js';
import type { TestApp } from '../app.js';
import { type TestDb, testDb } from '../db.js';
import { sha256, type TestFiles, testFiles, uniqueJpeg, upload } from '../files.js';
import { type Person, peopleApp, person } from '../people.js';
import { type TestPgTools, testPgTools } from '../pg-tools.js';
import { asOwner } from '../tenancy.js';
import { createLocation, createThing, type Loc } from '../things.js';

// Step 8, T7 (D66, D144, L78): a backup comes back. Snapshot with restic, restore into a new,
// empty database and an empty file store, and check every table by its data digest, not just
// its count; refuse what must be refused; the drill records itself in the live database; verify
// finds a file the S3 bucket lost. restic is the in-memory fake unless KEPT_TEST_RESTIC=1 (then
// the real binary, KEPT_RESTIC_BIN).

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/postgres';
const PASSWORD = 'a restore drill password';
const REAL = process.env.KEPT_TEST_RESTIC === '1';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let db: TestDb;
let files: TestFiles;
let t: TestApp;
let ibrahim: Person;
let garage: Loc;
let pgt: TestPgTools;
let scratch: string;
let photo: Buffer;
let restic: Restic;
const extraDbs: string[] = [];

async function superuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: SUPERUSER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A new database owned by kept_owner: from template1 (the extensions, as setup makes one), or
 * template0 (none). */
async function emptyDatabase(label: string, template = 'template1'): Promise<string> {
  const name = `kept_${label}_${inject('keptRunId')}_${process.env.VITEST_POOL_ID ?? '0'}`;
  await superuser(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name} OWNER kept_owner TEMPLATE ${template}`);
  });
  extraDbs.push(name);
  return `postgres://kept_owner:kept_owner@localhost:5452/${name}`;
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function countsAt(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await countRows(c, await ownedTables(c));
  } finally {
    await c.end();
  }
}

function settingsFor(dir: string): ResolvedBackupSettings {
  return {
    target: { kind: 'dir', path: dir },
    password: PASSWORD,
    time: '02:30',
    keep: { daily: 7, weekly: 4, monthly: 6 },
    description: `directory ${dir}`,
    locked: true,
  };
}

function depsFor(dir: string, more: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    ownerUrl: db.urls.owner,
    restic,
    settings: settingsFor(dir),
    dataDir: files.dir,
    storage: 'local',
    blobs: files.blobs,
    pgTools: pgt.tools,
    ...more,
  };
}

const repoOf = async (dir: string) =>
  (await openRepo({ kind: 'dir', path: dir }, PASSWORD, { tmpDir: files.tmpDir })).repo;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  for (const name of ['Drill', 'Ladder', 'Toolbox'])
    await createThing(t, ibrahim, garage, { name });
  photo = await uniqueJpeg();
  const res = await upload(t, ibrahim, garage.id, photo);
  expect(res.statusCode, res.body).toBe(201);
  const major = await asOwner(db, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT current_setting('server_version_num')::int / 10000 AS n`,
    );
    return rows[0]?.n ?? 0;
  });
  pgt = await testPgTools(major);
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-roundtrip-'));
  restic = REAL
    ? new ResticCli({
        bin: process.env.KEPT_RESTIC_BIN || 'restic',
        cacheDir: path.join(scratch, 'restic-cache'),
      })
    : new FakeRestic();
  process.stderr.write(`round-trip.test.ts: ${pgt.how}${REAL ? ', real restic' : ''}\n`);
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
  await rm(scratch, { recursive: true, force: true });
  await superuser(async (c) => {
    for (const name of extraDbs) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
});

describe('the round trip', () => {
  it('restores every row and file into a new database, identical by data digest', async () => {
    const dir = path.join(scratch, 'roundtrip');
    const run = await runSnapshot(depsFor(dir), { kind: 'nightly' });
    expect(run.status).toBe('ok');
    const live = await countsAt(db.urls.owner);

    const emptyUrl = await emptyDatabase('rt');
    const restored = await testFiles();
    try {
      const lines: string[] = [];
      const report = await runResticRestore({
        ownerUrl: emptyUrl,
        restic,
        repo: await repoOf(dir),
        snapshot: (run.snapshotId as string).slice(0, 8),
        blobs: restored.blobs,
        pgTools: pgt.tools,
        tmpDir: files.tmpDir,
        print: (line) => lines.push(line),
      });
      expect(report.mismatches).toEqual([]);
      expect(report.digestMismatches).toEqual([]);
      expect(report.filesBad).toEqual([]);
      expect(restoreVerified(report)).toBe(true);
      expect(report.filesPut).toBe(report.files);
      expect(lines).toContain('Data digests match the backup, table by table.');

      // Independently: the counts and the photo. The snapshot was taken before the run audited
      // itself; the restore audits itself once: the same number of audit rows as live.
      const after = await countsAt(emptyUrl);
      expect(after['public.audit_events']).toBe(live['public.audit_events']);
      expect(after['public.things']).toBe(live['public.things']);
      const [row] = await query<{ storage_key: string }>(
        emptyUrl,
        'SELECT storage_key FROM public.files WHERE sha256 = $1',
        [sha256(photo)],
      );
      const hash = createHash('sha256');
      for await (const chunk of await restored.blobs.stream(row?.storage_key as string)) {
        hash.update(chunk);
      }
      expect(hash.digest('hex')).toBe(sha256(photo));
    } finally {
      await restored.cleanup();
    }
  });

  it('a restore whose data differs with the same row count fails on its digest', async () => {
    const dir = path.join(scratch, 'changed');
    const run = await runSnapshot(depsFor(dir), { kind: 'manual' });
    // pg_restore that quietly changes one thing's name: the count stays, the data doesn't.
    const lossy: PgTools = {
      ...pgt.tools,
      restore: async (url, file) => {
        await pgt.tools.restore(url, file);
        await query(
          url,
          `UPDATE public.things SET name = name || ' (changed)'
            WHERE id = (SELECT id FROM public.things ORDER BY id LIMIT 1)`,
        );
      },
    };
    const emptyUrl = await emptyDatabase('changed');
    const restored = await testFiles();
    try {
      const report = await runResticRestore({
        ownerUrl: emptyUrl,
        restic,
        repo: await repoOf(dir),
        snapshot: run.snapshotId as string,
        blobs: restored.blobs,
        pgTools: lossy,
        tmpDir: files.tmpDir,
      });
      expect(report.mismatches).toEqual([]);
      expect(report.digestMismatches).toEqual(['public.things']);
      expect(restoreVerified(report)).toBe(false);
    } finally {
      await restored.cleanup();
    }
  });

  it('refuses a database without the extensions before any data, and one that is not empty', async () => {
    const dir = path.join(scratch, 'refuse');
    const run = await runSnapshot(depsFor(dir), { kind: 'manual' });
    const bare = await emptyDatabase('bare', 'template0');
    const restored = await testFiles();
    try {
      const repo = await repoOf(dir);
      const withRepo = (url: string) =>
        runResticRestore({
          ownerUrl: url,
          restic,
          repo,
          snapshot: run.snapshotId as string,
          blobs: restored.blobs,
          pgTools: pgt.tools,
          tmpDir: files.tmpDir,
        });
      await expect(withRepo(bare)).rejects.toThrow(/lacks the extension/);
      expect(Object.keys(await countsAt(bare))).toEqual([]);
      const err = await withRepo(db.urls.owner).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect((err as Error).message).toMatch(/not empty/);
    } finally {
      await restored.cleanup();
    }
  });

  it('kept admin restore verifies, then prints the swap for the superuser', async () => {
    const dir = path.join(scratch, 'cli');
    await runSnapshot(depsFor(dir), { kind: 'manual' });
    const emptyUrl = await emptyDatabase('cli');
    const restoredDir = await mkdtemp(path.join(scratch, 'cli-data-'));
    const lines: string[] = [];
    const code = await restoreCommand(
      {
        KEPT_OWNER_DATABASE_URL: emptyUrl,
        KEPT_DATA_DIR: restoredDir,
        KEPT_BACKUP_DIR: dir,
        KEPT_BACKUP_PASSWORD: PASSWORD,
        KEPT_CONFIG_DIR: path.join(scratch, 'no-config'),
      },
      'latest',
      { tools: pgt.tools, restic },
      (line) => lines.push(line),
    );
    expect(code, lines.join('\n')).toBe(0);
    const name = new URL(emptyUrl).pathname.slice(1);
    expect(lines).toContain(`  ALTER DATABASE ${name} RENAME TO kept;`);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});

describe('the drill', () => {
  it('restores the newest good snapshot into a scratch database and records itself in the live one', async () => {
    const dir = path.join(scratch, 'drill');
    await runSnapshot(depsFor(dir), { kind: 'nightly' });
    await query(
      db.urls.owner,
      `INSERT INTO public.admin_alerts (kind, dedupe_key, payload)
       VALUES ('restore_drill_due', 'restore_drill_due', '{}'::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET resolved_at = NULL`,
    );
    const into = await emptyDatabase('drill');
    const lines: string[] = [];
    const result = await runDrill({
      liveOwnerUrl: db.urls.owner,
      intoUrl: into,
      restic,
      settings: settingsFor(dir),
      storage: 'local',
      blobs: files.blobs,
      pgTools: pgt.tools,
      tmpDir: files.tmpDir,
      print: (line) => lines.push(line),
    });
    expect(result.verified, lines.join('\n')).toBe(true);
    expect(result.run).toMatchObject({ kind: 'drill', status: 'ok', error: null });
    expect(result.run.verifiedAt).not.toBeNull();
    expect(result.report?.filesChecked).toBeGreaterThan(0);
    const liveDrills = await query(
      db.urls.owner,
      `SELECT 1 FROM public.backup_runs WHERE id = $1`,
      [result.run.id],
    );
    expect(liveDrills).toHaveLength(1);
    const scratchDrills = await query(
      into,
      `SELECT 1 FROM public.backup_runs WHERE kind = 'drill'`,
    );
    expect(scratchDrills).toHaveLength(0);
    const [alert] = await query<{ resolved_at: Date | null }>(
      db.urls.owner,
      `SELECT resolved_at FROM public.admin_alerts WHERE dedupe_key = 'restore_drill_due'`,
    );
    expect(alert?.resolved_at).not.toBeNull();
    expect(lines).toContain(`  DROP DATABASE ${new URL(into).pathname.slice(1)};`);
  });

  it('samples spread over the files', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const sample = sampleOf(items, 50);
    expect(sample).toHaveLength(50);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBe(196);
    expect(sampleOf(items, 'all')).toHaveLength(200);
  });
});

describe('verify', () => {
  it('checks the repository and, with S3 file storage, reports a file the bucket lost, by key', async () => {
    const dir = path.join(scratch, 'verify');
    // S3 storage: the files stay in the store and the manifest lists them (D144). The local
    // store stands in for the bucket.
    const run = await runSnapshot(depsFor(dir, { storage: 's3' }), { kind: 'nightly' });
    expect(run.status).toBe('ok');
    const deps = {
      ownerUrl: db.urls.owner,
      restic,
      settings: settingsFor(dir),
      storage: 's3' as const,
      blobs: files.blobs,
      tmpDir: files.tmpDir,
    };
    const good = await runVerify({ ...deps, allFiles: true });
    expect(good.run).toMatchObject({ kind: 'verify', status: 'ok', missing: 0 });
    expect(good.checkOk).toBe(true);

    const [row] = await query<{ storage_key: string }>(
      db.urls.owner,
      'SELECT storage_key FROM public.files WHERE sha256 = $1',
      [sha256(photo)],
    );
    const key = row?.storage_key as string;
    await files.blobs.delete(key);
    const lines: string[] = [];
    const bad = await runVerify({ ...deps, print: (line) => lines.push(line) });
    expect(bad.run).toMatchObject({ status: 'failed', error: 'files_missing', missing: 1 });
    expect(bad.missing).toEqual([key]);
    expect(lines).toContain(`  ${key}`);
  });
});
