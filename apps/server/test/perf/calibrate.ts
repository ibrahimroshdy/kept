import os from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { CONNECTION_OPTIONS } from '../../src/db/pools.js';
import { type Calibration, type ComponentMs, calibrationOf } from './calibration.js';

// The reference workload (issue #159): how fast this runner is, timed once at the start of the
// perf run (test/perf/global-setup.ts), before any check. Fixed and deterministic, and none of it
// Kept's code, so a regression in Kept never makes it slower:
// - cpu: pure JavaScript in this process: 150,000 records built, sent through JSON and back,
//   sorted by a string key, grouped in a Map and normalised (what a request's handler does).
// - db: plain SQL in a scratch database, one statement at a time, all of the work inside
//   Postgres: 100,000 rows into a temporary table, an index, a grouped aggregate, an ordered
//   page deep in the index and a self-join.
// - vector: an exact cosine scan of 10,000 768-dimension vectors for the 50 nearest, ten times
//   (the shape of semantic search, kept.semantic_thing_ids, at the perf fixture's size). On the
//   slow nights semantic search slowed about 2.5× while most checks slowed 1.5–1.8×, so vector
//   arithmetic gets its own part.
// Each part runs CALIBRATION_WARMUP + CALIBRATION_RUNS times; its fastest run counts (the least
// disturbed by anything else on the machine). Commits and round trips are left out on purpose:
// their cost depends on the disk and on Docker's networking (Docker Desktop's VM on a Mac), not on
// how fast the runner computes.
//
// About 5–10 s in all.

export const CALIBRATION_WARMUP = 1;
export const CALIBRATION_RUNS = 5;
const CPU_RECORDS = 150_000;
const DB_ROWS = 100_000;
const VECTORS = 10_000;
const BASES = 100;
const DIMS = 768;
const VECTOR_QUERIES = 10;

/** The checksum cpuWork() returns; another value means the workload changed (re-pin). */
export const CPU_CHECKSUM = 99_834_549;

/** The pure-JavaScript part. Returns a checksum so none of it can be optimised away. */
export function cpuWork(): number {
  type Row = { id: number; name: string; qty: number; tags: string[] };
  const rows: Row[] = [];
  let seed = 1;
  for (let i = 0; i < CPU_RECORDS; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    rows.push({
      id: i,
      name: `Thing ${seed.toString(36)} Ünïcode`,
      qty: seed % 97,
      tags: [`t${seed % 13}`, `t${seed % 7}`],
    });
  }
  const back = JSON.parse(JSON.stringify(rows)) as Row[];
  back.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  const groups = new Map<string, number>();
  let sum = 0;
  for (const [i, r] of back.entries()) {
    for (const t of r.tags) groups.set(t, (groups.get(t) ?? 0) + r.qty);
    const n = r.name.normalize('NFKD').toLowerCase();
    sum = (sum * 31 + n.length + i * r.qty) % 1_000_000_007;
  }
  for (const [k, v] of [...groups].sort()) sum = (sum * 31 + k.length * v) % 1_000_000_007;
  return sum;
}

async function fastest(fn: () => Promise<void>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CALIBRATION_WARMUP + CALIBRATION_RUNS; i++) {
    const start = performance.now();
    await fn();
    const ms = performance.now() - start;
    if (i >= CALIBRATION_WARMUP) best = Math.min(best, ms);
  }
  return Math.round(best * 10) / 10;
}

async function dbWork(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE cal_rows AS
     SELECT n AS id, md5(n::text) AS name, n % 97 AS qty,
            jsonb_build_object('k', n % 13, 'v', md5((n * 7)::text)) AS doc
       FROM generate_series(1, ${DB_ROWS}) AS n`,
  );
  await client.query('CREATE INDEX ON cal_rows (name)');
  await client.query('ANALYZE cal_rows');
  await client.query(
    `SELECT doc->>'k' AS k, count(*), sum(qty), max(name) FROM cal_rows GROUP BY 1 ORDER BY 1`,
  );
  await client.query('SELECT id FROM cal_rows ORDER BY name DESC LIMIT 50 OFFSET 40000');
  await client.query(
    `SELECT count(*) FROM cal_rows a JOIN cal_rows b ON b.id = a.id + 1 WHERE a.qty < b.qty`,
  );
  await client.query('DROP TABLE cal_rows');
}

async function vectorSetup(client: pg.Client): Promise<void> {
  // Deterministic and distinct: 100 base vectors (a sine of the row and the dimension), and each
  // of the 10,000 the sum of two of them.
  await client.query(
    `CREATE TEMP TABLE cal_base AS
     SELECT b, (SELECT array_agg(sin(b * 0.37 + d * 0.11)::real ORDER BY d)
                  FROM generate_series(1, ${DIMS}) AS d)::vector(${DIMS}) AS v
       FROM generate_series(0, ${BASES - 1}) AS b`,
  );
  await client.query(
    `CREATE TEMP TABLE cal_vectors AS
     SELECT n AS id, x.v + y.v AS v
       FROM generate_series(0, ${VECTORS - 1}) AS n
       JOIN cal_base x ON x.b = n % ${BASES}
       JOIN cal_base y ON y.b = n / ${BASES}`,
  );
  await client.query('ANALYZE cal_vectors');
}

async function vectorWork(client: pg.Client): Promise<void> {
  for (let q = 1; q <= VECTOR_QUERIES; q++) {
    await client.query(
      `SELECT id FROM cal_vectors
        ORDER BY v <=> (SELECT v FROM cal_vectors WHERE id = $1) LIMIT 50`,
      [q * 997 - 1],
    );
  }
}

/** This machine's CPU, as the snapshot bench names it. */
export function machine(): string {
  const cpus = os.cpus();
  return `${cpus[0]?.model ?? 'unknown'} × ${cpus.length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
}

/**
 * Times the reference workload's parts. `superuserUrl` is a superuser's connection to the
 * maintenance database: a scratch database is made for the SQL parts (with pgvector) and dropped
 * after.
 */
export async function measureComponents(superuserUrl: string): Promise<ComponentMs> {
  const checksum = cpuWork();
  if (checksum !== CPU_CHECKSUM) {
    throw new Error(
      `calibration: cpuWork() returned ${checksum}, not ${CPU_CHECKSUM}: the workload changed, so REFERENCE_MS must be re-pinned`,
    );
  }
  const cpu = await fastest(async () => {
    cpuWork();
  });

  const name = `kept_cal_${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  const admin = new pg.Client({ connectionString: superuserUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(superuserUrl);
    url.pathname = `/${name}`;
    // As the server's pools (src/db/pools.ts): JIT off. Temporary tables in memory.
    const client = new pg.Client({ connectionString: url.toString(), options: CONNECTION_OPTIONS });
    await client.connect();
    try {
      await client.query(`SET temp_buffers = '256MB'`);
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const db = await fastest(() => dbWork(client));
      await vectorSetup(client);
      const vector = await fastest(() => vectorWork(client));
      return { cpu, db, vector };
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

/** The workload timed and compared with REFERENCE_MS. */
export async function measureCalibration(superuserUrl: string): Promise<Calibration> {
  return calibrationOf(await measureComponents(superuserUrl), undefined, machine());
}
