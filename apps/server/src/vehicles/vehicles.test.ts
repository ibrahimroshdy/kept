import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { COROLLA_SERVICES, corollaShift, logCorollaFills, type Shift } from '../../test/corolla.js';
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
import { addMonths } from './costs.js';

// Step 5, T13 through the front door, as the web calls it (apps/web/src/api/vehicles/{types,
// paths}.ts: VehicleRow, VehiclesParams, CostReport, MeterSeries, StarterSchedulesResult,
// HomeResponseV5): the Vehicles list across the caller's locations with Vehicles on, a vehicle's
// running costs per month and currency, a meter's series, starter schedules, and Home's count of
// metered things. The Corolla is the web mock's (test/corolla.ts), with the board's numbers.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of the Garage and Home
let alfred: Person; // member of the Garage
let bruce: Person; // admin of the Garage
let talia: Person; // viewer of the Garage
let peter: Person; // outside the Garage
let garage: Loc; // complete
let home: Loc; // household
let shift: Shift;
let corolla: { id: string; meterId: string };
let oilScheduleId: string;

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const inDays = (n: number) => {
  const d = new Date(`${cairoToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function switchModule(locationId: string, module: string, enabled: boolean) {
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

async function vehicle(loc: Loc, name: string, type: string) {
  const thing = await createThing(t, ibrahim, loc, { name, typeId: await builtinType(db, type) });
  const meters = (thing.meters as { id: string }[]) ?? [];
  return { id: thing.id, meterId: meters[0]?.id as string };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  bruce = await person(t, db, 'bruce');
  talia = await person(t, db, 'talia');
  peter = await person(t, db, 'peter');
  await setDisplayName(db, alfred, 'Alfred');
  await setDisplayName(db, bruce, 'Bruce');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  await createLocation(t, db, peter, 'household', 'Peter’s');
  await join(db, garage.id, alfred.userId, 'member');
  await join(db, garage.id, bruce.userId, 'admin');
  await join(db, garage.id, talia.userId, 'viewer');
  shift = await corollaShift(db);

  corolla = await vehicle(garage, 'Toyota Corolla', 'car');
  await logCorollaFills(t, alfred, corolla.id, shift, { vendor: { name: 'Ring Road Station' } });
  const [oil, brakes] = COROLLA_SERVICES;
  for (const [s, by, lines] of [
    [
      oil,
      alfred,
      [{ kind: 'fluid', description: 'Engine oil 5W-30', quantity: '4', unitCost: '350' }],
    ],
    [brakes, bruce, [{ kind: 'part', description: 'Front brake pads', unitCost: '3200' }]],
  ] as const) {
    if (!s) continue;
    ok(
      await call(t, '/api/v1/service-records', {
        as: by,
        body: {
          subject: { thingId: corolla.id },
          servicedOn: shift.day(s[0]),
          reading: { meterId: corolla.meterId, value: s[1] },
          total: s[2],
          currency: 'EGP',
          lines,
        },
      }),
      201,
    );
  }
  ok(
    await call(t, '/api/v1/documents', {
      as: alfred,
      body: {
        subject: { thingId: corolla.id },
        kind: 'licence',
        expiresOn: inDays(23),
        leadDays: 30,
        issuedOn: inDays(-342),
        cost: '1200',
      },
    }),
    201,
  );
  ok(
    await call(t, '/api/v1/documents', {
      as: alfred,
      body: {
        subject: { thingId: corolla.id },
        kind: 'insurance',
        expiresOn: shift.day('2027-05-14'),
        issuedOn: shift.day('2026-05-15'),
        cost: '3500',
      },
    }),
    201,
  );
  const schedule = ok(
    await call(t, '/api/v1/schedules', {
      as: ibrahim,
      body: {
        subject: { thingId: corolla.id },
        name: 'Oil & filter',
        everyMonths: 12,
        everyUnits: '10000',
        meterId: corolla.meterId,
        leadUnits: '1000',
        anchorOn: shift.day('2026-06-18'),
        anchorValue: '46695',
      },
    }),
    201,
  );
  oilScheduleId = schedule.id;
});

afterAll(async () => {
  await t.app.close();
});

type Row = Json & {
  thing: Json & { name: string; lifecycle: string };
  meter?: {
    id: string;
    unit: string;
    latest?: { value: string; source: string };
    estimate: { advice: string; perDay: string | null };
  };
  nextDue?: { name: string; dueValue?: string; estimated: boolean; state: string };
  documentsDue: { kind: string; state: string }[];
  fuel?: { perHundred: string; unit: string; distanceUnit: string };
};
type Page = { items: Row[]; next_cursor: string | null };
const vehicles = async (as: Person, query = '') =>
  ok(await call(t, `/api/v1/vehicles${query}`, { as })) as unknown as Page;

describe('the Vehicles list', () => {
  it('lists the Corolla for Ibrahim, Bruce and Alfred, with its odometer, estimate, next due, documents and consumption', async () => {
    for (const who of [ibrahim, bruce, alfred]) {
      const page = await vehicles(who);
      expect(page.items.map((r) => r.thing.name)).toContain('Toyota Corolla');
    }
    const row = (await vehicles(alfred)).items.find((r) => r.thing.id === corolla.id);
    expect(row).toMatchObject({
      thing: { name: 'Toyota Corolla', lifecycle: 'in_use' },
      meter: {
        id: corolla.meterId,
        unit: 'km',
        latest: { value: '52541', source: 'fuel' },
      },
      nextDue: { name: 'Oil & filter', dueValue: '56695' },
      documentsDue: [{ kind: 'licence', state: 'expiring' }],
      fuel: { perHundred: '7.3', unit: 'L', distanceUnit: 'km' },
    });
    expect(['fresh', 'stale', 'unknown']).toContain(row?.meter?.estimate.advice);
    expect((await vehicles(peter)).items).toEqual([]);
  });

  it('drops the Garage’s vehicles with Vehicles off there', async () => {
    await switchModule(garage.id, 'vehicles', false);
    try {
      expect((await vehicles(alfred)).items).toEqual([]);
    } finally {
      await switchModule(garage.id, 'vehicles', true);
    }
  });

  it('shows a sold motorbike only under f.state=sold; lists the generator, not a kettle', async () => {
    const bike = await vehicle(home, 'Honda CB500', 'motorbike');
    await own(db, `UPDATE public.things SET lifecycle = 'sold' WHERE id = $1`, [bike.id]);
    const generator = await vehicle(home, 'Generator', 'generator');
    await createThing(t, ibrahim, home, { name: 'Kettle' });
    const names = (await vehicles(ibrahim, `?f.location=${home.id}`)).items.map(
      (r) => r.thing.name,
    );
    expect(names).toEqual(['Generator']);
    const sold = await vehicles(ibrahim, '?f.state=sold');
    expect(sold.items.map((r) => r.thing.id)).toEqual([bike.id]);
    const notSold = await vehicles(ibrahim, `?f.state=sold&not=state&f.location=${home.id}`);
    expect(notSold.items.map((r) => r.thing.id)).toEqual([generator.id]);
    expect((await vehicles(ibrahim, `?f.location=${home.id}`)).items[0]?.meter).toMatchObject({
      unit: 'h',
      estimate: { advice: 'none' },
    });
  });

  it('filters by the reading’s age and by what is due, sorts, and pages', async () => {
    const stale = await vehicle(garage, 'Hyundai Elantra', 'car');
    await call(t, `/api/v1/meters/${stale.meterId}/readings`, {
      as: alfred,
      body: { value: '84210', takenAt: daysAgo(80) },
    });
    await call(t, `/api/v1/meters/${stale.meterId}/readings`, {
      as: alfred,
      body: { value: '85310', takenAt: daysAgo(34) },
    });
    const staleOnly = await vehicles(alfred, '?f.reading=stale');
    expect(staleOnly.items.map((r) => r.thing.name)).toContain('Hyundai Elantra');
    expect(new Set(staleOnly.items.map((r) => r.meter?.estimate.advice))).toEqual(
      new Set(['stale']),
    );
    const soon = await vehicles(alfred, '?f.due=soon&f.due=overdue');
    expect(soon.items.map((r) => r.thing.name)).toEqual(['Toyota Corolla']);
    const byReading = await vehicles(alfred, '?sort=lastReading');
    expect(byReading.items.map((r) => r.thing.name)).toEqual(['Toyota Corolla', 'Hyundai Elantra']);
    const first = await vehicles(alfred, '?sort=name&limit=1');
    expect(first.items.map((r) => r.thing.name)).toEqual(['Hyundai Elantra']);
    const second = await vehicles(alfred, `?sort=name&limit=1&cursor=${first.next_cursor}`);
    expect(second.items.map((r) => r.thing.name)).toEqual(['Toyota Corolla']);
    expect(second.next_cursor).toBeNull();
    const named = await vehicles(alfred, '?q=coroll');
    expect(named.items.map((r) => r.thing.name)).toEqual(['Toyota Corolla']);
  });
});

type Costs = {
  period: { from: string; to: string };
  distance: { value: string; unit: string } | null;
  months: {
    month: string;
    soFar: boolean;
    byCurrency: Record<string, string>[];
    notes: string[];
  }[];
  totals: Record<string, string>[];
  moneyHidden?: true;
};

describe('running costs', () => {
  it('match the board’s table: 29,800 EGP over 11,346 km, 2.63 a km; this month is so far', async () => {
    const c = ok(
      await call(t, `/api/v1/things/${corolla.id}/costs`, { as: alfred }),
    ) as unknown as Costs;
    const full = Array.from({ length: 6 }, (_, i) => addMonths(shift.thisMonth, i - 6));
    expect(c.months.map((m) => [m.month, m.soFar])).toEqual([
      ...full.map((m) => [m, false]),
      [shift.thisMonth, true],
    ]);
    expect(c.period.from).toBe(`${full[0]}-01`);
    expect(c.distance).toEqual({ value: '11346', unit: 'km', basis: 'readings' });
    expect(c.totals).toEqual([
      {
        currency: 'EGP',
        fuel: '19855.5',
        service: '6444.5',
        fees: '3500',
        total: '29800',
        perDistance: '2.6265',
        monthlyAverage: '4966.6667',
      },
    ]);
    // The last fill, on this month's first instant, is this month's and counts in no total.
    expect(c.months.at(-1)?.byCurrency).toEqual([
      { currency: 'EGP', fuel: '218.62', service: '0', fees: '0', total: '218.62' },
    ]);
    const serviced = c.months.find((m) => m.month === shift.month('2026-06'));
    expect(serviced?.notes).toEqual(['Engine oil 5W-30']);
  });

  it('give a viewer the months and their notes, and no amounts', async () => {
    const c = ok(
      await call(t, `/api/v1/things/${corolla.id}/costs`, { as: talia }),
    ) as unknown as Costs;
    expect(c.moneyHidden).toBe(true);
    expect(c.totals).toEqual([]);
    expect(c.months.every((m) => m.byCurrency.length === 0)).toBe(true);
    expect(c.months.flatMap((m) => m.notes)).toEqual(['Engine oil 5W-30', 'Front brake pads']);
  });

  it('keep currencies apart, take a range, and refuse a bad month', async () => {
    const car = await vehicle(garage, 'Rental', 'car');
    const lastMonth = addMonths(shift.thisMonth, -1);
    const [mid] = await own<{ at: Date }>(
      db,
      `SELECT (($1 || '-15')::date + time '12:00') AT TIME ZONE 'Africa/Cairo' AS at`,
      [lastMonth],
    );
    for (const [cost, currency] of [
      ['100', 'EGP'],
      ['10', 'USD'],
    ] as const) {
      ok(
        await call(t, `/api/v1/things/${car.id}/fuel`, {
          as: alfred,
          body: {
            id: newId(),
            takenAt: mid?.at.toISOString(),
            amount: '10',
            unit: 'L',
            isFull: true,
            cost,
            currency,
          },
          headers: { 'idempotency-key': newId() },
        }),
        201,
      );
    }
    const c = ok(
      await call(t, `/api/v1/things/${car.id}/costs?from=${lastMonth}&to=${lastMonth}-28`, {
        as: alfred,
      }),
    ) as unknown as Costs;
    expect(c.months).toHaveLength(1);
    expect(c.totals.map((x) => [x.currency, x.fuel])).toEqual([
      ['EGP', '100'],
      ['USD', '10'],
    ]);
    const bad = await call(t, `/api/v1/things/${car.id}/costs?from=2026-13`, { as: alfred });
    expect(bad.statusCode).toBe(400);
  });
});

describe('a meter’s series', () => {
  it('gives the accepted readings, the oil change’s threshold and the estimate toward it', async () => {
    const s = ok(
      await call(t, `/api/v1/meters/${corolla.meterId}/series`, { as: talia }),
    ) as unknown as {
      unit: string;
      points: { value: string; source: string }[];
      thresholds: { scheduleId: string; value: string }[];
      estimate?: { perDay: string; through: { value: string }[] };
    };
    expect(s.unit).toBe('km');
    expect(s.points).toHaveLength(24);
    expect(s.points.at(-1)).toMatchObject({ value: '52541', source: 'fuel' });
    expect(s.thresholds).toEqual([
      expect.objectContaining({ scheduleId: oilScheduleId, value: '56695' }),
    ]);
    if (s.estimate) expect(s.estimate.through.at(-1)?.value).toBe('56695');
    const ranged = ok(
      await call(t, `/api/v1/meters/${corolla.meterId}/series?from=${shift.day('2026-09-01')}`, {
        as: talia,
      }),
    ) as unknown as { points: unknown[] };
    // The fixture's September: three fills, and the one on October's first instant.
    expect(ranged.points).toHaveLength(4);
  });
});

describe('starter schedules', () => {
  // catalogue: POST /api/v1/things/:id/starter-schedules
  it('makes the four on a car in km, none the second time; one event, undoable', async () => {
    const car = await vehicle(garage, 'Kia Picanto', 'car');
    const res = ok(
      await call(t, `/api/v1/things/${car.id}/starter-schedules`, { as: bruce, body: {} }),
      201,
    ) as unknown as {
      schedules: { name: string; everyMonths: number; everyUnits: string | null }[];
      undo: { eventId: string };
    };
    expect(res.schedules.map((s) => [s.name, s.everyMonths, s.everyUnits])).toEqual([
      ['Oil change', 12, '10000'],
      ['Tyre rotation', 12, '10000'],
      ['Brake fluid', 24, null],
      ['Air filter', 24, '20000'],
    ]);
    const events = await eventsOf(db, garage.id, car.id);
    const starter = events.filter((e) => e.action === 'schedule.starter');
    expect(starter).toHaveLength(1);
    expect(starter[0]?.id).toBe(res.undo.eventId);
    const again = ok(
      await call(t, `/api/v1/things/${car.id}/starter-schedules`, { as: bruce, body: {} }),
      201,
    );
    expect(again).toEqual({ schedules: [] });
    ok(await call(t, `/api/v1/audit/${res.undo.eventId}/undo`, { as: bruce, body: {} }));
    expect(await own(db, 'SELECT 1 FROM public.schedules WHERE thing_id = $1', [car.id])).toEqual(
      [],
    );
  });

  it('takes some keys, skips a name the car has, and gives a generator months only', async () => {
    const gen = await vehicle(garage, 'Standby generator', 'generator');
    const res = ok(
      await call(t, `/api/v1/things/${gen.id}/starter-schedules`, {
        as: bruce,
        body: { keys: ['oil_change', 'air_filter'] },
      }),
      201,
    ) as unknown as { schedules: { name: string; everyUnits: string | null }[] };
    expect(res.schedules.map((s) => [s.name, s.everyUnits])).toEqual([
      ['Oil change', null],
      ['Air filter', null],
    ]);
    const viewer = await call(t, `/api/v1/things/${gen.id}/starter-schedules`, {
      as: talia,
      body: {},
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('Home', () => {
  it('counts the metered things a person can log a reading on', async () => {
    const forAlfred = ok(await call(t, '/api/v1/home', { as: alfred })) as unknown as {
      meteredThings: number;
    };
    expect(forAlfred.meteredThings).toBeGreaterThan(0);
    const forTalia = ok(await call(t, '/api/v1/home', { as: talia })) as unknown as {
      meteredThings: number;
    };
    expect(forTalia.meteredThings).toBe(0);
    const forPeter = ok(await call(t, '/api/v1/home', { as: peter })) as unknown as {
      meteredThings: number;
    };
    expect(forPeter.meteredThings).toBe(0);
  });
});
