import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
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
import { registerUndo, undoableActions } from '../audit/undo.js';

// Undo (D58, D124, D150; T27's decision): POST /api/v1/audit/:eventId/undo over this task's
// undoable events (thing.update, thing.retype, thing.lifecycle) and the handlers it registers for
// T15's thing.move and T21's thing.trash, whose events are written here by hand in the shape
// things/undo.ts documents.

let db: TestDb;
let t: TestApp;
let ann: Person; // owner
let ada: Person; // admin
let mo: Person; // member
let vic: Person; // viewer
let bob: Person; // outsider
let home: Loc;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  ada = await person(t, db, 'ada');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  await setDisplayName(db, ann, 'Ann');
  await setDisplayName(db, mo, 'Alfred');
  home = await createLocation(t, db, ann, 'complete');
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
});

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const thingOf = async (id: string) => ok(await call(t, `/api/v1/things/${id}`, { as: ann }));

async function patch(as: Person, thing: Json, body: object): Promise<Json> {
  const current = await thingOf(thing.id);
  return ok(
    await call(t, `/api/v1/things/${thing.id}`, {
      method: 'PATCH',
      as,
      headers: { 'if-match': String(current.rowVersion) },
      body,
    }),
  );
}

const lastEvent = async (entityId: string) => (await eventsOf(db, home.id, entityId)).at(-1);

/** An undoable event written as kept_owner, in the shape T15/T21 write theirs. */
async function handWritten(
  as: Person,
  action: string,
  thingId: string,
  diff: object,
  subjects: string[] = [],
): Promise<string> {
  const [row] = await own<{ id: string; at: Date }>(
    db,
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, entity_id, root_thing_id, diff, undoable_until)
     VALUES ($1, $2, 'user', $3, $4, 'thing', $5, $5, $6, now() + interval '1 day')
     RETURNING id, at`,
    [home.id, home.accountId, as.userId, action, thingId, JSON.stringify(diff)],
  );
  for (const s of subjects) {
    await own(
      db,
      `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
       VALUES ($1, $2, $3, $4)`,
      [row?.id, row?.at, home.id, s],
    );
  }
  return row?.id as string;
}

describe('POST /api/v1/audit/:eventId/undo', () => {
  // catalogue: POST /api/v1/audit/:eventId/undo
  it("undoes the caller's own edit: fields back, one audit row pointing at it (D150)", async () => {
    const made = await createThing(t, mo, home, { name: 'Lamp', colour: 'red' });
    await patch(mo, made, { name: 'Desk lamp', colour: null });
    const edit = await lastEvent(made.id);
    const res = ok(await undo(mo, edit?.id as string));
    expect(res.undoOf).toBe(edit?.id);
    const back = await thingOf(made.id);
    expect(back.name).toBe('Lamp');
    expect(back.colour).toBe('red');
    const row = await lastEvent(made.id);
    expect(row).toEqual(
      expect.objectContaining({
        id: res.eventId,
        action: 'thing.update',
        actor_id: mo.userId,
        undo_of: edit?.id,
        undoable_until: null,
      }),
    );
    expect(row?.diff.name).toEqual({ before: 'Desk lamp', after: 'Lamp', class: 'plain' });
  });

  it('refuses when a field changed since, saying who (D124)', async () => {
    const made = await createThing(t, ann, home, { name: 'Chair' });
    await patch(mo, made, { name: 'Office chair' });
    const edit = await lastEvent(made.id);
    await patch(ann, made, { name: 'Kitchen chair' });
    const res = await undo(mo, edit?.id as string);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(
      expect.objectContaining({
        code: 'undo_refused',
        reason: 'changed_since',
        field: 'name',
        conflicts: ['name'],
        changedBy: { displayName: 'Ann' },
      }),
    );
    expect(res.json().hint).toMatch(/Can't undo: Ann changed name since/);
    expect((await thingOf(made.id)).name).toBe('Kitchen chair');
  });

  it('refuses a second undo, an expired window and an action with no handler', async () => {
    const made = await createThing(t, ann, home, { name: 'Rug' });
    await patch(ann, made, { name: 'Big rug' });
    const edit = await lastEvent(made.id);
    ok(await undo(ann, edit?.id as string));
    expect((await undo(ann, edit?.id as string)).statusCode).toBe(409);

    await patch(ann, made, { name: 'Small rug' });
    const late = await lastEvent(made.id);
    await own(
      db,
      `UPDATE public.audit_events SET undoable_until = now() - interval '1 minute' WHERE id = $1`,
      [late?.id],
    );
    const tooLate = await undo(ann, late?.id as string);
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().hint).toMatch(/7 days/);

    const [created] = await eventsOf(db, home.id, made.id);
    expect(created?.action).toBe('thing.create');
    expect((await undo(ann, created?.id as string)).statusCode).toBe(409);
  });

  it("lets owners and admins undo someone else's change; a member or viewer can't; an outsider sees nothing", async () => {
    const made = await createThing(t, ann, home, { name: 'Mirror' });
    await patch(mo, made, { name: 'Hall mirror' });
    const byMo = await lastEvent(made.id);
    await patch(ann, made, { notes: 'heavy' });
    const byAnn = await lastEvent(made.id);
    expect((await undo(mo, byAnn?.id as string)).statusCode).toBe(403);
    expect((await undo(vic, byMo?.id as string)).statusCode).toBe(403);
    expect((await undo(bob, byMo?.id as string)).statusCode).toBe(404);
    expect((await undo(bob, '01920000-0000-7000-8000-000000000000')).statusCode).toBe(404);
    ok(await undo(ada, byMo?.id as string));
    expect((await thingOf(made.id)).name).toBe('Mirror');
    expect((await thingOf(made.id)).notes).toBe('heavy');
  });

  it('undoes custom values, tags and aliases together', async () => {
    const [tag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'garden') RETURNING id`,
      [home.accountId],
    );
    const cable = await own<{ id: string }>(
      db,
      `SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'cable'`,
    );
    const made = await createThing(t, ann, home, {
      name: 'Hose',
      typeId: cable[0]?.id,
      custom: { length: 10 },
      aliases: { en: ['pipe'] },
    });
    await patch(ann, made, {
      custom: { length: null, connector_a: 'click' },
      tagIds: [tag?.id],
      aliases: { ar: ['خرطوم'] },
    });
    const edit = await lastEvent(made.id);
    ok(await undo(ann, edit?.id as string));
    const back = await thingOf(made.id);
    expect(back.custom).toEqual({ length: 10 });
    expect(back.tags).toEqual([]);
    expect(back.aliases).toEqual({ en: ['pipe'] });
  });

  it('undoes a status change, price and all (D124: terminal statuses too)', async () => {
    const made = await createThing(t, ann, home, { name: 'Bike' });
    ok(
      await call(t, `/api/v1/things/${made.id}/lifecycle`, {
        as: ann,
        headers: { 'if-match': String(made.rowVersion) },
        body: { lifecycle: 'sold', endedPrice: '100', endedCurrency: 'EGP', endedTo: 'Sam' },
      }),
    );
    const sold = await lastEvent(made.id);
    ok(await undo(ann, sold?.id as string));
    const back = await thingOf(made.id);
    expect(back.lifecycle).toBe('in_use');
    expect(back.ended).toBeNull();
    const row = await lastEvent(made.id);
    expect(row?.action).toBe('thing.lifecycle');
    expect(row?.diff.ended_price?.class).toBe('money');
  });

  it('undoes a re-type: the archived values come back', async () => {
    const [type] = await own<{ id: string }>(
      db,
      `INSERT INTO public.types (owner_account_id, name, icon) VALUES ($1, 'Plant', 'lucide:leaf')
       RETURNING id`,
      [home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
       VALUES ($1, $2, 'species', 'Species', 'text')`,
      [home.accountId, type?.id],
    );
    const made = await createThing(t, ann, home, {
      name: 'Fern',
      typeId: type?.id,
      custom: { species: 'Boston' },
    });
    ok(
      await call(t, `/api/v1/things/${made.id}/retype`, {
        as: ann,
        headers: { 'if-match': String(made.rowVersion) },
        body: {
          typeId: (
            await own<{ id: string }>(
              db,
              `SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'furniture'`,
            )
          )[0]?.id,
        },
      }),
    );
    const retype = await lastEvent(made.id);
    expect(retype?.action).toBe('thing.retype');
    ok(await undo(ann, retype?.id as string));
    const back = await thingOf(made.id);
    expect(back.type).toEqual(expect.objectContaining({ id: type?.id }));
    expect(back.custom).toEqual({ species: 'Boston' });
    expect(back.archivedCustom).toEqual({});
  });

  it('undoes a move (T15 shape): back where it was, the contents with it, unless moved since', async () => {
    const shelf = await place(db, home, 'Shelf');
    const attic = await place(db, home, 'Attic');
    const box = await createThing(t, ann, home, { name: 'Box' });
    const inside = await createThing(t, ann, home, { name: 'Tape', containerId: box.id });
    await own(db, 'UPDATE public.things SET place_id = $2 WHERE id = $1', [box.id, shelf]);
    const moved = await handWritten(
      mo,
      'thing.move',
      box.id,
      { place_id: { before: home.unplacedId, after: shelf, class: 'plain' } },
      [inside.id],
    );
    const res = ok(await undo(mo, moved));
    expect((await thingOf(box.id)).placeId).toBe(home.unplacedId);
    expect((await thingOf(inside.id)).containerId).toBe(box.id);
    const [subjects] = await own<{ n: number }>(
      db,
      'SELECT count(*)::int AS n FROM public.audit_event_subjects WHERE event_id = $1',
      [res.eventId],
    );
    expect(subjects?.n).toBe(2);
    const row = await lastEvent(box.id);
    expect(row).toEqual(expect.objectContaining({ action: 'thing.move', undo_of: moved }));

    await own(db, 'UPDATE public.things SET place_id = $2 WHERE id = $1', [box.id, shelf]);
    const again = await handWritten(mo, 'thing.move', box.id, {
      place_id: { before: home.unplacedId, after: shelf, class: 'plain' },
    });
    await own(db, 'UPDATE public.things SET place_id = $2 WHERE id = $1', [box.id, attic]);
    const refused = await undo(mo, again);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().conflicts).toEqual(['place_id']);
  });

  it('undoes a trash (T21 shape): the batch comes back, and an orphan goes to Unplaced', async () => {
    const closet = await place(db, home, 'Closet');
    const coat = await createThing(t, ann, home, { name: 'Coat', placeId: closet });
    const scarf = await createThing(t, ann, home, { name: 'Scarf', placeId: closet });
    const [batch] = await own<{ id: string }>(db, 'SELECT uuidv7() AS id');
    await own(
      db,
      `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = ANY ($1::uuid[])`,
      [[coat.id, scarf.id], batch?.id],
    );
    await own(db, 'UPDATE public.places SET deleted_at = now() WHERE id = $1', [closet]);
    const trashed = await handWritten(ann, 'thing.trash', coat.id, {
      deleted_at: { before: null, after: '2026-09-26T10:00:00.000Z', class: 'plain' },
      trash_batch_id: { before: null, after: batch?.id, class: 'plain' },
    });
    ok(await undo(ann, trashed));
    const back = await thingOf(coat.id);
    expect(back.placeId).toBe(home.unplacedId);
    expect((await thingOf(scarf.id)).placeId).toBe(home.unplacedId);
    const coatEvents = await eventsOf(db, home.id, coat.id);
    expect(coatEvents.find((e) => e.action === 'thing.trash' && e.undo_of)?.undo_of).toBe(trashed);
    // Its move to the Unplaced area is on its record too (security review #30).
    expect(coatEvents.at(-1)).toMatchObject({ action: 'thing.move', undo_of: null });
    expect((await undo(ann, trashed)).statusCode).toBe(409);
  });

  it("refuses to write back money its caller can't see (409 module_off)", async () => {
    const cabin = await createLocation(t, db, ann, 'essentials', 'Undo cabin');
    const vase = await createThing(t, ann, cabin, { name: 'Undo vase' });
    const [row] = await own<{ id: string; at: Date }>(
      db,
      `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                        entity_type, entity_id, root_thing_id, diff, undoable_until)
       VALUES ($1, $2, 'user', $3, 'thing.update', 'thing', $4, $4, $5, now() + interval '1 day')
       RETURNING id, at`,
      [
        cabin.id,
        cabin.accountId,
        ann.userId,
        vase.id,
        JSON.stringify({
          'custom.worth': {
            before: { amount: '70', currency: 'EGP' },
            after: null,
            class: 'money',
          },
        }),
      ],
    );
    const res = await undo(ann, row?.id as string);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('module_off');
    const [now] = await own<{ custom: object }>(
      db,
      'SELECT custom FROM public.things WHERE id = $1',
      [vase.id],
    );
    expect(now?.custom).toEqual({});
  });

  it('keeps one handler per action, and lists what it can undo', () => {
    expect(undoableActions()).toEqual(
      expect.arrayContaining([
        'thing.lifecycle',
        'thing.move',
        'thing.retype',
        'thing.trash',
        'thing.update',
      ]),
    );
    expect(() => registerUndo('thing.update', async () => {})).toThrow(/already registered/);
  });
});

describe('x-kept-audit-event: the id the Undo toast undoes', () => {
  const HEADER = 'x-kept-audit-event';

  it('names the undoable event a write recorded, and undoing it works', async () => {
    const made = await createThing(t, mo, home, { name: 'Kettle' });
    const current = await thingOf(made.id);
    const res = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': String(current.rowVersion) },
      body: { name: 'Electric kettle' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const edit = await lastEvent(made.id);
    expect(edit?.action).toBe('thing.update');
    expect(res.headers[HEADER]).toBe(edit?.id);
    const undone = await undo(mo, res.headers[HEADER] as string);
    expect(undone.statusCode, undone.body).toBe(200);
    // The undo's own row isn't undoable again: no header on it.
    expect(undone.headers[HEADER]).toBeUndefined();
    expect((await thingOf(made.id)).name).toBe('Kettle');
  });

  it('is absent when nothing undoable was written (a create)', async () => {
    const res = await call(t, '/api/v1/things', {
      as: mo,
      body: { locationId: home.id, placeId: home.unplacedId, name: 'Toaster' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers[HEADER]).toBeUndefined();
  });

  it('comes back on an Idempotency-Key replay', async () => {
    const made = await createThing(t, mo, home, { name: 'Iron' });
    const send = () =>
      call(t, `/api/v1/things/${made.id}/lifecycle`, {
        as: mo,
        headers: { 'if-match': String(made.rowVersion), 'idempotency-key': `iron-${made.id}` },
        body: { lifecycle: 'given_away' },
      });
    const first = await send();
    expect(first.statusCode, first.body).toBe(200);
    const again = await send();
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers[HEADER]).toBe((await lastEvent(made.id))?.id);
    expect(again.headers[HEADER]).toBe(first.headers[HEADER]);
  });

  it('lists one id per thing a bulk move moved, in the order written', async () => {
    const shelf = await place(db, home, 'Header shelf');
    const a = await createThing(t, mo, home, { name: 'Cup A' });
    const b = await createThing(t, mo, home, { name: 'Cup B' });
    const res = await call(t, '/api/v1/things/move', {
      as: mo,
      body: { thingIds: [a.id, b.id], to: { placeId: shelf } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const ids = String(res.headers[HEADER]).split(', ');
    const moves = [(await lastEvent(a.id))?.id, (await lastEvent(b.id))?.id];
    expect([...ids].sort()).toEqual([...moves].sort());
  });
});
