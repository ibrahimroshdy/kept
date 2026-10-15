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

// The spreadsheet view (1.x, D250) through the front door, as the web calls it
// (apps/web/src/api/inventory/{types,paths}.ts SheetRow, BulkEditBody, mock/sheet.ts): every
// request as a signed-in user on kept_app, so row-level security and can() decide.

let db: TestDb;
let t: TestApp;
let ann: Person; // owner of home
let mo: Person; // member of home
let vic: Person; // viewer of home
let bob: Person; // outsider
let home: Loc;
let garage: Loc; // ann's too

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  await setDisplayName(db, ann, 'Ann');
  await setDisplayName(db, mo, 'Alfred');
  home = await createLocation(t, db, ann, 'complete', 'Home');
  garage = await createLocation(t, db, ann, 'complete', 'Garage');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
});

type Row = Json & {
  rowVersion: number;
  name: string;
  brand: { id: string; name: string } | null;
  model: string | null;
  tags: { id: string; name: string }[];
  placeId: string | null;
  containerId: string | null;
  quantityFixed: boolean;
  purchase: Record<string, unknown> | null;
  warranty?: { endsOn: string | null; lifetime: boolean } | null;
};

const sheet = async (
  as: Person,
  query: string,
): Promise<{ items: Row[]; next_cursor: string | null }> =>
  ok(await call(t, `/api/v1/things/sheet?${query}`, { as })) as unknown as {
    items: Row[];
    next_cursor: string | null;
  };
const bulkEdit = (as: Person, edits: object[]) =>
  call(t, '/api/v1/things/bulk-edit', { as, body: { edits } });
const bulkTrash = (as: Person, body: object) => call(t, '/api/v1/things/bulk-trash', { as, body });
const undoTogether = (as: Person, eventIds: string[]) =>
  call(t, '/api/v1/audit/undo', { as, body: { eventIds } });

async function brand(name: string): Promise<string> {
  const [r] = await own<{ id: string }>(
    db,
    'INSERT INTO public.brands (owner_account_id, name) VALUES ($1, $2) RETURNING id',
    [home.accountId, name],
  );
  return r?.id as string;
}

async function tag(name: string): Promise<string> {
  const [r] = await own<{ id: string }>(
    db,
    'INSERT INTO public.tags (owner_account_id, name) VALUES ($1, $2) RETURNING id',
    [home.accountId, name],
  );
  return r?.id as string;
}

async function versionOf(id: string): Promise<number> {
  const [r] = await own<{ row_version: number }>(
    db,
    'SELECT row_version FROM public.things WHERE id = $1',
    [id],
  );
  return r?.row_version as number;
}

describe('GET /api/v1/things/sheet', () => {
  it('answers the wide rows, gates money per role and pages by any sheet sort', async () => {
    const loc = await createLocation(t, db, ann, 'complete', 'Sheet read');
    await join(db, loc.id, vic.userId, 'viewer');
    const [bosch] = await own<{ id: string }>(
      db,
      'INSERT INTO public.brands (owner_account_id, name) VALUES ($1, $2) RETURNING id',
      [loc.accountId, 'Bosch'],
    );
    const drill = await createThing(t, ann, loc, {
      name: 'Drill',
      brandId: bosch?.id,
      model: 'PSB 18',
      serial: 'SN-1',
      purchase: { purchasedOn: '2026-09-01', currency: 'EGP', price: '1250.50' },
    });
    await own(
      db,
      `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, ends_on, created_by)
       VALUES ($1, $2, 'manufacturer', '2026-09-01', '2028-08-31', $3)`,
      [loc.id, drill.id, ann.userId],
    );
    for (const name of ['Axe', 'Clamp', 'Bucket']) await createThing(t, ann, loc, { name });

    const first = await sheet(ann, `locationId=${loc.id}&limit=2`);
    expect(first.items.map((r) => r.name)).toEqual(['Axe', 'Bucket']);
    const second = await sheet(ann, `locationId=${loc.id}&limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((r) => r.name)).toEqual(['Clamp', 'Drill']);
    expect(second.next_cursor).toBeNull();

    const row = second.items[1] as Row;
    expect(row).toMatchObject({
      id: drill.id,
      brand: { id: bosch?.id, name: 'Bosch' },
      model: 'PSB 18',
      serial: 'SN-1',
      quantityFixed: false,
      purchase: { purchasedOn: '2026-09-01', price: '1250.5', currency: 'EGP' },
      warranty: { endsOn: '2028-08-31', lifetime: false },
    });
    expect(row.rowVersion).toBeGreaterThan(0);

    // A viewer, with money hidden from viewers: the date, never the amount (D13).
    const seen = (await sheet(vic, `locationId=${loc.id}&q=Drill`)).items[0] as Row;
    expect(seen.purchase).toEqual({ purchasedOn: '2026-09-01', moneyHidden: true });

    // Sorting by brand, then by name the other way round, across pages.
    const byBrand = await sheet(ann, `locationId=${loc.id}&sort=brand&dir=desc&limit=1`);
    expect(byBrand.items.map((r) => r.name)).toEqual(['Drill']);
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const pg = await sheet(
        ann,
        `locationId=${loc.id}&sort=name&dir=desc&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      all.push(...pg.items.map((r) => r.name));
      cursor = pg.next_cursor;
    } while (cursor);
    expect(all).toEqual(['Drill', 'Clamp', 'Bucket', 'Axe']);

    // An outsider naming the location: 404, as for the list.
    expect(
      (await call(t, `/api/v1/things/sheet?locationId=${loc.id}`, { as: bob })).statusCode,
    ).toBe(404);
  });

  it('says when the quantity is fixed at 1 (a serialized type)', async () => {
    const laptop = await createThing(t, ann, home, {
      name: 'Laptop',
      typeId: await builtinType(db, 'electronics'),
    });
    const row = (await sheet(ann, `locationId=${home.id}&q=Laptop`)).items.find(
      (r) => r.id === laptop.id,
    );
    expect(row?.quantityFixed).toBe(true);
  });
});

describe('POST /api/v1/things/bulk-edit', () => {
  // catalogue: POST /api/v1/things/bulk-edit
  it('saves each row with its own audit event, reports a stale row and leaves it unsaved', async () => {
    const makita = await brand('Makita');
    const red = await tag('Red');
    const a = await createThing(t, mo, home, { name: 'Saw' });
    const b = await createThing(t, mo, home, { name: 'Sander' });
    const c = await createThing(t, mo, home, { name: 'Router' });
    const stale = (await versionOf(c.id)) as number;
    // Someone else changes c after the sheet read it.
    ok(
      await call(t, `/api/v1/things/${c.id}`, {
        as: ann,
        method: 'PATCH',
        headers: { 'if-match': String(stale) },
        body: { model: 'RT0700' },
      }),
    );

    const res = await bulkEdit(mo, [
      { id: a.id, rowVersion: await versionOf(a.id), set: { brandId: makita, model: 'HS7601' } },
      { id: b.id, rowVersion: await versionOf(b.id), set: { tagIds: [red], quantity: 2 } },
      { id: c.id, rowVersion: stale, set: { model: 'Mine' } },
    ]);
    const body = ok(res) as unknown as {
      results: { id: string; ok: boolean; status?: number; code?: string; conflicts?: string[] }[];
      rows: Row[];
      events: string[];
    };
    expect(body.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
      expect.objectContaining({
        id: c.id,
        ok: false,
        status: 412,
        code: 'precondition_failed',
        conflicts: ['model'],
        rowVersion: stale + 1,
        changedBy: { displayName: 'Ann' },
      }),
    ]);
    expect(body.rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(body.rows[0]).toMatchObject({ brand: { name: 'Makita' }, model: 'HS7601' });
    expect(body.rows[1]).toMatchObject({ quantity: 2, tags: [{ id: red, name: 'Red' }] });

    // One undoable thing.update per saved row, named in the answer and the header.
    const ea = (await eventsOf(db, home.id, a.id)).at(-1);
    const eb = (await eventsOf(db, home.id, b.id)).at(-1);
    expect(ea).toMatchObject({ action: 'thing.update', actor_id: mo.userId });
    expect(ea?.diff.model).toMatchObject({ before: null, after: 'HS7601' });
    expect(eb?.action).toBe('thing.update');
    expect(ea?.undoable_until).not.toBeNull();
    expect(body.events).toEqual([ea?.id, eb?.id]);
    expect(res.headers['x-kept-audit-event']).toBe(`${ea?.id}, ${eb?.id}`);
    // The stale row kept what Ann wrote.
    const [cRow] = await own<{ model: string }>(
      db,
      'SELECT model FROM public.things WHERE id = $1',
      [c.id],
    );
    expect(cRow?.model).toBe('RT0700');
    expect(
      (await eventsOf(db, home.id, c.id)).filter(
        (e) => e.actor_id === mo.userId && e.action === 'thing.update',
      ),
    ).toEqual([]);
  });

  it('moves a row to a place in its own location; another location is not found', async () => {
    const shed = await place(db, home, 'Shed');
    const away = await place(db, garage, 'Bay');
    const box = await createThing(t, ann, home, {
      name: 'Tool box',
      typeId: await builtinType(db, 'box_bin'),
    });
    const x = await createThing(t, mo, home, { name: 'Hammer' });
    const y = await createThing(t, mo, home, { name: 'Pliers' });
    const z = await createThing(t, mo, home, { name: 'Level' });
    const body = ok(
      await bulkEdit(mo, [
        {
          id: x.id,
          rowVersion: await versionOf(x.id),
          set: { to: { placeId: shed }, name: 'Big hammer' },
        },
        { id: y.id, rowVersion: await versionOf(y.id), set: { to: { containerId: box.id } } },
        { id: z.id, rowVersion: await versionOf(z.id), set: { to: { placeId: away } } },
      ]),
    ) as unknown as { results: { ok: boolean; status?: number }[]; rows: Row[]; events: string[] };
    expect(body.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(body.results[2]?.status).toBe(404);
    expect(body.rows[0]).toMatchObject({ name: 'Big hammer', placeId: shed, containerId: null });
    expect(body.rows[1]).toMatchObject({ placeId: null, containerId: box.id });
    const xEvents = await eventsOf(db, home.id, x.id);
    expect(xEvents.slice(-2).map((e) => e.action)).toEqual(['thing.update', 'thing.move']);
    // Both of x's events are in the answer, so one Undo takes back the rename and the move.
    expect(body.events).toHaveLength(3);
    expect(body.events.slice(0, 2)).toEqual(xEvents.slice(-2).map((e) => e.id));
  });

  it('refuses a viewer and an outsider row by row, and checks the request', async () => {
    const x = await createThing(t, ann, home, { name: 'Vase' });
    const v = await versionOf(x.id);
    const asViewer = ok(
      await bulkEdit(vic, [{ id: x.id, rowVersion: v, set: { name: 'Mine' } }]),
    ) as unknown as { results: { status: number }[]; rows: Row[]; events: string[] };
    expect(asViewer.results[0]?.status).toBe(403);
    expect(asViewer.rows).toEqual([]);
    expect(asViewer.events).toEqual([]);
    const asOutsider = ok(
      await bulkEdit(bob, [{ id: x.id, rowVersion: v, set: { name: 'Mine' } }]),
    ) as unknown as { results: { status: number }[] };
    expect(asOutsider.results[0]?.status).toBe(404);
    expect(await versionOf(x.id)).toBe(v);

    // A price isn't a sheet edit (it lives on the purchase), nor is any unknown key.
    expect(
      (await bulkEdit(ann, [{ id: x.id, rowVersion: v, set: { price: '10' } }])).statusCode,
    ).toBe(400);
    // At most 200 rows, each once.
    const many = Array.from({ length: 201 }, () => ({
      id: x.id,
      rowVersion: v,
      set: { name: 'A' },
    }));
    expect((await bulkEdit(ann, many)).statusCode).toBe(400);
    expect(
      (
        await bulkEdit(ann, [
          { id: x.id, rowVersion: v, set: { name: 'A' } },
          { id: x.id, rowVersion: v, set: { name: 'B' } },
        ])
      ).statusCode,
    ).toBe(400);
    // The thing form's checks: a blank name, and a quantity for a serialized thing (D10).
    const laptop = await createThing(t, ann, home, {
      name: 'Old laptop',
      typeId: await builtinType(db, 'electronics'),
    });
    const bad = ok(
      await bulkEdit(ann, [
        { id: laptop.id, rowVersion: await versionOf(laptop.id), set: { quantity: 3 } },
      ]),
    ) as unknown as { results: { status: number; code: string }[] };
    expect(bad.results[0]).toMatchObject({ status: 400, code: 'validation' });
    expect(
      (await bulkEdit(ann, [{ id: x.id, rowVersion: v, set: { name: '  ' } }])).statusCode,
    ).toBe(400);
  });
});

describe('POST /api/v1/audit/undo (together)', () => {
  // catalogue: POST /api/v1/audit/undo
  it("undoes a save's events newest first, all or none", async () => {
    const a = await createThing(t, mo, home, { name: 'Kettle' });
    const b = await createThing(t, mo, home, { name: 'Toaster' });
    const shelf = await place(db, home, 'Shelf');
    const saved = ok(
      await bulkEdit(mo, [
        {
          id: a.id,
          rowVersion: await versionOf(a.id),
          set: { model: 'K1', to: { placeId: shelf } },
        },
        { id: b.id, rowVersion: await versionOf(b.id), set: { model: 'T1' } },
      ]),
    ) as unknown as { events: string[] };
    expect(saved.events).toHaveLength(3);

    // b changed since: the whole undo is refused and nothing is undone.
    ok(
      await call(t, `/api/v1/things/${b.id}`, {
        as: ann,
        method: 'PATCH',
        headers: { 'if-match': String(await versionOf(b.id)) },
        body: { model: 'T2' },
      }),
    );
    const refused = await undoTogether(mo, saved.events);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'undo_refused', reason: 'changed_since' });
    const [still] = await own<{ model: string; place_id: string }>(
      db,
      'SELECT model, place_id FROM public.things WHERE id = $1',
      [a.id],
    );
    expect(still).toEqual({ model: 'K1', place_id: shelf });

    // Without b's, a's rename and move go back together, each with its own undo row.
    const undone = ok(await undoTogether(mo, saved.events.slice(0, 2))) as unknown as {
      undone: { undoOf: string; eventId: string }[];
    };
    expect(undone.undone.map((u) => u.undoOf)).toEqual([...saved.events.slice(0, 2)].reverse());
    const [back] = await own<{ model: string | null; place_id: string }>(
      db,
      'SELECT model, place_id FROM public.things WHERE id = $1',
      [a.id],
    );
    expect(back).toEqual({ model: null, place_id: home.unplacedId });
    const rows = await own<{ undo_of: string }>(
      db,
      'SELECT undo_of FROM public.audit_events WHERE undo_of = ANY ($1::uuid[])',
      [saved.events.slice(0, 2)],
    );
    expect(rows).toHaveLength(2);
    // An outsider can't see the events: 404.
    expect((await undoTogether(bob, [saved.events[2] as string])).statusCode).toBe(404);
  });
});

describe('POST /api/v1/things/bulk-trash', () => {
  // catalogue: POST /api/v1/things/bulk-trash
  it('sends a selection to the Trash, each its own undoable event, all or none', async () => {
    const crate = await createThing(t, ann, home, {
      name: 'Crate',
      typeId: await builtinType(db, 'box_bin'),
    });
    const inside = await createThing(t, ann, home, { name: 'Cable', containerId: crate.id });
    const lamp = await createThing(t, mo, home, { name: 'Lamp' });

    // A box that holds something needs a choice: nothing is trashed, and the box is named.
    const refused = await bulkTrash(mo, { thingIds: [lamp.id, crate.id] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'contents_choice_required', thingId: crate.id });
    const [lampNow] = await own<{ deleted_at: Date | null }>(
      db,
      'SELECT deleted_at FROM public.things WHERE id = $1',
      [lamp.id],
    );
    expect(lampNow?.deleted_at).toBeNull();

    // A viewer can't.
    expect((await bulkTrash(vic, { thingIds: [lamp.id] })).statusCode).toBe(403);

    const res = await bulkTrash(mo, { thingIds: [lamp.id, crate.id], contents: 'move' });
    const body = ok(res) as unknown as { trashed: string[]; moved: string[]; events: string[] };
    expect(body.trashed.sort()).toEqual([lamp.id, crate.id].sort());
    expect(body.moved).toEqual([inside.id]);
    const trashEvents = [
      (await eventsOf(db, home.id, lamp.id)).at(-1),
      (await eventsOf(db, home.id, crate.id)).at(-1),
    ];
    expect(trashEvents.map((e) => e?.action)).toEqual(['thing.trash', 'thing.trash']);
    expect(body.events).toEqual(trashEvents.map((e) => e?.id));

    // One Undo brings both back.
    ok(await undoTogether(mo, body.events));
    const back = await own<{ deleted_at: Date | null }>(
      db,
      'SELECT deleted_at FROM public.things WHERE id = ANY ($1::uuid[])',
      [[lamp.id, crate.id]],
    );
    expect(back.map((r) => r.deleted_at)).toEqual([null, null]);
  });
});
