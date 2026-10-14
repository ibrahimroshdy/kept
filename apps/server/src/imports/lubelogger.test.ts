import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { builtinType, createLocation, createThing, type Loc, own } from '../../test/things.js';
import { lubeDate, lubeNumber } from './lubelogger.js';

// 1.3, D229: LubeLogger's per-vehicle CSV exports (fuel, service, odometer) into a Kept vehicle,
// through the front door. The rows are what LubeLogger's ExportFromVehicleToCsv writes (its
// headers, its culture's dates and money), as the web sends them after parsing.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner
let alfred: Person; // member
let garage: Loc;
let carType: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  alfred = await person(t, db, 'alfred');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, garage.id, alfred.userId, 'member');
  carType = await builtinType(db, 'car');
});

afterAll(async () => {
  await t.app.close();
});

async function newCar(name: string): Promise<string> {
  return (await createThing(t, ibrahim, garage, { name, typeId: carType })).id;
}

const lube = (as: Person, carId: string, body: object) =>
  call(t, `/api/v1/things/${carId}/import/lubelogger`, { as, body });

const fuelRows = [
  {
    Date: '10/8/2026 12:00:00 AM',
    Odometer: '10900',
    FuelConsumed: '40.25',
    Cost: '61.10',
    FuelEconomy: '9.9',
    IsFillToFull: 'False',
    MissedFuelUp: 'False',
    Notes: 'Half tank',
    Tags: '',
  },
  {
    Date: '10/1/2026 12:00:00 AM',
    Odometer: '10500',
    FuelConsumed: '42.5',
    Cost: '65.30',
    FuelEconomy: '',
    IsFillToFull: 'True',
    MissedFuelUp: 'False',
    Notes: '',
    Tags: 'highway',
  },
];

describe('reading LubeLogger’s culture', () => {
  it('reads dates in the order asked, a time after them ignored, and refuses nonsense', () => {
    expect(lubeDate('10/8/2026 12:00:00 AM', 'mdy')).toBe('2026-10-08');
    expect(lubeDate('08.10.2026', 'dmy')).toBe('2026-10-08');
    expect(lubeDate('2026-10-08', 'ymd')).toBe('2026-10-08');
    expect(lubeDate('31/02/2026', 'dmy')).toBeNull();
    expect(lubeDate('soon', 'mdy')).toBeNull();
  });

  it('reads money and volumes with either decimal mark, symbols and grouping dropped', () => {
    expect(lubeNumber('$1,234.56', '.')).toBe('1234.56');
    expect(lubeNumber('1.234,56 €', ',')).toBe('1234.56');
    expect(lubeNumber('42,5', ',')).toBe('42.5');
    expect(lubeNumber('', '.')).toBeNull();
    expect(lubeNumber('n/a', '.')).toBeNull();
  });
});

describe('POST /api/v1/things/:id/import/lubelogger', () => {
  // catalogue: POST /api/v1/things/:id/import/lubelogger
  it('imports fuel oldest first with odometer readings, audited; a dry run changes nothing; a second import adds nothing', async () => {
    const car = await newCar('Corolla');
    const body = { kind: 'fuel', rows: fuelRows, dateOrder: 'mdy', decimal: '.', fuelUnit: 'L' };
    const dry = await lube(ibrahim, car, { ...body, dryRun: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toEqual({ created: 2, skipped: 0, issues: [], dryRun: true });
    expect(await own(db, 'SELECT 1 FROM public.fuel_entries WHERE thing_id = $1', [car])).toEqual(
      [],
    );

    const res = await lube(ibrahim, car, body);
    expect(res.json()).toEqual({ created: 2, skipped: 0, issues: [], dryRun: false });
    const fills = (await own(
      db,
      `SELECT f.amount::text, f.cost::text, f.is_full, r.value::text AS odometer, r.source
         FROM public.fuel_entries f JOIN public.meter_readings r ON r.id = f.meter_reading_id
        WHERE f.thing_id = $1 ORDER BY f.taken_at`,
      [car],
    )) as Array<Record<string, unknown>>;
    expect(fills).toEqual([
      { amount: '42.500', cost: '65.3000', is_full: true, odometer: '10500.000', source: 'fuel' },
      { amount: '40.250', cost: '61.1000', is_full: false, odometer: '10900.000', source: 'fuel' },
    ]);
    const events = (await own(
      db,
      `SELECT action FROM public.audit_events WHERE root_thing_id = $1 AND action = 'fuel.create'`,
      [car],
    )) as Array<{ action: string }>;
    expect(events).toHaveLength(2);

    expect((await lube(ibrahim, car, body)).json()).toEqual({
      created: 0,
      skipped: 2,
      issues: [],
      dryRun: false,
    });
  });

  it('imports service records with a day-first date and a decimal comma', async () => {
    const car = await newCar('Golf');
    const res = await lube(ibrahim, car, {
      kind: 'service',
      dateOrder: 'dmy',
      decimal: ',',
      rows: [
        {
          Date: '03.09.2026',
          Description: 'Oil and filter',
          Cost: '1.234,56 €',
          Notes: 'Dealer',
          Odometer: '9800',
          Tags: '',
        },
        { Date: '04.09.2026', Description: '', Cost: '', Notes: '', Odometer: '', Tags: '' },
      ],
    });
    expect(res.json()).toEqual({
      created: 1,
      skipped: 0,
      issues: [{ row: 2, code: 'description' }],
      dryRun: false,
    });
    const [svc] = (await own(
      db,
      `SELECT s.serviced_on::text, s.total::text, s.notes, l.description
         FROM public.service_records s JOIN public.service_lines l ON l.service_record_id = s.id
        WHERE s.thing_id = $1`,
      [car],
    )) as Array<Record<string, unknown>>;
    expect(svc).toEqual({
      serviced_on: '2026-09-03',
      total: '1234.5600',
      notes: 'Dealer',
      description: 'Oil and filter',
    });
  });

  it('imports odometer readings, and keeps going past one that runs backwards', async () => {
    const car = await newCar('Civic');
    const res = await lube(ibrahim, car, {
      kind: 'odometer',
      dateOrder: 'ymd',
      decimal: '.',
      rows: [
        { Date: '2026-09-01', InitialOdometer: '', Odometer: '5000', Notes: '', Tags: '' },
        { Date: '2026-09-15', InitialOdometer: '', Odometer: '4000', Notes: '', Tags: '' },
        { Date: '2026-10-01', InitialOdometer: '', Odometer: '6000', Notes: '', Tags: '' },
        { Date: 'later', InitialOdometer: '', Odometer: '7000', Notes: '', Tags: '' },
      ],
    });
    const out = res.json() as { created: number; issues: Array<{ row: number; code: string }> };
    expect(out.created).toBe(2);
    expect(out.issues.map((i) => i.row)).toEqual([2, 4]);
    expect(out.issues[1]?.code).toBe('date');
    const readings = (await own(
      db,
      `SELECT r.value::text, r.source FROM public.meter_readings r
         JOIN public.meters m ON m.id = r.meter_id WHERE m.thing_id = $1 ORDER BY r.taken_at`,
      [car],
    )) as Array<Record<string, unknown>>;
    expect(readings).toEqual([
      { value: '5000.000', source: 'import' },
      { value: '6000.000', source: 'import' },
    ]);
  });

  it('is for owners and admins, and refuses a file that is not that kind of export', async () => {
    const car = await newCar('Yaris');
    const body = { kind: 'fuel', rows: fuelRows, dateOrder: 'mdy', decimal: '.', fuelUnit: 'L' };
    expect((await lube(alfred, car, body)).statusCode).toBe(403);
    const wrong = await lube(ibrahim, car, { ...body, rows: [{ Date: '1/1/2026', Foo: '1' }] });
    expect(wrong.statusCode).toBe(400);
    const noUnit = await lube(ibrahim, car, { ...body, fuelUnit: undefined });
    expect(noUnit.statusCode).toBe(400);
  });
});
