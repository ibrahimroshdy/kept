/**
 * S6.5 (D207): the scratch database for the local-embeddings spike.
 *
 *   cd apps/server && npx tsx ../../docs/spikes/code/step6/local-embeddings/setup-db.ts <out.json>
 *   cd apps/server && npx tsx ../../docs/spikes/code/step6/local-embeddings/setup-db.ts --drop
 *
 * Creates `kept_spike6_local` on the dev Postgres (localhost:5452, never the dev `kept`), migrates
 * it as kept_owner and seeds it the way apps/server/bench/rls.bench.ts main() does: the
 * `households` scenario (the cast's realistic inventory) and then `bench` with 10,000 things in
 * its largest location (names from seed/words.ts, 30% Arabic). Writes the ids the other scripts
 * need (locations, a user who can see each one) to <out.json>. `--drop` drops the database.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type PgTypes from 'pg';
import { loadEnv } from '../../../../../apps/server/src/config/env.js';
import { generateKey } from '../../../../../apps/server/src/crypto/envelope.js';
import { runMigrations } from '../../../../../apps/server/src/db/migrate.js';
import { closePools, createPools } from '../../../../../apps/server/src/db/pools.js';
import { assertSeedAllowed, runSeed } from '../../../../../apps/server/src/seed/index.js';

// `pg` resolves from apps/server (this folder has no node_modules of its own).
const pg = createRequire(new URL('../../../../../apps/server/package.json', import.meta.url))(
  'pg',
) as typeof PgTypes;

const PORT = 5452;
const DB = 'kept_spike6_local';
const superUrl = `postgres://postgres:postgres@localhost:${PORT}/postgres`;
const roleUrl = (role: string) => `postgres://kept_${role}:kept_${role}@localhost:${PORT}/${DB}`;

async function asSuper<T>(fn: (c: PgTypes.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === '--drop') {
    await asSuper((c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
    console.log(`dropped ${DB}`);
    return;
  }
  if (!arg) throw new Error('usage: setup-db.ts <out.json> | --drop');
  assertSeedAllowed(process.env.NODE_ENV);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kept-s65-'));
  const env = await loadEnv({
    KEPT_DATABASE_URL: roleUrl('app'),
    KEPT_AUTH_DATABASE_URL: roleUrl('auth'),
    KEPT_SYSTEM_DATABASE_URL: roleUrl('system'),
    KEPT_SECRET_KEY: generateKey(),
    KEPT_AUTH_SECRET: generateKey(),
    KEPT_PUBLIC_URL: 'http://127.0.0.1:18765',
    KEPT_ROLE: 'web',
    KEPT_LOG_LEVEL: 'error',
    KEPT_CONFIG_DIR: path.join(tmp, 'config'),
    KEPT_DATA_DIR: path.join(tmp, 'data'),
  });

  await asSuper((c) => c.query(`CREATE DATABASE ${DB} OWNER kept_owner`));
  console.log(`${DB}: migrating`);
  await runMigrations(roleUrl('owner'));

  const pools = createPools(env);
  const started = Date.now();
  try {
    console.log('seeding households');
    await runSeed('households', env, pools);
    console.log('seeding bench (10,000 things)');
    const report = await runSeed('bench', env, pools, {
      bench: { things: 10_000, ownerUrl: roleUrl('owner'), onProgress: (l) => console.log(`  ${l}`) },
    });
    if (!report.bench) throw new Error('no bench fixture');
  } finally {
    await closePools(pools);
  }

  // Every location, its thing count, and one member who can see it (for the keyword search,
  // which runs as kept_app under RLS in that member's scope).
  const owner = new pg.Client({ connectionString: roleUrl('owner') });
  await owner.connect();
  try {
    const { rows } = await owner.query<{
      id: string;
      name: string;
      things: string;
      user_id: string;
    }>(
      `SELECT l.id, l.name,
              (SELECT count(*) FROM public.things t
                WHERE t.location_id = l.id AND t.deleted_at IS NULL) AS things,
              (SELECT m.user_id FROM public.memberships m
                WHERE m.location_id = l.id ORDER BY (m.role = 'owner') DESC LIMIT 1) AS user_id
         FROM public.locations l ORDER BY l.name`,
    );
    writeFileSync(arg, `${JSON.stringify({ db: DB, seconds: (Date.now() - started) / 1000, locations: rows }, null, 2)}\n`);
    console.log(rows);
  } finally {
    await owner.end();
  }
}

await main();
