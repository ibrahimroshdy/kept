import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { v7 } from 'uuid';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import type { SystemJobDeps } from '../jobs/system.js';
import type { FileStorage } from '../storage/blob-store.js';
import { searchJobs } from './jobs.js';
import { nearWords } from './query.js';
import { search } from './service.js';

// Task 20 through the front door: GET /api/v1/search and the saved views, as the web calls them
// (apps/web/src/api/inventory/{types,paths}.ts and mock/search.ts). Rows are seeded as
// kept_owner; every read and write goes through the app as a signed-in user on kept_app.

let db: TestDb;
let t: TestApp;

type Loc = { id: string; unplacedId: string };

async function createLocation(as: Person, preset: string, name = 'Home'): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  const unplacedId = await ownerTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
      [id],
    );
    return rows[0]?.id as string;
  });
  return { id, unplacedId };
}

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function place(loc: Loc, name: string, parentId: string | null = null): Promise<string> {
  const id = newId();
  await own(
    'INSERT INTO public.places (id, location_id, parent_id, name) VALUES ($1, $2, $3, $4)',
    [id, loc.id, parentId, name],
  );
  return id;
}

type ThingFields = {
  name?: string | null;
  placeId?: string;
  containerId?: string;
  aliases?: Record<string, string[]>;
  model?: string;
  serial?: string;
  notes?: string;
  custom?: Record<string, unknown>;
  lifecycle?: string;
  reviewState?: string;
  uncertain?: boolean;
  lastSeenAt?: string;
  typeKey?: string;
};

async function thing(loc: Loc, f: ThingFields = {}): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name, aliases, model,
                               serial, notes, custom, lifecycle, review_state, location_uncertain,
                               last_seen_at, type_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, coalesce($14::timestamptz, now()),
             (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $15))`,
    [
      id,
      loc.id,
      f.containerId ? null : (f.placeId ?? loc.unplacedId),
      f.containerId ?? null,
      f.name === undefined ? 'Thing' : f.name,
      JSON.stringify(f.aliases ?? {}),
      f.model ?? null,
      f.serial ?? null,
      f.notes ?? null,
      JSON.stringify(f.custom ?? {}),
      f.lifecycle ?? 'in_use',
      f.reviewState ?? 'confirmed',
      f.uncertain ?? false,
      f.lastSeenAt ?? null,
      f.typeKey ?? null,
    ],
  );
  return id;
}

async function shortCode(loc: Loc, thingId: string): Promise<string> {
  const code = randomShortCode();
  await own('INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)', [
    code,
    loc.id,
    thingId,
  ]);
  return code;
}

type Row = {
  id: string;
  name: string | null;
  path: { id: string; name: string; kind: string; isUnplaced: boolean }[];
  derivedState: string[];
  matchedAlias?: string;
  containerThumbUrl: string | null;
  thumbUrl: string | null;
  shortCode: string | null;
  type: { builtinKey: string | null } | null;
} & Record<string, unknown>;
type Result = {
  things: { items: Row[]; next_cursor: string | null };
  places: { id: string; name: string; path: Row['path'] }[];
  people: { id: string; displayName: string }[];
  vendors: { id: string; name: string }[];
  didYouMean: string[];
  asOf: string;
};

async function find(as: Person, params: Record<string, string | number>): Promise<Result> {
  const sp = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await call(t, `/api/v1/search?${sp}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Result;
}

const names = (r: Result) => r.things.items.map((x) => x.name);

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/search', () => {
  let ann: Person;
  let bob: Person;
  let vic: Person;
  let home: Loc;
  let bobs: Loc;
  let hdmi: string;
  let office: string;
  let box: string;
  let drawer: string;
  let annCode: string;
  let bobCode: string;

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    t = await peopleApp(db);
    ann = await person(t, db, 'ann');
    bob = await person(t, db, 'bob');
    vic = await person(t, db, 'vic');
    // Essentials: the D74 location (no money module).
    home = await createLocation(ann, 'essentials');
    await join(db, home.id, vic.userId, 'viewer');
    bobs = await createLocation(bob, 'essentials', 'Bob home');

    office = await place(home, 'Office');
    drawer = await place(home, 'Desk drawer', office);
    hdmi = await thing(home, {
      name: 'HDMI cable, 2 m',
      placeId: drawer,
      aliases: { ar: ['كابل HDMI'], en: ['display cable'] },
    });
    annCode = await shortCode(home, hdmi);
    box = await thing(home, { name: 'Cable box', placeId: office, typeKey: 'box_bin' });
    await thing(home, { name: 'USB charger', containerId: box });
    await thing(home, { name: 'مكتبه صغيرة' });
    await thing(home, { name: 'Samsung TV 55' });
    await thing(home, { name: 'مِفْتَاح الشقة' });
    await thing(home, { name: 'HDMI  2.1 adapter', serial: 'SN-12345/AB' });
    await own(
      `INSERT INTO public.people (owner_account_id, display_name)
               SELECT owner_account_id, 'Murdock Cable' FROM public.locations WHERE id = $1`,
      [home.id],
    );
    await own(
      `INSERT INTO public.vendors (owner_account_id, name, kind)
               SELECT owner_account_id, 'Cable World', 'store' FROM public.locations WHERE id = $1`,
      [home.id],
    );

    const bobThing = await thing(bobs, { name: 'Bob HDMI cable secret stash' });
    bobCode = await shortCode(bobs, bobThing);
    await own(
      `INSERT INTO public.people (owner_account_id, display_name)
               SELECT owner_account_id, 'Bob Cable friend' FROM public.locations WHERE id = $1`,
      [bobs.id],
    );
  });

  describe('the D74 criterion: the HDMI cable on Essentials (D194)', () => {
    it.each(['hdmi', 'HDMI', 'cable', 'كابل', 'الكابل', 'hdmi cab'])(
      'finds it by %s',
      async (q) => {
        const r = await find(ann, { q });
        expect(r.things.items.map((x) => x.id)).toContain(hdmi);
      },
    );

    it('finds it through the typo hmdi: no match, and the did-you-mean finds it (§1, "No match for hmdi")', async () => {
      const r = await find(ann, { q: 'hmdi' });
      expect(r.things.items).toEqual([]);
      expect(r.didYouMean).toContain('HDMI cable, 2 m');
      const again = await find(ann, { q: r.didYouMean[0] as string });
      expect(again.things.items[0]?.id).toBe(hdmi);
    });

    it('says which alias matched when the name did not (screens §8)', async () => {
      const r = await find(ann, { q: 'كابل' });
      const row = r.things.items.find((x) => x.id === hdmi);
      expect(row?.matchedAlias).toBe('كابل HDMI');
      const byName = await find(ann, { q: 'hdmi' });
      expect(byName.things.items.find((x) => x.id === hdmi)).not.toHaveProperty('matchedAlias');
      const display = await find(ann, { q: 'display' });
      expect(display.things.items.find((x) => x.id === hdmi)?.matchedAlias).toBe('display cable');
    });

    it('answers the ThingRow shape with the full path', async () => {
      const r = await find(ann, { q: 'hdmi cable' });
      const row = r.things.items[0];
      expect(row).toMatchObject({
        id: hdmi,
        locationId: home.id,
        shortCode: annCode,
        name: 'HDMI cable, 2 m',
        type: null,
        quantity: 1,
        lifecycle: 'in_use',
        derivedState: [],
        path: [
          { id: office, name: 'Office', kind: 'place', isUnplaced: false, shortCode: null },
          { id: drawer, name: 'Desk drawer', kind: 'place', isUnplaced: false, shortCode: null },
        ],
        containerThumbUrl: null,
        thumbUrl: null,
        isContainer: false,
      });
      expect(typeof row?.lastSeenAt).toBe('string');
      expect(Date.parse(r.asOf)).not.toBeNaN();
    });

    it('marks containers as ThingRow does (a container type, or anything with things inside)', async () => {
      const rows = (await find(ann, { q: 'cable' })).things.items;
      expect(rows.find((x) => x.id === box)?.isContainer).toBe(true);
      expect(rows.find((x) => x.id === hdmi)?.isContainer).toBe(false);
    });
  });

  describe('Arabic and digits (D42, screens §8)', () => {
    it('finds مكتبه by مكتبة (ة ↔ ه)', async () => {
      expect(names(await find(ann, { q: 'مكتبة' }))).toContain('مكتبه صغيرة');
    });

    it('finds 55 by Eastern Arabic digits ٥٥', async () => {
      expect(names(await find(ann, { q: '٥٥' }))).toContain('Samsung TV 55');
    });

    it('ignores harakat on either side', async () => {
      expect(names(await find(ann, { q: 'مفتاح' }))).toContain('مِفْتَاح الشقة');
      expect(names(await find(ann, { q: 'مُفْتاح شقة' }))).toContain('مِفْتَاح الشقة');
    });

    it("matches tokens Postgres keeps whole (`2.1`, a serial's `-12345`) as typed", async () => {
      expect(names(await find(ann, { q: 'hdmi 2.1' }))).toContain('HDMI  2.1 adapter');
      expect(names(await find(ann, { q: 'SN-12345/AB' }))).toContain('HDMI  2.1 adapter');
      expect(names(await find(ann, { q: 'sn-123' }))).toContain('HDMI  2.1 adapter');
    });

    it('never lets typed tsquery syntax through', async () => {
      const r = await find(ann, { q: "hdmi & !cable | ') :* \\" });
      expect(r.things.items.map((x) => x.id)).toContain(hdmi);
    });
  });

  describe('row-level security', () => {
    it("never finds another household's things, people or codes", async () => {
      const r = await find(ann, { q: 'stash' });
      expect(r.things.items).toEqual([]);
      expect(r.didYouMean).toEqual([]);
      const cable = await find(ann, { q: 'cable', kind: 'people' });
      expect(cable.people.map((x) => x.displayName)).toEqual(['Murdock Cable']);
      const code = await find(ann, { q: bobCode });
      expect(code.things.items).toEqual([]);
      // …and Bob sees only his.
      const bobs = await find(bob, { q: 'hdmi' });
      expect(names(bobs)).toEqual(['Bob HDMI cable secret stash']);
    });

    it('answers 404 for a location filter the caller cannot see, as /trash and /activity do (review #36)', async () => {
      const res = await call(t, `/api/v1/search?q=hdmi&locationId=${bobs.id}`, { as: ann });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    });

    it("a viewer's rows carry no money field at all", async () => {
      const r = await find(vic, { q: 'hdmi' });
      expect(r.things.items.length).toBeGreaterThan(0);
      for (const row of r.things.items) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'containerThumbUrl',
            'derivedState',
            'id',
            'isContainer',
            'lastSeenAt',
            'lifecycle',
            'locationId',
            'name',
            'path',
            'quantity',
            'shortCode',
            'thumbUrl',
            'type',
            ...('matchedAlias' in row ? ['matchedAlias'] : []),
          ].sort(),
        );
      }
    });
  });

  describe('short codes (D120)', () => {
    it('finds a thing by its code, typed loosely, and ranks it first', async () => {
      const r = await find(ann, { q: annCode.toLowerCase() });
      expect(r.things.items[0]?.id).toBe(hdmi);
    });
  });

  describe('groups', () => {
    it('answers places with their breadcrumb, people and vendors of visible accounts', async () => {
      const r = await find(ann, { q: 'drawer' });
      expect(r.places).toEqual([
        {
          id: drawer,
          locationId: home.id,
          name: 'Desk drawer',
          kindKey: 'room',
          icon: null,
          path: [{ id: office, name: 'Office', kind: 'place', isUnplaced: false, shortCode: null }],
        },
      ]);
      const c = await find(ann, { q: 'cable' });
      expect(c.people.map((x) => x.displayName)).toEqual(['Murdock Cable']);
      expect(c.vendors).toMatchObject([{ name: 'Cable World', kind: 'store' }]);
    });

    it('with a kind, answers only that group', async () => {
      const r = await find(ann, { q: 'cable', kind: 'vendors' });
      expect(r.things).toEqual({ items: [], next_cursor: null });
      expect(r.places).toEqual([]);
      expect(r.people).toEqual([]);
      expect(r.vendors).toHaveLength(1);
    });

    it('never lists the Unplaced area as a place', async () => {
      expect((await find(ann, { q: 'unplaced' })).places).toEqual([]);
    });
  });

  describe('filters', () => {
    it('placeId covers the subtree and what is inside its containers', async () => {
      const r = await find(ann, { placeId: office });
      expect(names(r).sort()).toEqual(['Cable box', 'HDMI cable, 2 m', 'USB charger']);
      const inBox = await find(ann, { placeId: box });
      expect(names(inBox)).toEqual(['USB charger']);
      const usb = inBox.things.items[0];
      expect(usb?.path.map((s) => s.kind)).toEqual(['place', 'container']);
    });

    it('rejects a malformed filter (400)', async () => {
      const res = await call(t, '/api/v1/search?state=teapot', { as: ann });
      expect(res.statusCode).toBe(400);
      const cur = await call(t, '/api/v1/search?q=hdmi&cursor=nonsense', { as: ann });
      expect(cur.statusCode).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('search that changes data between cases', () => {
  let ann: Person;
  let home: Loc;

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
    t = await peopleApp(db);
    ann = await person(t, db, 'ann');
    home = await createLocation(ann, 'household');
  });

  it('never matches a secret value, a price or a money field', async () => {
    const id = await thing(home, {
      name: 'Router',
      custom: { price_paid: { amount: '4321', currency: 'EGP' } },
    });
    const purchase = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total)
       VALUES ($1, $2, '2026-09-01', 'EGP', 9876)`,
      [purchase, home.id],
    );
    const line = newId();
    await own(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
       VALUES ($1, $2, $3, 'Router', 5555)`,
      [line, home.id, purchase],
    );
    await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, id]);
    // A type of the account with a secret field, and the thing's value for it.
    const type = newId();
    const field = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.types (id, owner_account_id, name, icon)
         SELECT $1, owner_account_id, 'Network box', 'lucide:router' FROM public.locations
          WHERE id = $2`,
        [type, home.id],
      );
      await c.query(
        `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, kind, label, secret)
         SELECT $1, owner_account_id, $2, 'wifi_password', 'text', 'Wi-Fi password', true
           FROM public.locations WHERE id = $3`,
        [field, type, home.id],
      );
      await c.query('UPDATE public.things SET type_id = $1 WHERE id = $2', [type, id]);
      await c.query(
        `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key,
                                           ciphertext, key_version, updated_by)
         VALUES ($1, $2, $3, 'wifi_password', '{"v": 1, "c": "hunter2"}', 1, $4)`,
        [home.id, id, field, ann.userId],
      );
    });
    expect(await own('SELECT 1 FROM public.secret_values WHERE thing_id = $1', [id])).toHaveLength(
      1,
    );
    for (const q of ['4321', '5555', '9876', 'hunter2']) {
      const r = await find(ann, { q });
      expect(r.things.items, q).toEqual([]);
      expect(r.didYouMean, q).toEqual([]);
    }
    expect(names(await find(ann, { q: 'router' }))).toEqual(['Router']);
  });

  it('applies the money filters only where the caller sees money (a viewer: ignored)', async () => {
    const cheap = await thing(home, { name: 'Cheap lamp' });
    const dear = await thing(home, { name: 'Dear lamp' });
    const purchase = newId();
    await own(
      `INSERT INTO public.purchases (id, location_id, purchased_on, currency) VALUES ($1, $2, '2026-09-01', 'EGP')`,
      [purchase, home.id],
    );
    for (const [id, price] of [
      [cheap, 100],
      [dear, 5000],
    ] as const) {
      const line = newId();
      await own(
        `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
         VALUES ($1, $2, $3, 'Lamp', $4)`,
        [line, home.id, purchase, price],
      );
      await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, id]);
    }
    expect(names(await find(ann, { q: 'lamp', priceMin: '1000' }))).toEqual(['Dear lamp']);
    expect(names(await find(ann, { q: 'lamp', priceMax: '1000', currency: 'egp' }))).toEqual([
      'Cheap lamp',
    ]);
    expect(names(await find(ann, { q: 'lamp', currency: 'USD' }))).toEqual([]);

    const vic = await person(t, db, 'vic');
    await join(db, home.id, vic.userId, 'viewer');
    // A viewer can't see money here, so a price can't narrow (or reveal) anything.
    const viewer = await find(vic, { q: 'lamp', priceMin: '1000' });
    expect(names(viewer).sort()).toEqual(['Cheap lamp', 'Dear lamp']);
    // Once the location lets viewers see money, it applies to them too (D13).
    await own('UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    const shown = await find(vic, { q: 'lamp', priceMin: '1000' });
    expect(names(shown)).toEqual(['Dear lamp']);
  });

  it('takes several values of a filter, and "is none of" (D205)', async () => {
    const cabin = await createLocation(ann, 'household', 'Cabin');
    const shelf = await place(home, 'Shelf');
    const office = await place(home, 'Office');
    const [red, blue] = await own<{ id: string }>(
      `INSERT INTO public.tags (owner_account_id, name)
       SELECT owner_account_id, n FROM public.locations, unnest(ARRAY['red', 'blue']) AS n
        WHERE id = $1 ORDER BY n DESC RETURNING id`,
      [home.id],
    );
    const tagged = async (id: string, tag: string) =>
      own('INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)', [
        home.id,
        id,
        tag,
      ]);
    const a = await thing(home, { name: 'Alpha kit', placeId: shelf, typeKey: 'electronics' });
    await tagged(a, red?.id as string);
    await thing(home, { name: 'Bravo kit', typeKey: 'box_bin' });
    const c = await thing(home, { name: 'Charlie kit', placeId: office });
    await tagged(c, blue?.id as string);
    await thing(cabin, { name: 'Delta kit', typeKey: 'electronics' });
    const [electronics, box] = await own<{ id: string }>(
      `SELECT id FROM public.types WHERE owner_account_id IS NULL
          AND builtin_key IN ('electronics', 'box_bin') ORDER BY builtin_key = 'box_bin'`,
    );
    const by = async (qs: string) => {
      const res = await call(t, `/api/v1/search?${qs}`, { as: ann });
      expect(res.statusCode, `${qs}: ${res.body}`).toBe(200);
      return names(res.json() as Result).sort();
    };

    // Any of two types; a thing with no type is none of them.
    expect(await by(`typeId=${electronics?.id}&typeId=${box?.id}`)).toEqual([
      'Alpha kit',
      'Bravo kit',
      'Delta kit',
    ]);
    expect(await by(`typeId=${electronics?.id}&not=typeId`)).toEqual(['Bravo kit', 'Charlie kit']);
    // None of a tag: the untagged count.
    expect(await by(`tagId=${red?.id}&not=tagId`)).toEqual([
      'Bravo kit',
      'Charlie kit',
      'Delta kit',
    ]);
    // Two locations, with and without words (the index door takes one location, or none).
    expect(await by(`locationId=${home.id}&locationId=${cabin.id}`)).toHaveLength(4);
    expect(await by(`q=kit&locationId=${home.id}&locationId=${cabin.id}`)).toHaveLength(4);
    expect(await by(`q=kit&locationId=${cabin.id}`)).toEqual(['Delta kit']);
    expect(await by(`q=kit&locationId=${cabin.id}&not=locationId`)).toEqual([
      'Alpha kit',
      'Bravo kit',
      'Charlie kit',
    ]);
    // Places: any of two subtrees, or none of one.
    expect(await by(`placeId=${shelf}&placeId=${office}`)).toEqual(['Alpha kit', 'Charlie kit']);
    expect(await by(`placeId=${shelf}&not=placeId`)).toEqual([
      'Bravo kit',
      'Charlie kit',
      'Delta kit',
    ]);
    // States: any of, or none of (the Unplaced area holds Bravo and Delta).
    expect(await by('state=unplaced&state=draft')).toEqual(['Bravo kit', 'Delta kit']);
    expect(await by('state=unplaced&not=state')).toEqual(['Alpha kit', 'Charlie kit']);
    // A `not` naming a filter with no values says nothing.
    expect(await by(`q=kit&not=tagId`)).toHaveLength(4);
    // The other groups follow the location filter too.
    const places = await call(t, `/api/v1/search?q=shelf&locationId=${home.id}&not=locationId`, {
      as: ann,
    });
    expect((places.json() as Result).places).toEqual([]);
    const shelves = await call(
      t,
      `/api/v1/search?q=shelf&locationId=${home.id}&locationId=${cabin.id}`,
      {
        as: ann,
      },
    );
    expect((shelves.json() as Result).places.map((p) => p.name)).toEqual(['Shelf']);
    // So does did-you-mean: asked once per location the filter leaves.
    const near = async (qs: string) =>
      ((await call(t, `/api/v1/search?q=detla&${qs}`, { as: ann })).json() as Result).didYouMean;
    expect(await near(`locationId=${home.id}&locationId=${cabin.id}`)).toContain('Delta kit');
    expect(await near(`locationId=${home.id}&not=locationId`)).toContain('Delta kit');
    expect(await near(`locationId=${cabin.id}&not=locationId`)).not.toContain('Delta kit');
    // Every location named, either way, must be visible (review #36).
    const bob = await person(t, db, 'bob');
    const bobs = await createLocation(bob, 'essentials', 'Bob home');
    for (const qs of [
      `locationId=${home.id}&locationId=${bobs.id}`,
      `locationId=${bobs.id}&not=locationId`,
    ]) {
      expect((await call(t, `/api/v1/search?${qs}`, { as: ann })).statusCode, qs).toBe(404);
    }
    expect((await call(t, '/api/v1/search?not=kind', { as: ann })).statusCode).toBe(400);
  });

  it('filters by state: uncertain, draft, ended, unplaced, long unseen, to review', async () => {
    const shelf = await place(home, 'Shelf');
    await thing(home, { name: 'Lost remote', placeId: shelf, uncertain: true });
    await thing(home, { name: null, placeId: shelf, reviewState: 'draft' });
    await thing(home, { name: 'Old phone', placeId: shelf, lifecycle: 'sold' });
    await thing(home, { name: 'Loose screw' });
    await thing(home, { name: 'Forgotten tent', placeId: shelf, lastSeenAt: '2020-01-01' });
    const gen = await thing(home, { name: 'Generator', placeId: shelf });
    const meter = newId();
    await own(
      `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
      [meter, home.id, gen],
    );
    await own(
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, state)
       VALUES ($1, $2, 12.5, now(), 'needs_review')`,
      [home.id, meter],
    );
    const by = async (state: string) => names(await find(ann, { state })).sort();
    expect(await by('uncertain')).toEqual(['Lost remote']);
    expect(await by('draft')).toEqual([null]);
    expect(await by('ended')).toEqual(['Old phone']);
    expect(await by('unplaced')).toEqual(['Loose screw']);
    expect(await by('long_unseen')).toEqual(['Forgotten tent']);
    expect(await by('to_review')).toEqual(['Generator']);
    const draft = await find(ann, { state: 'draft' });
    expect(draft.things.items[0]?.derivedState).toEqual(['draft']);
    const loose = await find(ann, { q: 'screw' });
    expect(loose.things.items[0]?.path).toEqual([
      { id: home.unplacedId, name: 'Unplaced', kind: 'place', isUnplaced: true, shortCode: null },
    ]);
  });

  it('pages things with a cursor, with and without a query', async () => {
    for (let i = 0; i < 25; i++) {
      await thing(home, { name: `Widget ${String(i).padStart(2, '0')}` });
    }
    for (const params of [{ q: 'widget' }, {}] as Record<string, string>[]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r: Result = await find(ann, {
          ...params,
          kind: 'things',
          limit: 10,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...r.things.items.map((x) => x.id));
        cursor = r.things.next_cursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(25);
    }
    // Without a query, A to Z; without a kind, the first 20.
    const first = await find(ann, {});
    expect(first.things.items).toHaveLength(20);
    expect(first.things.items[0]?.name).toBe('Widget 00');
    expect(first.things.next_cursor).not.toBeNull();
  });

  it('shows the container photo beside the path (D195)', async () => {
    const box = await thing(home, { name: 'Box 3', typeKey: 'box_bin' });
    const inside = await thing(home, { name: 'Spare fuse', containerId: box });
    const file = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
      [file, home.id, `f/${home.id}/${file}`, 'a'.repeat(64), ann.userId],
    );
    await own(
      `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                            height, bytes)
       VALUES ($1, 'thumb', $2, $3, 10, 10, 5)`,
      [file, home.id, `d/${file}/thumb.jpg`],
    );
    await own(
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'photo', $4)`,
      [home.id, file, box, ann.userId],
    );
    const signed: string[] = [];
    const files = {
      blobs: {
        signedUrl: async (key: string) => {
          signed.push(key);
          return `https://files.test/${key}`;
        },
      },
    } as unknown as FileStorage;
    const result = await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (tx, c) =>
      search(tx, c, { userId: ann.userId, mfa: false }, files, { q: 'fuse' }),
    );
    const row = result.things.items.find((x) => x.id === inside);
    expect(row?.containerThumbUrl).toBe(`https://files.test/d/${file}/thumb.jpg`);
    expect(row?.thumbUrl).toBeNull();
    const boxRow = (
      await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (tx, c) =>
        search(tx, c, { userId: ann.userId, mfa: false }, files, { q: 'box 3' }),
      )
    ).things.items[0];
    expect(boxRow?.thumbUrl).toBe(`https://files.test/d/${file}/thumb.jpg`);
    expect(boxRow?.type?.builtinKey).toBe('box_bin');
    // Without storage (the app in these tests), no URL at all.
    expect((await find(ann, { q: 'fuse' })).things.items[0]?.containerThumbUrl).toBeNull();
  });

  it('signs the thumbnail the derivative row names: a copy shares its source blob, a PDF has none', async () => {
    // A photo a cross-account move copied here (D161): the copy's rows name the source's blobs,
    // not keys made from the copy's own id.
    const source = newId();
    const copy = newId();
    const clock = await thing(home, { name: 'Heirloom clock' });
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
      [copy, home.id, `f/${newId()}/${source}`, 'b'.repeat(64), ann.userId],
    );
    await own(
      `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                            height, bytes)
       VALUES ($1, 'thumb', $2, $3, 10, 10, 5)`,
      [copy, home.id, `d/${source}/thumb.jpg`],
    );
    // A manual kept as a PDF "photo": no derivatives at all (D117).
    const manual = await thing(home, { name: 'Heirloom manual' });
    const pdf = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'not_applicable', $5)`,
      [pdf, home.id, `f/${home.id}/${pdf}`, 'c'.repeat(64), ann.userId],
    );
    for (const [file, on] of [
      [copy, clock],
      [pdf, manual],
    ]) {
      await own(
        `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
         VALUES ($1, $2, $3, 'photo', $4)`,
        [home.id, file, on, ann.userId],
      );
    }
    const signed: string[] = [];
    const files = {
      blobs: {
        signedUrl: async (key: string) => {
          signed.push(key);
          return `https://files.test/${key}`;
        },
      },
    } as unknown as FileStorage;
    const result = await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (tx, c) =>
      search(tx, c, { userId: ann.userId, mfa: false }, files, { q: 'heirloom' }),
    );
    const byId = new Map(result.things.items.map((x) => [x.id, x]));
    expect(byId.get(clock)?.thumbUrl).toBe(`https://files.test/d/${source}/thumb.jpg`);
    expect(byId.get(manual)?.thumbUrl).toBeNull();
    expect(signed).toEqual([`d/${source}/thumb.jpg`]);
  });

  it('after a place rename and the reindex job, finds things by the new path', async () => {
    const office = await place(home, 'Office');
    await thing(home, { name: 'Stapler', placeId: office });
    expect(names(await find(ann, { q: 'office' }))).toEqual(['Stapler']);
    await own(`UPDATE public.places SET name = 'Study' WHERE id = $1`, [office]);
    // The document is stale until the job runs (§7.9): the breadcrumb is always live.
    expect(names(await find(ann, { q: 'study' }))).toEqual([]);

    const logged: object[] = [];
    const deps = {
      pools: db.pools,
      log: { info: (o: object) => logged.push(o), error: () => {} },
    } as unknown as SystemJobDeps;
    const job = searchJobs(deps).find((j) => j.name === 'reindex');
    expect(job?.kind).toBe('system');
    if (job?.kind !== 'system') throw new Error('reindex is a system job');
    await job.handler({ locationId: home.id });
    await expect(job.handler({ locationId: 'nope' })).rejects.toThrow(/uuid/);
    expect(logged).toEqual([{ locationId: home.id, things: 1 }]);

    const r = await find(ann, { q: 'study' });
    expect(names(r)).toEqual(['Stapler']);
    expect(r.things.items[0]?.path.map((s) => s.name)).toEqual(['Study']);
    expect(names(await find(ann, { q: 'office' }))).toEqual([]);
  });
});

describe('nearWords (did-you-mean)', () => {
  it('has the adjacent swap of a short word, and not the word itself', () => {
    const { literals, patterns } = nearWords('hmdi');
    expect(literals).toContain('hdmi');
    expect(literals).not.toContain('hmdi');
    expect(patterns).toContain('h_di');
    expect(nearWords('tv')).toEqual({ literals: [], patterns: [] });
  });
});

// ---------------------------------------------------------------------------------------------

describe('saved views', () => {
  let ann: Person;
  let mel: Person;
  let vic: Person;
  let bob: Person;
  let home: Loc;

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
    t = await peopleApp(db);
    ann = await person(t, db, 'ann');
    mel = await person(t, db, 'mel');
    vic = await person(t, db, 'vic');
    bob = await person(t, db, 'bob');
    home = await createLocation(ann, 'household');
    await join(db, home.id, mel.userId, 'member');
    await join(db, home.id, vic.userId, 'viewer');
  });

  const views = async (as: Person) => {
    const res = await call(t, '/api/v1/saved-views', { as });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { views: { id: string; name: string; rowVersion: number }[] }).views;
  };

  const accountAudit = (userId: string) =>
    own<{ action: string; diff: Record<string, { class: string }>; location_id: string | null }>(
      `SELECT e.action, e.diff, e.location_id FROM public.audit_events e
         JOIN public.owner_accounts a ON a.id = e.owner_account_id
        WHERE a.user_id = $1 AND e.location_id IS NULL AND e.entity_type = 'saved_view'
        ORDER BY e.at, e.id`,
      [userId],
    );

  // catalogue: POST /api/v1/saved-views
  it('creates a personal view, audited on the maker account, and a shared one in the location audit', async () => {
    const id = v7();
    const res = await call(t, '/api/v1/saved-views', {
      as: ann,
      body: { id, name: 'Cables', query: { q: 'cable', filters: { priceMin: ['10'] } } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      id,
      name: 'Cables',
      surface: 'search',
      query: { q: 'cable', filters: { priceMin: ['10'] } },
      sharedLocationId: null,
      createdBy: { displayName: expect.any(String) },
      mine: true,
      rowVersion: 1,
    });
    const personal = await accountAudit(ann.userId);
    expect(personal.map((e) => e.action)).toEqual(['saved_view.create']);
    // A price in a saved query is money in the history.
    expect(personal[0]?.diff.query?.class).toBe('money');

    const shared = await call(t, '/api/v1/saved-views', {
      as: mel,
      body: {
        name: 'Garden',
        query: { filters: { state: ['unplaced'] } },
        sharedLocationId: home.id,
      },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    expect(shared.json()).toMatchObject({ sharedLocationId: home.id });
    const events = await auditOf(db, home.id);
    expect(events.at(-1)).toMatchObject({ action: 'saved_view.create', actor_id: mel.userId });
  });

  it('keeps personal views to their maker and shares shared ones with the location only (RLS)', async () => {
    await call(t, '/api/v1/saved-views', { as: ann, body: { name: 'Mine', query: {} } });
    await call(t, '/api/v1/saved-views', {
      as: ann,
      body: { name: 'Ours', query: {}, sharedLocationId: home.id },
    });
    expect((await views(ann)).map((v) => v.name)).toEqual(['Mine', 'Ours']);
    expect((await views(mel)).map((v) => v.name)).toEqual(['Ours']);
    expect((await views(vic)).map((v) => v.name)).toEqual(['Ours']);
    expect(await views(bob)).toEqual([]);
  });

  it("refuses sharing for a viewer (403) and into a location the caller can't see (404), without an audit row", async () => {
    const before = (await auditOf(db, home.id)).length;
    const viewer = await call(t, '/api/v1/saved-views', {
      as: vic,
      body: { name: 'Nope', query: {}, sharedLocationId: home.id },
    });
    expect(viewer.statusCode).toBe(403);
    const outsider = await call(t, '/api/v1/saved-views', {
      as: bob,
      body: { name: 'Nope', query: {}, sharedLocationId: home.id },
    });
    expect(outsider.statusCode).toBe(404);
    expect((await auditOf(db, home.id)).length).toBe(before);
    // A viewer still keeps personal views.
    const mine = await call(t, '/api/v1/saved-views', {
      as: vic,
      body: { name: 'Mine', query: {} },
    });
    expect(mine.statusCode).toBe(201);
  });

  it('leaves money filters out of a shared view for whoever the location hides money from (review #29)', async () => {
    const shed = await createLocation(ann, 'essentials', 'Shed');
    await join(db, shed.id, mel.userId, 'member');
    const query = {
      q: 'drill',
      filters: { tag: ['a'], priceMin: ['100'], priceMax: ['900'], currency: ['EGP'] },
    };
    for (const [name, loc] of [
      ['Dear things', home],
      ['Dear tools', shed],
    ] as const) {
      const res = await call(t, '/api/v1/saved-views', {
        as: ann,
        body: { name, query, sharedLocationId: loc.id },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    type View = { name: string; query: Record<string, unknown>; moneyHidden?: true };
    const byName = async (as: Person) =>
      Object.fromEntries(((await views(as)) as unknown as View[]).map((v) => [v.name, v]));

    // A viewer where viewers don't see money: the query without its money keys, marked.
    const forVic = await byName(vic);
    expect(forVic['Dear things']?.query).toEqual({ q: 'drill', filters: { tag: ['a'] } });
    expect(forVic['Dear things']?.moneyHidden).toBe(true);
    // A member sees them at home, but not in the Shed, where the Money module is off.
    const forMel = await byName(mel);
    expect(forMel['Dear things']?.query).toEqual(query);
    expect(forMel['Dear things']).not.toHaveProperty('moneyHidden');
    expect(forMel['Dear tools']?.query).toEqual({ q: 'drill', filters: { tag: ['a'] } });
    expect(forMel['Dear tools']?.moneyHidden).toBe(true);
  });

  it("validates the query against the search list's filters", async () => {
    for (const query of [
      { state: 'lent' },
      { cursor: 'x' },
      { nonsense: 1 },
      { filters: { actor: ['x'] } },
      { filters: { tag: 'x' } },
      { filters: { tag: [''] } },
    ]) {
      const res = await call(t, '/api/v1/saved-views', { as: ann, body: { name: 'Bad', query } });
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
    }
  });

  // catalogue: PATCH /api/v1/saved-views/:id
  it('renames, shares and unshares with If-Match, keeping the id, and audits each change', async () => {
    const created = (
      await call(t, '/api/v1/saved-views', { as: mel, body: { name: 'Tools', query: {} } })
    ).json() as { id: string; rowVersion: number };
    const url = `/api/v1/saved-views/${created.id}`;
    const patch = (body: object, version: number | undefined, as: Person = mel) =>
      call(t, url, {
        as,
        method: 'PATCH',
        body,
        ...(version !== undefined ? { headers: { 'if-match': String(version) } } : {}),
      });

    expect((await patch({ name: 'x' }, undefined)).statusCode).toBe(428);
    const renamed = await patch({ name: 'Garden tools' }, 1);
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Garden tools', rowVersion: 2 });
    expect((await patch({ name: 'Stale' }, 1)).statusCode).toBe(412);

    const shared = await patch({ sharedLocationId: home.id }, 2);
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({
      id: created.id,
      sharedLocationId: home.id,
      rowVersion: 3,
    });
    expect((await views(ann)).map((v) => v.name)).toEqual(['Garden tools']);
    const unshared = await patch({ sharedLocationId: null }, 3);
    expect(unshared.json()).toMatchObject({ sharedLocationId: null, rowVersion: 4 });
    expect(await views(ann)).toEqual([]);

    // Someone else's view: 403 when visible (a shared one), 404 when not.
    await patch({ sharedLocationId: home.id }, 4);
    expect((await patch({ name: 'Mine now' }, 5, ann)).statusCode).toBe(403);
    expect((await patch({ name: 'Mine now' }, 5, bob)).statusCode).toBe(404);

    const inHome = (await auditOf(db, home.id)).filter((e) => e.action.startsWith('saved_view.'));
    expect(inHome.map((e) => e.action)).toEqual([
      'saved_view.update',
      'saved_view.update',
      'saved_view.update',
    ]);
    const personal = await accountAudit(mel.userId);
    expect(personal.map((e) => e.action)).toEqual(['saved_view.create', 'saved_view.update']);
  });

  // catalogue: DELETE /api/v1/saved-views/:id
  it("deletes the maker's own view and audits it; others get 403 (visible) or 404", async () => {
    const created = (
      await call(t, '/api/v1/saved-views', {
        as: mel,
        body: { name: 'Shared', query: {}, sharedLocationId: home.id },
      })
    ).json() as { id: string };
    const url = `/api/v1/saved-views/${created.id}`;
    expect((await call(t, url, { as: vic, method: 'DELETE' })).statusCode).toBe(403);
    expect((await call(t, url, { as: bob, method: 'DELETE' })).statusCode).toBe(404);
    const res = await call(t, url, { as: mel, method: 'DELETE' });
    expect(res.statusCode).toBe(204);
    expect(await views(mel)).toEqual([]);
    const events = await auditOf(db, home.id);
    expect(events.at(-1)).toMatchObject({ action: 'saved_view.delete', actor_id: mel.userId });
    expect((await call(t, url, { as: mel, method: 'DELETE' })).statusCode).toBe(404);
  });
});
