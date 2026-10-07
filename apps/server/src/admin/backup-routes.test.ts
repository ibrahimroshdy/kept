import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  call,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
  type RecordedSchedule,
} from '../../test/people.js';
import { asOwner, ownerTx } from '../../test/tenancy.js';
import { FakeRestic } from '../backup/restic/fake.js';
import type { ResolvedBackupSettings } from '../backup/settings.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import { createLogger } from '../http/logger.js';
import { createBoss } from '../jobs/boss.js';
import { JOB_POLICIES, queueOptions } from '../jobs/policies.js';
import { nightlyBackupTime } from '../jobs/system.js';
import { configureBackupRoutes } from './backup-routes.js';

// Step-8 plan T10: Admin → Backups through the front door, as the web calls it
// (apps/web/src/api/ops/{paths,types}.ts, mock/backup.ts). Instance admins only (404 for anyone
// else); the PUT behind the recovery kit (D193) and https (D181); the environment's locks
// (D186); the password never in a response, a log line, the audit or the idempotency store.

const HTTPS = 'https://kept.example.org';
const PASSWORD = 'correct horse battery staple';
const S3_SECRET = 'the-bucket-secret-access-key';
const keys = fixedSecretKeys(keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }));

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // instance admin
let louis: Person; // not one
const sent: RecordedJob[] = [];
const schedules: RecordedSchedule[] = [];
const logLines: string[] = [];
const restic = new FakeRestic();

const fakeEngine = {
  restic,
  open: async (s: ResolvedBackupSettings) => ({
    repo: {
      location: `fake:${s.description}`,
      env: { RESTIC_PASSWORD: s.password },
      description: s.description,
    },
    dispose: async () => {},
  }),
};

const DIR = { kind: 'dir', path: '/mnt/nas/kept' };
const body = (over: Record<string, unknown> = {}) => ({
  target: DIR,
  password: PASSWORD,
  time: '03:15',
  keep: { daily: 7, weekly: 4, monthly: 6 },
  ...over,
});

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  const sink = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  t = await peopleApp(db, {
    publicUrl: HTTPS,
    sent,
    schedules,
    secretKeys: keys,
    logger: createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, sink),
  });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  await ownerTx(db, (c) =>
    c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]),
  );
});

afterAll(() => configureBackupRoutes({ engine: null, env: process.env }));

beforeEach(async () => {
  sent.length = 0;
  schedules.length = 0;
  configureBackupRoutes({ engine: fakeEngine, env: { KEPT_DATA_DIR: '/data' } });
  await ownerTx(db, async (c) => {
    await c.query(
      `DELETE FROM public.instance_settings
        WHERE key IN ('backup', 'recovery_kit_acknowledged_at', 'recovery_kit_stale_since')`,
    );
    await c.query('DELETE FROM public.backup_runs');
  });
});

const acknowledgeKit = () =>
  ownerTx(db, (c) =>
    c.query(
      `INSERT INTO public.instance_settings (key, value)
       VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT DO NOTHING`,
    ),
  );

const put = (b: unknown, version: number | string = 0, as: Person = ibrahim) =>
  call(t, '/api/v1/admin/backup', {
    method: 'PUT',
    as,
    body: b,
    headers: { 'if-match': String(version) },
  });

const auditOf = (action: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; actor_id: string; diff: unknown }>(
      `SELECT action, actor_id, diff FROM public.audit_events
        WHERE action = $1 AND location_id IS NULL ORDER BY at, id`,
      [action],
    );
    return rows;
  });

describe('who may', () => {
  it('404 on every route for anyone but an instance admin', async () => {
    const routes: [string, 'GET' | 'PUT' | 'POST', unknown?][] = [
      ['/api/v1/admin/backup', 'GET'],
      ['/api/v1/admin/backup', 'PUT', body()],
      ['/api/v1/admin/backup/test', 'POST', {}],
      ['/api/v1/admin/backup/run', 'POST', {}],
      ['/api/v1/admin/backup/runs', 'GET'],
      ['/api/v1/admin/backup/snapshots', 'GET'],
    ];
    for (const [url, method, b] of routes) {
      const res = await call(t, url, {
        as: louis,
        method,
        ...(b !== undefined ? { body: b } : {}),
        headers: { 'if-match': '0' },
      });
      expect([url, method, res.statusCode]).toEqual([url, method, 404]);
    }
  });
});

describe('GET and PUT /api/v1/admin/backup', () => {
  it('starts unconfigured, with the defaults and nothing locked', async () => {
    const res = await call(t, '/api/v1/admin/backup', { as: ibrahim });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: false,
      target: { value: null, locked: false },
      passwordSet: { value: false, locked: false },
      time: { value: '02:30', locked: false },
      keep: {
        daily: { value: 7, locked: false },
        weekly: { value: 4, locked: false },
        monthly: { value: 6, locked: false },
      },
      version: 0,
    });
  });

  it('409 recovery_kit_required until the kit is acknowledged (D193)', async () => {
    const res = await put(body());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('recovery_kit_required');
  });

  // catalogue: PUT /api/v1/admin/backup
  it('saves, seals the secrets, audits without a value, and needs If-Match', async () => {
    await acknowledgeKit();
    expect(
      (await call(t, '/api/v1/admin/backup', { as: ibrahim, method: 'PUT', body: body() }))
        .statusCode,
    ).toBe(428);
    const res = await put(
      body({
        target: {
          kind: 's3',
          endpoint: 'https://s3.example.org',
          region: 'eu-central-1',
          bucket: 'kept-backups',
          prefix: 'kept/',
          forcePathStyle: true,
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: S3_SECRET,
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({
      configured: true,
      target: { value: { kind: 's3', secretAccessKeySet: true }, locked: false },
      passwordSet: { value: true },
      time: { value: '03:15' },
    });
    // The nightly schedule moves to the saved time at once, not at the worker's next start.
    expect(schedules).toEqual([{ name: 'backup', cron: '15 3 * * *' }]);
    expect(res.body).not.toContain(PASSWORD);
    expect(res.body).not.toContain(S3_SECRET);

    // A stale version is refused.
    expect((await put(body(), view.version - 1)).statusCode).toBe(412);

    const audit = await auditOf('instance.backup_settings');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(ibrahim.userId);
    const stored = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT (SELECT value::text FROM public.instance_settings WHERE key = 'backup') AS setting,
                (SELECT coalesce(string_agg(diff::text, ''), '') FROM public.audit_events) AS audit,
                (SELECT coalesce(string_agg(row_to_json(k)::text, ''), '')
                   FROM public.idempotency_keys k) AS idem`,
      );
      return rows[0] as { setting: string; audit: string; idem: string };
    });
    for (const secret of [PASSWORD, S3_SECRET]) {
      expect(stored.setting).not.toContain(secret);
      expect(stored.audit).not.toContain(secret);
      expect(stored.idem).not.toContain(secret);
      expect(logLines.join('')).not.toContain(secret);
    }
    expect(JSON.stringify(audit[0]?.diff)).toContain('s3SecretAccessKey');
    // A kit downloaded before this change no longer holds the backup's credentials (T9).
    const staleSince = await asOwner(
      db,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM public.instance_settings WHERE key = 'recovery_kit_stale_since'`,
          )
        ).rowCount,
    );
    expect(staleSince).toBe(1);
  });

  it('a worker starts the nightly backup at the saved time, unless KEPT_BACKUP_TIME is set', async () => {
    expect(await nightlyBackupTime(db.urls.owner, {})).toBe('02:30');
    await acknowledgeKit();
    expect((await put(body({ target: DIR, time: '04:45' }))).statusCode).toBe(200);
    expect(await nightlyBackupTime(db.urls.owner, {})).toBe('04:45');
    expect(await nightlyBackupTime(db.urls.owner, { KEPT_BACKUP_TIME: '01:10' })).toBe('01:10');
    // Without the owner login it can't read the saved one: the default.
    expect(await nightlyBackupTime(null, {})).toBe('02:30');
  });

  it('400 backup_password_weak under 12 characters', async () => {
    await acknowledgeKit();
    const res = await put(body({ password: 'too short' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('backup_password_weak');
  });

  it('400 setting_locked for a field the environment sets; unchanged it passes', async () => {
    await acknowledgeKit();
    configureBackupRoutes({
      env: { KEPT_DATA_DIR: '/data', KEPT_BACKUP_DIR: '/mnt/nas/kept', KEPT_BACKUP_TIME: '04:00' },
    });
    const view = (await call(t, '/api/v1/admin/backup', { as: ibrahim })).json();
    expect(view).toMatchObject({
      configured: false,
      target: { value: { kind: 'dir', path: '/mnt/nas/kept' }, locked: true },
      time: { value: '04:00', locked: true },
    });
    const moved = await put(
      body({ target: { kind: 'dir', path: '/mnt/elsewhere' }, time: '04:00' }),
    );
    expect([moved.statusCode, moved.json().code]).toEqual([400, 'setting_locked']);
    const ok = await put(body({ time: '04:00' }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().configured).toBe(true);
  });

  it('403 https_required over plain http (D181)', async () => {
    const plain = await peopleApp(db, { secretKeys: keys });
    const admin = await person(plain, db, 'bruce');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]),
    );
    await acknowledgeKit();
    const res = await call(plain, '/api/v1/admin/backup', {
      method: 'PUT',
      as: admin,
      body: body(),
      headers: { 'if-match': '0' },
    });
    expect([res.statusCode, res.json().code]).toEqual([403, 'https_required']);
    await plain.app.close();
  });
});

describe('test, run, runs and snapshots', () => {
  async function configure() {
    await acknowledgeKit();
    expect((await put(body())).statusCode).toBe(200);
  }

  it('409 backup_not_configured before a target and a password are set', async () => {
    for (const [url, method] of [
      ['/api/v1/admin/backup/test', 'POST'],
      ['/api/v1/admin/backup/run', 'POST'],
      ['/api/v1/admin/backup/snapshots', 'GET'],
    ] as const) {
      const res = await call(t, url, {
        as: ibrahim,
        method,
        ...(method === 'POST' ? { body: {} } : {}),
      });
      expect([url, res.statusCode, res.json().code]).toEqual([url, 409, 'backup_not_configured']);
    }
  });

  // catalogue: POST /api/v1/admin/backup/test
  it('tests the repository, makes it on request, and audits the test', async () => {
    await configure();
    const missing = await call(t, '/api/v1/admin/backup/test', { as: ibrahim, body: {} });
    expect(missing.json()).toEqual({ ok: false, initialised: false, error: 'no_repository' });
    const made = await call(t, '/api/v1/admin/backup/test', { as: ibrahim, body: { init: true } });
    expect(made.json()).toEqual({ ok: true, initialised: true });
    const again = await call(t, '/api/v1/admin/backup/test', { as: ibrahim, body: {} });
    expect(again.json()).toEqual({ ok: true, initialised: true });
    // The password went to restic in its environment only.
    expect(restic.calls.every((c) => !JSON.stringify(c).includes(PASSWORD))).toBe(true);
    const audit = await auditOf('instance.backup_test');
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('lists snapshots from restic, cached', async () => {
    await configure();
    const empty = await call(t, '/api/v1/admin/backup/snapshots', { as: ibrahim });
    expect(empty.json()).toMatchObject({ items: [] });
    const before = restic.calls.length;
    await call(t, '/api/v1/admin/backup/snapshots', { as: ibrahim });
    expect(restic.calls.length).toBe(before);
  });

  // catalogue: POST /api/v1/admin/backup/run
  it('Run now sends a manual backup, audited; 409 backup_running while one runs', async () => {
    await configure();
    const res = await call(t, '/api/v1/admin/backup/run', { as: ibrahim, body: {} });
    expect(res.statusCode).toBe(202);
    const run = res.json();
    expect(run).toMatchObject({
      kind: 'manual',
      status: 'running',
      target: 'directory /mnt/nas/kept',
    });
    expect(sent).toEqual([{ name: 'backup', data: { kind: 'manual', runId: run.id } }]);
    expect(await auditOf('instance.backup_run')).toHaveLength(1);

    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.backup_runs (id, kind, storage_mode, target)
         VALUES ($1, 'manual', 'local', 'directory /mnt/nas/kept')`,
        [run.id],
      ),
    );
    const busy = await call(t, '/api/v1/admin/backup/run', { as: ibrahim, body: {} });
    expect([busy.statusCode, busy.json().code]).toEqual([409, 'backup_running']);
  });

  it('refuses a second Run now while the first waits in the queue, before its run row exists', async () => {
    await configure();
    const boss = createBoss({
      connectionString: db.urls.system,
      supervise: false,
      schedule: false,
      max: 1,
    });
    await boss.start();
    try {
      await boss.createQueue('backup', queueOptions(JOB_POLICIES.backup));
      // The first press's job, sent and not yet picked up: no backup_runs row.
      const jobId = await boss.send('backup', { kind: 'manual' });
      const second = await call(t, '/api/v1/admin/backup/run', { as: ibrahim, body: {} });
      expect([second.statusCode, second.json().code]).toEqual([409, 'backup_running']);
      expect(sent).toEqual([]);
      // Once it's done, Run now works again.
      await asOwner(db, (c) =>
        c.query(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [jobId]),
      );
      const again = await call(t, '/api/v1/admin/backup/run', { as: ibrahim, body: {} });
      expect(again.statusCode).toBe(202);
    } finally {
      await asOwner(db, (c) => c.query(`DELETE FROM pgboss.job WHERE name = 'backup'`));
      await boss.stop({ graceful: false });
    }
  });

  it('lists runs newest first, filtered and paged', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.backup_runs (kind, status, started_at, finished_at, storage_mode, target, error)
         SELECT CASE WHEN n % 3 = 0 THEN 'manual' ELSE 'nightly' END,
                CASE WHEN n = 2 THEN 'failed' ELSE 'ok' END,
                now() - make_interval(days => n), now() - make_interval(days => n) + interval '5 minutes',
                'local', 'directory /mnt/nas/kept',
                CASE WHEN n = 2 THEN 'unreachable' END
           FROM generate_series(1, 5) AS n`,
      ),
    );
    const all = (await call(t, '/api/v1/admin/backup/runs?limit=2', { as: ibrahim })).json();
    expect(all.items).toHaveLength(2);
    expect(all.next_cursor).toEqual(expect.any(String));
    const next = (
      await call(t, `/api/v1/admin/backup/runs?limit=2&cursor=${all.next_cursor}`, { as: ibrahim })
    ).json();
    expect(new Date(next.items[0].startedAt) < new Date(all.items[1].startedAt)).toBe(true);
    const failed = (
      await call(t, '/api/v1/admin/backup/runs?status=failed', { as: ibrahim })
    ).json();
    expect(failed.items.map((r: { error: string }) => r.error)).toEqual(['unreachable']);
    const manual = (await call(t, '/api/v1/admin/backup/runs?kind=manual', { as: ibrahim })).json();
    expect(manual.items).toHaveLength(1);
    const q = (await call(t, '/api/v1/admin/backup/runs?q=unreach', { as: ibrahim })).json();
    expect(q.items).toHaveLength(1);
  });
});

describe('GET /api/v1/admin/status (T10)', () => {
  it('reports the backup, the watch and the upgrade note from rows alone', async () => {
    configureBackupRoutes({
      env: {
        KEPT_DATA_DIR: '/data',
        KEPT_BACKUP_DIR: '/mnt/nas/kept',
        KEPT_BACKUP_PASSWORD: PASSWORD,
      },
    });
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.backup_runs (kind, status, started_at, finished_at, storage_mode, target, same_volume)
         VALUES ('nightly', 'ok', now() - interval '40 hours', now() - interval '40 hours', 'local',
                 'directory /mnt/nas/kept', false)`,
      );
      await c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES
           ('disk_status', '{"data": {"usedRatio": 0.5, "freeBytes": 1000}, "backup": null}'),
           ('upgrade_without_snapshot', jsonb_build_object('fromVersion', '1.0.0', 'toVersion', '1.1.0', 'at', now()))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
    });
    // The status route reads the process environment for the locks; this one has none set, so
    // it reports what the rows say.
    const s = (await call(t, '/api/v1/admin/status', { as: ibrahim })).json();
    expect(s.https).toBe(true);
    expect(s.connectors).toEqual({ mcpUrl: `${HTTPS}/mcp`, oauth: 'available' });
    expect(s.backup).toMatchObject({
      lastOk: { kind: 'nightly', status: 'ok', sameVolume: false },
      upgradeWithoutSnapshot: { fromVersion: '1.0.0', toVersion: '1.1.0' },
    });
    expect(s.disk).toEqual({ data: { usedRatio: 0.5, freeBytes: 1000 }, backup: null });
    expect(s.jobs).toEqual({ failedLastDay: 0 });
    expect((await call(t, '/api/v1/admin/status', { as: louis })).statusCode).toBe(403);
    await ownerTx(db, (c) =>
      c.query(
        `DELETE FROM public.instance_settings WHERE key IN ('disk_status', 'upgrade_without_snapshot')`,
      ),
    );
  });
});
