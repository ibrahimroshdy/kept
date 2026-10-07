import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  asOwner,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { diffRows } from '../audit/audited.js';
import { type Scope, withScope } from './scope.js';

// Task 6: things, short IDs, links, tag rows, and the places extension (engineering spec §1.3,
// §7.9, §7.13; D10, D42, D45, D76, D120, D177, D183; plan Q1, Q5, Q11, Q12). As kept_app unless
// noted.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string, mfa = false): Scope => ({ userId, mfa });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function builtin(key: string): Promise<string> {
  const { rows } = await asOwner(db, (c) =>
    c.query(`SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1`, [
      key,
    ]),
  );
  return rows[0].id;
}

type ThingInput = {
  id?: string;
  placeId?: string | null;
  containerId?: string | null;
  name?: string | null;
  typeId?: string | null;
  brandId?: string | null;
  personId?: string | null;
  quantity?: number;
  aliases?: Record<string, string[]>;
  reviewState?: string;
};

/** Inserts a thing in `t`'s location as `t`'s user (or `scope`); returns its id. */
async function thing(t: Tenant, input: ThingInput = {}, scope: Scope = as(t.userId)) {
  const id = input.id ?? newId();
  await q(
    scope,
    `INSERT INTO public.things (id, location_id, place_id, container_id, name, type_id, brand_id,
                                belongs_to_person_id, quantity, aliases, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      t.locationId,
      input.containerId ? (input.placeId ?? null) : (input.placeId ?? t.unplacedId),
      input.containerId ?? null,
      input.name === undefined ? 'Thing' : input.name,
      input.typeId ?? null,
      input.brandId ?? null,
      input.personId ?? null,
      input.quantity ?? 1,
      JSON.stringify(input.aliases ?? {}),
      input.reviewState ?? 'confirmed',
    ],
  );
  return id;
}

async function place(t: Tenant, name: string, parentId: string | null = null) {
  const id = newId();
  await q(
    as(t.userId),
    'INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, $4)',
    [id, t.locationId, parentId, name],
  );
  return id;
}

const bookkeeping = async (id: string) =>
  (
    await asOwner(db, (c) =>
      c.query<{ row_version: number; change_seq: string; search_tsv: string; place_path: string }>(
        `SELECT row_version, change_seq, search_tsv::text, place_path FROM public.things
          WHERE id = $1`,
        [id],
      ),
    )
  ).rows[0];

describe('things: where a thing is', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  it('sits in exactly one place or one container', async () => {
    const box = await thing(a, { name: 'Box' });
    const both = await pgError(thing(a, { placeId: a.unplacedId, containerId: box }));
    expect(both).toMatchObject({ code: '23514', constraint: 'things_one_parent_chk' });
    await thing(a, { containerId: box });
  });

  it('refuses a container loop (D45)', async () => {
    const outer = await thing(a, { name: 'Outer' });
    const inner = await thing(a, { name: 'Inner', containerId: outer });
    const err = await pgError(
      q(as(a.userId), 'UPDATE public.things SET place_id = NULL, container_id = $1 WHERE id = $2', [
        inner,
        outer,
      ]),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'things_no_loop' });
  });

  it('keeps the path from the root place to the innermost container', async () => {
    const room = await place(a, 'Kitchen');
    const shelf = await place(a, 'Shelf', room);
    const box = await thing(a, { name: 'Box', placeId: shelf });
    const cable = await thing(a, { name: 'Cable', containerId: box });
    const [path] = await q<{ p: unknown }>(as(a.userId), 'SELECT kept.path_of(NULL, $1) AS p', [
      box,
    ]);
    expect(path?.p).toEqual([
      { id: room, name: 'Kitchen', kind: 'place' },
      { id: shelf, name: 'Shelf', kind: 'place' },
      { id: box, name: 'Box', kind: 'container' },
    ]);
    expect((await bookkeeping(cable))?.place_path).toBe('Kitchen › Shelf › Box');
  });

  it('refuses a draft-less thing without a name, but allows a nameless draft', async () => {
    const err = await pgError(thing(a, { name: null }));
    expect(err).toMatchObject({ code: '23514', constraint: 'things_named_chk' });
    await thing(a, { name: null, reviewState: 'draft' });
  });
});

describe("things: registries of the location's own account (§7.13, D178)", () => {
  let a: Tenant;
  let b: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses B's type, brand or person on A's thing exactly like a random id (42501)", async () => {
    const theirs = newId();
    const brand = newId();
    const person = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.types (id, owner_account_id, name, icon) VALUES ($1, $2, 'T', 'lucide:box')`,
        [theirs, b.accountId],
      );
      await c.query(`INSERT INTO public.brands (id, owner_account_id, name) VALUES ($1, $2, 'B')`, [
        brand,
        b.accountId,
      ]);
      await c.query(
        `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'P')`,
        [person, b.accountId],
      );
    });
    for (const input of [
      { typeId: theirs },
      { typeId: newId() },
      { brandId: brand },
      { brandId: newId() },
      { personId: person },
      { personId: newId() },
      { typeId: await builtin('device') }, // a field group is no type for a thing
    ]) {
      const err = await pgError(thing(a, input));
      expect(err, JSON.stringify(input)).toMatchObject({
        code: '42501',
        constraint: 'things_registry_account',
      });
    }
    await thing(a, { typeId: await builtin('phone') });
  });

  it("refuses B's tag on A's thing (42501)", async () => {
    const mine = await thing(a);
    const tag = newId();
    await ownerTx(db, (c) =>
      c.query(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'T')`, [
        tag,
        b.accountId,
      ]),
    );
    const err = await pgError(
      q(
        as(a.userId),
        'INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)',
        [a.locationId, mine, tag],
      ),
    );
    expect(err).toMatchObject({ code: '42501', constraint: 'thing_tags_account' });
  });
});

describe('things: quantity (D10, §7.13, Q11)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  it('keeps a serialized or metered thing at 1', async () => {
    for (const key of ['phone', 'car']) {
      const err = await pgError(thing(a, { typeId: await builtin(key), quantity: 2 }));
      expect(err, key).toMatchObject({ code: '23514', constraint: 'things_quantity_one' });
    }
    const phone = await thing(a, { typeId: await builtin('phone') });
    const change = await pgError(
      q(as(a.userId), 'UPDATE public.things SET quantity = 3 WHERE id = $1', [phone]),
    );
    expect(change).toMatchObject({ code: '23514', constraint: 'things_quantity_one' });
  });

  it('allows 0 only for a consumable', async () => {
    await thing(a, { typeId: await builtin('batteries'), quantity: 0 });
    const err = await pgError(thing(a, { typeId: await builtin('furniture'), quantity: 0 }));
    expect(err).toMatchObject({ code: '23514', constraint: 'things_quantity_positive' });
    await thing(a, { typeId: await builtin('furniture'), quantity: 4 });
  });
});

describe('things: search document and caches (§7.9, D42, Q1)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  const search = (tsq: string) =>
    q<{ id: string }>(
      as(a.userId),
      `SELECT id FROM public.things WHERE search_tsv @@ to_tsquery('simple', $1)`,
      [tsq],
    ).then((r) => r.map((x) => x.id));

  it('finds الكابل by كابل and by an alias, and a typo by trigram', async () => {
    const id = await thing(a, { name: 'الكابل HDMI', aliases: { en: ['cable'] } });
    expect(await search('كابل:*')).toEqual([id]);
    expect(await search('cable:*')).toEqual([id]);
    expect(await search('hdmi:*')).toEqual([id]);
    const typo = await q<{ id: string }>(
      as(a.userId),
      `SELECT id FROM public.things WHERE kept.normalize(name) % kept.normalize($1)`,
      ['الكابل HDMII'],
    );
    expect(typo.map((r) => r.id)).toEqual([id]);
  });

  it('indexes brand, type, tags, person and scalar custom values, never money', async () => {
    const brand = newId();
    const person = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.brands (id, owner_account_id, name) VALUES ($1, $2, 'Samsung')`,
        [brand, a.accountId],
      );
      await c.query(
        `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
        [person, a.accountId],
      );
    });
    const id = await thing(a, { brandId: brand, personId: person, typeId: await builtin('phone') });
    await q(
      as(a.userId),
      `UPDATE public.things SET custom = '{"imei": "35123", "price": {"amount": "999.5", "currency": "EGP"}}'
        WHERE id = $1`,
      [id],
    );
    for (const term of ['samsung', 'alfred', 'phone', 'هاتف', '35123']) {
      expect(await search(`${term}:*`), term).toEqual([id]);
    }
    const doc = (await bookkeeping(id))?.search_tsv ?? '';
    expect(doc).not.toContain('999');
    expect(doc).not.toContain('egp');
  });

  it('bumps row_version on a rename, but not for a tag (quiet cache change)', async () => {
    const id = await thing(a, { name: 'Lamp' });
    const tag = newId();
    await ownerTx(db, (c) =>
      c.query(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'Garden')`, [
        tag,
        a.accountId,
      ]),
    );
    const start = await bookkeeping(id);
    await q(
      as(a.userId),
      'INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)',
      [a.locationId, id, tag],
    );
    const tagged = await bookkeeping(id);
    expect(tagged?.row_version).toBe(start?.row_version);
    expect(tagged?.change_seq).toBe(start?.change_seq);
    expect(tagged?.search_tsv).toContain('garden');
    expect(await search('garden:*')).toEqual([id]);
    await q(as(a.userId), `UPDATE public.things SET name = 'Desk lamp' WHERE id = $1`, [id]);
    expect((await bookkeeping(id))?.row_version).toBe((start?.row_version ?? 0) + 1);
    // Removing the tag refreshes the document the same quiet way.
    await q(as(a.userId), 'DELETE FROM public.thing_tags WHERE thing_id = $1', [id]);
    expect(await search('garden:*')).toEqual([]);
    expect((await bookkeeping(id))?.row_version).toBe((start?.row_version ?? 0) + 1);
  });

  it('bumps change_seq only when last_seen_at changes', async () => {
    const id = await thing(a);
    const start = await bookkeeping(id);
    await q(as(a.userId), 'UPDATE public.things SET last_seen_at = now() WHERE id = $1', [id]);
    const seen = await bookkeeping(id);
    expect(seen?.row_version).toBe(start?.row_version);
    expect(BigInt(seen?.change_seq ?? 0)).toBeGreaterThan(BigInt(start?.change_seq ?? 0));
  });

  it("can't be written directly: a caller's search_tsv is recomputed, place_path is not granted", async () => {
    const id = await thing(a, { name: 'Lamp' });
    await q(
      as(a.userId),
      `UPDATE public.things SET search_tsv = to_tsvector('simple', 'injected') WHERE id = $1`,
      [id],
    );
    expect(await search('injected:*')).toEqual([]);
    expect(await search('lamp:*')).toEqual([id]);
    const err = await pgError(
      q(as(a.userId), `UPDATE public.things SET place_path = 'x' WHERE id = $1`, [id]),
    );
    expect(err.code).toBe('42501');
  });

  it('never audits the cache columns; ended_price is money (§7.5)', () => {
    const diff = diffRows(
      'thing',
      { name: 'a', place_path: 'x', searchTsv: "'a':1", endedPrice: null },
      { name: 'b', place_path: 'y', searchTsv: "'b':1", endedPrice: '10.0000' },
    );
    expect(Object.keys(diff).sort()).toEqual(['ended_price', 'name']);
    expect(diff.ended_price).toMatchObject({ class: 'money' });
  });
});

describe('short IDs (D45, D120, §7.13)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  it('turn into retired tombstones when their thing is purged, keeping the location', async () => {
    const id = await thing(a);
    const code = randomShortCode();
    await q(
      as(a.userId),
      'INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)',
      [code, a.locationId, id],
    );
    await ownerTx(db, (c) => c.query('DELETE FROM public.things WHERE id = $1', [id]));
    const { rows } = await asOwner(db, (c) =>
      c.query(
        'SELECT location_id, thing_id, state, is_primary FROM public.short_ids WHERE code = $1',
        [code],
      ),
    );
    expect(rows).toEqual([
      { location_id: a.locationId, thing_id: null, state: 'retired', is_primary: false },
    ]);
  });

  it('are never deleted through kept_app', async () => {
    const id = await thing(a);
    const code = randomShortCode();
    await q(
      as(a.userId),
      'INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)',
      [code, a.locationId, id],
    );
    const deleted = await withScope(
      app,
      as(a.userId),
      async (_tx, c) =>
        (await c.query('DELETE FROM public.short_ids WHERE code = $1', [code])).rowCount,
    );
    expect(deleted).toBe(0);
  });

  it('allow one primary code per thing', async () => {
    const id = await thing(a);
    const insert = (primary: boolean) =>
      q(
        as(a.userId),
        `INSERT INTO public.short_ids (code, location_id, thing_id, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [randomShortCode(), a.locationId, id, primary],
      );
    await insert(true);
    await insert(false);
    expect(await pgError(insert(true))).toMatchObject({
      code: '23505',
      constraint: 'short_ids_primary_thing_uq',
    });
  });

  it('survive their location being purged, as retired codes (Q12: NO ACTION lets the cascade run)', async () => {
    const loc = await ownerTx(db, (c) => insertLocation(c, a));
    const t: Tenant = { ...a, ...loc };
    const room = newId();
    const inner = newId();
    const box = newId();
    const code = randomShortCode();
    await ownerTx(db, async (c) => {
      await c.query('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
        room,
        t.locationId,
        'Room',
      ]);
      await c.query(
        'INSERT INTO public.places (location_id, parent_id, name) VALUES ($1, $2, $3)',
        [t.locationId, room, 'Shelf'],
      );
      await c.query(
        'INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)',
        [box, t.locationId, room, 'Box'],
      );
      await c.query(
        'INSERT INTO public.things (id, location_id, container_id, name) VALUES ($1, $2, $3, $4)',
        [inner, t.locationId, box, 'Inner'],
      );
      await c.query(
        'INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)',
        [code, t.locationId, inner],
      );
    });
    await ownerTx(db, (c) => c.query('DELETE FROM public.locations WHERE id = $1', [t.locationId]));
    const { rows } = await asOwner(db, (c) =>
      c.query('SELECT location_id, state FROM public.short_ids WHERE code = $1', [code]),
    );
    expect(rows).toEqual([{ location_id: t.locationId, state: 'retired' }]);
  });
});

describe('links and places', () => {
  it('refuses a link to itself and a duplicate link', async () => {
    const a = await seedTenant(db, 'a');
    const one = await thing(a);
    const two = await thing(a);
    const link = (from: string, to: string) =>
      q(
        as(a.userId),
        `INSERT INTO public.thing_links (location_id, from_thing_id, to_thing_id, kind)
         VALUES ($1, $2, $3, 'accessory_of')`,
        [a.locationId, from, to],
      );
    expect(await pgError(link(one, one))).toMatchObject({
      code: '23514',
      constraint: 'thing_links_not_self_chk',
    });
    await link(one, two);
    expect(await pgError(link(one, two))).toMatchObject({ code: '23505' });
  });

  it("lets a writer set a place's icon, sort, custom and trash batch", async () => {
    const a = await seedTenant(db, 'a');
    const room = await place(a, 'Room');
    const rows = await q(
      as(a.userId),
      `UPDATE public.places SET icon = 'lucide:sofa', sort = 2, custom = '{"depth": 3}',
         trash_batch_id = $2 WHERE id = $1 RETURNING row_version`,
      [room, newId()],
    );
    expect(rows).toEqual([{ row_version: 2 }]);
  });
});

describe('person contacts after task 6 (D177, Q5)', () => {
  it('hide contacts from an admin who does not administer every location using the person', async () => {
    const b = await seedTenant(db, 'b');
    const second = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    const admin = await seedUser(db, 'admin-of-home');
    await addMember(db, b.locationId, admin, 'admin');
    await addMember(db, second.locationId, admin, 'member');
    const person = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
        [person, b.accountId],
      );
      await c.query(
        `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '1')`,
        [person, b.accountId],
      );
    });
    const read = () =>
      q(as(admin), 'SELECT phone FROM public.person_contacts WHERE person_id = $1', [person]);
    expect(await read()).toEqual([{ phone: '1' }]);
    const inFlat = newId();
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.things (id, location_id, place_id, name, belongs_to_person_id)
         VALUES ($1, $2, $3, 'Bike', $4)`,
        [inFlat, second.locationId, second.unplacedId, person],
      ),
    );
    expect(await read()).toEqual([]);
    // A trashed thing no longer counts.
    await ownerTx(db, (c) =>
      c.query('UPDATE public.things SET deleted_at = now() WHERE id = $1', [inFlat]),
    );
    expect(await read()).toEqual([{ phone: '1' }]);
    // The owner administers both.
    expect(
      await q(as(b.userId), 'SELECT phone FROM public.person_contacts WHERE person_id = $1', [
        person,
      ]),
    ).toEqual([{ phone: '1' }]);
  });
});

describe('who made a row is the database’s to say (security review minor)', () => {
  it('stamps created_by, logged_by, claimed_by and received_at from the request, not the client', async () => {
    const a = await seedTenant(db, 'a');
    const member = await seedUser(db, 'member');
    await addMember(db, a.locationId, member, 'member');
    const [box, lamp, room, purchase, meter, reading] = Array.from({ length: 6 }, () => newId());
    const code = randomShortCode();
    await withScope(app, as(member), async (_tx, c) => {
      await c.query(
        `INSERT INTO public.things (id, location_id, place_id, name, created_by) VALUES
           ($1, $3, $4, 'Box', $5), ($2, $3, $4, 'Lamp', $5)`,
        [box, lamp, a.locationId, a.unplacedId, a.userId],
      );
      await c.query(
        `INSERT INTO public.places (id, location_id, name, created_by) VALUES ($1, $2, 'Room', $3)`,
        [room, a.locationId, a.userId],
      );
      await c.query(
        `INSERT INTO public.thing_links (location_id, from_thing_id, to_thing_id, kind, created_by)
         VALUES ($1, $2, $3, 'related', $4)`,
        [a.locationId, lamp, box, a.userId],
      );
      await c.query(
        `INSERT INTO public.short_ids (code, location_id, thing_id, claimed_at, claimed_by)
         VALUES ($1, $2, $3, now(), $4)`,
        [code, a.locationId, box, a.userId],
      );
      await c.query(
        `INSERT INTO public.purchases (id, location_id, purchased_on, created_by) VALUES ($1, $2, '2026-09-01', $3)`,
        [purchase, a.locationId, a.userId],
      );
      await c.query(
        `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
        [meter, a.locationId, box],
      );
      await c.query(
        `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at, logged_by, received_at)
         VALUES ($1, $2, $3, 1, now(), $4, '2020-01-01')`,
        [reading, a.locationId, meter, a.userId],
      );
    });
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT (SELECT array_agg(DISTINCT created_by) FROM public.things WHERE id IN ($1, $2)) AS things,
                (SELECT created_by FROM public.places WHERE id = $3) AS place,
                (SELECT created_by FROM public.thing_links WHERE from_thing_id = $2) AS link,
                (SELECT claimed_by FROM public.short_ids WHERE code = $4) AS code,
                (SELECT created_by FROM public.purchases WHERE id = $5) AS purchase,
                (SELECT logged_by FROM public.meter_readings WHERE id = $6) AS logged,
                (SELECT received_at > now() - interval '1 minute' FROM public.meter_readings
                  WHERE id = $6) AS received_now`,
        [box, lamp, room, code, purchase, reading],
      ),
    );
    expect(rows[0]).toEqual({
      things: [member],
      place: member,
      link: member,
      code: member,
      purchase: member,
      logged: member,
      received_now: true,
    });
  });
});
