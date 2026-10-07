import { type EmbedTextInput, embedText, newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { type Scope, withScope, withSystem } from './scope.js';

// Step-6 T6 (0075, 0076): semantic search's storage and doors (D200, D207; plan Q12–Q15; spike
// S6.4). Vectors here are 3-dimensional; the model key is what the doors match on.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

const MODEL = 'provider:openai:text-embedding-3-small';
const OTHER = 'local:multilingual-e5-small';

let ibrahim: Tenant; // owns Home and Garage; an instance admin
let garage: { locationId: string; unplacedId: string };
let bruce: string; // admin of Home
let louis: string; // member of Home
let talia: string; // viewer of Home
let alfred: Tenant; // owns بيت العائلة, shares nothing
let router: string;
let cable: string;
let jack: string; // in Garage

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, scope, (_tx, c) => fn(c));
const user = (userId: string): Scope => ({ userId, mfa: true });
const system = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));

type Backlog = { thing_id: string; text: string; content_hash: string };
const backlog = (scope: Scope | 'system', locationId: string, model = MODEL, limit = 100) => {
  const run = async (c: pg.PoolClient) =>
    (
      await c.query<Backlog>('SELECT * FROM kept.embedding_backlog($1, $2, $3)', [
        locationId,
        model,
        limit,
      ])
    ).rows;
  return scope === 'system' ? system(run) : as(scope, run);
};
const store = (
  scope: Scope | 'system',
  locationId: string,
  rows: { thing_id: string; content_hash: string; embedding: number[] }[],
  model = MODEL,
) => {
  const run = async (c: pg.PoolClient) =>
    (
      await c.query<{ n: number }>('SELECT kept.embedding_store($1, $2, $3) AS n', [
        locationId,
        model,
        JSON.stringify(rows),
      ])
    ).rows[0]?.n;
  return scope === 'system' ? system(run) : as(scope, run);
};
const semantic = (scope: Scope, query: number[], locationId: string | null = null, model = MODEL) =>
  as(
    scope,
    async (c) =>
      (
        await c.query<{ thing_id: string; distance: number }>(
          'SELECT * FROM kept.semantic_thing_ids($1, $2::vector, $3, 50)',
          [model, JSON.stringify(query), locationId],
        )
      ).rows,
  );
const embedded = async () =>
  own<{ thing_id: string; location_id: string; model_key: string; content_hash: string }>(
    'SELECT thing_id, location_id, model_key, content_hash FROM public.thing_embeddings ORDER BY 1, 3',
  );

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'em-ibrahim', { name: 'Home' });
  garage = await ownerTx(db, (c) => insertLocation(c, ibrahim, { name: 'Garage' }));
  await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]);
  bruce = await seedUser(db, 'em-bruce');
  await addMember(db, ibrahim.locationId, bruce, 'admin');
  louis = await seedUser(db, 'em-louis');
  await addMember(db, ibrahim.locationId, louis, 'member');
  talia = await seedUser(db, 'em-talia');
  await addMember(db, ibrahim.locationId, talia, 'viewer');
  alfred = await seedTenant(db, 'em-alfred', { name: 'بيت العائلة' });

  // Home › Office › Desk drawer (a container) holds the HDMI cable; the router, bought at Raya
  // for EGP 450, has a secret PIN field with a value.
  router = newId();
  cable = newId();
  jack = newId();
  const office = newId();
  const drawer = newId();
  const type = newId();
  const pin = newId();
  const purchase = newId();
  const line = newId();
  await own(
    `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
     VALUES ($1, $2, (SELECT id FROM public.types
                       WHERE owner_account_id IS NULL AND builtin_key = 'electronics'),
             'Network gear', 'lucide:router')`,
    [type, ibrahim.accountId],
  );
  await own(
    `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind, secret)
     VALUES ($1, $2, $3, 'wifi_password', 'Wi-Fi password', 'text', true)`,
    [pin, ibrahim.accountId, type],
  );
  await own('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
    office,
    ibrahim.locationId,
    'Office',
  ]);
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id, model, notes, aliases)
     VALUES ($1, $2, $3, 'Router', $4, 'AX3000', 'Upstairs  hallway', '{}'),
            ($5, $2, $3, 'Desk drawer', NULL, NULL, NULL, '{}')`,
    [router, ibrahim.locationId, office, type, drawer],
  );
  await own(
    `INSERT INTO public.things (id, location_id, container_id, name, aliases)
     VALUES ($1, $2, $3, 'HDMI cable', '{"en": ["HDMI lead"], "ar": ["كابل HDMI"]}')`,
    [cable, ibrahim.locationId, drawer],
  );
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Jack')`,
    [jack, garage.locationId, garage.unplacedId],
  );
  await own(`INSERT INTO public.vendors (owner_account_id, name) VALUES ($1, 'Raya')`, [
    ibrahim.accountId,
  ]);
  await own(
    `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total)
     VALUES ($1, $2, (SELECT id FROM public.vendors WHERE name = 'Raya'), '2026-09-01', 'EGP', 450)`,
    [purchase, ibrahim.locationId],
  );
  await own(
    `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
     VALUES ($1, $2, $3, 'Router AX3000', 450)`,
    [line, ibrahim.locationId, purchase],
  );
  await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, router]);
  await own(
    `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                       key_version, updated_by)
     VALUES ($1, $2, $3, 'wifi_password', '{"v": 1, "c": "hunter2"}', 1, $4)`,
    [ibrahim.locationId, router, pin, ibrahim.userId],
  );
});

describe('the text a thing is embedded from (D200, Q12)', () => {
  const cases: EmbedTextInput[] = [
    {
      name: 'HDMI cable',
      aliases: ['HDMI', 'كابل HDMI'],
      typeName: 'Cable',
      brand: 'Belkin',
      model: 'HD-2',
      notes: 'For the TV\n in the living room',
      placePath: ['Home', 'Office', 'Drawer'],
      receipt: { vendor: 'B.TECH', lines: [{ description: 'HDMI 2.1 cable 2 m' }] },
    },
    { name: 'Drill', brand: ' ', notes: null, placePath: [] },
    { name: '  Jack\t\tstand ', aliases: [' ', 'رافعة'], placePath: ['Garage'] },
    { name: 'غسالة', notes: 'تحت\nالدرج', receipt: { vendor: null, lines: [{ description: '' }] } },
  ];

  it('is embedText() in SQL: kept.embedding_text_of() agrees on every case', async () => {
    for (const c of cases) {
      const [row] = await own<{ t: string }>(
        'SELECT kept.embedding_text_of($1, $2, $3, $4, $5, $6, $7, $8, $9) AS t',
        [
          c.name,
          c.aliases ?? [],
          c.typeName ?? null,
          c.brand ?? null,
          c.model ?? null,
          c.notes ?? null,
          c.placePath ?? [],
          c.receipt?.vendor ?? null,
          (c.receipt?.lines ?? []).map((l) => l.description ?? null),
        ],
      );
      expect(row?.t).toBe(embedText(c));
    }
  });

  it('reads a thing, its path, type, aliases and receipt line; never its secret or a price', async () => {
    const rows = await backlog('system', ibrahim.locationId);
    const byId = Object.fromEntries(rows.map((r) => [r.thing_id, r.text]));
    expect(byId[cable]).toBe(
      [
        'name: HDMI cable',
        'alias: كابل HDMI',
        'alias: HDMI lead',
        'place: Home › Office › Desk drawer',
      ].join('\n'),
    );
    expect(byId[router]).toBe(
      [
        'name: Router',
        'type: Network gear',
        'model: AX3000',
        'notes: Upstairs hallway',
        'place: Home › Office',
        'vendor: Raya',
        'item: Router AX3000',
      ].join('\n'),
    );
    for (const leak of ['450', 'EGP', 'hunter2', 'Wi-Fi', 'wifi_password'])
      expect(byId[router]).not.toContain(leak);
  });
});

describe('the backlog and the store', () => {
  const vec = (i: number) => [i, 1, 0];

  it('stores vectors, then answers only what changed, and everything again for a new model', async () => {
    const first = await backlog('system', ibrahim.locationId);
    expect(first.map((r) => r.thing_id).sort()).toEqual(
      [
        router,
        cable,
        (await own<{ id: string }>(`SELECT id FROM public.things WHERE name = 'Desk drawer'`))[0]
          ?.id,
      ].sort(),
    );
    expect(
      await store(
        user(louis),
        ibrahim.locationId,
        first.map((r, i) => ({
          thing_id: r.thing_id,
          content_hash: r.content_hash,
          embedding: vec(i),
        })),
      ),
    ).toBe(3);
    expect(await backlog('system', ibrahim.locationId)).toEqual([]);
    await own(`UPDATE public.things SET name = 'Wi-Fi router' WHERE id = $1`, [router]);
    expect((await backlog(user(louis), ibrahim.locationId)).map((r) => r.thing_id)).toEqual([
      router,
    ]);
    expect(await backlog('system', ibrahim.locationId, OTHER)).toHaveLength(3);
  });

  it("drops a thing's other models, and skips a thing that isn't live there", async () => {
    const [row] = await backlog('system', ibrahim.locationId, MODEL, 1);
    if (!row) throw new Error('no backlog');
    await store('system', ibrahim.locationId, [{ ...row, embedding: vec(1) }], OTHER);
    await store('system', ibrahim.locationId, [{ ...row, embedding: vec(2) }]);
    expect((await embedded()).map((e) => e.model_key)).toEqual([MODEL]);
    expect(await store('system', garage.locationId, [{ ...row, embedding: vec(3) }])).toBe(0);
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [row.thing_id]);
    expect(await store('system', ibrahim.locationId, [{ ...row, embedding: vec(4) }])).toBe(0);
  });

  it("refuses a viewer's store, a stranger's backlog, and a vector whose length isn't its dims", async () => {
    const [row] = await backlog('system', ibrahim.locationId, MODEL, 1);
    if (!row) throw new Error('no backlog');
    expect(
      (await pgError(store(user(talia), ibrahim.locationId, [{ ...row, embedding: vec(1) }]))).code,
    ).toBe('42501');
    expect((await pgError(backlog(user(alfred.userId), ibrahim.locationId))).code).toBe('42501');
    await own(
      `INSERT INTO public.thing_embeddings (thing_id, location_id, model_key, dims, content_hash,
                                            embedding)
       VALUES ($1, $2, 'x', 3, $3, '[1,2,3]')`,
      [row.thing_id, ibrahim.locationId, row.content_hash],
    );
    expect(
      (await pgError(own(`UPDATE public.thing_embeddings SET dims = 2 WHERE model_key = 'x'`)))
        .constraint,
    ).toBe('thing_embeddings_vector_chk');
  });

  it('follows a thing moved to Garage, marked stale', async () => {
    const rows = await backlog('system', ibrahim.locationId);
    await store(
      'system',
      ibrahim.locationId,
      rows.map((r, i) => ({ ...r, embedding: vec(i) })),
    );
    await as(user(ibrahim.userId), (c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [router],
        garage.locationId,
        garage.unplacedId,
      ]),
    );
    const moved = (await embedded()).find((e) => e.thing_id === router);
    expect(moved).toMatchObject({ location_id: garage.locationId, content_hash: '0'.repeat(64) });
    expect((await backlog('system', garage.locationId)).map((r) => r.thing_id)).toContain(router);
  });
});

describe('kept.semantic_thing_ids(): the only way to a match (§7.2)', () => {
  beforeEach(async () => {
    const home = await backlog('system', ibrahim.locationId);
    await store(
      'system',
      ibrahim.locationId,
      home.map((r) => ({ ...r, embedding: r.thing_id === cable ? [1, 0, 0] : [0, 1, 0] })),
    );
    const gar = await backlog('system', garage.locationId);
    await store(
      'system',
      garage.locationId,
      gar.map((r) => ({ ...r, embedding: [1, 0, 0] })),
    );
  });

  it("ranks the caller's visible things by distance, one location or all", async () => {
    const all = await semantic(user(ibrahim.userId), [1, 0, 0]);
    expect(
      all
        .slice(0, 2)
        .map((r) => r.thing_id)
        .sort(),
    ).toEqual([cable, jack].sort());
    expect(all[0]?.distance).toBeCloseTo(0);
    expect((await semantic(user(ibrahim.userId), [1, 0, 0], ibrahim.locationId))[0]?.thing_id).toBe(
      cable,
    );
    // Talia sees Home only; a viewer reads.
    expect((await semantic(user(talia), [1, 0, 0])).map((r) => r.thing_id)).not.toContain(jack);
  });

  it("never returns another tenant's thing, even at distance zero", async () => {
    expect(await semantic(user(alfred.userId), [1, 0, 0])).toEqual([]);
    expect(await semantic(user(alfred.userId), [1, 0, 0], ibrahim.locationId)).toEqual([]);
  });

  it('matches one model and vectors of its length, and never a trashed thing', async () => {
    expect(await semantic(user(ibrahim.userId), [1, 0, 0], null, OTHER)).toEqual([]);
    expect(await semantic(user(ibrahim.userId), [1, 0], null)).toEqual([]);
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [cable]);
    expect(
      (await semantic(user(ibrahim.userId), [1, 0, 0], ibrahim.locationId)).map((r) => r.thing_id),
    ).not.toContain(cable);
  });

  it('gives a token only its locations, and kept_app no vector at all', async () => {
    const token = newId();
    await own(
      `INSERT INTO public.api_tokens (id, user_id, kind, name, lookup, hash, scope)
       VALUES ($1, $2, 'personal', 'Shortcuts', 'Emb12345', $3, 'read')`,
      [token, ibrahim.userId, 'c'.repeat(64)],
    );
    await own('INSERT INTO public.token_locations (token_id, location_id) VALUES ($1, $2)', [
      token,
      garage.locationId,
    ]);
    const viaToken = await semantic(
      { userId: ibrahim.userId, mfa: false, tokenId: token },
      [1, 0, 0],
    );
    expect(viaToken.map((r) => r.thing_id)).toEqual([jack]);
    expect(
      (
        await pgError(
          as(user(ibrahim.userId), (c) => c.query('SELECT * FROM public.thing_embeddings')),
        )
      ).code,
    ).toBe('42501');
  });
});

describe('the status and the background payer', () => {
  it("shows the instance's counts and pause to instance admins; only the backfill marks", async () => {
    const rows = await backlog('system', ibrahim.locationId);
    await store(
      'system',
      ibrahim.locationId,
      rows.map((r) => ({ ...r, embedding: [1, 1, 1] })),
    );
    const mark = (reason: string | null, until: string | null) =>
      system((c) =>
        c.query(`SELECT kept.embedding_mark($1, $2, 'provider', 0, $3, $4)`, [
          ibrahim.locationId,
          MODEL,
          reason,
          until,
        ]),
      );
    await mark(null, null);
    // Security review S4: kept_app may not mark, not even an admin of the location.
    expect(
      (
        await pgError(
          as(user(ibrahim.userId), (c) =>
            c.query(`SELECT kept.embedding_mark($1, $2, 'provider', 0, NULL)`, [
              ibrahim.locationId,
              MODEL,
            ]),
          ),
        )
      ).code,
    ).toBe('42501');
    const instance = (scope: Scope) =>
      as(
        scope,
        async (c) => (await c.query('SELECT * FROM kept.embedding_status_instance()')).rows,
      );
    expect(await instance(user(ibrahim.userId))).toEqual([
      {
        source: 'provider',
        model_key: MODEL,
        locations: 1,
        embedded: '3',
        pending: '0',
        paused: 0,
        paused_until: null,
        paused_reason: null,
      },
    ]);
    expect((await pgError(instance(user(bruce)))).code).toBe('42501');

    // A cap's pause, with its end: shown, and the backfill skips the location until then.
    const live = () =>
      system(async (c) =>
        (
          await c.query<{ location_id: string }>(
            'SELECT location_id FROM kept.embedding_backfill_locations()',
          )
        ).rows.map((r) => r.location_id),
      );
    expect(await live()).toEqual(expect.arrayContaining([ibrahim.locationId, garage.locationId]));
    await mark('cap_money', '2999-01-01T00:00:00Z');
    expect(await instance(user(ibrahim.userId))).toEqual([
      expect.objectContaining({
        paused: 1,
        paused_until: new Date('2999-01-01T00:00:00Z'),
        paused_reason: 'cap_money',
      }),
    ]);
    expect(await live()).not.toContain(ibrahim.locationId);
    expect(await live()).toContain(garage.locationId);
    // An endless pause keeps no end, so the next run tries again; and an ended one is retried.
    await mark('manual', 'infinity');
    expect(await live()).toContain(ibrahim.locationId);
    await mark('rate_limited', '2000-01-01T00:00:00Z');
    expect(await live()).toContain(ibrahim.locationId);
    // A deleted location isn't visited.
    await own('UPDATE public.locations SET deleted_at = now() WHERE id = $1', [garage.locationId]);
    expect(await live()).not.toContain(garage.locationId);
    await own('UPDATE public.locations SET deleted_at = NULL WHERE id = $1', [garage.locationId]);
  });

  it('kept.embedding_backlog_thing(): one visible thing, until its vector is current', async () => {
    const [pending] = await backlog('system', ibrahim.locationId);
    expect(pending).toBeTruthy();
    const one = (scope: Scope, thingId: string) =>
      as(
        scope,
        async (c) =>
          (await c.query('SELECT * FROM kept.embedding_backlog_thing($1, $2)', [thingId, MODEL]))
            .rows,
      );
    const id = pending?.thing_id as string;
    await store('system', ibrahim.locationId, [
      { thing_id: id, content_hash: 'f'.repeat(64), embedding: [1, 0, 0] },
    ]);
    expect(await one(user(ibrahim.userId), id)).toEqual([
      { thing_id: id, text: pending?.text, content_hash: pending?.content_hash },
    ]);
    // Someone who doesn't see the location gets nothing.
    expect(await one(user(alfred.userId), id)).toEqual([]);
    await store('system', ibrahim.locationId, [
      { thing_id: id, content_hash: pending?.content_hash as string, embedding: [1, 0, 0] },
    ]);
    expect(await one(user(ibrahim.userId), id)).toEqual([]);
  });

  it("kept.ai_provider_for_system(): the system's, for embeddings in a location only", async () => {
    expect(
      (
        await pgError(
          as(user(ibrahim.userId), (c) =>
            c.query(`SELECT * FROM kept.ai_provider_for_system($1, 'embeddings')`, [
              ibrahim.locationId,
            ]),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await pgError(
          system((c) =>
            c.query(`SELECT * FROM kept.ai_provider_for_system($1, 'assistant')`, [
              ibrahim.locationId,
            ]),
          ),
        )
      ).code,
    ).toBe('22023');
    const none = await system((c) =>
      c.query(`SELECT * FROM kept.ai_provider_for_system($1, 'embeddings')`, [ibrahim.locationId]),
    );
    expect(none.rows).toEqual([]);
  });
});
