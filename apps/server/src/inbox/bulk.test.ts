import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  type Draft,
  draft,
  type InboxPageJson,
  inbox,
  inboxItem,
  itemRow,
} from '../../test/inbox.js';
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
  setDisplayName,
} from '../../test/things.js';
import { AUDIT_EVENT_HEADER } from '../http/write.js';

// T15: the inbox's bulk bar (D36, D150): one request, one undoable event, one undo.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let alfred: Person; // admin of Home
let home: Loc;

type BulkJson = {
  results: { id: string; ok: boolean; error?: string }[];
  undo?: { eventId: string; until: string };
};

const bulk = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/inbox/bulk', { as, body });

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, body: {} });

const bulkEvents = (locationId: string) =>
  own<{ id: string; undoable_until: Date | null; diff: Record<string, { after?: unknown }> }>(
    db,
    `SELECT id, undoable_until, diff FROM public.audit_events
      WHERE location_id = $1 AND action = 'inbox.bulk' AND undo_of IS NULL ORDER BY at, id`,
    [locationId],
  );

const thingsOf = (ids: readonly string[]) =>
  own<{
    id: string;
    review_state: string;
    type_id: string | null;
    place_id: string | null;
    deleted_at: Date | null;
    tag_ids: string[] | null;
  }>(
    db,
    `SELECT t.id, t.review_state, t.type_id, t.place_id, t.deleted_at,
            (SELECT array_agg(g.tag_id::text) FROM public.thing_tags g WHERE g.thing_id = t.id)
              AS tag_ids
       FROM public.things t WHERE t.id = ANY ($1::uuid[])`,
    [ids],
  );

async function drafts(n: number, loc: Loc = home, as: Person = ibrahim): Promise<Draft[]> {
  const batchId = newId();
  const out: Draft[] = [];
  for (let i = 0; i < n; i++) out.push(await draft(t, db, as, loc, { name: `Jar ${i}`, batchId }));
  return out;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, alfred, 'Alfred');
  home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, alfred.userId, 'admin');
});

afterAll(async () => {
  await t.app.close();
});

describe('POST /api/v1/inbox/bulk', () => {
  // catalogue: POST /api/v1/inbox/bulk
  it('accepts 50 names in one undoable event, and one undo puts all 50 back', async () => {
    const list = await drafts(50);
    const res = await bulk(ibrahim, { ids: list.map((d) => d.itemId), action: 'accept_names' });
    const body = ok(res) as unknown as BulkJson;
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(body.results).toHaveLength(50);
    // One undoable event, named in the header and in `undo`; the per-thing edits are not.
    const events = await bulkEvents(home.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.undoable_until).not.toBeNull();
    expect(events[0]?.diff.bulk_action?.after).toBe('accept_names');
    expect(body.undo?.eventId).toBe(events[0]?.id);
    expect(res.headers[AUDIT_EVENT_HEADER]).toBe(events[0]?.id);
    const perThing = await own<{ n: number; undoable: number }>(
      db,
      `SELECT count(*)::int AS n, count(undoable_until)::int AS undoable FROM public.audit_events
        WHERE action = 'thing.update' AND entity_id = ANY ($1::uuid[])`,
      [list.map((d) => d.thingId)],
    );
    expect(perThing[0]).toEqual({ n: 50, undoable: 0 });
    expect(
      (await thingsOf(list.map((d) => d.thingId))).every((x) => x.review_state === 'confirmed'),
    ).toBe(true);
    expect((await itemRow(db, list[0]?.itemId as string))?.resolution).toBe('accepted');

    ok(await undo(ibrahim, body.undo?.eventId as string));
    expect(
      (await thingsOf(list.map((d) => d.thingId))).every((x) => x.review_state === 'draft'),
    ).toBe(true);
    const open = ok(
      await inbox(t, ibrahim, `locationId=${home.id}&limit=200`),
    ) as unknown as InboxPageJson;
    const ids = new Set(open.items.map((i) => i.id));
    expect(list.every((d) => ids.has(d.itemId))).toBe(true);
    // No redo.
    expect((await undo(ibrahim, body.undo?.eventId as string)).statusCode).toBe(409);
  });

  it('sets the type, tags and place of a selection, each undone as one', async () => {
    const list = await drafts(3);
    const ids = list.map((d) => d.itemId);
    const things = list.map((d) => d.thingId);
    const tool = await builtinType(db, 'tool');
    const tag = (
      await own<{ id: string }>(
        db,
        `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'Kitchen') RETURNING id`,
        [home.accountId],
      )
    )[0]?.id as string;
    const shelf = await place(db, home, 'Spice rack');

    const typed = ok(
      await bulk(louis, { ids, action: 'set_type', typeId: tool }),
    ) as unknown as BulkJson;
    const tagged = ok(
      await bulk(louis, { ids, action: 'set_tags', tagIds: [tag] }),
    ) as unknown as BulkJson;
    const placed = ok(
      await bulk(louis, { ids, action: 'set_place', to: { placeId: shelf } }),
    ) as unknown as BulkJson;
    let now = await thingsOf(things);
    expect(now.every((x) => x.type_id === tool && x.place_id === shelf)).toBe(true);
    expect(now.every((x) => x.tag_ids?.[0] === tag)).toBe(true);
    // The items stay open: only the answers resolve them.
    expect((await itemRow(db, list[0]?.itemId as string))?.resolution).toBeNull();
    const moves = await own<{ n: number; undoable: number }>(
      db,
      `SELECT count(*)::int AS n, count(undoable_until)::int AS undoable FROM public.audit_events
        WHERE action = 'thing.move' AND entity_id = ANY ($1::uuid[])`,
      [things],
    );
    expect(moves[0]).toEqual({ n: 3, undoable: 0 });

    ok(await undo(louis, placed.undo?.eventId as string));
    ok(await undo(louis, tagged.undo?.eventId as string));
    ok(await undo(louis, typed.undo?.eventId as string));
    now = await thingsOf(things);
    expect(now.every((x) => x.type_id === null && x.place_id === home.unplacedId)).toBe(true);
    expect(now.every((x) => x.tag_ids === null)).toBe(true);
  });

  it('discards drafts together, and the undo brings them and their items back', async () => {
    const list = await drafts(4, home, louis);
    const res = ok(
      await bulk(louis, { ids: list.map((d) => d.itemId), action: 'discard' }),
    ) as unknown as BulkJson;
    const trashed = await thingsOf(list.map((d) => d.thingId));
    expect(trashed.every((x) => x.deleted_at !== null)).toBe(true);
    const batches = await own<{ n: number }>(
      db,
      'SELECT count(DISTINCT trash_batch_id)::int AS n FROM public.things WHERE id = ANY ($1::uuid[])',
      [list.map((d) => d.thingId)],
    );
    expect(batches[0]?.n).toBe(1);
    const hidden = ok(await inbox(t, louis, `locationId=${home.id}`)) as unknown as InboxPageJson;
    expect(hidden.items.some((i) => i.id === list[0]?.itemId)).toBe(false);

    ok(await undo(louis, res.undo?.eventId as string));
    expect((await thingsOf(list.map((d) => d.thingId))).every((x) => x.deleted_at === null)).toBe(
      true,
    );
    const back = ok(await inbox(t, louis, `locationId=${home.id}`)) as unknown as InboxPageJson;
    expect(list.every((d) => back.items.some((i) => i.id === d.itemId))).toBe(true);
  });

  it('reports each item it could not do, and does the rest', async () => {
    const [good] = await drafts(1);
    const nameless = await draft(t, db, ibrahim, home, { name: null });
    const box = await createThing(t, ibrahim, home, { name: 'Shoe box' });
    const claim = await inboxItem(db, home, ibrahim, {
      kind: 'label_claim',
      thingId: box.id,
      code: 'H4J5K6',
      payload: { claimedFor: { kind: 'thing', id: box.id, name: 'Shoe box' } },
    });
    const missing = newId();
    const res = ok(
      await bulk(ibrahim, {
        ids: [good?.itemId, nameless.itemId, claim, missing],
        action: 'accept_names',
      }),
    ) as unknown as BulkJson;
    expect(res.results).toEqual([
      { id: good?.itemId, ok: true },
      { id: nameless.itemId, ok: false, error: 'validation' },
      { id: claim, ok: false, error: 'conflict' },
      { id: missing, ok: false, error: 'not_found' },
    ]);
    expect((await thingsOf([good?.thingId as string]))[0]?.review_state).toBe('confirmed');
    expect((await thingsOf([nameless.thingId]))[0]?.review_state).toBe('draft');
    // Nothing done: no event, no undo.
    const none = ok(
      await bulk(ibrahim, { ids: [missing], action: 'discard' }),
    ) as unknown as BulkJson;
    expect(none.undo).toBeUndefined();
    // A body that can't be done at all.
    expect((await bulk(ibrahim, { ids: [missing], action: 'set_type' })).statusCode).toBe(400);
    expect(
      (await bulk(ibrahim, { ids: Array.from({ length: 201 }, () => newId()), action: 'discard' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses the undo when a thing changed since, naming who changed it', async () => {
    const list = await drafts(2);
    const tool = await builtinType(db, 'tool');
    const res = ok(
      await bulk(ibrahim, { ids: list.map((d) => d.itemId), action: 'set_type', typeId: tool }),
    ) as unknown as BulkJson;
    const [row] = await own<{ row_version: number }>(
      db,
      'SELECT row_version FROM public.things WHERE id = $1',
      [list[0]?.thingId],
    );
    ok(
      await call(t, `/api/v1/things/${list[0]?.thingId}`, {
        as: alfred,
        method: 'PATCH',
        body: { typeId: null },
        headers: { 'if-match': String(row?.row_version) },
      }),
    );
    const refused = await undo(ibrahim, res.undo?.eventId as string);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ changedBy: { displayName: 'Alfred' } });
    // Someone else's bulk is theirs to undo, or an admin's.
    const mine = ok(
      await bulk(ibrahim, { ids: [list[1]?.itemId], action: 'set_tags', tagIds: [] }),
    ) as unknown as Json & BulkJson;
    expect((await undo(louis, mine.undo?.eventId as string)).statusCode).toBe(403);
    ok(await undo(alfred, mine.undo?.eventId as string));
  });

  it('writes one bulk event per location a selection spans', async () => {
    const other = await createLocation(t, db, ibrahim, 'household', 'Cabin');
    const [a] = await drafts(1);
    const [b] = await drafts(1, other);
    const res = await bulk(ibrahim, { ids: [a?.itemId, b?.itemId], action: 'accept_names' });
    const body = ok(res) as unknown as BulkJson;
    const ids = String(res.headers[AUDIT_EVENT_HEADER]).split(', ');
    expect(ids).toHaveLength(2);
    expect(body.undo?.eventId).toBe(ids[0]);
    expect((await bulkEvents(other.id)).map((e) => e.id)).toContain(ids[1]);
  });
});
