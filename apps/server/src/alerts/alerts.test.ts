import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { MAILPIT_SMTP_URL, mailpitSearch, mailpitWait } from '../../test/mailpit.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner, ownerTx } from '../../test/tenancy.js';
import { createBoss, defineJob, registerJobs } from '../jobs/boss.js';
import { systemJobs } from '../jobs/system.js';
import type { Mail } from '../mail/mailer.js';
import { profileLocaleLookup, smtpMailer } from '../mail/transport.js';
import type { ChannelMessage, ChannelSender } from '../reminders/channel.js';
import { runScan } from '../reminders/scan.js';
import { REMINDER_SCAN_KEY } from '../reminders/status.js';
import {
  type AlertDeps,
  checkAdminAlerts,
  FAILED_JOBS_PER_HOUR,
  raiseAlert,
  resolveAlert,
} from './alerts.js';

// Task 25 (D166, D185): admin alerts, deduped, mailed at most once a day, resolved when the
// condition is gone; the alerts list and the status page.

let db: TestDb;
let t: TestApp;
let admin: Person;
let bob: Person;
let sent: Mail[];
let deps: AlertDeps;

const recording = (): AlertDeps['mailer'] => ({
  send: async (m) => {
    sent.push(m);
  },
});

const alertRow = (key: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query(
      `SELECT kind, count, first_at, last_at, resolved_at, mailed_at, payload
         FROM public.admin_alerts WHERE dedupe_key = $1`,
      [key],
    );
    return rows[0];
  });

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  admin = await person(t, db, 'alert-admin');
  bob = await person(t, db, 'alert-bob');
  await ownerTx(db, async (c) => {
    await c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]);
    await c.query(`UPDATE public.user_profiles SET locale = 'ar-EG' WHERE user_id = $1`, [
      admin.userId,
    ]);
  });
  sent = [];
  deps = { pools: db.pools, mailer: recording() };
});

describe('raiseAlert', () => {
  it("also pushes to the instance admins' devices, under the same daily claim (step 4)", async () => {
    const pushes: { userId: string; message: ChannelMessage }[] = [];
    const webpush: ChannelSender = {
      send: async (target, _to, message) => {
        pushes.push({ userId: target.userId, message });
        return { status: 'sent' };
      },
    };
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'webpush')`,
        [admin.userId],
      );
      await c.query(
        `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, 'https://push.example.test/admin', 'k', 'a')`,
        [admin.userId],
      );
    });
    const withPush = { ...deps, channels: { webpush } };
    const first = await raiseAlert(withPush, 'failed_jobs_rising', 'push-1', { failedLastHour: 6 });
    const second = await raiseAlert(withPush, 'failed_jobs_rising', 'push-1', {
      failedLastHour: 7,
    });
    expect(first).toMatchObject({ mailed: 1, pushed: 1 });
    expect(second).toMatchObject({ mailed: 0, pushed: 0 });
    expect(pushes).toEqual([
      {
        userId: admin.userId,
        message: { mode: 'alert', alert: 'failed_jobs_rising', details: { failedLastHour: 6 } },
      },
    ]);
  });

  it('dedupes by key: one row, counted, mailed to the instance admins once', async () => {
    const first = await raiseAlert(deps, 'failed_jobs_rising', 'k1', { failedLastHour: 6 });
    const second = await raiseAlert(deps, 'failed_jobs_rising', 'k1', { failedLastHour: 9 });
    expect(first).toMatchObject({ count: 1, opened: true, mailed: 1 });
    expect(second).toMatchObject({ id: first.id, count: 2, opened: false, mailed: 0 });
    expect(sent).toEqual([
      {
        kind: 'admin-alert',
        to: admin.email,
        locale: 'ar-EG',
        alert: 'failed_jobs_rising',
        details: { failedLastHour: 6 },
      },
    ]);
    const row = await alertRow('k1');
    expect(row).toMatchObject({ kind: 'failed_jobs_rising', count: 2, resolved_at: null });
    // The latest figures win.
    expect(row.payload).toEqual({ failedLastHour: 9 });
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT count(*)::int AS n FROM public.admin_alerts'),
    );
    expect(rows[0].n).toBe(1);
  });

  it('resolves, and a later raise reopens it without mailing again inside 24 hours', async () => {
    await raiseAlert(deps, 'failed_jobs_rising', 'k2', {});
    expect(await resolveAlert(db.pools, 'k2')).toBe(true);
    expect(await resolveAlert(db.pools, 'k2')).toBe(false);
    expect((await alertRow('k2')).resolved_at).toBeInstanceOf(Date);

    const again = await raiseAlert(deps, 'failed_jobs_rising', 'k2', {});
    expect(again).toMatchObject({ count: 1, opened: true, mailed: 0 });
    const row = await alertRow('k2');
    expect(row.resolved_at).toBeNull();
    expect(row.first_at.getTime()).toBe(row.last_at.getTime());
    expect(sent).toHaveLength(1);
  });

  it('mails again once 24 hours have passed since the last mail', async () => {
    await raiseAlert(deps, 'audit_default_partition', 'k3', { rows: 1 });
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.admin_alerts SET mailed_at = now() - interval '25 hours'
          WHERE dedupe_key = 'k3'`,
      ),
    );
    expect((await raiseAlert(deps, 'audit_default_partition', 'k3', { rows: 1 })).mailed).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('gives the mail claim back when every send fails, so the next raise tries again', async () => {
    const failing: AlertDeps = {
      pools: db.pools,
      mailer: {
        send: async () => {
          throw new Error('smtp down');
        },
      },
      log: { error: () => {} },
    };
    expect((await raiseAlert(failing, 'failed_jobs_rising', 'k4', {})).mailed).toBe(0);
    expect((await alertRow('k4')).mailed_at).toBeNull();
    expect((await raiseAlert(deps, 'failed_jobs_rising', 'k4', {})).mailed).toBe(1);
  });

  it('does not mail a disabled instance admin', async () => {
    await ownerTx(db, (c) =>
      c.query('UPDATE auth."user" SET banned = true WHERE id = $1', [admin.userId]),
    );
    expect((await raiseAlert(deps, 'failed_jobs_rising', 'k5', {})).mailed).toBe(0);
    expect(sent).toEqual([]);
  });

  it('reaches the admin through Mailpit once, in their language', async () => {
    const smtp = smtpMailer({
      url: MAILPIT_SMTP_URL,
      from: 'Kept <kept@kept.test>',
      publicUrl: 'http://kept.test',
      localeOf: profileLocaleLookup(db.pools.system),
    });
    try {
      const viaSmtp: AlertDeps = { pools: db.pools, mailer: smtp };
      const key = `mailpit-${randomUUID()}`;
      await raiseAlert(viaSmtp, 'failed_jobs_rising', key, { failedLastHour: 8 });
      await raiseAlert(viaSmtp, 'failed_jobs_rising', key, { failedLastHour: 11 });
      const [msg] = await mailpitWait(admin.email);
      expect(msg?.Subject).toBe('Kept: تتعثّر مهام في الخلفية');
      expect(msg?.Text).toContain('http://kept.test/admin/jobs');
      await new Promise((r) => setTimeout(r, 300));
      expect(await mailpitSearch(admin.email)).toHaveLength(1);
    } finally {
      smtp.close();
    }
  });
});

describe('checkAdminAlerts', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    const d = await testDb();
    boss = createBoss({ connectionString: d.urls.system, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  it('raises failed_jobs_rising above 5 failures in an hour, and resolves it once they age out', async () => {
    const name = `always-fails-${randomUUID()}`;
    await registerJobs(
      boss,
      [
        defineJob({
          name,
          kind: 'system',
          policy: { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 30 },
          handler: async () => {
            throw new Error('nope');
          },
        }),
      ],
      { pools: db.pools, pollingIntervalSeconds: 0.5 },
    );
    const count = async () =>
      (
        await db.pools.system.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = 'failed'`,
          [name],
        )
      ).rows[0]?.n ?? 0;
    for (let i = 0; i < FAILED_JOBS_PER_HOUR; i += 1) await boss.send(name, {});
    const deadline = Date.now() + 20_000;
    while ((await count()) < FAILED_JOBS_PER_HOUR && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Exactly 5 is not "more than 5".
    expect(await checkAdminAlerts(deps)).toEqual({ raised: [], resolved: [] });

    await boss.send(name, {});
    while ((await count()) < FAILED_JOBS_PER_HOUR + 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await boss.offWork(name);
    expect(await checkAdminAlerts(deps)).toEqual({ raised: ['failed_jobs_rising'], resolved: [] });
    expect((await alertRow('failed_jobs_rising')).payload).toEqual({
      failedLastHour: FAILED_JOBS_PER_HOUR + 1,
      byQueue: { [name]: FAILED_JOBS_PER_HOUR + 1 },
    });

    await ownerTx(db, (c) =>
      c.query(
        `UPDATE pgboss.job SET completed_on = now() - interval '2 hours'
          WHERE name = $1 AND state = 'failed'`,
        [name],
      ),
    );
    expect(await checkAdminAlerts(deps)).toEqual({ raised: [], resolved: ['failed_jobs_rising'] });
  });

  it('raises audit_default_partition while the default partition holds rows', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.audit_events (at, actor_type, action, entity_type)
         VALUES ('2099-01-02T03:00:00Z', 'system', 'probe', 'instance')`,
      ),
    );
    expect(await checkAdminAlerts(deps)).toEqual({
      raised: ['audit_default_partition'],
      resolved: [],
    });
    expect((await alertRow('audit_default_partition')).payload).toEqual({
      rows: 1,
      oldest: '2099-01-02T03:00:00.000Z',
      newest: '2099-01-02T03:00:00.000Z',
    });
    expect(sent.map((m) => m.kind === 'admin-alert' && m.alert)).toEqual([
      'audit_default_partition',
    ]);
    await ownerTx(db, (c) => c.query('DELETE FROM public.audit_events_default'));
    expect(await checkAdminAlerts(deps)).toEqual({
      raised: [],
      resolved: ['audit_default_partition'],
    });
  });

  it('raises llm_default_partition while the ledger’s default partition holds rows (T6)', async () => {
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.llm_calls (at, request_id, task, paying_scope, provider_kind, model,
                                       sent, outcome, cost_source)
         VALUES ('2099-01-02T03:00:00Z', 'probe', 'connection_test', 'instance', 'groq', 'm',
                 false, 'over_budget', 'not_sent')`,
      ),
    );
    expect(await checkAdminAlerts(deps)).toEqual({
      raised: ['llm_default_partition'],
      resolved: [],
    });
    expect((await alertRow('llm_default_partition')).payload).toEqual({
      rows: 1,
      oldest: '2099-01-02T03:00:00.000Z',
      newest: '2099-01-02T03:00:00.000Z',
    });
    await ownerTx(db, (c) => c.query('DELETE FROM public.llm_calls_default'));
    expect(await checkAdminAlerts(deps)).toEqual({
      raised: [],
      resolved: ['llm_default_partition'],
    });
  });

  it('raises reminders_not_scanned after 2 hours without a finished scan, and a good pass ends it (T14)', async () => {
    const hour = 3_600_000;
    const lastOk = new Date('2026-10-01T09:00:00Z');
    await ownerTx(db, (c) =>
      c.query(`INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)`, [
        REMINDER_SCAN_KEY,
        JSON.stringify({
          lastRunAt: '2026-10-01T11:45:00.000Z',
          lastOkAt: lastOk.toISOString(),
          occurrences: 0,
          durationMs: 40,
        }),
      ]),
    );
    // Exactly 2 hours is not "more than 2" (the faked clock).
    expect(await checkAdminAlerts(deps, new Date(lastOk.getTime() + 2 * hour))).toEqual({
      raised: [],
      resolved: [],
    });
    const late = new Date(lastOk.getTime() + 2 * hour + 60_000);
    expect(await checkAdminAlerts(deps, late)).toEqual({
      raised: ['reminders_not_scanned'],
      resolved: [],
    });
    expect((await alertRow('reminders_not_scanned')).payload).toEqual({
      lastOkAt: lastOk.toISOString(),
      lastRunAt: '2026-10-01T11:45:00.000Z',
    });
    expect(sent.map((m) => m.kind === 'admin-alert' && m.alert)).toEqual(['reminders_not_scanned']);

    // The next good pass resolves it at once; the check agrees.
    await runScan({ pools: db.pools });
    expect((await alertRow('reminders_not_scanned')).resolved_at).not.toBeNull();
    expect(await checkAdminAlerts(deps)).toEqual({ raised: [], resolved: [] });
  });

  it('never raises reminders_not_scanned before a first pass', async () => {
    expect(await checkAdminAlerts(deps, new Date('2099-01-01T00:00:00Z'))).toEqual({
      raised: [],
      resolved: [],
    });
  });

  it('is scheduled every 15 minutes as a system job', () => {
    const job = systemJobs({
      pools: db.pools,
      log: { info() {}, error() {} },
      mailer: recording(),
      publicUrl: 'http://kept.test',
    }).find((j) => j.name === 'check-admin-alerts');
    expect(job).toMatchObject({ kind: 'system', schedule: '*/15 * * * *' });
  });
});

describe('GET /api/v1/admin/alerts and /status', () => {
  it('lists open alerts to instance admins only, and all of them on request', async () => {
    await raiseAlert(deps, 'failed_jobs_rising', 'open-one', { failedLastHour: 7 });
    await raiseAlert(deps, 'audit_default_partition', 'closed-one', { rows: 2 });
    await resolveAlert(db.pools, 'closed-one');

    expect((await call(t, '/api/v1/admin/alerts', { as: bob })).statusCode).toBe(403);
    const open = await call(t, '/api/v1/admin/alerts', { as: admin });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({
      alerts: [
        {
          id: expect.any(String),
          kind: 'failed_jobs_rising',
          firstAt: expect.any(String),
          lastAt: expect.any(String),
          count: 1,
          resolvedAt: null,
          payload: { failedLastHour: 7 },
        },
      ],
      nextCursor: null,
    });
    const all = await call(t, '/api/v1/admin/alerts?state=all&limit=1', { as: admin });
    const page = all.json() as { alerts: { kind: string }[]; nextCursor: string };
    expect(page.alerts.map((a) => a.kind)).toEqual(['audit_default_partition']);
    const rest = await call(
      t,
      `/api/v1/admin/alerts?state=all&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      { as: admin },
    );
    expect((rest.json() as { alerts: { kind: string }[] }).alerts.map((a) => a.kind)).toEqual([
      'failed_jobs_rising',
    ]);
  });

  it('summarises the instance, and says when mail is not configured', async () => {
    await raiseAlert(deps, 'failed_jobs_rising', 'status-one', {});
    expect((await call(t, '/api/v1/admin/status', { as: bob })).statusCode).toBe(403);
    const res = await call(t, '/api/v1/admin/status', { as: admin });
    expect(res.statusCode).toBe(200);
    // toMatchObject: oidc and embeddings (step 6) have their own tests.
    expect(res.json()).toMatchObject({
      version: expect.any(String),
      dbOk: true,
      alerts: 1,
      recoveryKitAcknowledged: false,
      mail: { configured: false },
      reminders: null,
      // Step 6 (T22): connectors need https; the test app serves http.
      connectors: { mcpUrl: expect.stringMatching(/\/mcp$/), oauth: 'needs_https' },
      // Step 8 (T10): an unconfigured instance, from rows alone.
      release: {
        version: expect.any(String),
        revision: null,
        sourceUrl: null,
        lastMigration: expect.any(String),
        rolledBackFrom: null,
      },
      backup: {
        configured: false,
        locked: expect.any(Boolean),
        target: expect.toBeOneOf([null, expect.any(String)]),
        storageMode: expect.any(String),
        last: null,
        lastOk: null,
        stale: false,
        snapshots: null,
        repositoryBytes: null,
        readableBytes: null,
        sameVolume: null,
        bucketVersioning: expect.any(String),
        lastDrillAt: null,
        drillDue: false,
        lastVerifyAt: null,
        upgradeWithoutSnapshot: null,
      },
      recoveryKit: { acknowledgedAt: null, downloadedAt: null, stale: false },
      disk: { data: null, backup: null },
      updates: expect.objectContaining({ enabled: false, latest: null }),
      jobs: { failedLastDay: 0 },
      https: false,
    });

    // Step 4 (T14): the reminder scan's last pass.
    await runScan({ pools: db.pools });
    const scanned = await call(t, '/api/v1/admin/status', { as: admin });
    expect((scanned.json() as { reminders: unknown }).reminders).toEqual({
      lastRunAt: expect.any(String),
      lastOkAt: expect.any(String),
      occurrences: 0,
      durationMs: expect.any(Number),
    });

    const configured = await peopleApp(db, { mailConfigured: true });
    const again = await call(configured, '/api/v1/admin/status', { as: admin });
    expect(again.json()).toMatchObject({ mail: { configured: true } });
  });
});
