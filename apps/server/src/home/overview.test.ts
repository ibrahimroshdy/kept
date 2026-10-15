import { newId } from '@kept/shared';
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
import type { Insights } from '../insights/service.js';
import type { HomeOverview } from './overview.js';

// Home's overview (1.6, D240) through the front door, as the web calls it (apps/web/src/api/
// inventory/types.ts HomeOverview): the location cards' places, flags and value, the tiles' most
// urgent items, and the Insights teaser; amounts only where the caller's gate shows money; nothing
// from a location the caller can't see. And the activity feed's chips (`kind`).

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home (Household) and the Garage (Complete)
let talia: Person; // viewer of Home
let peter: Person; // sees neither; his own location has things due and valued
let home: Loc;
let garage: Loc;
let kitchen: string;
let tv: Json;
let drill: Json;
let batteries: Json;

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const today = cairoToday();
const Y = Number(today.slice(0, 4));
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

async function purchase(loc: Loc, on: string, currency: string, total: string) {
  await own(
    db,
    `INSERT INTO public.purchases (location_id, purchased_on, currency, total, review_state)
     VALUES ($1, $2, $3, $4, 'confirmed')`,
    [loc.id, on, currency, total],
  );
}

async function valuation(loc: Loc, by: Person, thingId: string, value: string, currency: string) {
  await own(
    db,
    `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                    created_by)
     VALUES ($1, $2, $3, $4, $5, 'estimate', $6)`,
    [loc.id, thingId, value, currency, today, by.userId],
  );
}

async function schedule(loc: Loc, by: Person, thingId: string, name: string, dueOn: string) {
  await own(
    db,
    `INSERT INTO public.schedules (location_id, thing_id, name, due_on, anchor_on, created_by)
     VALUES ($1, $2, $3, $4, $4::date - 30, $5)`,
    [loc.id, thingId, name, dueOn, by.userId],
  );
}

async function lend(loc: Loc, by: Person, thingId: string, dueOn: string, name = 'Murdock') {
  const personId = newId();
  await own(
    db,
    'INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, $3)',
    [personId, loc.accountId, name],
  );
  await own(
    db,
    `INSERT INTO public.loans (location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, 'out', $3, now() - interval '20 days', $4, $5)`,
    [loc.id, thingId, personId, dueOn, by.userId],
  );
}

const overview = async (as: Person) =>
  ok(await call(t, '/api/v1/home/overview', { as })) as unknown as HomeOverview;

const card = (o: HomeOverview, id: string) =>
  o.locations.find((l) => l.id === id) as HomeOverview['locations'][number];

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

  // Home: two rooms (and its Unplaced); a valued TV, a valued lamp in USD, a draft valued but
  // never counted, an uncertain charger, the drill lent out and overdue, a filter due in 3 days.
  kitchen = await place(db, home, 'Kitchen');
  await place(db, home, 'Office');
  tv = await createThing(t, ibrahim, home, { name: 'Samsung TV', placeId: kitchen });
  const lamp = await createThing(t, ibrahim, home, { name: 'Lamp', placeId: kitchen });
  const draft = await createThing(t, ibrahim, home, { name: 'Draft chair' });
  await own(db, `UPDATE public.things SET review_state = 'draft' WHERE id = $1`, [draft.id]);
  const charger = await createThing(t, ibrahim, home, { name: 'USB-C charger' });
  await own(db, 'UPDATE public.things SET location_uncertain = true WHERE id = $1', [charger.id]);
  drill = await createThing(t, ibrahim, home, { name: 'Bosch drill' });
  await lend(home, ibrahim, drill.id, inDays(-3));
  await schedule(home, ibrahim, tv.id, 'Replace the water filter', inDays(3));
  await valuation(home, ibrahim, tv.id, '1000', 'EGP');
  await valuation(home, ibrahim, lamp.id, '150', 'USD');
  await valuation(home, ibrahim, draft.id, '9999', 'EGP');
  // Spending: the teaser's window is this year and the three before it.
  await purchase(home, `${Y - 5}-02-02`, 'EGP', '999');
  await purchase(home, `${Y - 1}-06-01`, 'EGP', '5000');
  await purchase(home, `${Y}-01-15`, 'EGP', '1000');

  // Garage (Complete: Consumables on): batteries low, 2 of 8; a valued compressor.
  batteries = await createThing(t, ibrahim, garage, {
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
  const compressor = await createThing(t, ibrahim, garage, { name: 'Compressor' });
  await valuation(garage, ibrahim, compressor.id, '300', 'EGP');

  // Peter's own: nothing of it may reach Ibrahim's or Talia's overview.
  const his = await createLocation(t, db, peter, 'household', 'Cabin');
  const boat = await createThing(t, peter, his, { name: 'Boat' });
  await valuation(his, peter, boat.id, '50000', 'EGP');
  await schedule(his, peter, boat.id, 'Peter overdue', inDays(-30));
  await own(db, 'UPDATE public.things SET location_uncertain = true WHERE id = $1', [boat.id]);
}, 120_000);

describe('GET /api/v1/home/overview (D240)', () => {
  it('needs a session', async () => {
    expect((await call(t, '/api/v1/home/overview')).statusCode).toBe(401);
  });

  it("an owner's cards: places, flags and value per location, Personal first", async () => {
    const o = await overview(ibrahim);
    expect(o.locations.map((l) => l.id)).toEqual([ibrahim.personalLocationId, garage.id, home.id]);
    const h = card(o, home.id);
    expect(h.places).toBe(2);
    expect(h.flags).toEqual({
      overdue: 1,
      due: 1,
      expiring: 0,
      lentOut: 1,
      uncertain: 1,
      lowStock: 0,
    });
    // The draft's valuation is left out; each currency apart, never added or converted.
    expect(h.value).toEqual({
      things: 4,
      valued: 2,
      byCurrency: [
        { currency: 'EGP', amount: '1000' },
        { currency: 'USD', amount: '150' },
      ],
    });
    expect(h.moneyHidden).toBeUndefined();
    const g = card(o, garage.id);
    expect(g.flags.lowStock).toBe(1);
    expect(g.value?.byCurrency).toEqual([{ currency: 'EGP', amount: '300' }]);
    expect(card(o, ibrahim.personalLocationId).places).toBe(0);
  });

  it("names each tile's most urgent item", async () => {
    const o = await overview(ibrahim);
    // The overdue loan is the agenda's overdue row: the thing, with who has it.
    expect(o.top.overdue).toMatchObject({
      name: 'Bosch drill',
      locationId: home.id,
      dueOn: inDays(-3),
      person: 'Murdock',
    });
    expect(o.top.due).toMatchObject({ name: 'Replace the water filter', dueOn: inDays(3) });
    expect(o.top.expiring).toBeUndefined();
    expect(o.top.lentOut).toMatchObject({ name: 'Bosch drill', person: 'Murdock' });
    expect(o.top.borrowedIn).toBeUndefined();
    expect(o.top.uncertain).toEqual({ name: 'USB-C charger', locationId: home.id });
    expect(o.top.lowStock).toEqual({
      name: 'AA batteries',
      locationId: garage.id,
      quantity: '2',
      minimum: '8',
    });
  });

  it('the Insights teaser: this year and the three before it, as Insights sums them', async () => {
    const o = await overview(ibrahim);
    const ins = o.insights;
    expect(ins).not.toBeNull();
    expect(ins?.thisYear).toBe(Y);
    // From the first year in the window with a purchase; the one five years ago is outside it.
    expect(ins?.years).toEqual([
      { year: Y - 1, soFar: false, byCurrency: [{ currency: 'EGP', amount: '5000' }] },
      { year: Y, soFar: true, byCurrency: [{ currency: 'EGP', amount: '1000' }] },
    ]);
    expect(ins?.value).toEqual({
      things: 6,
      valued: 3,
      byCurrency: [
        { currency: 'EGP', amount: '1300' },
        { currency: 'USD', amount: '150' },
      ],
    });
    expect(new Set(ins?.included)).toEqual(
      new Set([ibrahim.personalLocationId, home.id, garage.id]),
    );
    expect(ins?.hiddenIn).toEqual([]);
    expect(ins?.moneyOff).toEqual([]);
    // The same figures as the Insights page.
    const full = ok(await call(t, '/api/v1/insights', { as: ibrahim })) as unknown as Insights;
    const year = (y: number) => full.spending.years.find((x) => x.year === y)?.byCurrency;
    expect(year(Y)).toEqual(ins?.years.at(-1)?.byCurrency);
    expect(year(Y - 1)).toEqual(ins?.years.at(-2)?.byCurrency);
    const homeValue = full.value.locations.find((l) => l.locationId === home.id);
    expect(homeValue?.byCurrency).toEqual(card(o, home.id).value?.byCurrency);
  });

  it('a viewer: no amounts and no valued count where money is hidden, and no teaser', async () => {
    const o = await overview(talia);
    expect(o.locations.map((l) => l.id)).toEqual([talia.personalLocationId, home.id]);
    const h = card(o, home.id);
    expect(h.moneyHidden).toBe(true);
    expect(h.value).toBeUndefined();
    // What needs attention still shows: a viewer can look.
    expect(h.flags.overdue).toBe(1);
    expect(o.top.uncertain?.name).toBe('USB-C charger');
    // Her Personal shows her money but holds nothing bought or valued: nothing to tease.
    expect(o.insights).toBeNull();
    expect(JSON.stringify(o)).not.toContain('1000');
  });

  it("nothing of a location the caller can't see", async () => {
    const o = await overview(ibrahim);
    const text = JSON.stringify(o);
    expect(text).not.toContain('Boat');
    expect(text).not.toContain('Peter overdue');
    expect(text).not.toContain('50000');
    expect(o.locations).toHaveLength(3);
  });

  it('Money off in the Garage: no value there, and the teaser names it', async () => {
    await switchModule(garage.id, 'money', false);
    try {
      const o = await overview(ibrahim);
      const g = card(o, garage.id);
      expect(g.value).toBeUndefined();
      expect(g.moneyHidden).toBeUndefined();
      expect(o.insights?.moneyOff).toEqual([garage.id]);
      expect(o.insights?.included).not.toContain(garage.id);
      expect(o.insights?.value.byCurrency).toEqual([
        { currency: 'EGP', amount: '1000' },
        { currency: 'USD', amount: '150' },
      ]);
    } finally {
      await switchModule(garage.id, 'money', true);
    }
  });

  it('a module off everywhere counts nothing: Lending and Consumables', async () => {
    await switchModule(home.id, 'lending', false);
    await switchModule(garage.id, 'consumables', false);
    try {
      const o = await overview(ibrahim);
      expect(card(o, home.id).flags.lentOut).toBe(0);
      expect(card(o, garage.id).flags.lowStock).toBe(0);
      expect(o.top.lentOut).toBeUndefined();
      expect(o.top.lowStock).toBeUndefined();
      // The loan's reminder pauses with its module (D113), so it is not overdue either.
      expect(o.top.overdue?.name).not.toBe('Bosch drill');
    } finally {
      await switchModule(home.id, 'lending', true);
      await switchModule(garage.id, 'consumables', true);
    }
  });
});

describe('GET /api/v1/activity?kind= (D240: Home’s chips)', () => {
  let ann: Person;
  let loc: Loc;
  let box: Json;

  beforeAll(async () => {
    ann = await person(t, db, 'ann');
    loc = await createLocation(t, db, ann, 'household', 'Flat');
    const shelf = await place(db, loc, 'Shelf');
    box = await createThing(t, ann, loc, { name: 'Box 3' });
    ok(
      await call(t, '/api/v1/things/move', {
        as: ann,
        body: { thingIds: [box.id], to: { placeId: shelf } },
      }),
    );
    ok(await call(t, `/api/v1/things/${box.id}/seen`, { as: ann, body: {} }));
  });

  const actions = async (kind?: string) => {
    const page = ok(
      await call(t, `/api/v1/activity?locationId=${loc.id}${kind ? `&kind=${kind}` : ''}`, {
        as: ann,
      }),
    ) as unknown as { items: { action: string }[] };
    return page.items.map((e) => e.action);
  };

  it('Added, Moved and Checked each keep their own actions', async () => {
    expect(await actions('added')).toEqual(['thing.create']);
    expect(await actions('moved')).toEqual(['thing.move']);
    expect(await actions('checked')).toEqual(['thing.seen']);
    expect(await actions()).toEqual(expect.arrayContaining(['thing.create', 'thing.move']));
  });

  it('refuses a kind it does not know', async () => {
    const res = await call(t, '/api/v1/activity?kind=deleted', { as: ann });
    expect(res.statusCode).toBe(400);
  });
});
