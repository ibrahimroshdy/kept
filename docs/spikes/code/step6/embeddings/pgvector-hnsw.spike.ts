/**
 * Spike S6.4, the follow-up the plan asks for when the exact scan misses 150 ms p95: on the
 * database pgvector.spike.ts left with --keep (`--db=<name>`), measure
 *   1. the exact scan again (the baseline, same run);
 *   2. the exact scan at 768 dimensions (both providers can return shortened vectors:
 *      `@ai-sdk/openai` sends `dimensions`, `@ai-sdk/google` sends `outputDimensionality`);
 *   3. an HNSW index on an expression cast to the model's dimension, partial on the model, used
 *      through a door with the model's literal (a partial index needs a provable predicate);
 *      recall@50 against the exact scan on the same query;
 *   4. what pgvector 0.8.6 itself says when asked for HNSW at 3,072 dimensions.
 * Then drops the database (unless --keep).
 *
 * Run from apps/server:  node_modules/.bin/tsx ../../docs/spikes/code/step6/embeddings/pgvector-hnsw.spike.ts --db=<name>
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../../../../../apps/server');
const pg = createRequire(path.join(server, 'package.json'))('pg') as typeof import('pg');

const PORT = 5452;
const dbName = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
if (!dbName || !/^kept_spike6_emb_[a-z0-9]+$/.test(dbName)) throw new Error('--db=kept_spike6_emb_… required');
const keep = process.argv.includes('--keep');
const url = (role: string) => `postgres://kept_${role}:kept_${role}@localhost:${PORT}/${dbName}`;
const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const randomVec = (n: number) => `[${Array.from({ length: n }, () => (Math.random() * 2 - 1).toFixed(5)).join(',')}]`;
function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => Number((s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? NaN).toFixed(2));
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}

const out: Record<string, unknown> = { date: new Date().toISOString(), db: dbName };
const owner = new pg.Client({ connectionString: url('owner') });
const app = new pg.Client({ connectionString: url('app') });
await owner.connect();
await app.connect();
try {
  const big = (await owner.query<{ id: string }>("SELECT id FROM public.locations WHERE name = 'Bench 10k'")).rows[0]?.id;
  const member = (await owner.query<{ id: string }>(
    `SELECT m.user_id AS id FROM public.memberships m WHERE m.location_id = $1 AND m.role = 'member' LIMIT 1`, [big],
  )).rows[0]?.id;
  if (!big || !member) throw new Error('bench location or member not found');

  // 2. 768-dimension rows for every thing, as a third model.
  log('768-d rows');
  const ids = (await owner.query<{ id: string; location_id: string }>('SELECT id, location_id FROM public.things WHERE deleted_at IS NULL')).rows;
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const params: unknown[] = [];
    const values = chunk.map((r) => {
      params.push(r.id, r.location_id, randomVec(768));
      const n = params.length;
      return `($${n - 2}, $${n - 1}, 'test:768', 768, $${n}::public.vector)`;
    });
    await owner.query(`INSERT INTO public.spike_thing_embeddings VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  }
  await owner.query('ANALYZE public.spike_thing_embeddings');

  // 3. The HNSW index and a door that names the model literally.
  log('HNSW index (1536, partial on the model)');
  const t0 = performance.now();
  await owner.query(`SET maintenance_work_mem = '256MB'`);
  await owner.query(`CREATE INDEX IF NOT EXISTS spike_emb_hnsw_1536 ON public.spike_thing_embeddings
                      USING hnsw ((embedding::public.vector(1536)) public.vector_cosine_ops)
                      WHERE model_key = 'openai:text-embedding-3-small'`);
  out.hnswBuildSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));
  out.hnswIndexSize = (await owner.query("SELECT pg_size_pretty(pg_relation_size('spike_emb_hnsw_1536')) AS s")).rows[0]?.s;
  await owner.query(`
    CREATE OR REPLACE FUNCTION kept.spike_semantic_hnsw_1536(p_location uuid, p_q public.vector, p_limit int)
    RETURNS TABLE (id uuid, distance double precision)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      SELECT e.thing_id, (e.embedding::public.vector(1536)) OPERATOR(public.<=>) p_q::public.vector(1536)
        FROM public.spike_thing_embeddings e
        JOIN public.things t ON t.id = e.thing_id AND t.deleted_at IS NULL
       WHERE e.model_key = 'openai:text-embedding-3-small'
         AND e.location_id = p_location
         AND p_location IN (SELECT kept.visible_location_ids())
       ORDER BY (e.embedding::public.vector(1536)) OPERATOR(public.<=>) p_q::public.vector(1536)
       LIMIT least(p_limit, 50)
    $$;
    REVOKE EXECUTE ON FUNCTION kept.spike_semantic_hnsw_1536(uuid, public.vector, int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION kept.spike_semantic_hnsw_1536(uuid, public.vector, int) TO kept_app;`);

  // 4. HNSW at 3,072 dimensions: what the extension says.
  out.hnsw3072 = await owner
    .query(`CREATE INDEX spike_emb_hnsw_3072 ON public.spike_thing_embeddings
             USING hnsw ((embedding::public.vector(3072)) public.vector_cosine_ops)
             WHERE model_key = 'google:gemini-embedding-001'`)
    .then(() => 'created')
    .catch((e: Error) => `error: ${e.message}`);
  out.hnsw3072Halfvec = await owner
    .query(`CREATE INDEX spike_emb_hnsw_3072h ON public.spike_thing_embeddings
             USING hnsw ((embedding::public.halfvec(3072)) public.halfvec_cosine_ops)
             WHERE model_key = 'google:gemini-embedding-001'`)
    .then(() => 'created')
    .catch((e: Error) => `error: ${e.message}`);
  await owner.query('DROP INDEX IF EXISTS spike_emb_hnsw_3072h');

  // Measure as kept_app in the member's scope, one transaction per query (as withScope does).
  async function run(sql: string, dims: number, runs = 200, warm = 20) {
    const ms: number[] = [];
    for (let i = 0; i < warm + runs; i++) {
      const q = randomVec(dims);
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.user_id', $1, true), set_config('app.mfa', 'false', true)", [member]);
      const s = performance.now();
      await app.query(sql, [big, q]);
      if (i >= warm) ms.push(performance.now() - s);
      await app.query('COMMIT');
    }
    return stats(ms);
  }
  const exactSql = (model: string) => `SELECT id FROM kept.spike_semantic_thing_ids($1, '${model}', $2::public.vector, 50)`;
  log('measuring');
  out.exact1536 = await run(exactSql('openai:text-embedding-3-small'), 1536);
  out.exact768 = await run(exactSql('test:768'), 768);
  out.exact3072 = await run(exactSql('google:gemini-embedding-001'), 3072, 100, 10);
  out.hnsw1536 = await run('SELECT id FROM kept.spike_semantic_hnsw_1536($1, $2::public.vector, 50)', 1536);

  // Recall@50 of the HNSW door against the exact door, same query (random vectors: a worst case).
  let hits = 0;
  const N = 30;
  for (let i = 0; i < N; i++) {
    const q = randomVec(1536);
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.user_id', $1, true)", [member]);
    const a = new Set((await app.query(exactSql('openai:text-embedding-3-small'), [big, q])).rows.map((r) => r.id));
    const b = (await app.query('SELECT id FROM kept.spike_semantic_hnsw_1536($1, $2::public.vector, 50)', [big, q])).rows.map((r) => r.id);
    await app.query('COMMIT');
    hits += b.filter((x) => a.has(x)).length / Math.max(1, a.size);
  }
  out.hnswRecallAt50 = Number((hits / N).toFixed(3));

  // The inner plans (as the owner, in the member's scope) to show the index is used.
  await owner.query('BEGIN');
  await owner.query("SELECT set_config('app.user_id', $1, true)", [member]);
  const plan = await owner.query(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT e.thing_id FROM spike_thing_embeddings e JOIN things t ON t.id = e.thing_id AND t.deleted_at IS NULL
      WHERE e.model_key = 'openai:text-embedding-3-small' AND e.location_id = $1 AND $1 IN (SELECT kept.visible_location_ids())
      ORDER BY (e.embedding::vector(1536)) <=> $2::vector(1536) LIMIT 50`,
    [big, randomVec(1536)],
  );
  await owner.query('ROLLBACK');
  out.hnswPlan = plan.rows.map((r: Record<string, string>) => r['QUERY PLAN'].replace(/'\[[^\]]+\]'/g, "'[…]'"));
  out.storage = (await owner.query(`SELECT attstorage FROM pg_attribute WHERE attrelid = 'public.spike_thing_embeddings'::regclass AND attname = 'embedding'`)).rows[0]?.attstorage;
} finally {
  await app.end();
  await owner.end();
  writeFileSync(path.join(here, 'pgvector-hnsw-results.json'), `${JSON.stringify(out, null, 2)}\n`);
  if (!keep) {
    const su = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PORT}/postgres` });
    await su.connect();
    await su.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await su.end();
    log(`dropped ${dbName}`);
  }
}
console.log(JSON.stringify(out, null, 2));
