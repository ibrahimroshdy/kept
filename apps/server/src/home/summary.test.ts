import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import type { HomeResponse } from './service.js';
import type { SummaryResponse } from './summary.js';

// GET /api/v1/summary (D244): Home's counts per location, for Home Assistant and dashboard
// widgets, through the front door with a session and with personal tokens; and the routes D244
// opens to tokens (the vehicles list, the agenda, the schedules list, marking a schedule done, a
// reading sent as Home Assistant's).

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home (Household) and the Garage (Complete)
let talia: Person; // viewer of Home
let peter: Person; // sees neither
let home: Loc;
let garage: Loc;
let filterScheduleId: string;
let car: { id: string; meterId: string };

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const inDays = (n: number) => {
  const d = new Date(`${cairoToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function schedule(loc: Loc, by: Person, thingId: string, name: string, dueOn: string) {
  const rows = await own<{ id: string }>(
    db,
    `INSERT INTO public.schedules (location_id, thing_id, name, due_on, anchor_on, created_by)
     VALUES ($1, $2, $3, $4, $4::date - 30, $5) RETURNING id`,
    [loc.id, thingId, name, dueOn, by.userId],
  );
  return (rows[0] as { id: string }).id;
}

async function lend(loc: Loc, by: Person, thingId: string, dueOn: string) {
  const personId = newId();
  await own(
    db,
    'INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, $3)',
    [personId, loc.accountId, 'Murdock'],
  );
  await own(
    db,
    `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, 'out', $3, now() - interval '20 days', $4, $5)`,
    [loc.id, thingId, personId, dueOn, by.userId],
  );
}

const summary = async (as: Person) =>
  ok(await call(t, '/api/v1/summary', { as })) as unknown as SummaryResponse;

async function makeToken(who: Person, body: Record<string, unknown>): Promise<string> {
  const res = await call(t, '/api/v1/tokens', { as: who, body });
  return (ok(res, 201) as unknown as { secret: string }).secret;
}

function bearer(
  secret: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return call(t, url, { ...opts, headers: { authorization: `Bearer ${secret}`, ...opts.headers } });
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  // Token creation is https only (D181).
  t = await peopleApp(db, { publicUrl: 'https://kept.example' });
  ibrahim = await person(t, db, 'ibrahim');
  talia = await person(t, db, 'talia');
  peter = await person(t, db, 'peter');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, home.id, talia.userId, 'viewer');

  // Home: a TV with a filter due in 3 days, the drill lent out and overdue, an uncertain
  // charger in the Unplaced area, a lamp in the kitchen.
  const kitchen = await place(db, home, 'Kitchen');
  const tv = await createThing(t, ibrahim, home, { name: 'Samsung TV', placeId: kitchen });
  await createThing(t, ibrahim, home, { name: 'Lamp', placeId: kitchen });
  const charger = await createThing(t, ibrahim, home, { name: 'USB-C charger' });
  await own(db, 'UPDATE public.things SET location_uncertain = true WHERE id = $1', [charger.id]);
  const drill = await createThing(t, ibrahim, home, { name: 'Bosch drill', placeId: kitchen });
  await lend(home, ibrahim, drill.id, inDays(-3));
  filterScheduleId = await schedule(home, ibrahim, tv.id, 'Replace the water filter', inDays(3));

  // Garage (Complete): batteries low, 2 of 8; a car with its odometer and an overdue service;
  // a ladder not seen for two years.
  const batteries = await createThing(t, ibrahim, garage, {
    name: 'AA batteries',
    typeId: await builtinType(db, 'batteries'),
    quantity: 2,
  });
  await own(
    db,
    `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
     VALUES ($1, $2, 8, $3)`,
    [batteries.id, garage.id, ibrahim.userId],
  );
  const carThing = await createThing(t, ibrahim, garage, {
    name: 'Toyota Corolla',
    typeId: await builtinType(db, 'car'),
  });
  car = { id: carThing.id, meterId: (carThing.meters as { id: string }[])[0]?.id as string };
  await schedule(garage, ibrahim, car.id, 'Oil change', inDays(-10));
  const ladder = await createThing(t, ibrahim, garage, { name: 'Ladder' });
  await own(
    db,
    `UPDATE public.things SET last_seen_at = now() - interval '2 years' WHERE id = $1`,
    [ladder.id],
  );

  // Peter's own cabin: nothing of it may reach anyone else's summary.
  const cabin = await createLocation(t, db, peter, 'household', 'Cabin');
  const boat = await createThing(t, peter, cabin, { name: 'Boat' });
  await schedule(cabin, peter, boat.id, 'Peter overdue', inDays(-30));
}, 120_000);

describe('GET /api/v1/summary (D244)', () => {
  it('needs a session or a token', async () => {
    expect((await call(t, '/api/v1/summary')).statusCode).toBe(401);
  });

  it('counts per location, Personal first, null where the module is off', async () => {
    const s = await summary(ibrahim);
    expect(s.locations.map((l) => l.id)).toEqual([ibrahim.personalLocationId, garage.id, home.id]);
    const byId = new Map(s.locations.map((l) => [l.id, l]));
    expect(byId.get(home.id)).toMatchObject({
      name: 'Home',
      kind: 'home',
      counts: {
        things: 4,
        unplaced: 1,
        overdue: 1,
        due: 1,
        expiring: 0,
        lentOut: 1,
        borrowedIn: 0,
        uncertain: 1,
        longUnseen: 0,
        // Household: Consumables is off.
        lowStock: null,
      },
    });
    expect(byId.get(garage.id)?.counts).toEqual({
      things: 3,
      unplaced: 3,
      overdue: 1,
      due: 0,
      expiring: 0,
      lentOut: 0,
      borrowedIn: 0,
      uncertain: 0,
      longUnseen: 1,
      lowStock: 1,
    });
    expect(typeof byId.get(garage.id)?.timeZone).toBe('string');
    expect(Number.isNaN(Date.parse(s.asOf))).toBe(false);
  });

  it("totals equal Home's attention counts for the same person", async () => {
    const s = await summary(ibrahim);
    const h = ok(await call(t, '/api/v1/home', { as: ibrahim })) as unknown as HomeResponse;
    expect(s.totals).toMatchObject({
      overdue: h.attention.overdue,
      due: h.attention.due,
      expiring: h.attention.expiring,
      lentOut: h.attention.lentOut,
      borrowedIn: h.attention.borrowedIn,
      uncertain: h.attention.uncertain,
      longUnseen: h.attention.longUnseen,
      lowStock: h.attention.lowStock,
      unplaced: h.attention.unplaced,
    });
    expect(s.totals.things).toBe(h.locations.reduce((n, l) => n + l.thingCount, 0));
    expect(s.totals).toMatchObject({ overdue: 2, due: 1, lentOut: 1, lowStock: 1 });
  });

  it('shows only the locations the caller can see', async () => {
    const tal = await summary(talia);
    expect(tal.locations.map((l) => l.id).sort()).toEqual(
      [talia.personalLocationId, home.id].sort(),
    );
    const pet = await summary(peter);
    expect(pet.locations.map((l) => l.name)).not.toContain('Home');
    expect(pet.totals.overdue).toBe(1);
  });

  it('a read token sees only its own locations, and nothing of Home it was not given', async () => {
    const secret = await makeToken(ibrahim, {
      name: 'Home Assistant',
      scope: 'read',
      locationIds: [garage.id],
    });
    const s = ok(await bearer(secret, '/api/v1/summary')) as unknown as SummaryResponse;
    expect(s.locations.map((l) => l.id)).toEqual([garage.id]);
    expect(s.totals).toMatchObject({ overdue: 1, lentOut: 0, lowStock: 1 });
    // Home's own read stays with the app.
    const home = await bearer(secret, '/api/v1/home');
    expect(home.statusCode).toBe(403);
    expect((home.json() as { code: string }).code).toBe('token_scope');
  });
});

describe('the routes D244 opens to tokens', () => {
  let reader: string;
  let writer: string;

  beforeAll(async () => {
    reader = await makeToken(ibrahim, {
      name: 'HA read',
      scope: 'read',
      locationIds: [home.id, garage.id],
    });
    writer = await makeToken(ibrahim, {
      name: 'HA write',
      scope: 'write',
      locationIds: [home.id, garage.id],
      // Home and the Garage have different members: say it is meant (D180's warning).
      confirmCrossLocation: true,
    });
  });

  it('a read token lists vehicles, the agenda and schedules', async () => {
    const vehicles = ok(await bearer(reader, '/api/v1/vehicles')) as unknown as {
      items: { thing: { id: string }; meter?: { id: string }; nextDue?: { name: string } }[];
    };
    const corolla = vehicles.items.find((v) => v.thing.id === car.id);
    expect(corolla?.meter?.id).toBe(car.meterId);
    expect(corolla?.nextDue?.name).toBe('Oil change');

    const agenda = ok(await bearer(reader, `/api/v1/agenda?locationId=${home.id}`)) as unknown as {
      items: { sourceId: string; dueOn: string }[];
      counts: { overdue: number; due: number };
    };
    expect(agenda.counts).toMatchObject({ overdue: 1, due: 1 });
    expect(agenda.items.map((i) => i.sourceId)).toContain(filterScheduleId);

    const schedules = ok(
      await bearer(reader, `/api/v1/schedules?locationId=${home.id}`),
    ) as unknown as { items: { id: string; rowVersion: number }[] };
    expect(schedules.items.map((s) => s.id)).toEqual([filterScheduleId]);
  });

  it('a read token may not mark a schedule done', async () => {
    const res = await bearer(reader, `/api/v1/schedules/${filterScheduleId}/complete`, {
      body: {},
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('token_scope');
  });

  it('a write token marks a schedule done, audited as the token', async () => {
    const list = ok(await bearer(writer, `/api/v1/schedules?locationId=${home.id}`)) as unknown as {
      items: { id: string; rowVersion: number }[];
    };
    const before = list.items.find((s) => s.id === filterScheduleId);
    const done = ok(
      await bearer(writer, `/api/v1/schedules/${filterScheduleId}/complete`, {
        body: { servicedOn: cairoToday() },
        headers: { 'if-match': String(before?.rowVersion) },
      }),
    ) as unknown as { schedule: { id: string; lastService: { servicedOn: string } | null } };
    expect(done.schedule.id).toBe(filterScheduleId);
    expect(done.schedule.lastService?.servicedOn).toBe(cairoToday());
    const events = await own<{ action: string }>(
      db,
      `SELECT e.action FROM public.audit_events e
        WHERE e.location_id = $1 AND e.actor_type = 'token'`,
      [home.id],
    );
    // Completing records the service it was (the web's "Done" does the same).
    expect(events.map((e) => e.action)).toEqual(['service_record.create']);
  });

  it("a reading sent as Home Assistant's says so", async () => {
    const res = ok(
      await bearer(writer, `/api/v1/meters/${car.meterId}/readings`, {
        body: { value: '12345', takenAt: new Date().toISOString(), source: 'home_assistant' },
      }),
      201,
    ) as unknown as { reading: Json & { source: string } };
    expect(res.reading.source).toBe('home_assistant');
    const bad = await bearer(writer, `/api/v1/meters/${car.meterId}/readings`, {
      body: { value: '12346', takenAt: new Date().toISOString(), source: 'import' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
