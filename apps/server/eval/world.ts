/**
 * The world the assistant and search evaluations run in (step-6 plan T17): the `households` seed
 * on a database of its own, an AI provider every location resolves (the mock, or the one a real
 * run names), the cases' own fixtures (things with injected notes), and the things embedded by the
 * real backfill (embeddings/backfill.ts) so meaning can be searched.
 *
 * `scratchDb()` makes and migrates a throwaway database on the development Postgres (5452) for a
 * command-line run and drops it afterwards; `score.test.ts` uses the test run's own database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { providerKeyAad } from '../src/ai/db-keys.js';
import type { AiDeps } from '../src/ai/routes.js';
import { type Keyring, seal } from '../src/crypto/envelope.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Pools } from '../src/db/pools.js';
import { withScope } from '../src/db/scope.js';
import { runBackfill } from '../src/embeddings/backfill.js';
import { PEOPLE, type PersonKey } from '../src/seed/cast.js';
import { runSeed } from '../src/seed/index.js';
import { insertThing } from '../src/things/service.js';

export type Owner = <T extends pg.QueryResultRow>(sql: string, values?: unknown[]) => Promise<T[]>;

export type EvalProvider = {
  kind: 'openai' | 'google' | 'anthropic' | 'groq' | 'openrouter' | 'openai_compatible';
  chat: string;
  /** Null: no embeddings model (search is keyword-only, as for a Groq-only key). */
  embeddings: string | null;
  baseUrl?: string | null;
  /** The key (KEPT_EVAL_API_KEY); null for the mock (a placeholder makes the provider usable).
   * Never printed. */
  apiKey: string | null;
};

export type World = {
  users: Record<PersonKey, string>;
  locations: Map<string, { id: string; accountId: string }>;
  /** A thing's name → its ids (names repeat across locations). */
  things: Map<string, string[]>;
  keyring: Keyring;
};

export type Fixture = { location: string; name: string; notes?: string };

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The world on a database whose pools and owner connection are given. */
export async function buildWorld(opts: {
  pools: Pools;
  owner: Owner;
  provider: EvalProvider;
  fixtures?: Fixture[];
  ai: (keyring: Keyring) => AiDeps;
  keyring?: Keyring;
}): Promise<World & { ai: AiDeps }> {
  const keyring: Keyring = opts.keyring ?? new Map([[1, randomBytes(32)]]);
  const env = {
    KEPT_PUBLIC_URL: 'http://localhost:5173',
    KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
  } as Parameters<typeof runSeed>[1];
  await runSeed('households', env, opts.pools);

  const users = {} as Record<PersonKey, string>;
  for (const [key, p] of Object.entries(PEOPLE) as [PersonKey, { email: string }][]) {
    const [row] = await opts.owner<{ id: string }>(
      'SELECT id::text FROM auth."user" WHERE email = $1',
      [p.email],
    );
    if (!row) throw new Error(`the seed made no ${key}`);
    users[key] = row.id;
  }
  const locs = await opts.owner<{ id: string; name: string; owner_account_id: string }>(
    `SELECT id::text, name, owner_account_id::text FROM public.locations
      WHERE kind <> 'personal' AND deleted_at IS NULL`,
  );
  const locations = new Map(locs.map((l) => [l.name, { id: l.id, accountId: l.owner_account_id }]));

  // One instance provider: every location resolves it (the cascade's last scope).
  const p = opts.provider;
  const id = randomUUID();
  const sealed = seal(
    { key: keyring.get(1) as Buffer, keyVersion: 1 },
    p.apiKey ?? 'mock-key-not-sent',
    providerKeyAad(id),
  );
  await opts.owner(
    `INSERT INTO public.ai_providers (id, scope, kind, base_url, key_ciphertext, key_version, models,
                                      created_by)
     VALUES ($1, 'instance', $2, $3, $4, $5, $6, $7)`,
    [
      id,
      p.kind,
      p.baseUrl ?? null,
      JSON.stringify(sealed),
      1,
      // A vision model too: the AI modules count as on where extraction resolves (0040's
      // kept.ai_provider_resolved), and the assistant's tools follow them (D191).
      JSON.stringify({
        vision: p.chat,
        chat: p.chat,
        ...(p.embeddings ? { embeddings: p.embeddings } : {}),
      }),
      users.ibrahim,
    ],
  );

  for (const f of opts.fixtures ?? []) {
    const loc = locations.get(f.location);
    if (!loc) throw new Error(`fixture location ${f.location} isn't in the seed`);
    const [unplaced] = await opts.owner<{ id: string }>(
      'SELECT id::text FROM public.places WHERE location_id = $1 AND is_unplaced',
      [loc.id],
    );
    const [owner] = await opts.owner<{ user_id: string }>(
      `SELECT user_id::text FROM public.memberships WHERE location_id = $1 AND role = 'owner'`,
      [loc.id],
    );
    if (!unplaced || !owner) throw new Error(`fixture location ${f.location} has no owner`);
    await withScope(opts.pools.app, { userId: owner.user_id, mfa: true }, (tx, client) =>
      insertThing(
        {
          tx,
          client,
          scope: { userId: owner.user_id, mfa: true },
          requestId: 'eval',
          jobs: null,
          files: null,
        },
        {
          locationId: loc.id,
          placeId: unplaced.id,
          name: f.name,
          ...(f.notes ? { notes: f.notes } : {}),
        },
      ),
    );
  }

  const ai = opts.ai(keyring);
  if (p.embeddings) {
    await runBackfill({ pools: opts.pools, ai, keyring: () => keyring, log: silent });
  }
  const rows = await opts.owner<{ id: string; name: string }>(
    'SELECT id::text, name FROM public.things WHERE deleted_at IS NULL AND name IS NOT NULL',
  );
  const things = new Map<string, string[]>();
  for (const r of rows) things.set(r.name, [...(things.get(r.name) ?? []), r.id]);
  return { users, locations, things, keyring, ai };
}

const ADMIN_URL =
  process.env.KEPT_EVAL_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5452/postgres';
const roleUrl = (role: string, db: string) =>
  `postgres://kept_${role}:kept_${role}@localhost:5452/${db}`;

/** A migrated throwaway database for a command-line run, with its pools and a drop(). */
export async function scratchDb(): Promise<{
  pools: Pools;
  owner: Owner;
  drop: () => Promise<void>;
}> {
  const name = `kept_eval_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await admin(`CREATE DATABASE ${name} OWNER kept_owner`);
  await runMigrations(roleUrl('owner', name));
  const pool = (role: string) => {
    const p = new pg.Pool({ connectionString: roleUrl(role, name), max: 5 });
    p.on('error', () => {});
    return p;
  };
  const pools: Pools = { app: pool('app'), auth: pool('auth'), system: pool('system') };
  const ownerPool = pool('owner');
  const owner: Owner = async (sql, values = []) => (await ownerPool.query(sql, values)).rows;
  return {
    pools,
    owner,
    drop: async () => {
      await Promise.all([...Object.values(pools), ownerPool].map((p) => p.end()));
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
