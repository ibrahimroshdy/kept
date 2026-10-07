import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { testDb, workerDbName } from './db.js';
import { leaveMarker, markerLeftBy } from './leftover.js';

describe('template database per vitest worker', () => {
  it('starts on a clone with nothing another file on this worker left behind', async () => {
    const db = await testDb();
    expect(await markerLeftBy(db)).toEqual([]);
  });

  it('gives a database named after this run and this worker, migrated and clean', async () => {
    const db = await testDb();
    const poolId = process.env.VITEST_POOL_ID;
    expect(poolId).toMatch(/^\d+$/);
    expect(db.dbName).toBe(workerDbName(inject('keptRunId'), String(poolId)));

    const client = new pg.Client({ connectionString: db.urls.owner });
    await client.connect();
    try {
      const current = await client.query('SELECT current_database() AS name');
      expect(current.rows[0].name).toBe(db.dbName);

      const migrations = await client.query(`SELECT to_regclass('kept_meta.migrations') AS reg`);
      expect(migrations.rows[0].reg).toBe('kept_meta.migrations');
    } finally {
      await client.end();
    }
  });

  it('returns the same cached database on a second call within this file', async () => {
    const first = await testDb();
    const second = await testDb();
    expect(second.dbName).toBe(first.dbName);
    expect(second.pools.app).toBe(first.pools.app);
  });

  it('reset() truncates ordinary tables, restarts identities and leaves reference tables', async () => {
    const db = await testDb();
    const client = new pg.Client({ connectionString: db.urls.owner });
    await client.connect();
    try {
      // A name that only survives if it is quoted as an identifier.
      await client.query(
        'CREATE TABLE public."Harness Scratch" (id int GENERATED ALWAYS AS IDENTITY, v text)',
      );
      await client.query(`INSERT INTO public."Harness Scratch" (v) VALUES ('a'), ('b')`);

      await db.reset();

      const scratch = await client.query('SELECT count(*)::int AS n FROM public."Harness Scratch"');
      expect(scratch.rows[0].n).toBe(0);
      const next = await client.query(
        `INSERT INTO public."Harness Scratch" (v) VALUES ('c') RETURNING id`,
      );
      expect(next.rows[0].id).toBe(1);
      const currencies = await client.query(
        'SELECT count(*)::int AS n FROM public.currencies WHERE enabled',
      );
      // The five enabled by default (0004, then the reference seed's ISO list, D136).
      expect(currencies.rows[0].n).toBe(5);

      await client.query('DROP TABLE public."Harness Scratch"');
    } finally {
      await client.end();
    }
  });

  it('runs with TZ pinned to Africa/Cairo', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Africa/Cairo');
    // Cairo is UTC+2 in January, whatever the host machine says.
    expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(-120);
  });
});

// Left on purpose: the next file this worker runs must not see it.
afterAll(async () => {
  await leaveMarker(await testDb(), 'harness.test.ts');
});
