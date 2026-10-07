import pg from 'pg';
import { inject } from 'vitest';
import { CONNECTION_OPTIONS } from '../src/db/pools.js';
import { seedTypes } from '../src/db/seed-reference.js';
import { templateDbName, workerDbName } from './names.js';

export { templateDbName, workerDbName } from './names.js';

const SUPERUSER_MAINTENANCE_URL = 'postgres://postgres:postgres@localhost:5452/postgres';

// Reference tables carry seed data that tests read but shouldn't have to reinsert (e.g.
// `currencies`, from task 9 onward). reset() leaves them alone.
const REFERENCE_TABLES = new Set(['currencies']);

// The built-in type library and place kinds (step 2) share their tables with tenants' own rows.
// reset() keeps the built-in rows (owner_account_id NULL) the clone got from `kept migrate`, and
// deletes the rest: these tables and the two they reference (owner_accounts, auth.user) are kept
// out of the TRUNCATE, whose CASCADE would otherwise empty them, and emptied with DELETE instead.
// Seeding them again on every reset cost more than the truncate itself. A test that changes a
// built-in row changes its fingerprint, and the next reset seeds the library again.
const BUILTIN_TABLES = ['type_fields', 'types', 'place_kinds'];
const DELETED_TABLES = new Set(['public.owner_accounts', 'auth."user"', 'auth.user']);
const builtinPrints = new Map<string, string>();

/** count, highest change_seq and total row_version of the built-in rows, per table. */
async function builtinPrint(client: pg.ClientBase): Promise<string> {
  const parts = BUILTIN_TABLES.map(
    (t) =>
      `(SELECT count(*) || ':' || coalesce(max(change_seq), 0) || ':' || coalesce(sum(row_version), 0)
          FROM public.${t} WHERE owner_account_id IS NULL)`,
  );
  const { rows } = await client.query<{ p: string }>(
    `SELECT concat_ws('/', ${parts.join(', ')}) AS p`,
  );
  return rows[0]?.p ?? '';
}

export type TestDb = {
  dbName: string;
  urls: { app: string; auth: string; system: string; owner: string };
  pools: { app: pg.Pool; auth: pg.Pool; system: pg.Pool };
  reset: () => Promise<void>;
};

function urlFor(role: 'app' | 'auth' | 'system' | 'owner', dbName: string): string {
  return `postgres://kept_${role}:kept_${role}@localhost:5452/${dbName}`;
}

/** Runs `fn` on a superuser connection to the maintenance database (DROP/CREATE DATABASE,
 * pg_terminate_backend on other roles' backends). */
export async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: SUPERUSER_MAINTENANCE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createFromTemplate(dbName: string, template: string): Promise<void> {
  await withSuperuser(async (client) => {
    // FORCE: the previous file on this worker may not have closed every connection.
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName} TEMPLATE ${template} OWNER kept_owner`);
  });
}

async function resetDb(ownerUrl: string, dbName: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ ident: string; tablename: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS ident, tablename
       FROM pg_tables WHERE schemaname IN ('public', 'auth')`,
    );
    const targets = rows.filter(
      (r) =>
        !REFERENCE_TABLES.has(r.tablename) &&
        !BUILTIN_TABLES.includes(r.tablename) &&
        !DELETED_TABLES.has(r.ident),
    );
    if (targets.length === 0) return;
    const idents = targets.map((r) => r.ident).join(', ');
    // One transaction without waiting for the WAL flush: a reset is a test's scratch state.
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL synchronous_commit = off');
      await client.query(`TRUNCATE ${idents} RESTART IDENTITY CASCADE`);
      for (const t of BUILTIN_TABLES) {
        await client.query(`DELETE FROM public.${t} WHERE owner_account_id IS NOT NULL`);
      }
      await client.query('DELETE FROM public.owner_accounts');
      await client.query('DELETE FROM auth."user"');
      const print = await builtinPrint(client);
      if (builtinPrints.get(dbName) !== print) {
        await client.query(
          `TRUNCATE ${BUILTIN_TABLES.map((t) => `public.${t}`).join(', ')} CASCADE`,
        );
        await seedTypes(client);
        builtinPrints.set(dbName, await builtinPrint(client));
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}

function newPool(connectionString: string): pg.Pool {
  // As the server's pools (src/db/pools.ts): JIT off, so tests and perf time what production runs.
  const pool = new pg.Pool({ connectionString, max: 5, options: CONNECTION_OPTIONS });
  // An idle client whose backend goes away (the next file re-cloning this database) emits
  // 'error' on the pool; unhandled, that crashes the worker instead of failing a query.
  pool.on('error', () => {});
  return pool;
}

const cache = new Map<string, Promise<TestDb>>();

/** One database per Vitest worker (and an optional second one), cloned from the migrated
 * template when a test file first asks for it (each file runs in a fresh module, so each file gets a fresh clone). Cached for
 * the file; call `reset()` between tests instead of recreating it. test/setup.ts closes the
 * pools after the file. */
export async function testDb(second?: 'b'): Promise<TestDb> {
  const runId = inject('keptRunId');
  // `second`: another server's database beside this worker's (step 7's round trip into a fresh
  // database), cloned from the same template and dropped with the run's others.
  const dbName = `${workerDbName(runId, process.env.VITEST_POOL_ID ?? '0')}${second ? `_${second}` : ''}`;
  let cached = cache.get(dbName);
  if (!cached) {
    cached = (async () => {
      await createFromTemplate(dbName, templateDbName(runId));
      const urls = {
        app: urlFor('app', dbName),
        auth: urlFor('auth', dbName),
        system: urlFor('system', dbName),
        owner: urlFor('owner', dbName),
      };
      // The clone's built-ins are the template's, as `kept migrate` seeded them.
      const owner = new pg.Client({ connectionString: urls.owner });
      await owner.connect();
      try {
        builtinPrints.set(dbName, await builtinPrint(owner));
      } finally {
        await owner.end();
      }
      const pools = {
        app: newPool(urls.app),
        auth: newPool(urls.auth),
        system: newPool(urls.system),
      };
      return {
        dbName,
        urls,
        pools,
        reset: () => resetDb(urls.owner, dbName),
      } satisfies TestDb;
    })();
    cache.set(dbName, cached);
  }
  return cached;
}

/** Ends every pool testDb() opened in this module instance. */
export async function closeTestDbs(): Promise<void> {
  const dbs = await Promise.allSettled(cache.values());
  cache.clear();
  await Promise.all(
    dbs.flatMap((db) =>
      db.status === 'fulfilled' ? Object.values(db.value.pools).map((pool) => pool.end()) : [],
    ),
  );
}
