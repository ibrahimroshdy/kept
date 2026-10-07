import { newId, type SnapshotPage, type SnapThing } from '@kept/shared';
import pg from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { insertLocation, ownerTx } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import { type CursorState, FIRST_SYNC, signCursor, syncCursorKey } from './cursor.js';
import { snapshotPage } from './snapshot.js';

// Plan T12 through the front door: GET /api/v1/sync/snapshot as the web's sync engine calls it
// (apps/web/src/offline/snapshot.ts): the first sync with no cursor, then each page's
// nextCursor until `complete`, then deltas from the last one. Fixtures are written as
// kept_owner; every read is the signed-in person's, on kept_app under row-level security.
//
// The watermark is the whole server's oldest running transaction (pg_snapshot_xmin), so under a
// parallel test run a delta may repeat rows it has already given: duplicates are harmless, and
// the cases through the route only assert what must be there, or what can't be (uncommitted,
// or never visible). Where a case needs "this must not be sent", it builds the cursor state
// itself with a watermark taken after the fixtures (`markNow`) and calls snapshotPage() in the
// person's scope, the function the route runs.

let db: TestDb;
let t: TestApp;

let ibrahim: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;
let family: Loc;

type Loc = { id: string; unplacedId: string };

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function accountOf(p: Person): Promise<string> {
  const [row] = await own<{ id: string }>(
    'SELECT id FROM public.owner_accounts WHERE user_id = $1',
    [p.userId],
  );
  return row?.id as string;
}

async function location(p: Person, name: string): Promise<Loc> {
  const accountId = await accountOf(p);
  const loc = await ownerTx(db, (c) =>
    insertLocation(c, { userId: p.userId, accountId }, { name }),
  );
  return { id: loc.locationId, unplacedId: loc.unplacedId };
}

async function place(loc: Loc, name: string): Promise<string> {
  const id = newId();
  await own('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
    id,
    loc.id,
    name,
  ]);
  return id;
}

async function thing(
  loc: Loc,
  name: string,
  where: { placeId?: string; containerId?: string } = {},
): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, container_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      loc.id,
      where.containerId ? null : (where.placeId ?? loc.unplacedId),
      where.containerId ?? null,
      name,
    ],
  );
  return id;
}

/** One page through the route. */
async function page(
  as: Person,
  q: { cursor?: string; limit?: number; typesHash?: string } = {},
): Promise<SnapshotPage> {
  const params = new URLSearchParams();
  if (q.cursor) params.set('cursor', q.cursor);
  if (q.limit) params.set('limit', String(q.limit));
  if (q.typesHash) params.set('typesHash', q.typesHash);
  const res = await call(t, `/api/v1/sync/snapshot?${params}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SnapshotPage;
}

type Pulled = {
  pages: SnapshotPage[];
  things: Map<string, SnapThing>;
  cursor: string;
};

/** Pages until one is complete, as the phone does (at most 50). */
async function pull(as: Person, cursor?: string, limit?: number): Promise<Pulled> {
  const pages: SnapshotPage[] = [];
  const things = new Map<string, SnapThing>();
  let next = cursor;
  for (let i = 0; i < 50; i++) {
    const p = await page(as, { ...(next ? { cursor: next } : {}), ...(limit ? { limit } : {}) });
    pages.push(p);
    for (const th of p.changes.things) things.set(th.id, th);
    next = p.nextCursor;
    if (p.complete) return { pages, things, cursor: next };
  }
  throw new Error('the snapshot never completed');
}

type Changes = SnapshotPage['changes'];
const allOf = <K extends keyof Changes>(pages: Pick<SnapshotPage, 'changes'>[], key: K) =>
  ([] as unknown[]).concat(...pages.map((p) => p.changes[key])) as Changes[K];
const removedOf = (pages: SnapshotPage[]) => pages.flatMap((p) => p.removed);

/** An xid8 no transaction before this call has: a delta from it holds only what comes after. */
async function markNow(): Promise<string> {
  const [row] = await own<{ x: string }>('SELECT pg_current_xact_id()::text AS x');
  return (BigInt(row?.x as string) + 1n).toString();
}

/** snapshotPage() in the person's scope, from a state the test builds. */
function direct(as: Person, state: CursorState, limit = 1000, thingCap?: number) {
  return withScope(db.pools.app, { userId: as.userId, mfa: true }, (_tx, c) =>
    snapshotPage(c, state, { limit, ...(thingCap ? { thingCap } : {}) }),
  );
}

/** Pages snapshotPage() until complete, from `state`. */
async function directPull(as: Person, state: CursorState, limit = 1000, thingCap?: number) {
  const pages: Omit<SnapshotPage, 'nextCursor'>[] = [];
  let s = state;
  for (let i = 0; i < 50; i++) {
    const r = await direct(as, s, limit, thingCap);
    pages.push(r.page);
    s = r.next;
    if (r.page.complete) return { pages, next: s };
  }
  throw new Error('the snapshot never completed');
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

let kitchen: string;
let drill: string;
let ladder: string;
let box: string;
let screws: string;

beforeEach(async () => {
  // Fresh people each case: what one person sees stays independent of the other cases.
  [ibrahim, louis, talia, alfred] = (await Promise.all(
    ['ibrahim', 'louis', 'talia', 'alfred'].map((label) => person(t, db, label)),
  )) as [Person, Person, Person, Person];
  home = await location(ibrahim, 'Home');
  garage = await location(ibrahim, 'Garage');
  family = await location(alfred, 'بيت العائلة');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  kitchen = await place(home, 'Kitchen');
  drill = await thing(home, 'Drill', { placeId: kitchen });
  ladder = await thing(home, 'Ladder');
  box = await thing(home, 'Parts box', { placeId: kitchen });
  screws = await thing(home, 'Screws', { containerId: box });
  await thing(family, 'مثقاب');
});

const open: pg.Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.end().catch(() => {});
});

describe('the first sync', () => {
  it('is the full snapshot, in pages, with the locations, types and codes', async () => {
    for (let i = 0; i < 12; i++) await thing(home, `Cable ${i}`, { placeId: kitchen });
    await own(
      `INSERT INTO public.meters (location_id, thing_id, kind, unit, label)
       VALUES ($1, $2, 'distance', 'km', 'Odometer')`,
      [home.id, ladder],
    );
    const trashed = await thing(home, 'Old kettle');
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [trashed]);
    await own(
      `INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ('DR1234', $1, $2)`,
      [home.id, drill],
    );
    await own(
      `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
       VALUES ($1, 'homebox', 'HB-7', $2)`,
      [home.id, ladder],
    );

    const { pages, things } = await pull(louis, undefined, 5);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.slice(0, -1).every((p) => !p.complete)).toBe(true);
    for (const p of pages.slice(0, -1)) {
      const n =
        p.changes.places.length +
        p.changes.things.length +
        p.changes.codes.length +
        p.changes.legacyCodes.length +
        p.removed.length;
      expect(n).toBeLessThanOrEqual(5);
    }

    // Every live thing of Louis's locations, once; the trash left out of a first pass.
    const homeThings = [...things.values()].filter((x) => x.locationId === home.id);
    expect(homeThings).toHaveLength(16);
    expect(things.has(trashed)).toBe(false);
    expect(things.get(drill)).toMatchObject({
      name: 'Drill',
      placeId: kitchen,
      containerId: null,
      shortCode: 'DR1234',
      quantity: '1',
      lifecycle: 'in_use',
      reviewState: 'confirmed',
      deleted: false,
      typeId: null,
    });
    expect(things.get(box)?.isContainer).toBe(true);
    expect(things.get(screws)).toMatchObject({ containerId: box, placeId: null });
    // Each thing with its meters (READING offline); none is an empty list.
    expect(things.get(ladder)?.meters).toEqual([
      { id: expect.any(String), kind: 'distance', unit: 'km', label: 'Odometer' },
    ]);
    expect(things.get(drill)?.meters).toEqual([]);
    expect(allOf(pages, 'codes')).toContainEqual({
      code: 'DR1234',
      locationId: home.id,
      thingId: drill,
      placeId: null,
      state: 'assigned',
      isPrimary: true,
    });
    expect(allOf(pages, 'legacyCodes')).toContainEqual({
      locationId: home.id,
      source: 'homebox',
      sourceCollection: '',
      code: 'HB-7',
      thingId: ladder,
      placeId: null,
    });
    expect(allOf(pages, 'places').map((p) => p.id)).toEqual(
      expect.arrayContaining([kitchen, home.unplacedId]),
    );

    // Locations in full on every page; Louis's Personal location and Home, never Garage.
    for (const p of pages) {
      expect(p.locations.map((l) => l.id).sort()).toEqual(
        [home.id, louis.personalLocationId].sort(),
      );
    }
    const loc = pages[0]?.locations.find((l) => l.id === home.id);
    expect(loc).toMatchObject({
      name: 'Home',
      role: 'member',
      unplacedPlaceId: home.unplacedId,
      suggestRadiusM: 150,
      timezone: 'Africa/Cairo',
    });
    expect(loc?.effectiveModules.length).toBeGreaterThan(0);
    expect(pages[0]?.payloadVersion).toBe(1);
    expect(pages.every((p) => p.revokedLocationIds.length === 0)).toBe(true);
    expect(pages.every((p) => p.truncated === undefined)).toBe(true);
  });

  it('turns the AI modules on where a provider resolves for the person, as the location API does', async () => {
    const modulesOf = async (as: Person, id: string) =>
      (await page(as)).locations.find((l) => l.id === id)?.effectiveModules ?? [];
    expect(await modulesOf(ibrahim, home.id)).not.toContain('ai_capture');
    // An account key with a vision model (kept.ai_cascade), on Ibrahim's account.
    await own(
      `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                        key_version, models, created_by)
       VALUES ($1, 'account', $2, 'groq', '{"v": 1}', 1, $3, $4)`,
      [
        newId(),
        await accountOf(ibrahim),
        JSON.stringify({ vision: 'qwen/qwen3.8-27b' }),
        ibrahim.userId,
      ],
    );
    const res = await call(t, `/api/v1/locations/${home.id}`, { as: ibrahim });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { providerResolved: boolean; effectiveModules: string[] };
    expect(view.providerResolved).toBe(true);
    expect(await modulesOf(ibrahim, home.id)).toEqual(view.effectiveModules);
    expect(await modulesOf(ibrahim, home.id)).toContain('ai_capture');
    expect(await modulesOf(ibrahim, garage.id)).toContain('ai_capture');
    // Alfred's household has no provider of its own.
    expect(await modulesOf(alfred, family.id)).not.toContain('ai_capture');
  });

  it('sends the types only when their hash differs from the phone’s', async () => {
    const first = await page(louis);
    expect(first.types.items?.length).toBeGreaterThan(10);
    expect(first.types.items?.find((x) => x.builtinKey === 'box_bin')?.isContainer).toBe(true);
    const again = await page(louis, { typesHash: first.types.hash });
    expect(again.types).toEqual({ hash: first.types.hash });
    const stale = await page(louis, { typesHash: 'something-else' });
    expect(stale.types.items).toHaveLength(first.types.items?.length as number);
  });

  it('gives a viewer and a member the same rows, each with their own role', async () => {
    const asMember = await pull(louis);
    const asViewer = await pull(talia);
    const ids = (p: Pulled) =>
      [...p.things.values()]
        .filter((x) => x.locationId === home.id)
        .map((x) => x.id)
        .sort();
    expect(ids(asViewer)).toEqual(ids(asMember));
    expect(asViewer.pages[0]?.locations.find((l) => l.id === home.id)?.role).toBe('viewer');
    expect(asMember.pages[0]?.locations.find((l) => l.id === home.id)?.role).toBe('member');
    const owner = await pull(ibrahim);
    expect(owner.pages[0]?.locations.find((l) => l.id === home.id)?.role).toBe('owner');
  });

  it('never gives another household’s rows', async () => {
    const { pages } = await pull(ibrahim);
    const json = JSON.stringify(pages);
    expect(json).not.toContain(family.id);
    expect(json).not.toContain('مثقاب');
    expect(json).not.toContain('بيت العائلة');
  });
});

describe('deltas', () => {
  // Step-3 carry-over (T19): no code tombstone. The phone applies removals after changes, so a
  // tombstone for a code that moved would delete it from its new thing. A moved code instead
  // bumps the thing it left (kept.touch_code_move(), state_version, 0055) and its own row
  // changes: the delta carries both.
  it('carry the thing a code moved off, and the code on its new thing, with no removal', async () => {
    await own(
      `INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ('MV1234', $1, $2)`,
      [home.id, drill],
    );
    const mark = await markNow();
    const state: CursorState = { v: 1, w: { [home.id]: mark }, p: null };
    await own(
      `UPDATE public.short_ids SET thing_id = $2 WHERE code = 'MV1234' AND location_id = $1`,
      [home.id, ladder],
    );
    const { pages } = await directPull(louis, state);
    const things = new Map(allOf(pages, 'things').map((x) => [x.id, x]));
    expect(things.get(drill)?.shortCode).toBeNull();
    expect(allOf(pages, 'codes')).toEqual([
      expect.objectContaining({ code: 'MV1234', thingId: ladder, placeId: null }),
    ]);
    expect(pages.flatMap((p) => p.removed)).toEqual([]);
  });

  it('carry a rename, a sighting and the trash, and not a quiet cache update', async () => {
    const shelf = await place(home, 'Shelf');
    const mark = await markNow();
    const state: CursorState = {
      v: 1,
      w: { [home.id]: mark, [louis.personalLocationId]: mark },
      p: null,
    };
    // Quiet: search_tsv only (touch_row leaves change_seq, so change_xid stays).
    await own(`UPDATE public.things SET search_tsv = to_tsvector('simple', 'x') WHERE id = $1`, [
      ladder,
    ]);
    let { pages } = await directPull(louis, state);
    expect(allOf(pages, 'things')).toEqual([]);
    expect(allOf(pages, 'places')).toEqual([]);

    await own(`UPDATE public.places SET name = 'Top shelf' WHERE id = $1`, [shelf]);
    await own('UPDATE public.things SET last_seen_at = $2 WHERE id = $1', [
      drill,
      '2026-09-20T10:00:00Z',
    ]);
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [box]);
    ({ pages } = await directPull(louis, state));
    expect(allOf(pages, 'places')).toEqual([
      expect.objectContaining({ id: shelf, name: 'Top shelf', deleted: false }),
    ]);
    const changed = new Map(allOf(pages, 'things').map((x) => [x.id, x]));
    expect(changed.get(drill)?.lastSeenAt).toBe('2026-09-20T10:00:00.000Z');
    expect(changed.get(box)?.deleted).toBe(true);
    expect(changed.has(ladder)).toBe(false);
    expect(pages.at(-1)?.complete).toBe(true);
  });

  it('carry a thing whose meter was added or renamed, with its meters, its row_version kept', async () => {
    const version = async () =>
      (
        await own<{ v: number }>('SELECT row_version AS v FROM public.things WHERE id = $1', [
          drill,
        ])
      )[0]?.v;
    const before = await version();
    const mark = await markNow();
    const state: CursorState = { v: 1, w: { [home.id]: mark }, p: null };
    const [meter] = await own<{ id: string }>(
      `INSERT INTO public.meters (location_id, thing_id, kind, unit, label)
       VALUES ($1, $2, 'hours', 'h', NULL) RETURNING id`,
      [home.id, drill],
    );
    let { pages } = await directPull(louis, state);
    let things = allOf(pages, 'things');
    expect(things.map((x) => x.id)).toEqual([drill]);
    expect(things[0]?.meters).toEqual([{ id: meter?.id, kind: 'hours', unit: 'h', label: null }]);

    const later = await markNow();
    await own(`UPDATE public.meters SET label = 'Motor hours' WHERE id = $1`, [meter?.id]);
    ({ pages } = await directPull(louis, { v: 1, w: { [home.id]: later }, p: null }));
    things = allOf(pages, 'things');
    expect(things.map((x) => x.id)).toEqual([drill]);
    expect(things[0]?.meters?.[0]?.label).toBe('Motor hours');
    // A reading's replacement offset isn't what READING shows: no resend.
    const quiet = await markNow();
    await own(`UPDATE public.meters SET "offset" = 10 WHERE id = $1`, [meter?.id]);
    ({ pages } = await directPull(louis, { v: 1, w: { [home.id]: quiet }, p: null }));
    expect(allOf(pages, 'things')).toEqual([]);
    // The thing's own version, the one an edit's If-Match names, is untouched.
    expect(await version()).toBe(before);
  });

  it('carry a thing whose meter got a reading, with the latest (step 5, Q18)', async () => {
    const car = await thing(home, 'Corolla');
    const [meter] = await own<{ id: string }>(
      `INSERT INTO public.meters (location_id, thing_id, kind, unit)
       VALUES ($1, $2, 'distance', 'km') RETURNING id`,
      [home.id, car],
    );
    const mark = await markNow();
    const res = await call(t, `/api/v1/meters/${meter?.id}/readings`, {
      as: ibrahim,
      body: { value: '52340.500', takenAt: '2026-09-20T09:00:00.000Z' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { pages } = await directPull(louis, { v: 1, w: { [home.id]: mark }, p: null });
    const things = allOf(pages, 'things');
    expect(things.map((x) => x.id)).toEqual([car]);
    expect(things[0]?.meters).toEqual([
      {
        id: meter?.id,
        kind: 'distance',
        unit: 'km',
        label: null,
        latest: { value: '52340.5', takenAt: '2026-09-20T09:00:00.000Z' },
      },
    ]);
    // Through the route too, as the phone reads it.
    const routed = await pull(louis);
    expect(routed.things.get(car)?.meters?.[0]?.latest).toEqual({
      value: '52340.5',
      takenAt: '2026-09-20T09:00:00.000Z',
    });
  });

  it('remove a thing moved out of the location, and bring it back when it returns', async () => {
    const first = await pull(louis);
    await withScope(db.pools.app, { userId: ibrahim.userId, mfa: true }, (_tx, c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [drill],
        garage.id,
        garage.unplacedId,
      ]),
    );
    const out = await pull(louis, first.cursor);
    expect(removedOf(out.pages)).toContainEqual({
      locationId: home.id,
      entityType: 'thing',
      entityId: drill,
    });
    expect(out.things.has(drill)).toBe(false);

    // Ibrahim sees both: the thing arrives in Garage, and Home's tombstone says it left Home.
    const owner = await pull(ibrahim);
    const moved = await withScope(db.pools.app, { userId: ibrahim.userId, mfa: true }, (_tx, c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [
        [ladder],
        garage.id,
        garage.unplacedId,
      ]),
    );
    expect(moved.rowCount).toBe(1);
    const ownerDelta = await pull(ibrahim, owner.cursor);
    expect(ownerDelta.things.get(ladder)?.locationId).toBe(garage.id);
    expect(removedOf(ownerDelta.pages)).toContainEqual({
      locationId: home.id,
      entityType: 'thing',
      entityId: ladder,
    });

    await withScope(db.pools.app, { userId: ibrahim.userId, mfa: true }, (_tx, c) =>
      c.query('SELECT * FROM kept.move_things($1, $2, $3, NULL)', [[drill], home.id, kitchen]),
    );
    const back = await pull(louis, out.cursor);
    expect(back.things.get(drill)).toMatchObject({ locationId: home.id, placeId: kitchen });
    // The arrival cleared Home's tombstone: nothing says it left.
    expect(removedOf(back.pages).filter((r) => r.entityId === drill)).toEqual([]);
  });

  it('name a location whose membership ended, once', async () => {
    const first = await pull(louis);
    await own('DELETE FROM public.memberships WHERE location_id = $1 AND user_id = $2', [
      home.id,
      louis.userId,
    ]);
    const next = await page(louis, { cursor: first.cursor });
    expect(next.revokedLocationIds).toEqual([home.id]);
    expect(next.locations.map((l) => l.id)).toEqual([louis.personalLocationId]);
    expect(JSON.stringify(next.changes)).not.toContain(home.id);
    const after = await pull(louis, next.nextCursor);
    expect(after.pages.flatMap((p) => p.revokedLocationIds)).toEqual([]);
  });

  it('read a location joined since the last sync in full', async () => {
    const tools = await thing(garage, 'Tool chest');
    const first = await pull(louis);
    expect(first.things.has(tools)).toBe(false);
    await join(db, garage.id, louis.userId, 'member');
    const next = await pull(louis, first.cursor);
    expect(next.things.get(tools)).toMatchObject({ locationId: garage.id, name: 'Tool chest' });
    expect(allOf(next.pages, 'places').map((p) => p.id)).toContain(garage.unplacedId);
  });

  it('start another pass for a location joined during one', async () => {
    const tools = await thing(garage, 'Tool chest');
    const one = await page(louis, { limit: 2 });
    expect(one.complete).toBe(false);
    await join(db, garage.id, louis.userId, 'member');
    const rest = await pull(louis, one.nextCursor, 2);
    // The pass that started without Garage finishes incomplete, and the next one reads it.
    expect(rest.pages.some((p) => !p.complete && p.locations.some((l) => l.id === garage.id))).toBe(
      true,
    );
    expect(rest.things.get(tools)?.locationId).toBe(garage.id);
  });

  it('stay stable across pages when rows change mid-pass: the next pass has them', async () => {
    for (let i = 0; i < 8; i++) await thing(home, `Jar ${i}`, { placeId: kitchen });
    const first = await page(louis, { limit: 4 });
    const seen = first.changes.things[0] ?? first.changes.places[0];
    expect(seen).toBeDefined();
    const renamed = first.changes.things[0]?.id ?? drill;
    await own(`UPDATE public.things SET name = 'Renamed mid-pass' WHERE id = $1`, [renamed]);
    const added = await thing(home, 'Added mid-pass');
    const rest = await pull(louis, first.nextCursor, 4);
    const pass = new Map([
      ...first.changes.things.map((x) => [x.id, x] as const),
      ...rest.things.entries(),
    ]);
    // Every thing that was there when the pass began arrives in it.
    for (const id of [drill, ladder, box, screws]) expect(pass.has(id)).toBe(true);
    const next = await pull(louis, rest.cursor);
    expect(next.things.get(renamed)?.name).toBe('Renamed mid-pass');
    expect(next.things.has(added) || pass.has(added)).toBe(true);
  });

  it('page through several locations that share a watermark', async () => {
    const first = await pull(louis);
    const renamed: string[] = [];
    for (const id of [drill, ladder, box, screws]) {
      await own(`UPDATE public.things SET name = name || ' (checked)' WHERE id = $1`, [id]);
      renamed.push(id);
    }
    const nook = await place({ id: louis.personalLocationId, unplacedId: '' }, 'Nook');
    const delta = await pull(louis, first.cursor, 2);
    expect(delta.pages.length).toBeGreaterThan(2);
    for (const id of renamed) expect(delta.things.get(id)?.name).toMatch(/\(checked\)$/);
    expect(allOf(delta.pages, 'places').map((p) => p.id)).toContain(nook);
  });

  it('keep the T4 watermark cases: a late commit is read on the next pass', async () => {
    const first = await pull(louis);
    const begin = async () => {
      const c = new pg.Client({ connectionString: db.urls.app });
      c.on('error', () => {});
      await c.connect();
      open.push(c);
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.mfa', 'true', true)",
        [ibrahim.userId],
      );
      return c;
    };
    const t1 = await begin();
    await t1.query(`UPDATE public.things SET name = 'Drill, cordless' WHERE id = $1`, [drill]);
    const t2 = await begin();
    await t2.query(`UPDATE public.things SET name = 'Ladder, tall' WHERE id = $1`, [ladder]);
    await t2.query('COMMIT');

    const second = await pull(louis, first.cursor);
    expect(second.things.get(ladder)?.name).toBe('Ladder, tall');
    expect(second.things.get(drill)?.name).not.toBe('Drill, cordless');

    await t1.query('COMMIT');
    const third = await pull(louis, second.cursor);
    expect(third.things.get(drill)?.name).toBe('Drill, cordless');
  });
});

describe('the cap', () => {
  it('keeps the most recently seen things past it, and says so', async () => {
    const recent: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await thing(home, `Seen ${i}`);
      await own('UPDATE public.things SET last_seen_at = $2 WHERE id = $1', [
        id,
        `2020-01-0${i + 1}T00:00:00Z`,
      ]);
      recent.push(id);
    }
    // Louis's live things: the 4 of beforeEach and these 6. Keep 4: the ones of beforeEach were
    // seen now, the most recent.
    const { pages } = await directPull(louis, FIRST_SYNC, 3, 4);
    expect(pages.every((p) => p.truncated === true)).toBe(true);
    const ids = allOf(pages, 'things').map((x) => x.id);
    expect(ids.sort()).toEqual([drill, ladder, box, screws].sort());
  });
});

describe('the cursor', () => {
  it('is refused when it has been tampered with, garbled or signed with another key', async () => {
    const first = await page(louis, { limit: 2 });
    const [body, sig] = first.nextCursor.split('.') as [string, string];
    const state = JSON.parse(Buffer.from(body, 'base64url').toString()) as CursorState;
    const forged = Buffer.from(JSON.stringify({ ...state, w: { [family.id]: '0' } })).toString(
      'base64url',
    );
    for (const cursor of [
      `${forged}.${sig}`,
      `${body}.${sig.slice(1)}A`,
      'not-a-cursor',
      signCursor(syncCursorKey(Buffer.alloc(32, 7)), state),
    ]) {
      const res = await call(t, `/api/v1/sync/snapshot?cursor=${encodeURIComponent(cursor)}`, {
        as: louis,
      });
      expect(res.statusCode, cursor).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation' });
    }
    expect((await page(louis, { cursor: first.nextCursor })).locations.length).toBe(2);
  });

  it('needs a session', async () => {
    const res = await call(t, '/api/v1/sync/snapshot');
    expect(res.statusCode).toBe(401);
  });
});
