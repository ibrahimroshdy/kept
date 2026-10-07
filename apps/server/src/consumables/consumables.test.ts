import { beforeAll, describe, expect, it, vi } from 'vitest';
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
import { REMINDER_WORDS } from '../notify/words.js';
import { runScan } from '../reminders/scan.js';

// Step-7 T17 through the front door, as the web calls it (apps/web/src/api/portability/
// {types,paths}.ts, components/consumables/*): "keep at least N" on a consumable (D14), low below
// the minimum (Q19), the low-stock list, Adjust (D183), Home's attention row, the module gate
// (§7.6) and undo (D150).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDb;
let t: TestApp;

let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let alfred: Person; // his own account, nothing of Ibrahim's
let home: Loc; // complete: Consumables on
let garage: Loc; // essentials: Consumables off
let batteries: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');
  batteries = await builtinType(db, 'batteries');
});

const ruleUrl = (id: string) => `/api/v1/things/${id}/stock-rule`;
const put = (as: Person, id: string, minQuantity: number, version?: number) =>
  call(t, ruleUrl(id), {
    as,
    method: 'PUT',
    body: { minQuantity },
    ...(version !== undefined ? { headers: { 'if-match': String(version) } } : {}),
  });
const del = (as: Person, id: string, version: number) =>
  call(t, ruleUrl(id), { as, method: 'DELETE', headers: { 'if-match': String(version) } });
const adjust = (as: Person, id: string, body: object, version: number) =>
  call(t, `/api/v1/things/${id}/adjust`, {
    as,
    body,
    headers: { 'if-match': String(version) },
  });
const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });
const list = (as: Person, query = '') =>
  call(t, `/api/v1/consumables?locationId=${home.id}${query}`, { as });
const version = async (id: string) =>
  ok(await call(t, `/api/v1/things/${id}`, { as: ibrahim })).rowVersion as number;
const lowStock = async (as: Person) =>
  (ok(await call(t, '/api/v1/home', { as })).attention as Json).lowStock as number;
const quantityOf = async (id: string) =>
  (
    await own<{ q: string }>(
      db,
      'SELECT trim_scale(quantity)::text AS q FROM public.things WHERE id = $1',
      [id],
    )
  )[0]?.q;

const pack = (name: string, quantity: number, loc: Loc = home) =>
  createThing(t, ibrahim, loc, { name, typeId: batteries, quantity });

describe('PUT /api/v1/things/:id/stock-rule', () => {
  // catalogue: PUT /api/v1/things/:id/stock-rule
  it('keeps at least 4: 3 left is low, 4 is not; audited on the thing, undoable', async () => {
    const aa = await pack('AA batteries', 3);
    const rule = ok(await put(louis, aa.id, 4));
    expect(rule).toMatchObject({ thingId: aa.id, locationId: home.id, minQuantity: 4 });
    expect(rule.rowVersion).toBeTypeOf('number');
    expect(ok(await call(t, ruleUrl(aa.id), { as: talia }))).toEqual(rule);

    const [event] = (await eventsOf(db, home.id, aa.id)).filter(
      (e) => e.action === 'thing.stock_rule',
    );
    expect(event?.diff).toEqual({ min_quantity: { before: null, after: 4, class: 'plain' } });
    expect(event?.undoable_until).not.toBeNull();

    const low = ok(await list(talia, '&state=low')).items as Json[];
    expect(low.map((r) => [(r.thing as Json).id, r.minQuantity, r.low])).toContainEqual([
      aa.id,
      4,
      true,
    ]);
    const before = await lowStock(ibrahim);
    ok(await adjust(louis, aa.id, { delta: 1 }, await version(aa.id)));
    expect(await lowStock(ibrahim)).toBe(before - 1);
    expect(
      (ok(await list(talia, '&state=low')).items as Json[]).some(
        (r) => (r.thing as Json).id === aa.id,
      ),
    ).toBe(false);
    const all = ok(await list(talia, '&state=all')).items as Json[];
    expect(all.find((r) => (r.thing as Json).id === aa.id)).toMatchObject({ low: false });
  });

  it('changes a rule only with If-Match (428 without, 412 stale), and undo puts it back', async () => {
    const aaa = await pack('AAA batteries', 2);
    const first = ok(await put(louis, aaa.id, 2));
    expect((await put(louis, aaa.id, 6)).statusCode).toBe(428);
    expect((await put(louis, aaa.id, 6, (first.rowVersion as number) + 5)).statusCode).toBe(412);
    const res = await put(louis, aaa.id, 6, first.rowVersion as number);
    const changed = ok(res);
    expect(changed.minQuantity).toBe(6);
    const eventId = String(res.headers['x-kept-audit-event']);
    ok(await undo(louis, eventId));
    expect(ok(await call(t, ruleUrl(aaa.id), { as: louis })).minQuantity).toBe(2);
  });

  it("refuses a thing that isn't consumable (409 not_consumable) and a viewer (403)", async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    const res = await put(louis, drill.id, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_consumable' });
    const aa = await pack('Viewer AA', 3);
    expect((await put(talia, aa.id, 4)).statusCode).toBe(403);
    expect((await put(alfred, aa.id, 4)).statusCode).toBe(404);
  });
});

describe('GET /api/v1/things/:id/stock-rule', () => {
  it('is 404 when the thing keeps no minimum', async () => {
    const aa = await pack('No rule', 3);
    expect((await call(t, ruleUrl(aa.id), { as: louis })).statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/things/:id/stock-rule', () => {
  // catalogue: DELETE /api/v1/things/:id/stock-rule
  it("removes the minimum, audited and undoable; a viewer can't", async () => {
    const aa = await pack('Removed rule', 1);
    const rule = ok(await put(louis, aa.id, 3));
    expect((await del(talia, aa.id, rule.rowVersion as number)).statusCode).toBe(403);
    const res = await del(louis, aa.id, rule.rowVersion as number);
    expect(res.statusCode).toBe(204);
    expect((await call(t, ruleUrl(aa.id), { as: louis })).statusCode).toBe(404);
    const events = (await eventsOf(db, home.id, aa.id)).filter(
      (e) => e.action === 'thing.stock_rule',
    );
    expect(events.at(-1)?.diff).toEqual({
      min_quantity: { before: 3, after: null, class: 'plain' },
    });
    ok(await undo(louis, String(res.headers['x-kept-audit-event'])));
    expect(ok(await call(t, ruleUrl(aa.id), { as: louis })).minQuantity).toBe(3);
  });
});

describe('POST /api/v1/things/:id/adjust', () => {
  // catalogue: POST /api/v1/things/:id/adjust
  it('adjusts by a delta or to a quantity, down to 0 and never below; undone by the toast', async () => {
    const aa = await pack('Adjusted AA', 5);
    const res = await adjust(louis, aa.id, { delta: -2 }, await version(aa.id));
    const row = ok(res);
    expect(row).toMatchObject({ id: aa.id, quantity: 3 });
    const [event] = (await eventsOf(db, home.id, aa.id)).filter((e) => e.action === 'thing.update');
    expect(event?.diff.quantity).toMatchObject({ before: '5.000', after: '3.000' });

    ok(await adjust(louis, aa.id, { quantity: 0 }, await version(aa.id)));
    expect(await quantityOf(aa.id)).toBe('0');
    const below = await adjust(louis, aa.id, { delta: -1 }, await version(aa.id));
    expect(below.statusCode).toBe(400);
    expect((await adjust(louis, aa.id, { delta: 1 }, 1)).statusCode).toBe(412);

    // The first adjust's undo is refused (the quantity changed since); the last one's goes.
    const last = await adjust(louis, aa.id, { quantity: 7 }, await version(aa.id));
    ok(last);
    ok(await undo(louis, String(last.headers['x-kept-audit-event'])));
    expect(await quantityOf(aa.id)).toBe('0');
    expect((await undo(louis, String(res.headers['x-kept-audit-event']))).statusCode).toBe(409);
  });

  it('can be read by a viewer, but not adjusted', async () => {
    const aa = await pack('Talia AA', 2);
    expect((await adjust(talia, aa.id, { delta: 1 }, await version(aa.id))).statusCode).toBe(403);
  });
});

describe('the module gate (§7.6)', () => {
  it('Consumables off: reads are 404 module_off, writes 409', async () => {
    const aa = await pack('Garage AA', 1, garage);
    const read = await call(t, ruleUrl(aa.id), { as: louis });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'module_off' });
    const listed = await call(t, `/api/v1/consumables?locationId=${garage.id}`, { as: louis });
    expect(listed.statusCode).toBe(404);
    const write = await put(louis, aa.id, 2);
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ code: 'module_off' });
    expect((await adjust(louis, aa.id, { delta: 1 }, await version(aa.id))).statusCode).toBe(409);
  });

  it('counts a low thing on Home only where Consumables is on', async () => {
    const before = await lowStock(ibrahim);
    const aa = await pack('Garage low', 1, garage);
    await own(
      db,
      `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
       VALUES ($1, $2, 5, $3)`,
      [aa.id, garage.id, ibrahim.userId],
    );
    expect(await lowStock(ibrahim)).toBe(before);
    expect(await lowStock(alfred)).toBe(0);
  });
});

describe("low-stock reminders (the agenda's stock source, 0104)", () => {
  const rule = async (thingId: string) =>
    (
      await own<{ id: string; low_since: string | null; row_version: number }>(
        db,
        `SELECT id, low_since::text, row_version FROM public.stock_rules WHERE thing_id = $1`,
        [thingId],
      )
    )[0];
  const agenda = async (ruleId: string) =>
    own<{ state: string; due_period: string; module: string }>(
      db,
      `SELECT state, due_period, module FROM public.agenda_items
        WHERE source_type = 'stock' AND source_id = $1`,
      [ruleId],
    );
  const occurrences = async (ruleId: string) =>
    own<{ state: string; due_period: string }>(
      db,
      `SELECT state, due_period FROM public.reminder_occurrences
        WHERE source_type = 'stock' AND source_id = $1 ORDER BY created_at`,
      [ruleId],
    );
  const today = async () =>
    (
      await own<{ d: string }>(
        db,
        `SELECT (now() AT TIME ZONE l.timezone)::date::text AS d FROM public.locations l
          WHERE l.id = $1`,
        [home.id],
      )
    )[0]?.d;

  it('reminds once from the day a thing ran low, is done when restocked, and again next time', async () => {
    const aaa = await pack('AAA batteries', 6);
    ok(await put(ibrahim, aaa.id, 4));
    const r0 = await rule(aaa.id);
    expect(r0?.low_since).toBeNull();
    expect(await agenda(r0?.id as string)).toEqual([]);

    // Down to 3: low since today, in the agenda as due, and the rule's version doesn't move.
    ok(await adjust(louis, aaa.id, { quantity: 3 }, await version(aaa.id)));
    const r1 = await rule(aaa.id);
    expect(r1?.low_since).toBe(await today());
    expect(r1?.row_version).toBe(r0?.row_version);
    expect(await agenda(r1?.id as string)).toEqual([
      { state: 'due', due_period: `date:${await today()}`, module: 'consumables' },
    ]);
    // One reminder across two scans; down to 2 keeps the same day, so no second one.
    await runScan({ pools: db.pools, channels: {} });
    ok(await adjust(louis, aaa.id, { quantity: 2 }, await version(aaa.id)));
    await runScan({ pools: db.pools, channels: {} });
    expect(await occurrences(r1?.id as string)).toEqual([
      { state: 'open', due_period: `date:${await today()}` },
    ]);
    // Not in the agenda's list or Home's due count (low stock has its own), but in `upcoming`'s.
    const listed = ok(await call(t, `/api/v1/agenda?locationId=${home.id}`, { as: ibrahim }));
    expect(JSON.stringify(listed)).not.toContain(r1?.id as string);

    // Restocked: out of the agenda, low_since cleared, the reminder done.
    ok(await adjust(louis, aaa.id, { quantity: 10 }, await version(aaa.id)));
    expect((await rule(aaa.id))?.low_since).toBeNull();
    expect(await agenda(r1?.id as string)).toEqual([]);
    expect((await runScan({ pools: db.pools, channels: {} })).closed.done).toBeGreaterThanOrEqual(
      1,
    );
    expect((await occurrences(r1?.id as string)).map((o) => o.state)).toEqual(['done']);

    // A higher minimum makes it low again: low since today once more.
    ok(await put(ibrahim, aaa.id, 12, (await rule(aaa.id))?.row_version));
    expect((await rule(aaa.id))?.low_since).toBe(await today());
  });

  it('words a low-stock reminder in each language', () => {
    const facts = {
      sourceType: 'stock' as const,
      kind: 'due' as const,
      title: 'AAA batteries',
      subject: { type: 'thing' as const, name: 'AAA batteries', path: 'Kitchen' },
      locationName: 'Home',
      dueOn: '2026-10-07',
      dueValue: null,
      unit: null,
      link: '/t/x',
    };
    expect(REMINDER_WORDS.en.headline(facts)).toBe('AAA batteries ran low on October 7, 2026');
    expect(REMINDER_WORDS.en.label(facts)).toBe('Low stock');
    expect(REMINDER_WORDS.ar.label(facts)).toBe('مخزون منخفض');
  });

  it('pauses while Consumables is off', async () => {
    const aa = await pack('Garage AA', 1, garage);
    await own(
      db,
      `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
       VALUES ($1, $2, 5, $3)`,
      [aa.id, garage.id, ibrahim.userId],
    );
    const r = await rule(aa.id);
    expect(r?.low_since).not.toBeNull();
    expect(await agenda(r?.id as string)).toEqual([]);
  });
});

describe('GET /api/v1/consumables', () => {
  it('lists low first, then by name, a page at a time', async () => {
    const names = ['Zinc pack', 'Alkaline pack', 'Button cells'];
    for (const [i, name] of names.entries()) {
      const thing = await pack(name, i === 0 ? 1 : 10);
      ok(await put(louis, thing.id, 2));
    }
    const seen: Json[] = [];
    let cursor: string | null = null;
    do {
      const page = ok(
        await list(louis, `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      );
      seen.push(...(page.items as Json[]));
      cursor = page.next_cursor as string | null;
    } while (cursor);
    const lows = seen.map((r) => r.low as boolean);
    expect(lows).toEqual([...lows].sort((a, b) => Number(b) - Number(a)));
    const ids = seen.map((r) => (r.thing as Json).id);
    expect(new Set(ids).size).toBe(ids.length);
    const ours = seen.map((r) => (r.thing as Json).name as string).filter((n) => names.includes(n));
    expect(ours).toEqual(['Zinc pack', 'Alkaline pack', 'Button cells']);
  });
});
