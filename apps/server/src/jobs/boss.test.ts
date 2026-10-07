import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { createBoss, sendInTx } from './boss.js';

// Spike S1 (V33): pg-boss with its migrations off, under non-owner roles.
describe('pg-boss under kept_system, sending from kept_app', () => {
  let boss: PgBoss;
  let urls: Awaited<ReturnType<typeof testDb>>['urls'];
  let pools: Awaited<ReturnType<typeof testDb>>['pools'];

  beforeAll(async () => {
    ({ urls, pools } = await testDb());
    boss = createBoss({ connectionString: urls.system, supervise: false, schedule: false, max: 3 });
    boss.on('error', (err) => {
      throw err;
    });
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  async function inAppTx<T>(
    fn: (client: import('pg').PoolClient) => Promise<T>,
    commit: boolean,
  ): Promise<T> {
    const client = await pools.app.connect();
    try {
      await client.query('BEGIN');
      const who = await client.query<{ u: string }>('SELECT current_user AS u');
      expect(who.rows[0]?.u).toBe('kept_app');
      const result = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  it('delivers a job sent inside a committed kept_app transaction to a kept_system worker', async () => {
    const queue = `noop-${randomUUID()}`;
    await boss.createQueue(queue);

    const received = new Promise<unknown>((resolve) => {
      void boss.work(queue, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        resolve(job?.data);
      });
    });

    const id = await inAppTx((client) => sendInTx(boss, client, queue, { n: 1 }), true);
    expect(id).toEqual(expect.any(String));

    await expect(received).resolves.toEqual({ n: 1 });
    await boss.offWork(queue);
  });

  it('delivers nothing when the kept_app transaction rolls back', async () => {
    const queue = `noop-${randomUUID()}`;
    await boss.createQueue(queue);

    const id = await inAppTx((client) => sendInTx(boss, client, queue, { n: 2 }), false);
    expect(id).toEqual(expect.any(String));

    expect(await boss.fetch(queue)).toEqual([]);
  });

  it('lets kept_app send but not read, claim or delete jobs', async () => {
    const client = await pools.app.connect();
    try {
      await expect(client.query('SELECT data FROM pgboss.job_common LIMIT 1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query(`UPDATE pgboss.job_common SET state = 'active'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DELETE FROM pgboss.job_common')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DELETE FROM pgboss.queue')).rejects.toThrow(/permission denied/);
      // It may write only the columns send() writes: not a job's state, output or timestamps.
      for (const [column, value] of [
        ['state', `'completed'`],
        ['output', `'{}'::jsonb`],
        ['started_on', 'now()'],
        ['completed_on', 'now()'],
        ['retry_count', '5'],
      ]) {
        await expect(
          client.query(
            `INSERT INTO pgboss.job_common (id, name, ${column}) VALUES (gen_random_uuid(), 'x', ${value})`,
          ),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      client.release();
    }
  });

  it('runs maintenance and cron as kept_system without owner rights', async () => {
    const queue = `cron-${randomUUID()}`;
    const full = createBoss({ connectionString: urls.system, max: 2 });
    const errors: unknown[] = [];
    full.on('error', (err) => errors.push(err));
    await full.start();
    try {
      await full.createQueue(queue);
      await full.schedule(queue, '*/5 * * * *', { tick: true }, { tz: 'Africa/Cairo' });
      expect(await full.getSchedules(queue)).toHaveLength(1);
      await full.supervise();
      await full.unschedule(queue);
      await full.deleteQueue(queue);
    } finally {
      await full.stop({ graceful: false });
    }
    expect(errors).toEqual([]);
  });

  it('refuses to start against a database whose pg-boss schema it would have to migrate', async () => {
    // kept_system can't create the schema, and migrate:false means it must not try: point it at
    // a schema that doesn't exist and start() must fail rather than install anything.
    const { PgBoss: Boss } = await import('pg-boss');
    const stray = new Boss({
      connectionString: urls.system,
      schema: 'pgboss_missing',
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await expect(stray.start()).rejects.toThrow(/not installed/);
    await stray.stop({ graceful: false }).catch(() => {});
  });
});
