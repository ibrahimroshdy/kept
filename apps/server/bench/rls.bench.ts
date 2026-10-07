#!/usr/bin/env tsx
/**
 * The RLS benchmark at 10,000 things (plan task 24; master plan risk #3, "RLS cost on a Pi").
 *
 *   pnpm --filter @kept/server bench                  unconstrained, the dev Postgres on 5452
 *   pnpm --filter @kept/server bench:pi               the gate: a Postgres container of its own
 *                                                     on 5462 (--cpus 1, --memory 1g) and node
 *                                                     with a 512 MB heap
 *   pnpm --filter @kept/server bench:pi-speed         a slower-core proxy (docs/perf): the
 *                                                     container at --cpus 0.3, and node on the
 *                                                     efficiency cores (macOS `taskpolicy -b`)
 *
 * Options (after `--`): --things N (10000), --runs N (200), --warmup N (20), --write-runs N (30),
 * --pi-cpus N (implies --pi), --out <file.json>, --keep (leave the scratch database and
 * container), --db <name> (reuse a kept scratch database: no create or migrate; the seed finds
 * everything and adds nothing), --no-explain, --snapshot-only (only the sync snapshot, T12).
 *
 * What it does, in order:
 * 1. Creates its own scratch database (`kept_bench_<id>`, never the dev `kept`), migrates it as
 *    kept_owner and seeds `kept admin seed --scenario bench` into it (seed/bench.ts).
 * 2. Starts the real server (main.ts startKept: pg-boss for enqueues, local file storage, Better
 *    Auth) on a loopback port, with KEPT_ROLE=web so no job worker competes with the timings.
 * 3. Signs in the scenario's three actors (owner, a member and a viewer of all three locations)
 *    and times each hot path over real HTTP: 20 warm-ups, then 200 timed runs, one request at a
 *    time. Writes (move preview, a 200-thing move within a location and across locations, tags)
 *    run for the owner and the member only; a viewer can't write.
 * 4. Traces the SQL of one run of every read path (a wrapper on pg's Client.query, in-process),
 *    and EXPLAIN (ANALYZE, BUFFERS, VERBOSE)es the slowest statements of each as kept_app in the
 *    actor's scope (app.user_id), checking that the RLS helper functions ran once per statement
 *    (the node calling kept.visible_location_ids() and its siblings ran loops=1: an InitPlan or
 *    a hashed SubPlan, never a SubPlan per row) and listing sequential scans.
 * 5. Prints a markdown table (p50/p95/p99/max per path and actor, against the budgets) and writes
 *    the full result, plans included, to --out (after every path, so a cut-off run keeps what it
 *    measured). Drops the database and removes the container. Exits 1 on a budget miss or a
 *    helper run per row.
 *
 * Move previews are limited to 60 a minute per person (review #27), so that path takes 5
 * warm-ups and 50 runs whatever --runs says. There is no bulk-tag route in step 2: the bulk tag
 * is 20 PATCHes, as a client makes it today.
 *
 * Budgets (engineering spec §3.1, plan T24; the Pi targets): page loads and search p95 < 300 ms,
 * the thing page p95 < 200 ms, moving 200 things p95 < 1 s, and the offline snapshot of all
 * 10,000 things, every page of it, < 2 s (§3.1, D209; step-3 plan T12). The laptop gates of plan
 * T24 (and T12's 600 ms for the snapshot) are printed beside them for the unconstrained pass.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import pg from 'pg';
import pino from 'pino';
import { loadEnv } from '../src/config/env.js';
import { generateKey } from '../src/crypto/envelope.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePools, createPools } from '../src/db/pools.js';
import { startKept } from '../src/main.js';
import { SEED_PASSWORD } from '../src/seed/cast.js';
import { assertSeedAllowed, runSeed } from '../src/seed/index.js';

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

type Options = {
  pi: boolean;
  /** The Pi container's CPU quota, in CPUs (docker --cpus). */
  piCpus: string;
  things: number;
  runs: number;
  warmup: number;
  writeRuns: number;
  out: string | null;
  keep: boolean;
  db: string | null;
  explain: boolean;
  snapshotOnly: boolean;
};

function parseArgs(argv: string[]): Options {
  const o: Options = {
    pi: false,
    piCpus: '1',
    things: 10_000,
    runs: 200,
    warmup: 20,
    writeRuns: 30,
    out: null,
    keep: false,
    db: null,
    explain: true,
    snapshotOnly: false,
  };
  const num = (v: string | undefined, name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--pi') o.pi = true;
    else if (a === '--pi-cpus') {
      o.pi = true;
      o.piCpus = String(Number(argv[++i]));
      if (!(Number(o.piCpus) > 0)) throw new Error('--pi-cpus needs a number of CPUs');
    } else if (a === '--keep') o.keep = true;
    else if (a === '--no-explain') o.explain = false;
    else if (a === '--snapshot-only') o.snapshotOnly = true;
    else if (a === '--things') o.things = num(argv[++i], a);
    else if (a === '--runs') o.runs = num(argv[++i], a);
    else if (a === '--warmup') o.warmup = num(argv[++i], a);
    else if (a === '--write-runs') o.writeRuns = num(argv[++i], a);
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--db') o.db = argv[++i] ?? null;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const log = (line: string) => process.stderr.write(`${line}\n`);

// ---------------------------------------------------------------------------------------------
// Database: the dev server (5452) or a Pi-class container of the benchmark's own (5462)
// ---------------------------------------------------------------------------------------------

const DEV_PORT = 5452;
const PI_PORT = 5462;
const PI_CONTAINER = 'kept-bench-db';
const piLimits = (cpus: string) => ['--cpus', cpus, '--memory', '1g', '--memory-swap', '1g'];

const superUrl = (port: number) => `postgres://postgres:postgres@localhost:${port}/postgres`;
const roleUrl = (role: string, port: number, db: string) =>
  `postgres://kept_${role}:kept_${role}@localhost:${port}/${db}`;

/** The Postgres image compose.dev.yaml pins, so the container is the dev database's twin. */
function devImage(): string {
  const compose = readFileSync(path.join(repo, 'compose.dev.yaml'), 'utf8');
  const image = /^\s+image:\s*(pgvector\/pgvector:\S+)/m.exec(compose)?.[1];
  if (!image) throw new Error('no pgvector image in compose.dev.yaml');
  return image;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    // Captured, not printed: the pre-clean `rm -f` of a container that isn't there is expected.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? '/tmp/kept-docker-config' },
  }).trim();
}

async function startPiContainer(cpus: string): Promise<void> {
  try {
    docker(['rm', '-f', PI_CONTAINER]);
  } catch {
    // none left over
  }
  // An anonymous volume (removed with --rm), the dev init script (roles, extensions), the same
  // image as the dev database; the limits are the container's, not the shared dev database's.
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    PI_CONTAINER,
    ...piLimits(cpus),
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=kept',
    '-e',
    'TZ=UTC',
    '-p',
    `${PI_PORT}:5432`,
    '-v',
    `${path.join(repo, 'docker/initdb')}:/docker-entrypoint-initdb.d:ro`,
    devImage(),
  ]);
  // TCP answers only after the entrypoint's init (which listens on the socket alone) is done.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const c = new pg.Client({ connectionString: superUrl(PI_PORT) });
    try {
      await c.connect();
      const { rows } = await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'kept_system'");
      await c.end();
      if (rows.length === 1) return;
    } catch {
      await c.end().catch(() => {});
    }
    if (Date.now() > deadline) throw new Error(`${PI_CONTAINER} did not come up`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function stopPiContainer(): void {
  try {
    docker(['rm', '-f', PI_CONTAINER]);
  } catch (err) {
    log(`could not remove ${PI_CONTAINER}: ${(err as Error).message}`);
  }
}

async function asSuper<T>(port: number, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superUrl(port) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function serverFacts(port: number) {
  return asSuper(port, async (c) => {
    const setting = async (name: string) =>
      (await c.query<{ s: string }>(`SELECT current_setting($1) AS s`, [name])).rows[0]?.s;
    return {
      version: (await c.query<{ v: string }>('SELECT version() AS v')).rows[0]?.v,
      shared_buffers: await setting('shared_buffers'),
      work_mem: await setting('work_mem'),
      effective_cache_size: await setting('effective_cache_size'),
      jit: await setting('jit'),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// SQL trace (in-process: startKept's pools use this module's pg)
// ---------------------------------------------------------------------------------------------

type Traced = { text: string; values: unknown[]; ms: number };
let trace: Traced[] | null = null;

function installTrace(): void {
  const proto = pg.Client.prototype as unknown as {
    query: (...args: unknown[]) => unknown;
    connectionParameters?: { application_name?: string };
  };
  const original = proto.query;
  proto.query = function traced(this: typeof proto, ...args: unknown[]) {
    const sink = trace;
    const app = this.connectionParameters?.application_name;
    const result = original.apply(this, args);
    if (!sink || app !== 'kept-app' || !(result instanceof Promise)) return result;
    const first = args[0];
    const text =
      typeof first === 'string' ? first : ((first as { text?: string } | null)?.text ?? '');
    const values =
      (Array.isArray(args[1]) ? args[1] : (first as { values?: unknown[] } | null)?.values) ?? [];
    const started = performance.now();
    return result.then((r: unknown) => {
      sink.push({ text, values, ms: performance.now() - started });
      return r;
    });
  };
}

const EXPLAINABLE = /^\s*(SELECT|WITH)\b/i;
/** The RLS helper functions (0006, 0012): SECURITY DEFINER, so never inlined. */
const HELPER = /kept\.((?:visible|writable|admin)_(?:location|account)_ids)\(\)/;

/** Per helper, the most times one plan node calling it ran (EXPLAIN VERBOSE's `Output:` names
 * the call under its ProjectSet or Function Scan node). 1 means once per statement: an InitPlan
 * or a hashed SubPlan. More means a SubPlan re-run per row. */
function helperLoops(plan: string): Record<string, number> {
  const lines = plan.split('\n');
  const out: Record<string, number> = {};
  for (const [i, line] of lines.entries()) {
    if (!/ProjectSet|Function Scan|Result/.test(line)) continue;
    const loops = /loops=(\d+)/.exec(line)?.[1];
    const output = lines[i + 1] ?? '';
    const name = /^\s*Output: /.test(output) ? HELPER.exec(output)?.[1] : undefined;
    if (!name) continue;
    out[name] = Math.max(out[name] ?? 0, loops ? Number(loops) : 0);
  }
  return out;
}

type PlanCheck = {
  statement: string;
  ms: number;
  helperLoops: Record<string, number>;
  onceEach: boolean;
  /** Filters comparing a scope column to a SubPlan that is not hashed (run per row). */
  perRowSubPlans: number;
  initPlan: boolean;
  hashedSubPlan: boolean;
  seqScans: string[];
  indexes: string[];
  executionMs: number | null;
  plan: string;
};

async function explain(url: string, userId: string, t: Traced): Promise<PlanCheck> {
  const c = new pg.Client({ connectionString: url, application_name: 'kept-bench-explain' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.mfa', 'false', true)",
      [userId],
    );
    const { rows } = await c.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${t.text}`,
      t.values,
    );
    await c.query('ROLLBACK');
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const loops = helperLoops(plan);
    const perRowSubPlans = [...plan.matchAll(/(?:location_id|owner_account_id) = \(SubPlan \d+\)/g)]
      .length;
    return {
      statement: t.text.replace(/\s+/g, ' ').trim(),
      ms: Math.round(t.ms * 100) / 100,
      helperLoops: loops,
      onceEach: Object.values(loops).every((n) => n <= 1) && perRowSubPlans === 0,
      perRowSubPlans,
      initPlan: /InitPlan/.test(plan),
      hashedSubPlan: /hashed SubPlan/.test(plan),
      seqScans: [...plan.matchAll(/Seq Scan on (?:\w+\.)?(\w+)/g)].map((m) => m[1] as string),
      indexes: [
        ...new Set(
          [
            ...plan.matchAll(
              /(?:Index Scan|Index Only Scan|Bitmap Index Scan) (?:using |on )(\w+)/g,
            ),
          ].map((m) => m[1] as string),
        ),
      ],
      executionMs: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? Number.NaN) || null,
      plan,
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

class Http {
  constructor(
    readonly base: string,
    readonly cookie = '',
  ) {}

  async call(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Json; ms: number; setCookie: string[] }> {
    const started = performance.now();
    const res = await fetch(this.base + url, {
      method,
      headers: {
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Json) : {},
      ms,
      setCookie: res.headers.getSetCookie(),
    };
  }

  async ok(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    const r = await this.call(method, url, body, headers);
    if (r.status < 200 || r.status > 299) {
      throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    }
    return r;
  }
}

async function signIn(base: string, email: string): Promise<Http> {
  const r = await new Http(base).call('POST', '/api/v1/auth/sign-in/email', {
    email,
    password: SEED_PASSWORD,
  });
  if (r.status !== 200) throw new Error(`sign-in ${email}: ${r.status}`);
  const cookie = r.setCookie
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair && !pair.endsWith('='))
    .join('; ');
  return new Http(base, cookie);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

type Actor = 'owner' | 'member' | 'viewer';
type Kind = 'page' | 'search' | 'thing' | 'move' | 'write' | 'snapshot';

type Stat = {
  path: string;
  actor: Actor;
  kind: Kind;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  budget: number | null;
  laptopGate: number | null;
  pass: boolean | null;
  error?: string;
};

/** Nearest-rank percentile of sorted samples. */
function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? Number.NaN;
}

const BUDGET: Record<Kind, number | null> = {
  page: 300,
  search: 300,
  thing: 200,
  move: 1000,
  write: 300,
  snapshot: 2000,
};

/** Plan T24's dev-laptop gates, by path. */
const LAPTOP_GATE: Record<string, number> = {
  'search: hdmi': 100,
  'search: Arabic': 100,
  'search: typo': 100,
  'search: serial': 100,
  'thing page': 60,
  'place contents: 200-thing room': 80,
  'things list: global, 3 locations': 80,
  'sync snapshot: full, every page': 600,
};

function summarise(pathName: string, actor: Actor, kind: Kind, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  const budget = BUDGET[kind];
  const p95 = pct(s, 95);
  return {
    path: pathName,
    actor,
    kind,
    n: s.length,
    p50: r(pct(s, 50)),
    p95: r(p95),
    p99: r(pct(s, 99)),
    max: r(s[s.length - 1] ?? Number.NaN),
    budget,
    laptopGate: LAPTOP_GATE[pathName] ?? null,
    pass: budget === null ? null : p95 < budget,
  };
}

type Step = { name: string; kind: Kind; run: (i: number) => Promise<number> };

/** Called after every measurement (main writes the results so far to --out). */
let checkpoint: (stat: Stat) => void = () => {};

/** Warm-ups, then timed runs, one request at a time. A path that fails is recorded with its
 * error (and counts as a miss) instead of ending the whole run. */
async function measure(step: Step, actor: Actor, warmup: number, runs: number): Promise<Stat> {
  let stat: Stat;
  try {
    for (let i = 0; i < warmup; i++) await step.run(i);
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) samples.push(await step.run(warmup + i));
    stat = summarise(step.name, actor, step.kind, samples);
    log(`  ${actor.padEnd(6)} ${step.name.padEnd(36)} p50 ${stat.p50} p95 ${stat.p95} ms`);
  } catch (err) {
    const error = (err as Error).message;
    stat = { ...summarise(step.name, actor, step.kind, []), pass: false, error };
    log(`  ${actor.padEnd(6)} ${step.name.padEnd(36)} FAILED ${error}`);
  }
  checkpoint(stat);
  return stat;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  assertSeedAllowed(process.env.NODE_ENV);
  const port = o.pi ? PI_PORT : DEV_PORT;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kept-bench-'));
  const dbName = o.db ?? `kept_bench_${Date.now().toString(36)}`;
  let running: Awaited<ReturnType<typeof startKept>> | null = null;
  let created = false;

  try {
    if (o.pi) {
      log(`starting ${PI_CONTAINER} (${piLimits(o.piCpus).join(' ')}) on ${PI_PORT}`);
      await startPiContainer(o.piCpus);
    }
    const urls = {
      owner: roleUrl('owner', port, dbName),
      app: roleUrl('app', port, dbName),
      auth: roleUrl('auth', port, dbName),
      system: roleUrl('system', port, dbName),
    };
    const httpPort = await freePort();
    const env = await loadEnv({
      KEPT_DATABASE_URL: urls.app,
      KEPT_AUTH_DATABASE_URL: urls.auth,
      KEPT_SYSTEM_DATABASE_URL: urls.system,
      KEPT_SECRET_KEY: generateKey(),
      KEPT_AUTH_SECRET: generateKey(),
      KEPT_PUBLIC_URL: `http://127.0.0.1:${httpPort}`,
      KEPT_ROLE: 'web',
      KEPT_LOG_LEVEL: 'error',
      KEPT_CONFIG_DIR: path.join(tmp, 'config'),
      KEPT_DATA_DIR: path.join(tmp, 'data'),
    });

    let seedSeconds: number | null = null;
    let bench: NonNullable<Awaited<ReturnType<typeof runSeed>>['bench']> | undefined;
    if (!o.db) {
      await asSuper(port, (c) => c.query(`CREATE DATABASE ${dbName} OWNER kept_owner`));
      created = true;
      log(`database ${dbName} on ${port}: migrating`);
      await runMigrations(urls.owner);
    }
    // The seed is idempotent: on a reused database it finds everything and makes nothing.
    log(`seeding bench (${o.things} things)`);
    const pools = createPools(env);
    try {
      const report = await runSeed('bench', env, pools, {
        bench: { things: o.things, ownerUrl: urls.owner, onProgress: (l) => log(`  ${l}`) },
      });
      bench = report.bench;
      seedSeconds = bench?.seconds ?? null;
    } finally {
      await closePools(pools);
    }
    if (!bench) throw new Error('the seed reported no bench fixture');

    installTrace();
    running = await startKept(env, {
      port: httpPort,
      host: '127.0.0.1',
      webRoot: null,
      logger: pino({ level: 'silent' }),
      print: () => {},
    });
    const base = env.KEPT_PUBLIC_URL;

    const actors: Record<Actor, Http> = {
      owner: await signIn(base, bench.actors.owner.login),
      member: await signIn(base, bench.actors.member.login),
      viewer: await signIn(base, bench.actors.viewer.login),
    };
    const userIds: Record<Actor, string> = {
      owner: bench.actors.owner.userId,
      member: bench.actors.member.userId,
      viewer: bench.actors.viewer.userId,
    };
    const owner = actors.owner;

    // --- fixture lookups (untimed) ---------------------------------------------------------
    const [big, second] = bench.locations;
    if (!big || !second) throw new Error('bench locations missing');
    const accountId = (
      (await owner.ok('GET', '/api/v1/accounts')).json.accounts as { id: string; isOwn: boolean }[]
    ).find((a) => a.isOwn)?.id as string;
    const types = (await owner.ok('GET', `/api/v1/accounts/${accountId}/types`)).json.types as {
      id: string;
      builtinKey: string | null;
    }[];
    const cableType = types.find((t) => t.builtinKey === 'cable')?.id as string;
    const tagIds = (
      (await owner.ok('GET', `/api/v1/accounts/${accountId}/tags?limit=200`)).json.items as {
        id: string;
      }[]
    ).map((t) => t.id);
    type Node = { id: string; parentId: string | null; name: string; isUnplaced: boolean };
    const nodes = (await owner.ok('GET', `/api/v1/locations/${big.id}/places`)).json
      .places as Node[];
    const depth = (n: Node): number => {
      const parent = nodes.find((p) => p.id === n.parentId);
      return parent ? 1 + depth(parent) : 1;
    };
    const deepest = [...nodes].sort((a, b) => depth(b) - depth(a))[0] as Node;
    const otherRoom = nodes.find(
      (n) => n.parentId === null && !n.isUnplaced && n.id !== bench.bigRoomId,
    ) as Node;
    const secondRoom = (
      (await owner.ok('GET', `/api/v1/locations/${second.id}/places`)).json.places as Node[]
    ).find((n) => n.parentId === null && !n.isUnplaced) as Node;
    const roomThings = (
      (await owner.ok('GET', `/api/v1/places/${bench.bigRoomId}/contents?limit=200`)).json
        .things as { items: { id: string }[] }
    ).items.map((t) => t.id);
    if (roomThings.length !== 200) throw new Error(`the room holds ${roomThings.length} things`);
    const serial = 'BN1-004321';
    const cars = bench.showcaseThingIds.filter((_, i) => i % 2 === 0);

    // Something in the trash: 60 things of the big location (not the room's, not containers).
    const trashed = (
      (await owner.ok('GET', `/api/v1/things?locationId=${big.id}&sort=updated&limit=100`)).json
        .items as { id: string; isContainer: boolean }[]
    )
      .filter((t) => !t.isContainer && !roomThings.includes(t.id))
      .slice(0, 60);
    const inTrash = (
      (await owner.ok('GET', '/api/v1/trash?limit=100')).json.items as { id: string }[]
    ).length;
    if (inTrash === 0) {
      for (const t of trashed) await owner.ok('POST', `/api/v1/things/${t.id}/trash`, {});
    }

    // --- the paths ---------------------------------------------------------------------------
    const get = (who: Http, url: string | ((i: number) => string)) => async (i: number) =>
      (await who.ok('GET', typeof url === 'string' ? url : url(i))).ms;
    const enc = encodeURIComponent;
    const reads = (who: Http): Step[] => [
      { name: 'home', kind: 'page', run: get(who, '/api/v1/home') },
      { name: 'locations list', kind: 'page', run: get(who, '/api/v1/locations') },
      { name: 'location page', kind: 'page', run: get(who, `/api/v1/locations/${big.id}`) },
      {
        name: 'location place tree',
        kind: 'page',
        run: get(who, `/api/v1/locations/${big.id}/places`),
      },
      {
        name: 'things list: location, first 50',
        kind: 'page',
        run: get(who, `/api/v1/things?locationId=${big.id}&limit=50`),
      },
      {
        name: 'things list: global, 3 locations',
        kind: 'page',
        run: get(who, '/api/v1/things?limit=50'),
      },
      {
        name: 'things list: by tag',
        kind: 'page',
        run: get(who, `/api/v1/things?tagId=${tagIds[0]}&limit=50`),
      },
      {
        name: 'place contents: 200-thing room',
        kind: 'page',
        run: get(who, `/api/v1/places/${bench.bigRoomId}/contents`),
      },
      {
        name: 'place contents: room, all 200',
        kind: 'page',
        run: get(who, `/api/v1/places/${bench.bigRoomId}/contents?limit=200`),
      },
      { name: 'place page: deep bin', kind: 'page', run: get(who, `/api/v1/places/${deepest.id}`) },
      {
        name: 'place contents: deep bin',
        kind: 'page',
        run: get(who, `/api/v1/places/${deepest.id}/contents`),
      },
      {
        name: 'thing page',
        kind: 'thing',
        run: get(who, (i) => `/api/v1/things/${cars[i % cars.length]}`),
      },
      {
        name: 'thing history',
        kind: 'page',
        run: get(who, (i) => `/api/v1/things/${cars[i % cars.length]}/history`),
      },
      { name: 'search: hdmi', kind: 'search', run: get(who, '/api/v1/search?q=hdmi') },
      { name: 'search: Arabic', kind: 'search', run: get(who, `/api/v1/search?q=${enc('شاحن')}`) },
      { name: 'search: typo', kind: 'search', run: get(who, '/api/v1/search?q=hmdi') },
      { name: 'search: serial', kind: 'search', run: get(who, `/api/v1/search?q=${serial}`) },
      {
        name: 'search: no text, filters',
        kind: 'search',
        run: get(who, `/api/v1/search?locationId=${big.id}&typeId=${cableType}&state=long_unseen`),
      },
      {
        name: 'palette: as you type',
        kind: 'search',
        run: get(who, '/api/v1/search?q=char&kind=things&limit=8'),
      },
      { name: 'activity: global', kind: 'page', run: get(who, '/api/v1/activity') },
      {
        name: 'activity: location',
        kind: 'page',
        run: get(who, `/api/v1/activity?locationId=${big.id}`),
      },
      { name: 'trash list', kind: 'page', run: get(who, '/api/v1/trash') },
    ];

    const results: Stat[] = [];
    const plans: Record<string, PlanCheck[]> = {};
    checkpoint = (stat) => {
      if (!o.out) return;
      const sofar = { partial: true, results: [...results, stat], plans };
      writeFileSync(o.out, JSON.stringify(sofar, null, 2));
    };

    // The offline snapshot (T12): the phone's first sync, every page at the default size, and a
    // delta when nothing changed (one page). Fewer runs: a full pull is ten requests.
    const pullAll = async (who: Http) => {
      let ms = 0;
      let cursor = '';
      for (let page = 0; page < 200; page++) {
        const q = cursor ? `?cursor=${enc(cursor)}` : '';
        const r = await who.ok('GET', `/api/v1/sync/snapshot${q}`);
        ms += r.ms;
        cursor = r.json.nextCursor as string;
        if (r.json.complete === true) return { ms, cursor, pages: page + 1 };
      }
      throw new Error('the snapshot never completed');
    };
    for (const actor of ['owner', 'member', 'viewer'] as const) {
      const who = actors[actor];
      log(`sync snapshot as ${actor}`);
      const first = await pullAll(who);
      log(`  ${first.pages} pages`);
      const steps: Step[] = [
        {
          name: 'sync snapshot: full, every page',
          kind: 'snapshot',
          run: async () => (await pullAll(who)).ms,
        },
        {
          name: 'sync snapshot: delta, nothing new',
          kind: 'page',
          run: async () =>
            (await who.ok('GET', `/api/v1/sync/snapshot?cursor=${enc(first.cursor)}`)).ms,
        },
      ];
      for (const step of steps) {
        results.push(await measure(step, actor, Math.min(o.warmup, 3), Math.min(o.runs, 30)));
        if (o.explain && actor === 'owner') {
          trace = [];
          await step.run(0);
          const statements = trace as Traced[];
          trace = null;
          const top = statements
            .filter((t) => EXPLAINABLE.test(t.text) && !/set_config\(/.test(t.text))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 3);
          const checks: PlanCheck[] = [];
          for (const t of top) checks.push(await explain(urls.app, userIds[actor], t));
          plans[`${actor}: ${step.name}`] = checks;
        }
      }
    }

    // Reads, every actor. The owner's first pass is traced for the plans.
    for (const actor of o.snapshotOnly ? [] : (['owner', 'member', 'viewer'] as const)) {
      log(`reads as ${actor}`);
      for (const step of reads(actors[actor])) {
        results.push(await measure(step, actor, o.warmup, o.runs));
        if (o.explain && (actor === 'owner' || actor === 'viewer')) {
          trace = [];
          await step.run(0);
          const statements = trace as Traced[];
          trace = null;
          const top = statements
            .filter((t) => EXPLAINABLE.test(t.text) && !/set_config\(/.test(t.text))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 3);
          const checks: PlanCheck[] = [];
          for (const t of top) checks.push(await explain(urls.app, userIds[actor], t));
          plans[`${actor}: ${step.name}`] = checks;
        }
      }
    }

    // Writes: the owner and the member (a viewer can't write).
    for (const actor of o.snapshotOnly ? [] : (['owner', 'member'] as const)) {
      const who = actors[actor];
      log(`writes as ${actor}`);
      // Move preview of the room's 200 things (read-only).
      results.push(
        await measure(
          {
            name: 'move preview: 200 things',
            kind: 'page',
            run: async () =>
              (
                await who.ok('POST', '/api/v1/things/move/preview', {
                  thingIds: roomThings,
                  to: { placeId: otherRoom.id },
                })
              ).ms,
          },
          actor,
          // The route allows 60 previews a minute per person (review #27): stay under it.
          Math.min(o.warmup, 5),
          Math.min(o.runs, 50),
        ),
      );
      // Moves: there and back, so every run moves the same 200 things.
      const moveStep = (name: string, away: string): Step => ({
        name,
        kind: 'move',
        run: async (i) =>
          (
            await who.ok('POST', '/api/v1/things/move', {
              thingIds: roomThings,
              to: { placeId: i % 2 === 0 ? away : bench.bigRoomId },
            })
          ).ms,
      });
      results.push(
        await measure(
          moveStep('move 200 things: within location', otherRoom.id),
          actor,
          2,
          o.writeRuns * 2,
        ),
      );
      results.push(
        await measure(
          moveStep('move 200 things: across locations', secondRoom.id),
          actor,
          2,
          o.writeRuns * 2,
        ),
      );
      // Tags: there is no bulk-tag route in step 2; the client PATCHes each thing (If-Match).
      const versions = new Map<string, number>();
      for (const id of roomThings.slice(0, 20)) {
        versions.set(id, (await who.ok('GET', `/api/v1/things/${id}`)).json.rowVersion as number);
      }
      const tagOnce = async (id: string, i: number) => {
        const r = await who.ok(
          'PATCH',
          `/api/v1/things/${id}`,
          { tagIds: [tagIds[i % tagIds.length]] },
          { 'if-match': String(versions.get(id)) },
        );
        versions.set(id, r.json.rowVersion as number);
        return r.ms;
      };
      results.push(
        await measure(
          {
            name: 'tag one thing',
            kind: 'write',
            run: (i) => tagOnce(roomThings[i % 20] as string, i),
          },
          actor,
          o.warmup,
          o.runs,
        ),
      );
      results.push(
        await measure(
          {
            name: 'bulk tag: 20 things, one PATCH each',
            kind: 'move',
            run: async (i) => {
              let total = 0;
              for (const id of roomThings.slice(0, 20)) total += await tagOnce(id, i);
              return total;
            },
          },
          actor,
          2,
          o.writeRuns,
        ),
      );
    }

    // --- report --------------------------------------------------------------------------------
    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
    const facts = {
      label: o.pi ? 'constrained (Pi-class)' : 'unconstrained',
      when: new Date().toISOString(),
      machine: `${os.cpus()[0]?.model ?? os.arch()} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
      node: process.version,
      nodeHeapLimitMb: heapLimitMb,
      postgres: {
        port,
        limits: o.pi ? piLimits(o.piCpus).join(' ') : 'none (shared dev container)',
        ...(await serverFacts(port)),
      },
      fixture: { locations: bench.locations, seedSeconds },
      runs: { warmup: o.warmup, runs: o.runs, writeRuns: o.writeRuns },
    };
    const failed = results.filter((r) => r.pass === false);
    const planIssues = Object.entries(plans).flatMap(([k, checks]) =>
      checks
        .filter((c) => !c.onceEach)
        .map((c) => `${k}: ${JSON.stringify(c.helperLoops)}, ${c.perRowSubPlans} per-row SubPlans`),
    );
    const helperNodes = Object.values(plans)
      .flat()
      .reduce((n, c) => n + Object.keys(c.helperLoops).length, 0);
    const table = [
      '| Path | Actor | n | p50 | p95 | p99 | max | Budget | Laptop gate | |',
      '|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
      ...results.map(
        (r) =>
          `| ${r.path} | ${r.actor} | ${r.n} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.budget ?? '—'} | ${r.laptopGate ?? '—'} | ${r.error ? `ERROR ${r.error.slice(0, 60)}` : r.pass === false ? 'MISS' : 'ok'} |`,
      ),
    ].join('\n');
    process.stdout.write(`\n## ${facts.label}\n\n${JSON.stringify(facts, null, 2)}\n\n${table}\n`);
    process.stdout.write(
      `\nPlans checked: ${Object.values(plans).flat().length}, calling the RLS helpers from ${helperNodes} plan nodes; helper functions more than once per statement: ${planIssues.length ? planIssues.join('; ') : 'none'}\n`,
    );
    process.stdout.write(
      `Budget misses: ${failed.length ? failed.map((f) => `${f.actor} ${f.path}`).join(', ') : 'none'}\n`,
    );
    if (o.out) {
      writeFileSync(o.out, JSON.stringify({ facts, results, plans }, null, 2));
      log(`wrote ${o.out}`);
    }
    process.exitCode = failed.length || planIssues.length ? 1 : 0;
  } finally {
    await running?.stop().catch((err: Error) => log(`stop: ${err.message}`));
    if (created && !o.keep) {
      await asSuper(port, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)).catch(
        (err: Error) => log(`drop ${dbName}: ${err.message}`),
      );
    } else if (created) {
      log(`kept database ${dbName} on ${port} (--db ${dbName} to reuse)`);
    }
    if (o.pi && !o.keep) stopPiContainer();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
