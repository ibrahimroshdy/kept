import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner, ownerTx, seedTenant, seedUser } from '../../test/tenancy.js';
import { ScopeError, withScope, withSystem } from '../db/scope.js';
import {
  createBoss,
  defineJob,
  registerJobs,
  sendInTx,
  sendTenantJob,
  type TenantJobContext,
} from './boss.js';
import { jobAdmin } from './failed.js';
import {
  AUDIT_MONTHS_AHEAD,
  aiMaintenance,
  ensureAuditPartitions,
  pruneStaleRows,
} from './maintenance.js';
import { JOB_POLICIES } from './policies.js';
import { bossQueue, createRequestQueues, REQUEST_QUEUES, TENANT_REQUEST_QUEUES } from './queue.js';
import { systemJobs } from './system.js';

// Task 24 (D166, §3.1b, §7.1): the job registry, policies, schedules and the failed-jobs admin.

let db: TestDb;
let boss: PgBoss;

const FAST = { pollingIntervalSeconds: 0.5 };
const NO_RETRY = { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 30 };

async function until<T>(probe: () => Promise<T | null | undefined | false>, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function jobState(id: string): Promise<string | null> {
  const { rows } = await db.pools.system.query<{ state: string }>(
    'SELECT state FROM pgboss.job WHERE id = $1',
    [id],
  );
  return rows[0]?.state ?? null;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  boss = createBoss({ connectionString: db.urls.system, supervise: false, schedule: true, max: 4 });
  boss.on('error', () => {});
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

describe('defineJob', () => {
  it('refuses a scheduled tenant job, a bad name and a bad policy', () => {
    const handler = async () => {};
    expect(() =>
      defineJob({
        name: 'x-tenant',
        kind: 'tenant',
        policy: NO_RETRY,
        handler,
        ...{ schedule: '* * * * *' },
      }),
    ).toThrow(/can't be scheduled/);
    expect(() =>
      defineJob({ name: 'Bad Name', kind: 'system', policy: NO_RETRY, handler }),
    ).toThrow(/lowercase/);
    expect(() =>
      defineJob({
        name: 'bad-policy',
        kind: 'system',
        policy: { ...NO_RETRY, expireInSeconds: 0 },
        handler,
      }),
    ).toThrow(/policy/);
  });
});

describe('a tenant job', () => {
  it("re-assumes the sender's scope and sees only that user's rows", async () => {
    const a = await seedTenant(db, 'tenant-job-a');
    const b = await seedTenant(db, 'tenant-job-b');
    const name = `tenant-probe-${randomUUID()}`;
    const seen: { ctx: TenantJobContext; locations: string[] }[] = [];
    const job = defineJob({
      name,
      kind: 'tenant',
      policy: NO_RETRY,
      handler: async (ctx) => {
        const { rows } = await ctx.client.query<{ id: string }>('SELECT id FROM public.locations');
        seen.push({ ctx, locations: rows.map((r) => r.id) });
      },
    });
    await registerJobs(boss, [job], { pools: db.pools, ...FAST });

    await withScope(db.pools.app, { userId: a.userId, mfa: false }, (_tx, client) =>
      // Whatever the sender says, the scope comes from the transaction.
      sendTenantJob(boss, client, name, { note: 'hello', userId: b.userId }),
    );

    const got = await until(async () => seen[0]);
    expect(got.ctx.scope).toEqual({ userId: a.userId, mfa: false });
    expect(got.ctx.data).toEqual({ note: 'hello', userId: b.userId });
    expect(got.locations).toEqual([a.locationId]);
    await boss.offWork(name);
  });

  it('cannot be sent from outside a user scope', async () => {
    const name = `tenant-nobody-${randomUUID()}`;
    await boss.createQueue(name);
    await expect(
      withSystem(db.pools.system, (_tx, client) => sendTenantJob(boss, client, name, {})),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('fails for good when its payload names no valid scope', async () => {
    const name = `tenant-forged-${randomUUID()}`;
    let ran = false;
    const job = defineJob({
      name,
      kind: 'tenant',
      policy: NO_RETRY,
      handler: async () => {
        ran = true;
      },
    });
    await registerJobs(boss, [job], { pools: db.pools, ...FAST });
    const id = (await boss.send(name, { userId: 'not-a-uuid', mfa: false, data: {} })) as string;
    await until(async () => (await jobState(id)) === 'failed');
    expect(ran).toBe(false);
    await boss.offWork(name);
  });
});

describe('policies and schedules', () => {
  it('schedules the maintenance jobs in UTC and gives every queue its policy', async () => {
    const jobs = systemJobs({
      pools: db.pools,
      log: { info() {}, error() {} },
      mailer: { send: async () => {} },
      publicUrl: 'http://kept.test',
    });
    const scheduled = Object.fromEntries(
      jobs.flatMap((j) => (j.kind === 'system' && j.schedule ? [[j.name, j.schedule]] : [])),
    );
    expect(scheduled).toMatchObject({
      'repair-orphans': '17 * * * *',
      'expire-memberships': '*/15 * * * *',
      'audit-partitions': '5 3 * * *',
      'prune-stale-rows': '35 3 * * *',
      'ai-maintenance': '45 3 * * *',
      'ai-rollover': '5 0 * * *',
      // Step 4 (Q35): last month's AI summary, early on the 1st (UTC, as the ledger's months).
      'ai-summary': '20 0 1 * *',
      'purge-reports': '41 * * * *',
      'reminder-scan': '*/15 * * * *',
      'reminder-digest': '*/15 * * * *',
      'purge-exports': '23 * * * *',
      'prune-imports': '53 3 * * *',
      'assistant-maintenance': '15 3 * * *',
      'embed-backfill': '30 * * * *',
      'ops-watch': '37 * * * *',
      // Hourly; it asks GitHub once a day at this instance's own hour (updates/job.ts).
      'update-check': '7 * * * *',
      'backup-verify': '10 4 * * 0',
    });

    // A queue made earlier without a policy is brought up to date.
    await boss.createQueue('prune-stale-rows');
    await registerJobs(boss, jobs, { pools: db.pools });
    try {
      for (const [name, cron] of Object.entries(scheduled)) {
        const schedules = await boss.getSchedules(name);
        expect(schedules).toEqual([expect.objectContaining({ name, cron, timezone: 'UTC' })]);
      }
      for (const job of jobs) {
        const queue = await boss.getQueue(job.name);
        expect(queue, job.name).toMatchObject({
          retryLimit: job.policy.retryLimit,
          retryDelay: job.policy.retryDelay,
          retryBackoff: job.policy.retryBackoff,
          expireInSeconds: job.policy.expireInSeconds,
        });
      }
    } finally {
      for (const job of jobs) await boss.offWork(job.name);
      for (const name of Object.keys(scheduled)) await boss.unschedule(name);
    }
  });

  it('gives the step-3 jobs the §3.1b policies', () => {
    expect(JOB_POLICIES.extract).toEqual({
      retryLimit: 2,
      retryDelay: 20,
      retryBackoff: true,
      expireInSeconds: 90,
    });
    expect(JOB_POLICIES['import-csv']).toEqual({
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 7200,
    });
    expect(JOB_POLICIES['pdf-text']).toEqual({
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 60,
    });
    expect(JOB_POLICIES['ai-maintenance']).toEqual(JOB_POLICIES['prune-stale-rows']);
    expect(TENANT_REQUEST_QUEUES).toEqual([
      'extract',
      'import-csv',
      'pdf-text',
      'report',
      'claim-pack',
      'export',
      'import-homebox',
      'import-kept',
      'enrich-aliases',
      'assistant-turn',
      'embed-thing',
    ]);
    expect(JOB_POLICIES.report).toEqual({
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 180,
    });
  });

  it('gives the step-4 jobs the §3.1b policies (plan T2)', () => {
    expect(JOB_POLICIES['reminder-scan']).toEqual({
      retryLimit: 4,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 60,
    });
    expect(JOB_POLICIES['reminder-deliver']).toEqual(JOB_POLICIES['send-invite-mail']);
    expect(JOB_POLICIES['reminder-digest']).toEqual({
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 120,
    });
    expect(JOB_POLICIES['claim-pack']).toEqual({ ...JOB_POLICIES.report, expireInSeconds: 1800 });
    expect(JOB_POLICIES['purge-exports']).toEqual(JOB_POLICIES['prune-stale-rows']);
    expect(REQUEST_QUEUES).toEqual(expect.arrayContaining(['reminder-deliver', 'channel-webhook']));

    // §3.1b, §2.6: ten attempts over about 24 hours. pg-boss 12.34.0 waits
    // retryDelay × 2^c × (1 + U) after a failure at retry count c, U uniform in [0, 1).
    const hook = JOB_POLICIES['channel-webhook'];
    expect(hook.retryLimit + 1).toBe(10);
    expect(hook.retryBackoff).toBe(true);
    const spans = Array.from({ length: hook.retryLimit }, (_, c) => hook.retryDelay * 2 ** c);
    const soonest = spans.reduce((a, b) => a + b, 0);
    const hours = (s: number) => s / 3600;
    expect(hours(soonest * 1.5)).toBeGreaterThan(23.5);
    expect(hours(soonest * 1.5)).toBeLessThan(24.5);
    expect(hours(soonest)).toBeGreaterThan(12);
    expect(hours(soonest * 2)).toBeLessThan(36);
  });

  it('gives the step-7 jobs the §3.1b policies (plan T2)', () => {
    // "import/export: 1 attempt, 2 h, resumable".
    for (const name of ['export', 'import-homebox', 'import-kept'] as const) {
      expect(JOB_POLICIES[name]).toEqual(JOB_POLICIES['import-csv']);
    }
    expect(JOB_POLICIES['enrich-aliases']).toEqual(JOB_POLICIES.extract);
    expect(JOB_POLICIES['prune-imports']).toEqual(JOB_POLICIES['prune-stale-rows']);
  });

  it('gives the step-6 jobs their policies (plan T2)', () => {
    expect(JOB_POLICIES['assistant-turn']).toEqual({
      retryLimit: 1,
      retryDelay: 5,
      retryBackoff: false,
      expireInSeconds: 200,
    });
    expect(JOB_POLICIES['embed-thing']).toEqual({
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 90,
    });
    expect(JOB_POLICIES['embed-backfill']).toEqual({
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 3600,
    });
    expect(JOB_POLICIES['webhook-fanout']).toMatchObject({ retryLimit: 2, expireInSeconds: 60 });
    // 10 attempts over about 24 hours, the same schedule as step 4's channel webhook.
    expect(JOB_POLICIES['webhook-deliver']).toEqual(JOB_POLICIES['channel-webhook']);
    expect(JOB_POLICIES['assistant-maintenance']).toEqual(JOB_POLICIES['prune-stale-rows']);
    // The fan-out reads hooks and writes deliveries as kept_system: a system job a request sends.
    expect(REQUEST_QUEUES).toContain('webhook-fanout');
    expect(TENANT_REQUEST_QUEUES).not.toContain('webhook-fanout');
  });

  it('gives the step-8 jobs their policies (plan T2)', () => {
    expect(JOB_POLICIES['ops-watch']).toEqual(JOB_POLICIES['prune-stale-rows']);
    // §3.1b "backup: 2 attempts, 4 h".
    expect(JOB_POLICIES['backup-verify']).toEqual(JOB_POLICIES.backup);
    // A rate limit or a network failure waits for the next day (D65).
    expect(JOB_POLICIES['update-check']).toMatchObject({ retryLimit: 0 });
  });

  it("creates the request queues with their policies, and a sent job carries the queue's", async () => {
    await createRequestQueues(boss);
    for (const name of [...REQUEST_QUEUES, ...TENANT_REQUEST_QUEUES]) {
      expect(await boss.getQueue(name)).toMatchObject({
        retryLimit: JOB_POLICIES[name].retryLimit,
        expireInSeconds: JOB_POLICIES[name].expireInSeconds,
      });
    }
    const a = await seedTenant(db, 'request-policy');
    const id = await withScope(db.pools.app, { userId: a.userId, mfa: false }, (_tx, client) =>
      sendInTx(boss, client, 'send-invite-mail', { inviteId: randomUUID() }),
    );
    const { rows } = await db.pools.system.query(
      'SELECT retry_limit, expire_seconds FROM pgboss.job WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({
      retry_limit: JOB_POLICIES['send-invite-mail'].retryLimit,
      expire_seconds: JOB_POLICIES['send-invite-mail'].expireInSeconds,
    });
    await boss.deleteJob('send-invite-mail', id as string);
  });
});

describe('JobQueue.sendTenant', () => {
  it("sends a tenant job carrying the transaction's scope, with the queue's policy", async () => {
    await createRequestQueues(boss);
    const a = await seedTenant(db, 'send-tenant-a');
    const b = await seedTenant(db, 'send-tenant-b');
    const queue = bossQueue(boss);
    const singletonKey = randomUUID();
    await withScope(db.pools.app, { userId: a.userId, mfa: true }, (_tx, client) =>
      queue.sendTenant(
        client,
        'extract',
        { attachmentId: 'x', userId: b.userId },
        { singletonKey, singletonSeconds: 20 },
      ),
    );
    const { rows } = await db.pools.system.query<{
      id: string;
      data: unknown;
      retry_limit: number;
      expire_seconds: number;
    }>(
      `SELECT id, data, retry_limit, expire_seconds FROM pgboss.job
        WHERE name = 'extract' AND singleton_key = $1`,
      [singletonKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      data: { userId: a.userId, mfa: true, data: { attachmentId: 'x', userId: b.userId } },
      retry_limit: JOB_POLICIES.extract.retryLimit,
      expire_seconds: JOB_POLICIES.extract.expireInSeconds,
    });
    await boss.deleteJob('extract', rows[0]?.id as string);
  });
});

describe('the maintenance jobs', () => {
  it('audit-partitions keeps this month and the next three partitioned', async () => {
    // The migration made them; the job finds nothing to do, and says so.
    expect(await ensureAuditPartitions(db.pools)).toBe(0);
    const months = Array.from({ length: AUDIT_MONTHS_AHEAD + 1 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + i);
      return `audit_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const { rows } = await asOwner(db, (c) =>
      c.query<{ reg: string | null }>(
        'SELECT to_regclass(m)::text AS reg FROM unnest($1::text[]) m',
        [months.map((m) => `public.${m}`)],
      ),
    );
    expect(rows.map((r) => r.reg)).toEqual(months);
  });

  it('ai-maintenance keeps ledger partitions ahead, rolls up past the retention and prunes counters', async () => {
    await ownerTx(db, async (c) => {
      await c.query(`SELECT kept.create_llm_partition('2020-01-01')`);
      await c.query(
        `INSERT INTO public.ai_leases (lease_key, slot, job_id, lease_until)
         VALUES ('payer:instance:instance', 1, 'old', now() - interval '1 hour')`,
      );
      await c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ('ai_ledger_months', '24')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    });
    const done = await aiMaintenance(db.pools);
    expect(done).toMatchObject({ partitionsCreated: 0, partitionsRolledUp: 1, keepMonths: 24 });
    expect(done.pruned).toMatchObject({ ai_leases: 1 });
    const { rows } = await asOwner(db, (c) =>
      c.query(`SELECT to_regclass('public.llm_calls_2020_01') AS r`),
    );
    expect(rows).toEqual([{ r: null }]);
  });

  it('prune-stale-rows removes lapsed limiter rows, expired sessions’ flags and old keys only', async () => {
    const user = await seedUser(db, 'prune');
    const home = await seedTenant(db, 'prune-home');
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO auth.sign_in_failures (key, window_start, count, last_failure_at) VALUES
           ('old', now() - interval '3 days', 3, now() - interval '26 hours'),
           ('recent-window', now() - interval '2 days', 3, now() - interval '1 hour'),
           ('fresh', now(), 1, now())`,
      );
      for (const [id, expires] of [
        ['expired', "now() - interval '1 minute'"],
        ['live', "now() + interval '1 day'"],
      ]) {
        const sid = randomUUID();
        await c.query(
          `INSERT INTO auth.session (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, ${expires}, now(), now())`,
          [sid, `token-${id}-${sid}`, user],
        );
        await c.query(`INSERT INTO auth.session_mfa (session_id, method) VALUES ($1, 'totp')`, [
          sid,
        ]);
      }
      await c.query(
        `INSERT INTO public.idempotency_keys (user_id, key, request_hash, created_at) VALUES
           ($1, 'old', 'h', now() - interval '31 days'), ($1, 'new', 'h', now())`,
        [user],
      );
      // Step 3 (T4): the sync ledger, 30 days too.
      for (const [key, age] of [
        ['op-old-00001', '31 days'],
        ['op-new-00001', '0 days'],
      ]) {
        await c.query(
          `INSERT INTO public.sync_ops (user_id, idempotency_key, client_id, op, payload_version,
                                        client_version, taken_at, received_at, request_hash,
                                        outcome)
           VALUES ($1, $2, $3, 'mark_seen', 1, '0.3.0', now(), now() - $4::interval,
                   repeat('a', 64), 'applied')`,
          [user, key, randomUUID(), age],
        );
      }
      // Step 3 (T5): inbox items resolved more than 90 days ago; open ones stay, however old.
      for (const [code, resolved] of [
        ['AAAAAA', "now() - interval '91 days'"],
        ['BBBBBB', "now() - interval '1 day'"],
        ['CCCCCC', 'NULL'],
      ]) {
        await c.query(
          `INSERT INTO public.inbox_items (location_id, kind, code, created_by, resolved_at,
                                           resolution, created_at)
           VALUES ($1, 'label_claim', $2, $3, ${resolved},
                   CASE WHEN ${resolved} IS NULL THEN NULL ELSE 'dismissed' END,
                   now() - interval '200 days')`,
          [home.locationId, code, home.userId],
        );
      }
      // Step 4 (T7): the centre after 90 days; the reminder ledger after a year, an occurrence
      // only once its deliveries are gone.
      const channel = (
        await c.query<{ id: string }>(
          `INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'email') RETURNING id`,
          [home.userId],
        )
      ).rows[0]?.id;
      const occurrence = async (period: string, state: string, closed: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO public.reminder_occurrences (location_id, source_type, source_id, kind,
                                                      due_period, state, closed_at)
             VALUES ($1, 'document', $2, 'expiring', $3, $4, ${closed}) RETURNING id`,
            [home.locationId, randomUUID(), period, state],
          )
        ).rows[0]?.id;
      const oldClosed = await occurrence('date:2024-01-01', 'done', "now() - interval '13 months'");
      const oldDelivered = await occurrence(
        'date:2024-02-01',
        'done',
        "now() - interval '13 months'",
      );
      await occurrence('date:2024-03-01', 'open', 'NULL');
      await c.query(
        `INSERT INTO public.reminder_deliveries (occurrence_id, user_id, channel_id, status,
                                                 created_at)
         VALUES ($1, $3, $4, 'sent', now() - interval '13 months'),
                ($2, $3, $4, 'sent', now() - interval '11 months')`,
        [oldClosed, oldDelivered, home.userId, channel],
      );
      await c.query(
        `INSERT INTO public.notifications (user_id, kind, created_at)
         VALUES ($1, 'ai_cap', now() - interval '91 days'), ($1, 'ai_cap', now())`,
        [home.userId],
      );
      await c.query(
        `INSERT INTO public.notification_digests (user_id, digest_on, channel_id)
         VALUES ($1, current_date - 400, $2), ($1, current_date, $2)`,
        [home.userId, channel],
      );
    });

    expect(await pruneStaleRows(db.pools)).toEqual({
      'auth.sign_in_failures': 1,
      'auth.session_mfa': 1,
      idempotency_keys: 1,
      sync_ops: 1,
      inbox_items: 1,
      notifications: 1,
      reminder_deliveries: 1,
      // The one whose delivery went in the same run; the other still has one.
      reminder_occurrences: 1,
      notification_digests: 1,
      // Step 6: tokens' rate windows and webhook deliveries (none old enough here).
      token_rate_windows: 0,
      webhook_deliveries: 0,
    });
    const left = await asOwner(db, async (c) => ({
      failures: (await c.query('SELECT key FROM auth.sign_in_failures ORDER BY key')).rows,
      mfa: (await c.query('SELECT count(*)::int AS n FROM auth.session_mfa')).rows[0].n,
      keys: (await c.query('SELECT key FROM public.idempotency_keys')).rows,
      ops: (await c.query('SELECT idempotency_key FROM public.sync_ops')).rows,
      inbox: (await c.query('SELECT code FROM public.inbox_items ORDER BY code')).rows,
    }));
    expect(left).toEqual({
      failures: [{ key: 'fresh' }, { key: 'recent-window' }],
      mfa: 1,
      keys: [{ key: 'new' }],
      ops: [{ idempotency_key: 'op-new-00001' }],
      inbox: [{ code: 'BBBBBB' }, { code: 'CCCCCC' }],
    });
  });
});

describe('failed jobs', () => {
  let t: TestApp;
  let admin: Person;
  let bob: Person;
  const name = `flaky-${randomUUID()}`;
  let failuresLeft = 0;
  let runs = 0;

  beforeAll(async () => {
    const job = defineJob({
      name,
      kind: 'system',
      policy: NO_RETRY,
      handler: async () => {
        runs += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('the printer is on fire');
        }
      },
    });
    await registerJobs(boss, [job], { pools: db.pools, ...FAST });
  });

  beforeEach(async () => {
    t = await peopleApp(db, { jobAdmin: jobAdmin(boss, db.pools.system) });
    admin = await person(t, db, 'job-admin');
    bob = await person(t, db, 'job-bob');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]),
    );
  });

  const failOne = async () => {
    failuresLeft = 1;
    const id = (await boss.send(name, {})) as string;
    await until(async () => (await jobState(id)) === 'failed');
    return id;
  };

  const instanceAudit = () =>
    asOwner(db, async (c) => {
      const { rows } = await c.query<{ action: string; entity_id: string }>(
        `SELECT action, entity_id FROM public.audit_events
          WHERE location_id IS NULL AND owner_account_id IS NULL AND entity_type = 'job'
          ORDER BY at, id`,
      );
      return rows;
    });

  it('lists a job that exhausted its retries, to instance admins only', async () => {
    const id = await failOne();
    expect((await call(t, '/api/v1/admin/jobs/failed', { as: bob })).statusCode).toBe(403);
    const res = await call(t, '/api/v1/admin/jobs/failed', { as: admin });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: { id: string }[] };
    expect(jobs).toContainEqual({
      id,
      name,
      error: 'the printer is on fire',
      attempts: 1,
      createdAt: expect.any(String),
      failedAt: expect.any(String),
    });
    // Its data is not shown.
    expect(JSON.stringify(res.json())).not.toContain('"data"');
  });

  // catalogue: POST /api/v1/admin/jobs/failed/:id/retry
  it('retries a failed job, which then runs again, and audits it', async () => {
    const id = await failOne();
    const before = runs;
    expect(
      (await call(t, `/api/v1/admin/jobs/failed/${id}/retry`, { as: bob, body: {} })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/admin/jobs/failed/${id}/retry`, { as: admin, body: {} });
    expect(res.statusCode).toBe(204);
    await until(async () => (await jobState(id)) === 'completed');
    expect(runs).toBe(before + 1);
    expect(await instanceAudit()).toContainEqual({ action: 'admin.job_retry', entity_id: id });
    // It is no longer failed, so a second retry finds nothing.
    expect(
      (await call(t, `/api/v1/admin/jobs/failed/${id}/retry`, { as: admin, body: {} })).statusCode,
    ).toBe(404);
  });

  // catalogue: POST /api/v1/admin/jobs/failed/:id/discard
  it('discards a failed job', async () => {
    const id = await failOne();
    const res = await call(t, `/api/v1/admin/jobs/failed/${id}/discard`, { as: admin, body: {} });
    expect(res.statusCode).toBe(204);
    expect(await jobState(id)).toBeNull();
    expect(await instanceAudit()).toContainEqual({ action: 'admin.job_discard', entity_id: id });
    const list = await call(t, '/api/v1/admin/jobs/failed', { as: admin });
    expect((list.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).not.toContain(id);
  });

  it('pages the list newest first', async () => {
    const ids = [await failOne(), await failOne(), await failOne()];
    const first = await call(t, '/api/v1/admin/jobs/failed?limit=2', { as: admin });
    const page1 = first.json() as { jobs: { id: string }[]; nextCursor: string };
    expect(page1.jobs.map((j) => j.id)).toEqual([ids[2], ids[1]]);
    const second = await call(
      t,
      `/api/v1/admin/jobs/failed?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      { as: admin },
    );
    expect((second.json() as { jobs: { id: string }[] }).jobs[0]?.id).toBe(ids[0]);
  });
});
