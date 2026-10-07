import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { createBoss } from '../jobs/boss.js';
import { JOB_POLICIES, queueOptions } from '../jobs/policies.js';
import { bossQueue } from '../jobs/queue.js';
import { enqueueReindex } from './jobs.js';

// The reindex job is debounced per location (route security review #33): a burst of renames in
// one location queues one job now and one trailing job, never one per request; another location
// gets its own.
describe('enqueueReindex', () => {
  let boss: PgBoss;
  let pools: Awaited<ReturnType<typeof testDb>>['pools'];

  beforeAll(async () => {
    const db = await testDb();
    pools = db.pools;
    boss = createBoss({
      connectionString: db.urls.system,
      supervise: false,
      schedule: false,
      max: 3,
    });
    boss.on('error', (err) => {
      throw err;
    });
    await boss.start();
    await boss.createQueue('reindex', queueOptions(JOB_POLICIES.reindex));
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  const jobsFor = async (locationId: string) => {
    const { rows } = await pools.system.query<{ n: number; key: string | null }>(
      `SELECT count(*)::int AS n, max(singleton_key) AS key FROM pgboss.job
        WHERE name = 'reindex' AND data->>'locationId' = $1`,
      [locationId],
    );
    return rows[0];
  };

  it('queues at most one job now and one trailing job per location, however many sends', async () => {
    const queue = bossQueue(boss);
    const here = randomUUID();
    const there = randomUUID();
    for (let i = 0; i < 6; i++) {
      const client = await pools.app.connect();
      try {
        await client.query('BEGIN');
        await enqueueReindex(queue, client, here);
        if (i === 0) await enqueueReindex(queue, client, there);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    expect(await jobsFor(here)).toEqual({ n: 2, key: `reindex:${here}` });
    expect(await jobsFor(there)).toEqual({ n: 1, key: `reindex:${there}` });
  });
});
