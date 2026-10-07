import { newId, randomShortCode, type SyncOpResult } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { act } from '../../test/inbox.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { CLIENT_VERSION, captureOp, idDaysAgo, op, sent, syncOps } from '../../test/sync-ops.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { applyOps } from './ops.js';

// T14's sync ordering and conflict suite (plan T14 "ordering.test.ts"; D35, D112, D148, D210;
// Q2, Q3): what the server does with offline changes that arrive late, twice, out of order, or
// into something that changed meanwhile.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let alfred: Person; // member of Home, the other phone
let bruce: Person; // another household
let home: Loc;
let garage: Loc;

const thingOf = async (id: string) =>
  (
    await own<{ place_id: string | null; container_id: string | null; deleted_at: Date | null }>(
      db,
      'SELECT place_id, container_id, deleted_at FROM public.things WHERE id = $1',
      [id],
    )
  )[0];

/** An inbox item as stored (as kept_owner). */
const itemRow = async (id: string) =>
  (
    await own<{
      kind: string;
      code: string | null;
      thing_id: string | null;
      resolution: string | null;
      payload: Record<string, unknown>;
    }>(
      db,
      'SELECT kind, code, thing_id, resolution, payload FROM public.inbox_items WHERE id = $1',
      [id],
    )
  )[0];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  alfred = await person(t, db, 'alfred');
  bruce = await person(t, db, 'bruce');
  await setDisplayName(db, alfred, 'Alfred');
  home = await createLocation(t, db, ibrahim, 'household');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, alfred.userId, 'member');
});

afterAll(async () => {
  await t.app.close();
});

describe('sync ordering and conflicts', () => {
  it('1. applies two offline moves in arrival order: the last to arrive wins, both in history', async () => {
    const p1 = await place(db, home, 'Garage shelf');
    const p2 = await place(db, home, 'Attic');
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    // Louis moved it to P1 first, Alfred to P2 later; Alfred's phone synced first.
    const toP1 = op('move', home.id, { thingIds: [drill.id], to: { placeId: p1 } });
    const toP2 = op('move', home.id, { thingIds: [drill.id], to: { placeId: p2 } });
    expect((await sent(t, alfred, [toP2]))[0]?.outcome).toBe('applied');
    expect((await sent(t, louis, [toP1]))[0]?.outcome).toBe('applied');
    expect((await thingOf(drill.id))?.place_id).toBe(p1);
    const moves = (await eventsOf(db, home.id, drill.id)).filter((e) => e.action === 'thing.move');
    expect(moves.map((e) => e.actor_id)).toEqual([alfred.userId, louis.userId]);
  });

  it('2. drops a move into a place trashed meanwhile, with who did it, an inbox item, and a restore', async () => {
    const shelf = await place(db, home, 'Hallway closet');
    const jar = await createThing(t, ibrahim, home, { name: 'Jam jar' });
    ok(await call(t, `/api/v1/places/${shelf}/trash`, { as: alfred, body: {} }));
    const moving = op('move', home.id, { thingIds: [jar.id], to: { placeId: shelf } });
    const [r] = await sent(t, louis, [moving]);
    expect(r).toMatchObject({
      outcome: 'dropped',
      reason: 'target_trashed',
      notice: { name: 'Hallway closet', by: { displayName: 'Alfred' }, action: 'trashed' },
    });
    expect((await thingOf(jar.id))?.place_id).toBe(home.unplacedId);
    const item = r?.inboxItemId as string;
    const row = await itemRow(item);
    expect(row).toMatchObject({ kind: 'sync_drop', resolution: null });
    expect(row?.payload).toEqual({
      op: { op: 'move', payload: { thingIds: [jar.id], to: { placeId: shelf } } },
      reason: 'target_trashed',
      entity: { type: 'place', id: shelf, name: 'Hallway closet' },
      by: { displayName: 'Alfred' },
    });
    // One tap: the closet comes back, and the move applies.
    expect(ok(await act(t, louis, item, 'restore', {}))).toEqual({ outcome: 'applied' });
    expect((await thingOf(jar.id))?.place_id).toBe(shelf);
    expect((await itemRow(item))?.resolution).toBe('restored');
  });

  it('3. orders readings by when they were taken, and sends a late misfit to the inbox', async () => {
    const car = await createThing(t, ibrahim, home, { name: 'Car' });
    const meter = ok(
      await call(t, `/api/v1/things/${car.id}/meters`, {
        as: ibrahim,
        body: { kind: 'distance', unit: 'km' },
      }),
      201,
    ).id;
    const day = 86_400_000;
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
    const reading = (value: string, takenAt: string) =>
      op('log_reading', home.id, { id: newId(), meterId: meter, value, takenAt });
    // 10,000 on day 1 and 10,500 on day 2, arriving in reverse order: both fit.
    const later = await sent(t, louis, [reading('10500', at(2))]);
    const earlier = await sent(t, alfred, [reading('10000', at(3))]);
    expect([later[0]?.outcome, earlier[0]?.outcome]).toEqual(['applied', 'applied']);
    // A 9,800 taken between them: backwards against 10,000, never silently rejected.
    const [late] = await sent(t, louis, [reading('9800', at(2.5))]);
    expect(late).toMatchObject({
      outcome: 'needs_review',
      reason: 'lower_than_previous',
      entity: { type: 'meter_reading' },
    });
    const item = await itemRow(late?.inboxItemId as string);
    expect(item).toMatchObject({ kind: 'reading', resolution: null });
    expect(item?.payload).toMatchObject({
      reason: 'lower_than_previous',
      value: '9800',
      neighbours: { before: { takenAt: at(3) }, after: { takenAt: at(2) } },
    });
    const states = await own<{ value: string; state: string }>(
      db,
      `SELECT trim_scale(value)::text AS value, state FROM public.meter_readings
        WHERE meter_id = $1 ORDER BY taken_at`,
      [meter],
    );
    expect(states).toEqual([
      { value: '10000', state: 'accepted' },
      { value: '9800', state: 'needs_review' },
      { value: '10500', state: 'accepted' },
    ]);
  });

  it('4. lets the first claim of a blank label win; the other phone gets a label_claim item', async () => {
    const shelf = await place(db, home, 'Shelf B');
    const code = randomShortCode();
    await own(
      db,
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
       VALUES ($1, $2, 'blank', false)`,
      [code, home.id],
    );
    const box1 = newId();
    const box2 = newId();
    const claim = (id: string, name: string) =>
      op(
        'claim_label',
        home.id,
        { code, target: { newContainer: { id, name, placeId: shelf } } },
        { idempotencyKey: `claim:${code}` },
      );
    const [a] = await sent(t, louis, [claim(box1, 'Box 1')]);
    const [b] = await sent(t, alfred, [claim(box2, 'Box 2')]);
    expect(a).toMatchObject({ outcome: 'applied', entity: { type: 'thing', id: box1 } });
    expect(a?.entity?.shortCode).toBe(code);
    expect(b).toMatchObject({
      outcome: 'needs_review',
      reason: 'already_claimed',
      entity: { type: 'thing', id: box2 },
    });
    // Box 2 stands, with its own code, not the label.
    const codes = await own<{ code: string; thing_id: string; is_primary: boolean }>(
      db,
      `SELECT code, thing_id, is_primary FROM public.short_ids
        WHERE thing_id = ANY ($1::uuid[]) AND state = 'assigned' AND is_primary`,
      [[box1, box2]],
    );
    expect(codes.find((c) => c.thing_id === box1)?.code).toBe(code);
    const own2 = codes.find((c) => c.thing_id === box2)?.code;
    expect(own2).toBeTruthy();
    expect(own2).not.toBe(code);
    expect(b?.entity?.shortCode).toBe(own2);
    expect(await itemRow(b?.inboxItemId as string)).toMatchObject({
      kind: 'label_claim',
      code,
      thing_id: box2,
      payload: { claimedFor: { kind: 'thing', id: box1, name: 'Box 1' } },
    });
  });

  it('5. drops a capture whose area was dropped: the location was revoked meanwhile', async () => {
    const peter = await person(t, db, 'peter');
    const membership = await join(db, home.id, peter.userId, 'member');
    // Peter synced into Home once, so his ledger knows it.
    const drill = await createThing(t, ibrahim, home, { name: 'Level' });
    await sent(t, peter, [op('mark_seen', home.id, { thingId: drill.id })]);
    await own(db, 'DELETE FROM public.memberships WHERE id = $1', [membership]);

    const area = op('create_area', home.id, {
      id: newId(),
      parentId: null,
      name: 'Loft',
      kindKey: 'room',
    });
    const into = captureOp(
      home.id,
      { placeId: (area.payload as { id: string }).id },
      {},
      { dependsOn: [area.idempotencyKey] },
    );
    const results = await sent(t, peter, [area, into]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['dropped', 'location_revoked'],
      ['dropped', 'parent_dropped'],
    ]);
    expect(await thingOf(into.payload.id)).toBeUndefined();
  });

  it('6. answers the same batch sent twice identically: one thing, one audit event', async () => {
    const shelf = await place(db, home, 'Shelf C');
    const batch = [captureOp(home.id, { placeId: shelf }, { name: 'Tape measure' })];
    const first = await sent(t, louis, batch);
    const again = await sent(t, louis, batch);
    expect(again).toEqual(first);
    expect(first[0]).toMatchObject({ outcome: 'applied', entity: { type: 'thing' } });
    const id = batch[0]?.payload.id as string;
    const rows = await own<{ n: number }>(
      db,
      'SELECT count(*)::int AS n FROM public.things WHERE id = $1',
      [id],
    );
    expect(rows[0]?.n).toBe(1);
    const captures = (await eventsOf(db, home.id, id)).filter((e) => e.action === 'thing.capture');
    expect(captures).toHaveLength(1);
  });

  it('7. upgrades a v0 payload with a registered upgrader; below the minimum nothing is written', async () => {
    // Through the service, with a window that still takes v0 and a v0 → v1 step (`title` → `name`).
    const shelf = await place(db, home, 'Shelf D');
    const old = captureOp(home.id, { placeId: shelf }, { name: undefined, title: 'Old lamp' });
    old.payloadVersion = 0;
    const { results } = await applyOps(
      { pools: db.pools, jobs: null, files: null, log: silent },
      { userId: louis.userId, mfa: false },
      'test',
      { clientVersion: CLIENT_VERSION, ops: [old] },
      {
        window: {
          min: 0,
          upgraders: {
            create_thing: {
              0: (p) => {
                const { title, ...rest } = p as { title: string };
                return { ...rest, name: title };
              },
            },
          },
        },
      },
    );
    expect(results[0]).toMatchObject({ outcome: 'applied' });
    const names = await own<{ name: string }>(db, 'SELECT name FROM public.things WHERE id = $1', [
      old.payload.id,
    ]);
    expect(names).toEqual([{ name: 'Old lamp' }]);

    // Through the route, where v0 is below the minimum: 409, and the good op beside it waits too.
    const good = captureOp(home.id, { placeId: shelf }, { name: 'New lamp' });
    const stale = { ...captureOp(home.id, { placeId: shelf }), payloadVersion: 0 };
    const res = await syncOps(t, louis, [good, stale]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'client_outdated', minPayloadVersion: 1 });
    expect(await thingOf(good.payload.id)).toBeUndefined();
    const ledger = await own(db, 'SELECT 1 FROM public.sync_ops WHERE idempotency_key = $1', [
      good.idempotencyKey,
    ]);
    expect(ledger).toEqual([]);
  });

  it('8. accepts a client id 60 days old, and drops one 100 days old as invalid', async () => {
    const shelf = await place(db, home, 'Shelf E');
    const sixty = idDaysAgo(60);
    const hundred = idDaysAgo(100);
    const results = await sent(t, louis, [
      captureOp(home.id, { placeId: shelf }, {}, { clientId: sixty }),
      captureOp(home.id, { placeId: shelf }, {}, { clientId: hundred }),
      // A fresh op id with a 100-day-old thing id is refused too.
      op('create_thing', home.id, {
        id: hundred.replace(/.$/, '0'),
        target: { placeId: shelf },
        mode: 'thing',
        batchId: newId(),
        files: [],
        name: 'Old',
      }),
    ]);
    expect(results.map((r) => [r.outcome, r.reason ?? null])).toEqual([
      ['applied', null],
      ['dropped', 'invalid'],
      ['dropped', 'invalid'],
    ]);
    expect(await thingOf(sixty)).toBeTruthy();
    expect(await thingOf(hundred)).toBeUndefined();
  });

  it("9. answers an op into another household's location as a random location id", async () => {
    const theirs = await createThing(t, bruce, garage, { name: 'Welder' });
    const answer = async (locationId: string, thingId: string) => {
      const item = op('mark_seen', locationId, { thingId });
      const [r] = await sent(t, louis, [item]);
      return { ...r, clientId: undefined, idempotencyKey: undefined };
    };
    const intoGarage = await answer(garage.id, theirs.id);
    const intoNowhere = await answer(newId(), newId());
    expect(intoGarage).toEqual({
      clientId: undefined,
      idempotencyKey: undefined,
      outcome: 'dropped',
      reason: 'not_permitted',
    });
    expect(intoNowhere).toEqual(intoGarage);
    // Bruce's welder, named from Home: the same as a thing that doesn't exist.
    const [viaHome] = await sent(t, louis, [op('mark_seen', home.id, { thingId: theirs.id })]);
    const [random] = await sent(t, louis, [op('mark_seen', home.id, { thingId: newId() })]);
    expect({ ...viaHome, clientId: '', idempotencyKey: '', inboxItemId: '' }).toEqual({
      ...random,
      clientId: '',
      idempotencyKey: '',
      inboxItemId: '',
    });
    expect(viaHome?.reason).toBe('target_missing');
    const garageEvents = await auditOf(db, garage.id);
    expect(garageEvents.some((e) => e.actor_id === louis.userId)).toBe(false);
  });

  // Its time is measured alone, where a clock means something: test/perf/step3.perf.test.ts
  // holds a 50-op batch's p95 under 1.5 s (docs/perf/2026-09-30-step3.md). Here, inside the
  // parallel suite, the same batch took 3.1–9.3 s at load 20–36 and about 1 s alone (T32).
  it('10. applies 50 ops in one batch', async () => {
    const shelf = await place(db, home, 'Shelf F');
    const box = await builtinType(db, 'box_bin');
    const ops = Array.from({ length: 50 }, (_, i) =>
      captureOp(home.id, { placeId: shelf }, { name: `Jar ${i + 1}`, typeId: box }),
    );
    const results: SyncOpResult[] = await sent(t, louis, ops);
    expect(results.every((r) => r.outcome === 'applied')).toBe(true);
    expect(results).toHaveLength(50);
  });
});

const silent = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silent,
  level: 'silent',
  silent: () => {},
} as unknown as import('fastify').FastifyBaseLogger;
