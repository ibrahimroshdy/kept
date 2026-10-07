import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { op, sent } from '../../test/sync-ops.js';
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

// Step 5, T8 through the front door, as the web calls it (apps/web/src/api/vehicles/types.ts:
// ThingMeterV5, UpdateMeterBodyV5, CreateReadingBodyV5, ReadingRow, ReadingsParams, ProofsPage):
// "It's right" for a jump (Q9), proof photos on their reading (Q10, D195) and the proof strip,
// owned readings (Q11), reading undo (D150), usage estimates (Q8) and the stale-reading nudge's
// setting (Q19).

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owner of Garage
let bruce: Person; // admin
let alfred: Person; // member: he logs the Corolla's readings
let talia: Person; // viewer
let garage: Loc;
let carType: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  alfred = await person(t, db, 'alfred');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, alfred, 'Alfred');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, garage.id, bruce.userId, 'admin');
  await join(db, garage.id, alfred.userId, 'member');
  await join(db, garage.id, talia.userId, 'viewer');
  // AI capture off: a READING capture with a typed value (capture/service.ts).
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled)
     VALUES ($1, 'ai_capture', false)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
    [garage.id],
  );
  carType = await builtinType(db, 'car');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

type Car = { id: string; meterId: string };

async function newCar(name = 'Corolla'): Promise<Car> {
  const thing = await createThing(t, ibrahim, garage, { name, typeId: carType });
  return { id: thing.id, meterId: ((thing.meters as { id: string }[])[0] as { id: string }).id };
}

const daysAgo = (days: number, hour = 9) => {
  const at = new Date(Date.now() - days * 86_400_000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
};

const log = (as: Person, meterId: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/meters/${meterId}/readings`, { as, body });

async function logOk(as: Person, car: Car, value: string, takenAt: string): Promise<Json> {
  return ok(await log(as, car.meterId, { value, takenAt }), 201);
}

async function photo(as: Person): Promise<string> {
  const res = await upload(t, as, garage.id, await uniqueJpeg(), { cls: 'evidence' });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const meterOf = async (as: Person, car: Car) => {
  const view = ok(await call(t, `/api/v1/things/${car.id}`, { as }));
  return (view.meters as Json[]).find((m) => m.id === car.meterId) as Json;
};

const readings = async (as: Person, car: Car, q = '') =>
  ok(await call(t, `/api/v1/meters/${car.meterId}/readings?${q}`, { as })).items as Json[];

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

describe("POST /api/v1/meters/:id/readings: It's right, proof photos, undo", () => {
  it('keeps an implausible jump for review, unless confirmed; backwards is never confirmable', async () => {
    const car = await newCar();
    await logOk(alfred, car, '50000', daysAgo(2));
    const jump = ok(await log(alfred, car.meterId, { value: '58000', takenAt: daysAgo(1) }), 201);
    expect(jump).toMatchObject({ state: 'needs_review', reason: 'implausible_jump' });
    const sure = ok(
      await log(alfred, car.meterId, { value: '66000', takenAt: daysAgo(0), confirmJump: true }),
      201,
    );
    expect(sure.state).toBe('accepted');
    expect(sure.reason).toBeUndefined();
    const [event] = (await eventsOf(db, garage.id, (sure.reading as Json).id)).filter(
      (e) => e.action === 'reading.create',
    );
    expect(event?.diff.confirmed).toMatchObject({ after: 'implausible_jump' });
    const back = await log(alfred, car.meterId, {
      value: '40000',
      takenAt: new Date().toISOString(),
      confirmJump: true,
    });
    expect(back.statusCode).toBe(409);
    expect(back.json()).toMatchObject({ code: 'conflict', reason: 'lower_than_previous' });
  });

  it('hangs the proof photo on the reading, and answers its Undo; undo removes it unless changed', async () => {
    const car = await newCar();
    const fileId = await photo(alfred);
    const res = await log(alfred, car.meterId, {
      value: '52340',
      takenAt: daysAgo(0),
      proofFileId: fileId,
    });
    const made = ok(res, 201);
    const reading = made.reading as Json;
    expect(reading.source).toBe('photo');
    const undoRef = made.undo as { eventId: string; until: string };
    expect(undoRef.eventId).toBe(res.headers['x-kept-audit-event']);
    const [proof] = await own<{ meter_reading_id: string; thing_id: string | null; role: string }>(
      db,
      'SELECT meter_reading_id, thing_id, role FROM public.attachments WHERE file_id = $1',
      [fileId],
    );
    expect(proof).toEqual({ meter_reading_id: reading.id, thing_id: null, role: 'proof' });
    const [row] = await readings(alfred, car);
    expect(row).toMatchObject({
      id: reading.id,
      proof: { fileId, attachmentId: expect.any(String) },
    });

    ok(await undo(alfred, undoRef.eventId));
    expect(await readings(alfred, car)).toEqual([]);

    // Edited since: refused.
    const again = ok(await log(alfred, car.meterId, { value: '52400', takenAt: daysAgo(0) }), 201);
    ok(
      await call(t, `/api/v1/readings/${(again.reading as Json).id}`, {
        as: alfred,
        method: 'PATCH',
        body: { note: 'Checked twice' },
      }),
    );
    const refused = await undo(alfred, (again.undo as { eventId: string }).eventId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'undo_refused', reason: 'changed_since' });
  });

  it('undoes a delete: the reading comes back with its proof, unless it no longer fits', async () => {
    const car = await newCar();
    const fileId = await photo(alfred);
    const made = ok(
      await log(alfred, car.meterId, { value: '30000', takenAt: daysAgo(5), proofFileId: fileId }),
      201,
    );
    const id = (made.reading as Json).id;
    const del = await call(t, `/api/v1/readings/${id}`, { as: alfred, method: 'DELETE' });
    expect(del.statusCode).toBe(204);
    const eventId = del.headers['x-kept-audit-event'] as string;
    expect(eventId).toBeTruthy();
    ok(await undo(alfred, eventId));
    const [back] = await readings(alfred, car);
    expect(back).toMatchObject({ id, value: '30000', proof: { fileId } });

    // Deleted again, then a lower reading after it: putting it back would run backwards.
    const del2 = await call(t, `/api/v1/readings/${id}`, { as: alfred, method: 'DELETE' });
    await logOk(alfred, car, '29000', daysAgo(1));
    const refused = await undo(alfred, del2.headers['x-kept-audit-event'] as string);
    expect(refused.statusCode).toBe(409);
    expect((await readings(alfred, car)).map((r) => r.value)).toEqual(['29000']);
  });
});

describe('owned readings (Q11)', () => {
  it("refuses a fill's and a service's reading on the readings routes (409 reading_owned)", async () => {
    const car = await newCar();
    const reading = ok(await log(alfred, car.meterId, { value: '41000', takenAt: daysAgo(3) }), 201)
      .reading as Json;
    const fill = newId();
    await own(
      db,
      `INSERT INTO public.fuel_entries (id, location_id, thing_id, taken_at, amount, unit,
                                        meter_reading_id, logged_by)
       VALUES ($1, $2, $3, now() - interval '3 days', 40, 'L', $4, $5)`,
      [fill, garage.id, car.id, reading.id, alfred.userId],
    );
    const patch = await call(t, `/api/v1/readings/${reading.id}`, {
      as: alfred,
      method: 'PATCH',
      body: { value: '41100' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({
      code: 'reading_owned',
      ownedBy: { type: 'fuel', id: fill },
    });
    const del = await call(t, `/api/v1/readings/${reading.id}`, { as: bruce, method: 'DELETE' });
    expect(del.statusCode).toBe(409);
    const [row] = await readings(talia, car);
    expect(row?.ownedBy).toEqual({ type: 'fuel', id: fill });

    const service = ok(
      await call(t, '/api/v1/service-records', {
        as: alfred,
        body: {
          subject: { thingId: car.id },
          servicedOn: daysAgo(0).slice(0, 10),
          reading: { meterId: car.meterId, value: '41500' },
        },
      }),
      201,
    );
    const owned = (service.reading as Json).id;
    const svcDel = await call(t, `/api/v1/readings/${owned}`, { as: alfred, method: 'DELETE' });
    expect(svcDel.json()).toMatchObject({
      code: 'reading_owned',
      ownedBy: { type: 'service', id: service.id },
    });
    // Through its owner it changes.
    const edited = ok(
      await call(t, `/api/v1/service-records/${service.id}`, {
        as: alfred,
        method: 'PATCH',
        body: { reading: { meterId: car.meterId, value: '41600' } },
        headers: { 'if-match': String(service.rowVersion) },
      }),
    );
    expect((edited.reading as Json).value).toBe('41600');
  });
});

describe('proofs and the readings list', () => {
  it('lists the strip newest first: typed, synced and captured proofs on readings, and step 3 proofs on the thing', async () => {
    const car = await newCar();
    // A step-3 proof, still on the thing (Q10).
    const old = await photo(ibrahim);
    await own(
      db,
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by, created_at)
       VALUES ($1, $2, $3, 'proof', $4, now() - interval '20 days')`,
      [garage.id, old, car.id, ibrahim.userId],
    );
    // A READING capture with a typed value (AI off).
    const captured = await photo(alfred);
    const cap = await call(t, '/api/v1/captures', {
      as: alfred,
      body: {
        id: newId(),
        locationId: garage.id,
        target: { unplaced: true },
        mode: 'reading',
        batchId: newId(),
        attachToThingId: car.id,
        files: [{ fileId: captured, role: 'proof' }],
        readingValue: '60000',
      },
      headers: { 'idempotency-key': newId() },
    });
    expect(cap.statusCode, cap.body).toBe(201);
    // A `log_reading` op from the phone, with its proof, taken earlier.
    const synced = await photo(alfred);
    const results = await sent(t, alfred, [
      op('log_reading', garage.id, {
        id: newId(),
        meterId: car.meterId,
        value: '59000',
        takenAt: daysAgo(2),
        proofFileId: synced,
      }),
    ]);
    expect(results[0]).toMatchObject({ outcome: 'applied' });

    const strip = ok(await call(t, `/api/v1/meters/${car.meterId}/proofs`, { as: talia }));
    expect(strip.items).toEqual([
      expect.objectContaining({
        value: '60000',
        fileId: captured,
        readingId: expect.any(String),
        by: { displayName: 'Alfred' },
      }),
      expect.objectContaining({ value: '59000', fileId: synced, readingId: expect.any(String) }),
      expect.objectContaining({
        value: null,
        readingId: null,
        fileId: old,
        by: { displayName: 'Ibrahim' },
      }),
    ]);
    const onThing = await own(
      db,
      `SELECT 1 FROM public.attachments WHERE thing_id = $1 AND file_id = ANY ($2::uuid[])`,
      [car.id, [captured, synced]],
    );
    expect(onThing).toHaveLength(0);
    const page1 = ok(await call(t, `/api/v1/meters/${car.meterId}/proofs?limit=2`, { as: alfred }));
    const page2 = ok(
      await call(t, `/api/v1/meters/${car.meterId}/proofs?limit=2&cursor=${page1.next_cursor}`, {
        as: alfred,
      }),
    );
    expect((page2.items as Json[]).map((x) => x.fileId)).toEqual([old]);
    expect(page2.next_cursor).toBeNull();
    expect((await call(t, `/api/v1/meters/${newId()}/proofs`, { as: alfred })).statusCode).toBe(
      404,
    );
  });

  it('follows a synced proof whose bytes the location already had to that file, by its hash', async () => {
    const car = await newCar('Elantra');
    await logOk(alfred, car, '30000', daysAgo(10));
    // The photo is already in the Garage (uploaded online, say); the queue's own upload of the
    // same bytes under its id answers that file (deduplicatedFrom) and makes none.
    const bytes = await uniqueJpeg();
    const first = await upload(t, alfred, garage.id, bytes, { cls: 'evidence' });
    expect(first.statusCode, first.body).toBe(201);
    const existing = (first.json() as { id: string }).id;
    const queued = newId();
    const again = await upload(t, alfred, garage.id, bytes, { cls: 'evidence', id: queued });
    expect(again.json()).toMatchObject({ deduplicatedFrom: existing });
    const results = await sent(t, alfred, [
      op('log_reading', garage.id, {
        id: newId(),
        meterId: car.meterId,
        value: '30500',
        takenAt: daysAgo(1),
        proofFileId: queued,
        proofSha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ]);
    expect(results[0]).toMatchObject({ outcome: 'applied' });
    const strip = ok(await call(t, `/api/v1/meters/${car.meterId}/proofs`, { as: alfred }));
    expect(strip.items).toEqual([expect.objectContaining({ value: '30500', fileId: existing })]);
  });

  it('filters readings by date, source and state, and turns the order around', async () => {
    const car = await newCar();
    await logOk(alfred, car, '10000', daysAgo(40));
    await logOk(alfred, car, '11000', daysAgo(10));
    const jump = ok(await log(alfred, car.meterId, { value: '30000', takenAt: daysAgo(9) }), 201);
    const values = async (q: string) => (await readings(alfred, car, q)).map((r) => r.value);
    expect(await values('')).toEqual(['30000', '11000', '10000']);
    expect(await values('dir=asc&sort=takenAt')).toEqual(['10000', '11000', '30000']);
    expect(await values('f.when=month')).toEqual(['30000', '11000']);
    expect(await values('f.state=needs_review')).toEqual(['30000']);
    expect(await values('f.state=needs_review&not=state')).toEqual(['11000', '10000']);
    expect(await values('f.source=photo')).toEqual([]);
    expect(await values('f.source=manual&limit=1')).toEqual(['30000']);
    expect(jump.state).toBe('needs_review');
  });
});

describe('estimates and the nudge (Q8, Q19)', () => {
  it('estimates about 62 km a day from 90 days of readings; stale at 34 days, unknown at 70', async () => {
    const car = await newCar();
    // 124 days back to 34 days back: 90 days at 62 km a day.
    for (const [ago, value] of [
      [124, 40000],
      [94, 41860],
      [64, 43720],
      [34, 45580],
    ] as const) {
      await logOk(alfred, car, String(value), daysAgo(ago));
    }
    const m = await meterOf(talia, car);
    expect(m.nudgeDays).toBe(30);
    expect(m.estimate).toMatchObject({ basisDays: 90, ageDays: 34, advice: 'stale' });
    expect(Number((m.estimate as Json).perDay)).toBeCloseTo(62, 1);

    const older = await newCar('Old Corolla');
    await logOk(alfred, older, '10000', daysAgo(100));
    await logOk(alfred, older, '12000', daysAgo(70));
    expect((await meterOf(talia, older)).estimate).toEqual({
      perDay: null,
      basisDays: 30,
      ageDays: 70,
      advice: 'unknown',
    });
    const none = await newCar('New Corolla');
    expect((await meterOf(talia, none)).estimate).toEqual({
      perDay: null,
      basisDays: null,
      ageDays: null,
      advice: 'none',
    });
  });

  // catalogue: PATCH /api/v1/meters/:id
  it('sets the nudge in 7 to 365 days or none, for owners and admins, audited', async () => {
    const car = await newCar();
    const m = await meterOf(ibrahim, car);
    const patch = (as: Person, body: unknown, version: number) =>
      call(t, `/api/v1/meters/${car.meterId}`, {
        as,
        method: 'PATCH',
        body,
        headers: { 'if-match': String(version) },
      });
    expect((await patch(alfred, { nudgeDays: 14 }, m.rowVersion as number)).statusCode).toBe(403);
    expect((await patch(bruce, { nudgeDays: 6 }, m.rowVersion as number)).statusCode).toBe(400);
    const set = ok(await patch(bruce, { nudgeDays: 14 }, m.rowVersion as number));
    expect(set.nudgeDays).toBe(14);
    const off = ok(await patch(ibrahim, { nudgeDays: null }, set.rowVersion as number));
    expect(off.nudgeDays).toBeNull();
    expect((await meterOf(talia, car)).nudgeDays).toBeNull();
    const events = (await eventsOf(db, garage.id, car.meterId)).filter(
      (e) => e.action === 'meter.update',
    );
    expect(events.map((e) => e.diff.nudge_days)).toMatchObject([
      { before: 30, after: 14 },
      { before: 14, after: null },
    ]);
  });
});
