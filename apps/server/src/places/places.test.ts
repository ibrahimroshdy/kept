import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { v7 } from 'uuid';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  auditOf,
  call,
  join,
  type Person,
  peopleApp,
  person,
  type RecordedJob,
} from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import { allocateShortId } from './short-id.js';

// Task 13 through the front door: every place operation of D160 as the web calls it
// (apps/web/src/api/inventory/{types,paths}.ts, mock/places.ts). Fixtures are seeded as
// kept_owner; every read and write goes through the app as a signed-in user on kept_app, so
// row-level security and can() decide.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];

type Loc = { id: string; unplacedId: string; accountId: string };

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function createLocation(as: Person, name = 'Home', preset = 'complete'): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  const [row] = await own<{ unplaced: string; account: string }>(
    `SELECT (SELECT id FROM public.places WHERE location_id = l.id AND is_unplaced) AS unplaced,
            l.owner_account_id AS account
       FROM public.locations l WHERE l.id = $1`,
    [id],
  );
  return { id, unplacedId: row?.unplaced as string, accountId: row?.account as string };
}

async function place(loc: Loc, name: string, parentId: string | null = null, kind = 'room') {
  const id = newId();
  await own(
    'INSERT INTO public.places (id, location_id, parent_id, name, kind_key) VALUES ($1, $2, $3, $4, $5)',
    [id, loc.id, parentId, name, kind],
  );
  return id;
}

async function thing(
  loc: Loc,
  name: string,
  where: { placeId?: string; containerId?: string } = {},
  extra: { typeKey?: string; lifecycle?: string } = {},
): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name, lifecycle, type_id)
     VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $7))`,
    [
      id,
      loc.id,
      where.containerId ? null : (where.placeId ?? loc.unplacedId),
      where.containerId ?? null,
      name,
      extra.lifecycle ?? 'in_use',
      extra.typeKey ?? null,
    ],
  );
  return id;
}

type Req = { body?: unknown; ifMatch?: number | string; headers?: Record<string, string> };

function api(
  as: Person,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  req: Req = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...req.headers };
  if (req.ifMatch !== undefined) headers['if-match'] = String(req.ifMatch);
  return call(t, url, {
    as,
    method,
    ...(req.body !== undefined ? { body: req.body } : {}),
    headers,
  });
}

async function ok<T = Record<string, unknown>>(
  res: Promise<LightMyRequestResponse>,
  status = 200,
): Promise<T> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return (status === 204 ? undefined : r.json()) as T;
}

type View = {
  id: string;
  locationId: string;
  parentId: string | null;
  name: string;
  kindKey: string;
  icon: string | null;
  isUnplaced: boolean;
  path: { id: string; name: string; kind: string; isUnplaced: boolean }[];
  shortCode: string | null;
  fields: { key: string; kind: string; secret: boolean; label: string | null }[];
  custom: Record<string, unknown>;
  secrets: { fieldKey: string; set: boolean; canReveal: boolean }[];
  counts: { places: number; things: number };
  attachments: unknown[];
  rowVersion: number;
};

const view = (as: Person, id: string) => ok<View>(api(as, 'GET', `/api/v1/places/${id}`));

/** The audit events of a location with this action, newest last. */
async function auditEvents(locationId: string, action: string) {
  return (await auditOf(db, locationId)).filter((e) => e.action === action);
}

const placeRow = async (id: string) =>
  (
    await own<{
      id: string;
      parent_id: string | null;
      deleted_at: Date | null;
      trash_batch_id: string | null;
    }>('SELECT id, parent_id, deleted_at, trash_batch_id FROM public.places WHERE id = $1', [id])
  )[0];

const thingRow = async (id: string) =>
  (
    await own<{
      id: string;
      place_id: string | null;
      container_id: string | null;
      deleted_at: Date | null;
      trash_batch_id: string | null;
    }>(
      'SELECT id, place_id, container_id, deleted_at, trash_batch_id FROM public.things WHERE id = $1',
      [id],
    )
  )[0];

let ola: Person; // owner
let ada: Person; // admin
let max: Person; // member
let vic: Person; // viewer
let bob: Person; // outsider, with his own location
let home: Loc;
let bobs: Loc;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ola = await person(t, db, 'ola');
  ada = await person(t, db, 'ada');
  max = await person(t, db, 'max');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  home = await createLocation(ola);
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, max.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  bobs = await createLocation(bob, 'Bob home');
});

beforeEach(() => {
  sent.splice(0);
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/locations/:locationId/places (the tree)', () => {
  it('lists every live place flat, the Unplaced area included, with counts', async () => {
    const study = await place(home, 'Study');
    const shelf = await place(home, 'Shelf', study, 'zone');
    const gone = await place(home, 'Gone');
    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [gone]);
    await thing(home, 'Lamp', { placeId: study });
    await thing(home, 'Old lamp', { placeId: study }, { lifecycle: 'sold' });
    // The study's label: its short ID is the tree's link (D208).
    await own(
      `INSERT INTO public.short_ids (code, location_id, place_id, state, is_primary)
       VALUES ('ST4DY2', $1, $2, 'assigned', true)`,
      [home.id, study],
    );

    for (const as of [ola, max, vic]) {
      const { places } = await ok<{ places: Record<string, unknown>[] }>(
        api(as, 'GET', `/api/v1/locations/${home.id}/places`),
      );
      const byId = new Map(places.map((p) => [p.id, p]));
      expect(byId.get(home.unplacedId)).toMatchObject({ isUnplaced: true, parentId: null });
      expect(byId.get(study)).toEqual({
        id: study,
        parentId: null,
        name: 'Study',
        kindKey: 'room',
        icon: null,
        sort: 0,
        isUnplaced: false,
        shortCode: 'ST4DY2',
        thingCount: 2,
        childCount: 1,
      });
      expect(byId.get(shelf)).toMatchObject({
        parentId: study,
        kindKey: 'zone',
        childCount: 0,
        shortCode: null,
      });
      expect(byId.has(gone)).toBe(false);
    }
  });

  it("is a 404 for a location the caller isn't in", async () => {
    expect((await api(bob, 'GET', `/api/v1/locations/${home.id}/places`)).statusCode).toBe(404);
    expect((await api(max, 'GET', `/api/v1/locations/${bobs.id}/places`)).statusCode).toBe(404);
  });
});

describe('POST /api/v1/locations/:locationId/places', () => {
  // catalogue: POST /api/v1/locations/:locationId/places
  it('creates a place as a member and audits it', async () => {
    const id = v7();
    const created = await ok<View>(
      api(max, 'POST', `/api/v1/locations/${home.id}/places`, {
        body: { id, name: '  Garage  ', kindKey: 'room', icon: 'lucide:warehouse' },
      }),
      201,
    );
    expect(created).toEqual({
      id,
      locationId: home.id,
      parentId: null,
      name: 'Garage',
      kindKey: 'room',
      icon: 'lucide:warehouse',
      isUnplaced: false,
      path: [{ id, name: 'Garage', kind: 'place', isUnplaced: false, shortCode: null }],
      shortCode: null,
      fields: [],
      custom: {},
      secrets: [],
      counts: { places: 0, things: 0 },
      attachments: [],
      rowVersion: expect.any(Number),
    });
    const [event] = await auditEvents(home.id, 'place.create');
    expect(event).toMatchObject({ actor_type: 'user', actor_id: max.userId });
    expect(event?.diff).toMatchObject({ name: { before: null, after: 'Garage', class: 'plain' } });

    const child = await ok<View>(
      api(max, 'POST', `/api/v1/locations/${home.id}/places`, {
        body: { parentId: id, name: 'Pegboard', kindKey: 'zone' },
      }),
      201,
    );
    expect(child.path.map((s) => s.name)).toEqual(['Garage', 'Pegboard']);
  });

  it('refuses viewers (403), outsiders (404), and bad input', async () => {
    const url = `/api/v1/locations/${home.id}/places`;
    expect((await api(vic, 'POST', url, { body: { name: 'X', kindKey: 'room' } })).statusCode).toBe(
      403,
    );
    expect((await api(bob, 'POST', url, { body: { name: 'X', kindKey: 'room' } })).statusCode).toBe(
      404,
    );
    const bad = await api(max, 'POST', url, { body: { name: 'X', kindKey: 'spaceship' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().hint).toMatch(/kindKey/);
    expect(
      (await api(max, 'POST', url, { body: { name: 'x'.repeat(121), kindKey: 'room' } }))
        .statusCode,
    ).toBe(400);
    const old = await api(max, 'POST', url, {
      body: { id: '01890a5d-ac96-7000-8000-000000000000', name: 'Old', kindKey: 'room' },
    });
    expect(old.json().code).toBe('id_out_of_window');
  });

  it('refuses a parent in another location (404) or the Unplaced area (409)', async () => {
    const url = `/api/v1/locations/${home.id}/places`;
    const bobsRoom = await place(bobs, 'Bob room');
    const elsewhere = await api(max, 'POST', url, {
      body: { name: 'X', kindKey: 'room', parentId: bobsRoom },
    });
    expect(elsewhere.statusCode).toBe(404);
    const unplaced = await api(max, 'POST', url, {
      body: { name: 'X', kindKey: 'room', parentId: home.unplacedId },
    });
    expect(unplaced.statusCode).toBe(409);
  });
});

describe('GET /api/v1/places/:id', () => {
  it('shows a place to every role, and to nobody outside', async () => {
    const hall = await place(home, 'Hall');
    const nook = await place(home, 'Nook', hall, 'zone');
    for (const as of [ola, ada, max, vic]) {
      const v = await view(as, nook);
      expect(v.path).toEqual([
        { id: hall, name: 'Hall', kind: 'place', isUnplaced: false, shortCode: null },
        { id: nook, name: 'Nook', kind: 'place', isUnplaced: false, shortCode: null },
      ]);
    }
    expect((await api(bob, 'GET', `/api/v1/places/${nook}`)).statusCode).toBe(404);
    const u = await view(max, home.unplacedId);
    expect(u.isUnplaced).toBe(true);
    expect(u.path).toEqual([
      {
        id: home.unplacedId,
        name: expect.any(String),
        kind: 'place',
        isUnplaced: true,
        shortCode: null,
      },
    ]);
  });

  it('is a 404 once the place is in the trash', async () => {
    const p = await place(home, 'Binned');
    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [p]);
    expect((await api(max, 'GET', `/api/v1/places/${p}`)).statusCode).toBe(404);
  });
});

describe('GET /api/v1/places/:id/contents', () => {
  type Contents = {
    places: { id: string; name: string }[];
    things: {
      items: {
        id: string;
        name: string;
        isContainer: boolean;
        path: { name: string; isUnplaced: boolean }[];
        derivedState: string[];
        type: { builtinKey: string | null } | null;
      }[];
      next_cursor: string | null;
    };
  };
  let room: string;
  let box: string;

  beforeAll(async () => {
    room = await place(home, 'Pantry');
    await place(home, 'Top shelf', room, 'zone');
    await place(home, 'Bottom shelf', room, 'zone');
    box = await thing(home, 'Tea box', { placeId: room }, { typeKey: 'box_bin' });
    await thing(home, 'Green tea', { containerId: box });
    await thing(home, 'Rice', { placeId: room });
    await thing(home, 'Flour', { placeId: room });
    await thing(home, 'Beans', { placeId: room }, { lifecycle: 'lost' });
    const bag = await thing(home, 'Bag of bags', { placeId: room });
    await thing(home, 'Small bag', { containerId: bag });
  });

  const contents = (as: Person, qs = '') =>
    ok<Contents>(api(as, 'GET', `/api/v1/places/${room}/contents${qs}`));

  it('answers the child places first, then the things directly inside', async () => {
    const c = await contents(vic);
    expect(c.places.map((p) => p.name)).toEqual(['Bottom shelf', 'Top shelf']);
    expect(c.things.items.map((x) => x.name)).toEqual([
      'Bag of bags',
      'Beans',
      'Flour',
      'Rice',
      'Tea box',
    ]);
    const byName = new Map(c.things.items.map((x) => [x.name, x]));
    expect(byName.get('Tea box')?.isContainer).toBe(true); // by type (box_bin)
    expect(byName.get('Bag of bags')?.isContainer).toBe(true); // by what it holds
    expect(byName.get('Rice')?.isContainer).toBe(false);
    expect(byName.get('Beans')?.derivedState).toEqual(['ended']);
    expect(byName.get('Rice')?.path).toEqual([
      { id: room, name: 'Pantry', kind: 'place', isUnplaced: false, shortCode: null },
    ]);
  });

  it('filters by q, type and state, and pages with a cursor', async () => {
    expect((await contents(max, '?q=shelf')).places.map((p) => p.name)).toEqual([
      'Bottom shelf',
      'Top shelf',
    ]);
    expect((await contents(max, '?q=ric')).things.items.map((x) => x.name)).toEqual(['Rice']);
    expect((await contents(max, '?state=ended')).things.items.map((x) => x.name)).toEqual([
      'Beans',
    ]);
    const [box_bin] = await own<{ id: string }>(
      `SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'box_bin'`,
    );
    expect((await contents(max, `?type=${box_bin?.id}`)).things.items.map((x) => x.name)).toEqual([
      'Tea box',
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Contents = await contents(
        max,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.things.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.things.items.map((x) => x.name));
      cursor = page.things.next_cursor;
    } while (cursor);
    expect(seen).toEqual(['Bag of bags', 'Beans', 'Flour', 'Rice', 'Tea box']);
  });

  it('sorts by last seen and groups by type, and pages the same way', async () => {
    await own(
      `UPDATE public.things SET last_seen_at = now() - (CASE name WHEN 'Rice' THEN 1
                                                              WHEN 'Flour' THEN 2 ELSE 3 END)
                                                        * interval '1 day'
        WHERE place_id = $1`,
      [room],
    );
    const all = await contents(max, '?sort=lastSeen');
    expect(all.things.items.slice(0, 2).map((x) => x.name)).toEqual(['Rice', 'Flour']);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Contents = await contents(
        max,
        `?sort=lastSeen&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      seen.push(...page.things.items.map((x) => x.name));
      cursor = page.things.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.things.items.map((x) => x.name));

    const grouped = await contents(max, '?group=type&limit=1');
    expect(grouped.things.items[0]?.type?.builtinKey).toBe('box_bin');
  });

  it('turns the sort around with dir (D211), and pages the same way', async () => {
    const walk = async (qs: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Contents = await contents(
          max,
          `?${qs}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...page.things.items.map((x) => x.name ?? ''));
        cursor = page.things.next_cursor;
      } while (cursor);
      return seen;
    };
    const aToZ = await walk('sort=name');
    expect(await walk('sort=name&dir=desc')).toEqual([...aToZ].reverse());
    expect(await walk('sort=name&dir=asc')).toEqual(aToZ);
    const newest = await walk('sort=lastSeen');
    const oldest = await walk('sort=lastSeen&dir=asc');
    expect(oldest.slice(-2)).toEqual(['Flour', 'Rice']);
    expect(oldest).toEqual(expect.arrayContaining(newest));
    const bad = await api(max, 'GET', `/api/v1/places/${room}/contents?dir=sideways`);
    expect(bad.statusCode).toBe(400);
  });

  it('takes several types, brands and owners, and "is none of" each (D205)', async () => {
    const larder = await place(home, 'Larder');
    const [bosch, makita] = await own<{ id: string }>(
      `INSERT INTO public.brands (owner_account_id, name)
       VALUES ($1, 'Bosch'), ($1, 'Makita') RETURNING id`,
      [home.accountId],
    );
    const [ibrahim, bruce] = await own<{ id: string }>(
      `INSERT INTO public.people (owner_account_id, display_name)
       VALUES ($1, 'Ibrahim'), ($1, 'Bruce') RETURNING id`,
      [home.accountId],
    );
    const drill = await thing(home, 'Drill', { placeId: larder }, { typeKey: 'box_bin' });
    const saw = await thing(home, 'Saw', { placeId: larder }, { typeKey: 'cable' });
    const lamp = await thing(home, 'Lamp', { placeId: larder });
    await thing(home, 'Jar', { placeId: larder }, { typeKey: 'box_bin' });
    await own('UPDATE public.things SET brand_id = $2, belongs_to_person_id = $3 WHERE id = $1', [
      drill,
      bosch?.id,
      ibrahim?.id,
    ]);
    await own('UPDATE public.things SET brand_id = $2 WHERE id = $1', [saw, makita?.id]);
    await own('UPDATE public.things SET belongs_to_person_id = $2 WHERE id = $1', [
      lamp,
      bruce?.id,
    ]);
    const [box_bin, cable] = await own<{ id: string }>(
      `SELECT id FROM public.types WHERE owner_account_id IS NULL
          AND builtin_key IN ('box_bin', 'cable') ORDER BY builtin_key`,
    );
    const by = async (qs: string) =>
      (await ok<Contents>(api(max, 'GET', `/api/v1/places/${larder}/contents?${qs}`))).things.items
        .map((x) => x.name)
        .sort();

    expect(await by(`brand=${bosch?.id}&brand=${makita?.id}`)).toEqual(['Drill', 'Saw']);
    expect(await by(`brand=${bosch?.id}&not=brand`)).toEqual(['Jar', 'Lamp', 'Saw']);
    expect(await by(`belongsTo=${ibrahim?.id}&belongsTo=${bruce?.id}`)).toEqual(['Drill', 'Lamp']);
    expect(await by(`belongsTo=${ibrahim?.id}&not=belongsTo`)).toEqual(['Jar', 'Lamp', 'Saw']);
    expect(await by(`type=${box_bin?.id}&type=${cable?.id}`)).toEqual(['Drill', 'Jar', 'Saw']);
    // None of a type: the untyped count.
    expect(await by(`type=${box_bin?.id}&not=type`)).toEqual(['Lamp', 'Saw']);
    expect(await by(`type=${box_bin?.id}&brand=${bosch?.id}&not=brand`)).toEqual(['Jar']);
    expect((await api(max, 'GET', `/api/v1/places/${larder}/contents?not=q`)).statusCode).toBe(400);
  });

  it('is a 404 for an outsider', async () => {
    expect((await api(bob, 'GET', `/api/v1/places/${room}/contents`)).statusCode).toBe(404);
  });
});

describe('PATCH /api/v1/places/:id', () => {
  // catalogue: PATCH /api/v1/places/:id
  it('renames with If-Match, audits it, and enqueues a reindex', async () => {
    const p = await place(home, 'Attic');
    const before = await view(max, p);
    const after = await ok<View>(
      api(max, 'PATCH', `/api/v1/places/${p}`, {
        ifMatch: before.rowVersion,
        body: { name: 'Loft', icon: 'lucide:house', sort: 4 },
      }),
    );
    expect(after).toMatchObject({ name: 'Loft', icon: 'lucide:house' });
    expect(after.rowVersion).toBeGreaterThan(before.rowVersion);
    const [event] = await auditEvents(home.id, 'place.update');
    expect(event?.diff).toMatchObject({
      name: { before: 'Attic', after: 'Loft' },
      icon: { before: null, after: 'lucide:house' },
      sort: { before: 0, after: 4 },
    });
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
  });

  it('needs If-Match (428), and a stale one is 412 with conflicts and who changed it', async () => {
    const p = await place(home, 'Porch');
    const v1 = await view(max, p);
    const missing = await api(max, 'PATCH', `/api/v1/places/${p}`, { body: { name: 'X' } });
    expect(missing.statusCode).toBe(428);
    await ok(
      api(ada, 'PATCH', `/api/v1/places/${p}`, { ifMatch: v1.rowVersion, body: { name: 'Stoop' } }),
    );
    const stale = await api(max, 'PATCH', `/api/v1/places/${p}`, {
      ifMatch: v1.rowVersion,
      body: { name: 'Veranda' },
    });
    expect(stale.statusCode).toBe(412);
    const [ada_] = await own<{ display_name: string }>(
      'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
      [ada.userId],
    );
    expect(stale.json()).toMatchObject({
      code: 'precondition_failed',
      conflicts: ['name'],
      row_version: expect.any(Number),
      changedBy: { displayName: ada_?.display_name },
    });
  });

  // catalogue: PATCH /api/v1/places/:id
  it('re-parents within the location (place.move), and to the top level with parentId null', async () => {
    const a = await place(home, 'Wing A');
    const b = await place(home, 'Wing B');
    const room = await place(home, 'Den', a);
    let v = await view(max, room);
    v = await ok<View>(
      api(max, 'PATCH', `/api/v1/places/${room}`, { ifMatch: v.rowVersion, body: { parentId: b } }),
    );
    expect(v.path.map((s) => s.name)).toEqual(['Wing B', 'Den']);
    const moves = await auditEvents(home.id, 'place.move');
    expect(moves.at(-1)?.diff).toMatchObject({ parent_id: { before: a, after: b } });
    expect(sent.some((j) => j.name === 'reindex')).toBe(true);
    v = await ok<View>(
      api(max, 'PATCH', `/api/v1/places/${room}`, {
        ifMatch: v.rowVersion,
        body: { parentId: null },
      }),
    );
    expect(v.parentId).toBeNull();
  });

  it('refuses loops, the Unplaced area, and parents elsewhere', async () => {
    const top = await place(home, 'Block');
    const mid = await place(home, 'Floor 1', top, 'floor');
    const topV = await view(max, top);
    const loop = await api(max, 'PATCH', `/api/v1/places/${top}`, {
      ifMatch: topV.rowVersion,
      body: { parentId: mid },
    });
    expect(loop.statusCode).toBe(409);
    expect(loop.json().hint).toMatch(/under itself/);
    const intoUnplaced = await api(max, 'PATCH', `/api/v1/places/${top}`, {
      ifMatch: topV.rowVersion,
      body: { parentId: home.unplacedId },
    });
    expect(intoUnplaced.statusCode).toBe(409);
    const u = await view(max, home.unplacedId);
    const moveUnplaced = await api(max, 'PATCH', `/api/v1/places/${home.unplacedId}`, {
      ifMatch: u.rowVersion,
      body: { parentId: top },
    });
    expect(moveUnplaced.statusCode).toBe(409);
    const bobsRoom = await place(bobs, 'Bob den');
    const elsewhere = await api(max, 'PATCH', `/api/v1/places/${top}`, {
      ifMatch: topV.rowVersion,
      body: { parentId: bobsRoom },
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('is 403 for a viewer and 404 for an outsider', async () => {
    const p = await place(home, 'Shed');
    const v = await view(max, p);
    const req = { ifMatch: v.rowVersion, body: { name: 'Hut' } };
    expect((await api(vic, 'PATCH', `/api/v1/places/${p}`, req)).statusCode).toBe(403);
    expect((await api(bob, 'PATCH', `/api/v1/places/${p}`, req)).statusCode).toBe(404);
  });
});

describe('place fields (D160): custom values from the place kind', () => {
  let kind: string;
  let alarmField: string;
  let pantry: string;

  beforeAll(async () => {
    kind = newId();
    await own(
      `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
       VALUES ($1, $2, 'store_room', 'Store room', 'lucide:warehouse')`,
      [kind, home.accountId],
    );
    alarmField = newId();
    await own(
      `INSERT INTO public.type_fields (id, owner_account_id, place_kind_id, key, label, kind, options,
                                       required, secret, sort)
       VALUES (gen_random_uuid(), $1, $2, 'paint_colour', 'Paint colour', 'text', NULL, false, false, 1),
              (gen_random_uuid(), $1, $2, 'width_cm', 'Width', 'number', NULL, false, false, 2),
              (gen_random_uuid(), $1, $2, 'filter', 'Filter size', 'select', '["S","M","L"]', false, false, 3),
              (gen_random_uuid(), $1, $2, 'value', 'Value', 'money', NULL, false, false, 4),
              ($3, $1, $2, 'alarm_code', 'Alarm code', 'text', NULL, false, true, 5)`,
      [home.accountId, kind, alarmField],
    );
    pantry = await place(home, 'Store', null, 'store_room');
  });

  it('resolves the fields from the location account’s kind', async () => {
    const v = await view(max, pantry);
    expect(v.fields.map((f) => f.key)).toEqual([
      'paint_colour',
      'width_cm',
      'filter',
      'value',
      'alarm_code',
    ]);
    expect(v.fields.find((f) => f.key === 'alarm_code')).toMatchObject({
      secret: true,
      label: 'Alarm code',
    });
  });

  // catalogue: PATCH /api/v1/places/:id
  it('validates custom per field, audits it per key, and classes money', async () => {
    let v = await view(max, pantry);
    v = await ok<View>(
      api(max, 'PATCH', `/api/v1/places/${pantry}`, {
        ifMatch: v.rowVersion,
        body: {
          custom: {
            paint_colour: 'Sage',
            width_cm: 240,
            filter: 'M',
            value: { amount: '1200.50', currency: 'EGP' },
          },
        },
      }),
    );
    expect(v.custom).toEqual({
      paint_colour: 'Sage',
      width_cm: 240,
      filter: 'M',
      // Stored and answered in canonical form.
      value: { amount: '1200.5', currency: 'EGP' },
    });
    const [event] = (await auditEvents(home.id, 'place.update')).slice(-1);
    expect(event?.diff).toMatchObject({
      'custom.paint_colour': { before: null, after: 'Sage', class: 'plain' },
      'custom.value': { after: { amount: '1200.5', currency: 'EGP' }, class: 'money' },
    });

    // A viewer (money hidden by default, D13) sees everything but the money field.
    const seenByViewer = await view(vic, pantry);
    expect(seenByViewer.custom).toEqual({ paint_colour: 'Sage', width_cm: 240, filter: 'M' });

    // null clears a key.
    v = await ok<View>(
      api(max, 'PATCH', `/api/v1/places/${pantry}`, {
        ifMatch: v.rowVersion,
        body: { custom: { paint_colour: null } },
      }),
    );
    expect(v.custom).not.toHaveProperty('paint_colour');
  });

  it('refuses wrong kinds, unknown keys and secret fields (400)', async () => {
    const v = await view(max, pantry);
    for (const custom of [
      { width_cm: 'wide' },
      { filter: 'XL' },
      { nonsense: 1 },
      { alarm_code: '1234' },
      { value: { amount: '12,5', currency: 'EGP' } },
    ]) {
      const res = await api(max, 'PATCH', `/api/v1/places/${pantry}`, {
        ifMatch: v.rowVersion,
        body: { custom },
      });
      expect(res.statusCode, JSON.stringify(custom)).toBe(400);
      expect(res.json().hint).toMatch(new RegExp(`body\\.custom\\.${Object.keys(custom)[0]}`));
    }
  });

  it('lists the secret fields without values, with who may reveal them', async () => {
    await own(
      `INSERT INTO public.secret_values (location_id, place_id, type_field_id, field_key, ciphertext,
                                         key_version, updated_by)
       VALUES ($1, $2, $3, 'alarm_code', '{"v":1}', 1, $4)`,
      [home.id, pantry, alarmField, ola.userId],
    );
    const byAdmin = await view(ada, pantry);
    expect(byAdmin.secrets).toEqual([
      { fieldKey: 'alarm_code', label: 'Alarm code', set: true, canReveal: true },
    ]);
    const byMember = await view(max, pantry);
    expect(byMember.secrets).toEqual([
      { fieldKey: 'alarm_code', label: 'Alarm code', set: true, canReveal: false },
    ]);
    expect(JSON.stringify(byAdmin)).not.toContain('"v":1');
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/places/:id/trash (D45, D160, D162)', () => {
  // catalogue: POST /api/v1/places/:id/trash
  it('trashes an empty place and audits it', async () => {
    const p = await place(home, 'Empty cupboard');
    const res = await ok<{ trashed: string[]; moved: string[]; trashBatchId: string }>(
      api(max, 'POST', `/api/v1/places/${p}/trash`, { body: {} }),
    );
    expect(res).toEqual({ trashed: [p], moved: [], trashBatchId: expect.any(String) });
    expect(await placeRow(p)).toMatchObject({ trash_batch_id: res.trashBatchId });
    expect((await placeRow(p))?.deleted_at).not.toBeNull();
    const [event] = (await auditEvents(home.id, 'place.trash')).slice(-1);
    expect(event).toMatchObject({ actor_id: max.userId });
  });

  it('asks for a contents choice first (409 with counts)', async () => {
    const p = await place(home, 'Full cupboard');
    await place(home, 'Inner shelf', p, 'zone');
    await thing(home, 'Plate', { placeId: p });
    await thing(home, 'Cup', { placeId: p });
    const res = await api(max, 'POST', `/api/v1/places/${p}/trash`, { body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'contents_choice_required',
      counts: { places: 1, things: 2 },
    });
    expect((await placeRow(p))?.deleted_at).toBeNull();
  });

  // catalogue: POST /api/v1/places/:id/restore
  it('trashes everything inside with it, in one batch, and restores the batch', async () => {
    const p = await place(home, 'Old wardrobe');
    const inner = await place(home, 'Drawer', p, 'zone');
    const shirt = await thing(home, 'Shirt', { placeId: p });
    const box = await thing(home, 'Sock box', { placeId: inner }, { typeKey: 'box_bin' });
    const sock = await thing(home, 'Sock', { containerId: box });
    const earlier = await thing(home, 'Trashed before', { placeId: p });
    await own(`UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1`, [
      earlier,
      newId(),
    ]);

    const res = await ok<{ trashed: string[]; trashBatchId: string }>(
      api(max, 'POST', `/api/v1/places/${p}/trash`, { body: { contents: 'trash' } }),
    );
    expect(new Set(res.trashed)).toEqual(new Set([p, inner, shirt, box, sock]));
    for (const id of [shirt, box, sock]) {
      expect((await thingRow(id))?.trash_batch_id).toBe(res.trashBatchId);
    }
    expect((await placeRow(inner))?.trash_batch_id).toBe(res.trashBatchId);
    const [trash] = (await auditEvents(home.id, 'place.trash')).slice(-1);
    expect(trash?.diff).toMatchObject({ contents: { after: 'trash' } });

    const restored = await ok<{ restored: string[]; hint?: string }>(
      api(max, 'POST', `/api/v1/places/${p}/restore`),
    );
    expect(new Set(restored.restored)).toEqual(new Set([p, inner, shirt, box, sock]));
    expect(restored.hint).toBeUndefined();
    for (const id of [shirt, box, sock]) expect((await thingRow(id))?.deleted_at).toBeNull();
    expect((await thingRow(earlier))?.deleted_at).not.toBeNull(); // its own batch stays
    expect((await view(max, p)).counts).toEqual({ places: 1, things: 1 });
    const [event] = (await auditEvents(home.id, 'place.restore')).slice(-1);
    expect(event).toMatchObject({ actor_id: max.userId });
  });

  it('moves the contents to the parent by default, then trashes only the place', async () => {
    const parent = await place(home, 'Basement');
    const p = await place(home, 'Corner', parent, 'zone');
    const child = await place(home, 'Crate stack', p, 'zone');
    const drill = await thing(home, 'Drill', { placeId: p });
    const res = await ok<{ trashed: string[]; moved: string[] }>(
      api(max, 'POST', `/api/v1/places/${p}/trash`, { body: { contents: 'move' } }),
    );
    expect(res.trashed).toEqual([p]);
    expect(new Set(res.moved)).toEqual(new Set([drill, child]));
    expect((await thingRow(drill))?.place_id).toBe(parent);
    expect((await placeRow(child))?.parent_id).toBe(parent);
    expect(sent.some((j) => j.name === 'reindex')).toBe(true);
  });

  it('at the top level, things go to Unplaced and places to the top level', async () => {
    const p = await place(home, 'Tent');
    const child = await place(home, 'Pocket', p, 'zone');
    const torch = await thing(home, 'Torch', { placeId: p });
    await ok(api(max, 'POST', `/api/v1/places/${p}/trash`, { body: { contents: 'move' } }));
    expect((await thingRow(torch))?.place_id).toBe(home.unplacedId);
    expect((await placeRow(child))?.parent_id).toBeNull();

    // The web sends the Unplaced area as the chosen place at the top level: the same outcome.
    const q = await place(home, 'Tent 2');
    const child2 = await place(home, 'Pocket 2', q, 'zone');
    const torch2 = await thing(home, 'Torch 2', { placeId: q });
    await ok(
      api(max, 'POST', `/api/v1/places/${q}/trash`, {
        body: { contents: 'move', moveTo: { placeId: home.unplacedId } },
      }),
    );
    expect((await thingRow(torch2))?.place_id).toBe(home.unplacedId);
    expect((await placeRow(child2))?.parent_id).toBeNull();
  });

  it('moves to a chosen place or container, never into what is being trashed', async () => {
    const p = await place(home, 'Van');
    const inner = await place(home, 'Glovebox', p, 'zone');
    const map = await thing(home, 'Map', { placeId: p });
    const inside = await api(max, 'POST', `/api/v1/places/${p}/trash`, {
      body: { contents: 'move', moveTo: { placeId: inner } },
    });
    expect(inside.statusCode).toBe(409);

    const garage = await place(home, 'Big garage');
    await ok(
      api(max, 'POST', `/api/v1/places/${p}/trash`, {
        body: { contents: 'move', moveTo: { placeId: garage } },
      }),
    );
    expect((await thingRow(map))?.place_id).toBe(garage);
    expect((await placeRow(inner))?.parent_id).toBe(garage);

    const q = await place(home, 'Car');
    const cable = await thing(home, 'Jump cable', { placeId: q });
    const crate = await thing(home, 'Crate', { placeId: garage }, { typeKey: 'box_bin' });
    await ok(
      api(max, 'POST', `/api/v1/places/${q}/trash`, {
        body: { contents: 'move', moveTo: { containerId: crate } },
      }),
    );
    expect(await thingRow(cable)).toMatchObject({ place_id: null, container_id: crate });
  });

  it('refuses the Unplaced area (409), viewers (403) and outsiders (404)', async () => {
    const p = await place(home, 'Hook');
    expect(
      (await api(max, 'POST', `/api/v1/places/${home.unplacedId}/trash`, { body: {} })).statusCode,
    ).toBe(409);
    expect((await api(vic, 'POST', `/api/v1/places/${p}/trash`, { body: {} })).statusCode).toBe(
      403,
    );
    expect((await api(bob, 'POST', `/api/v1/places/${p}/trash`, { body: {} })).statusCode).toBe(
      404,
    );
  });
});

describe('POST /api/v1/places/:id/restore', () => {
  // catalogue: POST /api/v1/places/:id/restore
  it('re-homes what comes back under something still in the trash, with a hint', async () => {
    const outer = await place(home, 'Loft room');
    const inner = await place(home, 'Loft box area', outer, 'zone');
    const lamp = await thing(home, 'Loft lamp', { placeId: inner });
    // The inner place is trashed on its own, with its lamp; then the outer place.
    const first = await ok<{ trashBatchId: string }>(
      api(max, 'POST', `/api/v1/places/${inner}/trash`, { body: { contents: 'trash' } }),
    );
    await ok(api(max, 'POST', `/api/v1/places/${outer}/trash`, { body: {} }));
    expect((await thingRow(lamp))?.trash_batch_id).toBe(first.trashBatchId);

    const res = await ok<{ restored: string[]; hint?: string }>(
      api(max, 'POST', `/api/v1/places/${inner}/restore`),
    );
    expect(new Set(res.restored)).toEqual(new Set([inner, lamp]));
    expect(res.hint).toMatch(/top level/);
    expect((await placeRow(inner))?.parent_id).toBeNull();
    expect((await thingRow(lamp))?.place_id).toBe(inner);
    const [event] = (await auditEvents(home.id, 'place.restore')).slice(-1);
    expect(event?.diff).toMatchObject({ deleted_at: { after: null } });

    // A thing whose place is still in the trash goes to Unplaced.
    const shelf = await place(home, 'Wall shelf');
    const vase = await thing(home, 'Vase', { placeId: shelf });
    const batch = newId();
    await own(`UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1`, [
      vase,
      batch,
    ]);
    const holder = await place(home, 'Holder', null);
    await own(
      `UPDATE public.places SET deleted_at = now(), trash_batch_id = $2 WHERE id = ANY ($1::uuid[])`,
      [[holder], batch],
    );
    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [shelf]);
    const back = await ok<{ restored: string[]; hint?: string }>(
      api(max, 'POST', `/api/v1/places/${holder}/restore`),
    );
    expect(new Set(back.restored)).toEqual(new Set([holder, vase]));
    expect(back.hint).toMatch(/Unplaced/);
    expect((await thingRow(vase))?.place_id).toBe(home.unplacedId);
  });

  it('refuses a place that is not in the trash (409) and viewers (403)', async () => {
    const p = await place(home, 'Still here');
    expect((await api(max, 'POST', `/api/v1/places/${p}/restore`)).statusCode).toBe(409);
    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [p]);
    expect((await api(vic, 'POST', `/api/v1/places/${p}/restore`)).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/api/v1/places/${p}/restore`)).statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/places/:id (delete permanently)', () => {
  // catalogue: DELETE /api/v1/places/:id
  it('deletes a trashed place and what was trashed with it, for owners and admins, with tombstones', async () => {
    const p = await place(home, 'Doomed');
    const inner = await place(home, 'Doomed shelf', p, 'zone');
    const junk = await thing(home, 'Junk', { placeId: inner });
    const live = await api(ada, 'DELETE', `/api/v1/places/${p}`);
    expect(live.statusCode).toBe(409);
    await ok(api(max, 'POST', `/api/v1/places/${p}/trash`, { body: { contents: 'trash' } }));
    expect((await api(max, 'DELETE', `/api/v1/places/${p}`)).statusCode).toBe(403);
    expect((await api(vic, 'DELETE', `/api/v1/places/${p}`)).statusCode).toBe(403);
    expect((await api(bob, 'DELETE', `/api/v1/places/${p}`)).statusCode).toBe(404);

    await ok(api(ada, 'DELETE', `/api/v1/places/${p}`), 204);
    expect(await placeRow(p)).toBeUndefined();
    expect(await placeRow(inner)).toBeUndefined();
    expect(await thingRow(junk)).toBeUndefined();
    const tombs = await own<{ entity_type: string; entity_id: string }>(
      'SELECT entity_type, entity_id FROM public.sync_tombstones WHERE entity_id = ANY ($1::uuid[])',
      [[p, inner, junk]],
    );
    expect(new Set(tombs.map((x) => `${x.entity_type}:${x.entity_id}`))).toEqual(
      new Set([`place:${p}`, `place:${inner}`, `thing:${junk}`]),
    );
    const [event] = (await auditEvents(home.id, 'place.delete')).slice(-1);
    expect(event).toMatchObject({ actor_id: ada.userId });
    expect(event?.diff).toMatchObject({ name: { before: 'Doomed', after: null } });
  });
});

describe('POST /api/v1/places/:id/merge-into (D160)', () => {
  // catalogue: POST /api/v1/places/:id/merge-into
  it('merges a duplicate into another place, for owners and admins, with both versions', async () => {
    const dup = await place(home, 'Kitchen (dup)');
    const kitchen = await place(home, 'Kitchen');
    const spoon = await thing(home, 'Spoon', { placeId: dup });
    const cabinet = await place(home, 'Cabinet', dup, 'zone');
    const src = await view(ada, dup);
    const dst = await view(ada, kitchen);
    const url = `/api/v1/places/${dup}/merge-into`;
    const body = { targetId: kitchen, sourceRowVersion: src.rowVersion };

    expect((await api(max, 'POST', url, { ifMatch: dst.rowVersion, body })).statusCode).toBe(403);
    expect((await api(ada, 'POST', url, { body })).statusCode).toBe(428);
    expect((await api(ada, 'POST', url, { ifMatch: dst.rowVersion + 5, body })).statusCode).toBe(
      412,
    );
    const staleSource = await api(ada, 'POST', url, {
      ifMatch: dst.rowVersion,
      body: { ...body, sourceRowVersion: src.rowVersion + 5 },
    });
    expect(staleSource.statusCode).toBe(412);
    expect(staleSource.json().conflicts).toEqual(['sourceRowVersion']);

    const merged = await ok<View>(api(ada, 'POST', url, { ifMatch: dst.rowVersion, body }));
    expect(merged.id).toBe(kitchen);
    expect(merged.counts).toEqual({ places: 1, things: 1 });
    expect((await thingRow(spoon))?.place_id).toBe(kitchen);
    expect((await placeRow(cabinet))?.parent_id).toBe(kitchen);
    expect(await placeRow(dup)).toBeUndefined();
    const [event] = (await auditEvents(home.id, 'place.merge')).slice(-1);
    expect(event?.diff).toMatchObject({ merged_into: { after: kitchen } });
    expect(sent.some((j) => j.name === 'reindex')).toBe(true);
  });

  it('refuses a target elsewhere (404) and one inside the source (409)', async () => {
    const a = await place(home, 'Merge A');
    const aChild = await place(home, 'Merge A child', a, 'zone');
    const src = await view(ola, a);
    const child = await view(ola, aChild);
    const loop = await api(ola, 'POST', `/api/v1/places/${a}/merge-into`, {
      ifMatch: child.rowVersion,
      body: { targetId: aChild, sourceRowVersion: src.rowVersion },
    });
    expect(loop.statusCode).toBe(409);
    const bobsRoom = await place(bobs, 'Bob attic');
    const elsewhere = await api(ola, 'POST', `/api/v1/places/${a}/merge-into`, {
      ifMatch: 1,
      body: { targetId: bobsRoom, sourceRowVersion: src.rowVersion },
    });
    expect(elsewhere.statusCode).toBe(404);
  });
});

describe('POST /api/v1/places/:id/convert-to-container (Q14: the same id, both ways)', () => {
  // catalogue: POST /api/v1/places/:id/convert-to-container
  it('turns a place into a box thing and back, keeping its id, code and contents', async () => {
    const parent = await place(home, 'Workshop');
    const p = await place(home, 'Parts bin', parent, 'zone');
    const screw = await thing(home, 'Screws', { placeId: p });
    const { code } = await ok<{ code: string }>(api(max, 'POST', `/api/v1/places/${p}/label`));

    const res = await ok<{ thingId: string }>(
      api(max, 'POST', `/api/v1/places/${p}/convert-to-container`, { body: {} }),
    );
    expect(res).toEqual({ thingId: p });
    expect((await api(max, 'GET', `/api/v1/places/${p}`)).statusCode).toBe(404);
    expect(await thingRow(p)).toMatchObject({ place_id: parent, container_id: null });
    expect(await thingRow(screw)).toMatchObject({ place_id: null, container_id: p });
    const [codeRow] = await own<{ thing_id: string | null }>(
      'SELECT thing_id FROM public.short_ids WHERE code = $1',
      [code],
    );
    expect(codeRow?.thing_id).toBe(p);
    const [event] = (await auditEvents(home.id, 'place.convert_to_container')).slice(-1);
    expect(event?.diff).toMatchObject({ entity_type: { before: 'place', after: 'thing' } });

    // And back (T14's route calls the same definer): the place returns under the same id.
    await withScope(db.pools.app, { userId: max.userId, mfa: false }, async (_tx, c) => {
      await c.query('SELECT kept.convert_container_to_place($1, NULL)', [p]);
    });
    const back = await view(max, p);
    expect(back).toMatchObject({ id: p, parentId: parent, shortCode: code, name: 'Parts bin' });
    expect(back.counts.things).toBe(1);
  });

  it('refuses a place with places inside (409), the Unplaced area (409), and viewers (403)', async () => {
    const p = await place(home, 'Closet');
    await place(home, 'Closet shelf', p, 'zone');
    const nested = await api(max, 'POST', `/api/v1/places/${p}/convert-to-container`, {
      body: {},
    });
    expect(nested.statusCode).toBe(409);
    expect(nested.json().hint).toMatch(/places inside/);
    expect(
      (
        await api(max, 'POST', `/api/v1/places/${home.unplacedId}/convert-to-container`, {
          body: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api(vic, 'POST', `/api/v1/places/${p}/convert-to-container`, { body: {} })).statusCode,
    ).toBe(403);
  });
});

describe('POST /api/v1/places/:id/label (labels module)', () => {
  // catalogue: POST /api/v1/places/:id/label
  it('allocates a primary short ID once, and audits the allocation', async () => {
    const p = await place(home, 'Labelled shelf');
    const first = await ok<{ code: string }>(api(max, 'POST', `/api/v1/places/${p}/label`));
    expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    const again = await ok<{ code: string }>(api(max, 'POST', `/api/v1/places/${p}/label`));
    expect(again.code).toBe(first.code);
    const labels = (await auditEvents(home.id, 'place.label')).filter(
      (e) => (e.diff as { short_code?: { after?: string } }).short_code?.after === first.code,
    );
    expect(labels).toHaveLength(1);
    expect((await view(vic, p)).shortCode).toBe(first.code);
  });

  it('is 403 for a viewer, 404 for an outsider, and 409 module_off with labels off', async () => {
    const p = await place(home, 'Unlabelled');
    expect((await api(vic, 'POST', `/api/v1/places/${p}/label`)).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/api/v1/places/${p}/label`)).statusCode).toBe(404);
    const plain = await createLocation(ola, 'No labels');
    await own(
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'labels', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
      [plain.id],
    );
    const q = await place(plain, 'Somewhere');
    const off = await api(ola, 'POST', `/api/v1/places/${q}/label`);
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('module_off');
  });

  it('steps over a code another tenant holds, without seeing it', async () => {
    const taken = 'TAKEN1';
    const bobsRoom = await place(bobs, 'Bob labelled');
    await own('INSERT INTO public.short_ids (code, location_id, place_id) VALUES ($1, $2, $3)', [
      taken,
      bobs.id,
      bobsRoom,
    ]);
    const p = await place(home, 'Collision shelf');
    const codes = [taken, 'FRESH2'];
    const code = await withScope(db.pools.app, { userId: max.userId, mfa: false }, (_tx, c) =>
      allocateShortId(c, home.id, { placeId: p }, () => codes.shift() as string),
    );
    expect(code).toBe('FRESH2');
    const [row] = await own<{ place_id: string }>(
      'SELECT place_id FROM public.short_ids WHERE code = $1',
      [taken],
    );
    expect(row?.place_id).toBe(bobsRoom);
  });
});

describe('the location carries its owner account (T25 decision 1)', () => {
  it('answers ownerAccountId and moneyVisibleToViewers on GET /api/v1/locations/:id', async () => {
    const loc = await ok<{ ownerAccountId: string; moneyVisibleToViewers: boolean }>(
      api(max, 'GET', `/api/v1/locations/${home.id}`),
    );
    expect(loc.ownerAccountId).toBe(home.accountId);
    expect(loc.moneyVisibleToViewers).toBe(false);
  });
});

describe('row-level security and roles across every place route', () => {
  it("answers 404 for another household's place on every route, and 403 to a viewer's writes", async () => {
    const theirs = await place(bobs, 'Bob private room');
    const mine = await place(home, 'Viewer-proof room');
    const target = await place(home, 'Viewer-proof target');
    const routes: [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, req: Req][] = [
      ['GET', '', {}],
      ['GET', '/contents', {}],
      ['PATCH', '', { ifMatch: 1, body: { name: 'Mine now' } }],
      ['POST', '/trash', { body: {} }],
      ['POST', '/restore', {}],
      ['POST', '/merge-into', { ifMatch: 1, body: { targetId: target, sourceRowVersion: 1 } }],
      ['POST', '/convert-to-container', { body: {} }],
      ['POST', '/label', {}],
      ['DELETE', '', {}],
    ];
    for (const [method, path, req] of routes) {
      const res = await api(max, method, `/api/v1/places/${theirs}${path}`, req);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    expect((await placeRow(theirs))?.deleted_at).toBeNull();

    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [target]);
    const trashed = await place(home, 'Viewer-proof trashed');
    await own('UPDATE public.places SET deleted_at = now() WHERE id = $1', [trashed]);
    const v = await view(vic, mine);
    const writes: [method: 'POST' | 'PATCH' | 'DELETE', path: string, req: Req, id?: string][] = [
      ['PATCH', '', { ifMatch: v.rowVersion, body: { name: 'Nope' } }],
      ['POST', '/trash', { body: {} }],
      ['POST', '/restore', {}, trashed],
      ['POST', '/merge-into', { ifMatch: 1, body: { targetId: target, sourceRowVersion: 1 } }],
      ['POST', '/convert-to-container', { body: {} }],
      ['POST', '/label', {}],
      ['DELETE', '', {}, trashed],
    ];
    for (const [method, path, req, id] of writes) {
      const res = await api(vic, method, `/api/v1/places/${id ?? mine}${path}`, req);
      expect(res.statusCode, `${method} ${path}`).toBe(403);
    }
    expect((await view(max, mine)).name).toBe('Viewer-proof room');
  });

  it('shows a viewer money in place fields only when the location allows it (D13)', async () => {
    const kindId = newId();
    await own(
      `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
       VALUES ($1, $2, 'vault_room', 'Vault room', 'lucide:vault')`,
      [kindId, home.accountId],
    );
    await own(
      `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind)
       VALUES ($1, $2, 'insured_for', 'Insured for', 'money')`,
      [home.accountId, kindId],
    );
    const p = await place(home, 'Vault', null, 'vault_room');
    await own(
      `UPDATE public.places SET custom = '{"insured_for":{"amount":"5000","currency":"EGP"}}'
        WHERE id = $1`,
      [p],
    );
    expect((await view(vic, p)).custom).toEqual({});
    expect((await view(max, p)).custom).toEqual({
      insured_for: { amount: '5000', currency: 'EGP' },
    });
    await own('UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      expect((await view(vic, p)).custom).toEqual({
        insured_for: { amount: '5000', currency: 'EGP' },
      });
    } finally {
      await own('UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });
});

describe('route security review (step 2): places', () => {
  it("refuses a place with a thing's id, anywhere, like any taken id (404, #35)", async () => {
    const mine = await thing(home, 'Id holder');
    const theirs = await thing(bobs, 'Bob id holder');
    for (const id of [mine, theirs]) {
      const res = await api(max, 'POST', `/api/v1/locations/${home.id}/places`, {
        body: { id, name: 'Squatter', kindKey: 'room' },
      });
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(await placeRow(mine)).toBeUndefined();
  });

  // catalogue: POST /api/v1/places/:id/convert-to-container
  it('takes an optional If-Match on convert-to-container: a stale one is 412', async () => {
    const p = await place(home, 'Tote shelf');
    const v = await view(max, p);
    const url = `/api/v1/places/${p}/convert-to-container`;
    const stale = await api(max, 'POST', url, { ifMatch: v.rowVersion + 5, body: {} });
    expect(stale.statusCode, stale.body).toBe(412);
    expect(await placeRow(p)).toBeDefined();
    await ok(api(max, 'POST', url, { ifMatch: v.rowVersion, body: {} }));
    expect(await thingRow(p)).toBeDefined();
    const [event] = (await auditEvents(home.id, 'place.convert_to_container')).slice(-1);
    expect(event?.diff).toMatchObject({ entity_type: { before: 'place', after: 'thing' } });
  });

  // catalogue: DELETE /api/v1/places/:id
  it('names the things a permanent delete removes as subjects of its audit row', async () => {
    const p = await place(home, 'Condemned');
    const a = await thing(home, 'Condemned chair', { placeId: p });
    const box = await thing(home, 'Condemned box', { placeId: p });
    const inBox = await thing(home, 'Condemned toy', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/places/${p}/trash`, { body: { contents: 'trash' } }));
    await ok(api(ada, 'DELETE', `/api/v1/places/${p}`), 204);
    const [event] = await own<{ id: string; diff: Record<string, unknown> }>(
      `SELECT id, diff FROM public.audit_events
        WHERE location_id = $1 AND action = 'place.delete' AND entity_id = $2`,
      [home.id, p],
    );
    expect(event?.diff).toMatchObject({ name: { before: 'Condemned', after: null } });
    const subjects = await own<{ thing_id: string }>(
      'SELECT thing_id FROM public.audit_event_subjects WHERE event_id = $1',
      [event?.id],
    );
    expect(new Set(subjects.map((s) => s.thing_id))).toEqual(new Set([a, box, inBox]));
  });

  it("names only a person in a 412's changedBy, never another actor that shares an id", async () => {
    const p = await place(home, 'Pantry corner');
    const v = await view(max, p);
    // A non-user actor whose id happens to equal a user's (a token, an import) must not be
    // reported as that user.
    await own(
      `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id,
                                        action, entity_type, entity_id, diff)
       VALUES ($1, $2, 'token', $3, 'place.update', 'place', $4, '{}')`,
      [home.id, home.accountId, max.userId, p],
    );
    const stale = await api(ada, 'PATCH', `/api/v1/places/${p}`, {
      ifMatch: v.rowVersion + 1,
      body: { name: 'Pantry nook' },
    });
    expect(stale.statusCode, stale.body).toBe(412);
    expect(stale.json().changedBy ?? null).toBeNull();
  });
});
