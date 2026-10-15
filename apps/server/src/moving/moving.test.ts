import { execFileSync } from 'node:child_process';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { op, sent as sentOps } from '../../test/sync-ops.js';
import {
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { runJob } from '../jobs/boss.js';
import { reportJobs } from '../reports/jobs.js';

// Moving mode (1.x, D39 (5), D251), through the front door: starting a move, numbered boxes made
// for it or chosen, packing them with the ordinary move, marking them in transit (and Undo),
// unpacking one into its room with everything inside it (and Undo), across to another location,
// the offline `move_box` op and its ordering, who may do what, the module gate, and the contents
// sheets.
//
// Ibrahim owns Flat (Complete: Moving mode on) and House, where the move goes. Louis is a member
// of both, Talia a viewer of Flat. Garage (Household: Moving mode off) is Ibrahim's alone.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const jobs: RecordedJob[] = [];
let ibrahim: Person;
let louis: Person;
let talia: Person;
let flat: Loc;
let house: Loc;
let garage: Loc;
let hallway: string;
let kitchen: string;
let study: string;

const HEADER = 'x-kept-audit-event';

const hasPoppler = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();
const pdfText = (pdf: Buffer) =>
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
    input: pdf,
    timeout: 30_000,
  }).toString('utf8');

type Box = {
  moveId: string;
  containerId: string;
  number: number;
  state: string;
  name: string | null;
  shortCode: string | null;
  visible: boolean;
  locationId: string | null;
  placeId: string | null;
  contents: number;
  destination: { placeId: string; name: string; locationId: string } | null;
  stateBy: { displayName: string } | null;
};
type Move = {
  id: string;
  locationId: string;
  toLocationId: string | null;
  toLocationName: string | null;
  name: string;
  status: string;
  finishedAt: string | null;
  counts: { packed: number; in_transit: number; unpacked: number; total: number };
  boxes: Box[];
  rowVersion: number;
};

const start = async (as: Person, body: object, loc = flat) =>
  ok(await call(t, `/api/v1/locations/${loc.id}/moves`, { as, body }), 201) as unknown as Move;
const read = async (as: Person, id: string) =>
  ok(await call(t, `/api/v1/moves/${id}`, { as })) as unknown as Move;
const newBox = async (as: Person, moveId: string, extra: object = {}) =>
  ok(
    await call(t, `/api/v1/moves/${moveId}/boxes`, {
      as,
      body: { new: { prefix: 'Box' }, ...extra },
    }),
    201,
  ) as unknown as Box;
const thingRow = async (id: string) =>
  (
    await own<{ location_id: string; place_id: string | null; container_id: string | null }>(
      db,
      'SELECT location_id, place_id, container_id FROM public.things WHERE id = $1',
      [id],
    )
  )[0];
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent: jobs, files });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  flat = await createLocation(t, db, ibrahim, 'complete', 'Flat');
  house = await createLocation(t, db, ibrahim, 'complete', 'House');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  await join(db, flat.id, louis.userId, 'member');
  await join(db, house.id, louis.userId, 'member');
  await join(db, flat.id, talia.userId, 'viewer');
  hallway = await place(db, flat, 'Hallway');
  kitchen = await place(db, house, 'Kitchen');
  study = await place(db, flat, 'Study');
});

afterAll(async () => {
  await t.app.close();
  await files?.cleanup();
});

describe('starting a move', () => {
  // catalogue: POST /api/v1/locations/:id/moves
  it('starts one for a member, audits move.create, and refuses a viewer, a stranger and a location with the module off', async () => {
    const move = await start(louis, { name: 'Flat to House', toLocationId: house.id });
    expect(move).toMatchObject({
      name: 'Flat to House',
      locationId: flat.id,
      toLocationId: house.id,
      toLocationName: 'House',
      status: 'active',
      counts: { packed: 0, in_transit: 0, unpacked: 0, total: 0 },
      boxes: [],
    });
    const events = await eventsOf(db, flat.id, move.id);
    expect(events.map((e) => e.action)).toEqual(['move.create']);
    expect(events[0]?.diff.to_location_id?.after).toBe(house.id);

    const viewer = await call(t, `/api/v1/locations/${flat.id}/moves`, {
      as: talia,
      body: { name: 'Nope' },
    });
    expect(viewer.statusCode).toBe(403);
    const stranger = await call(t, `/api/v1/locations/${garage.id}/moves`, {
      as: louis,
      body: { name: 'Nope' },
    });
    expect(stranger.statusCode).toBe(404);
    const off = await call(t, `/api/v1/locations/${garage.id}/moves`, {
      as: ibrahim,
      body: { name: 'Nope' },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('module_off');
    // A destination the caller can't write is as absent as one they can't see.
    const elsewhere = await call(t, `/api/v1/locations/${flat.id}/moves`, {
      as: louis,
      body: { name: 'To the garage', toLocationId: garage.id },
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('lists the moves a person sees, open first, and leaves out a location with the module off', async () => {
    const list = ok(
      await call(t, `/api/v1/moves?locationId=${flat.id}`, { as: talia }),
    ) as unknown as {
      items: Move[];
    };
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((m) => m.locationId === flat.id)).toBe(true);
    await own(
      db,
      `INSERT INTO public.moves (location_id, name, created_by) VALUES ($1, 'Hidden', $2)`,
      [garage.id, ibrahim.userId],
    );
    const mine = ok(await call(t, '/api/v1/moves', { as: ibrahim })) as unknown as {
      items: Move[];
    };
    expect(mine.items.map((m) => m.name)).not.toContain('Hidden');
    const gated = await call(t, `/api/v1/moves?locationId=${garage.id}`, { as: ibrahim });
    expect((gated.json() as { items: Move[] }).items).toEqual([]);
  });
});

describe('boxes', () => {
  let move: Move;
  beforeAll(async () => {
    move = await start(louis, { name: 'Boxes', toLocationId: house.id });
  });

  // catalogue: POST /api/v1/moves/:id/boxes
  it('makes numbered boxes in the location, or takes a container that is there, and audits move_box.create', async () => {
    const one = await newBox(louis, move.id, { destinationPlaceId: kitchen });
    const two = await newBox(louis, move.id, { new: { prefix: 'Karton', placeId: hallway } });
    expect(one).toMatchObject({ number: 1, name: 'Box 1', state: 'packed', visible: true });
    expect(one.destination).toEqual({ placeId: kitchen, name: 'Kitchen', locationId: house.id });
    expect(two).toMatchObject({ number: 2, name: 'Karton 2', placeId: hallway });
    const type = await own<{ builtin_key: string }>(
      db,
      `SELECT ty.builtin_key FROM public.things t JOIN public.types ty ON ty.id = t.type_id
        WHERE t.id = $1`,
      [one.containerId],
    );
    expect(type[0]?.builtin_key).toBe('box_bin');
    const crate = await createThing(t, louis, flat, { name: 'Wine crate' });
    const three = ok(
      await call(t, `/api/v1/moves/${move.id}/boxes`, {
        as: louis,
        body: { containerId: crate.id },
      }),
      201,
    ) as unknown as Box;
    expect(three).toMatchObject({ number: 3, name: 'Wine crate' });
    const events = await eventsOf(db, flat.id, crate.id);
    expect(events.map((e) => e.action)).toEqual(['thing.create', 'move_box.create']);
    expect((events[1]?.diff.box?.after as { number: number } | undefined)?.number).toBe(3);

    // Only once in an open move; a room where the move goes; not a viewer.
    const twice = await call(t, `/api/v1/moves/${move.id}/boxes`, {
      as: louis,
      body: { containerId: crate.id },
    });
    expect(twice.statusCode).toBe(409);
    const wrongRoom = await call(t, `/api/v1/moves/${move.id}/boxes`, {
      as: louis,
      body: { new: {}, destinationPlaceId: hallway },
    });
    expect(wrongRoom.statusCode).toBe(400);
    const viewer = await call(t, `/api/v1/moves/${move.id}/boxes`, {
      as: talia,
      body: { new: {} },
    });
    expect(viewer.statusCode).toBe(403);

    const board = await read(talia, move.id);
    expect(board.boxes.map((b) => b.number)).toEqual([1, 2, 3]);
    expect(board.counts).toEqual({ packed: 3, in_transit: 0, unpacked: 0, total: 3 });
  });

  // catalogue: PATCH /api/v1/moves/:id/boxes/:containerId
  it('marks a box in transit, undoably (move_box.update), and chooses its room without an undo window', async () => {
    const box = await newBox(louis, move.id);
    const res = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}`, {
      method: 'PATCH',
      as: louis,
      body: { state: 'in_transit' },
    });
    const marked = ok(res) as unknown as Box;
    expect(marked).toMatchObject({ state: 'in_transit', stateBy: { displayName: 'Louis' } });
    const eventId = res.headers[HEADER] as string;
    expect(eventId).toBeTruthy();
    const events = await eventsOf(db, flat.id, box.containerId);
    const update = events.find((e) => e.action === 'move_box.update');
    expect(update?.undoable_until).not.toBeNull();

    ok(await undo(louis, eventId));
    expect(
      (await read(louis, move.id)).boxes.find((b) => b.containerId === box.containerId),
    ).toMatchObject({ state: 'packed' });

    const room = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}`, {
      method: 'PATCH',
      as: louis,
      body: { destinationPlaceId: kitchen },
    });
    expect((ok(room) as unknown as Box).destination?.name).toBe('Kitchen');
    expect(room.headers[HEADER]).toBeUndefined();
    const viewer = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}`, {
      method: 'PATCH',
      as: talia,
      body: { state: 'in_transit' },
    });
    expect(viewer.statusCode).toBe(403);
  });

  // catalogue: DELETE /api/v1/moves/:id/boxes/:containerId
  it('takes a box out of the move (the container stays) and audits move_box.delete', async () => {
    const box = await newBox(louis, move.id);
    const res = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}`, {
      method: 'DELETE',
      as: louis,
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await thingRow(box.containerId)).toBeTruthy();
    const events = await eventsOf(db, flat.id, box.containerId);
    expect(events.map((e) => e.action)).toContain('move_box.delete');
    expect((await read(louis, move.id)).boxes.map((b) => b.containerId)).not.toContain(
      box.containerId,
    );
  });
});

describe('unpacking', () => {
  let move: Move;
  beforeAll(async () => {
    move = await start(louis, { name: 'Unpacking', toLocationId: house.id });
  });

  // catalogue: POST /api/v1/moves/:id/boxes/:containerId/unpack
  it('moves the box with everything inside into its room in the other location, audits move_box.unpack, and Undo puts it all back', async () => {
    const box = await newBox(louis, move.id, {
      new: { prefix: 'Box', placeId: hallway },
      destinationPlaceId: kitchen,
    });
    const kettle = await createThing(t, louis, flat, {
      name: 'Kettle',
      containerId: box.containerId,
    });
    expect((await read(louis, move.id)).boxes[0]?.contents).toBe(1);

    const res = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}/unpack`, {
      as: louis,
      body: {},
    });
    const unpacked = ok(res) as unknown as Box;
    expect(unpacked).toMatchObject({ state: 'unpacked', locationId: house.id, placeId: kitchen });
    expect(await thingRow(box.containerId)).toMatchObject({
      location_id: house.id,
      place_id: kitchen,
    });
    // The kettle came with it, still inside the box.
    expect(await thingRow(kettle.id)).toMatchObject({
      location_id: house.id,
      container_id: box.containerId,
    });
    const events = await eventsOf(db, flat.id, box.containerId);
    const unpack = events.find((e) => e.action === 'move_box.unpack');
    expect(unpack?.undoable_until).not.toBeNull();
    expect(unpack?.diff.at?.after).toMatchObject({ location_id: house.id, place_id: kitchen });
    // Only the unpack is offered for Undo; the box's own move has no window of its own.
    expect(res.headers[HEADER]).toBe(unpack?.id);
    const moves = events.filter((e) => e.action === 'thing.move');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((e) => e.undoable_until === null)).toBe(true);
    const board = await read(louis, move.id);
    expect(board.counts).toMatchObject({ unpacked: 1, packed: 0 });

    ok(await undo(louis, unpack?.id as string));
    expect(await thingRow(box.containerId)).toMatchObject({
      location_id: flat.id,
      place_id: hallway,
    });
    expect(await thingRow(kettle.id)).toMatchObject({ location_id: flat.id });
    expect((await read(louis, move.id)).boxes[0]?.state).toBe('packed');
  });

  it('needs a room, refuses one where the move isn’t going, and a viewer', async () => {
    const box = await newBox(louis, move.id);
    const none = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}/unpack`, {
      as: louis,
      body: {},
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().reason).toBe('no_room');
    const wrong = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}/unpack`, {
      as: louis,
      body: { placeId: study },
    });
    expect(wrong.statusCode).toBe(400);
    const viewer = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}/unpack`, {
      as: talia,
      body: { placeId: kitchen },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('within one location: a move with no destination unpacks into its own rooms', async () => {
    const within = await start(louis, { name: 'Rearranging' });
    const box = await newBox(louis, within.id, { destinationPlaceId: study });
    ok(
      await call(t, `/api/v1/moves/${within.id}/boxes/${box.containerId}/unpack`, {
        as: louis,
        body: {},
      }),
    );
    expect(await thingRow(box.containerId)).toMatchObject({
      location_id: flat.id,
      place_id: study,
    });
  });

  it('finds the box a scanned container is (an open move first)', async () => {
    const box = await newBox(louis, move.id);
    const found = ok(await call(t, `/api/v1/move-boxes/${box.containerId}`, { as: talia }));
    expect(found).toMatchObject({ containerId: box.containerId, move: { id: move.id } });
    const loose = await createThing(t, louis, flat, { name: 'Loose' });
    expect((await call(t, `/api/v1/move-boxes/${loose.id}`, { as: louis })).statusCode).toBe(404);
  });
});

describe('the move itself', () => {
  // catalogue: PATCH /api/v1/moves/:id
  it('renames it and marks it done (move.update); a done move takes no box changes until it is opened again', async () => {
    const move = await start(louis, { name: 'Old name' });
    const box = await newBox(louis, move.id);
    const res = await call(t, `/api/v1/moves/${move.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(move.rowVersion),
      body: { name: 'New name', status: 'done' },
    });
    const done = ok(res) as unknown as Move;
    expect(done).toMatchObject({ name: 'New name', status: 'done' });
    expect(done.finishedAt).not.toBeNull();
    const events = await eventsOf(db, flat.id, move.id);
    expect(events.map((e) => e.action)).toEqual(['move.create', 'move.update']);
    const refused = await call(t, `/api/v1/moves/${move.id}/boxes/${box.containerId}`, {
      method: 'PATCH',
      as: louis,
      body: { state: 'in_transit' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toBe('move_done');
    const stale = await call(t, `/api/v1/moves/${move.id}`, {
      method: 'PATCH',
      as: louis,
      headers: ifMatch(move.rowVersion),
      body: { status: 'active' },
    });
    expect(stale.statusCode).toBe(412);
    const open = ok(
      await call(t, `/api/v1/moves/${move.id}`, {
        method: 'PATCH',
        as: louis,
        headers: ifMatch(done.rowVersion),
        body: { status: 'active' },
      }),
    ) as unknown as Move;
    expect(open.finishedAt).toBeNull();
  });

  // catalogue: DELETE /api/v1/moves/:id
  it('deletes it (move.delete); its boxes stay as things', async () => {
    const move = await start(louis, { name: 'Gone' });
    const box = await newBox(louis, move.id);
    const res = await call(t, `/api/v1/moves/${move.id}`, {
      method: 'DELETE',
      as: louis,
      headers: ifMatch(move.rowVersion),
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await call(t, `/api/v1/moves/${move.id}`, { as: louis })).statusCode).toBe(404);
    expect(await thingRow(box.containerId)).toBeTruthy();
    const events = await eventsOf(db, flat.id, move.id);
    expect(events.map((e) => e.action)).toEqual(['move.create', 'move.delete']);
  });

  it('is in the Moving mode module: off there, its routes answer module_off', async () => {
    const move = await start(louis, { name: 'Gated' });
    const set = (enabled: boolean) =>
      own(
        db,
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'moving', $2)
         ON CONFLICT (location_id, module) DO UPDATE SET enabled = excluded.enabled`,
        [flat.id, enabled],
      );
    await set(false);
    try {
      const res = await call(t, `/api/v1/moves/${move.id}`, { as: louis });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('module_off');
    } finally {
      await set(true);
    }
  });
});

describe('the move_box op (offline)', () => {
  let move: Move;
  beforeAll(async () => {
    move = await start(louis, { name: 'Offline', toLocationId: house.id });
  });

  it('marks a box in transit, ignores an older change that arrives later, and unpacks into a room', async () => {
    const box = await newBox(louis, move.id);
    await new Promise((r) => setTimeout(r, 50));
    const now = Date.now();
    const [first] = await sentOps(t, louis, [
      op(
        'move_box',
        flat.id,
        { moveId: move.id, containerId: box.containerId, state: 'in_transit' },
        { takenAt: new Date(now).toISOString() },
      ),
    ]);
    expect(first?.outcome).toBe('applied');
    // Another phone said "packed" earlier, and syncs now: the newer word stands.
    const [late] = await sentOps(t, louis, [
      op(
        'move_box',
        flat.id,
        { moveId: move.id, containerId: box.containerId, state: 'packed' },
        { takenAt: new Date(now - 10).toISOString() },
      ),
    ]);
    expect(late).toMatchObject({ outcome: 'applied', reason: 'superseded' });
    expect((await read(louis, move.id)).boxes[0]?.state).toBe('in_transit');

    const [unpack] = await sentOps(t, louis, [
      op('move_box', flat.id, {
        moveId: move.id,
        containerId: box.containerId,
        state: 'unpacked',
        placeId: kitchen,
      }),
    ]);
    expect(unpack?.outcome).toBe('applied');
    expect(await thingRow(box.containerId)).toMatchObject({
      location_id: house.id,
      place_id: kitchen,
    });
    const events = await eventsOf(db, flat.id, box.containerId);
    expect(events.map((e) => e.action)).toContain('move_box.unpack');
  });

  it('a viewer’s op is not permitted; a trashed box drops with a restore', async () => {
    const box = await newBox(louis, move.id);
    const [viewer] = await sentOps(t, talia, [
      op('move_box', flat.id, {
        moveId: move.id,
        containerId: box.containerId,
        state: 'in_transit',
      }),
    ]);
    expect(viewer).toMatchObject({ outcome: 'dropped', reason: 'not_permitted' });
    ok(await call(t, `/api/v1/things/${box.containerId}/trash`, { as: louis, body: {} }));
    const [gone] = await sentOps(t, louis, [
      op('move_box', flat.id, {
        moveId: move.id,
        containerId: box.containerId,
        state: 'in_transit',
      }),
    ]);
    expect(gone).toMatchObject({ outcome: 'dropped', reason: 'target_trashed' });
  });
});

describe('the contents sheets', () => {
  let move: Move;
  let box: Box;
  const log = { info: () => {}, error: () => {} };

  beforeAll(async () => {
    move = await start(louis, { name: 'Sheets', toLocationId: house.id });
    box = await newBox(louis, move.id, { destinationPlaceId: kitchen });
    await createThing(t, louis, flat, { name: 'Teapot', containerId: box.containerId });
  });

  // catalogue: POST /api/v1/reports/move
  it('queues a run for a viewer, audits report.generate, and refuses a move they can’t see', async () => {
    jobs.length = 0;
    const body = ok(
      await call(t, '/api/v1/reports/move', { as: talia, body: { moveId: move.id } }),
      202,
    );
    expect(jobs).toEqual([{ name: 'report', data: { runId: body.id } }]);
    const events = await own<{ action: string; diff: Record<string, { after: unknown }> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_type = 'report' AND entity_id = $1`,
      [body.id],
    );
    expect(events.map((e) => e.action)).toEqual(['report.generate']);
    expect(events[0]?.diff.kind?.after).toBe('move');
    const hidden = await call(t, '/api/v1/reports/move', {
      as: talia,
      body: { moveId: newId() },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it.skipIf(!hasPoppler)(
    'prints a page per box: its number, the room it goes to and what is inside',
    async () => {
      const { id } = ok(
        await call(t, '/api/v1/reports/move', {
          as: louis,
          body: { moveId: move.id, containerIds: [box.containerId], locale: 'en' },
        }),
        202,
      );
      const job = reportJobs({
        pools: db.pools,
        mailer: { send: async () => {} },
        publicUrl: 'https://kept.example',
        log,
        files,
      }).find((j) => j.name === 'report');
      if (!job) throw new Error('no report job');
      await runJob(job, { userId: louis.userId, mfa: false, data: { runId: id } }, db.pools);
      const run = ok(await call(t, `/api/v1/reports/${id}`, { as: louis })) as {
        status?: string;
        fileUrl?: string;
      };
      expect(run.status, JSON.stringify(run)).toBe('done');
      const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
      expect(String(res.headers['content-disposition'])).toMatch(/kept-contents-sheets-/);
      const text = pdfText(res.rawPayload);
      expect(text).toContain('Box 1');
      expect(text).toContain('Kitchen');
      expect(text).toContain('Teapot');
      expect(text).toContain('Flat → House');
    },
    60_000,
  );
});
