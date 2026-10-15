import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, eventsOf, type Loc, own } from '../../test/things.js';
import { withScope } from '../db/scope.js';

// The location map (1.x, D237) through the front door: GET /api/v1/locations/:id/map and
// PUT /api/v1/locations/:id/layout as the web calls them, its undo, and map_nodes' row-level
// security. Fixtures are seeded as kept_owner; every read and write goes through the app as a
// signed-in user on kept_app.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ola: Person; // owner
let max: Person; // member
let vic: Person; // viewer
let bob: Person; // outsider
let home: Loc;
let bobs: Loc;

type Ids = {
  ground: string;
  first: string;
  living: string;
  bedroom: string;
  garage: string;
  shelf: string;
  box: string;
  batteries: string;
  tv: string;
  drill: string;
};
let ids: Ids;

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  own<T>(db, text, values);

async function placeOf(loc: Loc, name: string, parentId: string | null, kind = 'room') {
  const id = newId();
  await sql(
    'INSERT INTO public.places (id, location_id, parent_id, name, kind_key) VALUES ($1, $2, $3, $4, $5)',
    [id, loc.id, parentId, name, kind],
  );
  return id;
}

async function thingOf(
  loc: Loc,
  name: string,
  where: { placeId?: string; containerId?: string },
  typeKey: string | null = null,
  quantity = 1,
) {
  const id = newId();
  await sql(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name, quantity, type_id)
     VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $7))`,
    [id, loc.id, where.placeId ?? null, where.containerId ?? null, name, quantity, typeKey],
  );
  return id;
}

const getMap = (as: Person, loc: Loc = home) => call(t, `/api/v1/locations/${loc.id}/map`, { as });

const putLayout = (as: Person, body: unknown, loc: Loc = home) =>
  call(t, `/api/v1/locations/${loc.id}/layout`, { as, method: 'PUT', body });

type MapJson = {
  canArrange: boolean;
  version: string | null;
  levels: { id: string | null; name: string | null }[];
  rooms: { id: string; name: string; levelId: string | null; layout: unknown }[];
  nodes: {
    id: string;
    subject: string;
    name: string;
    roomId: string;
    parentId: string;
    isContainer: boolean;
    typeKey: string | null;
    layout: {
      x: number;
      z: number;
      rot: number;
      model: string | null;
      hostId: string | null;
    } | null;
  }[];
  things: {
    id: string;
    name: string;
    parentId: string;
    quantity: number;
    typeKey: string | null;
    typeName: string | null;
    isContainer: boolean;
  }[];
  more: number;
  attention: { subjectId: string; kind: string; person: string | null; min: number | null }[];
};

async function json<T>(res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
}

/** A complete layout for the seeded home: every room side by side, the shelf and the box. */
const fullLayout = (version: string | null) => ({
  version,
  rooms: [
    { id: ids.living, x: 0, z: 0, w: 600, d: 500, kind: 'room', surface: 'wood' },
    { id: ids.garage, x: 700, z: 0, w: 700, d: 600, kind: 'room', surface: 'concrete' },
    { id: ids.bedroom, x: 0, z: 0, w: 400, d: 500, kind: 'balcony', surface: 'deck' },
  ],
  nodes: [
    { id: ids.shelf, x: 15, z: 15, rot: 0, model: 'metal_shelf', hostId: null },
    { id: ids.box, x: 200, z: 300, rot: 90, model: 'box', hostId: null },
    { id: ids.tv, x: 210, z: 310, rot: 0, model: 'laptop', hostId: ids.box },
  ],
});

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ola = await person(t, db, 'ola');
  max = await person(t, db, 'max');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  home = await createLocation(t, db, ola, 'complete');
  bobs = await createLocation(t, db, bob, 'complete', 'Bob home');
  await join(db, home.id, max.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');

  const ground = await placeOf(home, 'Ground floor', null, 'floor');
  const first = await placeOf(home, 'First floor', null, 'floor');
  await sql('UPDATE public.places SET sort = 1 WHERE id = $1', [first]);
  const living = await placeOf(home, 'Living room', ground);
  const bedroom = await placeOf(home, 'Bedroom', first);
  // A room on no floor: the map gives such rooms a level of their own.
  const garage = await placeOf(home, 'Garage', null);
  const shelf = await placeOf(home, 'Shelf A', living, 'zone');
  const box = await thingOf(home, 'Games box', { placeId: living }, 'box_bin');
  const batteries = await thingOf(home, 'AA batteries', { containerId: box }, 'batteries', 2);
  const tv = await thingOf(home, 'Samsung TV', { placeId: living }, 'tv_display');
  const drill = await thingOf(home, 'Bosch drill', { placeId: shelf }, 'power_tool');
  await thingOf(home, 'Car papers', { placeId: home.unplacedId });
  ids = { ground, first, living, bedroom, garage, shelf, box, batteries, tv, drill };

  // Low stock and a loan, for the pins.
  await sql(
    `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
     VALUES ($1, $2, 6, $3)`,
    [batteries, home.id, ola.userId],
  );
  const bruce = newId();
  await sql(
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Bruce')`,
    [bruce, home.accountId],
  );
  await sql(
    `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, 'out', $3, now(), current_date + 7, $4)`,
    [home.id, drill, bruce, ola.userId],
  );
});

beforeEach(async () => {
  sent.splice(0);
  await sql('DELETE FROM public.map_nodes WHERE location_id = $1', [home.id]);
});

describe('GET /api/v1/locations/:id/map', () => {
  it('draws floors, rooms, the places and containers in them, and every thing', async () => {
    const map = await json<MapJson>(getMap(vic));
    expect(map.canArrange).toBe(false);
    expect(map.version).toBeNull();
    // The rooms on no floor first, then the floors in the tree's order.
    expect(map.levels).toEqual([
      { id: null, name: null },
      { id: ids.ground, name: 'Ground floor' },
      { id: ids.first, name: 'First floor' },
    ]);
    const rooms = new Map(map.rooms.map((r) => [r.id, r]));
    expect(rooms.get(ids.living)).toMatchObject({ levelId: ids.ground, layout: null });
    expect(rooms.get(ids.bedroom)).toMatchObject({ levelId: ids.first });
    expect(rooms.get(ids.garage)).toMatchObject({ levelId: null });
    expect(rooms.has(home.unplacedId)).toBe(false);
    expect(rooms.has(ids.ground)).toBe(false);

    const nodes = new Map(map.nodes.map((n) => [n.id, n]));
    expect(nodes.get(ids.shelf)).toMatchObject({ subject: 'place', roomId: ids.living });
    expect(nodes.get(ids.box)).toMatchObject({
      subject: 'thing',
      roomId: ids.living,
      parentId: ids.living,
      isContainer: true,
      typeKey: 'box_bin',
      layout: null,
    });
    // A plain thing isn't drawn until someone puts it on the map.
    expect(nodes.has(ids.tv)).toBe(false);

    const things = new Map(map.things.map((x) => [x.id, x]));
    expect(things.get(ids.batteries)).toMatchObject({ parentId: ids.box, quantity: 2 });
    expect(things.get(ids.drill)?.parentId).toBe(ids.shelf);
    expect(things.get(ids.tv)?.parentId).toBe(ids.living);
    // D249: what the shape picker ranks a thing's shapes from.
    expect(things.get(ids.tv)).toMatchObject({
      typeKey: 'tv_display',
      typeName: null,
      isContainer: false,
    });
    expect(things.get(ids.box)).toMatchObject({ typeKey: 'box_bin', isContainer: true });
    // The Unplaced area is on no map.
    expect(map.things.some((x) => x.name === 'Car papers')).toBe(false);
    expect(map.more).toBe(0);

    expect(map.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: ids.batteries, kind: 'low', min: 6 }),
        expect.objectContaining({ subjectId: ids.drill, kind: 'lent', person: 'Bruce' }),
      ]),
    );
  });

  it('names a custom type, so its things get a shape from it (D249)', async () => {
    const den = await placeOf(bobs, 'Den', null);
    const typeId = newId();
    await sql(
      `INSERT INTO public.types (id, owner_account_id, name, icon)
       VALUES ($1, $2, 'Fernseher', 'lucide:tv')`,
      [typeId, bobs.accountId],
    );
    const id = await thingOf(bobs, 'Wall screen', { placeId: den });
    await sql('UPDATE public.things SET type_id = $1 WHERE id = $2', [typeId, id]);
    const map = await json<MapJson>(getMap(bob, bobs));
    expect(map.things.find((x) => x.id === id)).toMatchObject({
      typeKey: null,
      typeName: 'Fernseher',
      isContainer: false,
    });
  });

  it('lets members arrange, and is not found outside the location', async () => {
    expect((await json<MapJson>(getMap(max))).canArrange).toBe(true);
    expect((await json<MapJson>(getMap(ola))).canArrange).toBe(true);
    expect((await getMap(bob)).statusCode).toBe(404);
  });
});

describe('PUT /api/v1/locations/:id/layout', () => {
  // catalogue: PUT /api/v1/locations/:id/layout
  it('stores a member’s arrangement, audited place.arrange, and the map reads it back', async () => {
    const res = await putLayout(max, fullLayout(null));
    expect(res.statusCode, res.body).toBe(200);
    const { version } = res.json() as { version: string };
    expect(version).toEqual(expect.any(String));
    expect(res.headers['x-kept-audit-event']).toBeTruthy();

    const events = (await eventsOf(db, home.id, home.id)).filter(
      (e) => e.action === 'place.arrange',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_id).toBe(max.userId);
    expect(events[0]?.undoable_until).toBeTruthy();
    const diff = events[0]?.diff.layout as { before: unknown[]; after: { id: string }[] };
    expect(diff.before).toEqual([]);
    expect(diff.after.map((r) => r.id).sort()).toEqual(
      [ids.living, ids.garage, ids.bedroom, ids.shelf, ids.box, ids.tv].sort(),
    );

    const map = await json<MapJson>(getMap(vic));
    expect(map.version).toBe(version);
    expect(map.rooms.find((r) => r.id === ids.bedroom)?.layout).toEqual({
      x: 0,
      z: 0,
      w: 400,
      d: 500,
      kind: 'balcony',
      surface: 'deck',
    });
    // The TV is on the map now, standing on the box.
    const tv = map.nodes.find((n) => n.id === ids.tv);
    expect(tv?.layout).toEqual({ x: 210, z: 310, rot: 0, model: 'laptop', hostId: ids.box });
    expect(map.nodes.find((n) => n.id === ids.box)?.layout?.rot).toBe(90);
  });

  it('refuses a viewer and an outsider', async () => {
    expect((await putLayout(vic, fullLayout(null))).statusCode).toBe(403);
    expect((await putLayout(bob, fullLayout(null))).statusCode).toBe(404);
  });

  it('refuses an arrangement made on an older map (409 arranged_since)', async () => {
    const first = (await json<{ version: string }>(putLayout(ola, fullLayout(null)))).version;
    const stale = await putLayout(max, fullLayout(null));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ reason: 'arranged_since' });
    expect((await putLayout(max, fullLayout(first))).statusCode).toBe(200);
  });

  it('lets rooms of different floors overlap, and refuses a room twice', async () => {
    // fullLayout() puts the bedroom (first floor) over the living room (ground floor).
    expect((await putLayout(ola, fullLayout(null))).statusCode).toBe(200);
    await sql('DELETE FROM public.map_nodes WHERE location_id = $1', [home.id]);
    const twice = fullLayout(null);
    twice.rooms.push({
      id: ids.garage,
      x: 2000,
      z: 0,
      w: 200,
      d: 200,
      kind: 'room',
      surface: 'wood',
    });
    expect((await putLayout(ola, twice)).statusCode).toBe(400);
  });

  it('refuses what isn’t a room or node of this location, an unknown model and a bad host', async () => {
    const base = fullLayout(null);
    const bobRoom = await placeOf(bobs, 'Bob room', null);
    const cases: unknown[] = [
      { ...base, rooms: [...base.rooms, { ...base.rooms[0], id: ids.shelf }] },
      { ...base, rooms: [...base.rooms, { ...base.rooms[0], id: bobRoom, x: 9000 }] },
      { ...base, rooms: [...base.rooms, { ...base.rooms[0], id: ids.ground, x: 9000 }] },
      { ...base, nodes: [...base.nodes, { ...base.nodes[0], id: ids.living }] },
      { ...base, nodes: [{ ...base.nodes[0], model: 'spaceship' }] },
      // Standing on something that isn't on the map, or that nothing stands on, or too big.
      { ...base, nodes: [{ ...base.nodes[2], hostId: ids.drill }] },
      { ...base, nodes: [base.nodes[0], { ...base.nodes[2], hostId: ids.shelf }] },
      {
        ...base,
        nodes: [base.nodes[1], { ...base.nodes[2], model: 'wardrobe', hostId: ids.box }],
      },
    ];
    for (const body of cases) {
      const res = await putLayout(ola, body);
      expect(res.statusCode, res.body).toBe(400);
    }
    const overlapping = {
      ...base,
      rooms: [base.rooms[0], { ...base.rooms[0], id: ids.garage, x: 100 }],
    };
    // The garage is on no floor and the living room on the ground floor: no overlap.
    expect((await putLayout(ola, overlapping)).statusCode).toBe(200);
  });

  it('refuses two rooms of one floor that overlap (409 rooms_overlap)', async () => {
    const study = await placeOf(home, 'Study', ids.ground);
    try {
      const body = fullLayout(null);
      body.rooms.push({ id: study, x: 500, z: 400, w: 300, d: 300, kind: 'room', surface: 'tile' });
      const res = await putLayout(ola, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'rooms_overlap' });
      body.rooms[3] = { ...body.rooms[3], x: 600 } as (typeof body.rooms)[number];
      expect((await putLayout(ola, body)).statusCode).toBe(200);
    } finally {
      await sql('DELETE FROM public.map_nodes WHERE place_id = $1', [study]);
      await sql('DELETE FROM public.places WHERE id = $1', [study]);
    }
  });
});

describe('undo of an arrange session', () => {
  it('puts the layout from before back, once, and not after someone arranged again', async () => {
    const r1 = await putLayout(ola, fullLayout(null));
    const v1 = (r1.json() as { version: string }).version;
    const firstEvent = String(r1.headers['x-kept-audit-event']);
    const moved = fullLayout(v1);
    moved.nodes[1] = { ...moved.nodes[1], x: 50 } as (typeof moved.nodes)[number];
    const res = await putLayout(max, moved);
    expect(res.statusCode).toBe(200);
    const eventId = String(res.headers['x-kept-audit-event']);

    const undo = await call(t, `/api/v1/audit/${eventId}/undo`, { as: max, body: {} });
    expect(undo.statusCode, undo.body).toBe(200);
    const map = await json<MapJson>(getMap(ola));
    expect(map.nodes.find((n) => n.id === ids.box)?.layout?.x).toBe(200);
    const events = (await eventsOf(db, home.id, home.id)).filter(
      (e) => e.action === 'place.arrange',
    );
    expect(events.at(-1)?.undo_of).toBe(eventId);
    const again = await call(t, `/api/v1/audit/${eventId}/undo`, { as: max, body: {} });
    expect(again.json()).toMatchObject({ reason: 'already_undone' });

    // Arranged again since the first session: its undo is refused.
    const other = fullLayout(map.version);
    other.nodes[0] = { ...other.nodes[0], x: 77 } as (typeof other.nodes)[number];
    expect((await putLayout(ola, other)).statusCode).toBe(200);
    const refused = await call(t, `/api/v1/audit/${firstEvent}/undo`, { as: ola, body: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'changed_since' });
  });
});

describe('map_nodes row-level security', () => {
  const asUser = <T>(userId: string, fn: Parameters<typeof withScope<T>>[2]) =>
    withScope(db.pools.app, { userId, mfa: true }, fn);

  it('lets members see and write their own location’s rows only', async () => {
    await json(putLayout(ola, fullLayout(null)));
    const seen = (userId: string) =>
      asUser(userId, async (_tx, c) => {
        const { rows } = await c.query('SELECT id FROM public.map_nodes WHERE location_id = $1', [
          home.id,
        ]);
        return rows.length;
      });
    expect(await seen(vic.userId)).toBe(6);
    expect(await seen(bob.userId)).toBe(0);

    // A viewer can't write, nor can anyone into a location they don't edit.
    const insert = (userId: string) =>
      asUser(userId, (_tx, c) =>
        c.query(
          `INSERT INTO public.map_nodes (location_id, place_id, x_cm, z_cm, w_cm, d_cm, created_by)
           VALUES ($1, $2, 0, 0, 100, 100, $3)`,
          [home.id, ids.garage, userId],
        ),
      );
    await expect(insert(vic.userId)).rejects.toThrow(/row-level security/);
    await expect(insert(bob.userId)).rejects.toThrow(/row-level security/);
    const del = (userId: string) =>
      asUser(userId, async (_tx, c) => {
        const r = await c.query('DELETE FROM public.map_nodes WHERE location_id = $1', [home.id]);
        return r.rowCount;
      });
    expect(await del(vic.userId)).toBe(0);
    expect(await del(bob.userId)).toBe(0);
    // Nobody updates a row: an arrange session replaces them.
    await expect(
      asUser(max.userId, (_tx, c) =>
        c.query('UPDATE public.map_nodes SET x_cm = 1 WHERE location_id = $1', [home.id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('goes with its place or thing', async () => {
    const gone = await thingOf(home, 'Old radio', { placeId: ids.living });
    await sql(
      `INSERT INTO public.map_nodes (location_id, thing_id, x_cm, z_cm, model) VALUES ($1, $2, 0, 0, 'item')`,
      [home.id, gone],
    );
    await sql('DELETE FROM public.things WHERE id = $1', [gone]);
    expect(await sql('SELECT 1 FROM public.map_nodes WHERE thing_id = $1', [gone])).toHaveLength(0);
  });
});
