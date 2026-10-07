import { BUILTIN_TYPES, newId } from '@kept/shared';
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
import { seedTypes } from './seed-reference.js';

// Task 5: the type tree, place kinds and the account registries (engineering spec §1.3, §7.9,
// §7.13; D11, D92, D123, D154, D177, D192; plan Q4, Q5), as kept_app unless noted.

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
  if (!rows[0]) throw new Error(`no built-in ${key}`);
  return rows[0].id;
}

/** A custom type of `t`'s account under `parent`, as its owner. */
async function customType(t: Tenant, name: string, parentId: string | null): Promise<string> {
  const id = newId();
  await q(
    as(t.userId),
    `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
     VALUES ($1, $2, $3, $4, 'lucide:box')`,
    [id, t.accountId, parentId, name],
  );
  return id;
}

const addField = (t: Tenant, typeId: string, key: string, extra = '') =>
  q(
    as(t.userId),
    `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind${extra ? ', secret' : ''})
     VALUES ($1, $2, $3, $3, 'text'${extra ? `, ${extra}` : ''})`,
    [t.accountId, typeId, key],
  );

describe('the built-in library (seed-reference)', () => {
  it('has every built-in type, parents and field groups linked by key', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT t.builtin_key, p.builtin_key AS parent, t.is_field_group,
                ARRAY(SELECT g.builtin_key FROM public.types g WHERE g.id = ANY (t.field_groups)
                       ORDER BY 1) AS groups
           FROM public.types t LEFT JOIN public.types p ON p.id = t.parent_id
          WHERE t.owner_account_id IS NULL ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.builtin_key)).toEqual(BUILTIN_TYPES.map((t) => t.key).sort());
    for (const t of BUILTIN_TYPES) {
      expect(rows.find((r) => r.builtin_key === t.key)).toMatchObject({
        parent: t.parent ?? null,
        is_field_group: t.isFieldGroup ?? false,
        groups: [...(t.groups ?? [])].sort(),
      });
    }
  });

  it('resolves a phone to the device group plus its own fields, and keeps secrets secret', async () => {
    const a = await seedTenant(db, 'a');
    const phone = await builtin('phone');
    const rows = await q<{ key: string; secret: boolean }>(
      as(a.userId),
      `SELECT f.key, f.secret FROM public.type_fields f
        WHERE f.type_id IN (SELECT id FROM kept.type_chain($1))
           OR f.type_id IN (SELECT unnest(t.field_groups) FROM public.types t
                             WHERE t.id IN (SELECT id FROM kept.type_chain($1)))
        ORDER BY f.key`,
      [phone],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'firmware',
      'imei',
      'imei_2',
      'linked_account',
      'mac_address',
      'os',
      'os_version',
      'storage',
    ]);
    expect(rows.filter((r) => r.secret).map((r) => r.key)).toEqual(['linked_account']);
    const secret = await asOwner(db, (c) =>
      c.query(
        `SELECT t.builtin_key || '.' || f.key AS k FROM public.type_fields f
           JOIN public.types t ON t.id = f.type_id WHERE f.secret ORDER BY 1`,
      ),
    );
    expect(secret.rows.map((r) => r.k)).toEqual([
      'computer.licence_key',
      'device.linked_account',
      'network_device.wifi_password',
      'safe.combination',
    ]);
  });

  it('stores default meters: set, inherited (NULL) and cancelled (JSON null)', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT builtin_key, default_meter, default_meter IS NULL AS inherits
           FROM public.types WHERE builtin_key IN ('vehicle', 'car', 'bicycle', 'generator')
          ORDER BY 1`,
      ),
    );
    expect(rows).toEqual([
      { builtin_key: 'bicycle', default_meter: null, inherits: false },
      { builtin_key: 'car', default_meter: null, inherits: true },
      { builtin_key: 'generator', default_meter: { kind: 'hours', unit: 'h' }, inherits: false },
      { builtin_key: 'vehicle', default_meter: { kind: 'distance', unit: 'km' }, inherits: false },
    ]);
  });

  it('seeds the four built-in place kinds', async () => {
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT key, icon, name FROM public.place_kinds WHERE owner_account_id IS NULL ORDER BY key`,
      ),
    );
    expect(rows).toEqual([
      { key: 'closet', icon: 'tabler:hanger', name: null },
      { key: 'floor', icon: 'lucide:layers', name: null },
      { key: 'room', icon: 'lucide:door-open', name: null },
      { key: 'zone', icon: 'lucide:square-dashed', name: null },
    ]);
  });

  it('is a no-op on a second run (same row_version, same change_seq)', async () => {
    const snap = () =>
      asOwner(db, async (c) => {
        const t = await c.query(`SELECT id, row_version, change_seq FROM public.types ORDER BY id`);
        const f = await c.query(
          `SELECT id, row_version, change_seq FROM public.type_fields ORDER BY id`,
        );
        const k = await c.query(
          `SELECT id, row_version, change_seq FROM public.place_kinds ORDER BY id`,
        );
        return [t.rows, f.rows, k.rows];
      });
    const before = await snap();
    await asOwner(db, (c) => seedTypes(c));
    expect(await snap()).toEqual(before);
  });

  it('archives a built-in field that left the library, and restores it when it returns', async () => {
    const phone = await builtin('phone');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.type_fields (type_id, key, kind) VALUES ($1, 'retired_field', 'text')`,
        [phone],
      ),
    );
    await asOwner(db, (c) => seedTypes(c));
    const { rows } = await asOwner(db, (c) =>
      c.query(
        `SELECT key, archived_at IS NOT NULL AS archived FROM public.type_fields
          WHERE type_id = $1 AND key IN ('retired_field', 'imei') ORDER BY key`,
        [phone],
      ),
    );
    expect(rows).toEqual([
      { key: 'imei', archived: false },
      { key: 'retired_field', archived: true },
    ]);
  });

  it('is readable by any signed-in request, and by nobody without a scope', async () => {
    const a = await seedTenant(db, 'a');
    const seen = await q<{ n: number }>(
      as(a.userId),
      `SELECT count(*)::int AS n FROM public.types WHERE owner_account_id IS NULL`,
    );
    expect(seen[0]?.n).toBe(BUILTIN_TYPES.length);
    const { rows } = await app.query(
      `SELECT (SELECT count(*) FROM public.types)::int AS t,
              (SELECT count(*) FROM public.type_fields)::int AS f,
              (SELECT count(*) FROM public.place_kinds)::int AS k`,
    );
    expect(rows[0]).toEqual({ t: 0, f: 0, k: 0 });
  });

  it('can never be written through kept_app, even by an admin', async () => {
    const a = await seedTenant(db, 'a');
    const phone = await builtin('phone');
    const updated = await q(
      as(a.userId),
      `UPDATE public.types SET icon = 'lucide:x' WHERE id = $1 RETURNING id`,
      [phone],
    );
    expect(updated).toEqual([]);
    const err = await pgError(
      q(
        as(a.userId),
        `INSERT INTO public.types (builtin_key, icon) VALUES ('rogue', 'lucide:box')`,
      ),
    );
    expect(err.code).toBe('42501');
  });
});

describe('kept.type_chain() and kept.type_capabilities()', () => {
  it('walks up from a type to its root, and unions the capabilities (D154)', async () => {
    const a = await seedTenant(db, 'a');
    const phone = await builtin('phone');
    const mine = await customType(a, 'Foldable', phone);
    const chain = await q<{ id: string; depth: number }>(
      as(a.userId),
      'SELECT id, depth FROM kept.type_chain($1)',
      [mine],
    );
    expect(chain).toEqual([
      { id: mine, depth: 0 },
      { id: phone, depth: 1 },
      { id: await builtin('electronics'), depth: 2 },
    ]);
    const caps = await q<{ c: string[] }>(as(a.userId), 'SELECT kept.type_capabilities($1) AS c', [
      mine,
    ]);
    expect(caps[0]?.c).toEqual(['serialized', 'warranty']);
    const none = await q<{ c: string[] }>(as(a.userId), 'SELECT kept.type_capabilities(NULL) AS c');
    expect(none[0]?.c).toEqual([]);
  });
});

describe('kept.guard_type()', () => {
  let a: Tenant;
  let b: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses a parent in another account exactly like one that doesn't exist (42501)", async () => {
    const theirs = await customType(b, 'Theirs', null);
    for (const parent of [theirs, newId()]) {
      const err = await pgError(customType(a, 'Mine', parent));
      expect(err).toMatchObject({ code: '42501', constraint: 'types_parent_account' });
    }
    // A built-in parent is fine.
    await customType(a, 'Mine', await builtin('furniture'));
  });

  it('refuses a field group as a parent', async () => {
    const err = await pgError(customType(a, 'Mine', await builtin('device')));
    expect(err).toMatchObject({ code: '42501', constraint: 'types_parent_account' });
  });

  it('refuses a loop (D92)', async () => {
    const top = await customType(a, 'Top', null);
    const mid = await customType(a, 'Mid', top);
    const leaf = await customType(a, 'Leaf', mid);
    const err = await pgError(
      q(as(a.userId), 'UPDATE public.types SET parent_id = $1 WHERE id = $2', [leaf, top]),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'types_no_loop' });
  });

  it('takes field groups only when they are groups, built in or of the same account', async () => {
    const device = await builtin('device');
    const mine = await customType(a, 'Gadget', null);
    await q(as(a.userId), 'UPDATE public.types SET field_groups = $1 WHERE id = $2', [
      [device],
      mine,
    ]);
    for (const bad of [await builtin('phone'), newId()]) {
      const err = await pgError(
        q(as(a.userId), 'UPDATE public.types SET field_groups = $1 WHERE id = $2', [[bad], mine]),
      );
      expect(err).toMatchObject({ code: '42501', constraint: 'types_field_group_account' });
    }
  });
});

describe('type fields', () => {
  let a: Tenant;
  let b: Tenant;
  beforeEach(async () => {
    a = await seedTenant(db, 'a');
    b = await seedTenant(db, 'b');
  });

  it("refuses a field whose owner isn't its type's account (42501)", async () => {
    const mine = await customType(a, 'Mine', null);
    const theirs = await customType(b, 'Theirs', null);
    const err = await pgError(
      q(
        as(a.userId),
        `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
         VALUES ($1, $2, 'x', 'X', 'text')`,
        [a.accountId, theirs],
      ),
    );
    expect(err.code).toBe('42501');
    // A built-in's field can't be added through kept_app: NULL owner is in no account set.
    const builtinErr = await pgError(
      q(
        as(a.userId),
        `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
         VALUES (NULL, $1, 'x', 'X', 'text')`,
        [await builtin('phone')],
      ),
    );
    expect(builtinErr.code).toBe('42501');
    await addField(a, mine, 'x');
  });

  it('refuses a key an ancestor or its group already defines (§7.13, D192)', async () => {
    const mine = await customType(a, 'Foldable', await builtin('phone'));
    for (const key of ['imei', 'os']) {
      const err = await pgError(addField(a, mine, key));
      expect(err).toMatchObject({ code: '23514', constraint: 'type_fields_inherited_key' });
    }
    await addField(a, mine, 'hinge_count');
  });

  it('refuses a key on a parent that a descendant already defines', async () => {
    const top = await customType(a, 'Top', null);
    const leaf = await customType(a, 'Leaf', top);
    await addField(a, leaf, 'shade');
    const err = await pgError(addField(a, top, 'shade'));
    expect(err).toMatchObject({ code: '23514', constraint: 'type_fields_inherited_key' });
  });

  it('refuses a re-parent that would bring the same key together', async () => {
    const one = await customType(a, 'One', null);
    const two = await customType(a, 'Two', null);
    await addField(a, one, 'shade');
    await addField(a, two, 'shade');
    const err = await pgError(
      q(as(a.userId), 'UPDATE public.types SET parent_id = $1 WHERE id = $2', [one, two]),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'type_fields_inherited_key' });
  });

  it('refuses a secret field that is not text', async () => {
    const mine = await customType(a, 'Mine', null);
    const err = await pgError(
      q(
        as(a.userId),
        `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, secret)
         VALUES ($1, $2, 'pin', 'PIN', 'number', true)`,
        [a.accountId, mine],
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint: 'type_fields_secret_text_chk' });
    await addField(a, mine, 'pin', 'true');
  });

  it('gives place-kind fields to the kind, with no inheritance', async () => {
    const kind = newId();
    await q(
      as(a.userId),
      `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
       VALUES ($1, $2, 'shelf', 'Shelf', 'lucide:box')`,
      [kind, a.accountId],
    );
    await q(
      as(a.userId),
      `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind)
       VALUES ($1, $2, 'depth', 'Depth', 'number')`,
      [a.accountId, kind],
    );
    const err = await pgError(
      q(
        as(a.userId),
        `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind)
         VALUES ($1, $2, 'depth', 'Depth', 'number')`,
        [a.accountId, kind],
      ),
    );
    expect(err).toMatchObject({ code: '23505', constraint: 'type_fields_place_kind_key_uq' });
  });
});

describe('who may write which registry (D11, D123)', () => {
  let b: Tenant;
  let member: string;
  let viewer: string;
  beforeEach(async () => {
    b = await seedTenant(db, 'b');
    member = await seedUser(db, 'member');
    viewer = await seedUser(db, 'viewer');
    await addMember(db, b.locationId, member, 'member');
    await addMember(db, b.locationId, viewer, 'viewer');
  });

  const insert = (userId: string, table: string, cols: string, values: string) =>
    withScope(
      app,
      as(userId),
      async (_tx, c) =>
        (
          await c.query(
            `INSERT INTO public.${table} (owner_account_id, ${cols}) VALUES ($1, ${values})`,
            [b.accountId],
          )
        ).rowCount,
    );

  it('lets a member create vendors, people and tags inline, but not brands or types', async () => {
    expect(await insert(member, 'vendors', 'name', `'Shop'`)).toBe(1);
    expect(await insert(member, 'people', 'display_name', `'Alfred'`)).toBe(1);
    expect(await insert(member, 'tags', 'name', `'Garden'`)).toBe(1);
    for (const [table, cols, values] of [
      ['brands', 'name', `'Acme'`],
      ['types', 'name, icon', `'Mine', 'lucide:box'`],
      ['place_kinds', 'key, name, icon', `'shelf', 'Shelf', 'lucide:box'`],
    ] as const) {
      expect((await pgError(insert(member, table, cols, values))).code, table).toBe('42501');
    }
  });

  it('lets only admins change or remove them', async () => {
    await insert(b.userId, 'vendors', 'name', `'Shop'`);
    const changed = await q(as(member), `UPDATE public.vendors SET name = 'X' RETURNING id`);
    expect(changed).toEqual([]);
    const deleted = await withScope(
      app,
      as(member),
      async (_tx, c) => (await c.query('DELETE FROM public.vendors')).rowCount,
    );
    expect(deleted).toBe(0);
    const byOwner = await q(as(b.userId), `UPDATE public.vendors SET name = 'X' RETURNING id`);
    expect(byOwner).toHaveLength(1);
  });

  it('refuses a viewer every insert', async () => {
    for (const [table, cols, values] of [
      ['vendors', 'name', `'Shop'`],
      ['people', 'display_name', `'Alfred'`],
      ['tags', 'name', `'Garden'`],
    ] as const) {
      expect((await pgError(insert(viewer, table, cols, values))).code, table).toBe('42501');
    }
  });

  it('refuses a second brand or tag with the same normalised name (D42)', async () => {
    await insert(b.userId, 'brands', 'name', `'Samsung'`);
    expect(await pgError(insert(b.userId, 'brands', 'name', `'SAMSUNG '`))).toMatchObject({
      code: '23505',
      constraint: 'brands_name_uq',
    });
    await insert(b.userId, 'tags', 'name', `'مكتبة'`);
    expect(await pgError(insert(member, 'tags', 'name', `'مكتبه'`))).toMatchObject({
      code: '23505',
      constraint: 'tags_name_uq',
    });
    // Another account may use the same names.
    const a = await seedTenant(db, 'a');
    await q(
      as(a.userId),
      `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Samsung')`,
      [a.accountId],
    );
  });
});

describe('person contacts (D177, Q5)', () => {
  it('shows contacts to admins of the account, never to members or viewers', async () => {
    const b = await seedTenant(db, 'b');
    const member = await seedUser(db, 'member');
    const admin = await seedUser(db, 'admin');
    await addMember(db, b.locationId, member, 'member');
    await addMember(db, b.locationId, admin, 'admin');
    const person = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Alfred')`,
        [person, b.accountId],
      );
      await c.query(
        `INSERT INTO public.person_contacts (person_id, owner_account_id, phone)
         VALUES ($1, $2, '+20 100')`,
        [person, b.accountId],
      );
    });
    const read = (userId: string) =>
      q(as(userId), 'SELECT phone FROM public.person_contacts WHERE person_id = $1', [person]);
    expect(await read(b.userId)).toEqual([{ phone: '+20 100' }]);
    expect(await read(admin)).toEqual([{ phone: '+20 100' }]);
    expect(await read(member)).toEqual([]);
    // The member still sees the person, only not the contacts.
    expect(await q(as(member), 'SELECT display_name FROM public.people')).toEqual([
      { display_name: 'Alfred' },
    ]);
  });
});

describe('security review of Phase A (minor findings)', () => {
  it('refuses a new type whose parent and field group define the same key (23514)', async () => {
    const a = await seedTenant(db, 'a');
    const parent = await customType(a, 'Parent', null);
    await addField(a, parent, 'code');
    const group = newId();
    await q(
      as(a.userId),
      `INSERT INTO public.types (id, owner_account_id, name, icon, is_field_group)
       VALUES ($1, $2, 'Group', 'lucide:box', true)`,
      [group, a.accountId],
    );
    await addField(a, group, 'code');
    const both = q(
      as(a.userId),
      `INSERT INTO public.types (owner_account_id, parent_id, field_groups, name, icon)
       VALUES ($1, $2, $3, 'Both', 'lucide:box')`,
      [a.accountId, parent, [group]],
    );
    expect(await pgError(both)).toMatchObject({
      code: '23514',
      constraint: 'type_fields_inherited_key',
    });
  });

  it('takes copied_from_id only for a built-in, refusing anything else like a missing id (42501)', async () => {
    const a = await seedTenant(db, 'a');
    const b = await seedTenant(db, 'b');
    const theirs = await customType(b, 'Theirs', null);
    const mine = await customType(a, 'Mine', null);
    const copy = (from: string) =>
      q(
        as(a.userId),
        `INSERT INTO public.types (owner_account_id, copied_from_id, icon) VALUES ($1, $2, 'lucide:box')`,
        [a.accountId, from],
      );
    for (const from of [theirs, mine, newId()]) {
      expect(await pgError(copy(from))).toMatchObject({
        code: '42501',
        constraint: 'types_copied_from',
      });
    }
    await copy(await builtin('phone'));
  });

  it('links a person only to a member of a location of the account (42501 otherwise)', async () => {
    const b = await seedTenant(db, 'b');
    const a = await seedTenant(db, 'a');
    const member = await seedUser(db, 'member');
    await addMember(db, b.locationId, member, 'member');
    const link = (userId: string) =>
      q(
        as(b.userId),
        `INSERT INTO public.people (owner_account_id, display_name, member_user_id) VALUES ($1, 'P', $2)`,
        [b.accountId, userId],
      );
    for (const who of [a.userId, newId()]) {
      expect(await pgError(link(who))).toMatchObject({
        code: '42501',
        constraint: 'people_member_user',
      });
    }
    await link(member);
    await link(b.userId);
  });

  it('lets a member add contacts only for a person used nowhere they cannot write, and hides a clash', async () => {
    const b = await seedTenant(db, 'b');
    const flat = await ownerTx(db, (c) => insertLocation(c, b, { name: 'Flat' }));
    const member = await seedUser(db, 'member');
    await addMember(db, b.locationId, member, 'member');
    const [free, usedInFlat, hasContact] = [newId(), newId(), newId()];
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.people (id, owner_account_id, display_name)
         VALUES ($1, $4, 'Free'), ($2, $4, 'Flat'), ($3, $4, 'Known')`,
        [free, usedInFlat, hasContact, b.accountId],
      );
      await c.query(
        `INSERT INTO public.things (location_id, place_id, name, belongs_to_person_id)
         VALUES ($1, $2, 'Bike', $3)`,
        [flat.locationId, flat.unplacedId, usedInFlat],
      );
      await c.query(
        `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '1')`,
        [hasContact, b.accountId],
      );
    });
    const add = (person: string) =>
      q(
        as(member),
        `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '2')`,
        [person, b.accountId],
      );
    await add(free);
    for (const person of [usedInFlat, hasContact, newId()]) {
      expect((await pgError(add(person))).code, person).toBe('42501');
    }
  });
});

describe('the reference seed and secret fields (security review minor)', () => {
  it('never flips a field to or from secret, and the seed names the field it refuses', async () => {
    const wifi = await asOwner(db, (c) =>
      c.query<{ id: string }>(
        `SELECT f.id FROM public.type_fields f JOIN public.types t ON t.id = f.type_id
          WHERE t.builtin_key = 'network_device' AND f.key = 'wifi_password'`,
      ),
    ).then((r) => r.rows[0]?.id as string);
    expect(
      await pgError(
        asOwner(db, (c) =>
          c.query('UPDATE public.type_fields SET secret = false WHERE id = $1', [wifi]),
        ),
      ),
    ).toMatchObject({ code: '23514', constraint: 'type_fields_secret_fixed' });
    // A database that disagrees with the library (made past the guard) fails the seed clearly.
    await asOwner(db, async (c) => {
      await c.query('ALTER TABLE public.type_fields DISABLE TRIGGER type_fields_secret_fixed');
      try {
        await c.query('UPDATE public.type_fields SET secret = false WHERE id = $1', [wifi]);
      } finally {
        await c.query('ALTER TABLE public.type_fields ENABLE TRIGGER type_fields_secret_fixed');
      }
    });
    const err = await asOwner(db, (c) => seedTypes(c)).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain('network_device.wifi_password');
  });
});
