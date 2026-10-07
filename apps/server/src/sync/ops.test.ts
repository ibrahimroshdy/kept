import { newId, randomShortCode } from '@kept/shared';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { sha256, type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { act } from '../../test/inbox.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { CLIENT_VERSION, captureOp, op, sent, syncOps } from '../../test/sync-ops.js';
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

// T14: POST /api/v1/sync/ops through the front door, in the shapes the phone's sync engine sends
// (apps/web/src/offline/sync-engine.ts) and reads back. The ordering and conflict suite is
// ordering.test.ts.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let home: Loc;

const log = { error: () => {} } as unknown as FastifyBaseLogger;

const thingOf = async (id: string) =>
  (
    await own<{
      name: string | null;
      place_id: string | null;
      container_id: string | null;
      last_seen_at: Date | null;
      deleted_at: Date | null;
    }>(
      db,
      `SELECT name, place_id, container_id, last_seen_at, deleted_at FROM public.things
        WHERE id = $1`,
      [id],
    )
  )[0];

const ledger = (key: string) =>
  own<{ outcome: string; reason: string | null; location_id: string | null }>(
    db,
    'SELECT outcome, reason, location_id FROM public.sync_ops WHERE idempotency_key = $1',
    [key],
  );

async function up(as: Person, bytes: Buffer, id = newId()) {
  const res = await upload(t, as, home.id, bytes, { id, cls: 'photo' });
  expect([200, 201]).toContain(res.statusCode);
  return res.json() as { id: string; deduplicatedFrom?: string };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('POST /api/v1/sync/ops', () => {
  // catalogue: POST /api/v1/sync/ops
  it('applies a queued capture as the caller, audits it, and answers its short ID', async () => {
    const shelf = await place(db, home, 'Shelf A');
    const item = captureOp(home.id, { placeId: shelf }, { name: 'Step ladder' });
    const [r] = await sent(t, louis, [item]);
    expect(r).toMatchObject({
      clientId: item.clientId,
      idempotencyKey: item.idempotencyKey,
      outcome: 'applied',
      entity: { type: 'thing', id: item.payload.id },
    });
    expect(r?.entity?.shortCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(await thingOf(item.payload.id)).toMatchObject({ name: 'Step ladder', place_id: shelf });
    const events = await eventsOf(db, home.id, item.payload.id);
    expect(events.map((e) => [e.action, e.actor_id])).toEqual([['thing.capture', louis.userId]]);
    expect(await ledger(item.idempotencyKey)).toEqual([
      { outcome: 'applied', reason: null, location_id: home.id },
    ]);
  });

  it('answers the same key with another body as idempotency_mismatch, and changes nothing', async () => {
    const shelf = await place(db, home, 'Shelf B');
    const first = captureOp(home.id, { placeId: shelf }, { name: 'Drill' });
    await sent(t, louis, [first]);
    const other = { ...first, payload: { ...first.payload, name: 'Hammer' } };
    const [r] = await sent(t, louis, [other]);
    expect(r).toEqual({
      clientId: first.clientId,
      idempotencyKey: first.idempotencyKey,
      outcome: 'dropped',
      reason: 'idempotency_mismatch',
    });
    expect((await thingOf(first.payload.id))?.name).toBe('Drill');
    expect(await ledger(first.idempotencyKey)).toHaveLength(1);
  });

  it('refuses a batch with a payload newer than the server: 409 server_outdated, nothing applied', async () => {
    const item = captureOp(home.id, { unplaced: true });
    const res = await syncOps(t, louis, [
      captureOp(home.id, { unplaced: true }),
      { ...item, payloadVersion: 2 },
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'server_outdated' });
    expect(await thingOf(item.payload.id)).toBeUndefined();
  });

  it('refuses a batch with a field the phone never sends: the schema is strict', async () => {
    const item = { ...captureOp(home.id, { unplaced: true }), blobs: [] };
    expect((await syncOps(t, louis, [item])).statusCode).toBe(400);
  });

  it("refuses a viewer's ops, and changes nothing", async () => {
    const jar = await createThing(t, ibrahim, home, { name: 'Jam jar' });
    const before = (await thingOf(jar.id))?.last_seen_at;
    const results = await sent(t, talia, [
      op('mark_seen', home.id, { thingId: jar.id }),
      captureOp(home.id, { unplaced: true }),
    ]);
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['dropped', 'not_permitted'],
      ['dropped', 'not_permitted'],
    ]);
    expect((await thingOf(jar.id))?.last_seen_at).toEqual(before);
  });

  it('tells a removed member location_revoked even when no op of theirs reached it (T19, D210)', async () => {
    const bruce = await person(t, db, 'bruce');
    const membership = await join(db, home.id, bruce.userId, 'member');
    const stranger = await person(t, db, 'murdock');
    const jar = await createThing(t, ibrahim, home, { name: 'Honey jar' });
    // Removed through the front door (audited `member.remove`) before his phone ever synced.
    const removed = await call(t, `/api/v1/locations/${home.id}/members/${membership}`, {
      as: ibrahim,
      method: 'DELETE',
    });
    expect(removed.statusCode).toBe(204);
    const [his] = await sent(t, bruce, [op('mark_seen', home.id, { thingId: jar.id })]);
    expect([his?.outcome, his?.reason]).toEqual(['dropped', 'location_revoked']);
    // Someone who never belonged learns nothing: the same answer as a random id.
    const [theirs] = await sent(t, stranger, [op('mark_seen', home.id, { thingId: jar.id })]);
    expect([theirs?.outcome, theirs?.reason]).toEqual(['dropped', 'not_permitted']);
  });

  it('stamps a queued mark_seen with when the phone saw it, never moving a sighting back', async () => {
    const jar = await createThing(t, ibrahim, home, { name: 'Spice jar' });
    await own(
      db,
      `UPDATE public.things SET last_seen_at = now() - interval '3 days' WHERE id = $1`,
      [jar.id],
    );
    const takenAt = new Date(Date.now() - 2 * 3600 * 1000);
    const [r] = await sent(t, louis, [
      op('mark_seen', home.id, { thingId: jar.id }, { takenAt: takenAt.toISOString() }),
    ]);
    expect(r?.outcome).toBe('applied');
    expect((await thingOf(jar.id))?.last_seen_at?.toISOString()).toBe(takenAt.toISOString());
    // An older sighting queued behind it keeps the later one.
    const older = new Date(Date.now() - 5 * 3600 * 1000);
    await sent(t, louis, [
      op('mark_seen', home.id, { thingId: jar.id }, { takenAt: older.toISOString() }),
    ]);
    expect((await thingOf(jar.id))?.last_seen_at?.toISOString()).toBe(takenAt.toISOString());
  });

  it('answers a key the ledger cannot hold as invalid, without recording it', async () => {
    const jar = await createThing(t, ibrahim, home, { name: 'Jar' });
    const item = op('mark_seen', home.id, { thingId: jar.id }, { idempotencyKey: 'short' });
    const [r] = await sent(t, louis, [item]);
    expect(r).toMatchObject({ outcome: 'dropped', reason: 'invalid' });
    expect(await ledger('short')).toEqual([]);
  });

  it('applies ops in order with dependsOn, and drops a child whose parent was dropped earlier', async () => {
    const area = op('create_area', home.id, {
      id: newId(),
      parentId: null,
      name: 'Shed',
      kindKey: 'room',
    });
    const areaId = (area.payload as { id: string }).id;
    const into = captureOp(
      home.id,
      { placeId: areaId },
      { name: 'Rake' },
      {
        dependsOn: [area.idempotencyKey],
      },
    );
    const results = await sent(t, louis, [area, into]);
    expect(results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
    expect(results[0]?.entity).toEqual({ type: 'place', id: areaId });
    expect((await thingOf(into.payload.id))?.place_id).toBe(areaId);

    // An area of a kind that doesn't exist is dropped; a capture into it, sent later, follows.
    const bad = op('create_area', home.id, {
      id: newId(),
      parentId: null,
      name: 'Nowhere',
      kindKey: 'no_such_kind',
    });
    expect((await sent(t, louis, [bad]))[0]).toMatchObject({
      outcome: 'dropped',
      reason: 'invalid',
    });
    const late = captureOp(
      home.id,
      { placeId: (bad.payload as { id: string }).id },
      {},
      {
        dependsOn: [bad.idempotencyKey],
      },
    );
    expect((await sent(t, louis, [late]))[0]).toMatchObject({
      outcome: 'dropped',
      reason: 'parent_dropped',
    });
  });

  it('drops a capture into a trashed place with an inbox item, and Restore captures it', async () => {
    const shelf = await place(db, home, 'Top shelf');
    ok(await call(t, `/api/v1/places/${shelf}/trash`, { as: ibrahim, body: {} }));
    const item = captureOp(home.id, { placeId: shelf }, { name: 'Torch' });
    const [r] = await sent(t, louis, [item]);
    expect(r).toMatchObject({
      outcome: 'dropped',
      reason: 'target_trashed',
      notice: { name: 'Top shelf', by: { displayName: 'Ibrahim' }, action: 'trashed' },
    });
    expect(await thingOf(item.payload.id)).toBeUndefined();
    const restored = ok(await act(t, louis, r?.inboxItemId as string, 'restore', {}));
    expect(restored).toEqual({ outcome: 'applied' });
    expect(await thingOf(item.payload.id)).toMatchObject({ name: 'Torch', place_id: shelf });
  });

  it('moves the live things of a move and names the one trashed meanwhile', async () => {
    const shelf = await place(db, home, 'Shelf C');
    const kept = await createThing(t, ibrahim, home, { name: 'Glue' });
    const gone = await createThing(t, ibrahim, home, { name: 'Old paint' });
    ok(await call(t, `/api/v1/things/${gone.id}/trash`, { as: ibrahim, body: {} }));
    const [r] = await sent(t, louis, [
      op('move', home.id, { thingIds: [kept.id, gone.id], to: { placeId: shelf } }),
    ]);
    expect(r).toMatchObject({
      outcome: 'applied',
      notice: { name: 'Old paint', by: { displayName: 'Ibrahim' }, action: 'trashed' },
    });
    expect((await thingOf(kept.id))?.place_id).toBe(shelf);
    expect((await thingOf(gone.id))?.deleted_at).not.toBeNull();
  });

  it('stops at an op that fails like a bug: earlier answers stand, the rest go again', async () => {
    const jar = await createThing(t, ibrahim, home, { name: 'Honey' });
    const a = captureOp(home.id, { unplaced: true }, { name: 'A' });
    const seen = op('mark_seen', home.id, { thingId: jar.id });
    const b = captureOp(home.id, { unplaced: true }, { name: 'B' });
    const deps = { pools: db.pools, jobs: null, files: null, log };
    const scope = { userId: louis.userId, mfa: false };
    const body = { clientVersion: CLIENT_VERSION, ops: [a, seen, b] };
    const broken = await applyOps(deps, scope, 'test', body, {
      handlers: {
        mark_seen: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(broken.results.map((r) => r.idempotencyKey)).toEqual([a.idempotencyKey]);
    expect(await thingOf(b.payload.id)).toBeUndefined();
    expect(await ledger(seen.idempotencyKey)).toEqual([]);
    // Sent again with the same keys: the first replays, the others apply.
    const again = await applyOps(deps, scope, 'test', body);
    expect(again.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(again.results[0]).toEqual(broken.results[0]);
    expect(
      (await eventsOf(db, home.id, a.payload.id)).filter((e) => e.action === 'thing.capture'),
    ).toHaveLength(1);
  });

  it('takes a file whose bytes the location already held by its hash (dedupe, D177)', async () => {
    const bytes = await uniqueJpeg();
    const sha = sha256(bytes);
    // Ibrahim's photo, on his own capture.
    const his = await up(ibrahim, bytes);
    const first = captureOp(
      home.id,
      { unplaced: true },
      {
        files: [{ fileId: his.id, role: 'photo', sha256: sha }],
      },
    );
    expect((await sent(t, ibrahim, [first]))[0]?.outcome).toBe('applied');
    // Louis's phone uploads the same bytes under its own id: no new file is made.
    const mine = newId();
    expect((await up(louis, bytes, mine)).deduplicatedFrom).toBe(his.id);
    const withHash = captureOp(
      home.id,
      { unplaced: true },
      {
        files: [{ fileId: mine, role: 'photo', sha256: sha }],
      },
    );
    const [r] = await sent(t, louis, [withHash]);
    expect(r?.outcome).toBe('applied');
    const atts = await own<{ file_id: string }>(
      db,
      'SELECT file_id FROM public.attachments WHERE thing_id = $1',
      [withHash.payload.id],
    );
    expect(atts).toEqual([{ file_id: his.id }]);
    // Without the hash, the id names nothing: the capture can't find its photo.
    const bare = captureOp(
      home.id,
      { unplaced: true },
      {
        files: [{ fileId: newId(), role: 'photo' }],
      },
    );
    expect((await sent(t, louis, [bare]))[0]).toMatchObject({
      outcome: 'dropped',
      reason: 'target_missing',
    });
  });

  it('claims a blank label for a new box inside a container', async () => {
    const crate = await createThing(t, ibrahim, home, {
      name: 'Crate',
      typeId: await builtinType(db, 'box_bin'),
    });
    const code = randomShortCode();
    await own(
      db,
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
       VALUES ($1, $2, 'blank', false)`,
      [code, home.id],
    );
    const box = newId();
    const [r] = await sent(t, louis, [
      op(
        'claim_label',
        home.id,
        { code, target: { newContainer: { id: box, name: 'Cables', containerId: crate.id } } },
        { idempotencyKey: `claim:${code}` },
      ),
    ]);
    expect(r).toMatchObject({
      outcome: 'applied',
      entity: { type: 'thing', id: box, shortCode: code },
    });
    expect((await thingOf(box))?.container_id).toBe(crate.id);
    expect((await eventsOf(db, home.id, box)).map((e) => e.action)).toContain('label.claim');
  });

  it('drops a box check whose counted thing has left the box since, saying who moved it', async () => {
    const boxType = await builtinType(db, 'box_bin');
    const box = await createThing(t, ibrahim, home, { name: 'Box 3', typeId: boxType });
    const cable = await createThing(t, ibrahim, home, { name: 'HDMI cable', containerId: box.id });
    const lamp = await createThing(t, ibrahim, home, { name: 'Lamp', containerId: box.id });
    const check = (lines: string[]) =>
      op(
        'box_check',
        home.id,
        {
          id: newId(),
          containerId: box.id,
          lines: lines.map((thingId) => ({ thingId, expectedQty: '1', foundQty: '1' })),
          foundElsewhereIds: [],
        },
        { idempotencyKey: `box:${newId()}` },
      );
    // Counted offline; meanwhile Ibrahim took the lamp out.
    const stale = check([cable.id, lamp.id]);
    const shelf = await place(db, home, 'Desk');
    ok(
      await call(t, '/api/v1/things/move', {
        as: ibrahim,
        body: { thingIds: [lamp.id], to: { placeId: shelf } },
      }),
    );
    const before = (await thingOf(cable.id))?.last_seen_at as Date;
    const [r] = await sent(t, louis, [stale]);
    expect(r).toMatchObject({
      outcome: 'dropped',
      reason: 'target_missing',
      notice: { name: 'Lamp', by: { displayName: 'Ibrahim' }, action: 'moved' },
    });
    expect((await thingOf(cable.id))?.last_seen_at).toEqual(before);
    // A count of what is in the box now applies.
    const [fresh] = await sent(t, louis, [check([cable.id])]);
    expect(fresh).toMatchObject({ outcome: 'applied', entity: { type: 'thing', id: box.id } });
    expect((await thingOf(cable.id))?.last_seen_at?.getTime()).toBeGreaterThan(before.getTime());
    expect((await eventsOf(db, home.id, box.id)).map((e) => e.action)).toContain('box.check');
  });
});
