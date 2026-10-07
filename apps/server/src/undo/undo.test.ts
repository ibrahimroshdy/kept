import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { undoableActions } from '../audit/undo.js';

// T20 (D150, D124; plan Q23) through the front door: the actions step 3 adds to the undo route
// (place.trash; the web's lifecycle and trash toasts, whose events step 2 already writes), every
// refusal's `reason`, who may undo whose change, GET /api/v1/things/:id/undoable, and that
// another household reaches none of it. thing.extract and purchase.extract are undone end to
// end in extraction/extraction.test.ts; the capture, inbox and box-check handlers in their own
// areas' tests.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home and Garage
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let peter: Person; // member of Home
let talia: Person; // viewer of Home
let alfred: Person; // another household
let home: Loc;
let garage: Loc;

const HEADER = 'x-kept-audit-event';

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  peter = await person(t, db, 'peter');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  await setDisplayName(db, peter, 'Peter');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, peter.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const undoable = (as: Person, thingId: string) =>
  call(t, `/api/v1/things/${thingId}/undoable`, { as });

const thingRow = async (id: string) =>
  (
    await own<{
      name: string | null;
      lifecycle: string;
      place_id: string | null;
      container_id: string | null;
      location_id: string;
      deleted_at: Date | null;
    }>(
      db,
      `SELECT name, lifecycle, place_id, container_id, location_id, deleted_at
         FROM public.things WHERE id = $1`,
      [id],
    )
  )[0];

const placeRow = async (id: string) =>
  (
    await own<{ parent_id: string | null; deleted_at: Date | null }>(
      db,
      'SELECT parent_id, deleted_at FROM public.places WHERE id = $1',
      [id],
    )
  )[0];

const lastEvent = async (locationId: string, entityId: string) =>
  (await eventsOf(db, locationId, entityId)).at(-1);

async function rename(as: Person, id: string, name: string): Promise<string> {
  const current = ok(await call(t, `/api/v1/things/${id}`, { as: ibrahim }));
  const res = await call(t, `/api/v1/things/${id}`, {
    method: 'PATCH',
    as,
    headers: { 'if-match': String(current.rowVersion) },
    body: { name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.headers[HEADER] as string;
}

/** An undoable event written by hand, as kept_owner (for shapes no route writes). */
async function handWritten(
  as: Person,
  thingId: string,
  action: string,
  diff: object,
  until = "now() + interval '1 day'",
): Promise<string> {
  const [row] = await own<{ id: string }>(
    db,
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, entity_id, root_thing_id, diff, undoable_until)
     VALUES ($1, $2, 'user', $3, $4, 'thing', $5, $5, $6, ${until})
     RETURNING id`,
    [home.id, home.accountId, as.userId, action, thingId, JSON.stringify(diff)],
  );
  return row?.id as string;
}

// ---------------------------------------------------------------------------------------------

describe('what step 3 undoes', () => {
  it('registers a handler for every action D150 and plan Q23 name', () => {
    expect(undoableActions()).toEqual(
      expect.arrayContaining([
        'thing.update',
        'thing.retype',
        'thing.lifecycle',
        'thing.move',
        'thing.trash',
        'thing.capture',
        'capture.batch_undo',
        'thing.extract',
        'purchase.extract',
        'place.update',
        'place.move',
        'place.trash',
        'box.check',
        'inbox.bulk',
      ]),
    );
  });

  it('undoes a status change the web toasts: the header names it (D150)', async () => {
    const drill = await createThing(t, louis, home, { name: 'Drill' });
    const res = await call(t, `/api/v1/things/${drill.id}/lifecycle`, {
      as: louis,
      headers: { 'if-match': String(drill.rowVersion) },
      body: { lifecycle: 'lost' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const eventId = res.headers[HEADER] as string;
    expect(eventId).toBe((await lastEvent(home.id, drill.id))?.id);
    ok(await undo(louis, eventId));
    expect((await thingRow(drill.id))?.lifecycle).toBe('in_use');
  });

  it('undoes a trash the web toasts: the thing comes back', async () => {
    const lamp = await createThing(t, louis, home, { name: 'Lamp' });
    const res = await call(t, `/api/v1/things/${lamp.id}/trash`, { as: louis, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    ok(await undo(louis, res.headers[HEADER] as string));
    expect((await thingRow(lamp.id))?.deleted_at).toBeNull();
  });

  // catalogue: POST /api/v1/audit/:eventId/undo
  it('undoes a place trash that moved its contents out: all of it goes back (place.trash)', async () => {
    const room = await place(db, home, 'Workshop');
    const shelf = await place(db, home, 'Shelf', room);
    const tray = await place(db, home, 'Tray', shelf);
    const saw = await createThing(t, louis, home, { name: 'Saw', placeId: shelf });
    const tape = await createThing(t, louis, home, { name: 'Tape', placeId: shelf });
    const res = await call(t, `/api/v1/places/${shelf}/trash`, {
      as: louis,
      body: { contents: 'move' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await thingRow(saw.id))?.place_id).toBe(room);
    expect((await placeRow(tray))?.parent_id).toBe(room);
    // The tape moves on before the undo: it stays where it is now.
    const moved = await call(t, '/api/v1/things/move', {
      as: louis,
      body: { thingIds: [tape.id], to: { placeId: home.unplacedId } },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const eventId = res.headers[HEADER] as string;
    const done = ok(await undo(louis, eventId));
    expect(done.undoOf).toBe(eventId);
    expect((await placeRow(shelf))?.deleted_at).toBeNull();
    expect((await placeRow(tray))?.parent_id).toBe(shelf);
    expect((await thingRow(saw.id))?.place_id).toBe(shelf);
    expect((await thingRow(tape.id))?.place_id).toBe(home.unplacedId);
    const row = await lastEvent(home.id, shelf);
    expect(row).toMatchObject({ action: 'place.trash', undo_of: eventId, undoable_until: null });
    // The saw's history says it went back (security review #30).
    expect((await lastEvent(home.id, saw.id))?.action).toBe('thing.move');
  });

  it('undoes a place trash that trashed its contents: the batch comes back', async () => {
    const box = await place(db, home, 'Attic');
    const inner = await place(db, home, 'Corner', box);
    const fan = await createThing(t, louis, home, { name: 'Fan', placeId: inner });
    const res = await call(t, `/api/v1/places/${box}/trash`, {
      as: louis,
      body: { contents: 'trash' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await thingRow(fan.id))?.deleted_at).not.toBeNull();
    ok(await undo(louis, res.headers[HEADER] as string));
    expect((await placeRow(box))?.deleted_at).toBeNull();
    expect((await placeRow(inner))?.deleted_at).toBeNull();
    expect(await thingRow(fan.id)).toMatchObject({ deleted_at: null, place_id: inner });
  });

  it('refuses a place trash restored since: changed_since, saying who', async () => {
    const nook = await place(db, home, 'Nook');
    const res = await call(t, `/api/v1/places/${nook}/trash`, { as: louis, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    ok(await call(t, `/api/v1/places/${nook}/restore`, { as: peter, body: {} }));
    const refused = await undo(louis, res.headers[HEADER] as string);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'undo_refused',
      reason: 'changed_since',
      field: 'deleted_at',
      changedBy: { displayName: 'Peter' },
    });
    expect(refused.json().hint).toMatch(/Can't undo: Peter changed deleted_at since/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('refusals: 409 undo_refused with a reason', () => {
  it('changed_since names the field and who changed it', async () => {
    const mug = await createThing(t, louis, home, { name: 'Mug' });
    const eventId = await rename(louis, mug.id, 'Blue mug');
    await rename(peter, mug.id, 'Green mug');
    const res = await undo(louis, eventId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'undo_refused',
      reason: 'changed_since',
      field: 'name',
      changedBy: { displayName: 'Peter' },
    });
    expect((await thingRow(mug.id))?.name).toBe('Green mug');
  });

  it('already_undone on a second undo', async () => {
    const cup = await createThing(t, louis, home, { name: 'Cup' });
    const eventId = await rename(louis, cup.id, 'Tea cup');
    ok(await undo(louis, eventId));
    const again = await undo(louis, eventId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'undo_refused', reason: 'already_undone' });
  });

  it('expired once the 7 days are over, and the window is 7 days (D150)', async () => {
    const jar = await createThing(t, louis, home, { name: 'Jar' });
    const before = Date.now();
    const eventId = await rename(louis, jar.id, 'Glass jar');
    const [row] = await own<{ undoable_until: Date }>(
      db,
      'SELECT undoable_until FROM public.audit_events WHERE id = $1',
      [eventId],
    );
    const days = ((row?.undoable_until.getTime() ?? 0) - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    await own(
      db,
      `UPDATE public.audit_events SET undoable_until = now() - interval '1 second' WHERE id = $1`,
      [eventId],
    );
    const late = await undo(louis, eventId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'undo_refused', reason: 'expired' });
    expect(late.json().hint).toMatch(/7 days/);
    expect((await thingRow(jar.id))?.name).toBe('Glass jar');
  });

  it('not_undoable: a create, an undo (no redo), and a secret-class change (screens §8)', async () => {
    const vase = await createThing(t, louis, home, { name: 'Vase' });
    const [created] = await eventsOf(db, home.id, vase.id);
    const create = await undo(louis, created?.id as string);
    expect(create.statusCode).toBe(409);
    expect(create.json()).toMatchObject({ code: 'undo_refused', reason: 'not_undoable' });

    const eventId = await rename(louis, vase.id, 'Tall vase');
    const done = ok(await undo(louis, eventId));
    const redo = await undo(louis, done.eventId as string);
    expect(redo.json()).toMatchObject({ code: 'undo_refused', reason: 'not_undoable' });

    const secret = await handWritten(louis, vase.id, 'thing.update', {
      'custom.pin': { changed: true, class: 'secret' },
    });
    const res = await undo(louis, secret);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'undo_refused', reason: 'not_undoable' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('who may undo (Q23)', () => {
  let bowl: Json;
  let eventId: string;

  beforeAll(async () => {
    bowl = await createThing(t, louis, home, { name: 'Bowl' });
    eventId = await rename(louis, bowl.id, 'Big bowl');
  });

  it("refuses another member's event (403), a viewer (403) and another household (404)", async () => {
    expect((await undo(peter, eventId)).statusCode).toBe(403);
    expect((await undo(talia, eventId)).statusCode).toBe(403);
    expect((await undo(alfred, eventId)).statusCode).toBe(404);
    expect((await thingRow(bowl.id))?.name).toBe('Big bowl');
  });

  it("lets an admin of the location undo someone else's event", async () => {
    ok(await undo(bruce, eventId));
    expect((await thingRow(bowl.id))?.name).toBe('Bowl');
  });

  it('answers 404 for a move across locations undone without access to where it came from', async () => {
    const helmet = await createThing(t, ibrahim, home, { name: 'Helmet' });
    const res = await call(t, '/api/v1/things/move', {
      as: ibrahim,
      body: { thingIds: [helmet.id], to: { placeId: garage.unplacedId } },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Alfred runs the Garage too now, but has nothing in Home.
    await join(db, garage.id, alfred.userId, 'admin');
    const inGarage = await lastEvent(garage.id, helmet.id);
    expect(inGarage?.action).toBe('thing.move');
    expect((await undo(alfred, inGarage?.id as string)).statusCode).toBe(404);
    expect((await thingRow(helmet.id))?.location_id).toBe(garage.id);
    // Ibrahim, who has both, may.
    ok(await undo(ibrahim, inGarage?.id as string));
    expect((await thingRow(helmet.id))?.location_id).toBe(home.id);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/things/:id/undoable (D150: the timeline, 7 days)', () => {
  type Items = { items: { eventId: string; action: string; at: string; until: string }[] };
  const list = async (as: Person, id: string) => ok(await undoable(as, id)) as unknown as Items;

  it("lists the caller's own undoable events, newest first, with their window", async () => {
    const pan = await createThing(t, louis, home, { name: 'Pan' });
    const first = await rename(louis, pan.id, 'Frying pan');
    const second = await rename(louis, pan.id, 'Iron pan');
    const { items } = await list(louis, pan.id);
    expect(items.map((i) => i.eventId)).toEqual([second, first]);
    expect(items[0]?.action).toBe('thing.update');
    const days = (Date.parse(items[0]?.until ?? '') - Date.parse(items[0]?.at ?? '')) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("leaves out what the caller may not undo: another member's (members), all (viewers)", async () => {
    const pot = await createThing(t, louis, home, { name: 'Pot' });
    const eventId = await rename(louis, pot.id, 'Stock pot');
    expect((await list(peter, pot.id)).items).toEqual([]);
    expect((await list(talia, pot.id)).items).toEqual([]);
    expect((await list(bruce, pot.id)).items.map((i) => i.eventId)).toEqual([eventId]);
    expect((await list(ibrahim, pot.id)).items.map((i) => i.eventId)).toEqual([eventId]);
  });

  it('drops an event once undone, once expired, and never lists a create or a secret change', async () => {
    const kettle = await createThing(t, louis, home, { name: 'Kettle' });
    const a = await rename(louis, kettle.id, 'Steel kettle');
    const b = await rename(louis, kettle.id, 'Electric kettle');
    await handWritten(louis, kettle.id, 'thing.update', {
      'custom.pin': { changed: true, class: 'secret' },
    });
    expect((await list(louis, kettle.id)).items.map((i) => i.eventId)).toEqual([b, a]);
    ok(await undo(louis, b));
    await own(
      db,
      `UPDATE public.audit_events SET undoable_until = now() - interval '1 second' WHERE id = $1`,
      [a],
    );
    expect((await list(louis, kettle.id)).items).toEqual([]);
  });

  it('shows a trash on the trashed thing, and a move across locations once', async () => {
    const torch = await createThing(t, ibrahim, home, { name: 'Torch' });
    const moved = await call(t, '/api/v1/things/move', {
      as: ibrahim,
      body: { thingIds: [torch.id], to: { placeId: garage.unplacedId } },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const trashed = await call(t, `/api/v1/things/${torch.id}/trash`, { as: ibrahim, body: {} });
    expect(trashed.statusCode, trashed.body).toBe(200);
    const { items } = await list(ibrahim, torch.id);
    expect(items.map((i) => i.action)).toEqual(['thing.trash', 'thing.move']);
  });

  it('is a 404 for another household, and for a thing that does not exist', async () => {
    const plate = await createThing(t, louis, home, { name: 'Plate' });
    await rename(louis, plate.id, 'Dinner plate');
    expect((await undoable(alfred, plate.id)).statusCode).toBe(404);
    expect((await undoable(louis, '01926f00-0000-7000-8000-00000000ffff')).statusCode).toBe(404);
    expect((await undoable({ ...louis, cookie: '' }, plate.id)).statusCode).toBe(401);
  });
});
