import { addDays, addMonthsClamped } from '@kept/shared';
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
  place,
  setDisplayName,
} from '../../test/things.js';

// Task 11 through the front door, as the web calls it (apps/web/src/api/household/{types,paths}.ts,
// components/schedules/*, components/services/log-service-sheet.tsx): schedules on things and
// places, "every N units and/or M months, whichever first" or once (D29, D146), completion
// through a service record that re-anchors (D162), snooze, skip (Q28), and service records as
// core (D113), with readings refused at entry as the meters section refuses them (D112).

let db: TestDb;
let t: TestApp;

let ibrahim: Person; // owner of Home
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let alfred: Person; // his own account; nothing of Ibrahim's
let home: Loc;
let garage: Loc; // Essentials: no Schedules, no Money
let carType: string;
let today: string;

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
  await setDisplayName(db, bruce, 'Bruce');
  await setDisplayName(db, louis, 'Louis');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');
  carType = await builtinType(db, 'car');
  const [row] = await own<{ today: string }>(
    db,
    `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS today`,
  );
  today = row?.today as string;
});

type Car = { thing: Json; meterId: string };

async function newCar(name = 'Corolla'): Promise<Car> {
  const thing = await createThing(t, ibrahim, home, { name, typeId: carType });
  const meters = thing.meters as { id: string }[];
  return { thing, meterId: (meters[0] as { id: string }).id };
}

/** A reading, taken `daysAgo` days ago at 09:00 UTC. */
async function reading(meterId: string, value: string, daysAgo: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  at.setUTCHours(9, 0, 0, 0);
  ok(
    await call(t, `/api/v1/meters/${meterId}/readings`, {
      as: ibrahim,
      body: { value, takenAt: at.toISOString() },
    }),
    201,
  );
}

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

async function schedule(as: Person, body: Record<string, unknown>): Promise<Json> {
  return ok(await post(as, '/api/v1/schedules', body), 201);
}

async function scheduleOf(id: string, as = ibrahim): Promise<Json> {
  const res = ok(await call(t, '/api/v1/schedules?limit=200', { as }));
  const found = (res.items as Json[]).find((s) => s.id === id);
  if (found) return found;
  // Not on the agenda (inactive): its subject's list has it.
  const [row] = await own<{ thing_id: string | null; place_id: string | null }>(
    db,
    'SELECT thing_id, place_id FROM public.schedules WHERE id = $1',
    [id],
  );
  const url = row?.thing_id
    ? `/api/v1/things/${row.thing_id}/schedules`
    : `/api/v1/places/${row?.place_id}/schedules`;
  return (ok(await call(t, url, { as })).items as Json[]).find((s) => s.id === id) as Json;
}

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

describe('POST /api/v1/schedules', () => {
  // catalogue: POST /api/v1/schedules
  it('makes a schedule on a thing, anchored today, audited on the thing', async () => {
    const car = await newCar();
    const s = await schedule(louis, {
      subject: { thingId: car.thing.id },
      name: 'Oil change',
      everyMonths: 12,
      everyUnits: '10000',
      meterId: car.meterId,
    });
    expect(s).toMatchObject({
      locationId: home.id,
      // The Unplaced area is left out of a path (UI step-4 review L2).
      subject: { type: 'thing', id: car.thing.id, name: 'Corolla', path: 'Home' },
      name: 'Oil change',
      everyMonths: 12,
      everyUnits: '10000',
      meter: { id: car.meterId, unit: 'km' },
      dueOn: null,
      leadDays: 14,
      leadUnits: null,
      anchorOn: today,
      anchorValue: null,
      next: {
        dueOn: addMonthsClamped(today, 12),
        dueValue: '10000',
        state: 'upcoming',
        basis: 'both',
      },
      snoozedUntil: null,
      skipNext: false,
      active: true,
      lastService: null,
      rowVersion: 1,
    });
    const [event] = await eventsOf(db, home.id, s.id);
    expect(event).toMatchObject({ action: 'schedule.create', actor_id: louis.userId });
    expect(event?.diff).toMatchObject({
      name: { after: 'Oil change' },
      every_months: { after: 12 },
    });
    expect(event?.undoable_until).toBeNull();
  });

  it('needs an interval or a date (400 schedule_interval_required), and a meter for units', async () => {
    const car = await newCar('Civic');
    const none = await post(ibrahim, '/api/v1/schedules', {
      subject: { thingId: car.thing.id },
      name: 'Something',
    });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: 'schedule_interval_required' });
    const noMeter = await post(ibrahim, '/api/v1/schedules', {
      subject: { thingId: car.thing.id },
      name: 'Tyres',
      everyUnits: '40000',
    });
    expect(noMeter.statusCode).toBe(400);
    const both = await post(ibrahim, '/api/v1/schedules', {
      subject: { thingId: car.thing.id },
      name: 'Once and again',
      everyMonths: 6,
      dueOn: addDays(today, 10),
    });
    expect(both.statusCode).toBe(400);
  });

  it('is refused to a viewer (403), in a location with Schedules off (409), to outsiders (404)', async () => {
    const car = await newCar('Viewer car');
    const body = { subject: { thingId: car.thing.id }, name: 'Wax', everyMonths: 3 };
    expect((await post(talia, '/api/v1/schedules', body)).statusCode).toBe(403);
    expect((await post(alfred, '/api/v1/schedules', body)).statusCode).toBe(404);
    const drill = await createThing(t, ibrahim, garage, { name: 'Drill' });
    const off = await post(louis, '/api/v1/schedules', {
      subject: { thingId: drill.id },
      name: 'Oil the chuck',
      everyMonths: 6,
    });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'module_off' });
    const read = await call(t, `/api/v1/things/${drill.id}/schedules`, { as: louis });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'module_off' });
  });

  it('puts a schedule on a place (D39): the boiler service', async () => {
    const kitchen = await place(db, home, 'Kitchen');
    const s = await schedule(bruce, {
      subject: { placeId: kitchen },
      name: 'Boiler service',
      everyMonths: 12,
      anchorOn: addMonthsClamped(today, -12),
    });
    expect(s.subject).toMatchObject({ type: 'place', id: kitchen, name: 'Kitchen', path: 'Home' });
    // Anchored a year ago: due today, so overdue from tomorrow; today it is due.
    expect(s.next).toMatchObject({ dueOn: today, state: 'due', basis: 'months' });
    const list = ok(await call(t, `/api/v1/places/${kitchen}/schedules`, { as: talia }));
    expect((list.items as Json[]).map((x) => x.id)).toEqual([s.id]);
  });
});

describe('the due point (D29, D146, D162; Q2, Q28)', () => {
  it('"every 10,000 km or 12 months": due by months first, then by units', async () => {
    const car = await newCar('Accord');
    // Made eleven and a half months ago: the months side is due (inside the 14-day lead).
    const byMonths = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Service A',
      everyMonths: 12,
      everyUnits: '10000',
      meterId: car.meterId,
      anchorOn: addDays(addMonthsClamped(today, -12), 7),
      anchorValue: '50000',
    });
    expect(byMonths.next).toMatchObject({
      dueOn: addDays(today, 7),
      dueValue: '60000',
      state: 'due',
    });
    // Made today at 50,000 km: nothing is due until the odometer says so.
    const byUnits = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Service B',
      everyMonths: 12,
      everyUnits: '10000',
      meterId: car.meterId,
      anchorValue: '50000',
    });
    expect(byUnits.next).toMatchObject({ state: 'upcoming', dueValue: '60000' });
    await reading(car.meterId, '59200', 1); // inside the 10% lead (1,000 km)
    expect((await scheduleOf(byUnits.id)).next).toMatchObject({ state: 'due', dueValue: '60000' });
    await reading(car.meterId, '60150', 0);
    expect((await scheduleOf(byUnits.id)).next).toMatchObject({ state: 'overdue' });
  });

  it('a one-off date', async () => {
    const car = await newCar('Beetle');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Registration photos',
      dueOn: addDays(today, 3),
    });
    expect(s.next).toMatchObject({
      dueOn: addDays(today, 3),
      dueValue: null,
      state: 'due',
      basis: 'once',
    });
  });

  // catalogue: POST /api/v1/schedules/:id/skip
  it('skip moves the due point one interval on, audited and undoable', async () => {
    const car = await newCar('Skipper');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Detailing',
      everyMonths: 3,
      anchorOn: addMonthsClamped(today, -3),
    });
    expect(s.next).toMatchObject({ dueOn: today, state: 'due' });
    const skipped = ok(await post(louis, `/api/v1/schedules/${s.id}/skip`, {}, 1));
    expect(skipped).toMatchObject({
      skipNext: true,
      next: { dueOn: addMonthsClamped(addMonthsClamped(today, -3), 6), state: 'upcoming' },
    });
    const events = await eventsOf(db, home.id, s.id);
    const skip = events.find((e) => e.action === 'schedule.skip');
    expect(skip?.diff).toMatchObject({ skip_next: { before: false, after: true } });
    ok(await undo(louis, skip?.id as string));
    expect(await scheduleOf(s.id)).toMatchObject({ skipNext: false, next: { dueOn: today } });
    const once = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Once',
      dueOn: addDays(today, 30),
    });
    expect((await post(ibrahim, `/api/v1/schedules/${once.id}/skip`, {}, 1)).statusCode).toBe(400);
  });

  // catalogue: POST /api/v1/schedules/:id/snooze
  // catalogue: POST /api/v1/schedules/:id/complete
  it('snooze to a reading replaces the due point; completing clears it', async () => {
    const car = await newCar('Snoozer');
    await reading(car.meterId, '19500', 2);
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Timing belt',
      everyUnits: '10000',
      meterId: car.meterId,
      anchorValue: '10000',
    });
    expect(s.next).toMatchObject({ dueValue: '20000', state: 'due' });
    // {} on a unit schedule: +10% of the interval past the due reading (screens §8).
    const snoozed = ok(await post(louis, `/api/v1/schedules/${s.id}/snooze`, {}, 1));
    expect(snoozed).toMatchObject({
      snoozedUntilValue: '21000',
      next: { dueValue: '21000', state: 'upcoming' },
    });
    const snoozeEvent = (await eventsOf(db, home.id, s.id)).find(
      (e) => e.action === 'schedule.snooze',
    );
    expect(snoozeEvent?.diff).toMatchObject({
      snoozed_until_value: { before: null, after: '21000' },
    });

    const done = ok(
      await post(
        louis,
        `/api/v1/schedules/${s.id}/complete`,
        { reading: { value: '19800' }, notes: 'New belt' },
        snoozed.rowVersion as number,
      ),
    );
    expect(done.schedule).toMatchObject({
      snoozedUntilValue: null,
      anchorOn: today,
      anchorValue: '19800',
      next: { dueValue: '29800', state: 'upcoming' },
      lastService: { servicedOn: today },
    });
    const record = done.serviceRecord as Json;
    expect(record).toMatchObject({
      subject: { type: 'thing', id: car.thing.id },
      servicedOn: today,
      reading: { value: '19800', unit: 'km' },
      completes: [{ scheduleId: s.id, name: 'Timing belt' }],
      notes: 'New belt',
      loggedBy: { displayName: 'Louis' },
    });
    const [event] = await eventsOf(db, home.id, record.id);
    expect(event).toMatchObject({ action: 'service_record.create', actor_id: louis.userId });
    expect(event?.undoable_until).not.toBeNull();
    expect(event?.diff).toMatchObject({
      completes: { after: [s.id] },
      reading_created: { after: true },
    });

    // Undo: the record and its reading go; the anchor and the snooze come back.
    ok(await undo(louis, event?.id as string));
    expect(await scheduleOf(s.id)).toMatchObject({
      anchorValue: '10000',
      snoozedUntilValue: '21000',
      lastService: null,
    });
    const gone = await own(
      db,
      'SELECT 1 FROM public.meter_readings WHERE value = 19800 AND meter_id = $1',
      [car.meterId],
    );
    expect(gone).toHaveLength(0);
  });

  // catalogue: POST /api/v1/schedules/:id/unsnooze
  it('unsnooze puts the schedule back on its own due point', async () => {
    const car = await newCar('Waker');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Coolant',
      everyMonths: 24,
      anchorOn: addMonthsClamped(today, -24),
    });
    const snoozed = ok(
      await post(ibrahim, `/api/v1/schedules/${s.id}/snooze`, { untilDate: addDays(today, 20) }, 1),
    );
    expect(snoozed.next).toMatchObject({ dueOn: addDays(today, 20), state: 'upcoming' });
    const woken = ok(
      await post(ibrahim, `/api/v1/schedules/${s.id}/unsnooze`, {}, snoozed.rowVersion as number),
    );
    expect(woken).toMatchObject({ snoozedUntil: null, next: { dueOn: today, state: 'due' } });
    const events = await eventsOf(db, home.id, s.id);
    expect(events.map((e) => e.action)).toContain('schedule.unsnooze');
  });
});

describe('PATCH and DELETE /api/v1/schedules/:id', () => {
  // catalogue: PATCH /api/v1/schedules/:id
  it('changes a schedule with If-Match (412 when stale), audited and undoable', async () => {
    const car = await newCar('Patcher');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Wash',
      everyMonths: 1,
    });
    const res = ok(
      await patch(louis, `/api/v1/schedules/${s.id}`, { name: 'Full wash', everyMonths: 2 }, 1),
    );
    expect(res).toMatchObject({ name: 'Full wash', everyMonths: 2, rowVersion: 2 });
    const stale = await patch(louis, `/api/v1/schedules/${s.id}`, { name: 'Again' }, 1);
    expect(stale.statusCode).toBe(412);
    const event = (await eventsOf(db, home.id, s.id)).find((e) => e.action === 'schedule.update');
    expect(event?.diff).toMatchObject({ name: { before: 'Wash', after: 'Full wash' } });
    ok(await undo(louis, event?.id as string));
    expect(await scheduleOf(s.id)).toMatchObject({ name: 'Wash', everyMonths: 1 });
  });

  // catalogue: DELETE /api/v1/schedules/:id
  it('deletes for good (Q25), and undo brings it back with its id', async () => {
    const car = await newCar('Deleter');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Polish',
      everyMonths: 6,
    });
    expect((await del(talia, `/api/v1/schedules/${s.id}`, 1)).statusCode).toBe(403);
    const res = await del(bruce, `/api/v1/schedules/${s.id}`, 1);
    expect(res.statusCode).toBe(204);
    const eventId = res.headers['x-kept-audit-event'] as string;
    expect(await own(db, 'SELECT 1 FROM public.schedules WHERE id = $1', [s.id])).toHaveLength(0);
    const [event] = (await eventsOf(db, home.id, s.id)).filter(
      (e) => e.action === 'schedule.delete',
    );
    expect(event?.id).toBe(eventId);
    ok(await undo(bruce, eventId));
    expect(await scheduleOf(s.id)).toMatchObject({ name: 'Polish', everyMonths: 6 });
  });
});

describe('GET /api/v1/schedules (the Schedules screen)', () => {
  it('lists what is due first, with counts that agree with the agenda, across locations', async () => {
    const car = await newCar('Lister');
    const overdue = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Very late',
      everyMonths: 1,
      anchorOn: addMonthsClamped(today, -3),
    });
    const res = ok(
      await call(t, `/api/v1/schedules?locationId=${home.id}&limit=200`, { as: talia }),
    );
    const items = res.items as Json[];
    const states = items.map((s) => (s.next as { state: string }).state);
    expect(states.indexOf('overdue')).toBeLessThanOrEqual(states.lastIndexOf('overdue'));
    expect(
      states.slice(0, states.filter((x) => x === 'overdue').length).every((x) => x === 'overdue'),
    ).toBe(true);
    expect(items.some((s) => s.id === overdue.id)).toBe(true);
    const [agenda] = await own<{ due: number; overdue: number }>(
      db,
      `SELECT count(*) FILTER (WHERE state = 'due')::int AS due,
              count(*) FILTER (WHERE state = 'overdue')::int AS overdue
         FROM public.agenda_items WHERE source_type = 'schedule' AND location_id = $1`,
      [home.id],
    );
    expect(res.counts).toEqual(agenda);
    const only = ok(await call(t, '/api/v1/schedules?state=overdue&q=very%20late', { as: louis }));
    expect((only.items as Json[]).map((s) => s.id)).toEqual([overdue.id]);
    const page = ok(
      await call(t, `/api/v1/schedules?locationId=${home.id}&limit=1`, { as: talia }),
    );
    expect(page.next_cursor).toEqual(expect.any(String));
    const next = ok(
      await call(t, `/api/v1/schedules?locationId=${home.id}&limit=1&cursor=${page.next_cursor}`, {
        as: talia,
      }),
    );
    expect((next.items as Json[])[0]?.id).not.toBe((page.items as Json[])[0]?.id);
    expect((ok(await call(t, '/api/v1/schedules', { as: alfred })).items as Json[]).length).toBe(0);
  });
});

describe('service records (core, D113)', () => {
  // catalogue: POST /api/v1/service-records
  it('logs a service with lines, a vendor by name and an invoice subject; the total is money', async () => {
    const car = await newCar('Logger');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Brakes',
      everyMonths: 24,
      anchorOn: addMonthsClamped(today, -24),
    });
    const res = await post(louis, '/api/v1/service-records', {
      subject: { thingId: car.thing.id },
      servicedOn: today,
      vendor: { name: 'Murdock Motors' },
      currency: 'EGP',
      lines: [
        { kind: 'part', description: 'Pads', quantity: '2', unitCost: '400' },
        { kind: 'labour', description: 'Fitting', unitCost: '250.5' },
      ],
      completes: [s.id],
      notes: 'Front axle',
    });
    const record = ok(res, 201);
    expect(record).toMatchObject({
      vendor: { name: 'Murdock Motors' },
      total: { amount: '1050.5', currency: 'EGP' },
      lines: [
        {
          kind: 'part',
          description: 'Pads',
          quantity: '2',
          unitCost: { amount: '400', currency: 'EGP' },
        },
        {
          kind: 'labour',
          description: 'Fitting',
          quantity: null,
          unitCost: { amount: '250.5', currency: 'EGP' },
        },
      ],
      completes: [{ scheduleId: s.id, name: 'Brakes' }],
      invoices: [],
    });
    const [event] = await eventsOf(db, home.id, record.id);
    expect(event).toMatchObject({ action: 'service_record.create' });
    expect(event?.diff.total).toMatchObject({ after: '1050.5', class: 'money' });

    // Log a service attaches the invoice to the record once it exists (subject
    // {serviceRecordId}, role `invoice`, as the web sends it).
    const invoice = ok(
      await post(louis, '/api/v1/attachments', {
        locationId: home.id,
        url: 'https://example.com/invoice-1050.pdf',
        subject: { serviceRecordId: record.id },
        role: 'invoice',
      }),
      201,
    );
    expect(invoice.subject).toEqual({ serviceRecordId: record.id });
    const withInvoice = ok(
      await call(t, `/api/v1/things/${car.thing.id}/service-records`, { as: louis }),
    );
    expect((withInvoice.items as Json[])[0]).toMatchObject({
      id: record.id,
      invoices: [{ id: invoice.id, role: 'invoice', subject: { serviceRecordId: record.id } }],
    });
    expect((await scheduleOf(s.id)).anchorOn).toBe(today);

    // The viewer sees the record, never its money.
    const seen = ok(await call(t, `/api/v1/things/${car.thing.id}/service-records`, { as: talia }));
    expect((seen.items as Json[])[0]).toMatchObject({
      id: record.id,
      total: { moneyHidden: true },
      lines: [{ unitCost: { moneyHidden: true } }, { unitCost: { moneyHidden: true } }],
      invoices: [],
    });
  });

  it('refuses a reading that runs backwards with the neighbour (409, the meters shape)', async () => {
    const car = await newCar('Backwards');
    await reading(car.meterId, '80000', 5);
    const res = await post(louis, '/api/v1/service-records', {
      subject: { thingId: car.thing.id },
      servicedOn: today,
      reading: { meterId: car.meterId, value: '79000' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
      reason: 'lower_than_previous',
      previous: { value: '80000' },
    });
    const none = await own(db, 'SELECT 1 FROM public.service_records WHERE thing_id = $1', [
      car.thing.id,
    ]);
    expect(none).toHaveLength(0);
  });

  it('refuses the future, and `completes` where Schedules are off (409 module_off)', async () => {
    const car = await newCar('Future');
    const later = await post(louis, '/api/v1/service-records', {
      subject: { thingId: car.thing.id },
      servicedOn: addDays(today, 1),
    });
    expect(later.statusCode).toBe(400);
    const saw = await createThing(t, ibrahim, garage, { name: 'Saw' });
    const logged = ok(
      await post(louis, '/api/v1/service-records', {
        subject: { thingId: saw.id },
        servicedOn: today,
      }),
      201,
    );
    expect(logged.total).toEqual({ moneyHidden: true });
    const priced = await post(louis, '/api/v1/service-records', {
      subject: { thingId: saw.id },
      servicedOn: today,
      total: '100',
      currency: 'EGP',
    });
    expect(priced.statusCode).toBe(409);
    expect(priced.json()).toMatchObject({ code: 'module_off' });
  });

  it('a back-dated service re-anchors (D162); deleting it puts the previous anchor back', async () => {
    const car = await newCar('Backdated');
    const s = await schedule(ibrahim, {
      subject: { thingId: car.thing.id },
      name: 'Filter',
      everyMonths: 6,
      anchorOn: addMonthsClamped(today, -8),
    });
    const earlier = addMonthsClamped(today, -1);
    const record = ok(
      await post(louis, '/api/v1/service-records', {
        subject: { thingId: car.thing.id },
        servicedOn: earlier,
        completes: [s.id],
      }),
      201,
    );
    expect(await scheduleOf(s.id)).toMatchObject({
      anchorOn: earlier,
      next: { dueOn: addMonthsClamped(earlier, 6) },
    });
    expect((await del(louis, `/api/v1/service-records/${record.id}`, 1)).statusCode).toBe(204);
    expect((await scheduleOf(s.id)).anchorOn).toBe(addMonthsClamped(today, -8));
  });

  // catalogue: PATCH /api/v1/service-records/:id
  // catalogue: DELETE /api/v1/service-records/:id
  it('a member changes their own service, not Bruce’s (403); edits and deletes are undoable', async () => {
    const car = await newCar('Owned');
    const mine = ok(
      await post(louis, '/api/v1/service-records', {
        subject: { thingId: car.thing.id },
        servicedOn: today,
        notes: 'Mine',
      }),
      201,
    );
    const his = ok(
      await post(bruce, '/api/v1/service-records', {
        subject: { thingId: car.thing.id },
        servicedOn: today,
        notes: 'Bruce’s',
      }),
      201,
    );
    const forbidden = await patch(louis, `/api/v1/service-records/${his.id}`, { notes: 'x' }, 1);
    expect(forbidden.statusCode).toBe(403);
    expect((await del(louis, `/api/v1/service-records/${his.id}`, 1)).statusCode).toBe(403);
    const edited = ok(
      await patch(
        louis,
        `/api/v1/service-records/${mine.id}`,
        {
          notes: 'Mine, edited',
          lines: [{ kind: 'fluid', description: 'Oil 5W-30', quantity: '4.5' }],
        },
        1,
      ),
    );
    expect(edited).toMatchObject({
      notes: 'Mine, edited',
      lines: [{ kind: 'fluid', quantity: '4.5' }],
    });
    const update = (await eventsOf(db, home.id, mine.id)).find(
      (e) => e.action === 'service_record.update',
    );
    expect(update?.diff).toMatchObject({ notes: { before: 'Mine', after: 'Mine, edited' } });
    ok(await undo(louis, update?.id as string));
    const back = ok(await call(t, `/api/v1/things/${car.thing.id}/service-records`, { as: louis }));
    expect((back.items as Json[]).find((r) => r.id === mine.id)).toMatchObject({
      notes: 'Mine',
      lines: [],
    });

    // Bruce, an admin, removes Louis's; undo brings it back with its id.
    const current = (back.items as Json[]).find((r) => r.id === mine.id) as Json;
    const gone = await del(
      bruce,
      `/api/v1/service-records/${mine.id}`,
      current.rowVersion as number,
    );
    expect(gone.statusCode).toBe(204);
    const deleted = (await eventsOf(db, home.id, mine.id)).find(
      (e) => e.action === 'service_record.delete',
    );
    expect(deleted?.diff).toMatchObject({ notes: { before: 'Mine', after: null } });
    ok(await undo(bruce, deleted?.id as string));
    expect(
      await own(db, 'SELECT 1 FROM public.service_records WHERE id = $1', [mine.id]),
    ).toHaveLength(1);
  });

  it('lists a place’s services, newest first, paged', async () => {
    const hall = await place(db, home, 'Hall');
    for (const back of [3, 2, 1]) {
      ok(
        await post(louis, '/api/v1/service-records', {
          subject: { placeId: hall },
          servicedOn: addDays(today, -back),
        }),
        201,
      );
    }
    const first = ok(
      await call(t, `/api/v1/places/${hall}/service-records?limit=2`, { as: talia }),
    );
    expect((first.items as Json[]).map((r) => r.servicedOn)).toEqual([
      addDays(today, -1),
      addDays(today, -2),
    ]);
    const second = ok(
      await call(t, `/api/v1/places/${hall}/service-records?limit=2&cursor=${first.next_cursor}`, {
        as: talia,
      }),
    );
    expect((second.items as Json[]).map((r) => r.servicedOn)).toEqual([addDays(today, -3)]);
    expect(second.next_cursor).toBeNull();
    expect(
      (await call(t, `/api/v1/places/${hall}/service-records`, { as: alfred })).statusCode,
    ).toBe(404);
  });
});
