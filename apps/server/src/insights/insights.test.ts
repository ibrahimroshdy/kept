import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { addMonths, type Insights } from './service.js';

// Insights (1.x, D234) through the front door, as the web calls it (apps/web/src/api/insights/
// types.ts): spending per year from purchases, current value per place and location from
// valuations, vehicle costs per month and year, and warranty coverage; per currency, never added
// across currencies; amounts only where the caller's gate shows money; sections only where their
// module is on.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home and the Garage
let talia: Person; // viewer of Home and the Garage
let peter: Person; // sees neither
let home: Loc; // household: money, warranties, vehicles
let garage: Loc; // complete
let tv: Json;
let car: Json;

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const today = cairoToday();
const Y = Number(today.slice(0, 4));
const thisMonth = today.slice(0, 7);
const lastMonth = addMonths(thisMonth, -1);
const twoMonthsAgo = addMonths(thisMonth, -2);
const inDays = (n: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function switchModule(locationId: string, module: string, enabled: boolean) {
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

async function purchase(
  loc: Loc,
  on: string | null,
  money: { currency?: string; total?: string } = {},
  opts: { draft?: boolean; lines?: [string, string | null][] } = {},
) {
  const [row] = await own<{ id: string }>(
    db,
    `INSERT INTO public.purchases (location_id, purchased_on, currency, total, review_state)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [loc.id, on, money.currency ?? null, money.total ?? null, opts.draft ? 'draft' : 'confirmed'],
  );
  for (const [quantity, unitPrice] of opts.lines ?? []) {
    await own(
      db,
      `INSERT INTO public.purchase_lines (location_id, purchase_id, description, quantity, unit_price)
       VALUES ($1, $2, 'Line', $3, $4)`,
      [loc.id, row?.id, quantity, unitPrice],
    );
  }
}

async function valuation(loc: Loc, thingId: string, value: string, currency: string, on: string) {
  await own(
    db,
    `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                    created_by)
     VALUES ($1, $2, $3, $4, $5, 'estimate', $6)`,
    [loc.id, thingId, value, currency, on, ibrahim.userId],
  );
}

async function warranty(
  loc: Loc,
  thingId: string,
  w: { startsOn: string; endsOn?: string; lifetime?: boolean },
) {
  await own(
    db,
    `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, ends_on, lifetime,
                                    lead_days, created_by)
     VALUES ($1, $2, 'manufacturer', $3, $4, $5, 30, $6)`,
    [loc.id, thingId, w.startsOn, w.endsOn ?? null, w.lifetime ?? false, ibrahim.userId],
  );
}

const insights = async (as: Person, ...locations: string[]) =>
  ok(
    await call(
      t,
      `/api/v1/insights${locations.length ? '?' : ''}${locations
        .map((id) => `f.location=${id}`)
        .join('&')}`,
      { as },
    ),
  ) as unknown as Insights;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  talia = await person(t, db, 'talia');
  peter = await person(t, db, 'peter');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, talia.userId, 'viewer');

  // Purchases: two years ago one with no amounts; last year 5,000 EGP and a USD one priced by its
  // lines only; this year (so far) 1,000 EGP; a draft never counts.
  await purchase(home, `${Y - 2}-03-03`);
  await purchase(home, `${Y - 1}-06-01`, { currency: 'EGP', total: '5000' });
  await purchase(
    home,
    `${Y - 1}-07-01`,
    { currency: 'USD' },
    {
      lines: [
        ['2', '150'],
        ['1', null],
      ],
    },
  );
  await purchase(home, `${Y}-01-01`, { currency: 'EGP', total: '1000' });
  await purchase(home, null, { currency: 'EGP', total: '777' }, { draft: true });

  // Places and things: the TV on a shelf in the living room, a box in the kitchen with a mixer
  // and a lamp in it, a plate unplaced; a sold radio and a trashed vase never count.
  const kitchen = await place(db, home, 'Kitchen');
  const living = await place(db, home, 'Living room');
  const shelf = await place(db, home, 'Shelf', living);
  tv = await createThing(t, ibrahim, home, { name: 'TV', placeId: shelf });
  const box = await createThing(t, ibrahim, home, {
    name: 'Box',
    typeId: await builtinType(db, 'box_bin'),
    placeId: kitchen,
  });
  const mixer = await createThing(t, ibrahim, home, { name: 'Mixer', containerId: box.id });
  const lamp = await createThing(t, ibrahim, home, { name: 'Lamp', containerId: box.id });
  await createThing(t, ibrahim, home, { name: 'Plate' });
  const radio = await createThing(t, ibrahim, home, { name: 'Radio', placeId: kitchen });
  const vase = await createThing(t, ibrahim, home, { name: 'Vase', placeId: kitchen });
  await valuation(home, tv.id, '15000', 'EGP', `${Y - 1}-01-01`);
  await valuation(home, tv.id, '20000', 'EGP', `${Y}-01-01`);
  await valuation(home, mixer.id, '3000', 'EGP', `${Y - 1}-05-05`);
  await valuation(home, lamp.id, '100', 'USD', `${Y - 1}-05-05`);
  await valuation(home, radio.id, '500', 'EGP', `${Y - 1}-05-05`);
  await valuation(home, vase.id, '999', 'EGP', `${Y - 1}-05-05`);
  await own(db, `UPDATE public.things SET lifecycle = 'sold', ended_on = $2 WHERE id = $1`, [
    radio.id,
    today,
  ]);
  await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [vase.id]);

  // Warranties: the TV's ends in 10 days (lead 30: expiring), the mixer's is lifetime, the lamp's
  // ended, the box's starts next month (it covers, as the coverage bar says), the plate has none.
  await warranty(home, tv.id, { startsOn: `${Y - 1}-01-01`, endsOn: inDays(10) });
  await warranty(home, mixer.id, { startsOn: `${Y - 1}-01-01`, lifetime: true });
  await warranty(home, lamp.id, { startsOn: `${Y - 2}-01-01`, endsOn: inDays(-5) });
  await warranty(home, box.id, { startsOn: inDays(30), endsOn: inDays(400) });
  await own(
    db,
    `INSERT INTO public.claims (location_id, thing_id, opened_on, status, cost, currency,
                                covered_amount, closed_on, created_by)
     VALUES ($1, $2, $3, 'resolved', 500, 'EGP', 400, $3, $4)`,
    [home.id, tv.id, `${Y}-01-01`, ibrahim.userId],
  );

  // The Garage's car: a fill last month (800), a confirmed service two months ago (1,500), a
  // draft service (never counts), and a fill this month (so far: in the year, not the months).
  car = await createThing(t, ibrahim, garage, {
    name: 'Corolla',
    typeId: await builtinType(db, 'car'),
  });
  const fill = (at: string, cost: string) =>
    own(
      db,
      `INSERT INTO public.fuel_entries (location_id, thing_id, taken_at, amount, unit, currency,
                                        cost, logged_by)
       VALUES ($1, $2, $3, 40, 'L', 'EGP', $4, $5)`,
      [garage.id, car.id, at, cost, ibrahim.userId],
    );
  await fill(`${lastMonth}-15T10:00:00Z`, '800');
  await fill(new Date(Date.now() - 60_000).toISOString(), '400');
  for (const [on, total, state] of [
    [`${twoMonthsAgo}-10`, '1500', 'confirmed'],
    [`${lastMonth}-10`, '999', 'draft'],
  ] as const) {
    await own(
      db,
      `INSERT INTO public.service_records (location_id, thing_id, serviced_on, total, currency,
                                           logged_by, review_state)
       VALUES ($1, $2, $3, $4, 'EGP', $5, $6)`,
      [garage.id, car.id, on, total, ibrahim.userId, state],
    );
  }
});

afterAll(async () => {
  await t.app.close();
});

describe('GET /api/v1/insights', () => {
  it('adds spending per year and currency, with this year so far apart', async () => {
    const r = await insights(ibrahim, home.id);
    expect(r.locations).toEqual([{ id: home.id, money: true, vehicles: true, warranties: true }]);
    expect(r.thisYear).toBe(Y);
    expect(r.spending).toEqual({
      years: [
        { year: Y - 2, soFar: false, purchases: 1, unpriced: 1, byCurrency: [] },
        {
          year: Y - 1,
          soFar: false,
          purchases: 2,
          unpriced: 0,
          byCurrency: [
            { currency: 'EGP', amount: '5000' },
            { currency: 'USD', amount: '300' },
          ],
        },
        {
          year: Y,
          soFar: true,
          purchases: 1,
          unpriced: 0,
          byCurrency: [{ currency: 'EGP', amount: '1000' }],
        },
      ],
      hiddenIn: [],
    });
  });

  it('values each place by its things’ newest valuations, through containers and sub-places', async () => {
    const r = await insights(ibrahim, home.id);
    const loc = r.value.locations[0];
    expect(loc).toMatchObject({
      locationId: home.id,
      things: 5,
      valued: 3,
      byCurrency: [
        { currency: 'EGP', amount: '23000' },
        { currency: 'USD', amount: '100' },
      ],
    });
    expect(loc?.moneyHidden).toBeUndefined();
    const places = (loc?.places ?? []).map((p) => ({
      name: p.unplaced ? 'Unplaced' : p.name,
      things: p.things,
      valued: p.valued,
      byCurrency: p.byCurrency,
    }));
    expect(places).toEqual([
      {
        name: 'Kitchen',
        things: 3,
        valued: 2,
        byCurrency: [
          { currency: 'EGP', amount: '3000' },
          { currency: 'USD', amount: '100' },
        ],
      },
      {
        name: 'Living room',
        things: 1,
        valued: 1,
        byCurrency: [{ currency: 'EGP', amount: '20000' }],
      },
      { name: 'Unplaced', things: 1, valued: 0, byCurrency: [] },
    ]);
  });

  it('counts warranty coverage and lists what ends soon, with the year’s repairs', async () => {
    const r = await insights(ibrahim, home.id);
    expect(r.warranties).toMatchObject({
      things: 5,
      covered: 2,
      expiring: 1,
      ended: 1,
      none: 1,
      expiringSoon: [{ id: tv.id, name: 'TV', locationId: home.id, endsOn: inDays(10) }],
      repairs: [
        { year: Y - 1, soFar: false, resolved: 0, byCurrency: [] },
        {
          year: Y,
          soFar: true,
          resolved: 1,
          byCurrency: [{ currency: 'EGP', cost: '500', covered: '400' }],
        },
      ],
      hiddenIn: [],
    });
  });

  it('adds the vehicles’ costs per full month, and per vehicle per year', async () => {
    const r = await insights(ibrahim, garage.id);
    const v = r.vehicles;
    expect(v?.thisMonth).toBe(thisMonth);
    expect(v?.months).toHaveLength(12);
    expect(v?.months.at(-1)).toEqual({
      month: lastMonth,
      byCurrency: [{ currency: 'EGP', fuel: '800', service: '0', fees: '0', total: '800' }],
    });
    expect(v?.months.at(-2)).toEqual({
      month: twoMonthsAgo,
      byCurrency: [{ currency: 'EGP', fuel: '0', service: '1500', fees: '0', total: '1500' }],
    });
    expect(v?.months.some((m) => m.month === thisMonth)).toBe(false);
    const item = v?.items[0];
    expect(item).toMatchObject({
      id: car.id,
      name: 'Corolla',
      locationId: garage.id,
      ended: false,
    });
    // Fills and services fall in their own year: last month and two months ago may be last year.
    const expected = new Map<
      number,
      { fills: number; services: number; fuel: bigint; service: bigint }
    >();
    const add = (month: string, k: 'fills' | 'services', amount: number) => {
      const y = Number(month.slice(0, 4));
      const e = expected.get(y) ?? { fills: 0, services: 0, fuel: 0n, service: 0n };
      e[k] += 1;
      if (k === 'fills') e.fuel += BigInt(amount);
      else e.service += BigInt(amount);
      expected.set(y, e);
    };
    add(lastMonth, 'fills', 800);
    add(thisMonth, 'fills', 400);
    add(twoMonthsAgo, 'services', 1500);
    expect(item?.years.map((y) => y.year)).toEqual([Y - 2, Y - 1, Y]);
    for (const y of item?.years ?? []) {
      const e = expected.get(y.year);
      expect(y.soFar).toBe(y.year === Y);
      expect(y.fills).toBe(e?.fills ?? 0);
      expect(y.services).toBe(e?.services ?? 0);
      expect(y.byCurrency).toEqual(
        e
          ? [
              {
                currency: 'EGP',
                fuel: String(e.fuel),
                service: String(e.service),
                fees: '0',
                total: String(e.fuel + e.service),
              },
            ]
          : [],
      );
    }
  });

  it('gives a viewer counts, not amounts, and names the locations it left out (D13)', async () => {
    const r = await insights(talia, home.id, garage.id);
    expect(r.locations.map((l) => [l.id, l.money])).toEqual([
      [home.id, false],
      [garage.id, false],
    ]);
    expect(r.spending.hiddenIn).toEqual([home.id, garage.id]);
    expect(r.spending.years.map((y) => [y.year, y.purchases, y.unpriced, y.byCurrency])).toEqual([
      [Y - 2, 1, 0, []],
      [Y - 1, 2, 0, []],
      [Y, 1, 0, []],
    ]);
    const loc = r.value.locations.find((l) => l.locationId === home.id);
    expect(loc).toMatchObject({ things: 5, moneyHidden: true });
    expect(loc?.valued).toBeUndefined();
    expect(loc?.byCurrency).toBeUndefined();
    expect(loc?.places.every((p) => p.byCurrency === undefined && p.valued === undefined)).toBe(
      true,
    );
    expect(r.vehicles?.months.every((m) => m.byCurrency.length === 0)).toBe(true);
    const car_ = r.vehicles?.items.find((i) => i.id === car.id);
    expect(car_?.moneyHidden).toBe(true);
    expect(car_?.years.every((y) => y.byCurrency === undefined)).toBe(true);
    expect(car_?.years.reduce((a, y) => a + y.fills, 0)).toBe(2);
    // The Garage's car has no warranty: the Garage has Warranties & claims on too.
    expect(r.warranties).toMatchObject({ covered: 2, expiring: 1, ended: 1, none: 2 });
    expect(r.warranties?.repairs.every((y) => y.byCurrency === undefined)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/"(amount|fuel|service|fees|total|cost)":/);

    // Home lets viewers see money: its amounts come back; the Garage's stay out.
    await own(db, 'UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      const shown = await insights(talia, home.id, garage.id);
      expect(shown.spending.hiddenIn).toEqual([garage.id]);
      expect(shown.spending.years.at(-1)?.byCurrency).toEqual([
        { currency: 'EGP', amount: '1000' },
      ]);
      expect(shown.value.locations.find((l) => l.locationId === home.id)?.byCurrency).toEqual([
        { currency: 'EGP', amount: '23000' },
        { currency: 'USD', amount: '100' },
      ]);
      expect(shown.vehicles?.items.find((i) => i.id === car.id)?.moneyHidden).toBe(true);
    } finally {
      await own(db, 'UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });

  it('shows a section only where its module is on, and Insights only where Money is', async () => {
    await switchModule(home.id, 'warranties', false);
    await switchModule(home.id, 'vehicles', false);
    try {
      const r = await insights(ibrahim, home.id);
      expect(r.warranties).toBeNull();
      expect(r.vehicles).toBeNull();
      expect(r.value.locations).toHaveLength(1);
    } finally {
      await switchModule(home.id, 'warranties', true);
      await switchModule(home.id, 'vehicles', true);
    }
    await switchModule(garage.id, 'money', false);
    try {
      const r = await insights(ibrahim, garage.id);
      expect(r.locations).toEqual([]);
      expect(r.spending.years).toEqual([]);
      expect(r.vehicles).toBeNull();
      const all = await insights(ibrahim);
      expect(all.locations.map((l) => l.id)).toContain(home.id);
      expect(all.locations.map((l) => l.id)).not.toContain(garage.id);
    } finally {
      await switchModule(garage.id, 'money', true);
    }
  });

  it('never counts a location the caller can’t see', async () => {
    const r = await insights(peter, home.id);
    expect(r.locations).toEqual([]);
    expect(r.value.locations).toEqual([]);
    const all = await insights(peter);
    expect(JSON.stringify(all)).not.toContain(home.id);
    expect(JSON.stringify(all)).not.toContain(garage.id);
  });

  it('refuses a location filter that isn’t an id', async () => {
    const res = await call(t, '/api/v1/insights?f.location=garage', { as: ibrahim });
    expect(res.statusCode).toBe(400);
  });
});
