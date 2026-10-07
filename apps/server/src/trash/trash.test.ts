import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 21 through the front door: trashing, restoring and deleting things, and the trash list,
// as the web calls them (apps/web/src/api/inventory/{types,paths}.ts, mock/trash.ts). Fixtures
// are seeded as kept_owner; every request goes through the app as a signed-in user on kept_app,
// so row-level security and can() decide (screens §5: restore for members and above, delete
// permanently for admins and above).

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];

type Loc = { id: string; unplacedId: string };

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function createLocation(as: Person, name = 'Home'): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: {
      name,
      kind: 'home',
      preset: 'complete',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  const [row] = await own<{ id: string }>(
    'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
    [id],
  );
  return { id, unplacedId: row?.id as string };
}

async function place(loc: Loc, name: string, parentId: string | null = null): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.places (id, location_id, parent_id, name, kind_key)
     VALUES ($1, $2, $3, $4, 'room')`,
    [id, loc.id, parentId, name],
  );
  return id;
}

async function thing(
  loc: Loc,
  name: string,
  where: { placeId?: string; containerId?: string } = {},
): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      loc.id,
      where.containerId ? null : (where.placeId ?? loc.unplacedId),
      where.containerId ?? null,
      name,
    ],
  );
  return id;
}

function api(
  as: Person,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return call(t, url, { as, method, ...(body !== undefined ? { body } : {}) });
}

async function ok<T = Record<string, unknown>>(
  res: Promise<LightMyRequestResponse>,
  status = 200,
): Promise<T> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return (status === 204 ? undefined : r.json()) as T;
}

type Row = {
  id: string;
  place_id: string | null;
  container_id: string | null;
  deleted_at: Date | null;
  trash_batch_id: string | null;
};
const thingRow = async (id: string): Promise<Row | undefined> =>
  (
    await own<Row>(
      'SELECT id, place_id, container_id, deleted_at, trash_batch_id FROM public.things WHERE id = $1',
      [id],
    )
  )[0];

type Event = {
  id: string;
  at: Date;
  action: string;
  actor_id: string | null;
  entity_id: string | null;
  root_thing_id: string | null;
  diff: Record<string, { before?: unknown; after?: unknown }>;
  undoable_until: Date | null;
  subjects: string[];
};

/** The newest event of `action` about `entityId`, with its subjects. */
async function lastEvent(action: string, entityId: string): Promise<Event | undefined> {
  const [row] = await own<Event>(
    `SELECT e.id, e.at, e.action, e.actor_id, e.entity_id, e.root_thing_id, e.diff,
            e.undoable_until,
            coalesce((SELECT array_agg(s.thing_id::text ORDER BY s.thing_id)
                        FROM public.audit_event_subjects s
                       WHERE s.event_id = e.id AND s.event_at = e.at), '{}') AS subjects
       FROM public.audit_events e
      WHERE e.action = $1 AND e.entity_id = $2
      ORDER BY e.at DESC, e.id DESC LIMIT 1`,
    [action, entityId],
  );
  return row;
}

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

describe('POST /api/v1/things/:id/trash', () => {
  // catalogue: POST /api/v1/things/:id/trash
  it('trashes a thing into a batch of its own and audits it as undoable', async () => {
    const lamp = await thing(home, 'Lamp');
    const res = await ok<{ trashed: string[]; moved: string[]; trashBatchId: string }>(
      api(max, 'POST', `/api/v1/things/${lamp}/trash`, {}),
    );
    expect(res).toEqual({ trashed: [lamp], moved: [], trashBatchId: expect.any(String) });
    const row = await thingRow(lamp);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.trash_batch_id).toBe(res.trashBatchId);

    const event = await lastEvent('thing.trash', lamp);
    expect(event).toMatchObject({ actor_id: max.userId, root_thing_id: lamp, subjects: [] });
    expect(event?.diff.trash_batch_id).toMatchObject({ before: null, after: res.trashBatchId });
    expect(event?.diff.deleted_at?.before).toBeNull();
    expect(event?.undoable_until).not.toBeNull();
  });

  it('asks for a contents choice first (409 with counts, D45)', async () => {
    const box = await thing(home, 'Box');
    await thing(home, 'Cable', { containerId: box });
    await thing(home, 'Plug', { containerId: box });
    const res = await api(max, 'POST', `/api/v1/things/${box}/trash`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'contents_choice_required',
      counts: { places: 0, things: 2 },
    });
    expect((await thingRow(box))?.deleted_at).toBeNull();
  });

  it('trashes everything inside with it, however deep, in one batch', async () => {
    const box = await thing(home, 'Box');
    const pouch = await thing(home, 'Pouch', { containerId: box });
    const coin = await thing(home, 'Coin', { containerId: pouch });
    const res = await ok<{ trashed: string[]; trashBatchId: string }>(
      api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'trash' }),
    );
    expect(new Set(res.trashed)).toEqual(new Set([box, pouch, coin]));
    for (const id of [pouch, coin]) {
      expect((await thingRow(id))?.trash_batch_id).toBe(res.trashBatchId);
    }
    expect((await lastEvent('thing.trash', box))?.subjects).toEqual([pouch, coin].sort());
  });

  it('moves the contents to where the container was, by default', async () => {
    const shelf = await place(home, 'Shelf');
    const box = await thing(home, 'Box', { placeId: shelf });
    const cable = await thing(home, 'Cable', { containerId: box });
    const res = await ok<{ moved: string[] }>(
      api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'move' }),
    );
    expect(res.moved).toEqual([cable]);
    expect(await thingRow(cable)).toMatchObject({
      place_id: shelf,
      container_id: null,
      deleted_at: null,
    });
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
    expect((await lastEvent('thing.trash', box))?.subjects).toEqual([cable]);
  });

  it('moves the contents to a chosen place or container, never into itself', async () => {
    const box = await thing(home, 'Box');
    const inner = await thing(home, 'Inner box', { containerId: box });
    const crate = await thing(home, 'Crate');
    const refused = await api(max, 'POST', `/api/v1/things/${box}/trash`, {
      contents: 'move',
      moveTo: { containerId: inner },
    });
    expect(refused.statusCode).toBe(409);
    await ok(
      api(max, 'POST', `/api/v1/things/${box}/trash`, {
        contents: 'move',
        moveTo: { containerId: crate },
      }),
    );
    expect(await thingRow(inner)).toMatchObject({ container_id: crate, place_id: null });

    const elsewhere = await place(bobs, 'Bob shelf');
    const box2 = await thing(home, 'Box 2');
    await thing(home, 'Thing in box 2', { containerId: box2 });
    const res = await api(max, 'POST', `/api/v1/things/${box2}/trash`, {
      contents: 'move',
      moveTo: { placeId: elsewhere },
    });
    expect(res.statusCode).toBe(404);
  });

  it('is 403 for a viewer and 404 for an outsider or a thing already in the trash', async () => {
    const lamp = await thing(home, 'Desk lamp');
    expect((await api(vic, 'POST', `/api/v1/things/${lamp}/trash`, {})).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/api/v1/things/${lamp}/trash`, {})).statusCode).toBe(404);
    await ok(api(ola, 'POST', `/api/v1/things/${lamp}/trash`, {}));
    expect((await api(ola, 'POST', `/api/v1/things/${lamp}/trash`, {})).statusCode).toBe(404);
  });

  it('writes the event things/undo.ts undoes: the batch comes back (D150)', async () => {
    const box = await thing(home, 'Undo box');
    const cable = await thing(home, 'Undo cable', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'trash' }));
    const event = await lastEvent('thing.trash', box);
    await ok(api(max, 'POST', `/api/v1/audit/${event?.id}/undo`, {}));
    for (const id of [box, cable]) expect((await thingRow(id))?.deleted_at).toBeNull();
  });
});

describe('POST /api/v1/things/:id/restore', () => {
  // catalogue: POST /api/v1/things/:id/restore
  it('restores the whole batch, and audits it', async () => {
    const box = await thing(home, 'Toolbox');
    const drill = await thing(home, 'Drill', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'trash' }));
    // Restoring the drill brings its whole batch back, the box included.
    const res = await ok<{ restored: string[]; hint?: string }>(
      api(max, 'POST', `/api/v1/things/${drill}/restore`),
    );
    expect(new Set(res.restored)).toEqual(new Set([box, drill]));
    expect(res.hint).toBeUndefined();
    expect(await thingRow(drill)).toMatchObject({
      deleted_at: null,
      trash_batch_id: null,
      container_id: box,
    });
    const event = await lastEvent('thing.restore', drill);
    expect(event).toMatchObject({ actor_id: max.userId, subjects: [box] });
  });

  it('sends it to Unplaced, with a hint, when its container is still in the trash', async () => {
    const box = await thing(home, 'Shoebox');
    const shoe = await thing(home, 'Shoe', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/things/${shoe}/trash`, {}));
    await ok(api(max, 'POST', `/api/v1/things/${box}/trash`, {}));
    const res = await ok<{ restored: string[]; hint?: string }>(
      api(max, 'POST', `/api/v1/things/${shoe}/restore`),
    );
    expect(res.restored).toEqual([shoe]);
    expect(res.hint).toMatch(/Unplaced/);
    expect(await thingRow(shoe)).toMatchObject({
      place_id: home.unplacedId,
      container_id: null,
      deleted_at: null,
    });
  });

  it("restores a place's batch through the place (D162)", async () => {
    const room = await place(home, 'Attic');
    const chair = await thing(home, 'Old chair', { placeId: room });
    await ok(api(max, 'POST', `/api/v1/places/${room}/trash`, { contents: 'trash' }));
    const res = await ok<{ restored: string[] }>(
      api(max, 'POST', `/api/v1/things/${chair}/restore`),
    );
    expect(new Set(res.restored)).toEqual(new Set([room, chair]));
    const [p] = await own<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM public.places WHERE id = $1',
      [room],
    );
    expect(p?.deleted_at).toBeNull();
    expect(await lastEvent('place.restore', room)).toMatchObject({ actor_id: max.userId });
  });

  it('is 409 for a live thing, 403 for a viewer and 404 for an outsider', async () => {
    const lamp = await thing(home, 'Floor lamp');
    expect((await api(max, 'POST', `/api/v1/things/${lamp}/restore`)).statusCode).toBe(409);
    await ok(api(max, 'POST', `/api/v1/things/${lamp}/trash`, {}));
    expect((await api(vic, 'POST', `/api/v1/things/${lamp}/restore`)).statusCode).toBe(403);
    expect((await api(bob, 'POST', `/api/v1/things/${lamp}/restore`)).statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/things/:id', () => {
  // catalogue: DELETE /api/v1/things/:id
  it('deletes a trashed thing for good, with what is inside it, leaving tombstones', async () => {
    const box = await thing(home, 'Junk box');
    const junk = await thing(home, 'Junk', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'trash' }));
    await ok(api(ada, 'DELETE', `/api/v1/things/${box}`), 204);
    for (const id of [box, junk]) {
      expect(await thingRow(id)).toBeUndefined();
      const tomb = await own(
        `SELECT 1 FROM public.sync_tombstones
          WHERE location_id = $1 AND entity_type = 'thing' AND entity_id = $2`,
        [home.id, id],
      );
      expect(tomb).toHaveLength(1);
    }
    // The audit row: thing.delete by the admin, the name it had.
    const audit = await lastEvent('thing.delete', box);
    expect(audit).toMatchObject({ actor_id: ada.userId });
    expect(audit?.diff.name).toMatchObject({ before: 'Junk box', after: null });
  });

  it('is for owners and admins only, and only for what is in the trash', async () => {
    const lamp = await thing(home, 'Bedside lamp');
    expect((await api(ola, 'DELETE', `/api/v1/things/${lamp}`)).statusCode).toBe(409);
    await ok(api(max, 'POST', `/api/v1/things/${lamp}/trash`, {}));
    expect((await api(max, 'DELETE', `/api/v1/things/${lamp}`)).statusCode).toBe(403);
    expect((await api(vic, 'DELETE', `/api/v1/things/${lamp}`)).statusCode).toBe(403);
    expect((await api(bob, 'DELETE', `/api/v1/things/${lamp}`)).statusCode).toBe(404);
    await ok(api(ola, 'DELETE', `/api/v1/things/${lamp}`), 204);
  });

  it('refuses while something inside is no longer in the trash', async () => {
    const box = await thing(home, 'Crate of books');
    await thing(home, 'Book', { containerId: box });
    await own(
      'UPDATE public.things SET deleted_at = now(), trash_batch_id = uuidv7() WHERE id = $1',
      [box],
    );
    expect((await api(ada, 'DELETE', `/api/v1/things/${box}`)).statusCode).toBe(409);
    expect(await thingRow(box)).toBeDefined();
  });
});

describe('GET /api/v1/trash', () => {
  type Item = {
    kind: string;
    id: string;
    locationId: string;
    name: string | null;
    path: { id: string; name: string; kind: string; isUnplaced: boolean }[];
    deletedAt: string;
    deletedBy: { id: string; displayName: string } | null;
    purgeAfter: string;
    batchSize: number;
  };
  type Page = { items: Item[]; next_cursor: string | null };

  it('lists trashed things and places of visible locations, newest first', async () => {
    const study = await place(home, 'Study');
    const shelf = await place(home, 'Study shelf', study);
    const vase = await thing(home, 'Vase', { placeId: shelf });
    await ok(api(max, 'POST', `/api/v1/things/${vase}/trash`, {}));
    await ok(api(ola, 'POST', `/api/v1/places/${shelf}/trash`, {}));
    const bobsThing = await thing(bobs, 'Bob mug');
    await ok(api(bob, 'POST', `/api/v1/things/${bobsThing}/trash`, {}));

    const [maxName] = await own<{ display_name: string }>(
      'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
      [max.userId],
    );
    for (const as of [ola, max, vic]) {
      const page = await ok<Page>(api(as, 'GET', '/api/v1/trash'));
      const ids = page.items.map((i) => i.id);
      expect(ids).not.toContain(bobsThing);
      expect(ids.indexOf(shelf)).toBeLessThan(ids.indexOf(vase));
      const item = page.items.find((i) => i.id === vase);
      expect(item).toMatchObject({
        kind: 'thing',
        locationId: home.id,
        name: 'Vase',
        deletedBy: { displayName: maxName?.display_name },
        batchSize: 1,
      });
      expect(item?.path.map((s) => s.name)).toEqual(['Study', 'Study shelf']);
      expect(Date.parse(item?.purgeAfter ?? '') - Date.parse(item?.deletedAt ?? '')).toBe(
        30 * 86_400_000,
      );
      expect(page.items.find((i) => i.id === shelf)).toMatchObject({
        kind: 'place',
        path: [{ id: study, name: 'Study', kind: 'place', isUnplaced: false }],
      });
    }
    const bobsPage = await ok<Page>(api(bob, 'GET', '/api/v1/trash'));
    expect(bobsPage.items.map((i) => i.id)).toContain(bobsThing);
    expect(bobsPage.items.every((i) => i.locationId === bobs.id)).toBe(true);
  });

  it('filters by location, kind and name, and counts the batch', async () => {
    const tent = await thing(home, 'Camping tent');
    const peg = await thing(home, 'Tent peg', { containerId: tent });
    await ok(api(max, 'POST', `/api/v1/things/${tent}/trash`, { contents: 'trash' }));

    const byName = await ok<Page>(api(max, 'GET', '/api/v1/trash?q=tent'));
    expect(new Set(byName.items.map((i) => i.id))).toEqual(new Set([tent, peg]));
    expect(byName.items.every((i) => i.batchSize === 2)).toBe(true);

    const places = await ok<Page>(
      api(max, 'GET', `/api/v1/trash?kind=place&locationId=${home.id}`),
    );
    expect(places.items.every((i) => i.kind === 'place')).toBe(true);
    expect((await api(max, 'GET', `/api/v1/trash?locationId=${bobs.id}`)).statusCode).toBe(404);
  });

  it('filters by who trashed it, "none of" a location, several kinds and a date range (D205)', async () => {
    const cabin = await createLocation(ola, 'Cabin');
    const lamp = await thing(home, 'Sieve lamp');
    const rug = await thing(home, 'Sieve rug');
    const chair = await thing(cabin, 'Sieve chair');
    const kettle = await thing(home, 'Sieve kettle');
    await ok(api(max, 'POST', `/api/v1/things/${lamp}/trash`, {}));
    await ok(api(ola, 'POST', `/api/v1/things/${rug}/trash`, {}));
    await ok(api(ola, 'POST', `/api/v1/things/${chair}/trash`, {}));
    // Trashed with no trash event (an import, say): nobody trashed it, so it is "none of" anyone.
    await own(
      `UPDATE public.things SET deleted_at = '2026-01-15T10:00:00Z', trash_batch_id = uuidv7()
        WHERE id = $1`,
      [kettle],
    );
    const by = async (qs: string) =>
      (await ok<Page>(api(ola, 'GET', `/api/v1/trash?q=sieve&${qs}`))).items
        .map((i) => i.name)
        .sort();

    const lampItem = (
      await ok<Page>(api(ola, 'GET', `/api/v1/trash?q=sieve&deletedById=${max.userId}`))
    ).items;
    expect(lampItem.map((i) => i.id)).toEqual([lamp]);
    expect(lampItem[0]?.deletedBy).toMatchObject({ id: max.userId });
    expect(await by(`deletedById=${max.userId}&deletedById=${ola.userId}`)).toEqual([
      'Sieve chair',
      'Sieve lamp',
      'Sieve rug',
    ]);
    expect(await by(`deletedById=${max.userId}&not=deletedById`)).toEqual([
      'Sieve chair',
      'Sieve kettle',
      'Sieve rug',
    ]);
    expect(await by(`locationId=${home.id}&not=locationId`)).toEqual(['Sieve chair']);
    expect(await by(`locationId=${home.id}&locationId=${cabin.id}`)).toHaveLength(4);
    expect(await by('kind=thing&kind=place')).toHaveLength(4);
    expect(await by('kind=place')).toEqual([]);
    expect(await by('from=2026-01-01&to=2026-02-01')).toEqual(['Sieve kettle']);
    expect(await by('from=2026-01-16')).toEqual(['Sieve chair', 'Sieve lamp', 'Sieve rug']);
    expect(await by('to=2026-01-15T10:00:00Z')).toEqual([]);
    expect(
      (await api(max, 'GET', `/api/v1/trash?locationId=${bobs.id}&not=locationId`)).statusCode,
    ).toBe(404);
    expect((await api(max, 'GET', '/api/v1/trash?not=kind')).statusCode).toBe(400);
    expect((await api(max, 'GET', '/api/v1/trash?from=last-week')).statusCode).toBe(400);
  });

  it('pages with a cursor, without repeats or gaps', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await thing(home, `Paged ${i}`));
    // One batch, one instant: the order within it is by id.
    await own(
      `UPDATE public.things SET deleted_at = now(), trash_batch_id = uuidv7()
        WHERE id = ANY ($1::uuid[])`,
      [ids],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/trash?q=paged&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page: Page = await ok<Page>(api(max, 'GET', url));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].sort().reverse());
    expect((await api(max, 'GET', '/api/v1/trash?cursor=nonsense')).statusCode).toBe(400);
  });
});

describe('route security review (step 2): trash moves its contents on the record', () => {
  // catalogue: POST /api/v1/things/:id/trash
  it('audits each thing a trash moves out of its container, and undo puts it back', async () => {
    const shelf = await place(home, 'Review shelf');
    const box = await thing(home, 'Review box', { placeId: shelf });
    const cable = await thing(home, 'Review cable', { containerId: box });
    const plug = await thing(home, 'Review plug', { containerId: box });
    await ok(api(max, 'POST', `/api/v1/things/${box}/trash`, { contents: 'move' }));
    const cableMove = await lastEvent('thing.move', cable);
    expect(cableMove).toMatchObject({
      root_thing_id: cable,
      subjects: [cable],
      undoable_until: null,
    });
    expect(cableMove?.diff).toMatchObject({
      container_id: { before: box, after: null },
      place_id: { before: null, after: shelf },
    });
    const trash = await lastEvent('thing.trash', box);
    expect(new Set(trash?.diff.moved_ids?.after as string[])).toEqual(new Set([cable, plug]));

    // The plug moves on before the undo: it stays where it went; the cable goes back.
    const drawer = await place(home, 'Review drawer');
    await own('UPDATE public.things SET place_id = $2 WHERE id = $1', [plug, drawer]);
    await ok(api(max, 'POST', `/api/v1/audit/${trash?.id}/undo`, {}));
    expect(await thingRow(box)).toMatchObject({ deleted_at: null, place_id: shelf });
    expect(await thingRow(cable)).toMatchObject({ container_id: box, place_id: null });
    expect(await thingRow(plug)).toMatchObject({ place_id: drawer, container_id: null });
    const back = await lastEvent('thing.move', cable);
    expect(back?.diff).toMatchObject({ container_id: { before: null, after: box } });
    expect(back?.id).not.toBe(cableMove?.id);
  });

  // catalogue: POST /api/v1/things/:id/restore
  it('audits each thing a restore sends to the Unplaced area', async () => {
    const crate = await thing(home, 'Review crate');
    const jar = await thing(home, 'Review jar', { containerId: crate });
    await ok(api(max, 'POST', `/api/v1/things/${jar}/trash`, {}));
    await ok(api(max, 'POST', `/api/v1/things/${crate}/trash`, {}));
    await ok(api(max, 'POST', `/api/v1/things/${jar}/restore`));
    const moved = await lastEvent('thing.move', jar);
    expect(moved?.diff).toMatchObject({
      container_id: { before: crate, after: null },
      place_id: { before: null, after: home.unplacedId },
    });
  });
});
