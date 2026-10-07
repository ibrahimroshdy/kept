import { newId } from '@kept/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, ok, own, place } from '../../test/things.js';

// T13 through the front door: GET /api/v1/agenda and Home's step-4 attention rows, as the web
// calls them (apps/web/src/api/household/{types,paths}.ts, mock/agenda.ts). The sources are
// seeded as kept_owner (their own routes are T9–T12's); every read goes through the app.
//
// Ibrahim owns Home and Garage (Household). In Home, Louis is a member and Talia a viewer.
// Alfred owns بيت العائلة and shares nothing with them.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;
let alfreds: Loc;

type Item = {
  key: string;
  sourceType: string;
  sourceId: string;
  kind: string;
  state: string;
  locationId: string;
  subject: { type: string; id: string; name: string; path: string };
  title: string;
  dueOn: string | null;
  dueValue: string | null;
  unit: string | null;
  actions: string[];
};
type Counts = { overdue: number; due: number; expiring: number };
type AgendaPage = { items: Item[]; counts: Counts; next_cursor: string | null };
type Home = {
  attention: Record<string, number>;
  agendaBySource: Record<'overdue' | 'due' | 'expiring', Record<string, number>>;
};

const todayIn = (timeZone: string) => new Date().toLocaleDateString('en-CA', { timeZone });
const cairo = () => todayIn('Africa/Cairo');
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function thing(loc: Loc, name: string, by: Person, fields: { expiresOn?: string } = {}) {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.things (id, location_id, place_id, name, expires_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, loc.id, loc.unplacedId, name, fields.expiresOn ?? null, by.userId],
  );
  return id;
}

async function schedule(
  loc: Loc,
  by: Person,
  f: { thingId?: string; placeId?: string; name: string; dueOn: string },
) {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.schedules (id, location_id, thing_id, place_id, name, due_on, anchor_on,
                                   created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6::date - 30, $7)`,
    [id, loc.id, f.thingId ?? null, f.placeId ?? null, f.name, f.dueOn, by.userId],
  );
  return id;
}

async function warranty(loc: Loc, by: Person, thingId: string, endsOn: string, provider?: string) {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, provider, starts_on, ends_on,
                                    created_by)
     VALUES ($1, $2, $3, 'manufacturer', $4, $5::date - 365, $5, $6)`,
    [id, loc.id, thingId, provider ?? null, endsOn, by.userId],
  );
  return id;
}

async function documentOn(loc: Loc, by: Person, expiresOn: string, title: string | null = null) {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.expiring_documents (id, location_id, kind, title, expires_on, created_by)
     VALUES ($1, $2, 'insurance', $3, $4, $5)`,
    [id, loc.id, title, expiresOn, by.userId],
  );
  return id;
}

async function loan(
  loc: Loc,
  by: Person,
  thingId: string,
  direction: 'out' | 'in',
  dueOn: string | null,
) {
  const personId = newId();
  await own(
    db,
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Murdock')`,
    [personId, loc.accountId],
  );
  const id = newId();
  await own(
    db,
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '20 days', $6, $7)`,
    [id, loc.id, thingId, direction, personId, dueOn, by.userId],
  );
  return id;
}

async function switchModule(locationId: string, module: string, enabled: boolean) {
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

async function agenda(as: Person, query = ''): Promise<AgendaPage> {
  return ok(await call(t, `/api/v1/agenda${query}`, { as })) as unknown as AgendaPage;
}

/** Every page of a list. */
async function all(as: Person, query = ''): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query.replace(/^\?/, ''));
    params.set('limit', '2');
    if (cursor) params.set('cursor', cursor);
    const page: AgendaPage = await agenda(as, `?${params}`);
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

async function homeOf(as: Person): Promise<Home> {
  return ok(await call(t, '/api/v1/home', { as })) as unknown as Home;
}

beforeAll(async () => {
  db = await testDb();
  t = await peopleApp(db);
});

beforeEach(async () => {
  await db.reset();
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  alfreds = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

/** One of every source, in every state that matters, in Home. */
async function seedHome() {
  const today = cairo();
  const kitchen = await place(db, home, 'Kitchen');
  const drill = await thing(home, 'Drill', ibrahim);
  const tv = await thing(home, 'TV', ibrahim);
  const ladder = await thing(home, 'Ladder', ibrahim);
  const extinguisher = await thing(home, 'Extinguisher', ibrahim, { expiresOn: addDays(today, 5) });
  const ids = {
    boilerOverdue: await schedule(home, ibrahim, {
      placeId: kitchen,
      name: 'Boiler service',
      dueOn: addDays(today, -3),
    }),
    descaleDue: await schedule(home, ibrahim, {
      thingId: tv,
      name: 'Descale',
      dueOn: addDays(today, 3),
    }),
    filterUpcoming: await schedule(home, ibrahim, {
      thingId: tv,
      name: 'Filter',
      dueOn: addDays(today, 90),
    }),
    tvWarranty: await warranty(home, ibrahim, tv, addDays(today, 10), 'B.TECH'),
    endedWarranty: await warranty(home, ibrahim, drill, addDays(today, -10)),
    insuranceExpiring: await documentOn(home, ibrahim, addDays(today, 20), 'Home insurance'),
    licenceOverdue: await documentOn(home, ibrahim, addDays(today, -1)),
    drillOverdue: await loan(home, ibrahim, drill, 'out', addDays(today, -2)),
    ladderIn: await loan(home, ibrahim, ladder, 'in', null),
    extinguisher,
    kitchen,
    tv,
  };
  return ids;
}

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/agenda', () => {
  it('lists every source by state, then day, with its subject, title and actions', async () => {
    const s = await seedHome();
    const page = await agenda(ibrahim, `?locationId=${home.id}&limit=50`);
    const by = (id: string) => page.items.find((i) => i.sourceId === id);
    expect(page.items.map((i) => i.state)).toEqual([
      'overdue',
      'overdue',
      'overdue',
      'due',
      'expiring',
      'expiring',
      'expiring',
      'upcoming',
    ]);
    expect(by(s.boilerOverdue)).toMatchObject({
      sourceType: 'schedule',
      kind: 'overdue',
      title: 'Boiler service',
      subject: { type: 'place', id: s.kitchen, name: 'Kitchen', path: 'Home' },
      actions: ['complete', 'snooze', 'open'],
    });
    expect(by(s.boilerOverdue)?.key).toBe(
      `schedule:${s.boilerOverdue}:overdue:date:${addDays(cairo(), -3)}`,
    );
    expect(by(s.tvWarranty)).toMatchObject({
      sourceType: 'warranty',
      kind: 'expiring',
      state: 'expiring',
      title: 'B.TECH',
      subject: { type: 'thing', id: s.tv, name: 'TV' },
      actions: ['open'],
    });
    // An ended warranty isn't actionable (Q7).
    expect(by(s.endedWarranty)).toBeUndefined();
    expect(by(s.licenceOverdue)).toMatchObject({
      sourceType: 'document',
      title: 'insurance',
      state: 'overdue',
      subject: { type: 'location', id: home.id, path: '' },
      actions: ['renew', 'open'],
    });
    expect(by(s.drillOverdue)).toMatchObject({
      sourceType: 'loan',
      title: 'Drill',
      state: 'overdue',
      actions: ['mark_returned', 'open'],
    });
    expect(by(s.extinguisher)).toMatchObject({ sourceType: 'thing_expiry', state: 'expiring' });
    // A loan with no due date is never on the agenda.
    expect(by(s.ladderIn)).toBeUndefined();
  });

  it('every count equals the length of the list it opens, across pages', async () => {
    await seedHome();
    for (const q of ['', '?sourceType=schedule', '?sourceType=warranty,document,thing_expiry']) {
      const { counts } = await agenda(ibrahim, q);
      for (const state of ['overdue', 'due', 'expiring'] as const) {
        const list = await all(ibrahim, `${q}${q ? '&' : '?'}state=${state}`);
        expect(list.every((i) => i.state === state)).toBe(true);
        expect(list, `${q} ${state}`).toHaveLength(counts[state]);
      }
    }
    // Pages are disjoint and complete.
    const everything = await all(ibrahim);
    expect(new Set(everything.map((i) => i.key)).size).toBe(everything.length);
    expect(everything).toHaveLength(8);
  });

  it('narrows by source, location and dates', async () => {
    const s = await seedHome();
    const today = cairo();
    const schedules = await agenda(ibrahim, '?sourceType=schedule');
    expect(schedules.items.map((i) => i.sourceId).sort()).toEqual(
      [s.boilerOverdue, s.descaleDue, s.filterUpcoming].sort(),
    );
    expect(schedules.counts).toEqual({ overdue: 1, due: 1, expiring: 0 });
    expect((await agenda(ibrahim, `?locationId=${garage.id}`)).items).toEqual([]);
    const soon = await agenda(ibrahim, `?from=${today}&to=${addDays(today, 15)}`);
    expect(soon.items.map((i) => i.sourceId).sort()).toEqual(
      [s.descaleDue, s.tvWarranty, s.extinguisher].sort(),
    );
    // Low stock is listed only when asked for (0104; its own list is Consumables).
    expect((await agenda(ibrahim, '?sourceType=stock')).items).toEqual([]);
    const bad = await call(t, '/api/v1/agenda?sourceType=stocks', { as: ibrahim });
    expect(bad.statusCode).toBe(400);
  });

  it('respects row-level security and roles: a viewer only opens, Alfred sees nothing', async () => {
    const s = await seedHome();
    const hers = await agenda(talia, '?limit=50');
    expect(hers.items).toHaveLength(8);
    expect(hers.items.every((i) => i.actions.length === 1 && i.actions[0] === 'open')).toBe(true);
    const his = await agenda(louis, '?limit=50');
    expect(his.items.find((i) => i.sourceId === s.descaleDue)?.actions).toEqual([
      'complete',
      'snooze',
      'open',
    ]);
    const alfredsOwn = await agenda(alfred);
    expect(alfredsOwn).toEqual({
      items: [],
      counts: { overdue: 0, due: 0, expiring: 0 },
      next_cursor: null,
    });
  });

  it('pauses a module’s sources (D162) and a trashed thing’s warranty, in list and counts', async () => {
    const s = await seedHome();
    const before = await agenda(ibrahim);
    await switchModule(home.id, 'warranties', false);
    const off = await agenda(ibrahim, '?limit=50');
    expect(off.items.find((i) => i.sourceId === s.tvWarranty)).toBeUndefined();
    expect(off.counts.expiring).toBe(before.counts.expiring - 1);
    await switchModule(home.id, 'warranties', true);
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [s.tv]);
    const trashed = await agenda(ibrahim, '?limit=50');
    // The TV's warranty and its two schedules rest with it.
    expect(trashed.items.map((i) => i.sourceId)).not.toContain(s.tvWarranty);
    expect(trashed.items.map((i) => i.sourceId)).not.toContain(s.descaleDue);
    expect(trashed.counts).toEqual({
      overdue: before.counts.overdue,
      due: before.counts.due - 1,
      expiring: before.counts.expiring - 1,
    });
  });

  it("decides overdue on the location's own date (§7.13)", async () => {
    // Pago Pago (UTC−11) and Kiritimati (UTC+14) are 25 hours apart: their dates always differ.
    const pago = await createLocation(t, db, ibrahim, 'household', 'Pago Pago');
    const kiri = await createLocation(t, db, ibrahim, 'household', 'Kiritimati');
    await own(db, `UPDATE public.locations SET timezone = 'Pacific/Pago_Pago' WHERE id = $1`, [
      pago.id,
    ]);
    await own(db, `UPDATE public.locations SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [
      kiri.id,
    ]);
    const day = todayIn('Pacific/Pago_Pago');
    const a = await schedule(pago, ibrahim, {
      name: 'Check',
      dueOn: day,
      placeId: pago.unplacedId,
    });
    const b = await schedule(kiri, ibrahim, {
      name: 'Check',
      dueOn: day,
      placeId: kiri.unplacedId,
    });
    const items = (await agenda(ibrahim, '?sourceType=schedule&limit=50')).items;
    expect(items.find((i) => i.sourceId === a)?.state).toBe('due');
    expect(items.find((i) => i.sourceId === b)?.state).toBe('overdue');
  });
});

describe("GET /api/v1/home: step 4's attention rows (T13)", () => {
  it('overdue, due and expiring are the agenda’s counts; loans are the open ones', async () => {
    await seedHome();
    const h = await homeOf(ibrahim);
    const { counts } = await agenda(ibrahim);
    expect(h.attention).toMatchObject({
      overdue: counts.overdue,
      due: counts.due,
      expiring: counts.expiring,
      lentOut: 1,
      borrowedIn: 1,
    });
    expect(h.agendaBySource).toEqual({
      overdue: { schedule: 1, document: 1, loan: 1 },
      due: { schedule: 1 },
      expiring: { warranty: 1, document: 1, thing_expiry: 1 },
    });
    // The rows' counts are what their lists show.
    expect((await all(ibrahim, '?state=overdue')).length).toBe(h.attention.overdue);
  });

  it('counts only what the person can see, and leaves Lending off out', async () => {
    await seedHome();
    const theirs = await homeOf(alfred);
    expect(theirs.attention).toMatchObject({
      overdue: 0,
      due: 0,
      expiring: 0,
      lentOut: 0,
      borrowedIn: 0,
    });
    await switchModule(home.id, 'lending', false);
    const mine = await homeOf(ibrahim);
    expect(mine.attention).toMatchObject({ lentOut: 0, borrowedIn: 0 });
    expect(mine.agendaBySource.overdue.loan).toBeUndefined();
    const { counts } = await agenda(ibrahim);
    expect(mine.attention.overdue).toBe(counts.overdue);
    void alfreds;
  });
});
