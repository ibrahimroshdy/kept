import { createHash } from 'node:crypto';
import { addDays, newId, type SnapshotPage, type SnapThing } from '@kept/shared';
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

// Task 10 through the front door, as the web calls it (apps/web/src/api/household/{types,paths}.ts,
// components/lending/*): lending out and borrowing in (D56, D57), one open loan per thing, a
// partial lend that splits and merges back on return (D10, D172, Q14), a borrowed thing that goes
// back to its owner (Q15), condition photos, the derived states lent and borrowed everywhere
// (thing, search, the offline snapshot, D119, Q34), and undo (D150).

let db: TestDb;
let t: TestApp;

let ibrahim: Person; // owner of Home
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let alfred: Person; // his own account (بيت العائلة); nothing of Ibrahim's
let home: Loc;
let garage: Loc; // Essentials: Lending off
let familyHome: Loc;
let today: string;
let murdock: string; // a person of Ibrahim's account

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  await setDisplayName(db, alfred, 'Alfred');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  familyHome = await createLocation(t, db, alfred, 'complete', 'بيت العائلة');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  const [row] = await own<{ today: string }>(
    db,
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
  );
  today = row?.today as string;
  const [m] = await own<{ id: string }>(
    db,
    `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Murdock') RETURNING id`,
    [home.accountId],
  );
  murdock = m?.id as string;
});

const post = (as: Person, url: string, body: unknown, version?: number) =>
  call(t, url, {
    as,
    body,
    ...(version !== undefined ? { headers: { 'if-match': String(version) } } : {}),
  });
const patch = (as: Person, url: string, body: unknown, version: number) =>
  call(t, url, { as, method: 'PATCH', body, headers: { 'if-match': String(version) } });
const del = (as: Person, url: string, version: number) =>
  call(t, url, { as, method: 'DELETE', headers: { 'if-match': String(version) } });
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

async function lend(as: Person, thingId: string, body: Record<string, unknown>): Promise<Json> {
  return ok(await post(as, `/api/v1/things/${thingId}/lend`, body), 201);
}

const thingView = async (id: string, as = ibrahim) =>
  ok(await call(t, `/api/v1/things/${id}`, { as }));
const thingRow = (id: string) =>
  own<{
    quantity: string;
    place_id: string | null;
    container_id: string | null;
    deleted_at: Date | null;
    lifecycle: string;
    ended_on: string | null;
    merged_into_id: string | null;
  }>(
    db,
    `SELECT trim_scale(quantity)::text AS quantity, place_id, container_id, deleted_at, lifecycle,
            ended_on::text AS ended_on, merged_into_id
       FROM public.things WHERE id = $1`,
    [id],
  ).then((r) => r[0]);

describe('POST /api/v1/things/:id/lend', () => {
  // catalogue: POST /api/v1/things/:id/lend
  it('lends a thing to a person: derived lent, the loan line, audited on the thing', async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    const res = await lend(louis, drill.id, {
      person: { id: murdock },
      dueOn: addDays(today, 14),
      notes: 'For the shelves',
    });
    const loan = res.loan as Json;
    expect(loan).toMatchObject({
      thingId: drill.id,
      direction: 'out',
      person: { id: murdock, name: 'Murdock', isMember: false },
      dueOn: addDays(today, 14),
      returnedAt: null,
      overdue: false,
      quantity: '1',
      splitFromThingId: null,
      previousPlace: { type: 'place', id: home.unplacedId },
      notes: 'For the shelves',
      conditionOut: [],
      conditionIn: [],
      rowVersion: 1,
      createdBy: { displayName: 'Louis' },
    });
    expect(res.thing).toMatchObject({ id: drill.id, derivedState: ['lent'] });
    expect(res.splitFrom).toBeUndefined();
    const view = await thingView(drill.id, talia);
    expect(view.derivedState).toEqual(['lent']);
    expect(view.loanLine).toMatchObject({
      direction: 'out',
      personName: 'Murdock',
      dueOn: addDays(today, 14),
      overdue: false,
    });
    const [event] = await eventsOf(db, home.id, loan.id);
    expect(event).toMatchObject({ action: 'loan.create', actor_id: louis.userId });
    expect(event?.diff).toMatchObject({
      direction: { after: 'out' },
      person_id: { after: murdock },
    });
    // Search finds it as lent.
    const found = ok(
      await call(t, `/api/v1/search?state=lent&locationId=${home.id}`, { as: talia }),
    );
    expect(JSON.stringify(found)).toContain(drill.id);
  });

  it('one open loan per thing (409 already_on_loan); nothing is lent while in repair', async () => {
    const ladder = await createThing(t, ibrahim, home, { name: 'Ladder' });
    await lend(louis, ladder.id, { person: { name: 'Peter' } });
    const again = await post(louis, `/api/v1/things/${ladder.id}/lend`, {
      person: { id: murdock },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'already_on_loan' });

    const tv = await createThing(t, ibrahim, home, { name: 'TV' });
    await own(
      db,
      `INSERT INTO public.claims (location_id, thing_id, opened_on, status, created_by)
       VALUES ($1, $2, $3, 'in_repair', $4)`,
      [home.id, tv.id, today, ibrahim.userId],
    );
    const repair = await post(louis, `/api/v1/things/${tv.id}/lend`, { person: { id: murdock } });
    expect(repair.statusCode).toBe(409);
    expect(repair.json()).toMatchObject({ code: 'thing_in_repair' });
  });

  it('a viewer reads but never writes (403); outsiders and other accounts’ people are 404', async () => {
    const saw = await createThing(t, ibrahim, home, { name: 'Saw' });
    expect(
      (await post(talia, `/api/v1/things/${saw.id}/lend`, { person: { id: murdock } })).statusCode,
    ).toBe(403);
    expect(
      (await post(alfred, `/api/v1/things/${saw.id}/lend`, { person: { id: murdock } })).statusCode,
    ).toBe(404);
    const [alfreds] = await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Murdock')
       RETURNING id`,
      [familyHome.accountId],
    );
    const other = await post(louis, `/api/v1/things/${saw.id}/lend`, {
      person: { id: alfreds?.id },
    });
    expect(other.statusCode).toBe(404);
    ok(await call(t, `/api/v1/things/${saw.id}/loans`, { as: talia }));
    const personPage = await call(t, `/api/v1/people/${alfreds?.id}/loans`, { as: ibrahim });
    expect(personPage.statusCode).toBe(404);
  });

  it('is refused where Lending is off (409 module_off; 404 on a read)', async () => {
    const hammer = await createThing(t, ibrahim, garage, { name: 'Hammer' });
    const res = await post(ibrahim, `/api/v1/things/${hammer.id}/lend`, {
      person: { id: murdock },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'module_off' });
    const read = await call(t, `/api/v1/things/${hammer.id}/loans`, { as: ibrahim });
    expect(read.statusCode).toBe(404);
  });

  it('still returns an open loan where Lending was switched off since (UI step-4 review L3)', async () => {
    const saw = await createThing(t, ibrahim, home, { name: 'Saw' });
    const loan = (await lend(ibrahim, saw.id, { person: { id: murdock } })).loan as {
      id: string;
      rowVersion: number;
    };
    const lending = (on: boolean) =>
      own(
        db,
        `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'lending', $2)
         ON CONFLICT (location_id, module) DO UPDATE SET enabled = $2`,
        [home.id, on],
      );
    await lending(false);
    try {
      // The thing page reads only its open loan, to mark it returned; other writes stay off.
      const read = ok(await call(t, `/api/v1/things/${saw.id}/loans`, { as: ibrahim }));
      expect((read.items as Json[]).map((l) => l.id)).toEqual([loan.id]);
      const due = await patch(ibrahim, `/api/v1/loans/${loan.id}`, { dueOn: today }, 1);
      expect(due.statusCode).toBe(409);
      expect(due.json()).toMatchObject({ code: 'module_off' });
      ok(await post(ibrahim, `/api/v1/loans/${loan.id}/return`, {}, loan.rowVersion));
      // Returned, the thing has no open loan: its loans are off again.
      expect((await call(t, `/api/v1/things/${saw.id}/loans`, { as: ibrahim })).statusCode).toBe(
        404,
      );
    } finally {
      await lending(true);
    }
  });

  it('lends to a member (Q16): the person linked to them', async () => {
    const book = await createThing(t, ibrahim, home, { name: 'Book' });
    const res = await lend(ibrahim, book.id, { person: { memberUserId: louis.userId } });
    expect((res.loan as Json).person).toMatchObject({ name: 'Louis', isMember: true });
    const [p] = await own<{ member_user_id: string }>(
      db,
      'SELECT member_user_id FROM public.people WHERE id = $1',
      [(res.loan as { person: { id: string } }).person.id],
    );
    expect(p?.member_user_id).toBe(louis.userId);
    const pen = await createThing(t, ibrahim, home, { name: 'Pen' });
    const stranger = await post(ibrahim, `/api/v1/things/${pen.id}/lend`, {
      person: { memberUserId: alfred.userId },
    });
    expect(stranger.statusCode).toBe(404);
  });
});

describe('partial lends and returns (D10, D172, Q14)', () => {
  // catalogue: POST /api/v1/loans/:id/return
  it('lending 3 of 5 splits; the return merges back; undo un-merges', async () => {
    const shelf = await place(db, home, 'Shelf');
    const chairs = await createThing(t, ibrahim, home, {
      name: 'Folding chairs',
      quantity: 5,
      placeId: shelf,
    });
    const res = await lend(louis, chairs.id, { person: { id: murdock }, quantity: '3' });
    const loan = res.loan as Json;
    const part = res.thing as Json;
    expect(part.id).not.toBe(chairs.id);
    expect(part).toMatchObject({ quantity: 3, derivedState: ['lent'] });
    expect(res.splitFrom).toMatchObject({ id: chairs.id, quantity: 2, derivedState: [] });
    expect(loan).toMatchObject({ thingId: part.id, splitFromThingId: chairs.id, quantity: '3' });

    const back = await post(louis, `/api/v1/loans/${loan.id}/return`, {}, 1);
    const returned = ok(back);
    expect(returned.loan).toMatchObject({
      returnedAt: expect.any(String),
      returnPlace: { id: shelf },
    });
    expect(returned.mergedInto).toMatchObject({ id: chairs.id, quantity: 5 });
    expect(await thingRow(part.id)).toMatchObject({
      deleted_at: expect.any(Date),
      merged_into_id: chairs.id,
    });
    // The part can't come back from the trash on its own (0056): that would count the 3 twice.
    const restore = await call(t, `/api/v1/things/${part.id}/restore`, {
      as: ibrahim,
      method: 'POST',
      body: {},
    });
    expect(restore.statusCode, restore.body).toBe(409);
    const eventId = back.headers['x-kept-audit-event'] as string;
    const [event] = (await eventsOf(db, home.id, loan.id)).filter(
      (e) => e.action === 'loan.return',
    );
    expect(event?.id).toBe(eventId);
    expect(event?.diff).toMatchObject({ merged_into: { after: chairs.id } });
    // The original's history lists the part's loan.
    const history = ok(await call(t, `/api/v1/things/${chairs.id}/loans`, { as: talia }));
    expect((history.items as Json[]).map((l) => l.id)).toContain(loan.id);

    ok(await undo(louis, eventId));
    expect(await thingRow(chairs.id)).toMatchObject({ quantity: '2' });
    expect(await thingRow(part.id)).toMatchObject({
      quantity: '3',
      deleted_at: null,
      merged_into_id: null,
    });
    const reopened = ok(await call(t, `/api/v1/things/${part.id}/loans`, { as: louis }));
    expect((reopened.items as Json[])[0]).toMatchObject({ id: loan.id, returnedAt: null });
    expect((await thingView(part.id)).derivedState).toEqual(['lent']);
  });

  it('a return after the original moved stays separate', async () => {
    const shed = await place(db, home, 'Shed');
    const porch = await place(db, home, 'Porch');
    const pots = await createThing(t, ibrahim, home, { name: 'Pots', quantity: 6, placeId: shed });
    const res = await lend(louis, pots.id, { person: { id: murdock }, quantity: '2' });
    ok(
      await post(ibrahim, '/api/v1/things/move', {
        thingIds: [pots.id],
        to: { placeId: porch },
      }),
    );
    const loan = res.loan as Json;
    const returned = ok(await post(louis, `/api/v1/loans/${loan.id}/return`, {}, 1));
    expect(returned.mergedInto).toBeUndefined();
    expect(await thingRow((res.thing as Json).id)).toMatchObject({
      place_id: shed,
      deleted_at: null,
      quantity: '2',
    });
    expect(await thingRow(pots.id)).toMatchObject({ quantity: '4' });
    expect((await thingView((res.thing as Json).id)).derivedState).toEqual([]);
  });

  it('returns to a chosen place, and keeps the part apart when asked', async () => {
    const attic = await place(db, home, 'Attic');
    const cups = await createThing(t, ibrahim, home, { name: 'Cups', quantity: 8 });
    const res = await lend(louis, cups.id, { person: { id: murdock }, quantity: '4' });
    const returned = ok(
      await post(
        louis,
        `/api/v1/loans/${(res.loan as Json).id}/return`,
        { to: { placeId: attic }, mergeBack: false, notes: 'One chipped' },
        1,
      ),
    );
    expect(returned.mergedInto).toBeUndefined();
    expect(returned.loan).toMatchObject({
      notes: 'One chipped',
      returnPlace: { id: attic, name: 'Attic' },
    });
    expect(await thingRow((res.thing as Json).id)).toMatchObject({ place_id: attic });
  });

  it('returns into a container, and names the container as where it came back (UI review L7)', async () => {
    const box = await createThing(t, ibrahim, home, { name: 'Box 3' });
    const tent = await createThing(t, ibrahim, home, { name: 'Tent' });
    const res = await lend(louis, tent.id, { person: { id: murdock } });
    const returned = ok(
      await post(
        louis,
        `/api/v1/loans/${(res.loan as Json).id}/return`,
        {
          to: { containerId: box.id },
        },
        1,
      ),
    );
    expect(returned.loan).toMatchObject({ returnPlace: { id: box.id, name: 'Box 3' } });
    expect(await thingRow(tent.id)).toMatchObject({ container_id: box.id, place_id: null });
  });
});

describe('POST /api/v1/locations/:id/borrow (D56, Q15)', () => {
  // catalogue: POST /api/v1/locations/:id/borrow
  it('borrows a thing that belongs to the person; its return ends it and it leaves Home’s counts', async () => {
    const before = ok(await call(t, '/api/v1/home', { as: ibrahim }));
    const res = ok(
      await post(louis, `/api/v1/locations/${home.id}/borrow`, {
        name: 'Pressure washer',
        target: { placeId: home.unplacedId },
        person: { name: 'Bruce' },
        dueOn: addDays(today, 7),
      }),
      201,
    );
    const loan = res.loan as Json;
    const thing = res.thing as Json;
    expect(loan).toMatchObject({ direction: 'in', person: { name: 'Bruce' }, thingId: thing.id });
    expect(thing).toMatchObject({ name: 'Pressure washer', derivedState: ['borrowed'] });
    const view = await thingView(thing.id);
    expect(view.belongsTo).toMatchObject({ id: (loan.person as Json).id });
    const [created] = await eventsOf(db, home.id, loan.id);
    expect(created).toMatchObject({ action: 'loan.create' });
    const during = ok(await call(t, '/api/v1/home', { as: ibrahim }));
    expect((during.attention as Json).borrowedIn).toBe(
      ((before.attention as Json).borrowedIn as number) + 1,
    );
    const lists = ok(
      await call(t, `/api/v1/loans?state=open&locationId=${home.id}`, { as: ibrahim }),
    );
    expect((lists.counts as Json).in).toBe((during.attention as Json).borrowedIn);

    ok(await post(louis, `/api/v1/loans/${loan.id}/return`, {}, 1));
    expect(await thingRow(thing.id)).toMatchObject({
      lifecycle: 'returned_to_owner',
      ended_on: today,
    });
    const after = ok(await call(t, '/api/v1/home', { as: ibrahim }));
    expect((after.attention as Json).borrowedIn).toBe((before.attention as Json).borrowedIn);
    expect((await thingView(thing.id)).derivedState).toEqual(['ended']);
  });
});

describe('PATCH, DELETE and the condition photos of a loan', () => {
  // catalogue: PATCH /api/v1/loans/:id
  it('changes the due date (If-Match; 412 stale), audited and undoable', async () => {
    const tent = await createThing(t, ibrahim, home, { name: 'Tent' });
    const loan = (
      await lend(louis, tent.id, {
        person: { id: murdock },
        startedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      })
    ).loan as Json;
    const res = ok(
      await patch(louis, `/api/v1/loans/${loan.id}`, { dueOn: addDays(today, -1) }, 1),
    );
    expect(res).toMatchObject({ dueOn: addDays(today, -1), overdue: true, rowVersion: 2 });
    expect((await patch(louis, `/api/v1/loans/${loan.id}`, { notes: 'x' }, 1)).statusCode).toBe(
      412,
    );
    const early = await patch(louis, `/api/v1/loans/${loan.id}`, { dueOn: addDays(today, -30) }, 2);
    expect(early.statusCode).toBe(400);
    const [update] = (await eventsOf(db, home.id, loan.id)).filter(
      (e) => e.action === 'loan.update',
    );
    expect(update?.diff).toMatchObject({ due_on: { before: null, after: addDays(today, -1) } });
    const overdue = ok(await call(t, '/api/v1/loans?state=overdue', { as: talia }));
    expect((overdue.items as Json[]).map((l) => l.id)).toContain(loan.id);
    ok(await undo(louis, update?.id as string));
    expect((await thingView(tent.id)).loanLine).toMatchObject({ dueOn: null, overdue: false });
  });

  // catalogue: DELETE /api/v1/loans/:id
  // catalogue: POST /api/v1/loans/:id/attachments
  it('deletes a loan recorded by mistake; undo brings it back with its condition photo', async () => {
    const bike = await createThing(t, ibrahim, home, { name: 'Bike' });
    const loan = (await lend(louis, bike.id, { person: { id: murdock } })).loan as Json;
    const bytes = Buffer.from(`bike-${newId()}`);
    const [file] = await own<{ id: string }>(
      db,
      `INSERT INTO public.files (location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, 'f/x/' || gen_random_uuid(), $2, $3, 'image/jpeg', 'photo', 'unavailable', $4)
       RETURNING id`,
      [home.id, createHash('sha256').update(bytes).digest('hex'), bytes.length, louis.userId],
    );
    const photo = ok(
      await post(louis, `/api/v1/loans/${loan.id}/attachments`, {
        fileId: file?.id,
        role: 'condition_out',
      }),
      201,
    );
    expect(photo).toMatchObject({ role: 'condition_out', subject: { loanId: loan.id } });
    const [attached] = await eventsOf(db, home.id, photo.id);
    expect(attached).toMatchObject({ action: 'attachment.create' });
    const wrongRole = await post(louis, `/api/v1/attachments`, {
      locationId: home.id,
      fileId: file?.id,
      subject: { loanId: loan.id },
      role: 'receipt',
    });
    expect(wrongRole.statusCode).toBe(400);
    const listed = ok(await call(t, `/api/v1/things/${bike.id}/loans`, { as: talia }));
    expect((listed.items as Json[])[0]).toMatchObject({ conditionOut: [{ id: photo.id }] });

    expect((await del(talia, `/api/v1/loans/${loan.id}`, 1)).statusCode).toBe(403);
    const gone = await del(louis, `/api/v1/loans/${loan.id}`, 1);
    expect(gone.statusCode).toBe(204);
    expect((await thingView(bike.id)).derivedState).toEqual([]);
    const [deleted] = (await eventsOf(db, home.id, loan.id)).filter(
      (e) => e.action === 'loan.delete',
    );
    expect(deleted?.diff).toMatchObject({ direction: { before: 'out', after: null } });
    ok(await undo(louis, gone.headers['x-kept-audit-event'] as string));
    const back = ok(await call(t, `/api/v1/things/${bike.id}/loans`, { as: louis }));
    expect((back.items as Json[])[0]).toMatchObject({
      id: loan.id,
      conditionOut: [{ id: photo.id }],
    });
    expect((await thingView(bike.id)).derivedState).toEqual(['lent']);
  });
});

describe('GET /api/v1/loans and the person page', () => {
  it('lists across locations, overdue first, with counts; the person page splits has, lent us, history', async () => {
    const kayak = await createThing(t, ibrahim, home, { name: 'Kayak' });
    const [peter] = await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Peter') RETURNING id`,
      [home.accountId],
    );
    const out = (
      await lend(louis, kayak.id, {
        person: { id: peter?.id },
        startedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        dueOn: addDays(today, -2),
      })
    ).loan as Json;
    const lentUs = ok(
      await post(louis, `/api/v1/locations/${home.id}/borrow`, {
        name: 'Projector',
        target: { placeId: home.unplacedId },
        person: { id: peter?.id },
      }),
      201,
    ).loan as Json;
    const paddle = await createThing(t, ibrahim, home, { name: 'Paddle' });
    const done = (await lend(louis, paddle.id, { person: { id: peter?.id } })).loan as Json;
    ok(await post(louis, `/api/v1/loans/${done.id}/return`, {}, 1));

    const all = ok(await call(t, `/api/v1/loans?personId=${peter?.id}`, { as: talia }));
    const ids = (all.items as Json[]).map((l) => l.id);
    expect(ids[0]).toBe(out.id); // overdue first
    expect(ids.at(-1)).toBe(done.id); // returned last
    expect(all.counts).toEqual({ out: 1, in: 1, overdue: 1 });
    expect((all.items as Json[])[0]).toMatchObject({
      thing: { id: kayak.id, name: 'Kayak' },
      overdue: true,
    });
    const search = ok(await call(t, `/api/v1/loans?q=projector`, { as: talia }));
    expect((search.items as Json[]).map((l) => l.id)).toEqual([lentUs.id]);

    const page = ok(await call(t, `/api/v1/people/${peter?.id}/loans`, { as: talia }));
    expect((page.has as Json[]).map((l) => l.id)).toEqual([out.id]);
    expect((page.lentUs as Json[]).map((l) => l.id)).toEqual([lentUs.id]);
    expect((page.history as Json[]).map((l) => l.id)).toEqual([done.id]);
    expect(page.next_cursor).toBeNull();
    expect(((await call(t, '/api/v1/loans', { as: alfred })).json() as Json).items).toEqual([]);
  });
});

describe('the offline snapshot (Q34)', () => {
  async function pull(as: Person, cursor?: string) {
    const things = new Map<string, SnapThing>();
    let next = cursor;
    for (let i = 0; i < 50; i++) {
      const res = await call(
        t,
        `/api/v1/sync/snapshot${next ? `?cursor=${encodeURIComponent(next)}` : ''}`,
        { as },
      );
      expect(res.statusCode, res.body).toBe(200);
      const p = res.json() as SnapshotPage;
      for (const th of p.changes.things) things.set(th.id, th);
      next = p.nextCursor;
      if (p.complete) return { things, cursor: next as string };
    }
    throw new Error('the snapshot never completed');
  }

  it('sends lent and the loan (a name and a due date only) in the next delta, and clears them on return', async () => {
    const grill = await createThing(t, ibrahim, home, { name: 'Grill' });
    const first = await pull(louis);
    await own(
      db,
      `INSERT INTO public.person_contacts (person_id, owner_account_id, phone, email)
       VALUES ($1, $2, '+20100000000', 'murdock@example.com') ON CONFLICT DO NOTHING`,
      [murdock, home.accountId],
    );
    const loan = (
      await lend(louis, grill.id, { person: { id: murdock }, dueOn: addDays(today, 3) })
    ).loan as Json;
    const lent = await pull(louis, first.cursor);
    const snap = lent.things.get(grill.id);
    expect(snap).toMatchObject({
      derived: ['lent'],
      loan: { direction: 'out', personName: 'Murdock', dueOn: addDays(today, 3) },
    });
    expect(JSON.stringify(snap)).not.toMatch(/murdock@example\.com|\+20100000000/);
    ok(await post(louis, `/api/v1/loans/${loan.id}/return`, {}, 1));
    const back = await pull(louis, lent.cursor);
    const cleared = back.things.get(grill.id);
    expect(cleared).toBeDefined();
    expect(cleared?.derived).toBeUndefined();
    expect(cleared?.loan).toBeUndefined();
  });
});
