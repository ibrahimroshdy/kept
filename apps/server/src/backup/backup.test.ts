import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KEPT_VERSION } from '@kept/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { sha256, type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { type Person, peopleApp, person } from '../../test/people.js';
import { type TestPgTools, testPgTools } from '../../test/pg-tools.js';
import { asOwner } from '../../test/tenancy.js';
import { createLocation, createThing, type Loc } from '../../test/things.js';
import type { AlertDeps } from '../alerts/alerts.js';
import { systemJobs } from '../jobs/system.js';
import { backupCron } from './config.js';
import { EXPORT_SKIPPED, runExport } from './export.js';
import { legacyRuns } from './legacy.js';
import {
  blobToFile,
  countRows,
  extensionsOf,
  hashFile,
  ownedTables,
  parseManifest,
  referencedBlobs,
} from './manifest.js';
import {
  BACKUP_LOCK_KEY,
  BackupRunningError,
  readBackupStatus,
  runSnapshot,
  type SnapshotDeps,
} from './nightly.js';
import type { PgTools } from './pg-tools.js';
import { FakeRestic } from './restic/fake.js';
import type { Restic } from './restic/restic.js';
import { ResticCli } from './restic/run.js';
import { RestoreError, runRestore } from './restore.js';
import type { ResolvedBackupSettings } from './settings.js';
import { LocalDirTarget } from './target.js';

// Step 8, T5: the nightly snapshot on restic (D64, D66, D144; L78, L79), end to end against a
// real database and file store: the dump, the manifest with per-table data digests and every
// blob, the snapshot's contents, retention, the size check, the lock, and secrets that never leave
// the restic child's environment. restic is the in-memory fake (restic/fake.ts) unless
// KEPT_TEST_RESTIC=1, when the real binary (KEPT_RESTIC_BIN) runs the round trip too. Also: the
// alpha's runs stay restorable (`--legacy`, plan Q1) and `kept admin export` is unchanged.
//
// pg_dump/pg_restore must be the server's major version (18): test/pg-tools.ts uses the local
// ones when they match, else the ones inside the dev database's container.

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/postgres';
const PASSWORD = 'a backup password, long enough';
const REAL = process.env.KEPT_TEST_RESTIC === '1';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 180_000 });

let db: TestDb;
let files: TestFiles;
let t: TestApp;
let ibrahim: Person;
let garage: Loc;
let pgt: TestPgTools;
let scratch: string;
let photo: Buffer;
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

/** A new, empty database owned by kept_owner (template1 has the extensions, as setup does). */
async function emptyDatabase(label: string): Promise<string> {
  const name = `kept_${label}_${inject('keptRunId')}_${process.env.VITEST_POOL_ID ?? '0'}`;
  await superuser(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name} OWNER kept_owner`);
  });
  extraDbs.push(name);
  return `postgres://kept_owner:kept_owner@localhost:5452/${name}`;
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

const runsOf = (where = 'true') =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{
      id: string;
      kind: string;
      status: string;
      error: string | null;
      snapshot_id: string | null;
      detail: Record<string, unknown>;
      bucket_versioning_ok: boolean | null;
    }>(
      `SELECT id, kind, status, error, snapshot_id, detail, bucket_versioning_ok
         FROM public.backup_runs WHERE ${where} ORDER BY started_at`,
    );
    return rows;
  });

function settingsFor(dir: string, password = PASSWORD): ResolvedBackupSettings {
  return {
    target: { kind: 'dir', path: dir },
    password,
    time: '02:30',
    keep: { daily: 7, weekly: 4, monthly: 6 },
    description: `directory ${dir}`,
    locked: true,
  };
}

function realRestic(): Restic {
  return new ResticCli({
    bin: process.env.KEPT_RESTIC_BIN || 'restic',
    cacheDir: path.join(scratch, 'restic-cache'),
  });
}

function depsFor(restic: Restic, dir: string, more: Partial<SnapshotDeps> = {}): SnapshotDeps {
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

/** A pg_dump stand-in for the many-run cases: a few bytes, so 40 nights take seconds. */
function tinyDump(bytes = 4096): PgTools {
  return {
    versions: () => pgt.tools.versions(),
    dump: async (_url, out) => writeFile(out, Buffer.alloc(bytes, 7), { mode: 0o600 }),
    restore: () => Promise.reject(new Error('not in these tests')),
  };
}

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
  process.stderr.write(`backup.test.ts: using ${pgt.how}${REAL ? ', real restic' : ''}\n`);
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-backup-'));
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
  await rm(scratch, { recursive: true, force: true });
  await superuser(async (c) => {
    for (const name of extraDbs) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
});

describe('a snapshot', () => {
  it('holds the dump, the manifest with data digests, and every local file; the next adds only new files', async () => {
    const restic = REAL ? realRestic() : new FakeRestic();
    const target = path.join(scratch, 'first');
    const deps = depsFor(restic, target);
    const before = await countsAt(db.urls.owner);
    const run = await runSnapshot(deps, { kind: 'nightly' });
    expect(run).toMatchObject({ kind: 'nightly', status: 'ok', missing: 0, error: null });
    expect(run.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(run.target).toBe(`directory ${target}`);
    // The fake keeps its repository in memory, so the target directory exists only for real.
    expect(run.sameVolume).toBe(REAL ? true : null);
    expect(run.detail).toMatchObject({ snapshots: 1, rows: { 'public.things': 3 } });

    // The stable directory: the manifest describes the dump beside it, from the same snapshot.
    const dbDir = path.join(files.dir, 'backup', 'db');
    const manifest = parseManifest(await readFile(path.join(dbDir, 'manifest.json')));
    expect(manifest).toMatchObject({ version: 2, kind: 'nightly', filesInSnapshot: true });
    // What the database held, with this run's own `running` row, written before the snapshot.
    expect(manifest.tables).toEqual({
      ...before,
      'public.backup_runs': (before['public.backup_runs'] ?? 0) + 1,
    });
    expect(Object.keys(manifest.digests ?? {}).sort()).toEqual(Object.keys(before).sort());
    expect(manifest.database.sha256).toBe((await hashFile(path.join(dbDir, 'db.dump'))).sha256);
    expect(manifest.blobs.map((b) => b.sha256)).toContain(sha256(photo));
    expect((await stat(path.join(dbDir, 'manifest.json'))).mode & 0o777).toBe(0o600);

    // The snapshot: the stable directory and every referenced blob, under / (R1).
    const opened = {
      location: path.join(target, 'restic'),
      env: { RESTIC_PASSWORD: PASSWORD },
      description: '',
    };
    const nodes = (await restic.ls(opened, run.snapshotId as string))
      .filter((n) => n.type === 'file')
      .map((n) => n.path);
    expect(nodes).toEqual(
      expect.arrayContaining(['/backup/db/db.dump', '/backup/db/manifest.json']),
    );
    for (const b of manifest.blobs) expect(nodes).toContain(`/blobs/${b.key}`);
    expect(nodes.some((p) => p.startsWith('/tmp/') || p.startsWith('/.cache/'))).toBe(false);

    // The next run: the dump and manifest change (the audit has grown), no file is new.
    const second = await runSnapshot(deps, { kind: 'nightly' });
    expect(second.filesNew).toBe(0);
    const res = await upload(t, ibrahim, garage.id, await uniqueJpeg());
    expect(res.statusCode, res.body).toBe(201);
    const third = await runSnapshot(deps, { kind: 'nightly' });
    expect(third.filesNew).toBeGreaterThanOrEqual(1);
    // Three the same day: retention keeps the newest and, while its buckets aren't full, the
    // oldest (R1: restic's "oldest … snapshot").
    expect(third.detail).toMatchObject({ snapshots: 2, forgotten: 1 });

    // Audited as system, figures only.
    const audits = await asOwner(db, async (c) => {
      const { rows } = await c.query<{
        actor_type: string;
        diff: Record<string, { after: unknown }>;
      }>(
        `SELECT actor_type, diff FROM public.audit_events WHERE action = 'instance.backup'
          AND diff -> 'backup' ->> 'after' = $1`,
        [run.id],
      );
      return rows;
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_type).toBe('system');
    expect(audits[0]?.diff.status?.after).toBe('ok');

    // The alpha status line reads backup_runs now.
    const status = await asOwner(db, (c) => readBackupStatus(c));
    expect(status.last?.id).toBe(third.id);
    expect(status.lastOk?.id).toBe(third.id);
  });

  it('a database-only run (the pre-upgrade snapshot) holds the dump and manifest alone', async () => {
    const restic = new FakeRestic();
    const target = path.join(scratch, 'dbonly');
    const run = await runSnapshot(depsFor(restic, target), {
      kind: 'pre_upgrade',
      databaseOnly: true,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
    });
    expect(run).toMatchObject({ status: 'ok', fromVersion: '1.0.0', toVersion: '1.1.0' });
    const repo = {
      location: path.join(target, 'restic'),
      env: { RESTIC_PASSWORD: PASSWORD },
      description: '',
    };
    const nodes = (await restic.ls(repo, run.snapshotId as string)).filter(
      (n) => n.type === 'file',
    );
    expect(nodes.map((n) => n.path).sort()).toEqual([
      '/backup/db/db.dump',
      '/backup/db/manifest.json',
    ]);
    const [snap] = await restic.snapshots(repo);
    expect(snap?.tags).toEqual(['kept', 'pre_upgrade', `v${KEPT_VERSION}`]);
  });

  it('with S3 file storage holds no files, and records the bucket versioning', async () => {
    const restic = new FakeRestic();
    const target = path.join(scratch, 's3-storage');
    const run = await runSnapshot(
      depsFor(restic, target, { storage: 's3', bucketVersioning: async () => false }),
      { kind: 'nightly' },
    );
    expect(run).toMatchObject({ status: 'ok', storageMode: 's3', bucketVersioningOk: false });
    const repo = {
      location: path.join(target, 'restic'),
      env: { RESTIC_PASSWORD: PASSWORD },
      description: '',
    };
    const nodes = await restic.ls(repo, run.snapshotId as string);
    expect(nodes.some((n) => n.path.startsWith('/blobs'))).toBe(false);
    const manifest = parseManifest(
      await readFile(path.join(files.dir, 'backup', 'db', 'manifest.json')),
    );
    expect(manifest.filesInSnapshot).toBe(false);
    expect(manifest.blobs.length).toBeGreaterThan(0);
  });
});

describe('the nightly job', () => {
  const jobDeps = {
    log: { info() {}, error() {} },
    mailer: { send: async () => {} },
    publicUrl: 'http://kept.test',
  };
  const backupConfig = (rawEnv: Record<string, string>, restic: Restic) => ({
    time: '04:15',
    ownerUrl: db.urls.owner,
    storage: 'local' as const,
    dataDir: files.dir,
    pgTools: pgt.tools,
    restic,
    rawEnv,
  });

  it('is scheduled at KEPT_BACKUP_TIME in UTC, and without a password does nothing (Q6)', async () => {
    expect(backupCron('02:30')).toBe('30 2 * * *');
    expect(backupCron('23:05')).toBe('5 23 * * *');
    const idle = systemJobs({ ...jobDeps, pools: db.pools }).find((j) => j.name === 'backup');
    expect(idle).toMatchObject({ kind: 'system', schedule: '30 2 * * *' });
    const restic = new FakeRestic();
    const job = systemJobs({
      ...jobDeps,
      pools: db.pools,
      files,
      backup: backupConfig({ KEPT_BACKUP_DIR: path.join(scratch, 'nopass') }, restic),
    }).find((j) => j.name === 'backup');
    expect(job).toMatchObject({ schedule: '15 4 * * *' });
    const before = (await runsOf()).length;
    if (job?.kind === 'system') await job.handler(null);
    expect((await runsOf()).length).toBe(before);
    expect(restic.calls).toEqual([]);
  });

  it('runs a nightly snapshot with the settings it reads, and a manual one when asked', async () => {
    const restic = new FakeRestic();
    const dir = path.join(scratch, 'job');
    const job = systemJobs({
      ...jobDeps,
      pools: db.pools,
      files,
      backup: backupConfig({ KEPT_BACKUP_DIR: dir, KEPT_BACKUP_PASSWORD: PASSWORD }, restic),
    }).find((j) => j.name === 'backup');
    if (job?.kind !== 'system') throw new Error('no backup job');
    await job.handler(null);
    await job.handler({ kind: 'manual' });
    const rows = await runsOf(`target = 'directory ${dir}'`);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['nightly', 'ok'],
      ['manual', 'ok'],
    ]);
  });
});

describe('retention', () => {
  it('keeps 7 daily, 4 weekly and 6 monthly of the nightly series; pre-upgrade snapshots their last 3', async () => {
    // Forty faked days are the contract's (test/restic-contract.ts, the same forget); here, nine
    // nights through the whole run. 1–9 January 2026: the last 7 days, and while the weekly and
    // monthly buckets aren't full, the oldest (R1): every night but the 2nd.
    const restic = new FakeRestic();
    const target = path.join(scratch, 'nights');
    const deps = depsFor(restic, target, { pgTools: tinyDump() });
    for (let day = 0; day < 9; day++) {
      // An upgrade on the 5th: the version tag changes, the series doesn't (forget groups by
      // host within the kind's tags, so a release never starts a group of its own).
      await runSnapshot(
        { ...deps, version: day < 4 ? '1.0.0' : '1.1.0' },
        {
          kind: 'nightly',
          time: new Date(Date.UTC(2026, 0, 1 + day, 2, 30)),
          // The first sets the size baseline for the stand-in dump.
          ...(day === 0 ? { acceptSize: true } : {}),
        },
      );
    }
    for (let i = 0; i < 4; i++) {
      await runSnapshot(deps, {
        kind: 'pre_upgrade',
        databaseOnly: true,
        time: new Date(Date.UTC(2026, 0, 2 + i, 1)),
      });
    }
    const repo = {
      location: path.join(target, 'restic'),
      env: { RESTIC_PASSWORD: PASSWORD },
      description: '',
    };
    const nightly = await restic.snapshots(repo, { tags: ['kept', 'nightly'] });
    expect(nightly.map((s) => s.time.toISOString().slice(0, 10)).sort()).toEqual([
      '2026-01-01',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ]);
    const upgrades = await restic.snapshots(repo, { tags: ['kept', 'pre_upgrade'] });
    expect(upgrades.map((s) => s.time.toISOString().slice(0, 10))).toEqual([
      '2026-01-05',
      '2026-01-04',
      '2026-01-03',
    ]);
    expect(restic.calls.filter((c) => c.command === 'forget')).toHaveLength(13);
  });

  it('a suspiciously small dump is a warning: its retention is skipped and the admins are told', async () => {
    const restic = new FakeRestic();
    const target = path.join(scratch, 'shrunk');
    const alerts: AlertDeps = { pools: db.pools, mailer: { send: async () => {} } };
    const big = await runSnapshot(depsFor(restic, target, { pgTools: tinyDump(4 << 20), alerts }), {
      kind: 'nightly',
    });
    expect(big.status).toBe('ok');
    const forgetsBefore = restic.calls.filter((c) => c.command === 'forget').length;
    const small = await runSnapshot(
      depsFor(restic, target, { pgTools: tinyDump(1 << 20), alerts }),
      {
        kind: 'nightly',
      },
    );
    expect(small).toMatchObject({ status: 'warning', error: 'backup_suspicious_size' });
    expect(small.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(small.detail).toMatchObject({
      retentionSkipped: true,
      shrank: [`dump ${4 << 20} → ${1 << 20}`],
    });
    expect(restic.calls.filter((c) => c.command === 'forget').length).toBe(forgetsBefore);
    const alert = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT resolved_at, payload FROM public.admin_alerts WHERE dedupe_key = 'backup_suspicious_size'`,
      );
      return rows[0];
    });
    expect(alert).toMatchObject({ resolved_at: null });

    // Still small the next night: still suspect against the last good one.
    const again = await runSnapshot(
      depsFor(restic, target, { pgTools: tinyDump(1 << 20), alerts }),
      {
        kind: 'nightly',
      },
    );
    expect(again.error).toBe('backup_suspicious_size');
    // Accepted: the new baseline, retention runs, the alert resolves.
    const accepted = await runSnapshot(
      depsFor(restic, target, { pgTools: tinyDump(1 << 20), alerts }),
      {
        kind: 'manual',
        acceptSize: true,
      },
    );
    expect(accepted).toMatchObject({ status: 'ok', error: null });
    const resolved = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT resolved_at FROM public.admin_alerts WHERE dedupe_key = 'backup_suspicious_size'`,
      );
      return rows[0];
    });
    expect(resolved?.resolved_at).not.toBeNull();
    const next = await runSnapshot(
      depsFor(restic, target, { pgTools: tinyDump(1 << 20), alerts }),
      {
        kind: 'nightly',
      },
    );
    expect(next.status).toBe('ok');
  });
});

describe('one run at a time', () => {
  it('a second run while one holds the lock is refused and records nothing', async () => {
    const holder = new pg.Client({ connectionString: db.urls.owner });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [BACKUP_LOCK_KEY]);
      const before = (await runsOf()).length;
      await expect(
        runSnapshot(depsFor(new FakeRestic(), path.join(scratch, 'locked')), { kind: 'manual' }),
      ).rejects.toBeInstanceOf(BackupRunningError);
      expect((await runsOf()).length).toBe(before);
    } finally {
      await holder.end();
    }
  });
});

describe('secrets', () => {
  it('never reach argv, a log line, backup_runs, the audit or an error, even when restic echoes the password', async () => {
    // A stand-in restic that prints the password it was given (from its environment) on stderr,
    // as an exit_error, and fails: the wrapper must scrub it.
    const bin = path.join(scratch, 'echo-restic.sh');
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '{"message_type":"exit_error","code":1,"message":"Fatal: no luck with %s"}\\n' "$RESTIC_PASSWORD" >&2\nexit 1\n`,
    );
    await chmod(bin, 0o755);
    const argvs: string[][] = [];
    const envNames: string[][] = [];
    const spy = ((
      cmd: string,
      args: readonly string[],
      options: { env?: Record<string, string> },
    ) => {
      argvs.push([cmd, ...args]);
      envNames.push(Object.keys(options.env ?? {}));
      return spawn(cmd, args, options);
    }) as unknown as typeof spawn;
    const logs: string[] = [];
    const log = {
      info: (obj: object, msg: string) => logs.push(JSON.stringify({ ...obj, msg })),
      error: (obj: object, msg: string) => logs.push(JSON.stringify({ ...obj, msg })),
    };
    const restic = new ResticCli({
      bin,
      spawn: spy,
      onLog: (line) => logs.push(line),
    });
    const alerts: AlertDeps = { pools: db.pools, mailer: { send: async () => {} } };
    const err = await runSnapshot(
      depsFor(restic, path.join(scratch, 'echo'), { log, alerts, pgTools: tinyDump() }),
      { kind: 'manual' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain(PASSWORD);
    expect(argvs.length).toBeGreaterThan(0);
    expect(JSON.stringify(argvs)).not.toContain(PASSWORD);
    expect(envNames.every((names) => names.includes('RESTIC_PASSWORD'))).toBe(true);
    expect(envNames.flat().some((n) => n.startsWith('KEPT_') || n === 'DATABASE_URL')).toBe(false);
    expect(logs.join('\n')).not.toContain(PASSWORD);
    const [row] = await runsOf(`target = 'directory ${path.join(scratch, 'echo')}'`);
    expect(row).toMatchObject({ status: 'failed', error: 'restic_failed' });
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const audit = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT diff FROM public.audit_events WHERE action = 'instance.backup'
          AND diff -> 'backup' ->> 'after' = $1`,
        [row?.id],
      );
      return rows;
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    const alert = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT payload FROM public.admin_alerts WHERE dedupe_key = 'backup_failed'`,
      );
      return rows[0];
    });
    expect(alert?.payload).toMatchObject({ error: 'restic_failed' });
    expect(JSON.stringify(alert)).not.toContain(PASSWORD);
  });
});

// ---------------------------------------------------------------------------------------------
// The alpha's runs (T31c): still restorable for one release (plan Q1), never written again.

/** An alpha run, written the way T31c's nightly did: runs/<id>/{db.dump,manifest.json}, blobs/. */
async function alphaRun(target: LocalDirTarget): Promise<string> {
  const id = `20260927T023000Z-${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
  const work = await mkdtemp(path.join(scratch, 'alpha-'));
  const dump = path.join(work, 'db.dump');
  await pgt.tools.dump(db.urls.owner, dump);
  const facts = await asOwner(db, async (c) => ({
    tables: await countRows(c, await ownedTables(c)),
    referenced: await referencedBlobs(c),
    extensions: await extensionsOf(c),
    server: (await c.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]
      ?.v,
  }));
  const blobs = [];
  for (const { key } of facts.referenced) {
    const tmp = path.join(work, 'blob');
    const copied = await blobToFile(files.blobs, key, tmp);
    await target.put(`blobs/${key}`, tmp);
    blobs.push({ key, ...copied });
  }
  const db1 = await hashFile(dump);
  await target.put(`runs/${id}/db.dump`, dump);
  const manifestFile = path.join(work, 'manifest.json');
  await writeFile(
    manifestFile,
    JSON.stringify({
      format: 'kept-backup',
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      keptVersion: KEPT_VERSION,
      postgres: { server: facts.server, dumpMajor: (await pgt.tools.versions()).dump },
      extensions: facts.extensions,
      database: { file: 'db.dump', bytes: db1.bytes, sha256: db1.sha256 },
      tables: facts.tables,
      storage: 'local',
      blobs,
      missing: [],
    }),
  );
  await target.put(`runs/${id}/manifest.json`, manifestFile);
  await rm(work, { recursive: true, force: true });
  return id;
}

describe('the alpha runs (--legacy)', () => {
  it('are listed and restore into an empty database with every row and file', async () => {
    const target = new LocalDirTarget(path.join(scratch, 'alpha'));
    const id = await alphaRun(target);
    expect(await legacyRuns(target)).toEqual([id]);
    const before = await countsAt(db.urls.owner);
    const emptyUrl = await emptyDatabase('legacy');
    const restored = await testFiles();
    try {
      const report = await runRestore({
        ownerUrl: emptyUrl,
        target,
        runId: id,
        blobs: restored.blobs,
        pgTools: pgt.tools,
        tmpDir: restored.tmpDir,
      });
      expect(report.mismatches).toEqual([]);
      const after = await countsAt(emptyUrl);
      expect(after['public.things']).toBe(before['public.things']);
      expect(report.filesPut).toBe(report.files);
    } finally {
      await restored.cleanup();
    }
  });

  it('refuse a database that is not empty', async () => {
    const target = new LocalDirTarget(path.join(scratch, 'alpha-refuse'));
    const id = await alphaRun(target);
    const err = await runRestore({
      ownerUrl: db.urls.owner,
      target,
      runId: id,
      blobs: files.blobs,
      pgTools: pgt.tools,
      tmpDir: files.tmpDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as Error).message).toMatch(/not empty/);
  });
});

describe('kept admin export', () => {
  it('writes every row as raw JSON and every file, 0600, and refuses a non-empty directory', async () => {
    const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
    const out = path.join(scratch, 'export');
    const before = await countsAt(db.urls.owner);
    const report = await runExport({ ownerUrl: db.urls.owner, outDir: out, blobs: files.blobs });

    expect(await modeOf(out)).toBe(0o700);
    expect(await modeOf(path.join(out, 'manifest.json'))).toBe(0o600);
    for (const [table, rows] of Object.entries(report.tables)) {
      const file = path.join(out, 'tables', `${table}.ndjson`);
      expect(await modeOf(file)).toBe(0o600);
      const text = await readFile(file, 'utf8');
      expect(text === '' ? 0 : text.trimEnd().split('\n').length, table).toBe(rows);
      expect(rows, table).toBe(before[table]);
    }
    for (const skipped of EXPORT_SKIPPED) expect(report.tables[skipped]).toBeUndefined();
    const original = report.files.find((f) => f.sha256 === sha256(photo));
    expect(original).toBeDefined();
    const copy = await readFile(path.join(out, 'files', original?.key as string));
    expect(sha256(copy)).toBe(sha256(photo));
    await expect(
      runExport({ ownerUrl: db.urls.owner, outDir: out, blobs: files.blobs }),
    ).rejects.toThrow(/not empty/);
    expect((await readdir(out)).sort()).toEqual(['files', 'manifest.json', 'tables']);
  });
});
