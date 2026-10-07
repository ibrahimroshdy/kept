import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb, withSuperuser } from '../test/db.js';
import { loadEnv } from './config/env.js';
import { withSystem } from './db/scope.js';
import { createLogger } from './http/logger.js';
import { startKept } from './main.js';

// Postgres going away under a running server (2026-09-30: the disk filled, Postgres PANICked
// with 58030 and ended every connection). A connection checked out of a pool has no 'error'
// listener of pg-pool's own, so its backend ending crashed the process with
// "Unhandled 'error' event … Connection terminated unexpectedly". The server has to log it,
// answer /readyz 503 while the database refuses connections, and recover when it is back.
// Requests meanwhile get 503 `database_unavailable`, not a bare 500.

const db = await testDb();
let configDir: string;

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'kept-connloss-'));
});
afterAll(async () => {
  await setAllowConnections(true);
  await rm(configDir, { recursive: true, force: true });
});

async function setAllowConnections(allow: boolean): Promise<void> {
  await withSuperuser((client) =>
    client.query(`ALTER DATABASE ${db.dbName} WITH ALLOW_CONNECTIONS ${allow}`),
  );
}

/** Ends every backend on the test database, as Postgres's PANIC did; returns how many. */
async function terminateAll(): Promise<number> {
  const { rows } = await withSuperuser((client) =>
    client.query<{ n: number }>(
      `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n
         FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [db.dbName],
    ),
  );
  return rows[0]?.n ?? 0;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readyz = async (address: string) => (await fetch(`${address}/readyz`)).status;

type Line = { msg?: string; pool?: string; err?: { message?: string } };

describe('the database going away under a running server', () => {
  it('survives connections killed mid-use, answers /readyz 503 while down and 200 once back', async () => {
    const lines: Line[] = [];
    const logger = createLogger(
      { KEPT_LOG_LEVEL: 'warn', KEPT_LOG_FORMAT: 'json' },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    const env = await loadEnv(
      {
        KEPT_DATABASE_URL: db.urls.app,
        KEPT_AUTH_DATABASE_URL: db.urls.auth,
        KEPT_SYSTEM_DATABASE_URL: db.urls.system,
        KEPT_PUBLIC_URL: 'http://kept.test',
        KEPT_ROLE: 'all',
        KEPT_LOG_LEVEL: 'warn',
      },
      { configDir },
    );
    const kept = await startKept(env, {
      port: 0,
      host: '127.0.0.1',
      logger,
      webRoot: null,
      print: () => {},
    });
    const address = kept.address as string;
    try {
      expect(await readyz(address)).toBe(200);

      // Two connections checked out when the backends end: one inside a transaction but
      // between statements (only the client's 'error' event reports that), one mid-query.
      let resume = () => {};
      const between = withSystem(kept.pools.system, async (_tx, client) => {
        await client.query('SELECT 1');
        await new Promise<void>((r) => {
          resume = r;
        });
        await client.query('SELECT 1');
      });
      const midQuery = withSystem(kept.pools.system, (_tx, client) =>
        client.query('SELECT pg_sleep(60)'),
      );
      const settled = Promise.allSettled([between, midQuery]);
      await until('both transactions to be open', async () => {
        const { rows } = await withSuperuser((c) =>
          c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = $1 AND application_name = 'kept-system' AND xact_start IS NOT NULL`,
            [db.dbName],
          ),
        );
        return (rows[0]?.n ?? 0) >= 2 ? true : undefined;
      });

      // Down: no new connection is accepted, and every existing one is ended.
      await setAllowConnections(false);
      expect(await terminateAll()).toBeGreaterThan(0);

      await until('the in-use connections to be reported', async () =>
        lines.filter((l) => l.msg === 'database connection lost while in use').length >= 2
          ? true
          : undefined,
      );
      resume();
      const [b, m] = await settled;
      expect(b.status).toBe('rejected');
      expect(m.status).toBe('rejected');

      expect(
        await until('/readyz 503', async () => ((await readyz(address)) === 503 ? 503 : undefined)),
      ).toBe(503);
      // What the web's signed-in gate asks first gets an ordinary error reply, which it shows as
      // "Couldn't load this" with a retry (web: home.test.tsx), not a dropped connection: a 503
      // that says the database is out of reach, not "Something went wrong".
      const setup = await fetch(`${address}/api/v1/setup`);
      expect(setup.status).toBe(503);
      expect(await setup.json()).toEqual({
        error: "Kept can't reach its database right now. Try again in a minute.",
        code: 'database_unavailable',
      });
      // pg-boss's own connections were ended too; it reports that as an error and carries on.
      // (Its workers' plain-object errors, once "[object Object]", are http/errors.test.ts's.)
      await until('a pg-boss error', async () =>
        lines.some((l) => l.msg === 'pg-boss error') ? true : undefined,
      );

      // Back.
      await setAllowConnections(true);
      expect(
        await until('/readyz 200', async () => ((await readyz(address)) === 200 ? 200 : undefined)),
      ).toBe(200);
      const { rows } = await withSystem(kept.pools.system, (_tx, client) =>
        client.query<{ one: number }>('SELECT 1 AS one'),
      );
      expect(rows).toEqual([{ one: 1 }]);
      const setupBack = await fetch(`${address}/api/v1/setup`);
      expect(setupBack.status).toBe(200);
      await kept.boss?.createQueue('connection-loss');
      expect(await kept.boss?.send('connection-loss', {})).toEqual(expect.any(String));

      const bossErrors = lines.filter((l) => l.msg === 'pg-boss error');
      for (const l of bossErrors) {
        expect(l.err?.message, JSON.stringify(l)).not.toBe('[object Object]');
      }
    } finally {
      await setAllowConnections(true);
      await kept.stop();
    }
  }, 60_000);
});
