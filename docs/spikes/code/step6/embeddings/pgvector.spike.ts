/**
 * Spike S6.4, database half (step-6 plan, T0): an undimensioned `vector` column holding two models'
 * vectors, and an exact cosine scan in a SECURITY DEFINER door over the 10,000 things of one
 * location, run as kept_app in a member's scope. Pass: the exact scan's p95 < 150 ms on the laptop.
 * If it misses, an HNSW index on an expression cast to the model's dimension, partial on the model.
 *
 * It makes its own scratch database on the dev Postgres (localhost:5452, never the dev `kept`
 * database), migrates it, seeds `bench` (10,000 things), measures, and drops the database.
 *
 * Run from apps/server (so the server's packages resolve):
 *   ../../node_modules/.bin/tsx ../../docs/spikes/code/step6/embeddings/pgvector.spike.ts [--keep]
 * (or apps/server/node_modules/.bin/tsx). Writes pgvector-results.json beside this file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../../../../../apps/server');
const req = createRequire(path.join(server, 'package.json'));
const pg = req('pg') as typeof import('pg');
const { loadEnv } = await import(path.join(server, 'src/config/env.ts'));
const { generateKey } = await import(path.join(server, 'src/crypto/envelope.ts'));
const { runMigrations } = await import(path.join(server, 'src/db/migrate.ts'));
const { closePools, createPools } = await import(path.join(server, 'src/db/pools.ts'));
const { withScope } = await import(path.join(server, 'src/db/scope.ts'));
const { assertSeedAllowed, runSeed } = await import(path.join(server, 'src/seed/index.ts'));

const PORT = 5452;
const keep = process.argv.includes('--keep');
const dbName = process.argv.find((a) => a.startsWith('--db='))?.slice(5) ?? `kept_spike6_emb_${Date.now().toString(36)}`;
const reuse = process.argv.some((a) => a.startsWith('--db='));
const superUrl = `postgres://postgres:postgres@localhost:${PORT}/postgres`;
const roleUrl = (role: string, db: string) => `postgres://kept_${role}:kept_${role}@localhost:${PORT}/${db}`;
const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function asSuper<T>(url: string, fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => Number((s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? NaN).toFixed(2));
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}

const MODELS = [
  { key: 'openai:text-embedding-3-small', dims: 1536 },
  { key: 'google:gemini-embedding-001', dims: 3072 },
];
// The spike's dimensions are test values; T14 stores `dims` from the real response.
const randomVec = (n: number) => `[${Array.from({ length: n }, () => (Math.random() * 2 - 1).toFixed(5)).join(',')}]`;

assertSeedAllowed(process.env.NODE_ENV);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kept-spike6-emb-'));
const result: Record<string, unknown> = { date: new Date().toISOString(), db: dbName };
let created = false;
try {
  if (!reuse) {
    await asSuper(superUrl, (c) => c.query(`CREATE DATABASE ${dbName} OWNER kept_owner`));
    created = true;
    log(`database ${dbName}: migrating`);
    await runMigrations(roleUrl('owner', dbName));
  }
  const env = await loadEnv({
    KEPT_DATABASE_URL: roleUrl('app', dbName),
    KEPT_AUTH_DATABASE_URL: roleUrl('auth', dbName),
    KEPT_SYSTEM_DATABASE_URL: roleUrl('system', dbName),
    KEPT_SECRET_KEY: generateKey(),
    KEPT_AUTH_SECRET: generateKey(),
    KEPT_PUBLIC_URL: 'http://127.0.0.1:1',
    KEPT_ROLE: 'web',
    KEPT_LOG_LEVEL: 'error',
    KEPT_CONFIG_DIR: path.join(tmp, 'config'),
    KEPT_DATA_DIR: path.join(tmp, 'data'),
  });
  const pools = createPools(env);
  try {
    log('seeding bench (10,000 things)');
    const t0 = performance.now();
    const report = await runSeed('bench', env, pools, { bench: { things: 10_000, ownerUrl: roleUrl('owner', dbName) } });
    result.seedSeconds = Math.round((performance.now() - t0) / 1000);
    const bench = report.bench;
    if (!bench) throw new Error('no bench report');
    const [big] = bench.locations as { id: string; name?: string }[];
    if (!big) throw new Error('no bench location');
    const member = bench.actors.member.userId as string;
    const viewer = bench.actors.viewer.userId as string;

    // Schema: the extension (superuser), then a table and a door owned by kept_owner.
    const dbSuper = `postgres://postgres:postgres@localhost:${PORT}/${dbName}`;
    await asSuper(dbSuper, async (c) => {
      await c.query('CREATE EXTENSION IF NOT EXISTS vector');
      result.pgvector = (await c.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rows[0]?.extversion;
      result.postgres = (await c.query('SHOW server_version')).rows[0]?.server_version;
    });
    await asSuper(roleUrl('owner', dbName), async (c) => {
      await c.query(`
        CREATE TABLE public.spike_thing_embeddings (
          thing_id uuid NOT NULL REFERENCES public.things(id) ON DELETE CASCADE,
          location_id uuid NOT NULL,
          model_key text NOT NULL,
          dims int NOT NULL,
          embedding public.vector NOT NULL,
          PRIMARY KEY (thing_id, model_key),
          CHECK (public.vector_dims(embedding) = dims));
        ALTER TABLE public.spike_thing_embeddings ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.spike_thing_embeddings FORCE ROW LEVEL SECURITY;
        -- owner_all only: definer-only, kept_app has no policy and so reads nothing (T6's shape).
        CREATE POLICY owner_all ON public.spike_thing_embeddings FOR ALL TO kept_owner USING (true) WITH CHECK (true);
        CREATE INDEX spike_emb_loc_model ON public.spike_thing_embeddings (location_id, model_key);
        CREATE FUNCTION kept.spike_semantic_thing_ids(p_location uuid, p_model text, p_q public.vector, p_limit int)
        RETURNS TABLE (id uuid, distance double precision)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
          SELECT e.thing_id, e.embedding OPERATOR(public.<=>) p_q
            FROM public.spike_thing_embeddings e
            JOIN public.things t ON t.id = e.thing_id AND t.deleted_at IS NULL
           WHERE e.location_id = p_location
             AND p_location IN (SELECT kept.visible_location_ids())
             AND e.model_key = p_model
           ORDER BY e.embedding OPERATOR(public.<=>) p_q
           LIMIT least(p_limit, 50)
        $$;
        REVOKE EXECUTE ON FUNCTION kept.spike_semantic_thing_ids(uuid, text, public.vector, int) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION kept.spike_semantic_thing_ids(uuid, text, public.vector, int) TO kept_app;
      `);
      const ids = (await c.query<{ id: string; location_id: string }>('SELECT id, location_id FROM public.things WHERE deleted_at IS NULL')).rows;
      result.thingsTotal = ids.length;
      result.thingsInBigLocation = ids.filter((r) => r.location_id === big.id).length;
      log(`inserting vectors for ${ids.length} things × ${MODELS.length} models`);
      const t1 = performance.now();
      for (const m of MODELS) {
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const values: string[] = [];
          const params: unknown[] = [];
          for (const r of chunk) {
            params.push(r.id, r.location_id, randomVec(m.dims));
            const n = params.length;
            values.push(`($${n - 2}, $${n - 1}, '${m.key}', ${m.dims}, $${n}::public.vector)`);
          }
          await c.query(`INSERT INTO public.spike_thing_embeddings VALUES ${values.join(',')}`, params);
        }
      }
      result.insertSeconds = Math.round((performance.now() - t1) / 1000);
      await c.query('ANALYZE public.spike_thing_embeddings');
      result.tableSize = (await c.query("SELECT pg_size_pretty(pg_total_relation_size('public.spike_thing_embeddings')) AS s")).rows[0]?.s;
    });

    // Measure as kept_app, in the member's scope, the way T14's search would call the door.
    const RUNS = 200;
    const WARM = 20;
    async function measure(model: (typeof MODELS)[number], fn = 'kept.spike_semantic_thing_ids', userId = member) {
      const inside: number[] = [];
      const wall: number[] = [];
      let rows = 0;
      for (let i = 0; i < WARM + RUNS; i++) {
        const q = randomVec(model.dims);
        const w0 = performance.now();
        await withScope(pools.app, { userId, mfa: false }, async (_tx: unknown, client: import('pg').PoolClient) => {
          const s0 = performance.now();
          const r = await client.query(`SELECT id, distance FROM ${fn}($1, $2, $3::public.vector, 50)`, [big.id, model.key, q]);
          if (i >= WARM) inside.push(performance.now() - s0);
          rows = r.rowCount ?? 0;
        });
        if (i >= WARM) wall.push(performance.now() - w0);
      }
      return { model: model.key, dims: model.dims, rows, query: stats(inside), withScopeWall: stats(wall) };
    }
    const exact: unknown[] = [];
    for (const m of MODELS) {
      log(`exact scan: ${m.key}`);
      exact.push(await measure(m));
    }
    result.exactScan = exact;
    result.exactScanViewer = await measure(MODELS[0]!, undefined, viewer);

    // The plan as kept_app (the door's inner plan via auto_explain is not available; EXPLAIN the
    // door call, then the inner statement as the owner for the plan shape).
    await withScope(pools.app, { userId: member, mfa: false }, async (_tx: unknown, client: import('pg').PoolClient) => {
      const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kept.spike_semantic_thing_ids($1, $2, $3::public.vector, 50)`, [big.id, MODELS[0]!.key, randomVec(MODELS[0]!.dims)]);
      result.explainDoorAsApp = r.rows.map((x: Record<string, string>) => x['QUERY PLAN']);
      // kept_app can't read the table directly (no policy): prove it.
      const direct = await client.query('SELECT count(*)::int AS n FROM public.spike_thing_embeddings').then((x) => x.rows[0]?.n).catch((e: Error) => `error: ${e.message}`);
      result.appDirectRead = direct;
    });
    await asSuper(roleUrl('owner', dbName), async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', $1, true)", [member]);
      const r = await c.query(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT e.thing_id, e.embedding <=> $3::vector AS d
           FROM spike_thing_embeddings e JOIN things t ON t.id = e.thing_id AND t.deleted_at IS NULL
          WHERE e.location_id = $1 AND $1 IN (SELECT kept.visible_location_ids()) AND e.model_key = $2
          ORDER BY e.embedding <=> $3::vector LIMIT 50`,
        [big.id, MODELS[0]!.key, randomVec(MODELS[0]!.dims)],
      );
      await c.query('ROLLBACK');
      result.explainInnerAsOwner = r.rows.map((x: Record<string, string>) => x['QUERY PLAN']);
    });

    // A cross-tenant probe: a user with no membership gets nothing from the door.
    const stranger = '01900000-0000-7000-8000-000000000000';
    result.strangerRows = await withScope(pools.app, { userId: stranger, mfa: false }, async (_tx: unknown, client: import('pg').PoolClient) =>
      (await client.query('SELECT count(*)::int AS n FROM kept.spike_semantic_thing_ids($1, $2, $3::public.vector, 50)', [big.id, MODELS[0]!.key, randomVec(MODELS[0]!.dims)])).rows[0]?.n,
    );
  } finally {
    await closePools(pools);
  }
} finally {
  writeFileSync(path.join(here, 'pgvector-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (created && !keep) {
    log(`dropping ${dbName}`);
    await asSuper(superUrl, (c) => c.query(`DROP DATABASE ${dbName} WITH (FORCE)`));
  }
  rmSync(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
