import { newId } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  setDisplayName,
} from '../../test/things.js';

// Task 16 through the front door, as the web calls it (apps/web/src/api/inventory/{types,
// paths}.ts, mock/things.ts, components/things/meters-section.tsx): meters and readings (D113),
// ordered by when they were taken and checked against their neighbours (D112), refused at entry
// when they run backwards (D26), a jump kept for review, and meter replacement (D52).

let db: TestDb;
let t: TestApp;

let ann: Person; // owner of `home`
let ada: Person; // admin of `home`
let mo: Person; // member of `home`
let vic: Person; // viewer of `home`
let bob: Person; // owner of his own home, nothing of Ann's
let home: Loc;
let bobs: Loc;
let carType: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  ada = await person(t, db, 'ada');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  await setDisplayName(db, ann, 'Ann');
  await setDisplayName(db, mo, 'Alfred');
  home = await createLocation(t, db, ann, 'complete');
  bobs = await createLocation(t, db, bob, 'complete', 'Bob home');
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  carType = await builtinType(db, 'car');
});

type Car = { thing: Json; meterId: string };

/** A car (its type gives it an odometer, D113). */
async function newCar(name = 'Corolla'): Promise<Car> {
  const thing = await createThing(t, ann, home, { name, typeId: carType });
  const meters = thing.meters as { id: string }[];
  return { thing, meterId: (meters[0] as { id: string }).id };
}

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();

const log = (as: Person, meterId: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/meters/${meterId}/readings`, { as, body });

async function logOk(as: Person, meterId: string, value: string, takenAt: string): Promise<Json> {
  const res = ok(await log(as, meterId, { value, takenAt }), 201);
  return res.reading as Json;
}

const meterOf = async (as: Person, thingId: string, meterId: string) => {
  const view = ok(await call(t, `/api/v1/things/${thingId}`, { as }));
  return (view.meters as Json[]).find((m) => m.id === meterId) as Json;
};

const readingRows = (meterId: string) =>
  own<{ id: string; value: string; state: string; logged_by: string | null }>(
    db,
    `SELECT id, value::text AS value, state, logged_by FROM public.meter_readings
      WHERE meter_id = $1 ORDER BY taken_at`,
    [meterId],
  );

describe('POST /api/v1/things/:id/meters', () => {
  // catalogue: POST /api/v1/things/:id/meters
  it('adds a meter for an admin, audited on the thing (meters.manage)', async () => {
    const pump = await createThing(t, ann, home, { name: 'Water pump' });
    const res = await call(t, `/api/v1/things/${pump.id}/meters`, {
      as: ada,
      body: { kind: 'custom', unit: 'm³', label: 'Flow', maxPerDay: 12.5 },
    });
    const meter = ok(res, 201);
    expect(meter).toEqual({
      id: expect.any(String),
      thingId: pump.id,
      kind: 'custom',
      unit: 'm³',
      label: 'Flow',
      latest: null,
      needsReview: 0,
      maxPerDay: 12.5,
      offset: '0',
      rowVersion: 1,
      // Step 5 (T8): the nudge's default and the (empty) estimate.
      nudgeDays: 30,
      estimate: { perDay: null, basisDays: null, ageDays: null, advice: 'none' },
    });
    const [event] = await eventsOf(db, home.id, meter.id);
    expect(event).toMatchObject({ action: 'meter.create', actor_id: ada.userId });
    expect(event?.diff).toMatchObject({
      kind: { after: 'custom' },
      unit: { after: 'm³' },
      max_per_day: { after: 12.5 },
    });
    const [root] = await own<{ root_thing_id: string }>(
      db,
      'SELECT root_thing_id FROM public.audit_events WHERE entity_id = $1',
      [meter.id],
    );
    expect(root?.root_thing_id).toBe(pump.id);
    const view = ok(await call(t, `/api/v1/things/${pump.id}`, { as: vic }));
    expect(view.meters).toEqual([expect.objectContaining({ id: meter.id, label: 'Flow' })]);
  });

  it('is refused to members and viewers (403), and to outsiders as a 404', async () => {
    const pump = await createThing(t, ann, home, { name: 'Generator' });
    const body = { kind: 'hours', unit: 'h' };
    for (const as of [mo, vic]) {
      const res = await call(t, `/api/v1/things/${pump.id}/meters`, { as, body });
      expect(res.statusCode, res.body).toBe(403);
    }
    const res = await call(t, `/api/v1/things/${pump.id}/meters`, { as: bob, body });
    expect(res.statusCode).toBe(404);
    const trashed = await createThing(t, ann, home, { name: 'Old pump' });
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [trashed.id]);
    const gone = await call(t, `/api/v1/things/${trashed.id}/meters`, { as: ann, body });
    expect(gone.statusCode).toBe(404);
  });

  it('needs a single thing (D10), a known kind and a short unit', async () => {
    const screws = await createThing(t, ann, home, { name: 'Screws', quantity: 40 });
    const many = await call(t, `/api/v1/things/${screws.id}/meters`, {
      as: ann,
      body: { kind: 'custom', unit: 'uses' },
    });
    expect(many.statusCode).toBe(409);
    expect(many.json().hint).toMatch(/quantity is 1/);
    const lamp = await createThing(t, ann, home, { name: 'Lamp' });
    for (const body of [
      { kind: 'speed', unit: 'km' },
      { kind: 'custom', unit: 'a-very-long-unit' },
      { kind: 'custom', unit: 'h', maxPerDay: 0 },
      { kind: 'custom', unit: 'h', maxPerDay: 1.2345 },
    ]) {
      const res = await call(t, `/api/v1/things/${lamp.id}/meters`, { as: ann, body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('PATCH /api/v1/meters/:id', () => {
  // catalogue: PATCH /api/v1/meters/:id
  it('changes the label and daily limit with If-Match, audited', async () => {
    const { meterId } = await newCar('Label car');
    const res = await call(t, `/api/v1/meters/${meterId}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': '1' },
      body: { label: 'Odometer (front)', maxPerDay: 800 },
    });
    const meter = ok(res);
    expect(meter).toMatchObject({ label: 'Odometer (front)', maxPerDay: 800, rowVersion: 2 });
    const events = await eventsOf(db, home.id, meterId);
    expect(events.at(-1)).toMatchObject({ action: 'meter.update', actor_id: ann.userId });
    expect(events.at(-1)?.diff).toMatchObject({
      label: { before: null, after: 'Odometer (front)' },
      max_per_day: { before: null, after: 800 },
    });
  });

  it('answers 428 without If-Match, 412 with a stale one, 403 to a member', async () => {
    const { meterId } = await newCar('Stale car');
    const url = `/api/v1/meters/${meterId}`;
    const none = await call(t, url, { method: 'PATCH', as: ann, body: { label: 'A' } });
    expect(none.statusCode).toBe(428);
    ok(
      await call(t, url, {
        method: 'PATCH',
        as: ada,
        headers: { 'if-match': '1' },
        body: { label: 'A' },
      }),
    );
    const stale = await call(t, url, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': '1' },
      body: { label: 'B' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ conflicts: ['label'], row_version: 2 });
    const member = await call(t, url, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': '2' },
      body: { label: 'C' },
    });
    expect(member.statusCode).toBe(403);
  });
});

describe('POST /api/v1/meters/:id/readings', () => {
  // catalogue: POST /api/v1/meters/:id/readings
  it('logs a reading stamped with the caller, audited, and updates the meter', async () => {
    const { thing, meterId } = await newCar();
    const id = newId();
    const res = await log(mo, meterId, {
      id,
      value: '53000.500',
      takenAt: at(1),
      note: 'Full tank',
    });
    const body = ok(res, 201);
    expect(body).toEqual({
      reading: {
        id,
        value: '53000.5',
        takenAt: at(1),
        source: 'manual',
        state: 'accepted',
        reviewReason: null,
        loggedBy: { displayName: 'Alfred' },
        note: 'Full tank',
        rowVersion: 1,
      },
      state: 'accepted',
      // Step 5 (T8, D150): a reading logged here is undoable.
      undo: { eventId: expect.any(String), until: expect.any(String) },
    });
    const [row] = await readingRows(meterId);
    expect(row).toMatchObject({ id, value: '53000.500', logged_by: mo.userId });
    const [event] = await eventsOf(db, home.id, id);
    expect(event).toMatchObject({ action: 'reading.create', actor_id: mo.userId });
    expect(event?.diff).toMatchObject({
      value: { after: '53000.5' },
      state: { after: 'accepted' },
      meter_id: { after: meterId },
    });
    expect(await meterOf(vic, thing.id, meterId)).toMatchObject({
      latest: { value: '53000.5', takenAt: at(1) },
      needsReview: 0,
    });
  });

  it('refuses a reading lower than the one before it, with a clear hint (D26)', async () => {
    const { meterId } = await newCar('Backwards car');
    await logOk(ann, meterId, '53000', at(1));
    const res = await log(mo, meterId, { value: '52999.999', takenAt: at(2) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
      reason: 'lower_than_previous',
      previous: { value: '53000', takenAt: at(1) },
    });
    expect(res.json().hint).toMatch(/Lower than the reading before it \(53000 km\)/);
    expect(res.json().hint).toMatch(/meter was replaced/);
    expect(await readingRows(meterId)).toHaveLength(1);
    // Equal is not backwards: the car stood still.
    await logOk(mo, meterId, '53000', at(3));
  });

  it('accepts a late reading that fits between its neighbours, and refuses one that does not (D112)', async () => {
    const { thing, meterId } = await newCar('Late car');
    await logOk(ann, meterId, '1000', at(1));
    await logOk(ann, meterId, '2000', at(10));
    const late = ok(await log(mo, meterId, { value: '1500', takenAt: at(5) }), 201);
    expect(late.state).toBe('accepted');
    const high = await log(mo, meterId, { value: '2500', takenAt: at(6) });
    expect(high.statusCode).toBe(409);
    expect(high.json()).toMatchObject({
      reason: 'higher_than_next',
      next: { value: '2000', takenAt: at(10) },
    });
    // The latest is still the one taken last, not the one logged last.
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({
      latest: { value: '2000', takenAt: at(10) },
    });
  });

  it('keeps an implausible jump for review instead of refusing it (D26, §3.4)', async () => {
    const { thing, meterId } = await newCar('Jumpy car');
    await logOk(ann, meterId, '1000', at(1));
    const res = ok(await log(mo, meterId, { value: '5000', takenAt: at(2) }), 201);
    expect(res).toMatchObject({
      state: 'needs_review',
      reason: 'implausible_jump',
      reading: { state: 'needs_review', reviewReason: 'implausible_jump' },
    });
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({
      latest: { value: '1000' },
      needsReview: 1,
    });
    // 1,500 km a day is still plausible.
    const fine = ok(await log(mo, meterId, { value: '2500', takenAt: at(2, 10) }), 201);
    expect(fine.state).toBe('accepted');
  });

  it("uses the meter's own daily limit when it has one", async () => {
    const { meterId } = await newCar('Slow car');
    ok(
      await call(t, `/api/v1/meters/${meterId}`, {
        method: 'PATCH',
        as: ann,
        headers: { 'if-match': '1' },
        body: { maxPerDay: 100 },
      }),
    );
    await logOk(ann, meterId, '1000', at(1));
    const res = ok(await log(ann, meterId, { value: '1250', takenAt: at(3) }), 201);
    expect(res.reason).toBe('implausible_jump');
  });

  it('clamps a reading taken in the future to now (D112)', async () => {
    const { meterId } = await newCar('Future car');
    const before = Date.now();
    const res = ok(await log(ann, meterId, { value: '10', takenAt: '2099-01-01T00:00:00Z' }), 201);
    const taken = Date.parse((res.reading as Json).takenAt as string);
    expect(taken).toBeGreaterThanOrEqual(before - 1000);
    expect(taken).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('keeps numeric(14,3) precision and refuses what it would have to round (§7.13)', async () => {
    const { meterId } = await newCar('Precise car');
    const max = await logOk(ann, meterId, '99999999999.999', at(1));
    expect(max.value).toBe('99999999999.999');
    for (const value of ['1.2345', '-1', '100000000000', '1e5', '٥٣٠٠٠', '']) {
      const res = await log(ann, meterId, { value, takenAt: at(2) });
      expect(res.statusCode, value).toBe(400);
    }
    // Who logged it and when it arrived are the server's, never the client's.
    const forged = await log(ann, meterId, {
      value: '99999999999.999',
      takenAt: at(2),
      loggedBy: bob.userId,
    });
    expect(forged.statusCode).toBe(400);
  });

  it('is refused to a viewer (403) and to an outsider as a 404', async () => {
    const { meterId } = await newCar('Guarded car');
    const viewer = await log(vic, meterId, { value: '1', takenAt: at(1) });
    expect(viewer.statusCode).toBe(403);
    const outsider = await log(bob, meterId, { value: '1', takenAt: at(1) });
    expect(outsider.statusCode).toBe(404);
    expect(await readingRows(meterId)).toEqual([]);
  });
});

describe('GET /api/v1/meters/:id/readings', () => {
  it('lists newest taken first, a page at a time, to anyone who can see the thing', async () => {
    const { meterId } = await newCar('Listed car');
    await logOk(ann, meterId, '100', at(1));
    await logOk(mo, meterId, '300', at(3));
    await logOk(ann, meterId, '200', at(2));
    const url = `/api/v1/meters/${meterId}/readings`;
    const first = ok(await call(t, `${url}?limit=2`, { as: vic }));
    expect((first.items as Json[]).map((r) => r.value)).toEqual(['300', '200']);
    expect((first.items as Json[])[0]).toMatchObject({ loggedBy: { displayName: 'Alfred' } });
    const next = ok(
      await call(t, `${url}?limit=2&cursor=${encodeURIComponent(first.next_cursor as string)}`, {
        as: vic,
      }),
    );
    expect((next.items as Json[]).map((r) => r.value)).toEqual(['100']);
    expect(next.next_cursor).toBeNull();
    expect((await call(t, url, { as: bob })).statusCode).toBe(404);
  });

  it('answers 400 for a cursor it did not make, never a 500 (review #36)', async () => {
    const { meterId } = await newCar('Cursor car');
    const url = `/api/v1/meters/${meterId}/readings`;
    const forged = (k: unknown) => Buffer.from(JSON.stringify({ k })).toString('base64url');
    for (const k of [
      ['not a date', 'x'],
      [new Date().toISOString(), 'not-a-uuid'],
      5,
      ['a'],
      null,
    ]) {
      const res = await call(t, `${url}?cursor=${forged(k)}`, { as: ann });
      expect(res.statusCode, JSON.stringify(k)).toBe(400);
    }
  });

  it("answers 404 for a trashed thing's meter", async () => {
    const { thing, meterId } = await newCar('Trashed car');
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [thing.id]);
    const res = await call(t, `/api/v1/meters/${meterId}/readings`, { as: ann });
    expect(res.statusCode).toBe(404);
  });
});

describe('needs review: Keep, Edit, Discard (D112)', () => {
  /** A car with 1000 on day 1 and a jump to 9000 on day 2 waiting for review. */
  async function jumpy(by: Person = mo) {
    const car = await newCar('Review car');
    await logOk(ann, car.meterId, '1000', at(1));
    const jump = await logOk(by, car.meterId, '9000', at(2));
    expect(jump.state).toBe('needs_review');
    return { ...car, jump };
  }

  // catalogue: POST /api/v1/readings/:id/accept
  it('Keep accepts it, recomputes the meter, and is audited', async () => {
    const { thing, meterId, jump } = await jumpy();
    const kept = ok(await call(t, `/api/v1/readings/${jump.id}/accept`, { as: mo, body: {} }));
    expect(kept).toMatchObject({ id: jump.id, state: 'accepted', reviewReason: null });
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({
      latest: { value: '9000', takenAt: at(2) },
      needsReview: 0,
    });
    const events = await eventsOf(db, home.id, jump.id);
    expect(events.at(-1)).toMatchObject({ action: 'reading.accept', actor_id: mo.userId });
    expect(events.at(-1)?.diff).toMatchObject({
      state: { before: 'needs_review', after: 'accepted' },
      review_reason: { before: 'implausible_jump', after: null },
    });
    // Keeping it again changes nothing.
    const again = ok(await call(t, `/api/v1/readings/${jump.id}/accept`, { as: mo, body: {} }));
    expect(again.rowVersion).toBe(kept.rowVersion);
  });

  // catalogue: PATCH /api/v1/readings/:id
  it('Edit places the new value again: one that fits is accepted, audited', async () => {
    const { thing, meterId, jump } = await jumpy();
    const res = await call(t, `/api/v1/readings/${jump.id}`, {
      method: 'PATCH',
      as: mo,
      body: { value: '1900', note: 'Typo' },
    });
    expect(ok(res)).toMatchObject({
      value: '1900',
      state: 'accepted',
      reviewReason: null,
      note: 'Typo',
    });
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({
      latest: { value: '1900' },
      needsReview: 0,
    });
    const events = await eventsOf(db, home.id, jump.id);
    expect(events.at(-1)).toMatchObject({ action: 'reading.update', actor_id: mo.userId });
    expect(events.at(-1)?.diff).toMatchObject({
      value: { before: '9000', after: '1900' },
      state: { before: 'needs_review', after: 'accepted' },
    });
  });

  it('Edit refuses a value that runs backwards, and a note alone keeps the state', async () => {
    const { jump } = await jumpy();
    const url = `/api/v1/readings/${jump.id}`;
    const low = await call(t, url, { method: 'PATCH', as: mo, body: { value: '999' } });
    expect(low.statusCode).toBe(409);
    expect(low.json()).toMatchObject({ reason: 'lower_than_previous' });
    const noted = ok(await call(t, url, { method: 'PATCH', as: mo, body: { note: 'Checked' } }));
    expect(noted).toMatchObject({ state: 'needs_review', reviewReason: 'implausible_jump' });
    // A stale If-Match, when sent, is a 412.
    const stale = await call(t, url, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': '1' },
      body: { note: 'Again' },
    });
    expect(stale.statusCode).toBe(412);
  });

  // catalogue: DELETE /api/v1/readings/:id
  it('Discard deletes it, recomputes the meter, and is audited', async () => {
    const { thing, meterId, jump } = await jumpy();
    const res = await call(t, `/api/v1/readings/${jump.id}`, { method: 'DELETE', as: mo });
    expect(res.statusCode).toBe(204);
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({
      latest: { value: '1000' },
      needsReview: 0,
    });
    const events = await eventsOf(db, home.id, jump.id);
    expect(events.at(-1)).toMatchObject({ action: 'reading.delete', actor_id: mo.userId });
    expect(events.at(-1)?.diff).toMatchObject({ value: { before: '9000', after: null } });
  });

  it("lets a member change only their own; admins change anyone's (logs.edit-*)", async () => {
    const { jump } = await jumpy(ann);
    const url = `/api/v1/readings/${jump.id}`;
    const edit = await call(t, url, { method: 'PATCH', as: mo, body: { note: 'x' } });
    expect(edit.statusCode).toBe(403);
    const keep = await call(t, `${url}/accept`, { as: mo, body: {} });
    expect(keep.statusCode).toBe(403);
    const discard = await call(t, url, { method: 'DELETE', as: mo });
    expect(discard.statusCode).toBe(403);
    ok(await call(t, url, { method: 'PATCH', as: ada, body: { note: 'Admin checked' } }));

    const own2 = await jumpy(mo);
    const viewer = await call(t, `/api/v1/readings/${own2.jump.id}`, {
      method: 'DELETE',
      as: vic,
    });
    expect(viewer.statusCode).toBe(403);
    const admin = await call(t, `/api/v1/readings/${own2.jump.id}`, {
      method: 'DELETE',
      as: ada,
    });
    expect(admin.statusCode).toBe(204);
  });

  it('is a 404 to an outsider, whatever the route', async () => {
    const { jump } = await jumpy();
    const url = `/api/v1/readings/${jump.id}`;
    expect((await call(t, url, { method: 'PATCH', as: bob, body: { note: 'x' } })).statusCode).toBe(
      404,
    );
    expect((await call(t, `${url}/accept`, { as: bob, body: {} })).statusCode).toBe(404);
    expect((await call(t, url, { method: 'DELETE', as: bob })).statusCode).toBe(404);
  });

  it("counts toward Home's to-review attention (T29)", async () => {
    const { thing } = await jumpy();
    const rows = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.meter_readings r
         JOIN public.meters m ON m.id = r.meter_id
        WHERE m.thing_id = $1 AND r.state = 'needs_review'`,
      [thing.id],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('POST /api/v1/meters/:id/replaced (D52)', () => {
  // catalogue: POST /api/v1/meters/:id/replaced
  it('records a replacement so the new unit may read lower, audited', async () => {
    const { thing, meterId } = await newCar('Replaced car');
    await logOk(ann, meterId, '150000', at(1));
    const refused = await log(mo, meterId, { value: '20', takenAt: at(3) });
    expect(refused.statusCode).toBe(409);

    const res = await call(t, `/api/v1/meters/${meterId}/replaced`, {
      as: ada,
      body: { at: at(2), offset: '150000' },
    });
    const body = ok(res, 201);
    expect(body).toMatchObject({
      event: { at: at(2), offset: '150000' },
      meter: { id: meterId, offset: '150000', rowVersion: 2 },
    });
    const events = await eventsOf(db, home.id, meterId);
    expect(events.at(-1)).toMatchObject({ action: 'meter.replaced', actor_id: ada.userId });
    expect(events.at(-1)?.diff).toMatchObject({
      offset: { before: '0', after: '150000' },
      replaced_at: { after: at(2) },
    });

    const fits = ok(await log(mo, meterId, { value: '20', takenAt: at(3) }), 201);
    expect(fits.state).toBe('accepted');
    // Before the replacement, the old unit's series still applies.
    const before = await log(mo, meterId, { value: '20', takenAt: at(1, 12) });
    expect(before.statusCode).toBe(409);
    expect(await meterOf(ann, thing.id, meterId)).toMatchObject({ latest: { value: '20' } });
  });

  it('is for admins (meters.manage), and 404 to an outsider', async () => {
    const { meterId } = await newCar('Replace guard car');
    const url = `/api/v1/meters/${meterId}/replaced`;
    const body = { at: at(2), offset: '10' };
    expect((await call(t, url, { as: mo, body })).statusCode).toBe(403);
    expect((await call(t, url, { as: vic, body })).statusCode).toBe(403);
    expect((await call(t, url, { as: bob, body })).statusCode).toBe(404);
    expect(
      (await call(t, url, { as: ann, body: { at: at(2), offset: '1.2345' } })).statusCode,
    ).toBe(400);
  });
});

describe('isolation between tenants (RLS)', () => {
  it("never shows one household's meters or readings to another", async () => {
    const { meterId } = await newCar('Private car');
    const reading = await logOk(ann, meterId, '10', at(1));
    const bobsCar = await createThing(t, bob, bobs, { name: 'Bob car', typeId: carType });
    expect((bobsCar.meters as Json[]).length).toBe(1);
    // Bob's own session sees only his meter rows.
    const res = await call(t, `/api/v1/meters/${meterId}/readings`, { as: bob });
    expect(res.statusCode).toBe(404);
    const patch = await call(t, `/api/v1/meters/${meterId}`, {
      method: 'PATCH',
      as: bob,
      headers: { 'if-match': '1' },
      body: { label: 'Mine' },
    });
    expect(patch.statusCode).toBe(404);
    const [row] = await own<{ note: string | null }>(
      db,
      'SELECT note FROM public.meter_readings WHERE id = $1',
      [reading.id],
    );
    expect(row).toEqual({ note: null });
  });
});
