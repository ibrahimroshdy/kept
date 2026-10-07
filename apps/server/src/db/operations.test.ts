import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '@kept/shared';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, pgError, seedUser } from '../../test/tenancy.js';
import { type Keyring, type MasterKey, open, type Sealed, seal } from '../crypto/envelope.js';
import { BACKUP_SETTINGS_KEY, rotateCiphertexts, SEALED_SETTINGS } from '../secrets/rotate.js';
import { migrationsFolder } from './migrate.js';
import { withScope, withSystem } from './scope.js';

// Step-8 T4 (0090, 0091): backup runs and release history at instance scope, the alpha's backup
// status moved into rows, and the backup setting's sealed fields re-wrapped by rotate-key.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: string; // instance admin
let louis: string; // nobody in particular

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedUser(db, 'ops-ibrahim');
  louis = await seedUser(db, 'ops-louis');
  await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim]);
  await own(
    `INSERT INTO public.backup_runs (kind, status, finished_at, storage_mode, target, snapshot_id)
     VALUES ('nightly', 'ok', now(), 'local', '/mnt/nas/kept', 'a1b2c3d4')`,
  );
  await own(
    `INSERT INTO public.release_history (version, revision, last_migration)
     VALUES ('1.0.0', 'abc1234', '0091_operations_rls')`,
  );
});

describe('backup runs (step 8 T4)', () => {
  it('instance admins read them; nobody else, and nobody but kept_owner writes them', async () => {
    const read = (userId: string) =>
      as(userId, async (c) => (await c.query('SELECT 1 FROM public.backup_runs')).rowCount);
    expect(await read(louis)).toBe(0);
    expect(await read(ibrahim)).toBe(1);
    const insert = as(ibrahim, (c) =>
      c.query(
        `INSERT INTO public.backup_runs (kind, storage_mode, target) VALUES ('manual', 'local', 'x')`,
      ),
    );
    expect((await pgError(insert)).code).toBe('42501');
    const update = as(ibrahim, (c) => c.query(`UPDATE public.backup_runs SET target = 'y'`));
    expect((await pgError(update)).code).toBe('42501');
    expect((await pgError(asSystem((c) => c.query('SELECT 1 FROM public.backup_runs')))).code).toBe(
      '42501',
    );
  });

  it('a running run has no end, a finished one has; a credential-shaped error is refused', async () => {
    const bad = (sql: string) => pgError(own(sql));
    expect(
      (
        await bad(
          `INSERT INTO public.backup_runs (kind, status, storage_mode, target)
           VALUES ('nightly', 'ok', 'local', 'x')`,
        )
      ).constraint,
    ).toBe('backup_runs_finished_chk');
    expect(
      (
        await bad(
          `INSERT INTO public.backup_runs (kind, status, finished_at, storage_mode, target, error)
           VALUES ('nightly', 'failed', now(), 'local', 'x', 'Password: hunter2')`,
        )
      ).constraint,
    ).toBe('backup_runs_error_chk');
  });
});

describe('release history (plan Q9)', () => {
  it("kept_system reads it and stamps last_booted_at only; kept_app's instance admins only read", async () => {
    await asSystem((c) =>
      c.query(`UPDATE public.release_history SET last_booted_at = now() WHERE version = '1.0.0'`),
    );
    const [row] = await own<{ last_booted_at: Date | null }>(
      'SELECT last_booted_at FROM public.release_history',
    );
    expect(row?.last_booted_at).not.toBeNull();
    for (const sql of [
      `UPDATE public.release_history SET last_migration = 'x'`,
      `INSERT INTO public.release_history (version, last_migration) VALUES ('2.0.0', 'x')`,
      'DELETE FROM public.release_history',
    ]) {
      expect((await pgError(asSystem((c) => c.query(sql)))).code).toBe('42501');
    }
    expect(
      await as(
        louis,
        async (c) => (await c.query('SELECT 1 FROM public.release_history')).rowCount,
      ),
    ).toBe(0);
    expect(
      await as(
        ibrahim,
        async (c) => (await c.query('SELECT 1 FROM public.release_history')).rowCount,
      ),
    ).toBe(1);
    expect(
      (
        await pgError(
          own(`INSERT INTO public.release_history (version, last_migration) VALUES ('v1', 'x')`),
        )
      ).constraint,
    ).toBe('release_history_version_chk');
  });
});

describe("the alpha's backup status (0091)", () => {
  it('becomes nightly rows, one per distinct run, and the key goes', async () => {
    const ok = newId();
    const failed = newId();
    const summary = (id: string, status: string, error: string | null) => ({
      id,
      status,
      startedAt: '2026-09-29T02:00:00.000Z',
      finishedAt: '2026-09-29T02:03:00.000Z',
      target: '/mnt/nas/kept',
      bytes: 5000,
      dbBytes: 1200,
      files: 40,
      newFiles: 2,
      missing: 0,
      sameVolume: false,
      error,
    });
    await own(`INSERT INTO public.instance_settings (key, value) VALUES ('backup_status', $1)`, [
      JSON.stringify({
        last: summary(failed, 'failed', 'ENOSPC: no space left on /mnt/nas'),
        lastOk: summary(ok, 'ok', null),
      }),
    ]);
    const sql = await readFile(path.join(migrationsFolder, '0091_operations_rls.sql'), 'utf8');
    const part = sql.slice(sql.indexOf("-- 3. The alpha's backup status"));
    await ownerTx(db, async (c) => {
      for (const statement of part.split('--> statement-breakpoint')) await c.query(statement);
    });
    const rows = await own<{ id: string; status: string; error: string | null; detail: object }>(
      `SELECT id, status, error, detail FROM public.backup_runs WHERE id = ANY ($1) ORDER BY status`,
      [[ok, failed]],
    );
    expect(rows).toEqual([
      { id: failed, status: 'failed', error: 'backup_failed', detail: { from: 'backup_status' } },
      { id: ok, status: 'ok', error: null, detail: { from: 'backup_status' } },
    ]);
    expect(await own(`SELECT 1 FROM public.instance_settings WHERE key = 'backup_status'`)).toEqual(
      [],
    );
  });
});

describe('the backup setting at rest (rotate-key)', () => {
  it('re-wraps its password, S3 secret key and SFTP private key', async () => {
    const v1: MasterKey = { key: randomBytes(32), keyVersion: 1 };
    const v2: MasterKey = { key: randomBytes(32), keyVersion: 2 };
    const fields = SEALED_SETTINGS.filter((s) => s.key === BACKUP_SETTINGS_KEY);
    expect(fields.map((s) => s.field)).toEqual(['password', 's3SecretAccessKey', 'sftpPrivateKey']);
    const value = Object.fromEntries(
      fields.map((s) => [s.field, seal(v1, `secret of ${s.field}`, s.aad)]),
    );
    await own(`INSERT INTO public.instance_settings (key, value) VALUES ('backup', $1)`, [
      JSON.stringify({ target: { kind: 'dir', path: '/mnt/nas' }, ...value }),
    ]);
    const both = new Map([
      [1, v1.key],
      [2, v2.key],
    ]) as Keyring;
    const client = new pg.Client({ connectionString: db.urls.owner });
    await client.connect();
    try {
      await rotateCiphertexts(client, both, v2);
    } finally {
      await client.end();
    }
    const [row] = await own<{ value: Record<string, Sealed> }>(
      `SELECT value FROM public.instance_settings WHERE key = 'backup'`,
    );
    const only2 = new Map([[2, v2.key]]) as Keyring;
    for (const s of fields) {
      expect(row?.value[s.field]?.kv).toBe(2);
      expect(open(only2, row?.value[s.field] as Sealed, s.aad).toString()).toBe(
        `secret of ${s.field}`,
      );
    }
  });
});
