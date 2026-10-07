import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { COROLLA_FILLS, corollaShift, logCorollaFills, type Shift } from '../../test/corolla.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
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

// Step 5, T11 through the front door, as the web calls it (apps/web/src/api/vehicles/{types,
// paths}.ts: FuelRow, CreateFuelBody, CreateFuelResult, UpdateFuelBody, FuelSummary): fills and
// charges with their odometer, the station, the receipt, consumption full to full, prices and
// cost per km per currency, the money gate, the module, and undo.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owner of the Garage
let alfred: Person; // member
let louis: Person; // member
let bruce: Person; // admin
let talia: Person; // viewer
let garage: Loc; // complete: Vehicles, Fuel & charging, Money
let carType: string;
let shift: Shift;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  louis = await person(t, db, 'louis');
  bruce = await person(t, db, 'bruce');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, alfred, 'Alfred');
  await setDisplayName(db, bruce, 'Bruce');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, garage.id, alfred.userId, 'member');
  await join(db, garage.id, louis.userId, 'member');
  await join(db, garage.id, bruce.userId, 'admin');
  await join(db, garage.id, talia.userId, 'viewer');
  carType = await builtinType(db, 'car');
  shift = await corollaShift(db);
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

type Car = { id: string; meterId: string };

async function newCar(name = 'Toyota Corolla'): Promise<Car> {
  const thing = await createThing(t, ibrahim, garage, { name, typeId: carType });
  return { id: thing.id, meterId: ((thing.meters as { id: string }[])[0] as { id: string }).id };
}

const fillCall = (
  as: Person,
  thingId: string,
  body: Record<string, unknown>,
  key: string | null = newId(),
) =>
  call(t, `/api/v1/things/${thingId}/fuel`, {
    as,
    body: { id: newId(), takenAt: new Date().toISOString(), unit: 'L', isFull: true, ...body },
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });

async function fill(as: Person, car: Car, body: Record<string, unknown>) {
  return ok(await fillCall(as, car.id, body), 201) as unknown as {
    entry: Json & { rowVersion: number };
    reading?: { id: string; state: string };
    undo: { eventId: string; until: string };
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const list = (as: Person, car: Car, query = '') =>
  call(t, `/api/v1/things/${car.id}/fuel${query}`, { as });
const summary = (as: Person, car: Car, query = '') =>
  call(t, `/api/v1/things/${car.id}/fuel/summary${query}`, { as });
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

async function receipt(as: Person): Promise<string> {
  const res = await upload(t, as, garage.id, await uniqueJpeg(), { cls: 'evidence' });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('logging a fill', () => {
  // catalogue: POST /api/v1/things/:id/fuel
  it('writes the fill, its odometer (source fuel, owned by it) and its receipt, audited and undoable', async () => {
    const car = await newCar();
    const receiptId = await receipt(alfred);
    const out = await fill(alfred, car, {
      takenAt: daysAgo(2),
      amount: '42.559',
      cost: '968.22',
      vendor: { name: 'Ring Road Station' },
      reading: { value: '41778' },
      receiptFileId: receiptId,
      note: 'Full tank',
    });
    expect(out.entry).toMatchObject({
      amount: '42.559',
      unit: 'L',
      isFull: true,
      missedBefore: false,
      cost: '968.22',
      currency: 'EGP',
      pricePerUnit: '22.7501',
      vendor: { name: 'Ring Road Station' },
      reading: { value: '41778', state: 'accepted' },
      receipt: { fileId: receiptId },
      loggedBy: { displayName: 'Alfred' },
      rowVersion: 1,
    });
    expect(out.reading).toMatchObject({ state: 'accepted' });
    const [r] = await own<{ source: string; owner: string }>(
      db,
      `SELECT d.source, f.id AS owner FROM public.meter_readings d
         JOIN public.fuel_entries f ON f.meter_reading_id = d.id WHERE d.id = $1`,
      [out.reading?.id],
    );
    expect(r).toEqual({ source: 'fuel', owner: out.entry.id });
    const events = await eventsOf(db, garage.id, out.entry.id);
    expect(events.map((e) => e.action)).toEqual(['fuel.create']);
    expect(events[0]?.id).toBe(out.undo.eventId);
    expect(events[0]?.undoable_until).not.toBeNull();
    expect(events[0]?.diff.cost).toMatchObject({ after: '968.22', class: 'money' });
    // The same station by name is the same vendor, not a second one.
    const again = await fill(alfred, car, { amount: '20', vendor: { name: 'ring road station' } });
    expect((again.entry.vendor as { id: string }).id).toBe((out.entry.vendor as { id: string }).id);
  });

  it('refuses an odometer that runs backwards with the neighbour, and writes nothing', async () => {
    const car = await newCar();
    await fill(louis, car, { takenAt: daysAgo(5), amount: '40', reading: { value: '50000' } });
    const id = newId();
    const res = await fillCall(louis, car.id, {
      id,
      takenAt: daysAgo(1),
      amount: '30',
      reading: { value: '49000' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
      reason: 'lower_than_previous',
      previous: { value: '50000' },
    });
    expect(await own(db, 'SELECT 1 FROM public.fuel_entries WHERE id = $1', [id])).toEqual([]);
    expect(
      await own(db, `SELECT 1 FROM public.meter_readings WHERE meter_id = $1 AND value = 49000`, [
        car.meterId,
      ]),
    ).toEqual([]);
  });

  it('needs an Idempotency-Key, a meter for the odometer, a cost of 0 or more, an enabled currency, and a member', async () => {
    const car = await newCar();
    const noKey = await fillCall(louis, car.id, { amount: '10' }, null);
    expect(noKey.statusCode, noKey.body).toBe(400);
    const box = await createThing(t, ibrahim, garage, { name: 'Jerrycan' });
    const noMeter = await fillCall(louis, box.id, { amount: '10', reading: { value: '5' } });
    expect(noMeter.statusCode, noMeter.body).toBe(400);
    expect(noMeter.json()).toMatchObject({ code: 'fuel_needs_meter' });
    const zero = await fillCall(louis, car.id, { amount: '0' });
    expect(zero.statusCode).toBe(400);
    const unit = await fillCall(louis, car.id, { amount: '1', unit: 'l' });
    expect(unit.statusCode).toBe(400);
    const unknown = await fillCall(louis, car.id, { amount: '10', cost: '5', currency: 'JPY' });
    expect(unknown.statusCode, unknown.body).toBe(400);
    await own(db, `UPDATE public.currencies SET enabled = false WHERE code = 'CAD'`);
    try {
      const off = await fillCall(louis, car.id, { amount: '10', cost: '5', currency: 'CAD' });
      expect(off.statusCode, off.body).toBe(400);
      expect(off.json()).toMatchObject({ hint: expect.stringMatching(/enabled currency/) });
    } finally {
      await own(db, `UPDATE public.currencies SET enabled = true WHERE code = 'CAD'`);
    }
    const viewer = await fillCall(talia, car.id, { amount: '10' });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('the summary', () => {
  it("gives the Corolla's 7.3 L/100 km over its last 5 full fills, and 1.75 EGP a km on fuel", async () => {
    const car = await newCar();
    await logCorollaFills(t, alfred, car.id, shift);
    const s = ok(await summary(louis, car)) as unknown as {
      byUnit: Array<Record<string, unknown> & { trend: { perHundred: string }[] }>;
      pricePerUnit: Array<Record<string, unknown>>;
      perDistance: Array<Record<string, unknown>>;
      monthlyAverage: Array<Record<string, unknown>>;
    };
    expect(s.byUnit).toHaveLength(1);
    expect(s.byUnit[0]).toMatchObject({
      unit: 'L',
      consumption: { perHundred: '7.3', distanceUnit: 'km', fills: 5, to: shift.thisStart },
    });
    // Every usable interval, full to full: 21 full fills, one interval lost to the missed
    // fill-up; the partial counts inside its interval.
    const trend = s.byUnit[0]?.trend ?? [];
    expect(trend).toHaveLength(19);
    expect(new Set(trend.map((x) => x.perHundred))).toEqual(new Set(['7.3']));
    expect(s.perDistance).toEqual([
      {
        currency: 'EGP',
        amount: '1.75',
        distanceUnit: 'km',
        from: shift.fromStart,
        to: shift.thisStart,
      },
    ]);
    expect(s.monthlyAverage).toEqual([{ currency: 'EGP', amount: '3309.25', months: 6 }]);
    expect(s.pricePerUnit?.[0]).toMatchObject({ unit: 'L', currency: 'EGP', latest: '24.7504' });
    expect(COROLLA_FILLS).toHaveLength(22);
  });

  it('breaks only the interval a missed fill-up is in, and counts a partial inside its interval', async () => {
    const car = await newCar();
    const at = (d: number) => daysAgo(40 - d);
    await fill(louis, car, { takenAt: at(0), amount: '40', reading: { value: '1000' } });
    await fill(louis, car, { takenAt: at(1), amount: '7', reading: { value: '1100' } });
    await fill(louis, car, {
      takenAt: at(2),
      amount: '3',
      isFull: false,
      reading: { value: '1150' },
    });
    await fill(louis, car, { takenAt: at(3), amount: '4', reading: { value: '1200' } });
    await fill(louis, car, {
      takenAt: at(4),
      amount: '9',
      missedBefore: true,
      reading: { value: '1300' },
    });
    const s = ok(await summary(louis, car)) as unknown as {
      byUnit: { consumption: { perHundred: string; fills: number }; trend: unknown[] }[];
    };
    // 7 L over 100 km, then 3 + 4 L over 100 km; the missed fill-up's interval is left out.
    expect(s.byUnit[0]?.trend).toHaveLength(2);
    expect(s.byUnit[0]?.consumption).toMatchObject({ perHundred: '7', fills: 3 });
  });

  it('gives a charge in kWh per 100 km, and a plug-in hybrid per unit with mixed intervals skipped', async () => {
    const ev = await newCar('Leaf');
    await fill(louis, ev, {
      takenAt: daysAgo(20),
      unit: 'kWh',
      amount: '30',
      reading: { value: '100' },
    });
    await fill(louis, ev, {
      takenAt: daysAgo(10),
      unit: 'kWh',
      amount: '15',
      reading: { value: '200' },
    });
    const e = ok(await summary(louis, ev)) as unknown as { byUnit: Record<string, unknown>[] };
    expect(e.byUnit).toEqual([
      expect.objectContaining({
        unit: 'kWh',
        consumption: expect.objectContaining({ perHundred: '15', distanceUnit: 'km' }),
      }),
    ]);
    const phev = await newCar('Outlander');
    await fill(louis, phev, { takenAt: daysAgo(30), amount: '30', reading: { value: '100' } });
    await fill(louis, phev, {
      takenAt: daysAgo(20),
      unit: 'kWh',
      amount: '12',
      reading: { value: '200' },
    });
    await fill(louis, phev, { takenAt: daysAgo(10), amount: '10', reading: { value: '300' } });
    const p = ok(await summary(louis, phev)) as unknown as { byUnit: Record<string, unknown>[] };
    expect(p.byUnit).toEqual([
      expect.objectContaining({ unit: 'L', consumption: null, whyNone: 'mixed_units' }),
      expect.objectContaining({ unit: 'kWh', consumption: null, whyNone: 'too_few_full_fills' }),
    ]);
  });

  it('keeps EGP and USD apart: prices and costs per currency, never added', async () => {
    const car = await newCar();
    await fill(louis, car, { takenAt: daysAgo(20), amount: '40', cost: '1000', currency: 'EGP' });
    await fill(louis, car, { takenAt: daysAgo(10), amount: '40', cost: '50', currency: 'usd' });
    const s = ok(await summary(louis, car, '?months=6')) as unknown as {
      pricePerUnit: { currency: string; latest: string }[];
    };
    expect(s.pricePerUnit.map((x) => [x.currency, x.latest])).toEqual([
      ['EGP', '25'],
      ['USD', '1.25'],
    ]);
  });
});

describe('the money gate', () => {
  it('shows a viewer litres, odometer and consumption, and no cost, price, receipt or per-km', async () => {
    const car = await newCar();
    await fill(louis, car, {
      takenAt: daysAgo(3),
      amount: '40',
      cost: '1000',
      reading: { value: '100' },
      receiptFileId: await receipt(louis),
    });
    const rows = ok(await list(talia, car)) as unknown as { items: Json[] };
    expect(rows.items[0]).toMatchObject({ amount: '40', moneyHidden: true });
    for (const k of ['cost', 'currency', 'pricePerUnit', 'receipt'])
      expect(rows.items[0]).not.toHaveProperty(k);
    const s = ok(await summary(talia, car)) as Json;
    expect(s.moneyHidden).toBe(true);
    for (const k of ['pricePerUnit', 'perDistance', 'monthlyAverage'])
      expect(s).not.toHaveProperty(k);
  });
});

describe('changing a fill', () => {
  // catalogue: PATCH /api/v1/fuel/:id
  it('re-places its own reading through the fill, audited and undoable; its reading alone is not the way', async () => {
    const car = await newCar();
    await fill(alfred, car, { takenAt: daysAgo(10), amount: '40', reading: { value: '1000' } });
    const out = await fill(alfred, car, {
      takenAt: daysAgo(5),
      amount: '30',
      cost: '600',
      reading: { value: '1400' },
    });
    const id = out.entry.id;
    const readingId = out.reading?.id as string;
    const direct = await call(t, `/api/v1/readings/${readingId}`, {
      as: alfred,
      method: 'PATCH',
      body: { value: '1450' },
    });
    expect(direct.statusCode, direct.body).toBe(409);
    expect(direct.json()).toMatchObject({ code: 'reading_owned', ownedBy: { type: 'fuel', id } });

    const back = await call(t, `/api/v1/fuel/${id}`, {
      as: alfred,
      method: 'PATCH',
      body: { reading: { value: '900' } },
      headers: { 'if-match': '1' },
    });
    expect(back.statusCode, back.body).toBe(409);

    const patched = ok(
      await call(t, `/api/v1/fuel/${id}`, {
        as: alfred,
        method: 'PATCH',
        body: { amount: '32', reading: { value: '1500' }, isFull: false },
        headers: { 'if-match': '1' },
      }),
    );
    expect(patched).toMatchObject({
      amount: '32',
      isFull: false,
      reading: { id: readingId, value: '1500' },
      rowVersion: 2,
    });
    const events = await eventsOf(db, garage.id, id);
    const update = events.find((e) => e.action === 'fuel.update');
    expect(update?.diff).toMatchObject({
      amount: { before: '30', after: '32' },
      reading_value: { before: '1400', after: '1500' },
    });
    ok(await undo(alfred, update?.id as string));
    const now = ok(await list(alfred, car)) as unknown as { items: Json[] };
    expect(now.items.find((x) => x.id === id)).toMatchObject({
      amount: '30',
      isFull: true,
      reading: { value: '1400' },
    });
  });

  it("lets Alfred change his own fill and not Bruce's; Bruce, an admin, removes Alfred's", async () => {
    const car = await newCar();
    const mine = await fill(alfred, car, { takenAt: daysAgo(4), amount: '10' });
    const bruces = await fill(bruce, car, { takenAt: daysAgo(3), amount: '11' });
    const refused = await call(t, `/api/v1/fuel/${bruces.entry.id}`, {
      as: alfred,
      method: 'PATCH',
      body: { note: 'mine now' },
      headers: { 'if-match': '1' },
    });
    expect(refused.statusCode).toBe(403);
    ok(
      await call(t, `/api/v1/fuel/${mine.entry.id}`, {
        as: alfred,
        method: 'PATCH',
        body: { note: 'checked' },
        headers: { 'if-match': '1' },
      }),
    );
    ok(
      await call(t, `/api/v1/fuel/${mine.entry.id}`, {
        as: bruce,
        method: 'DELETE',
        headers: { 'if-match': '2' },
      }),
    );
  });

  // catalogue: DELETE /api/v1/fuel/:id
  it('deletes the fill with its reading and receipt, and undo puts all three back', async () => {
    const car = await newCar();
    const receiptId = await receipt(louis);
    const out = await fill(louis, car, {
      takenAt: daysAgo(6),
      amount: '40',
      cost: '1000',
      reading: { value: '2000' },
      receiptFileId: receiptId,
    });
    const id = out.entry.id;
    const res = ok(
      await call(t, `/api/v1/fuel/${id}`, {
        as: louis,
        method: 'DELETE',
        headers: { 'if-match': '1' },
      }),
    ) as unknown as { undo: { eventId: string } };
    expect(
      await own(db, 'SELECT 1 FROM public.meter_readings WHERE id = $1', [out.reading?.id]),
    ).toEqual([]);
    const events = await eventsOf(db, garage.id, id);
    expect(events.at(-1)).toMatchObject({ action: 'fuel.delete', id: res.undo.eventId });
    ok(await undo(louis, res.undo.eventId));
    const rows = ok(await list(louis, car)) as unknown as { items: Json[] };
    expect(rows.items).toEqual([
      expect.objectContaining({
        id,
        cost: '1000',
        reading: { id: out.reading?.id, value: '2000', state: 'accepted' },
        receipt: expect.objectContaining({ fileId: receiptId }),
      }),
    ]);
  });

  it('refuses to undo a delete whose reading no longer fits', async () => {
    const car = await newCar();
    const out = await fill(louis, car, {
      takenAt: daysAgo(6),
      amount: '40',
      reading: { value: '3000' },
    });
    const del = ok(
      await call(t, `/api/v1/fuel/${out.entry.id}`, {
        as: louis,
        method: 'DELETE',
        headers: { 'if-match': '1' },
      }),
    ) as unknown as { undo: { eventId: string } };
    await call(t, `/api/v1/meters/${car.meterId}/readings`, {
      as: louis,
      body: { value: '2500', takenAt: daysAgo(3) },
    });
    const res = await undo(louis, del.undo.eventId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'undo_refused', reason: 'changed_since' });
    expect(
      await own(db, 'SELECT 1 FROM public.fuel_entries WHERE id = $1', [out.entry.id]),
    ).toEqual([]);
  });

  it('undoes a fill: it and its reading go', async () => {
    const car = await newCar();
    const out = await fill(louis, car, {
      takenAt: daysAgo(2),
      amount: '40',
      reading: { value: '10' },
    });
    ok(await undo(louis, out.undo.eventId));
    expect(
      await own(db, 'SELECT 1 FROM public.fuel_entries WHERE id = $1', [out.entry.id]),
    ).toEqual([]);
    expect(
      await own(db, 'SELECT 1 FROM public.meter_readings WHERE id = $1', [out.reading?.id]),
    ).toEqual([]);
  });
});

describe('the list and the module', () => {
  it('filters by unit, fullness and date, sorts by amount, and pages', async () => {
    const car = await newCar();
    await fill(louis, car, { takenAt: daysAgo(40), amount: '10' });
    await fill(louis, car, { takenAt: daysAgo(20), amount: '30', isFull: false });
    await fill(louis, car, { takenAt: daysAgo(2), amount: '20', unit: 'kWh' });
    const all = ok(await list(louis, car)) as unknown as { items: Json[] };
    expect(all.items.map((x) => x.amount)).toEqual(['20', '30', '10']);
    const litres = ok(await list(louis, car, '?f.unit=L&f.full=1')) as unknown as { items: Json[] };
    expect(litres.items.map((x) => x.amount)).toEqual(['10']);
    const notL = ok(await list(louis, car, '?f.unit=L&not=unit')) as unknown as { items: Json[] };
    expect(notL.items.map((x) => x.amount)).toEqual(['20']);
    const recent = ok(await list(louis, car, '?f.when=month')) as unknown as { items: Json[] };
    expect(recent.items.map((x) => x.amount)).toEqual(['20', '30']);
    const first = ok(await list(louis, car, '?sort=amount&dir=asc&limit=2')) as unknown as {
      items: Json[];
      next_cursor: string;
    };
    expect(first.items.map((x) => x.amount)).toEqual(['10', '20']);
    const second = ok(
      await list(louis, car, `?sort=amount&dir=asc&limit=2&cursor=${first.next_cursor}`),
    ) as unknown as { items: Json[]; next_cursor: string | null };
    expect(second.items.map((x) => x.amount)).toEqual(['30']);
    expect(second.next_cursor).toBeNull();
  });

  it('answers "off in this location" with Fuel off, and the fills’ readings stay in the series', async () => {
    const car = await newCar();
    await fill(louis, car, { takenAt: daysAgo(2), amount: '40', reading: { value: '777' } });
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'fuel', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
      [garage.id],
    );
    try {
      const read = await list(louis, car);
      expect(read.statusCode).toBe(404);
      expect(read.json()).toMatchObject({ code: 'module_off' });
      const write = await fillCall(louis, car.id, { amount: '1' });
      expect(write.statusCode).toBe(409);
      expect(write.json()).toMatchObject({ code: 'module_off' });
      const readings = ok(
        await call(t, `/api/v1/meters/${car.meterId}/readings`, { as: louis }),
      ) as unknown as { items: Json[] };
      expect(readings.items.map((r) => [r.value, r.source])).toEqual([['777', 'fuel']]);
    } finally {
      await own(
        db,
        `DELETE FROM public.location_modules WHERE location_id = $1 AND module = 'fuel'`,
        [garage.id],
      );
    }
  });

  it('is a 404 on another household’s car', async () => {
    const car = await newCar();
    const stranger = await person(t, db, 'peter');
    const res = await list(stranger, car);
    expect(res.statusCode).toBe(404);
    const w = await fillCall(stranger, car.id, { amount: '1' });
    expect(w.statusCode).toBe(404);
  });
});
