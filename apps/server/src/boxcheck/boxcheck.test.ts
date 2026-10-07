import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
} from '../../test/things.js';
import { AUDIT_EVENT_HEADER } from '../http/write.js';

// T17: the box check (D10, D40, D175; screens §6, §8; Q25), through the front door in the web
// contract's shapes (apps/web/src/api/capture/types.ts `BoxCheckBody`, `BoxCheckResult`).

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household
let home: Loc;
let garage: Loc;
let boxType: string;

type Row = {
  quantity: string;
  location_uncertain: boolean;
  last_seen_at: Date | null;
  purchase_line_id: string | null;
  container_id: string | null;
  deleted_at: Date | null;
};

const rowOf = async (id: string) =>
  (
    await own<Row>(
      db,
      `SELECT quantity::text AS quantity, location_uncertain, last_seen_at, purchase_line_id,
              container_id, deleted_at
         FROM public.things WHERE id = $1`,
      [id],
    )
  )[0] as Row;

const check = (as: Person, boxId: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/things/${boxId}/box-check`, { as, body: { id: newId(), ...body } });

const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.body });

const boxEvents = (locationId: string) =>
  own<{ id: string; entity_id: string; actor_id: string; undoable_until: Date | null }>(
    db,
    `SELECT id, entity_id, actor_id, undoable_until FROM public.audit_events
      WHERE location_id = $1 AND action = 'box.check' AND undo_of IS NULL ORDER BY at, id`,
    [locationId],
  );

const subjectsOf = (eventId: string) =>
  own<{ thing_id: string }>(
    db,
    'SELECT thing_id FROM public.audit_event_subjects WHERE event_id = $1 ORDER BY thing_id',
    [eventId],
  );

/** A box with: a torch (1), a rope (1), cables (3, on a purchase line), and a nested bag. */
async function packedBox(loc: Loc, as: Person) {
  const box = await createThing(t, as, loc, { name: 'Box 3', typeId: boxType });
  const torch = await createThing(t, as, loc, { name: 'Torch', containerId: box.id });
  const rope = await createThing(t, as, loc, { name: 'Rope', containerId: box.id });
  const cables = await createThing(t, as, loc, {
    name: 'HDMI cable',
    containerId: box.id,
    quantity: 3,
  });
  const bag = await createThing(t, as, loc, { name: 'Bag', containerId: box.id, typeId: boxType });
  const inBag = await createThing(t, as, loc, { name: 'Gloves', containerId: bag.id });
  const purchase = newId();
  const line = newId();
  await own(
    db,
    `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total)
     VALUES ($1, $2, '2026-01-10', 'EGP', 300)`,
    [purchase, loc.id],
  );
  await own(
    db,
    `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity, unit_price)
     VALUES ($1, $2, $3, 'HDMI cable', 3, 100)`,
    [line, loc.id, purchase],
  );
  await own(db, 'UPDATE public.things SET purchase_line_id = $2 WHERE id = $1', [cables.id, line]);
  return { box, torch, rope, cables, bag, inBag, line };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  boxType = await builtinType(db, 'box_bin');
});

afterAll(async () => {
  await t.app.close();
});

describe('POST /api/v1/things/:id/box-check', () => {
  // catalogue: POST /api/v1/things/:id/box-check
  it('marks seen and not here, splits "found 2 of 3", moves in what was found, in one event', async () => {
    const p = await packedBox(home, ibrahim);
    const stray = await createThing(t, ibrahim, home, { name: 'Tape' });
    const was = {
      cables: await rowOf(p.cables.id),
      torch: await rowOf(p.torch.id),
      inBag: await rowOf(p.inBag.id),
    };
    const res = await check(louis, p.box.id, {
      lines: [
        { thingId: p.torch.id, expectedQty: '1', foundQty: '1' },
        { thingId: p.rope.id, expectedQty: '1', foundQty: '0' },
        { thingId: p.cables.id, expectedQty: '3', foundQty: '2' },
        { thingId: p.bag.id, expectedQty: '1', foundQty: '1' },
      ],
      foundElsewhereIds: [stray.id],
    });
    const out = ok(res) as Json & {
      seen: string[];
      notHere: string[];
      split: { originalId: string; newId: string }[];
      movedIn: string[];
      undo: { eventId: string };
    };
    expect(out.seen.sort()).toEqual([p.torch.id, p.bag.id].sort());
    expect(out.notHere).toEqual([p.rope.id]);
    expect(out.movedIn).toEqual([stray.id]);
    expect(out.split).toHaveLength(1);
    const part = out.split[0]?.newId as string;
    expect(out.split[0]?.originalId).toBe(p.cables.id);

    // The found part stays and is seen; the missing one is a new row, not here, same purchase.
    expect(await rowOf(p.cables.id)).toMatchObject({
      quantity: '2.000',
      location_uncertain: false,
    });
    expect((await rowOf(p.cables.id)).last_seen_at?.getTime()).toBeGreaterThan(
      was.cables.last_seen_at?.getTime() ?? 0,
    );
    expect(await rowOf(part)).toMatchObject({
      quantity: '1.000',
      location_uncertain: true,
      purchase_line_id: p.line,
      container_id: p.box.id,
    });
    expect(await rowOf(p.rope.id)).toMatchObject({ location_uncertain: true });
    expect(await rowOf(stray.id)).toMatchObject({
      container_id: p.box.id,
      location_uncertain: false,
    });
    // A nested box is checked as a unit: what is in it keeps its last-seen date (D45).
    expect((await rowOf(p.inBag.id)).last_seen_at).toEqual(was.inBag.last_seen_at);

    // One box.check event, by Louis, undoable, with every line's thing as a subject.
    const events = await boxEvents(home.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity_id: p.box.id, actor_id: louis.userId });
    expect(events[0]?.undoable_until).not.toBeNull();
    expect(out.undo.eventId).toBe(events[0]?.id);
    expect(res.headers[AUDIT_EVENT_HEADER]).toBe(events[0]?.id);
    const subjects = (await subjectsOf(events[0]?.id as string)).map((s) => s.thing_id);
    for (const id of [p.box.id, p.torch.id, p.rope.id, p.cables.id, p.bag.id, stray.id, part]) {
      expect(subjects).toContain(id);
    }
    // It is stored, and listed on the box.
    const lines = await own<{ n: number }>(
      db,
      'SELECT count(*)::int AS n FROM public.box_check_lines WHERE box_check_id = $1',
      [out.boxCheckId],
    );
    expect(lines[0]?.n).toBe(5);
    const listed = ok(await call(t, `/api/v1/things/${p.box.id}/box-checks`, { as: talia }));
    expect(listed.items).toEqual([
      {
        id: out.boxCheckId,
        at: expect.any(String),
        by: { displayName: expect.any(String) },
        seen: 2,
        notHere: 1,
        split: 1,
        movedIn: 1,
      },
    ]);

    // Undo puts it all back: flags, quantity, the split-off row trashed, the tape moved out.
    ok(await call(t, `/api/v1/audit/${out.undo.eventId}/undo`, { as: louis, body: {} }));
    expect(await rowOf(p.cables.id)).toMatchObject({
      quantity: '3.000',
      last_seen_at: was.cables.last_seen_at,
    });
    expect((await rowOf(part)).deleted_at).not.toBeNull();
    expect(await rowOf(p.rope.id)).toMatchObject({ location_uncertain: false });
    expect(await rowOf(stray.id)).toMatchObject({ container_id: null });
    expect((await rowOf(p.torch.id)).last_seen_at).toEqual(was.torch.last_seen_at);
  });

  it("refuses an undo once something changed since, and refuses lines that aren't in the box", async () => {
    const p = await packedBox(home, ibrahim);
    const out = ok(
      await check(ibrahim, p.box.id, {
        lines: [{ thingId: p.rope.id, expectedQty: '1', foundQty: '0' }],
      }),
    ) as Json & { undo: { eventId: string } };
    await call(t, `/api/v1/things/${p.rope.id}/seen`, { as: louis, body: {} });
    const undo = await call(t, `/api/v1/audit/${out.undo.eventId}/undo`, { as: ibrahim, body: {} });
    expect(undo.statusCode).toBe(409);
    const elsewhere = await createThing(t, ibrahim, home, { name: 'Loose' });
    const bad = await check(ibrahim, p.box.id, {
      lines: [{ thingId: elsewhere.id, expectedQty: '1', foundQty: '1' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (
        await check(ibrahim, p.box.id, {
          lines: [
            { thingId: p.rope.id, expectedQty: '1', foundQty: '1' },
            { thingId: p.rope.id, expectedQty: '1', foundQty: '0' },
          ],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses a viewer with 403, and answers another household exactly as nothing', async () => {
    const p = await packedBox(home, ibrahim);
    const line = { thingId: p.torch.id, expectedQty: '1', foundQty: '1' };
    expect((await check(talia, p.box.id, { lines: [line] })).statusCode).toBe(403);
    expect(await boxEvents(home.id)).toHaveLength(2);

    // Leak: Bruce's box, his thing as a line or as found elsewhere, and his box's checks.
    const theirs = await packedBox(garage, bruce);
    const random = newId();
    expect(answer(await check(ibrahim, theirs.box.id, { lines: [line] }))).toEqual(
      answer(await check(ibrahim, random, { lines: [line] })),
    );
    expect(
      answer(
        await check(ibrahim, p.box.id, {
          lines: [{ thingId: theirs.torch.id, expectedQty: '1', foundQty: '1' }],
        }),
      ),
    ).toEqual(
      answer(
        await check(ibrahim, p.box.id, {
          lines: [{ thingId: newId(), expectedQty: '1', foundQty: '1' }],
        }),
      ),
    );
    expect(
      answer(await check(ibrahim, p.box.id, { lines: [], foundElsewhereIds: [theirs.torch.id] })),
    ).toEqual(answer(await check(ibrahim, p.box.id, { lines: [], foundElsewhereIds: [newId()] })));
    expect(
      answer(await call(t, `/api/v1/things/${theirs.box.id}/box-checks`, { as: ibrahim })),
    ).toEqual(answer(await call(t, `/api/v1/things/${random}/box-checks`, { as: ibrahim })));
    expect(await rowOf(theirs.torch.id)).toMatchObject({ container_id: theirs.box.id });
  });
});
