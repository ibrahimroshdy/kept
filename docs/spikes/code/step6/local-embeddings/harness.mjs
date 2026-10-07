// S6.5 (D207): the in-container measurement. Runs as the entrypoint of the spike image
// (Dockerfile here), inside `--memory=2g --cpus=2`, as Kept's own uid, on a read-only root.
//
// One process, as Kept runs it: Kept's web + worker (`KEPT_ROLE=all`, startKept from the image's
// own dist/) plus, lazily, the local model, the way T14's `local.ts` would load it in the worker.
//
// Phases, in order (each writes its numbers into the result JSON at $OUT):
//   1. boot Kept; wait IDLE_SECONDS; sample RSS: web + worker idle, model UNLOADED and
//      @huggingface/transformers not even imported (T14 imports it on first enable only);
//   2. import @huggingface/transformers (module cost alone);
//   3. first enable: download the model files from the Hugging Face hub at the pinned revision
//      into the data volume ($MODELS_DIR), then check every file's sha256 against $MANIFEST;
//   4. load the pipeline (q8 ONNX, intraOpNumThreads = 2 for the 2-core floor) -> added RSS;
//   5. query latency: every query of queries.json embedded alone, QUERY_PASSES times;
//   6. first index: every thing of the 'Bench 10k' location (and the households) read from the
//      database, embedded in batches of BATCH, stored in a pgvector table; wall time, peak RSS;
//   7. semantic ranking of every query against the stored vectors (exact cosine, top 50);
//   8. dispose the pipeline and sample RSS again (is the memory given back?).
//
// Environment: the usual KEPT_* (see Dockerfile / run.sh), plus OWNER_URL (kept_owner, for the
// index table), MODEL_ID, MODEL_REVISION, DTYPE, POOLING, MANIFEST, MODELS_DIR, OUT, IDLE_SECONDS,
// BATCH, QUERY_PASSES, QUERY_PREFIX / DOC_PREFIX (for models that need them), SKIP_INDEX=1.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const env = process.env;
const OUT = env.OUT ?? '/out/result.json';
const IDLE_SECONDS = Number(env.IDLE_SECONDS ?? 60);
const BATCH = Number(env.BATCH ?? 32);
const QUERY_PASSES = Number(env.QUERY_PASSES ?? 2);
const MODELS_DIR = env.MODELS_DIR ?? '/data/models';
const QUERY_PREFIX = env.QUERY_PREFIX ?? '';
const DOC_PREFIX = env.DOC_PREFIX ?? '';
const result = {
  started: new Date().toISOString(),
  arch: process.arch,
  node: process.version,
  model: { id: env.MODEL_ID, revision: env.MODEL_REVISION, dtype: env.DTYPE, pooling: env.POOLING },
  limits: cgroupLimits(),
  phases: {},
};
const save = () => writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
const log = (line) => process.stderr.write(`[s65 ${new Date().toISOString()}] ${line}\n`);
const MB = (b) => Math.round((b / 1048576) * 10) / 10;
const rss = () => process.memoryUsage().rss;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cgroupRead(name) {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
  } catch {
    return null;
  }
}
function cgroupLimits() {
  return { memoryMax: cgroupRead('memory.max'), cpuMax: cgroupRead('cpu.max') };
}
function cgroupAnon() {
  const stat = cgroupRead('memory.stat');
  const anon = stat ? /^anon (\d+)$/m.exec(stat)?.[1] : null;
  return { current: MB(Number(cgroupRead('memory.current') ?? 0)), anon: anon ? MB(Number(anon)) : null };
}

/** Median and max of `n` RSS samples, one a second, after a GC if --expose-gc. */
async function sampleRss(n = 10) {
  globalThis.gc?.();
  const xs = [];
  for (let i = 0; i < n; i++) {
    xs.push(rss());
    await sleep(1000);
  }
  xs.sort((a, b) => a - b);
  return {
    rssMedianMB: MB(xs[Math.floor(xs.length / 2)]),
    rssMaxMB: MB(xs[xs.length - 1]),
    heapUsedMB: MB(process.memoryUsage().heapUsed),
    externalMB: MB(process.memoryUsage().external),
    cgroupMB: cgroupAnon(),
  };
}

/** Tracks the peak RSS while `fn` runs. */
async function withPeak(fn) {
  let peak = rss();
  const timer = setInterval(() => {
    peak = Math.max(peak, rss());
  }, 200);
  try {
    const value = await fn();
    return { value, peakMB: MB(Math.max(peak, rss())) };
  } finally {
    clearInterval(timer);
  }
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const round = (x) => Math.round(x * 100) / 100;

async function sha256(file) {
  const h = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

// The embedding text of a thing (D200 and the plan's T2 step 7: name, aliases in every language,
// type name, brand and model, notes, place path; never secrets, serials or money).
const THING_TEXT_SQL = `
  SELECT t.id, t.location_id,
         concat_ws(' · ', t.name,
           (SELECT string_agg(v, ', ') FROM jsonb_each(t.aliases) e,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'array'
                                                  THEN e.value ELSE '[]'::jsonb END) v),
           (SELECT coalesce(ty.name, ty.search_names,
                            (SELECT c.search_names FROM public.types c WHERE c.id = ty.copied_from_id))
              FROM public.types ty WHERE ty.id = t.type_id),
           nullif(concat_ws(' ', (SELECT b.name FROM public.brands b WHERE b.id = t.brand_id), t.model), ''),
           t.notes, t.place_path) AS text
    FROM public.things t JOIN public.locations l ON l.id = t.location_id
   WHERE t.deleted_at IS NULL AND l.name = ANY ($1::text[])
   ORDER BY t.id`;

async function main() {
  const queries = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(env.MANIFEST, 'utf8'));

  // --- 1. Kept, web + worker, model unloaded ---------------------------------------------------
  const { loadEnv } = await import('/app/apps/server/dist/config/env.js');
  const { startKept } = await import('/app/apps/server/dist/main.js');
  const t0 = performance.now();
  const keptEnv = await loadEnv(process.env, { logger: () => {} });
  const running = await startKept(keptEnv, { print: () => {} });
  result.phases.boot = { seconds: round((performance.now() - t0) / 1000), role: keptEnv.KEPT_ROLE };
  // One request through the web half, so the idle number is of a process that has served.
  const health = await fetch('http://127.0.0.1:8080/readyz').then((r) => r.status, (e) => String(e));
  result.phases.boot.readyz = health;
  log(`kept up (${result.phases.boot.seconds}s, /readyz ${health}); idle ${IDLE_SECONDS}s`);
  await sleep(IDLE_SECONDS * 1000);
  result.phases.idleUnloaded = {
    transformersImported: false,
    ...(await sampleRss()),
  };
  save();
  log(`idle, unloaded: ${JSON.stringify(result.phases.idleUnloaded)}`);

  // --- 2. import the runtime -------------------------------------------------------------------
  let t = performance.now();
  const tf = await import('@huggingface/transformers');
  result.phases.imported = { ms: round(performance.now() - t), ...(await sampleRss(5)) };
  log(`imported: ${JSON.stringify(result.phases.imported)}`);

  // --- 3. first enable: download into the data volume, verify ----------------------------------
  tf.env.cacheDir = MODELS_DIR;
  tf.env.allowLocalModels = false;
  const files = new Map();
  t = performance.now();
  const opts = {
    revision: env.MODEL_REVISION,
    dtype: env.DTYPE,
    cache_dir: MODELS_DIR,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    progress_callback: (p) => {
      if (p.status === 'done' || p.status === 'download') files.set(p.file, p.status);
    },
  };
  const { value: extractor, peakMB: loadPeakMB } = await withPeak(() =>
    tf.pipeline('feature-extraction', env.MODEL_ID, opts),
  );
  const loadSeconds = round((performance.now() - t) / 1000);
  const onDisk = walk(MODELS_DIR);
  const checks = [];
  for (const f of onDisk) {
    const rel = path.relative(MODELS_DIR, f);
    const want = manifest.files.find((m) => rel === m.path || rel.endsWith(`/${m.path}`));
    const got = await sha256(f);
    checks.push({ file: rel, bytes: statSync(f).size, sha256: got, expected: want?.sha256 ?? null, ok: want ? want.sha256 === got : null });
  }
  result.phases.download = {
    secondsIncludingLoad: loadSeconds,
    progressFiles: [...files.keys()],
    files: checks,
    allVerified: checks.every((c) => c.ok === true),
  };
  save();
  log(`downloaded + loaded in ${loadSeconds}s: ${JSON.stringify(checks.map((c) => [c.file, c.bytes, c.ok]))}`);

  // --- 4. added RSS with the model loaded ------------------------------------------------------
  const embed = async (texts) => {
    const out = await extractor(texts, { pooling: env.POOLING, normalize: true });
    const [n, d] = out.dims;
    const data = out.data;
    return Array.from({ length: n }, (_, i) => Float32Array.from(data.subarray(i * d, (i + 1) * d)));
  };
  for (let i = 0; i < 5; i++) await embed([`${QUERY_PREFIX}warm up ${i}`]);
  result.phases.loaded = { loadPeakMB, ...(await sampleRss()) };
  result.phases.loaded.addedOverIdleMB = round(
    result.phases.loaded.rssMedianMB - result.phases.idleUnloaded.rssMedianMB,
  );
  save();
  log(`loaded: ${JSON.stringify(result.phases.loaded)}`);

  // --- 5. query latency ------------------------------------------------------------------------
  const all = [...queries.bench.queries, ...queries.households.queries];
  const lat = [];
  const qvec = new Map();
  const { peakMB: queryPeakMB } = await withPeak(async () => {
    for (let pass = 0; pass < QUERY_PASSES; pass++) {
      for (const q of all) {
        const s = performance.now();
        const [v] = await embed([`${QUERY_PREFIX}${q.q}`]);
        lat.push(performance.now() - s);
        qvec.set(q.id, v);
      }
    }
  });
  result.phases.query = {
    n: lat.length,
    p50ms: round(pct(lat, 50)),
    p95ms: round(pct(lat, 95)),
    p99ms: round(pct(lat, 99)),
    maxms: round(Math.max(...lat)),
    peakMB: queryPeakMB,
  };
  save();
  log(`query: ${JSON.stringify(result.phases.query)}`);

  if (env.SKIP_INDEX === '1') {
    await finish(extractor, running);
    return;
  }

  // --- 6. first index --------------------------------------------------------------------------
  const db = new pg.Client({ connectionString: env.OWNER_URL });
  await db.connect();
  const dims = qvec.values().next().value.length;
  await db.query('DROP TABLE IF EXISTS public.spike_s65_embeddings');
  await db.query(`CREATE TABLE public.spike_s65_embeddings (
      thing_id uuid PRIMARY KEY, location_id uuid NOT NULL, embedding vector NOT NULL)`);
  const locations = [queries.bench.location, ...queries.households.locations];
  const index = {};
  const vectors = new Map(); // location name -> [{id, v}]
  for (const [label, names] of [
    ['bench', [queries.bench.location]],
    ['households', queries.households.locations],
  ]) {
    const { rows } = await db.query(THING_TEXT_SQL, [names]);
    const lens = rows.map((r) => r.text.length);
    const store = [];
    const s = performance.now();
    const { peakMB } = await withPeak(async () => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const vs = await embed(batch.map((r) => `${DOC_PREFIX}${r.text}`));
        await db.query(
          `INSERT INTO public.spike_s65_embeddings (thing_id, location_id, embedding)
           SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[]::vector[])`,
          [batch.map((r) => r.id), batch.map((r) => r.location_id), vs.map((v) => `[${Array.from(v).join(',')}]`)],
        );
        batch.forEach((r, k) => store.push({ id: r.id, v: vs[k] }));
        if ((i / BATCH) % 50 === 0) log(`  ${label}: ${i + batch.length} / ${rows.length}`);
      }
    });
    vectors.set(label, store);
    index[label] = {
      things: rows.length,
      seconds: round((performance.now() - s) / 1000),
      thingsPerSecond: round(rows.length / ((performance.now() - s) / 1000)),
      peakMB,
      textChars: { p50: pct(lens, 50), p95: pct(lens, 95), max: Math.max(...lens) },
      sample: rows.slice(0, 3).map((r) => r.text),
    };
    result.phases.index = index;
    save();
    log(`index ${label}: ${JSON.stringify(index[label])}`);
  }
  result.phases.index.dims = dims;
  result.phases.index.afterIndex = await sampleRss();
  void locations;

  // --- 7. semantic ranking (exact cosine; vectors are normalised) -------------------------------
  const rank = (label, v) =>
    vectors
      .get(label)
      .map((x) => {
        let dot = 0;
        for (let k = 0; k < v.length; k++) dot += v[k] * x.v[k];
        return { id: x.id, s: dot };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.id);
  result.semantic = {
    bench: Object.fromEntries(queries.bench.queries.map((q) => [q.id, rank('bench', qvec.get(q.id))])),
    households: Object.fromEntries(
      queries.households.queries.map((q) => [q.id, rank('households', qvec.get(q.id))]),
    ),
  };
  // The same scan in pgvector, for one query, as T14 would run it (exact, no index).
  const one = qvec.get(queries.bench.queries[0].id);
  const s2 = performance.now();
  const { rows: pgTop } = await db.query(
    `SELECT thing_id FROM public.spike_s65_embeddings e
      JOIN public.locations l ON l.id = e.location_id AND l.name = $2
     ORDER BY e.embedding <=> $1::vector LIMIT 10`,
    [`[${Array.from(one).join(',')}]`, queries.bench.location],
  );
  result.phases.pgvectorCheck = {
    ms: round(performance.now() - s2),
    sameTop10AsInMemory:
      JSON.stringify(pgTop.map((r) => r.thing_id)) ===
      JSON.stringify(result.semantic.bench[queries.bench.queries[0].id].slice(0, 10)),
  };
  await db.end();
  save();
  await finish(extractor, running);
}

async function finish(extractor, running) {
  // --- 8. unload -------------------------------------------------------------------------------
  await extractor.dispose();
  await sleep(2000);
  result.phases.disposed = await sampleRss();
  result.finished = new Date().toISOString();
  save();
  log(`disposed: ${JSON.stringify(result.phases.disposed)}`);
  await running.stop();
  process.exit(0);
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  save();
  console.error(err);
  process.exit(1);
});
