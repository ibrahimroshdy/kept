import { newId, randomShortCode } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, freshIp, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { forgetFormerHostnames } from './former-hosts.js';

// T16: label batches, blank sheets, "Printed OK?", claims and former hostnames, through the front
// door in the web contract's shapes (apps/web/src/api/capture/types.ts "labels (T16)").

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household: his own Garage, nothing of Home's
let home: Loc;
let garage: Loc;
let shelf: string;

type Batch = {
  id: string;
  locationId: string;
  kind: string;
  stock: string;
  startCell: number;
  printedConfirmedAt: string | null;
  labels: {
    code: string;
    url: string;
    kind: string;
    name?: string;
    path?: string;
    targetId?: string;
  }[];
};

const batch = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/labels/batches', { as, body: { stock: 'a4_24_70x37', ...body } });
const printed = (as: Person, id: string) =>
  call(t, `/api/v1/labels/batches/${id}/printed`, { as, body: {} });
const claim = (as: Person, code: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/codes/${code}/claim`, { as, body });

/** The status and body a request answered with, for the equal-answers checks. */
const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.body });

const auditActions = async (locationId: string, action: string) =>
  own<{ id: string; entity_id: string | null; actor_id: string | null; diff: unknown }>(
    db,
    `SELECT id, entity_id, actor_id, diff FROM public.audit_events
      WHERE location_id = $1 AND action = $2 ORDER BY at, id`,
    [locationId, action],
  );

async function blanks(loc: Loc, n: number): Promise<string[]> {
  const codes = Array.from({ length: n }, () => randomShortCode());
  await own(
    db,
    `INSERT INTO public.short_ids (code, location_id, state, is_primary)
     SELECT c, $2, 'blank', false FROM unnest($1::text[]) c`,
    [codes, loc.id],
  );
  return codes;
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
  shelf = await place(db, home, 'Shelf A');
});

afterAll(async () => {
  await t.app.close();
});

describe('POST /api/v1/labels/batches', () => {
  // catalogue: POST /api/v1/labels/batches
  it('labels listed things with their codes, links, names and paths, audited', async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill', placeId: shelf });
    const cables = await createThing(t, ibrahim, home, { name: 'HDMI cable', quantity: 6 });
    const theirs = await createThing(t, bruce, garage, { name: 'Crate' });
    const res = await batch(louis, {
      locationId: home.id,
      kind: 'things',
      thingIds: [drill.id, cables.id, drill.id, newId(), theirs.id],
      startCell: 5,
    });
    const out = ok(res, 201) as unknown as { batch: Batch; excluded: Json };
    // A quantity row has one label (D137); an unknown id and another household's alike are
    // "pending" (an offline capture looks the same).
    expect(out.excluded).toEqual({ pending: 2, other: 0 });
    expect(out.batch).toMatchObject({ locationId: home.id, kind: 'things', startCell: 5 });
    expect(out.batch.labels).toEqual([
      {
        code: drill.shortCode,
        url: `${t.publicUrl}/l/${drill.shortCode}`,
        kind: 'thing',
        name: 'Drill',
        path: expect.stringContaining('Shelf A'),
        targetId: drill.id,
      },
      expect.objectContaining({ code: cables.shortCode, name: 'HDMI cable', targetId: cables.id }),
    ]);
    const events = await auditActions(home.id, 'label_batch.create');
    expect(events.map((e) => [e.entity_id, e.actor_id])).toEqual([[out.batch.id, louis.userId]]);
    // A reprint is the same codes (D45).
    const again = ok(await call(t, `/api/v1/labels/batches/${out.batch.id}`, { as: talia }));
    expect((again as unknown as Batch).labels.map((l) => l.code)).toEqual([
      drill.shortCode,
      cables.shortCode,
    ]);
  });

  it('refuses a viewer (403), an outsider (404), a bad start cell, and a batch of nothing', async () => {
    const thing = await createThing(t, ibrahim, home, { name: 'Lamp' });
    const body = { locationId: home.id, kind: 'things', thingIds: [thing.id] };
    expect((await batch(talia, body)).statusCode).toBe(403);
    expect((await batch(bruce, body)).statusCode).toBe(404);
    expect((await batch(ibrahim, { ...body, startCell: 25 })).statusCode).toBe(400);
    expect(
      (await batch(ibrahim, { ...body, stock: 'thermal_50x30', startCell: 2 })).statusCode,
    ).toBe(400);
    const none = await batch(ibrahim, { ...body, thingIds: [newId()] });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ excluded: { pending: 1, other: 0 } });
  });

  it('"unprinted" leaves out what was printed and what is elsewhere, and keeps contents', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Cottage');
    const room = await place(db, loc, 'Attic');
    const other = await place(db, loc, 'Porch');
    const box = await createThing(t, ibrahim, loc, {
      name: 'Box 3',
      placeId: room,
      typeId: await builtinType(db, 'box_bin'),
    });
    const inBox = await createThing(t, ibrahim, loc, { name: 'Torch', containerId: box.id });
    const done = await createThing(t, ibrahim, loc, { name: 'Fan', placeId: room });
    const porch = await createThing(t, ibrahim, loc, { name: 'Broom', placeId: other });
    const first = ok(
      await batch(ibrahim, { locationId: loc.id, kind: 'things', thingIds: [done.id] }),
      201,
    ) as unknown as { batch: Batch };
    ok(await printed(ibrahim, first.batch.id));

    const res = ok(
      await batch(ibrahim, { locationId: loc.id, kind: 'things', unprinted: { placeId: room } }),
      201,
    ) as unknown as { batch: Batch; excluded: Json };
    expect(res.batch.labels.map((l) => l.targetId).sort()).toEqual([box.id, inBox.id].sort());
    const all = ok(
      await batch(ibrahim, { locationId: loc.id, kind: 'things', unprinted: {} }),
      201,
    ) as unknown as { batch: Batch };
    expect(all.batch.labels.map((l) => l.targetId).sort()).toEqual(
      [box.id, inBox.id, porch.id].sort(),
    );
    const summary = ok(
      await call(t, `/api/v1/labels/summary?locationId=${loc.id}`, { as: ibrahim }),
    );
    expect(summary).toEqual({ unprinted: 3, blankUnclaimed: 0 });
  });

  it('makes blank sheets under the 1,000-unclaimed cap: the 1,001st is 409 blank_cap_reached', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Store');
    for (let i = 0; i < 2; i++) {
      const out = ok(
        await batch(ibrahim, { locationId: loc.id, kind: 'blank', blankCount: 500 }),
        201,
      ) as unknown as { batch: Batch };
      expect(out.batch.labels).toHaveLength(500);
      expect(out.batch.labels[0]).toEqual({
        code: expect.stringMatching(/^[0-9A-Z]{6}$/),
        url: expect.stringContaining('/l/'),
        kind: 'blank',
      });
    }
    const over = await batch(ibrahim, { locationId: loc.id, kind: 'blank', blankCount: 1 });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: 'blank_cap_reached' });
    const summary = ok(
      await call(t, `/api/v1/labels/summary?locationId=${loc.id}`, { as: ibrahim }),
    );
    expect(summary).toMatchObject({ blankUnclaimed: 1000 });
  }, 60_000);

  it('is 409 module_off for writes where labels are off, and 404 for reads', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Shed');
    const thing = await createThing(t, ibrahim, loc, { name: 'Rake' });
    const made = ok(
      await batch(ibrahim, { locationId: loc.id, kind: 'things', thingIds: [thing.id] }),
      201,
    ) as unknown as { batch: Batch };
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, 'labels', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
      [loc.id],
    );
    const off = await batch(ibrahim, { locationId: loc.id, kind: 'things', thingIds: [thing.id] });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ code: 'module_off' });
    expect((await printed(ibrahim, made.batch.id)).statusCode).toBe(409);
    const read = await call(t, `/api/v1/labels/batches/${made.batch.id}`, { as: ibrahim });
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'module_off' });
    const summary = await call(t, `/api/v1/labels/summary?locationId=${loc.id}`, { as: ibrahim });
    expect(summary.statusCode).toBe(404);
  });
});

describe('a dry run (the T28 preview)', () => {
  it('answers the labels, with paths, and saves and allocates nothing', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Flat');
    const room = await place(db, loc, 'Kitchen');
    const cupboard = await place(db, loc, 'Cupboard', room);
    const placeCode = randomShortCode();
    await own(
      db,
      'INSERT INTO public.short_ids (code, location_id, place_id) VALUES ($1, $2, $3)',
      [placeCode, loc.id, cupboard],
    );
    const box = await createThing(t, ibrahim, loc, {
      name: 'Spice box',
      placeId: cupboard,
      typeId: await builtinType(db, 'box_bin'),
    });
    const jar = await createThing(t, ibrahim, loc, { name: 'Cumin', containerId: box.id });
    const batches = async () =>
      (
        await own<{ n: number }>(
          db,
          'SELECT count(*)::int AS n FROM public.label_batches WHERE location_id = $1',
          [loc.id],
        )
      )[0]?.n;

    const things = await batch(ibrahim, {
      locationId: loc.id,
      kind: 'things',
      thingIds: [jar.id, newId()],
      dryRun: true,
    });
    expect(things.statusCode).toBe(200);
    expect(things.json()).toEqual({
      labels: [
        {
          code: jar.shortCode,
          url: `${t.publicUrl}/l/${jar.shortCode}`,
          kind: 'thing',
          name: 'Cumin',
          path: 'Kitchen › Cupboard › Spice box',
          targetId: jar.id,
        },
      ],
      blank: 0,
      excluded: { pending: 1, other: 0 },
    });
    const places = ok(
      await batch(ibrahim, {
        locationId: loc.id,
        kind: 'places',
        placeIds: [cupboard],
        dryRun: true,
      }),
    );
    expect(places.labels).toEqual([
      expect.objectContaining({
        code: placeCode,
        kind: 'place',
        name: 'Cupboard',
        path: 'Kitchen',
      }),
    ]);
    const blank = ok(
      await batch(ibrahim, { locationId: loc.id, kind: 'blank', blankCount: 30, dryRun: true }),
    );
    expect(blank).toEqual({ labels: [], blank: 30, excluded: { pending: 0, other: 0 } });
    expect(await batches()).toBe(0);
    const blanks = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.short_ids WHERE location_id = $1 AND state = 'blank'`,
      [loc.id],
    );
    expect(blanks[0]?.n).toBe(0);
    // Its errors are a real create's.
    expect(
      (await batch(talia, { locationId: home.id, kind: 'blank', blankCount: 1, dryRun: true }))
        .statusCode,
    ).toBe(403);
    expect(
      (await batch(ibrahim, { locationId: loc.id, kind: 'blank', blankCount: 501, dryRun: true }))
        .statusCode,
    ).toBe(400);
  });
});

describe('POST /api/v1/labels/batches/:id/printed', () => {
  // catalogue: POST /api/v1/labels/batches/:id/printed
  it('confirms once: the codes keep their first printed time, and one event is written', async () => {
    const thing = await createThing(t, ibrahim, home, { name: 'Kettle' });
    const made = ok(
      await batch(ibrahim, { locationId: home.id, kind: 'things', thingIds: [thing.id] }),
      201,
    ) as unknown as { batch: Batch };
    const first = ok(await printed(louis, made.batch.id)) as unknown as Batch;
    expect(first.printedConfirmedAt).not.toBeNull();
    const at = await own<{ printed_at: Date }>(
      db,
      'SELECT printed_at FROM public.short_ids WHERE code = $1',
      [thing.shortCode],
    );
    const second = ok(await printed(ibrahim, made.batch.id)) as unknown as Batch;
    expect(second.printedConfirmedAt).toBe(first.printedConfirmedAt);
    const at2 = await own<{ printed_at: Date }>(
      db,
      'SELECT printed_at FROM public.short_ids WHERE code = $1',
      [thing.shortCode],
    );
    expect(at2[0]?.printed_at.getTime()).toBe(at[0]?.printed_at.getTime());
    const events = await auditActions(home.id, 'labels.printed');
    expect(events.filter((e) => e.entity_id === made.batch.id)).toHaveLength(1);
    // A viewer may look, not confirm.
    expect((await printed(talia, made.batch.id)).statusCode).toBe(403);
  });

  it('lists recent batches, newest first, one page at a time', async () => {
    const page = ok(
      await call(t, `/api/v1/labels/batches?locationId=${home.id}&limit=1`, { as: ibrahim }),
    ) as unknown as { items: Batch[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    const next = ok(
      await call(
        t,
        `/api/v1/labels/batches?locationId=${home.id}&limit=1&cursor=${page.next_cursor}`,
        { as: ibrahim },
      ),
    ) as unknown as { items: Batch[] };
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    const theirs = ok(await call(t, '/api/v1/labels/batches', { as: bruce })) as unknown as {
      items: Batch[];
    };
    expect(theirs.items.some((b) => b.locationId === home.id)).toBe(false);
  });
});

describe('POST /api/v1/codes/:code/claim', () => {
  // catalogue: POST /api/v1/codes/:code/claim
  it('claims a blank once; a second claim is 409 label_claimed with the name', async () => {
    const [code] = (await blanks(home, 1)) as [string];
    const drill = await createThing(t, ibrahim, home, { name: 'Bosch drill' });
    const out = ok(await claim(louis, code, { thingId: drill.id }));
    expect(out).toEqual({ outcome: 'claimed', target: { kind: 'thing', id: drill.id } });
    const events = await auditActions(home.id, 'label.claim');
    expect(events.at(-1)).toMatchObject({ entity_id: drill.id, actor_id: louis.userId });
    const other = await createThing(t, ibrahim, home, { name: 'Ladder' });
    const again = await claim(ibrahim, code, { thingId: other.id });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: 'label_claimed',
      claimedFor: { kind: 'thing', id: drill.id, name: 'Bosch drill' },
    });
    // The label is now a (secondary) code of the drill, and counts as printed.
    const rows = await own<{ thing_id: string; is_primary: boolean; printed: boolean }>(
      db,
      'SELECT thing_id, is_primary, printed_at IS NOT NULL AS printed FROM public.short_ids WHERE code = $1',
      [code],
    );
    expect(rows).toEqual([{ thing_id: drill.id, is_primary: false, printed: true }]);
  });

  it('makes a new box for a blank (D43), with the label as its code', async () => {
    const [code] = (await blanks(home, 1)) as [string];
    const id = newId();
    const out = ok(
      await claim(louis, code.toLowerCase(), {
        newContainer: { id, name: 'Camping box', placeId: shelf },
      }),
    );
    expect(out).toEqual({ outcome: 'claimed', target: { kind: 'thing', id } });
    const view = ok(await call(t, `/api/v1/things/${id}`, { as: louis }));
    expect(view).toMatchObject({ name: 'Camping box', shortCode: code, isContainer: true });
    // Claimed first elsewhere: nothing is made.
    const lost = newId();
    const res = await claim(ibrahim, code, {
      newContainer: { id: lost, name: 'Other box', placeId: shelf },
    });
    expect(res.statusCode).toBe(409);
    expect(await own(db, 'SELECT 1 FROM public.things WHERE id = $1', [lost])).toEqual([]);
  });

  it("answers another household's blank, a retired code, a random one and a viewer's claim alike", async () => {
    const [theirs] = (await blanks(garage, 1)) as [string];
    const [mine] = (await blanks(home, 1)) as [string];
    const retired = randomShortCode();
    await own(
      db,
      `INSERT INTO public.short_ids (code, location_id, state, is_primary) VALUES ($1, $2, 'retired', false)`,
      [retired, home.id],
    );
    const drill = await createThing(t, ibrahim, home, { name: 'Saw' });
    const body = { thingId: drill.id };
    const random = answer(await claim(ibrahim, randomShortCode(), body));
    expect(random.status).toBe(404);
    expect(answer(await claim(ibrahim, theirs, body))).toEqual(random);
    expect(answer(await claim(ibrahim, retired, body))).toEqual(random);
    expect(answer(await claim(ibrahim, 'not-a-code', body))).toEqual(random);
    expect(answer(await claim(talia, mine, body))).toEqual(random);
    // B's blank claimed for B's own thing through A's door: still nothing.
    const crate = await createThing(t, bruce, garage, { name: 'Crate' });
    expect(answer(await claim(ibrahim, theirs, { thingId: crate.id }))).toEqual(random);
    expect(await own(db, `SELECT state FROM public.short_ids WHERE code = $1`, [theirs])).toEqual([
      { state: 'blank' },
    ]);
  });
});

describe('a capture into a scanned blank (T13 claimCode)', () => {
  const capture = (as: Person, body: Record<string, unknown>) =>
    call(t, '/api/v1/captures', { as, body, headers: { 'idempotency-key': newId() } });
  const captureBody = (over: Record<string, unknown>) => ({
    id: newId(),
    locationId: home.id,
    target: { placeId: shelf },
    mode: 'thing',
    batchId: newId(),
    files: [],
    ...over,
  });

  it('claims the code for the new thing, whose code it becomes', async () => {
    const [code] = (await blanks(home, 1)) as [string];
    const out = ok(await capture(louis, captureBody({ name: 'Tent', claimCode: code })), 201) as {
      thing: Json;
    } & Json;
    expect(out.thing).toMatchObject({ name: 'Tent', shortCode: code });
  });

  it('keeps the capture when the label was claimed elsewhere, with a label_claim item', async () => {
    const [code] = (await blanks(home, 1)) as [string];
    const first = captureBody({ name: 'Box 1', claimCode: code });
    ok(await capture(louis, first), 201);
    const second = captureBody({ name: 'Box 2', claimCode: code });
    const out = ok(await capture(ibrahim, second), 201) as unknown as {
      thing: Json;
      inboxItemId: string;
    };
    expect(out.thing.shortCode).not.toBe(code);
    const items = await own<{ kind: string; code: string; payload: Json }>(
      db,
      'SELECT kind, code, payload FROM public.inbox_items WHERE id = $1',
      [out.inboxItemId],
    );
    expect(items).toEqual([
      {
        kind: 'label_claim',
        code,
        payload: { claimedFor: { kind: 'thing', id: first.id, name: 'Box 1' } },
      },
    ]);
  });

  it("makes the capture, and says nothing, for another household's blank or a random code", async () => {
    const [theirs] = (await blanks(garage, 1)) as [string];
    for (const code of [theirs, randomShortCode()]) {
      const out = ok(
        await capture(louis, captureBody({ name: 'Mat', claimCode: code })),
        201,
      ) as unknown as {
        thing: Json;
        inboxItemId?: string;
      };
      expect(out.thing.shortCode).not.toBe(code);
      expect(out.inboxItemId).toBeUndefined();
    }
    expect(await own(db, `SELECT state FROM public.short_ids WHERE code = $1`, [theirs])).toEqual([
      { state: 'blank' },
    ]);
  });
});

describe('former hostnames (D120, Q32)', () => {
  it('redirects GET and HEAD from a former hostname, and refuses anything else with 421', async () => {
    await own(
      db,
      `INSERT INTO public.instance_settings (key, value) VALUES ('former_hostnames', '["kept.old.example"]'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    forgetFormerHostnames();
    const get = await t.app.inject({
      method: 'GET',
      url: '/l/ABC234?x=1',
      headers: { host: 'kept.old.example' },
      remoteAddress: freshIp(),
    });
    expect(get.statusCode).toBe(301);
    expect(get.headers.location).toBe(`${t.publicUrl}/l/ABC234?x=1`);
    const head = await t.app.inject({
      method: 'HEAD',
      url: '/api/v1/health',
      headers: { host: 'KEPT.old.example:8080' },
      remoteAddress: freshIp(),
    });
    expect(head.statusCode).toBe(301);
    const post = await t.app.inject({
      method: 'POST',
      url: '/api/v1/labels/batches',
      headers: { host: 'kept.old.example', origin: t.publicUrl, cookie: ibrahim.cookie },
      payload: { locationId: home.id, kind: 'blank', blankCount: 1, stock: 'a4_24_70x37' },
      remoteAddress: freshIp(),
    });
    expect(post.statusCode).toBe(421);
    // Any other host is served as usual.
    const other = await t.app.inject({
      method: 'GET',
      url: '/api/v1/labels/summary',
      headers: { host: 'somewhere.example', cookie: ibrahim.cookie },
      remoteAddress: freshIp(),
    });
    expect(other.statusCode).toBe(200);
  });
});

describe('leak: the label routes answer another household exactly as nothing', () => {
  it("treats Bruce's batch, codes and things like random ids on every label route", async () => {
    const crate = await createThing(t, bruce, garage, { name: 'Crate' });
    const theirs = ok(
      await batch(bruce, { locationId: garage.id, kind: 'things', thingIds: [crate.id] }),
      201,
    ) as unknown as { batch: Batch };
    const [blank] = (await blanks(garage, 1)) as [string];
    const id = theirs.batch.id;
    for (const path of [`/api/v1/labels/batches/${id}`]) {
      expect(answer(await call(t, path, { as: ibrahim }))).toEqual(
        answer(await call(t, path.replace(id, newId()), { as: ibrahim })),
      );
    }
    expect(answer(await printed(ibrahim, id))).toEqual(answer(await printed(ibrahim, newId())));
    expect(
      answer(await batch(ibrahim, { locationId: garage.id, kind: 'blank', blankCount: 1 })),
    ).toEqual(answer(await batch(ibrahim, { locationId: newId(), kind: 'blank', blankCount: 1 })));
    for (const q of [`?locationId=${garage.id}`]) {
      expect(answer(await call(t, `/api/v1/labels/summary${q}`, { as: ibrahim }))).toEqual(
        answer(await call(t, `/api/v1/labels/summary?locationId=${newId()}`, { as: ibrahim })),
      );
      expect(answer(await call(t, `/api/v1/labels/batches${q}`, { as: ibrahim }))).toEqual(
        answer(await call(t, `/api/v1/labels/batches?locationId=${newId()}`, { as: ibrahim })),
      );
    }
    const random = randomShortCode();
    expect(answer(await claim(ibrahim, blank, { placeId: shelf }))).toEqual(
      answer(await claim(ibrahim, random, { placeId: shelf })),
    );
    expect(
      answer(
        await claim(ibrahim, blank, { newContainer: { id: newId(), name: 'X', placeId: shelf } }),
      ),
    ).toEqual(
      answer(
        await claim(ibrahim, random, { newContainer: { id: newId(), name: 'X', placeId: shelf } }),
      ),
    );
    // Nothing of his is in Home's lists or summary.
    const summary = ok(await call(t, '/api/v1/labels/summary', { as: ibrahim }));
    const mineOnly = ok(
      await call(t, `/api/v1/labels/summary?locationId=${home.id}`, { as: ibrahim }),
    );
    expect(summary.blankUnclaimed).toBeGreaterThanOrEqual(mineOnly.blankUnclaimed as number);
    const listed = ok(await call(t, '/api/v1/labels/batches?limit=200', { as: ibrahim }));
    expect((listed.items as Json[]).some((b) => b.id === id)).toBe(false);
  });
});
