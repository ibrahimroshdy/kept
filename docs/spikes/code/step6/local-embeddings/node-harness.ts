/**
 * S6.5 (D207), re-run as a plain Node process on the laptop (arm64), after the Docker outage of
 * 2026-09-30: no image is built, no container runs. The coordinator's rules for the re-run: a plain
 * Node process, `--max-old-space-size`, under 500 MB of new disk.
 *
 * One process, as Kept runs it: Kept's web + worker (`KEPT_ROLE=all`, startKept from SOURCE under
 * tsx, so its idle RSS is an upper bound for the built image), then, lazily, the local model the
 * way T14's `local.ts` would load it (`intraOpNumThreads: 2` for the 2-core floor; macOS has no
 * cgroup, so the CPU limit is only the thread count). Phases: idle RSS unloaded → import → first
 * enable (download at the pinned revision, sha256 against model-granite97m.json) → added RSS →
 * query p95 → first index of 'Bench 10k' (vectors kept in memory) and the households → recall@10
 * and MRR@10 for keyword (Kept's own `search()`, as the location's member, under RLS), semantic
 * (exact cosine) and RRF (k = 60) → dispose.
 *
 * Needs the seeded `kept_spike6_local` (setup-db.ts). Run from apps/server:
 *   S65_DIR=<dir with node_modules/@huggingface/transformers> S65_MODELS=<download dir> \
 *   S65_OUT=<result.json> NODE_OPTIONS=--max-old-space-size=512 \
 *   node_modules/.bin/tsx ../../docs/spikes/code/step6/local-embeddings/node-harness.ts
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../../../../../apps/server');
const pg = createRequire(path.join(server, 'package.json'))('pg') as typeof import('pg');
const { loadEnv } = await import(path.join(server, 'src/config/env.ts'));
const { generateKey } = await import(path.join(server, 'src/crypto/envelope.ts'));
const { startKept } = await import(path.join(server, 'src/main.ts'));
const { createPools, closePools } = await import(path.join(server, 'src/db/pools.ts'));
const { withScope } = await import(path.join(server, 'src/db/scope.ts'));
const { search } = await import(path.join(server, 'src/search/service.ts'));
const { AR_ADJECTIVES, EN_ADJECTIVES } = await import(path.join(server, 'src/seed/words.ts'));

const S65_DIR = process.env.S65_DIR;
const MODELS = process.env.S65_MODELS;
const OUT = process.env.S65_OUT;
if (!S65_DIR || !MODELS || !OUT) throw new Error('set S65_DIR, S65_MODELS, S65_OUT');
const IDLE_S = Number(process.env.S65_IDLE ?? 30);
const BATCH = 32;

const DB = 'kept_spike6_local';
const url = (role: string) => `postgres://kept_${role}:kept_${role}@localhost:5452/${DB}`;
const manifest = JSON.parse(readFileSync(path.join(here, 'model-granite97m.json'), 'utf8'));
const queries = JSON.parse(readFileSync(path.join(here, 'queries.json'), 'utf8'));

const result: Record<string, unknown> = { started: new Date().toISOString(), arch: process.arch, node: process.version, model: { id: manifest.id, revision: manifest.revision, dtype: manifest.dtype, pooling: manifest.pooling }, phases: {} };
const phases = result.phases as Record<string, unknown>;
const save = () => writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
const log = (s: string) => process.stderr.write(`[s65 ${new Date().toISOString().slice(11, 19)}] ${s}\n`);
const MB = (b: number) => Math.round((b / 1048576) * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (x: number) => Math.round(x * 100) / 100;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
async function sampleRss(n = 10) {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(process.memoryUsage().rss);
    await sleep(1000);
  }
  xs.sort((a, b) => a - b);
  return { rssMedianMB: MB(xs[Math.floor(xs.length / 2)] ?? 0), rssMaxMB: MB(xs.at(-1) ?? 0), heapUsedMB: MB(process.memoryUsage().heapUsed) };
}
async function withPeak<T>(fn: () => Promise<T>) {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200);
  try {
    return { value: await fn(), peakMB: MB(Math.max(peak, process.memoryUsage().rss)) };
  } finally {
    clearInterval(t);
  }
}
async function sha256(file: string) {
  const h = createHash('sha256');
  await new Promise((res, rej) => createReadStream(file).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
  return h.digest('hex');
}
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// The embedding text (D200, T1 step 7): name, aliases, type, brand + model, notes, place path.
const THING_TEXT_SQL = `
  SELECT t.id, t.location_id, t.name,
         concat_ws(' · ', t.name,
           (SELECT string_agg(v, ', ') FROM jsonb_each(t.aliases) e,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END) v),
           (SELECT coalesce(ty.name, ty.search_names, (SELECT c.search_names FROM public.types c WHERE c.id = ty.copied_from_id))
              FROM public.types ty WHERE ty.id = t.type_id),
           nullif(concat_ws(' ', (SELECT b.name FROM public.brands b WHERE b.id = t.brand_id), t.model), ''),
           t.notes, t.place_path) AS text
    FROM public.things t JOIN public.locations l ON l.id = t.location_id
   WHERE t.deleted_at IS NULL AND l.id = ANY ($1::uuid[])
   ORDER BY t.id`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kept-s65n-'));
const env = await loadEnv({
  KEPT_DATABASE_URL: url('app'), KEPT_AUTH_DATABASE_URL: url('auth'), KEPT_SYSTEM_DATABASE_URL: url('system'),
  KEPT_SECRET_KEY: generateKey(), KEPT_AUTH_SECRET: generateKey(), KEPT_PUBLIC_URL: 'http://127.0.0.1:18766',
  KEPT_ROLE: 'all', KEPT_LOG_LEVEL: 'error', KEPT_CONFIG_DIR: path.join(tmp, 'config'), KEPT_DATA_DIR: path.join(tmp, 'data'),
});
const owner = new pg.Client({ connectionString: url('owner') });
await owner.connect();
const pools = createPools(env);

try {
  // 1. Kept, web + worker, the model not imported.
  let t = performance.now();
  const running = await startKept(env, { port: 18766, host: '127.0.0.1', webRoot: null, print: () => {} });
  phases.boot = { seconds: round((performance.now() - t) / 1000), role: 'all', note: 'from source under tsx: an upper bound for the built image' };
  log(`kept up; idle ${IDLE_S}s`);
  await sleep(IDLE_S * 1000);
  phases.idleUnloaded = await sampleRss();
  save();
  log(`idle unloaded ${JSON.stringify(phases.idleUnloaded)}`);

  // 2. import the runtime (its node entry, read from the package's exports).
  t = performance.now();
  // biome-ignore lint/suspicious/noExplicitAny: the runtime is loaded from outside the workspace, untyped here
  const tf: any = await import(pathToFileURL(path.join(S65_DIR, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
  phases.imported = { ms: round(performance.now() - t), ...(await sampleRss(5)) };
  log(`imported ${JSON.stringify(phases.imported)}`);

  // 3. first enable: download at the pinned revision into MODELS, verify.
  tf.env.cacheDir = MODELS;
  tf.env.allowLocalModels = false;
  t = performance.now();
  // biome-ignore lint/suspicious/noExplicitAny: untyped here (see the import above)
  const { value: extractor, peakMB: loadPeakMB }: { value: any; peakMB: number } = await withPeak(() =>
    tf.pipeline('feature-extraction', manifest.id, { revision: manifest.revision, dtype: manifest.dtype, cache_dir: MODELS, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } }),
  );
  const loadSeconds = round((performance.now() - t) / 1000);
  const checks = [];
  for (const f of walk(MODELS)) {
    const rel = path.relative(MODELS, f);
    // Match whole path segments: `tokenizer_config.json` must not match `config.json`.
    const want = manifest.files.find((m: { path: string }) => rel === m.path || rel.endsWith(`/${m.path}`));
    const got = await sha256(f);
    checks.push({ file: rel, bytes: statSync(f).size, ok: want ? want.sha256 === got : null });
  }
  phases.download = { secondsIncludingLoad: loadSeconds, files: checks, allVerified: checks.every((c) => c.ok === true) };
  save();
  log(`downloaded + loaded ${loadSeconds}s verified=${(phases.download as { allVerified: boolean }).allVerified}`);

  const embed = async (texts: string[]) => {
    const o = await extractor(texts, { pooling: manifest.pooling, normalize: true });
    const [n, d] = o.dims as [number, number];
    return Array.from({ length: n }, (_, i) => Float32Array.from((o.data as Float32Array).subarray(i * d, (i + 1) * d)));
  };
  for (let i = 0; i < 5; i++) await embed([`warm up ${i}`]);
  const loaded = { loadPeakMB, ...(await sampleRss()) };
  phases.loaded = { ...loaded, addedOverIdleMB: round(loaded.rssMedianMB - (phases.idleUnloaded as { rssMedianMB: number }).rssMedianMB) };
  save();
  log(`loaded ${JSON.stringify(phases.loaded)}`);

  // 4. query latency, one query at a time, two passes.
  const all = [...queries.bench.queries, ...queries.households.queries] as { id: string; q: string; locale: string }[];
  const lat: number[] = [];
  const qvec = new Map<string, Float32Array>();
  for (let pass = 0; pass < 2; pass++) {
    for (const q of all) {
      const s = performance.now();
      const [v] = await embed([q.q]);
      lat.push(performance.now() - s);
      if (v) qvec.set(q.id, v);
    }
  }
  phases.query = { n: lat.length, p50ms: round(pct(lat, 50)), p95ms: round(pct(lat, 95)), p99ms: round(pct(lat, 99)), maxms: round(Math.max(...lat)) };
  save();
  log(`query ${JSON.stringify(phases.query)}`);

  // 5. first index (the people and locations the scores use are resolved first).
  const userFor = async (loc: string, roles: string[]) => (await owner.query<{ user_id: string }>('SELECT user_id FROM public.memberships WHERE location_id = $1 AND role = ANY($2::text[]) ORDER BY role LIMIT 1', [loc, roles])).rows[0]?.user_id;
  const benchId = (await owner.query<{ id: string }>('SELECT id FROM public.locations WHERE name = $1', [queries.bench.location])).rows[0]?.id as string;
  const benchUser = await userFor(benchId, ['member']);
  const homeLoc = (await owner.query<{ id: string }>("SELECT id FROM public.locations WHERE name = 'Home'")).rows[0]?.id as string;
  const ibrahim = await userFor(homeLoc, ['owner']);
  // By membership, not by name alone: every user has a location called "Personal".
  const locIds = async (names: string[], userId: string) =>
    (await owner.query<{ id: string }>('SELECT l.id FROM public.locations l JOIN public.memberships m ON m.location_id = l.id AND m.user_id = $2 WHERE l.name = ANY($1::text[])', [names, userId])).rows.map((r) => r.id);
  const benchLoc = await locIds([queries.bench.location], benchUser as string);
  const homeLocs = await locIds(queries.households.locations, ibrahim as string);
  result.locations = { bench: benchLoc.length, households: homeLocs.length };
  const vectors = new Map<string, { id: string; name: string; v: Float32Array }[]>();
  const index: Record<string, unknown> = {};
  for (const [label, ids] of [['bench', benchLoc], ['households', homeLocs]] as [string, string[]][]) {
    const { rows } = await owner.query<{ id: string; name: string; text: string }>(THING_TEXT_SQL, [ids]);
    const store: { id: string; name: string; v: Float32Array }[] = [];
    const s = performance.now();
    const { peakMB } = await withPeak(async () => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const vs = await embed(batch.map((r) => r.text));
        batch.forEach((r, k) => store.push({ id: r.id, name: r.name, v: vs[k] as Float32Array }));
        if ((i / BATCH) % 60 === 0) log(`  ${label} ${i + batch.length}/${rows.length}`);
      }
    });
    vectors.set(label, store);
    const secs = (performance.now() - s) / 1000;
    index[label] = { things: rows.length, seconds: round(secs), thingsPerSecond: round(rows.length / secs), peakMB, sample: rows.slice(0, 2).map((r) => r.text) };
    phases.index = index;
    save();
    log(`index ${label} ${JSON.stringify(index[label])}`);
  }

  // 6. rankings and scores.
  const semantic = (label: string, v: Float32Array) =>
    (vectors.get(label) ?? [])
      .map((x) => {
        let dot = 0;
        for (let k = 0; k < v.length; k++) dot += (v[k] ?? 0) * (x.v[k] ?? 0);
        return { id: x.id, s: dot };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.id);
  const keyword = async (userId: string, locs: string[], q: string) =>
    withScope(pools.app, { userId, mfa: true }, async (tx: unknown, client: unknown) => {
      const r = await search(tx, client, { userId, mfa: true }, null, { q, locationId: locs, kind: 'things', limit: 50 });
      return (r.things.items as { id: string }[]).map((i) => i.id);
    });
  const rrf = (a: string[], b: string[], k = 60) => {
    const s = new Map<string, number>();
    a.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)));
    b.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)));
    return [...s.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  };
  const score = (ranked: string[], relevant: Set<string>) => {
    const top = ranked.slice(0, 10);
    const hit = top.filter((id) => relevant.has(id)).length;
    const first = top.findIndex((id) => relevant.has(id));
    return { recall: relevant.size ? hit / Math.min(10, relevant.size) : 0, mrr: first >= 0 ? 1 / (first + 1) : 0 };
  };
  const adjectives = new Set([...EN_ADJECTIVES, ...AR_ADJECTIVES].map((a: string) => a.toLowerCase()));
  const nounOf = (name: string) => name.split(' ').filter((w) => !adjectives.has(w.toLowerCase())).join(' ').toLowerCase();
  const rows: Record<string, unknown>[] = [];
  for (const q of queries.bench.queries as { id: string; q: string; locale: string; concepts: string[]; kind: string }[]) {
    const nouns = new Set(q.concepts.flatMap((c) => [...(queries.bench.concepts[c]?.en ?? []), ...(queries.bench.concepts[c]?.ar ?? [])]).map((n: string) => n.toLowerCase()));
    const relevant = new Set((vectors.get('bench') ?? []).filter((x) => nouns.has(nounOf(x.name ?? ''))).map((x) => x.id));
    const kw = await keyword(benchUser as string, benchLoc, q.q);
    const sem = semantic('bench', qvec.get(q.id) as Float32Array);
    rows.push({ part: 'bench', id: q.id, locale: q.locale, kind: q.kind, relevant: relevant.size, keyword: score(kw, relevant), semantic: score(sem, relevant), rrf: score(rrf(kw, sem), relevant) });
  }
  for (const q of queries.households.queries as { id: string; q: string; locale: string; expect: string[]; kind: string }[]) {
    const want = new Set(q.expect);
    const relevant = new Set((vectors.get('households') ?? []).filter((x) => want.has(x.name)).map((x) => x.id));
    const kw = await keyword(ibrahim as string, homeLocs, q.q);
    const sem = semantic('households', qvec.get(q.id) as Float32Array);
    rows.push({ part: 'households', id: q.id, locale: q.locale, kind: q.kind, relevant: relevant.size, keyword: score(kw, relevant), semantic: score(sem, relevant), rrf: score(rrf(kw, sem), relevant) });
  }
  const summary: Record<string, unknown> = {};
  for (const part of ['bench', 'households']) {
    for (const locale of ['ar', 'en']) {
      const xs = rows.filter((r) => r.part === part && r.locale === locale) as { keyword: { recall: number; mrr: number }; semantic: { recall: number; mrr: number }; rrf: { recall: number; mrr: number } }[];
      const avg = (f: (r: (typeof xs)[number]) => number) => round(xs.reduce((a, r) => a + f(r), 0) / Math.max(1, xs.length));
      summary[`${part}.${locale}`] = { n: xs.length, recall10: { keyword: avg((r) => r.keyword.recall), semantic: avg((r) => r.semantic.recall), rrf: avg((r) => r.rrf.recall) }, mrr10: { keyword: avg((r) => r.keyword.mrr), semantic: avg((r) => r.semantic.mrr), rrf: avg((r) => r.rrf.mrr) } };
    }
  }
  result.scores = summary;
  result.perQuery = rows;
  save();
  log(`scores ${JSON.stringify(summary)}`);

  // 7. dispose.
  await extractor.dispose();
  await sleep(2000);
  phases.disposed = await sampleRss();
  result.finished = new Date().toISOString();
  save();
  await running.stop();
} finally {
  await owner.end();
  await closePools(pools);
}
process.exit(0);
