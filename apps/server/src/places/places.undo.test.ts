import { newId } from '@kept/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import {
  createLocation,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { undoableActions } from '../audit/undo.js';

// Undo of place edits and moves (D58, D124, D150; T27's decision): the `place.update` and
// `place.move` events PATCH /api/v1/places/:id writes, reversed through
// POST /api/v1/audit/:eventId/undo (places/undo.ts).

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ola: Person; // owner
let max: Person; // member
let mo: Person; // member
let vic: Person; // viewer
let home: Loc;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ola = await person(t, db, 'ola');
  max = await person(t, db, 'max');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  await setDisplayName(db, mo, 'Alfred');
  home = await createLocation(t, db, ola, 'complete');
  await join(db, home.id, max.userId, 'member');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
});

beforeEach(() => {
  sent.splice(0);
});

const view = async (as: Person, id: string) => ok(await call(t, `/api/v1/places/${id}`, { as }));

async function patch(as: Person, id: string, body: object): Promise<Json> {
  const current = await view(ola, id);
  return ok(
    await call(t, `/api/v1/places/${id}`, {
      method: 'PATCH',
      as,
      headers: { 'if-match': String(current.rowVersion) },
      body,
    }),
  );
}

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

/** The place's audit events, oldest first. */
const auditOfPlace = (id: string) => eventsOf(db, home.id, id);

describe('undo of place.update and place.move (D150)', () => {
  it('registers both actions', () => {
    expect(undoableActions()).toEqual(expect.arrayContaining(['place.update', 'place.move']));
  });

  it('undoes an edit: every changed field back, one audit row pointing at it', async () => {
    const p = await place(db, home, 'Attic');
    await patch(max, p, { name: 'Loft', icon: 'lucide:house', sort: 3 });
    const [edit] = (await auditOfPlace(p)).slice(-1);
    expect(edit?.action).toBe('place.update');
    expect(edit?.undoable_until).not.toBeNull();

    const res = ok(await undo(max, edit?.id as string));
    expect(res.undoOf).toBe(edit?.id);
    expect(await view(max, p)).toMatchObject({ name: 'Attic', icon: null });
    const [row] = await own<{ sort: number }>(db, 'SELECT sort FROM public.places WHERE id = $1', [
      p,
    ]);
    expect(row?.sort).toBe(0);
    const [audit] = (await auditOfPlace(p)).slice(-1);
    expect(audit).toMatchObject({
      id: res.eventId,
      action: 'place.update',
      actor_id: max.userId,
      undo_of: edit?.id,
      undoable_until: null,
    });
    expect(audit?.diff).toMatchObject({
      name: { before: 'Loft', after: 'Attic' },
      icon: { before: 'lucide:house', after: null },
      sort: { before: 3, after: 0 },
    });
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });

    const again = await undo(max, edit?.id as string);
    expect(again.statusCode).toBe(409);
  });

  it('undoes a re-parent (place.move): back under the old parent', async () => {
    const wingA = await place(db, home, 'Wing A');
    const wingB = await place(db, home, 'Wing B');
    const den = await place(db, home, 'Den', wingA);
    await patch(max, den, { parentId: wingB });
    const [move] = (await auditOfPlace(den)).slice(-1);
    expect(move?.action).toBe('place.move');

    const res = ok(await undo(max, move?.id as string));
    expect((await view(max, den)).parentId).toBe(wingA);
    const [audit] = (await auditOfPlace(den)).slice(-1);
    expect(audit).toMatchObject({ id: res.eventId, action: 'place.move', undo_of: move?.id });
    expect(audit?.diff).toMatchObject({ parent_id: { before: wingB, after: wingA } });
  });

  it('undoes a move to the top level back under its parent', async () => {
    const block = await place(db, home, 'Block');
    const flat = await place(db, home, 'Flat', block);
    await patch(max, flat, { parentId: null });
    const [move] = (await auditOfPlace(flat)).slice(-1);
    ok(await undo(max, move?.id as string));
    expect((await view(max, flat)).parentId).toBe(block);
  });

  it('refuses when a field changed since, saying who (D124)', async () => {
    const p = await place(db, home, 'Porch');
    await patch(max, p, { name: 'Stoop' });
    const [edit] = (await auditOfPlace(p)).slice(-1);
    await patch(mo, p, { name: 'Veranda' });
    const res = await undo(max, edit?.id as string);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'undo_refused',
      reason: 'changed_since',
      field: 'name',
      conflicts: ['name'],
      changedBy: { displayName: 'Alfred' },
    });
    expect((await view(max, p)).name).toBe('Veranda');
  });

  it('refuses when the old parent is in the trash, or the place itself is', async () => {
    const shed = await place(db, home, 'Shed');
    const barn = await place(db, home, 'Barn');
    const rack = await place(db, home, 'Rack', shed);
    await patch(max, rack, { parentId: barn });
    const [move] = (await auditOfPlace(rack)).slice(-1);
    ok(await call(t, `/api/v1/places/${shed}/trash`, { as: max, body: {} }));
    const res = await undo(max, move?.id as string);
    expect(res.statusCode).toBe(409);
    expect(res.json().hint).toMatch(/trash/);
    expect((await view(max, rack)).parentId).toBe(barn);

    const hut = await place(db, home, 'Hut');
    await patch(max, hut, { name: 'Cabin' });
    const [edit] = (await auditOfPlace(hut)).slice(-1);
    ok(await call(t, `/api/v1/places/${hut}/trash`, { as: max, body: {} }));
    const gone = await undo(max, edit?.id as string);
    expect(gone.statusCode).toBe(409);
    expect(gone.json().hint).toMatch(/trash/);
  });

  it('refuses a loop the tree has grown since (409)', async () => {
    const a = await place(db, home, 'Loop A');
    const b = await place(db, home, 'Loop B');
    // A was under B and moved to the top; then B moved under A. Undoing A's move would put A
    // under its own child.
    await patch(max, a, { parentId: b });
    await patch(max, a, { parentId: null });
    const [aMove] = (await auditOfPlace(a)).slice(-1);
    await patch(max, b, { parentId: a });
    const res = await undo(max, aMove?.id as string);
    expect(res.statusCode).toBe(409);
    expect((await view(max, a)).parentId).toBeNull();
  });

  it('puts custom fields back per key, keeping the money class', async () => {
    const kind = newId();
    await own(
      db,
      `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
       VALUES ($1, $2, 'vault_room', 'Vault room', 'lucide:warehouse')`,
      [kind, home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind, secret, sort)
       VALUES ($1, $2, 'paint', 'Paint', 'text', false, 1),
              ($1, $2, 'worth', 'Worth', 'money', false, 2)`,
      [home.accountId, kind],
    );
    const p = newId();
    await own(
      db,
      `INSERT INTO public.places (id, location_id, name, kind_key, custom)
       VALUES ($1, $2, 'Strongroom', 'vault_room', '{"paint":"white"}')`,
      [p, home.id],
    );
    await patch(ola, p, { custom: { paint: 'Sage', worth: { amount: '1200', currency: 'EGP' } } });
    const [edit] = (await auditOfPlace(p)).slice(-1);
    expect(edit?.diff['custom.worth']).toMatchObject({ class: 'money' });

    ok(await undo(ola, edit?.id as string));
    expect((await view(ola, p)).custom).toEqual({ paint: 'white' });
    const [audit] = (await auditOfPlace(p)).slice(-1);
    expect(audit?.diff).toMatchObject({
      'custom.paint': { before: 'Sage', after: 'white', class: 'plain' },
      'custom.worth': { before: { amount: '1200', currency: 'EGP' }, after: null, class: 'money' },
    });
  });

  it('refuses to put back a place kind that is archived or gone since (409)', async () => {
    const kindId = newId();
    await own(
      db,
      `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
       VALUES ($1, $2, 'larder_kind', 'Larder', 'lucide:box')`,
      [kindId, home.accountId],
    );
    const p = newId();
    await own(
      db,
      `INSERT INTO public.places (id, location_id, name, kind_key)
       VALUES ($1, $2, 'Larder', 'larder_kind')`,
      [p, home.id],
    );
    await patch(max, p, { kindKey: 'room' });
    const [edit] = (await auditOfPlace(p)).slice(-1);
    await own(db, 'UPDATE public.place_kinds SET archived_at = now() WHERE id = $1', [kindId]);
    const archived = await undo(max, edit?.id as string);
    expect(archived.statusCode, archived.body).toBe(409);
    expect(archived.json().hint).toMatch(/kind/);
    expect((await view(max, p)).kindKey).toBe('room');

    await own(db, 'DELETE FROM public.place_kinds WHERE id = $1', [kindId]);
    const gone = await undo(max, edit?.id as string);
    expect(gone.statusCode, gone.body).toBe(409);
    expect((await view(max, p)).kindKey).toBe('room');
  });

  it("is 403 for a viewer and for a member undoing someone else's change", async () => {
    const p = await place(db, home, 'Cellar');
    await patch(ola, p, { name: 'Wine cellar' });
    const [edit] = (await auditOfPlace(p)).slice(-1);
    expect((await undo(vic, edit?.id as string)).statusCode).toBe(403);
    expect((await undo(max, edit?.id as string)).statusCode).toBe(403);
    expect((await view(ola, p)).name).toBe('Wine cellar');
  });
});
