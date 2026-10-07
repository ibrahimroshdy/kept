import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrationsFolder, runMigrations } from './migrate.js';
import {
  bootReleaseGuard,
  DowngradeRefused,
  decideRelease,
  imageJournal,
  UPGRADE_WITHOUT_SNAPSHOT_KEY,
} from './release-guard.js';

// Step-8 plan T8 (Q8, Q9; D66, D82): the snapshot before every upgrade, release history and the
// downgrade guard, on real migrations: a copy of the migrations folder with its journal cut
// short stands for the previous image.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/kept';
const rows = (versions: string[]) =>
  versions.map((version) => ({ version, revision: null, lastMigration: `m-${version}` }));

describe('decideRelease', () => {
  it('allows exactly one release ahead, refuses more or an unknown one', () => {
    expect(decideRelease({ imageVersion: '1.0.0', ahead: false, releases: [] })).toEqual({
      state: 'ok',
    });
    expect(
      decideRelease({ imageVersion: '1.0.0', ahead: true, releases: rows(['1.0.0', '1.1.0']) }),
    ).toEqual({ state: 'rollback', from: '1.1.0' });
    expect(
      decideRelease({
        imageVersion: '1.0.0',
        ahead: true,
        releases: rows(['1.0.0', '1.1.0', '1.2.0']),
      }),
    ).toEqual({ state: 'refused', newest: '1.2.0', why: 'too_far' });
    expect(
      decideRelease({ imageVersion: '1.0.0', ahead: true, releases: rows(['1.0.0']) }),
    ).toEqual({ state: 'refused', newest: '1.0.0', why: 'unknown' });
    // A prerelease of the next version is still the next release.
    expect(
      decideRelease({
        imageVersion: '1.0.0',
        ahead: true,
        releases: rows(['1.0.0', '1.1.0-rc.1']),
      }),
    ).toEqual({ state: 'rollback', from: '1.1.0-rc.1' });
  });
});

let dbName: string;
let ownerUrl: string;
let previous: string; // the migrations folder without its last entry
let older: string; // without its last two

async function superuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: SUPERUSER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function cutJournal(drop: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-migrations-'));
  await cp(migrationsFolder, dir, { recursive: true });
  const file = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, -drop);
  await writeFile(file, JSON.stringify(journal));
  return dir;
}

beforeAll(async () => {
  previous = await cutJournal(1);
  older = await cutJournal(2);
});

afterAll(async () => {
  await rm(previous, { recursive: true, force: true });
  await rm(older, { recursive: true, force: true });
});

beforeEach(async () => {
  dbName = `kept_release_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await superuser((c) => c.query(`CREATE DATABASE ${dbName} OWNER kept_owner`));
  ownerUrl = `postgres://kept_owner:kept_owner@localhost:5452/${dbName}`;
});

afterEach(async () => {
  await superuser(async (c) => {
    await c.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
  });
});

const releases = () =>
  owner(async (c) => {
    const { rows: r } = await c.query<{ version: string; last_migration: string }>(
      'SELECT version, last_migration FROM public.release_history ORDER BY version',
    );
    return r;
  });

describe('kept migrate', () => {
  it('records the release; a fresh database takes no snapshot; a dev build is not recorded', async () => {
    const snapshot = vi.fn(async () => 'taken' as const);
    const dev = await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '0.0.0-dev', revision: null },
      snapshot,
    });
    expect(dev).toMatchObject({ snapshot: 'not_needed', recorded: false });
    expect(snapshot).not.toHaveBeenCalled();
    expect(await releases()).toEqual([]);
    const again = await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '1.0.0', revision: 'abc1234' },
      snapshot,
    });
    expect(again).toMatchObject({ applied: 0, snapshot: 'not_needed', recorded: true });
    expect(await releases()).toEqual([
      { version: '1.0.0', last_migration: imageJournal(previous).at(-1)?.tag },
    ]);
  });

  it('takes the snapshot before any DDL when migrations are pending on a populated database', async () => {
    await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '1.0.0', revision: null },
    });
    let pendingWhenSnapshotRan = -1;
    const outcome = await runMigrations(ownerUrl, {
      release: { version: '1.1.0', revision: null },
      snapshot: async ({ client, fromVersion, toVersion }) => {
        expect([fromVersion, toVersion]).toEqual(['1.0.0', '1.1.0']);
        const { rows: r } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM kept_meta.migrations',
        );
        pendingWhenSnapshotRan = imageJournal().length - (r[0]?.n ?? 0);
        return 'taken';
      },
    });
    expect(pendingWhenSnapshotRan).toBe(1);
    expect(outcome).toMatchObject({ applied: 1, snapshot: 'taken', recorded: true });
    expect((await releases()).map((r) => r.version)).toEqual(['1.0.0', '1.1.0']);
  });

  it('a failing snapshot migrates nothing; no target leaves the status page a note', async () => {
    await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '1.0.0', revision: null },
    });
    const count = () =>
      owner(
        async (c) =>
          (await c.query('SELECT count(*)::int AS n FROM kept_meta.migrations')).rows[0].n,
      );
    const before = await count();
    await expect(
      runMigrations(ownerUrl, {
        release: { version: '1.1.0', revision: null },
        snapshot: async () => {
          throw new Error('the bucket refused the upload');
        },
      }),
    ).rejects.toMatchObject({ code: 'pre_upgrade_snapshot_failed' });
    expect(await count()).toBe(before);

    const lines: string[] = [];
    const outcome = await runMigrations(ownerUrl, {
      release: { version: '1.1.0', revision: null },
      snapshot: async () => 'no_target',
      log: (line) => lines.push(line),
    });
    expect(outcome.snapshot).toBe('no_target');
    expect(lines.join('\n')).toContain('NO BACKUP IS CONFIGURED');
    const note = await owner(
      async (c) =>
        (
          await c.query('SELECT value FROM public.instance_settings WHERE key = $1', [
            UPGRADE_WITHOUT_SNAPSHOT_KEY,
          ])
        ).rows[0]?.value,
    );
    expect(note).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0' });
  });

  it('allows a one-version rollback, refuses two, and the force path audits', async () => {
    await runMigrations(ownerUrl, { folder: older, release: { version: '1.0.0', revision: null } });
    await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '1.1.0', revision: null },
    });
    // 1.0.0 again on a database 1.1.0 migrated: one release back.
    const back = await runMigrations(ownerUrl, {
      folder: older,
      release: { version: '1.0.0', revision: null },
    });
    expect(back.rolledBackFrom).toBe('1.1.0');

    await runMigrations(ownerUrl, { release: { version: '1.2.0', revision: null } });
    await expect(
      runMigrations(ownerUrl, { folder: older, release: { version: '1.0.0', revision: null } }),
    ).rejects.toBeInstanceOf(DowngradeRefused);
    const forced = await runMigrations(ownerUrl, {
      folder: older,
      release: { version: '1.0.0', revision: null },
      allowDowngrade: true,
    });
    expect(forced.rolledBackFrom).toBe('1.2.0');
    const audit = await owner(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS n FROM public.audit_events WHERE action = 'instance.downgrade_forced'`,
          )
        ).rows[0].n,
    );
    expect(audit).toBe(1);
  });
});

describe('the boot guard (kept_system)', () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  const system = () =>
    new pg.Client({
      connectionString: `postgres://kept_system:kept_system@localhost:5452/${dbName}`,
    });

  it('logs a one-version rollback, refuses two, and stamps last_booted_at', async () => {
    await runMigrations(ownerUrl, { folder: older, release: { version: '1.0.0', revision: null } });
    await runMigrations(ownerUrl, {
      folder: previous,
      release: { version: '1.1.0', revision: null },
    });
    const c = system();
    await c.connect();
    try {
      const one = await bootReleaseGuard(c, {
        imageVersion: '1.0.0',
        allowDowngrade: false,
        log,
        folder: older,
      });
      expect(one).toEqual({ rolledBackFrom: '1.1.0', forced: false });
      const booted = await c.query(
        `SELECT last_booted_at FROM public.release_history WHERE version = '1.0.0'`,
      );
      expect(booted.rows[0].last_booted_at).toBeInstanceOf(Date);
      const ok = await bootReleaseGuard(c, {
        imageVersion: '1.1.0',
        allowDowngrade: false,
        log,
        folder: previous,
      });
      expect(ok.rolledBackFrom).toBeNull();
    } finally {
      await c.end();
    }
    await runMigrations(ownerUrl, { release: { version: '1.2.0', revision: null } });
    const d = system();
    await d.connect();
    try {
      await expect(
        bootReleaseGuard(d, { imageVersion: '1.0.0', allowDowngrade: false, log, folder: older }),
      ).rejects.toThrow(/downgrade_refused/);
    } finally {
      await d.end();
    }
  });
});
