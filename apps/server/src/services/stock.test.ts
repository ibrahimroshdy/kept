import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
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
import { decimal, milli, stockUse } from './stock.js';

// D236 (builds D170) through the front door: a service line uses stock from a consumable. The
// shelf count moves by the difference between a record's lines before and after every write
// (log, confirm a draft, edit, delete, and the undo of each); not enough left is 409; the change
// is on the consumable's history, linked to the service.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owner of Home, Garage and Shed
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let home: Loc; // complete: Consumables on
let garage: Loc; // complete, Ibrahim's too
let shed: Loc; // essentials: Consumables off
let filters: string;
let boxType: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  home = await createLocation(t, db, ibrahim, 'complete');
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  shed = await createLocation(t, db, ibrahim, 'essentials', 'Shed');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  filters = await builtinType(db, 'filters');
  boxType = await builtinType(db, 'box_bin');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

const quantityOf = async (id: string) =>
  (
    await own<{ q: string }>(
      db,
      'SELECT trim_scale(quantity)::text AS q FROM public.things WHERE id = $1',
      [id],
    )
  )[0]?.q;

const shelf = (name: string, quantity: number, loc: Loc = home) =>
  createThing(t, ibrahim, loc, { name, typeId: filters, quantity });

const log = (as: Person, subject: string, lines: object[]) =>
  call(t, '/api/v1/service-records', {
    as,
    body: { id: newId(), subject: { thingId: subject }, servicedOn: '2026-10-01', lines },
  });

const patch = (as: Person, id: string, body: object, version: number) =>
  call(t, `/api/v1/service-records/${id}`, {
    as,
    method: 'PATCH',
    body,
    headers: { 'if-match': String(version) },
  });

const del = (as: Person, id: string, version: number) =>
  call(t, `/api/v1/service-records/${id}`, {
    as,
    method: 'DELETE',
    headers: { 'if-match': String(version) },
  });

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const filterLine = (thingId: string, quantity?: string) => ({
  kind: 'part',
  description: 'Oil filter',
  ...(quantity ? { quantity } : {}),
  consumableThingId: thingId,
});

const stockEvents = async (loc: Loc, thingId: string) =>
  (await eventsOf(db, loc.id, thingId)).filter((e) => e.action === 'thing.stock_use');

describe('the arithmetic', () => {
  it('counts in thousandths: a line without a quantity uses 1', () => {
    expect(milli('2')).toBe(2000n);
    expect(milli('0.5')).toBe(500n);
    expect(decimal(4500n)).toBe('4.5');
    expect(decimal(-250n)).toBe('-0.25');
    const use = stockUse([
      { consumable_thing_id: 'a', quantity: '2' },
      { consumable_thing_id: 'A', quantity: null },
      { consumable_thing_id: null, quantity: '9' },
      { quantity: '9' },
    ]);
    expect([...use]).toEqual([['a', 3000n]]);
  });
});

describe('a service line from stock (D236)', () => {
  // POST, PATCH and DELETE /api/v1/service-records are catalogued in schedules.test.ts; these
  // assert their stock rows.
  it('logging a service takes the line off the shelf; the consumable shows what it was for', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Oil filter', 5);
    const res = await log(louis, mower.id, [filterLine(filter.id, '2')]);
    const record = ok(res, 201);
    expect(await quantityOf(filter.id)).toBe('3');
    expect((record.lines as Json[])[0]).toMatchObject({
      description: 'Oil filter',
      quantity: '2',
      consumable: { id: filter.id, name: 'Oil filter' },
    });

    const [event] = await stockEvents(home, filter.id);
    expect(event?.actor_id).toBe(louis.userId);
    expect(event?.diff).toEqual({
      quantity: { before: '5', after: '3', class: 'plain' },
      service_record_id: { before: null, after: record.id, class: 'plain' },
      service_thing_id: { before: null, after: mower.id, class: 'plain' },
    });
    // Not undoable on its own: the service's own events are.
    expect(event?.undoable_until).toBeNull();

    const history = ok(await call(t, `/api/v1/things/${filter.id}/history`, { as: talia }));
    const [top] = history.items as Json[];
    expect(top).toMatchObject({
      action: 'thing.stock_use',
      summaryKey: 'thing.stock_use',
      summaryParams: { name: 'Oil filter', service: 'Mower', serviceThingId: mower.id },
      summary: 'Used Oil filter in a service of Mower',
    });
    // The mower's history is the service's, not the shelf's.
    const mowers = ok(await call(t, `/api/v1/things/${mower.id}/history`, { as: talia }));
    expect((mowers.items as Json[]).some((e) => e.action === 'thing.stock_use')).toBe(false);
  });

  it('a line without a quantity uses one; a place can be serviced from stock too', async () => {
    const filter = await shelf('Cooker hood filter', 2);
    const [kitchen] = await own<{ id: string }>(
      db,
      `INSERT INTO public.places (location_id, name) VALUES ($1, 'Kitchen') RETURNING id`,
      [home.id],
    );
    const record = ok(
      await call(t, '/api/v1/service-records', {
        as: louis,
        body: {
          subject: { placeId: kitchen?.id },
          servicedOn: '2026-10-01',
          lines: [filterLine(filter.id)],
        },
      }),
      201,
    );
    expect(await quantityOf(filter.id)).toBe('1');
    const [event] = await stockEvents(home, filter.id);
    expect(event?.diff.service_place_id).toMatchObject({ after: kitchen?.id });
    expect(event?.diff.service_record_id).toMatchObject({ after: record.id });
  });

  it('a line can take another amount than its quantity (consumedQuantity), only with a consumable', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const oil = await shelf('Engine oil', 20);
    const record = ok(
      await log(louis, mower.id, [
        {
          kind: 'fluid',
          description: 'Oil change',
          quantity: '1',
          consumableThingId: oil.id,
          consumedQuantity: '4.5',
        },
      ]),
      201,
    );
    expect(await quantityOf(oil.id)).toBe('15.5');
    expect((record.lines as Json[])[0]).toMatchObject({
      quantity: '1',
      consumedQuantity: '4.5',
      consumable: { id: oil.id },
    });
    // Deleting gives back what it took, not the quantity.
    expect((await del(louis, record.id as string, record.rowVersion as number)).statusCode).toBe(
      204,
    );
    expect(await quantityOf(oil.id)).toBe('20');
    const alone = await log(louis, mower.id, [
      { kind: 'fluid', description: 'Oil', quantity: '1', consumedQuantity: '2' },
    ]);
    expect(alone.statusCode).toBe(400);
  });

  it('an edit moves it by the difference; removing the line puts it back; undo takes it again', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Air filter', 6);
    const record = ok(await log(louis, mower.id, [filterLine(filter.id, '2')]), 201);
    expect(await quantityOf(filter.id)).toBe('4');

    const more = ok(
      await patch(louis, record.id as string, { lines: [filterLine(filter.id, '3')] }, 1),
    );
    expect(await quantityOf(filter.id)).toBe('3');

    // Two lines from the same shelf count together.
    const two = ok(
      await patch(
        louis,
        record.id as string,
        { lines: [filterLine(filter.id, '3'), filterLine(filter.id, '0.5')] },
        more.rowVersion as number,
      ),
    );
    expect(await quantityOf(filter.id)).toBe('2.5');

    const res = await patch(louis, record.id as string, { lines: [] }, two.rowVersion as number);
    ok(res);
    expect(await quantityOf(filter.id)).toBe('6');
    const back = (await stockEvents(home, filter.id)).at(-1);
    expect(back?.diff.quantity).toEqual({ before: '2.5', after: '6', class: 'plain' });
    const history = ok(await call(t, `/api/v1/things/${filter.id}/history`, { as: louis }));
    expect((history.items as Json[])[0]).toMatchObject({
      summaryKey: 'thing.stock_return',
      summary: 'Put Air filter back from a service of Mower',
    });

    // Undoing the edit that removed the line takes the stock again.
    ok(await undo(louis, String(res.headers['x-kept-audit-event'])));
    expect(await quantityOf(filter.id)).toBe('2.5');
    // An edit that leaves the lines alone moves nothing.
    const now = ok(await call(t, `/api/v1/service-records/${record.id}`, { as: louis }));
    const before = (await stockEvents(home, filter.id)).length;
    ok(await patch(louis, record.id as string, { notes: 'Done' }, now.rowVersion as number));
    expect(await stockEvents(home, filter.id)).toHaveLength(before);
  });

  it('deleting the service puts it back; undoing the delete takes it again', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Fuel filter', 3);
    const record = ok(await log(louis, mower.id, [filterLine(filter.id, '1')]), 201);
    expect(await quantityOf(filter.id)).toBe('2');
    const res = await del(louis, record.id as string, record.rowVersion as number);
    expect(res.statusCode).toBe(204);
    expect(await quantityOf(filter.id)).toBe('3');
    ok(await undo(louis, String(res.headers['x-kept-audit-event'])));
    expect(await quantityOf(filter.id)).toBe('2');
    const back = ok(await call(t, `/api/v1/service-records/${record.id}`, { as: louis }));
    expect((back.lines as Json[])[0]).toMatchObject({ consumable: { id: filter.id } });
  });

  it('undoing a completion with stock lines gives the stock back', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Spark plug', 4);
    const schedule = ok(
      await call(t, '/api/v1/schedules', {
        as: ibrahim,
        body: { subject: { thingId: mower.id }, name: 'Tune-up', everyMonths: 12 },
      }),
      201,
    );
    const res = await call(t, '/api/v1/service-records', {
      as: louis,
      body: {
        subject: { thingId: mower.id },
        servicedOn: '2026-10-01',
        lines: [{ ...filterLine(filter.id, '2'), description: 'Spark plug' }],
        completes: [schedule.id],
      },
    });
    ok(res, 201);
    expect(await quantityOf(filter.id)).toBe('2');
    ok(await undo(louis, String(res.headers['x-kept-audit-event'])));
    expect(await quantityOf(filter.id)).toBe('4');
  });

  it('refuses taking more than is left: 409 not_enough_stock naming the thing; nothing written', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Blade', 1);
    const res = await log(louis, mower.id, [filterLine(filter.id, '2')]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'not_enough_stock',
      thing: { id: filter.id, name: 'Blade' },
      left: '1',
    });
    expect(await quantityOf(filter.id)).toBe('1');
    const list = ok(await call(t, `/api/v1/things/${mower.id}/service-records`, { as: louis }));
    expect(list.items).toEqual([]);

    // Exactly what is left is fine (D183: a consumable may reach 0).
    const record = ok(await log(louis, mower.id, [filterLine(filter.id, '1')]), 201);
    expect(await quantityOf(filter.id)).toBe('0');
    // An edit asking for more is refused the same way, and leaves the record as it was.
    const more = await patch(
      louis,
      record.id as string,
      { lines: [filterLine(filter.id, '2')] },
      1,
    );
    expect(more.statusCode).toBe(409);
    expect(more.json()).toMatchObject({ code: 'not_enough_stock', left: '0' });
    expect(await quantityOf(filter.id)).toBe('0');

    // An undone delete that would take what is no longer there is refused too.
    const gone = await del(louis, record.id as string, record.rowVersion as number);
    expect(await quantityOf(filter.id)).toBe('1');
    const version = ok(await call(t, `/api/v1/things/${filter.id}`, { as: ibrahim }))
      .rowVersion as number;
    ok(
      await call(t, `/api/v1/things/${filter.id}/adjust`, {
        as: ibrahim,
        body: { quantity: 0 },
        headers: { 'if-match': String(version) },
      }),
    );
    const refused = await undo(louis, String(gone.headers['x-kept-audit-event']));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'not_enough_stock' });
    expect(await quantityOf(filter.id)).toBe('0');
  });

  it("refuses another location's thing, a thing that isn't consumable, one in the trash, and Consumables off", async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const theirs = await shelf('Garage filter', 5, garage);
    const elsewhere = await log(ibrahim, mower.id, [filterLine(theirs.id, '1')]);
    expect(elsewhere.statusCode).toBe(404);
    expect(await quantityOf(theirs.id)).toBe('5');

    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    const notConsumable = await log(ibrahim, mower.id, [filterLine(drill.id, '1')]);
    expect(notConsumable.statusCode).toBe(409);
    expect(notConsumable.json()).toMatchObject({ code: 'not_consumable' });

    const trashed = await shelf('Old filter', 5);
    ok(await call(t, `/api/v1/things/${trashed.id}/trash`, { as: ibrahim, body: {} }));
    expect((await log(ibrahim, mower.id, [filterLine(trashed.id, '1')])).statusCode).toBe(404);
    expect(await quantityOf(trashed.id)).toBe('5');

    const saw = await createThing(t, ibrahim, shed, { name: 'Saw' });
    const shedFilter = await shelf('Shed filter', 5, shed);
    const off = await log(ibrahim, saw.id, [filterLine(shedFilter.id, '1')]);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'module_off' });
    expect(await quantityOf(shedFilter.id)).toBe('5');
  });

  it('refuses a viewer (403) and moves nothing', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Viewer filter', 5);
    expect((await log(talia, mower.id, [filterLine(filter.id, '1')])).statusCode).toBe(403);
    expect(await quantityOf(filter.id)).toBe('5');
  });

  it('gives back to a consumable in the trash, but takes nothing from it', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Trashed later', 5);
    const record = ok(await log(louis, mower.id, [filterLine(filter.id, '2')]), 201);
    ok(await call(t, `/api/v1/things/${filter.id}/trash`, { as: ibrahim, body: {} }));
    // An edit that keeps the link and the quantity is fine; one that takes more is refused.
    const notes = ok(await patch(louis, record.id as string, { notes: 'x' }, 1));
    const more = await patch(
      louis,
      record.id as string,
      { lines: [filterLine(filter.id, '3')] },
      notes.rowVersion as number,
    );
    expect(more.statusCode).toBe(409);
    expect(await quantityOf(filter.id)).toBe('3');
    expect((await del(louis, record.id as string, notes.rowVersion as number)).statusCode).toBe(
      204,
    );
    expect(await quantityOf(filter.id)).toBe('5');
  });

  it('a draft takes nothing until it is confirmed; undoing the confirm gives it back', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Draft filter', 4);
    const page = await upload(t, ibrahim, home.id, await uniqueJpeg(), { cls: 'evidence' });
    expect(page.statusCode, page.body).toBe(201);
    const made = ok(
      await call(t, '/api/v1/service-records/drafts', {
        as: ibrahim,
        body: {
          id: newId(),
          subject: { thingId: mower.id },
          invoiceFileIds: [(page.json() as { id: string }).id],
        },
        headers: { 'idempotency-key': newId() },
      }),
      201,
    );
    const draft = made.serviceRecord as Json;
    expect(await quantityOf(filter.id)).toBe('4');
    const res = await call(t, `/api/v1/service-records/${draft.id}/confirm`, {
      as: ibrahim,
      body: { servicedOn: '2026-10-01', lines: [filterLine(filter.id, '3')] },
      headers: { 'if-match': String(draft.rowVersion) },
    });
    ok(res);
    expect(await quantityOf(filter.id)).toBe('1');
    ok(await undo(ibrahim, String(res.headers['x-kept-audit-event'])));
    expect(await quantityOf(filter.id)).toBe('4');
    const back = ok(await call(t, `/api/v1/service-records/${draft.id}`, { as: ibrahim }));
    expect(back).toMatchObject({ reviewState: 'draft', lines: [] });
  });

  it('a move that separates the line from its consumable drops the link; one that keeps them together keeps it', async () => {
    // The mower moves to the garage; its filter stays on Home's shelf.
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Staying filter', 5);
    const record = ok(await log(ibrahim, mower.id, [filterLine(filter.id, '1')]), 201);
    ok(
      await call(t, '/api/v1/things/move', {
        as: ibrahim,
        body: { thingIds: [mower.id], to: { placeId: garage.unplacedId } },
      }),
    );
    const moved = ok(await call(t, `/api/v1/service-records/${record.id}`, { as: ibrahim }));
    expect((moved.lines as Json[])[0]).toMatchObject({ description: 'Oil filter' });
    expect((moved.lines as Json[])[0]?.consumable).toBeUndefined();
    expect(await quantityOf(filter.id)).toBe('4');
    // Deleting it now gives nothing back: the line no longer names the filter.
    expect((await del(ibrahim, record.id as string, moved.rowVersion as number)).statusCode).toBe(
      204,
    );
    expect(await quantityOf(filter.id)).toBe('4');

    // The filter leaves, the trailer stays: the line stays with its record, unlinked.
    const trailer = await createThing(t, ibrahim, home, { name: 'Trailer' });
    const leaving = await shelf('Leaving filter', 5);
    const second = ok(await log(ibrahim, trailer.id, [filterLine(leaving.id, '1')]), 201);
    ok(
      await call(t, '/api/v1/things/move', {
        as: ibrahim,
        body: { thingIds: [leaving.id], to: { placeId: garage.unplacedId } },
      }),
    );
    const left = ok(await call(t, `/api/v1/service-records/${second.id}`, { as: ibrahim }));
    expect((left.lines as Json[])[0]?.consumable).toBeUndefined();
    const [line] = await own<{ location_id: string; consumable_thing_id: string | null }>(
      db,
      'SELECT location_id, consumable_thing_id FROM public.service_lines WHERE service_record_id = $1',
      [second.id],
    );
    expect(line).toEqual({ location_id: home.id, consumable_thing_id: null });

    // A van carrying its own spare filter moves with it: the link is kept.
    const van = await createThing(t, ibrahim, home, { name: 'Van', typeId: boxType });
    const spare = await createThing(t, ibrahim, home, {
      name: 'Spare filter',
      typeId: filters,
      quantity: 3,
      containerId: van.id,
    });
    const third = ok(await log(ibrahim, van.id, [filterLine(spare.id, '1')]), 201);
    ok(
      await call(t, '/api/v1/things/move', {
        as: ibrahim,
        body: { thingIds: [van.id], to: { placeId: garage.unplacedId } },
      }),
    );
    const together = ok(await call(t, `/api/v1/service-records/${third.id}`, { as: ibrahim }));
    expect((together.lines as Json[])[0]).toMatchObject({ consumable: { id: spare.id } });
    expect(await quantityOf(spare.id)).toBe('2');
  });

  it('lists the consumables a line can use (GET /api/v1/things?consumable=1)', async () => {
    const filter = await shelf('Listed filter', 2);
    const mower = await createThing(t, ibrahim, home, { name: 'Listed mower' });
    const page = ok(
      await call(t, `/api/v1/things?locationId=${home.id}&consumable=1&limit=200`, { as: louis }),
    );
    const ids = (page.items as Json[]).map((r) => r.id);
    expect(ids).toContain(filter.id);
    expect(ids).not.toContain(mower.id);
  });

  it('purging the consumable keeps the line, unlinked', async () => {
    const mower = await createThing(t, ibrahim, home, { name: 'Mower' });
    const filter = await shelf('Purged filter', 5);
    const record = ok(await log(ibrahim, mower.id, [filterLine(filter.id, '1')]), 201);
    await own(db, 'DELETE FROM public.things WHERE id = $1', [filter.id]);
    const after = ok(await call(t, `/api/v1/service-records/${record.id}`, { as: ibrahim }));
    expect(after.lines as Json[]).toHaveLength(1);
    expect((after.lines as Json[])[0]?.consumable).toBeUndefined();
  });
});
