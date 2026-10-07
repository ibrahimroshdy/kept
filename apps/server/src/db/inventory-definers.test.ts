import { createHash } from 'node:crypto';
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
import { type Scope, withScope } from './scope.js';

// Task 9: the definer paths (engineering spec §6.1, §7.2, §7.4, §7.13; D45, D92, D115, D123,
// D160, D161, D177; plan Q13, Q13b, Q14): moves, conversions, merges, customising types and
// their impact. Called as kept_app, the way the routes will.

const db = await testDb();
const app = db.pools.app;

beforeEach(async () => {
  await db.reset();
});

const as = (userId: string): Scope => ({ userId, mfa: false });

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  scope: Scope,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return withScope(app, scope, async (_tx, client) => (await client.query<T>(text, values)).rows);
}

async function own<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await asOwner(db, (c) => c.query<T>(text, values))).rows;
}

async function builtin(key: string): Promise<string> {
  const rows = await own<{ id: string }>(
    'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
    [key],
  );
  return rows[0]?.id as string;
}

type Loc = { locationId: string; unplacedId: string };

/** A thing inserted as kept_owner. */
async function thing(
  loc: Loc,
  fields: { name?: string; placeId?: string; containerId?: string; typeId?: string } = {},
) {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name, type_id, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '30 days')`,
    [
      id,
      loc.locationId,
      fields.containerId ? null : (fields.placeId ?? loc.unplacedId),
      fields.containerId ?? null,
      fields.name ?? 'Thing',
      fields.typeId ?? null,
    ],
  );
  return id;
}

async function place(loc: Loc, name: string, parentId: string | null = null) {
  const id = newId();
  await own(
    'INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, $4)',
    [id, loc.locationId, parentId, name],
  );
  return id;
}

async function shortCode(loc: Loc, target: { thingId?: string; placeId?: string }) {
  const code = randomShortCode();
  await own(
    'INSERT INTO public.short_ids (code, location_id, thing_id, place_id) VALUES ($1, $2, $3, $4)',
    [code, loc.locationId, target.thingId ?? null, target.placeId ?? null],
  );
  return code;
}

async function file(loc: Loc, userId: string) {
  const id = newId();
  await own(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
    [
      id,
      loc.locationId,
      `f/${loc.locationId}/${id}`,
      createHash('sha256').update(id).digest('hex'),
      userId,
    ],
  );
  await own(
    `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height, bytes)
     VALUES ($1, 'thumb', $2, $3, 1, 1, 1)`,
    [id, loc.locationId, `d/${id}/thumb.jpg`],
  );
  return id;
}

const move = (
  userId: string,
  ids: string[],
  to: string,
  placeId: string | null,
  containerId: string | null = null,
) =>
  q<{
    thing_id: string;
    from_location: string;
    dropped_link_ids: string[];
    dropped_incident_ids: string[];
  }>(as(userId), 'SELECT * FROM kept.move_things($1, $2, $3, $4)', [ids, to, placeId, containerId]);

describe('kept.move_things() within an account (D45)', () => {
  let a: Tenant;
  let flat: Loc;
  let member: string;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    member = await seedUser(db, 'member');
    await addMember(db, a.locationId, member, 'member');
    await addMember(db, flat.locationId, member, 'member');
  });

  it('moves a box with its contents, codes and meters; contents keep last_seen_at; tombstones the source', async () => {
    const box = await thing(a, { name: 'Box' });
    const one = await thing(a, { name: 'One', containerId: box });
    const two = await thing(a, { name: 'Two', containerId: box });
    const code = await shortCode(a, { thingId: one });
    const meter = newId();
    await own(
      `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
      [meter, a.locationId, box],
    );
    const shelf = await place(flat, 'Shelf');
    const before = await own<{ id: string; last_seen_at: Date }>(
      'SELECT id, last_seen_at FROM public.things WHERE id = ANY ($1)',
      [[one, two]],
    );
    const rows = await move(member, [box], flat.locationId, shelf);
    expect(rows.map((r) => r.thing_id).sort()).toEqual([box, one, two].sort());
    expect(new Set(rows.map((r) => r.from_location))).toEqual(new Set([a.locationId]));

    const after = await own<{
      id: string;
      location_id: string;
      place_id: string | null;
      container_id: string | null;
      last_seen_at: Date;
      place_path: string;
    }>(
      'SELECT id, location_id, place_id, container_id, last_seen_at, place_path FROM public.things WHERE id = ANY ($1)',
      [[box, one, two]],
    );
    for (const r of after) expect(r.location_id).toBe(flat.locationId);
    const boxRow = after.find((r) => r.id === box);
    expect(boxRow).toMatchObject({ place_id: shelf, container_id: null, place_path: 'Shelf' });
    expect(boxRow?.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    for (const b of before) {
      const r = after.find((x) => x.id === b.id);
      expect(r?.container_id).toBe(box);
      expect(r?.last_seen_at.getTime()).toBe(b.last_seen_at.getTime());
      expect(r?.place_path).toBe('Shelf › Box');
    }
    expect(
      await own('SELECT location_id, thing_id FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ location_id: flat.locationId, thing_id: one }]);
    expect(await own('SELECT location_id FROM public.meters WHERE id = $1', [meter])).toEqual([
      { location_id: flat.locationId },
    ]);
    const tombs = await own<{ entity_id: string }>(
      `SELECT entity_id FROM public.sync_tombstones WHERE location_id = $1 AND entity_type = 'thing'`,
      [a.locationId],
    );
    expect(tombs.map((t) => t.entity_id).sort()).toEqual([box, one, two].sort());
  });

  it('keeps the purchase line in the old location (D115) and drops links that would cross', async () => {
    const purchase = newId();
    const line = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on) VALUES ($1, $2, '2026-09-01')`,
      [purchase, a.locationId],
    );
    await own(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description) VALUES ($1, $2, $3, 'x')`,
      [line, a.locationId, purchase],
    );
    const lamp = await thing(a, { name: 'Lamp' });
    await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, lamp]);
    const bulb = await thing(a, { name: 'Bulb' });
    const link = newId();
    await own(
      `INSERT INTO public.thing_links (id, location_id, from_thing_id, to_thing_id, kind)
       VALUES ($1, $2, $3, $4, 'consumable_for')`,
      [link, a.locationId, bulb, lamp],
    );
    const rows = await move(member, [lamp], flat.locationId, flat.unplacedId);
    expect(rows).toEqual([
      {
        thing_id: lamp,
        from_location: a.locationId,
        dropped_link_ids: [link],
        // 0051: the incidents it left (none here).
        dropped_incident_ids: [],
      },
    ]);
    expect(await own('SELECT purchase_line_id FROM public.things WHERE id = $1', [lamp])).toEqual([
      { purchase_line_id: line },
    ]);
    expect(await own('SELECT id FROM public.thing_links WHERE id = $1', [link])).toEqual([]);
  });

  it('refuses a viewer of the target, an invisible thing, and a missing target alike (42501)', async () => {
    const viewer = await seedUser(db, 'viewer');
    await addMember(db, a.locationId, viewer, 'member');
    await addMember(db, flat.locationId, viewer, 'viewer');
    const lamp = await thing(a);
    const b = await seedTenant(db, 'b');
    const theirs = await thing(b);
    // Thunks, awaited one at a time: promises made up front would reject unhandled while the
    // loop awaits the first.
    for (const call of [
      () => move(viewer, [lamp], flat.locationId, flat.unplacedId),
      () => move(member, [theirs], flat.locationId, flat.unplacedId),
      () => move(member, [newId()], flat.locationId, flat.unplacedId),
      () => move(member, [lamp], flat.locationId, newId()),
      () => move(member, [lamp], b.locationId, b.unplacedId),
    ]) {
      expect((await pgError(call())).code).toBe('42501');
    }
  });

  it('refuses moving a box into something inside it', async () => {
    const box = await thing(a, { name: 'Box' });
    const inner = await thing(a, { name: 'Inner', containerId: box });
    expect(await pgError(move(member, [box], a.locationId, null, inner))).toMatchObject({
      code: '23514',
      constraint: 'things_no_loop',
    });
    expect((await pgError(move(member, [box], a.locationId, null, null))).code).toBe('22023');
  });
});

describe('kept.move_things() across accounts (Q13, D161)', () => {
  it('copies the custom type, tag, person and purchase with its receipt; files share the blob', async () => {
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, m.userId, 'member');
    // In the mover's own account: a custom type under the built-in phone, with a secret field.
    const foldable = newId();
    const pin = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon) VALUES ($1, $2, $3, 'Foldable', 'lucide:box')`,
      [foldable, m.accountId, await builtin('phone')],
    );
    await own(
      `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind, secret)
       VALUES ($1, $2, $3, 'pin', 'PIN', 'text', true)`,
      [pin, m.accountId, foldable],
    );
    const tag = newId();
    const person = newId();
    await own(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'Travel')`, [
      tag,
      m.accountId,
    ]);
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
      [person, m.accountId],
    );
    await own(
      `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '1')`,
      [person, m.accountId],
    );
    // B already has a tag of the same name, differently cased.
    const bTag = newId();
    await own(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'TRAVEL')`, [
      bTag,
      b.accountId,
    ]);
    const purchase = newId();
    const line = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total) VALUES ($1, $2, '2026-09-01', 'EGP', 50)`,
      [purchase, m.locationId],
    );
    await own(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description) VALUES ($1, $2, $3, 'Phone')`,
      [line, m.locationId, purchase],
    );
    const receipt = await file(m, m.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by) VALUES ($1, $2, $3, 'receipt', $4)`,
      [m.locationId, receipt, purchase, m.userId],
    );
    const phone = await thing(m, { name: 'Phone', typeId: foldable });
    await own(
      'UPDATE public.things SET purchase_line_id = $1, belongs_to_person_id = $2 WHERE id = $3',
      [line, person, phone],
    );
    await own('INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)', [
      m.locationId,
      phone,
      tag,
    ]);
    const photo = await file(m, m.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by) VALUES ($1, $2, $3, 'photo', $4)`,
      [m.locationId, photo, phone, m.userId],
    );
    await own(
      `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext, key_version, updated_by)
       VALUES ($1, $2, $3, 'pin', '{"c": "x"}', 1, $4)`,
      [m.locationId, phone, pin, m.userId],
    );

    await move(m.userId, [phone], b.locationId, b.unplacedId);

    const [moved] = await own<{
      location_id: string;
      type_id: string;
      belongs_to_person_id: string;
      purchase_line_id: string;
    }>(
      'SELECT location_id, type_id, belongs_to_person_id, purchase_line_id FROM public.things WHERE id = $1',
      [phone],
    );
    expect(moved?.location_id).toBe(b.locationId);
    // The type: a copy in B's account, same name, same built-in parent, with its field.
    const [copy] = await own<{ owner_account_id: string; name: string; parent: string }>(
      `SELECT t.owner_account_id, t.name, p.builtin_key AS parent FROM public.types t
         JOIN public.types p ON p.id = t.parent_id WHERE t.id = $1`,
      [moved?.type_id],
    );
    expect(copy).toEqual({ owner_account_id: b.accountId, name: 'Foldable', parent: 'phone' });
    // The secret value follows onto the copy's field.
    expect(
      await own(
        `SELECT f.owner_account_id, f.type_id FROM public.secret_values s JOIN public.type_fields f ON f.id = s.type_field_id
          WHERE s.thing_id = $1`,
        [phone],
      ),
    ).toEqual([{ owner_account_id: b.accountId, type_id: moved?.type_id }]);
    // The tag: B's own, matched by normalised name.
    expect(await own('SELECT tag_id FROM public.thing_tags WHERE thing_id = $1', [phone])).toEqual([
      { tag_id: bTag },
    ]);
    // The person: by name only; contacts stay behind (D177).
    const [p] = await own<{ owner_account_id: string; display_name: string; contacts: number }>(
      `SELECT p.owner_account_id, p.display_name,
              (SELECT count(*) FROM public.person_contacts c WHERE c.person_id = p.id)::int AS contacts
         FROM public.people p WHERE p.id = $1`,
      [moved?.belongs_to_person_id],
    );
    expect(p).toEqual({ owner_account_id: b.accountId, display_name: 'Alfred', contacts: 0 });
    // The purchase line and its receipt, copied into B's location, the blob shared.
    const [copied] = await own<{ location_id: string; purchase_id: string }>(
      'SELECT location_id, purchase_id FROM public.purchase_lines WHERE id = $1',
      [moved?.purchase_line_id],
    );
    expect(copied?.location_id).toBe(b.locationId);
    expect(copied?.purchase_id).not.toBe(purchase);
    const storage = (id: string) =>
      own<{ storage_key: string }>('SELECT storage_key FROM public.files WHERE id = $1', [id]).then(
        (r) => r[0]?.storage_key,
      );
    const [receiptCopy] = await own<{ file_id: string; location_id: string }>(
      `SELECT a.file_id, f.location_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
        WHERE a.purchase_id = $1`,
      [copied?.purchase_id],
    );
    expect(receiptCopy?.location_id).toBe(b.locationId);
    expect(await storage(receiptCopy?.file_id as string)).toBe(await storage(receipt));
    const [photoCopy] = await own<{ file_id: string; location_id: string }>(
      `SELECT a.file_id, f.location_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
        WHERE a.thing_id = $1`,
      [phone],
    );
    expect(photoCopy?.location_id).toBe(b.locationId);
    expect(photoCopy?.file_id).not.toBe(photo);
    expect(await storage(photoCopy?.file_id as string)).toBe(await storage(photo));
    expect(
      await own('SELECT storage_key FROM public.file_derivatives WHERE file_id = $1', [
        photoCopy?.file_id,
      ]),
    ).toEqual([{ storage_key: `d/${photo}/thumb.jpg` }]);
    // The originals are untouched in the mover's account.
    expect(await own('SELECT location_id FROM public.purchases WHERE id = $1', [purchase])).toEqual(
      [{ location_id: m.locationId }],
    );
    expect(await own('SELECT location_id FROM public.files WHERE id = $1', [photo])).toEqual([
      { location_id: m.locationId },
    ]);
  });
});

describe('conversions between a place and a container (D160, Q14)', () => {
  let a: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
  });

  it('turns a place into a container and back, keeping the id, codes and attachments', async () => {
    const room = await place(a, 'Room');
    const shelf = await place(a, 'Shelf', room);
    const one = await thing(a, { placeId: shelf });
    const two = await thing(a, { placeId: shelf });
    const code = await shortCode(a, { placeId: shelf });
    const photo = await file(a, a.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, place_id, role, created_by) VALUES ($1, $2, $3, 'photo', $4)`,
      [a.locationId, photo, shelf, a.userId],
    );
    const [converted] = await q<{ id: string }>(
      as(a.userId),
      'SELECT kept.convert_place_to_container($1, NULL) AS id',
      [shelf],
    );
    expect(converted?.id).toBe(shelf);
    expect(
      await own(
        `SELECT t.place_id, ty.builtin_key FROM public.things t JOIN public.types ty ON ty.id = t.type_id WHERE t.id = $1`,
        [shelf],
      ),
    ).toEqual([{ place_id: room, builtin_key: 'box_bin' }]);
    expect(
      await own('SELECT container_id FROM public.things WHERE id = ANY ($1)', [[one, two]]),
    ).toEqual([{ container_id: shelf }, { container_id: shelf }]);
    expect(
      await own('SELECT thing_id, place_id FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ thing_id: shelf, place_id: null }]);
    expect(
      await own('SELECT thing_id FROM public.attachments WHERE file_id = $1', [photo]),
    ).toEqual([{ thing_id: shelf }]);
    expect(await own('SELECT id FROM public.places WHERE id = $1', [shelf])).toEqual([]);
    expect(
      await own(
        `SELECT 1 FROM public.sync_tombstones WHERE entity_type = 'place' AND entity_id = $1`,
        [shelf],
      ),
    ).toHaveLength(1);

    await q(as(a.userId), 'SELECT kept.convert_container_to_place($1, NULL)', [shelf]);
    expect(await own('SELECT parent_id, name FROM public.places WHERE id = $1', [shelf])).toEqual([
      { parent_id: room, name: 'Shelf' },
    ]);
    expect(
      await own('SELECT place_id, container_id FROM public.things WHERE id = ANY ($1)', [
        [one, two],
      ]),
    ).toEqual([
      { place_id: shelf, container_id: null },
      { place_id: shelf, container_id: null },
    ]);
    expect(
      await own('SELECT thing_id, place_id FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ thing_id: null, place_id: shelf }]);
    expect(
      await own('SELECT place_id FROM public.attachments WHERE file_id = $1', [photo]),
    ).toEqual([{ place_id: shelf }]);
    expect(await own('SELECT id FROM public.things WHERE id = $1', [shelf])).toEqual([]);
  });

  it('refuses the Unplaced area, a place with places under it, and a container with a meter', async () => {
    const room = await place(a, 'Room');
    await place(a, 'Shelf', room);
    expect(
      await pgError(
        q(as(a.userId), 'SELECT kept.convert_place_to_container($1, NULL)', [a.unplacedId]),
      ),
    ).toMatchObject({ code: '23514', constraint: 'places_unplaced_fixed' });
    expect(
      await pgError(q(as(a.userId), 'SELECT kept.convert_place_to_container($1, NULL)', [room])),
    ).toMatchObject({ code: '23514', constraint: 'places_has_children' });
    const gen = await thing(a);
    await own(
      `INSERT INTO public.meters (location_id, thing_id, kind, unit) VALUES ($1, $2, 'hours', 'h')`,
      [a.locationId, gen],
    );
    expect(
      await pgError(q(as(a.userId), 'SELECT kept.convert_container_to_place($1, NULL)', [gen])),
    ).toMatchObject({ code: '23514', constraint: 'things_has_meters' });
  });

  it('refuses anyone who cannot write the location (42501)', async () => {
    const shelf = await place(a, 'Shelf');
    const b = await seedTenant(db, 'b');
    expect(
      (await pgError(q(as(b.userId), 'SELECT kept.convert_place_to_container($1, NULL)', [shelf])))
        .code,
    ).toBe('42501');
  });
});

describe('kept.merge_places() (D160)', () => {
  it('moves everything under one place into another, its codes as secondary ones', async () => {
    const a = await seedTenant(db, 'a');
    const from = await place(a, 'Garage');
    const into = await place(a, 'Shed');
    const child = await place(a, 'Rack', from);
    const saw = await thing(a, { placeId: from });
    const code = await shortCode(a, { placeId: from });
    const [n] = await q<{ n: number }>(as(a.userId), 'SELECT kept.merge_places($1, $2) AS n', [
      from,
      into,
    ]);
    expect(n?.n).toBe(1);
    expect(await own('SELECT parent_id FROM public.places WHERE id = $1', [child])).toEqual([
      { parent_id: into },
    ]);
    expect(await own('SELECT place_id FROM public.things WHERE id = $1', [saw])).toEqual([
      { place_id: into },
    ]);
    expect(
      await own('SELECT place_id, is_primary FROM public.short_ids WHERE code = $1', [code]),
    ).toEqual([{ place_id: into, is_primary: false }]);
    expect(await own('SELECT id FROM public.places WHERE id = $1', [from])).toEqual([]);
  });

  it('refuses merging into a place inside it, and the Unplaced area', async () => {
    const a = await seedTenant(db, 'a');
    const from = await place(a, 'Garage');
    const inner = await place(a, 'Rack', from);
    expect(
      await pgError(q(as(a.userId), 'SELECT kept.merge_places($1, $2)', [from, inner])),
    ).toMatchObject({ code: '23514', constraint: 'places_no_loop' });
    expect(
      await pgError(q(as(a.userId), 'SELECT kept.merge_places($1, $2)', [a.unplacedId, from])),
    ).toMatchObject({ code: '23514', constraint: 'places_unplaced_fixed' });
  });
});

describe('kept.merge_registry() (D92, D123)', () => {
  let b: Tenant;
  let flat: Loc;
  let admin: string;
  beforeEach(async () => {
    b = await seedTenant(db, 'b');
    flat = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    // An admin of B's home only: the flat is invisible to them.
    admin = await seedUser(db, 'admin');
    await addMember(db, b.locationId, admin, 'admin');
  });

  it('repoints brands across every location of the account, even ones the admin cannot see', async () => {
    const from = newId();
    const into = newId();
    await own(
      `INSERT INTO public.brands (id, owner_account_id, name) VALUES ($1, $2, 'Samsng'), ($3, $2, 'Samsung')`,
      [from, b.accountId, into],
    );
    const tv = await thing(b);
    const fridge = await thing(flat);
    await own('UPDATE public.things SET brand_id = $1 WHERE id = ANY ($2)', [from, [tv, fridge]]);
    const [n] = await q<{ n: number }>(
      as(admin),
      `SELECT kept.merge_registry('brand', $1, $2) AS n`,
      [from, into],
    );
    expect(n?.n).toBe(2);
    expect(
      await own('SELECT DISTINCT brand_id FROM public.things WHERE id = ANY ($1)', [[tv, fridge]]),
    ).toEqual([{ brand_id: into }]);
    expect(await own('SELECT id FROM public.brands WHERE id = $1', [from])).toEqual([]);
  });

  it('merges tags without duplicating a thing that had both', async () => {
    const from = newId();
    const into = newId();
    await own(
      `INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'Gardn'), ($3, $2, 'Garden')`,
      [from, b.accountId, into],
    );
    const hose = await thing(b);
    const rake = await thing(b);
    await own(
      'INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)',
      [b.locationId, hose, from, into, rake],
    );
    await q(as(admin), `SELECT kept.merge_registry('tag', $1, $2)`, [from, into]);
    expect(
      await own('SELECT thing_id FROM public.thing_tags WHERE tag_id = $1 ORDER BY thing_id', [
        into,
      ]),
    ).toEqual([hose, rake].sort().map((thing_id) => ({ thing_id })));
  });

  it('merges types, archiving values the kept type has no field for', async () => {
    const from = newId();
    const into = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, name, icon) VALUES ($1, $2, 'Lamp', 'lucide:box'), ($3, $2, 'Light', 'lucide:box')`,
      [from, b.accountId, into],
    );
    await own(
      `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
       VALUES ($1, $2, 'bulb', 'Bulb', 'text'), ($1, $3, 'watts', 'Watts', 'number'), ($1, $2, 'watts', 'Watts', 'number')`,
      [b.accountId, from, into],
    );
    const lamp = await thing(b, { typeId: from });
    await own(`UPDATE public.things SET custom = '{"bulb": "E27", "watts": 40}' WHERE id = $1`, [
      lamp,
    ]);
    await q(as(admin), `SELECT kept.merge_registry('type', $1, $2)`, [from, into]);
    expect(
      await own('SELECT type_id, custom, archived_custom FROM public.things WHERE id = $1', [lamp]),
    ).toEqual([{ type_id: into, custom: { watts: 40 }, archived_custom: { bulb: 'E27' } }]);
  });

  it('refuses a member, rows of two accounts, and an unknown registry', async () => {
    const member = await seedUser(db, 'member');
    await addMember(db, b.locationId, member, 'member');
    const a = await seedTenant(db, 'a');
    const one = newId();
    const two = newId();
    const theirs = newId();
    await own(
      `INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'X'), ($3, $2, 'Y'), ($4, $5, 'Z')`,
      [one, b.accountId, two, theirs, a.accountId],
    );
    expect(
      (await pgError(q(as(member), `SELECT kept.merge_registry('vendor', $1, $2)`, [one, two])))
        .code,
    ).toBe('42501');
    expect(
      (await pgError(q(as(admin), `SELECT kept.merge_registry('vendor', $1, $2)`, [one, theirs])))
        .code,
    ).toBe('42501');
    expect(
      (await pgError(q(as(admin), `SELECT kept.merge_registry('shoe', $1, $2)`, [one, two]))).code,
    ).toBe('22023');
  });
});

describe('kept.customise_type() and kept.type_impact() (D92, D123, Q13b)', () => {
  let b: Tenant;
  let flat: Loc;
  let admin: string;
  beforeEach(async () => {
    b = await seedTenant(db, 'b');
    flat = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    admin = await seedUser(db, 'admin');
    await addMember(db, b.locationId, admin, 'admin');
  });

  it('copies the built-in and its built-in subtree, and repoints the account’s things and types', async () => {
    const phone = await builtin('phone');
    const computer = await builtin('computer');
    const handset = await thing(flat, { typeId: phone });
    const laptop = await thing(b, { typeId: computer });
    const foldable = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon) VALUES ($1, $2, $3, 'Foldable', 'lucide:box')`,
      [foldable, b.accountId, phone],
    );
    const licence = await own<{ id: string }>(
      `SELECT id FROM public.type_fields WHERE type_id = $1 AND key = 'licence_key'`,
      [computer],
    );
    await own(
      `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext, key_version, updated_by)
       VALUES ($1, $2, $3, 'licence_key', '{"c": "x"}', 1, $4)`,
      [b.locationId, laptop, licence[0]?.id, b.userId],
    );
    await own(
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles) VALUES ($1, $2, ARRAY['owner'])`,
      [b.locationId, licence[0]?.id],
    );

    const [copy] = await q<{ id: string }>(as(admin), 'SELECT kept.customise_type($1, $2) AS id', [
      await builtin('electronics'),
      b.accountId,
    ]);
    const copies = await own<{
      id: string;
      key: string;
      parent: string | null;
      name: string | null;
    }>(
      `SELECT t.id, s.builtin_key AS key, ps.builtin_key AS parent, t.name
         FROM public.types t JOIN public.types s ON s.id = t.copied_from_id
         LEFT JOIN public.types p ON p.id = t.parent_id
         LEFT JOIN public.types ps ON ps.id = p.copied_from_id
        WHERE t.owner_account_id = $1 ORDER BY 2`,
      [b.accountId],
    );
    expect(copies.map((c) => c.key)).toEqual([
      'camera',
      'computer',
      'console',
      'electronics',
      'network_device',
      'phone',
      'tablet',
      'tv_display',
    ]);
    expect(copies.find((c) => c.key === 'electronics')?.id).toBe(copy?.id);
    for (const c of copies) {
      expect(c.name).toBeNull();
      expect(c.parent).toBe(c.key === 'electronics' ? null : 'electronics');
    }
    const phoneCopy = copies.find((c) => c.key === 'phone')?.id;
    // Things in every location of the account, and the account's own subtypes, follow.
    expect(await own('SELECT type_id FROM public.things WHERE id = $1', [handset])).toEqual([
      { type_id: phoneCopy },
    ]);
    expect(await own('SELECT parent_id FROM public.types WHERE id = $1', [foldable])).toEqual([
      { parent_id: phoneCopy },
    ]);
    // The copy carries its own fields; the secret value and the policy follow the copied field.
    const [secret] = await own<{ type_id: string; roles: string[] }>(
      `SELECT f.type_id, sp.reveal_roles AS roles FROM public.secret_values s
         JOIN public.type_fields f ON f.id = s.type_field_id
         JOIN public.secret_field_policies sp ON sp.type_field_id = f.id AND sp.location_id = s.location_id
        WHERE s.thing_id = $1`,
      [laptop],
    );
    expect(secret).toEqual({
      type_id: copies.find((c) => c.key === 'computer')?.id,
      roles: ['owner'],
    });
    // Idempotent.
    const [again] = await q<{ id: string }>(as(admin), 'SELECT kept.customise_type($1, $2) AS id', [
      await builtin('electronics'),
      b.accountId,
    ]);
    expect(again?.id).toBe(copy?.id);
  });

  it('refuses a member, an account the caller does not administer, and a non-built-in', async () => {
    const member = await seedUser(db, 'member');
    await addMember(db, b.locationId, member, 'member');
    const a = await seedTenant(db, 'a');
    const phone = await builtin('phone');
    for (const [userId, acct, type] of [
      [member, b.accountId, phone],
      [admin, a.accountId, phone],
      [admin, b.accountId, await builtin('device')],
    ] as const) {
      expect(
        (await pgError(q(as(userId), 'SELECT kept.customise_type($1, $2)', [type, acct]))).code,
      ).toBe('42501');
    }
  });

  it('counts a type’s things per location, naming only the ones the caller can see (D123)', async () => {
    const lamp = newId();
    const desk = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, name, icon) VALUES ($1, $2, 'Lamp', 'lucide:box')`,
      [lamp, b.accountId],
    );
    await own(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon) VALUES ($1, $2, $3, 'Desk lamp', 'lucide:box')`,
      [desk, b.accountId, lamp],
    );
    await thing(b, { typeId: lamp });
    await thing(b, { typeId: desk });
    await thing(flat, { typeId: desk });
    expect(await q(as(admin), 'SELECT * FROM kept.type_impact($1)', [lamp])).toEqual([
      { location_id: b.locationId, location_name: 'Home', things: 2 },
      { location_id: null, location_name: null, things: 1 },
    ]);
    const a = await seedTenant(db, 'a');
    expect(
      (await pgError(q(as(a.userId), 'SELECT * FROM kept.type_impact($1)', [lamp]))).code,
    ).toBe('42501');
  });
});

// ---------------------------------------------------------------------------------------------
// Security review of Phase A (migration 0024). Each block is a finding the review reproduced.
// ---------------------------------------------------------------------------------------------

/** A secret value on a thing, as kept_owner; `superseded` keeps it as history. */
async function secretValue(
  loc: Loc,
  thingId: string,
  fieldId: string,
  key: string,
  userId: string,
  superseded = false,
) {
  await own(
    `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                       key_version, updated_by, superseded_at)
     VALUES ($1, $2, $3, $4, '{"c": "x"}', 1, $5, $6)`,
    [loc.locationId, thingId, fieldId, key, userId, superseded ? new Date() : null],
  );
}

async function builtinField(typeKey: string, key: string): Promise<string> {
  const rows = await own<{ id: string }>(
    `SELECT f.id FROM public.type_fields f JOIN public.types t ON t.id = f.type_id
      WHERE t.owner_account_id IS NULL AND t.builtin_key = $1 AND f.key = $2`,
    [typeKey, key],
  );
  return rows[0]?.id as string;
}

/** A custom type of `accountId` with the given fields; returns the type and its fields by key. */
async function customType(
  accountId: string,
  name: string,
  fields: { key: string; kind?: string; secret?: boolean }[],
  parentId: string | null = null,
) {
  const id = newId();
  await own(
    `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon) VALUES ($1, $2, $3, $4, 'lucide:box')`,
    [id, accountId, parentId, name],
  );
  const ids: Record<string, string> = {};
  for (const f of fields) {
    ids[f.key] = newId();
    await own(
      `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind, secret)
       VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      [ids[f.key], accountId, id, f.key, f.kind ?? 'text', f.secret ?? false],
    );
  }
  return { id, fields: ids };
}

describe('C1: a move never carries a secret to where its mover could read it', () => {
  it('refuses a member moving a thing with a secret they cannot reveal into their own location (42501)', async () => {
    const a = await seedTenant(db, 'a');
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    await addMember(db, a.locationId, m.userId, 'member');
    const wifi = await builtinField('network_device', 'wifi_password');
    const router = await thing(a, { name: 'Router', typeId: await builtin('network_device') });
    await secretValue(a, router, wifi, 'wifi_password', a.userId, true);
    await secretValue(a, router, wifi, 'wifi_password', a.userId);
    expect(await pgError(move(m.userId, [router], m.locationId, m.unplacedId))).toMatchObject({
      code: '42501',
      constraint: 'things_move_secrets',
    });
    // Inside a box, the same.
    const box = await thing(a, { name: 'Box' });
    await own('UPDATE public.things SET place_id = NULL, container_id = $1 WHERE id = $2', [
      box,
      router,
    ]);
    expect((await pgError(move(m.userId, [box], m.locationId, m.unplacedId))).code).toBe('42501');
    expect(
      await own<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.secret_values WHERE location_id = $1',
        [a.locationId],
      ),
    ).toEqual([{ n: 2 }]);
  });

  it('refuses an admin of both locations of one account too; the owner may move it', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const admin = await seedUser(db, 'admin');
    await addMember(db, a.locationId, admin, 'admin');
    await addMember(db, flat.locationId, admin, 'admin');
    const wifi = await builtinField('network_device', 'wifi_password');
    const router = await thing(a, { name: 'Router', typeId: await builtin('network_device') });
    await secretValue(a, router, wifi, 'wifi_password', a.userId);
    // The home's owner keeps the PIN to themselves; the flat would show it to its admins.
    await own(
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles) VALUES ($1, $2, ARRAY['owner'])`,
      [a.locationId, wifi],
    );
    expect(
      (await pgError(move(admin, [router], flat.locationId, flat.unplacedId))).constraint,
    ).toBe('things_move_secrets');
    await move(a.userId, [router], flat.locationId, flat.unplacedId);
    expect(
      await own('SELECT location_id FROM public.secret_values WHERE thing_id = $1', [router]),
    ).toEqual([{ location_id: flat.locationId }]);
  });

  it('still moves a thing with a secret within its own location', async () => {
    const a = await seedTenant(db, 'a');
    const member = await seedUser(db, 'member');
    await addMember(db, a.locationId, member, 'member');
    const shelf = await place(a, 'Shelf');
    const wifi = await builtinField('network_device', 'wifi_password');
    const router = await thing(a, { typeId: await builtin('network_device') });
    await secretValue(a, router, wifi, 'wifi_password', a.userId);
    await move(member, [router], a.locationId, shelf);
    expect(await own('SELECT place_id FROM public.things WHERE id = $1', [router])).toEqual([
      { place_id: shelf },
    ]);
  });
});

describe('I1: merging types never loosens a secret', () => {
  let b: Tenant;
  let admin: string;
  beforeEach(async () => {
    b = await seedTenant(db, 'b');
    admin = await seedUser(db, 'admin');
    await addMember(db, b.locationId, admin, 'admin');
  });

  it('refuses a secret value whose key is a plain field in the type merged into (23514)', async () => {
    const from = await customType(b.accountId, 'Safe', [{ key: 'code', secret: true }]);
    const into = await customType(b.accountId, 'Box', [{ key: 'code' }]);
    const safe = await thing(b, { typeId: from.id });
    await secretValue(b, safe, from.fields.code as string, 'code', b.userId);
    for (const who of [admin, b.userId]) {
      expect(
        await pgError(q(as(who), `SELECT kept.merge_registry('type', $1, $2)`, [from.id, into.id])),
      ).toMatchObject({ code: '23514', constraint: 'types_merge_secret_fields' });
    }
  });

  it('refuses an admin when the two fields’ policies differ in a location; the owner may', async () => {
    const from = await customType(b.accountId, 'Safe', [{ key: 'code', secret: true }]);
    const into = await customType(b.accountId, 'Vault', [{ key: 'code', secret: true }]);
    const safe = await thing(b, { typeId: from.id });
    await secretValue(b, safe, from.fields.code as string, 'code', b.userId);
    await own(
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles) VALUES ($1, $2, ARRAY['owner'])`,
      [b.locationId, from.fields.code],
    );
    const merge = (who: string) =>
      q(as(who), `SELECT kept.merge_registry('type', $1, $2)`, [from.id, into.id]);
    expect(await pgError(merge(admin))).toMatchObject({
      code: '23514',
      constraint: 'types_merge_secret_policy',
    });
    // The same policy on both sides: an admin may merge.
    await own(
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles) VALUES ($1, $2, ARRAY['owner'])`,
      [b.locationId, into.fields.code],
    );
    await merge(admin);
    expect(
      await own('SELECT type_field_id FROM public.secret_values WHERE thing_id = $1', [safe]),
    ).toEqual([{ type_field_id: into.fields.code }]);
  });

  it('lets the owner merge across differing policies', async () => {
    const from = await customType(b.accountId, 'Safe', [{ key: 'code', secret: true }]);
    const into = await customType(b.accountId, 'Vault', [{ key: 'code', secret: true }]);
    const safe = await thing(b, { typeId: from.id });
    await secretValue(b, safe, from.fields.code as string, 'code', b.userId);
    await own(
      `INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles) VALUES ($1, $2, ARRAY['owner'])`,
      [b.locationId, from.fields.code],
    );
    await q(as(b.userId), `SELECT kept.merge_registry('type', $1, $2)`, [from.id, into.id]);
    expect(
      await own('SELECT type_field_id FROM public.secret_values WHERE thing_id = $1', [safe]),
    ).toEqual([{ type_field_id: into.fields.code }]);
  });

  it('archives custom values whose key is secret in the type merged into', async () => {
    const from = await customType(b.accountId, 'Lock', [{ key: 'code' }]);
    const into = await customType(b.accountId, 'Safe', [{ key: 'code', secret: true }]);
    const lock = await thing(b, { typeId: from.id });
    await own(`UPDATE public.things SET custom = '{"code": "4321"}' WHERE id = $1`, [lock]);
    await q(as(admin), `SELECT kept.merge_registry('type', $1, $2)`, [from.id, into.id]);
    const [row] = await own<{ custom: object; archived_custom: object; doc: string }>(
      'SELECT custom, archived_custom, search_tsv::text AS doc FROM public.things WHERE id = $1',
      [lock],
    );
    expect(row).toMatchObject({ custom: {}, archived_custom: { code: '4321' } });
    expect(row?.doc).not.toContain('4321');
  });
});

describe('I2: kept.type_impact() counts hidden locations for admins only', () => {
  it('shows a member only the locations they can see', async () => {
    const b = await seedTenant(db, 'b');
    const flat = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    const member = await seedUser(db, 'member');
    const viewer = await seedUser(db, 'viewer');
    await addMember(db, b.locationId, member, 'member');
    await addMember(db, b.locationId, viewer, 'viewer');
    const lamp = await customType(b.accountId, 'Lamp', []);
    await thing(b, { typeId: lamp.id });
    await thing(flat, { typeId: lamp.id });
    for (const who of [member, viewer]) {
      expect(await q(as(who), 'SELECT * FROM kept.type_impact($1)', [lamp.id])).toEqual([
        { location_id: b.locationId, location_name: 'Home', things: 1 },
      ]);
    }
    // The owner, who sees both, gets both named.
    expect(await q(as(b.userId), 'SELECT * FROM kept.type_impact($1)', [lamp.id])).toHaveLength(2);
  });
});

describe('I3: a copied purchase carries only the thing’s line (D115)', () => {
  it('leaves the header’s total, tax and notes behind when the mover cannot see the purchase', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    await addMember(db, flat.locationId, m.userId, 'member');
    const purchase = newId();
    const line = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total, tax, notes)
       VALUES ($1, $2, '2026-09-01', 'EGP', 900, 90, 'with the TV and the sofa')`,
      [purchase, a.locationId],
    );
    await own(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
       VALUES ($1, $2, $3, 'Lamp', 100)`,
      [line, a.locationId, purchase],
    );
    const receipt = await file(a, a.userId);
    await own(
      `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by) VALUES ($1, $2, $3, 'receipt', $4)`,
      [a.locationId, receipt, purchase, a.userId],
    );
    // Bought for the home, then moved to the flat (D115: the line stays in the home).
    const lamp = await thing(a, { name: 'Lamp' });
    await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, lamp]);
    await own('UPDATE public.things SET location_id = $1, place_id = $2 WHERE id = $3', [
      flat.locationId,
      flat.unplacedId,
      lamp,
    ]);
    await move(m.userId, [lamp], m.locationId, m.unplacedId);
    const [copy] = await own<{
      purchase_id: string;
      unit_price: string;
      currency: string;
      total: string | null;
      tax: string | null;
      notes: string | null;
    }>(
      `SELECT l.purchase_id, l.unit_price::text, p.currency, p.total, p.tax, p.notes
         FROM public.things t JOIN public.purchase_lines l ON l.id = t.purchase_line_id
         JOIN public.purchases p ON p.id = l.purchase_id WHERE t.id = $1`,
      [lamp],
    );
    expect(copy).toMatchObject({
      unit_price: '100.0000',
      currency: 'EGP',
      total: null,
      tax: null,
      notes: null,
    });
    // The thing's receipt goes with it all the same (D161; D115 shows it to anyone who sees the
    // thing).
    expect(
      await own<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.attachments WHERE purchase_id = $1 AND role = 'receipt'`,
        [copy?.purchase_id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('copies the whole header when the mover can see the purchase', async () => {
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, m.userId, 'member');
    const purchase = newId();
    const line = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total, tax, notes)
       VALUES ($1, $2, '2026-09-01', 'EGP', 900, 90, 'gift')`,
      [purchase, m.locationId],
    );
    await own(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description) VALUES ($1, $2, $3, 'Lamp')`,
      [line, m.locationId, purchase],
    );
    const lamp = await thing(m, { name: 'Lamp' });
    await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, lamp]);
    await move(m.userId, [lamp], b.locationId, b.unplacedId);
    expect(
      await own(
        `SELECT p.total::text, p.tax::text, p.notes FROM public.things t
           JOIN public.purchase_lines l ON l.id = t.purchase_line_id
           JOIN public.purchases p ON p.id = l.purchase_id WHERE t.id = $1`,
        [lamp],
      ),
    ).toEqual([{ total: '900.0000', tax: '90.0000', notes: 'gift' }]);
  });
});

describe('I4: custom references and secret keys follow the rules', () => {
  it('remaps person and vendor values in custom on a move across accounts', async () => {
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, m.userId, 'member');
    const kit = await customType(m.accountId, 'Kit', [
      { key: 'lent_by', kind: 'person' },
      { key: 'serviced_at', kind: 'vendor' },
    ]);
    const person = newId();
    const vendor = newId();
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
      [person, m.accountId],
    );
    await own(`INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'Garage')`, [
      vendor,
      m.accountId,
    ]);
    const drill = await thing(m, { name: 'Drill', typeId: kit.id });
    await own('UPDATE public.things SET custom = $1 WHERE id = $2', [
      JSON.stringify({ lent_by: person, serviced_at: vendor }),
      drill,
    ]);
    await move(m.userId, [drill], b.locationId, b.unplacedId);
    const [row] = await own<{ custom: { lent_by: string; serviced_at: string } }>(
      'SELECT custom FROM public.things WHERE id = $1',
      [drill],
    );
    expect(row?.custom.lent_by).not.toBe(person);
    expect(row?.custom.serviced_at).not.toBe(vendor);
    expect(
      await own('SELECT owner_account_id, display_name FROM public.people WHERE id = $1', [
        row?.custom.lent_by,
      ]),
    ).toEqual([{ owner_account_id: b.accountId, display_name: 'Alfred' }]);
    expect(
      await own('SELECT owner_account_id, name FROM public.vendors WHERE id = $1', [
        row?.custom.serviced_at,
      ]),
    ).toEqual([{ owner_account_id: b.accountId, name: 'Garage' }]);
  });

  it('repoints custom references when people or vendors merge', async () => {
    const b = await seedTenant(db, 'b');
    const kit = await customType(b.accountId, 'Kit', [
      { key: 'lent_by', kind: 'person' },
      { key: 'helpers', kind: 'person' },
    ]);
    const [from, into, other] = [newId(), newId(), newId()];
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $4, 'Alfred'), ($2, $4, 'Alfred A.'), ($3, $4, 'Shahrazad')`,
      [from, into, other, b.accountId],
    );
    const drill = await thing(b, { typeId: kit.id });
    await own('UPDATE public.things SET custom = $1 WHERE id = $2', [
      JSON.stringify({ lent_by: from, helpers: [other, from] }),
      drill,
    ]);
    await q(as(b.userId), `SELECT kept.merge_registry('person', $1, $2)`, [from, into]);
    expect(await own('SELECT custom FROM public.things WHERE id = $1', [drill])).toEqual([
      { custom: { lent_by: into, helpers: [other, into] } },
    ]);
  });

  it('counts a person used in custom when showing contacts (D177)', async () => {
    const b = await seedTenant(db, 'b');
    const flat = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    const admin = await seedUser(db, 'admin');
    await addMember(db, b.locationId, admin, 'admin');
    const kit = await customType(b.accountId, 'Kit', [{ key: 'lent_by', kind: 'person' }]);
    const person = newId();
    await own(
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
      [person, b.accountId],
    );
    await own(
      `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '1')`,
      [person, b.accountId],
    );
    const read = () =>
      q(as(admin), 'SELECT phone FROM public.person_contacts WHERE person_id = $1', [person]);
    expect(await read()).toEqual([{ phone: '1' }]);
    const drill = await thing(flat, { typeId: kit.id });
    await own('UPDATE public.things SET custom = $1 WHERE id = $2', [
      JSON.stringify({ lent_by: person }),
      drill,
    ]);
    expect(await read()).toEqual([]);
  });

  it('archives place values whose key is secret in the container’s type', async () => {
    const a = await seedTenant(db, 'a');
    const safeType = await customType(a.accountId, 'Safe', [
      { key: 'combination_hint', secret: true },
      { key: 'depth' },
    ]);
    const cupboard = await place(a, 'Cupboard');
    await own(
      `UPDATE public.places SET custom = '{"combination_hint": "1234", "depth": "40"}' WHERE id = $1`,
      [cupboard],
    );
    await q(as(a.userId), 'SELECT kept.convert_place_to_container($1, $2)', [
      cupboard,
      safeType.id,
    ]);
    const [row] = await own<{ custom: object; archived_custom: object; doc: string }>(
      'SELECT custom, archived_custom, search_tsv::text AS doc FROM public.things WHERE id = $1',
      [cupboard],
    );
    expect(row).toMatchObject({
      custom: { depth: '40' },
      archived_custom: { combination_hint: '1234' },
    });
    expect(row?.doc).not.toContain('1234');
  });

  it('refuses a custom key that resolves to a secret field, on insert and on a type change (23514)', async () => {
    const a = await seedTenant(db, 'a');
    const router = await builtin('network_device');
    const secretInCustom = q(
      as(a.userId),
      `INSERT INTO public.things (location_id, place_id, name, type_id, custom)
       VALUES ($1, $2, 'Router', $3, '{"wifi_password": "hunter2"}')`,
      [a.locationId, a.unplacedId, router],
    );
    expect(await pgError(secretInCustom)).toMatchObject({
      code: '23514',
      constraint: 'things_custom_secret',
    });
    const box = await thing(a);
    // A plain field of the same key elsewhere is fine; turning the thing into a router is not.
    const plain = await customType(a.accountId, 'Note', [{ key: 'wifi_password' }]);
    await own(
      `UPDATE public.things SET type_id = $1, custom = '{"wifi_password": "x"}' WHERE id = $2`,
      [plain.id, box],
    );
    expect(
      await pgError(
        q(as(a.userId), 'UPDATE public.things SET type_id = $1 WHERE id = $2', [router, box]),
      ),
    ).toMatchObject({ code: '23514', constraint: 'things_custom_secret' });
  });
});

describe('secret values of fields the target account lacks (review minor)', () => {
  it('archives them onto a secret field of the target type instead of keeping a foreign field', async () => {
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, m.userId, 'member');
    // A thing whose type changed, leaving a secret of its old type behind (history).
    const old = await customType(m.accountId, 'Old', [{ key: 'old_pin', secret: true }]);
    const current = await customType(m.accountId, 'Gadget', []);
    const gadget = await thing(m, { typeId: current.id });
    await secretValue(m, gadget, old.fields.old_pin as string, 'old_pin', m.userId);
    await move(m.userId, [gadget], b.locationId, b.unplacedId);
    const [value] = await own<{
      owner_account_id: string;
      secret: boolean;
      archived: boolean;
      superseded: boolean;
    }>(
      `SELECT f.owner_account_id, f.secret, f.archived_at IS NOT NULL AS archived,
              s.superseded_at IS NOT NULL AS superseded
         FROM public.secret_values s JOIN public.type_fields f ON f.id = s.type_field_id
        WHERE s.thing_id = $1`,
      [gadget],
    );
    expect(value).toEqual({
      owner_account_id: b.accountId,
      secret: true,
      archived: true,
      superseded: true,
    });
    // The mover's account can now delete its old type: nothing of B's points at it.
    await own('DELETE FROM public.types WHERE id = $1', [old.id]);
  });

  it('prefers a new copy over a same-named type in the target that lacks the secret field', async () => {
    const m = await seedTenant(db, 'mover', { kind: 'personal' });
    const b = await seedTenant(db, 'b');
    await addMember(db, b.locationId, m.userId, 'member');
    const mine = await customType(m.accountId, 'Safe', [{ key: 'code', secret: true }]);
    const theirs = await customType(b.accountId, 'Safe', []);
    const safe = await thing(m, { typeId: mine.id });
    await secretValue(m, safe, mine.fields.code as string, 'code', m.userId);
    await move(m.userId, [safe], b.locationId, b.unplacedId);
    const [row] = await own<{
      type_id: string;
      field_type: string;
      secret: boolean;
      superseded: boolean;
    }>(
      `SELECT t.type_id, f.type_id AS field_type, f.secret, s.superseded_at IS NOT NULL AS superseded
         FROM public.things t JOIN public.secret_values s ON s.thing_id = t.id
         JOIN public.type_fields f ON f.id = s.type_field_id WHERE t.id = $1`,
      [safe],
    );
    expect(row?.type_id).not.toBe(theirs.id);
    expect(row).toMatchObject({ field_type: row?.type_id, secret: true, superseded: false });
  });
});

describe('sync tombstones for what leaves with a thing (D156, §7.4)', () => {
  it('tombstones its attachments, meters, readings and links in the source', async () => {
    const a = await seedTenant(db, 'a');
    const flat = await ownerTx(db, (c) => insertLocation(c, a, { name: 'Flat' }));
    const gen = await thing(a, { name: 'Generator' });
    const stays = await thing(a, { name: 'Fuel can' });
    const meter = newId();
    const reading = newId();
    const event = newId();
    await own(
      `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
      [meter, a.locationId, gen],
    );
    await own(
      `INSERT INTO public.meter_readings (id, location_id, meter_id, value, taken_at) VALUES ($1, $2, $3, 5, now())`,
      [reading, a.locationId, meter],
    );
    await own(
      `INSERT INTO public.meter_events (id, location_id, meter_id, kind, at, "offset") VALUES ($1, $2, $3, 'replaced', now(), 5)`,
      [event, a.locationId, meter],
    );
    const photo = await file(a, a.userId);
    const attachment = newId();
    await own(
      `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by) VALUES ($1, $2, $3, $4, 'photo', $5)`,
      [attachment, a.locationId, photo, gen, a.userId],
    );
    const link = newId();
    await own(
      `INSERT INTO public.thing_links (id, location_id, from_thing_id, to_thing_id, kind) VALUES ($1, $2, $3, $4, 'consumable_for')`,
      [link, a.locationId, stays, gen],
    );
    await move(a.userId, [gen], flat.locationId, flat.unplacedId);
    const tombs = await own<{ entity_type: string; entity_id: string }>(
      `SELECT entity_type, entity_id FROM public.sync_tombstones WHERE location_id = $1
        ORDER BY entity_type`,
      [a.locationId],
    );
    expect(tombs).toEqual([
      { entity_type: 'attachment', entity_id: attachment },
      { entity_type: 'meter', entity_id: meter },
      { entity_type: 'meter_event', entity_id: event },
      { entity_type: 'meter_reading', entity_id: reading },
      { entity_type: 'thing', entity_id: gen },
      { entity_type: 'thing_link', entity_id: link },
    ]);
  });

  it('tombstones the links a container drops when it becomes a place', async () => {
    const a = await seedTenant(db, 'a');
    const box = await thing(a, { name: 'Box' });
    const lamp = await thing(a, { name: 'Lamp' });
    const link = newId();
    await own(
      `INSERT INTO public.thing_links (id, location_id, from_thing_id, to_thing_id, kind) VALUES ($1, $2, $3, $4, 'related')`,
      [link, a.locationId, lamp, box],
    );
    await q(as(a.userId), 'SELECT kept.convert_container_to_place($1, NULL)', [box]);
    expect(
      await own(
        `SELECT entity_type FROM public.sync_tombstones WHERE location_id = $1 AND entity_id = $2`,
        [a.locationId, link],
      ),
    ).toEqual([{ entity_type: 'thing_link' }]);
  });
});
