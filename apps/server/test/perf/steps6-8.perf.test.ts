import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerKeyAad } from '../../src/ai/db-keys.js';
import { createAiDeps } from '../../src/ai/routes.js';
import { type Keyring, seal } from '../../src/crypto/envelope.js';
import { fixedSecretKeys, keyringOf } from '../../src/crypto/keyring.js';
import { runBackfill } from '../../src/embeddings/backfill.js';
import { buildExport } from '../../src/exports/job.js';
import type { ExportRunView } from '../../src/exports/service.js';
import { homeboxImportJobs } from '../../src/imports/homebox/job.js';
import { runJob } from '../../src/jobs/boss.js';
import { packageRoot } from '../../src/package-root.js';
import type { TestApp } from '../app.js';
import { homeboxZip, uploadArchive } from '../archive-imports.js';
import { type TestDb, testDb } from '../db.js';
import { type TestFiles, testFiles } from '../files.js';
import { call, type Person, peopleApp, type RecordedJob } from '../people.js';
import { createLocation, type Loc, ok, own } from '../things.js';
import { seedHousehold, THINGS } from './household.js';
import { timed } from './timing.js';

// Steps 6–8's performance checks (the final check for steps 5–8; step-6 plan T26 "Perf", step-7
// plan T25 "Perf"), full mode only: scripts/ci-local.sh `perf`, and
// `pnpm --filter @kept/server exec vitest run --config vitest.perf.config.ts test/perf/steps6-8.perf.test.ts`.
//
// The fixture is step 4's household (test/perf/household.ts: Home with 10,000 things in 20 places,
// 2,000 warranties, 500 schedules, 300 loans, 200 documents), with
// - Home's account given an embeddings model (the mock provider: KEPT_AI_MOCK's concept vectors,
//   never a real one) and every thing embedded by the backfill, as the worker would;
// - MCP switched on in Home, and a read token of Louis's for it.
//
// The checks, and their limits:
// - Search at 10,000 things, keywords only (a word one name has, never embedded) and with meaning
//   fused in (a sentence, embedded by the mock): p95 < 300 ms each (§3.1's search budget; step-6
//   plan T14's "search p95 < 300 ms at 10,000 things with embeddings"). The same with a word all
//   10,000 names share ("Thing") is recorded beside it, without a limit: every row then matches
//   and is ranked.
// - MCP `tools/call where_is` through the official client, the token verified on every request:
//   p95 recorded; limited at §3.1's 300 ms read budget (the plan names no figure of its own).
// - The Kept export of Home (10,000 things, the default options: history, the readable copy; its
//   PDF is left out past 2,000 things), built as the worker builds it: time, ZIP size and the
//   process's RSS growth recorded; limited at 10 minutes.
// - The Homebox import of the committed v0.26.2 `home` fixture into a new location: upload,
//   inspect and dry run, then the job: times recorded; limited at 2 minutes.
// The requests go through the app in-process (fastify inject): server time, no network.

const LIMITS = {
  searchP95Ms: 300,
  mcpWhereIsP95Ms: 300,
  exportMaxMs: 600_000,
  homeboxImportMaxMs: 120_000,
};
const WARMUP = 5;
const RUNS = 50;
const MASTER = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const keyring: Keyring = new Map([[1, MASTER.key]]);
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const secretKeys = fixedSecretKeys(
  keyringOf({ version: 1, key: randomBytes(32), retired: new Map() }),
);
const PUBLIC_URL = 'https://kept.example';
const TEST_MS = 300_000;
// The fixture names every thing "Thing NNNNN": RARE matches one name, SHARED has a word that all
// 10,000 share (the worst case for ranking, recorded without a limit).
const RARE = '04217';
const SHARED = 'Thing 04217';

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let louis: Person;
let home: Loc;
let client: Client;
const results: Record<string, unknown> = {};

const ai = () =>
  createAiDeps({
    pools: db.pools,
    keyring: () => keyring,
    log: silent,
    mock: true,
    overrides: {
      fetch: (() => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
    },
  });

const mb = (n: number) => Math.round(n / 1024 / 1024);

/** fetch() into the app, as src/mcp/mcp.test.ts does. */
function injectFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    headers.host = url.host;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const res = await t.app.inject({
      method: req.method as 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(body ? { payload: body } : {}),
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [String(v)]) out.append(k, one);
    }
    return new Response(
      res.statusCode === 202 || res.statusCode === 204 ? null : new Uint8Array(res.rawPayload),
      { status: res.statusCode, headers: out },
    );
  }) as typeof fetch;
}

type SearchBody = {
  things: { items: { id: string; name: string; matchedBy?: string }[] };
  semantic?: { state: string } | null;
};
const search = async (q: string): Promise<SearchBody> =>
  ok(
    await call(t, `/api/v1/search?kind=things&q=${encodeURIComponent(q)}`, { as: ibrahim }),
  ) as unknown as SearchBody;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files, ai: ai(), secretKeys, publicUrl: PUBLIC_URL });
  const fixture = await seedHousehold(db, t);
  ibrahim = fixture.ibrahim;
  louis = fixture.louis;
  home = fixture.home;

  // An embeddings model on Home's account (the mock provider answers it), then the backfill.
  const providerId = crypto.randomUUID();
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext, key_version,
                                      models, created_by)
     VALUES ($1, 'account', $2, 'openai', $3, 1, $4, $5)`,
    [
      providerId,
      home.accountId,
      JSON.stringify(seal(MASTER, 'sk-TESTKEY', providerKeyAad(providerId))),
      JSON.stringify({ chat: 'gpt-chat', embeddings: 'text-embedding-3-small' }),
      ibrahim.userId,
    ],
  );
  // The hourly backfill takes BATCHES_PER_LOCATION batches a run: run it until all are embedded.
  const embeddedCount = async () =>
    (
      await own<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM public.thing_embeddings e
           JOIN public.things x ON x.id = e.thing_id WHERE x.location_id = $1`,
        [home.id],
      )
    )[0]?.n ?? 0;
  const started = performance.now();
  let runs = 0;
  let embedded = 0;
  for (; runs < 10 && embedded < THINGS; runs++) {
    await runBackfill({ pools: db.pools, ai: ai(), keyring: () => keyring, log: silent });
    embedded = await embeddedCount();
  }
  results.backfill = { things: embedded, runs, ms: Math.round(performance.now() - started) };

  // MCP on in Home, and Louis's read token for it.
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled, enabled_at)
     VALUES ($1, 'mcp', true, now())
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = true, enabled_at = now()`,
    [home.id],
  );
  const { secret } = ok(
    await call(t, '/api/v1/tokens', {
      as: louis,
      body: { name: 'perf token', scope: 'read', locationIds: [home.id] },
    }),
    201,
  ) as unknown as { secret: string };
  client = new Client(
    { name: 'kept-perf', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
      fetch: injectFetch(),
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    }),
  );
  await own(db, 'ANALYZE');
  results.fixture = fixture.counted;
}, 1_800_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await t?.app.close();
  await files?.cleanup();
  const dir = path.join(packageRoot(), '../../.tmp/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'steps6-8.json');
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`steps6-8 perf: ${JSON.stringify(results)} → ${file}`);
});

describe('steps 6–8 performance (final check, full mode only)', () => {
  it(`embeds all ${THINGS} things in the backfill`, () => {
    expect((results.backfill as { things: number }).things).toBe(THINGS);
  });

  it(
    `searches ${THINGS} things by keyword with p95 under ${LIMITS.searchP95Ms} ms`,
    async () => {
      const first = await search(RARE);
      expect(first.things.items.map((x) => x.name)).toContain('Thing 04217');
      const s = await timed(WARMUP, RUNS, async () => {
        await search(RARE);
      });
      results.searchKeyword = { q: RARE, ...s };
      // Recorded, not limited: a word that every one of the 10,000 names shares.
      results.searchKeywordEveryRow = {
        q: SHARED,
        ...(await timed(WARMUP, RUNS, async () => {
          await search(SHARED);
        })),
      };
      expect(s.p95).toBeLessThan(LIMITS.searchP95Ms);
    },
    TEST_MS,
  );

  it(
    `searches ${THINGS} embedded things with meaning fused in, p95 under ${LIMITS.searchP95Ms} ms`,
    async () => {
      const q = 'the cable for the TV';
      const first = await search(q);
      // Meaning was asked for and not refused: the state is not keyword-only.
      expect(first.semantic?.state).not.toBe('keyword_only');
      const s = await timed(WARMUP, RUNS, async () => {
        await search(q);
      });
      results.searchSemantic = {
        ...s,
        semantic: first.semantic ?? null,
        results: first.things.items.length,
        q,
        byMeaning: first.things.items.filter((x) => x.matchedBy === 'meaning').length,
      };
      // Recorded, not limited: the sentence has a word every name shares ("thing").
      results.searchSemanticEveryRow = {
        q: 'the thing for the TV',
        ...(await timed(WARMUP, RUNS, async () => {
          await search('the thing for the TV');
        })),
      };
      expect(s.p95).toBeLessThan(LIMITS.searchP95Ms);
    },
    TEST_MS,
  );

  it(
    `calls the MCP tool where_is with p95 under ${LIMITS.mcpWhereIsP95Ms} ms`,
    async () => {
      const tools = (await client.listTools()).tools.map((x) => x.name);
      expect(tools).toContain('where_is');
      const once = (query: string) => async () => {
        const res = await client.callTool({ name: 'where_is', arguments: { query } });
        expect(res.isError ?? false).toBe(false);
      };
      const s = await timed(WARMUP, RUNS, once(RARE));
      results.mcpWhereIs = { q: RARE, ...s };
      results.mcpWhereIsEveryRow = { q: SHARED, ...(await timed(WARMUP, RUNS, once(SHARED))) };
      expect(s.p95).toBeLessThan(LIMITS.mcpWhereIsP95Ms);
    },
    TEST_MS,
  );

  it(`exports Home (${THINGS} things) in under ${LIMITS.exportMaxMs / 1000} s`, async () => {
    const res = await call(t, '/api/v1/exports', {
      as: ibrahim,
      body: { scope: { locationId: home.id }, options: { aiCalls: false } },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { id } = res.json() as ExportRunView;
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 100);
    const started = performance.now();
    try {
      const outcome = await buildExport(
        { pools: db.pools, files, secretKeys, publicUrl: PUBLIC_URL, log: silent },
        { userId: ibrahim.userId, mfa: false },
        { exportId: id },
      );
      expect(outcome.status).toBe('done');
    } finally {
      clearInterval(sampler);
    }
    const ms = Math.round(performance.now() - started);
    const view = ok(await call(t, `/api/v1/exports/${id}`, { as: ibrahim })) as unknown as {
      status: string;
      bytes?: number;
    };
    expect(view.status).toBe('done');
    results.export = {
      ms,
      zipMb: Math.round(((view.bytes ?? 0) / 1024 / 1024) * 10) / 10,
      rssBeforeMb: mb(rssBefore),
      rssPeakMb: mb(rssPeak),
    };
    expect(ms).toBeLessThan(LIMITS.exportMaxMs);
  }, 900_000);

  it(`imports the Homebox v0.26.2 home fixture in under ${LIMITS.homeboxImportMaxMs / 1000} s`, async () => {
    const target = await createLocation(t, db, ibrahim, 'complete', 'Imported');
    const zip = await homeboxZip('home');
    const started = performance.now();
    const id = await uploadArchive(t, ibrahim, zip);
    ok(
      await call(t, `/api/v1/imports/${id}/target`, {
        as: ibrahim,
        body: { locationId: target.id },
      }),
    );
    ok(await call(t, `/api/v1/imports/${id}/inspect`, { as: ibrahim, body: {} }));
    const run = ok(await call(t, `/api/v1/imports/${id}`, { as: ibrahim }));
    ok(
      await call(t, `/api/v1/imports/${id}/choices`, {
        as: ibrahim,
        headers: { 'if-match': String(run.rowVersion) },
        body: {
          choices: {
            archived: 'skip',
            currency: 'EGP',
            quantityRounding: 'keep_note',
            fields: {},
            types: {},
            insured: 'field',
            seeded: 'skip_unused',
          },
        },
      }),
    );
    ok(await call(t, `/api/v1/imports/${id}/dry-run`, { as: ibrahim, body: {} }));
    const prepared = performance.now();
    const res = await call(t, `/api/v1/imports/${id}/run`, { as: ibrahim, body: {} });
    expect(res.statusCode, res.body).toBe(202);
    const job = homeboxImportJobs({
      pools: db.pools,
      mailer: { send: async () => {} },
      publicUrl: PUBLIC_URL,
      log: silent,
      files,
      sendTenant: async () => {},
    }).find((j) => j.name === 'import-homebox');
    if (!job) throw new Error('no import-homebox job');
    await runJob(job, { userId: ibrahim.userId, mfa: false, data: { runId: id } }, db.pools);
    const done = performance.now();
    const status = (
      await own<{ status: string }>(db, 'SELECT status FROM public.import_runs WHERE id = $1', [id])
    )[0]?.status;
    expect(status).toBe('done');
    const things = (
      await own<{ n: number }>(
        db,
        'SELECT count(*)::int AS n FROM public.things WHERE location_id = $1',
        [target.id],
      )
    )[0]?.n;
    results.homeboxImport = {
      zipKb: Math.round(zip.length / 1024),
      things,
      prepareMs: Math.round(prepared - started),
      jobMs: Math.round(done - prepared),
      totalMs: Math.round(done - started),
    };
    expect(done - started).toBeLessThan(LIMITS.homeboxImportMaxMs);
  }, 300_000);
});
