import { randomBytes } from 'node:crypto';
import { newId } from '@kept/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
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

// Moves (T15; D45, D118, D161, D177; plan Q13) through the front door, as the web calls them
// (apps/web/src/api/inventory/{types,paths}.ts, mock/things.ts): fixtures seeded as kept_owner,
// every request as a signed-in user on kept_app, so row-level security and can() decide.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ann: Person; // owner of home and garage (one account)
let ada: Person; // admin of home
let mo: Person; // member of home and garage
let vic: Person; // viewer of home
let bob: Person; // outsider
let zed: Person; // owner of flat, another account; ann is a member there
let home: Loc;
let garage: Loc;
let flat: Loc;
let studio: Loc; // ann's too; for role cases that mustn't change who sees home

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ann = await person(t, db, 'ann');
  ada = await person(t, db, 'ada');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  zed = await person(t, db, 'zed');
  for (const [p, name] of [
    [ann, 'Ann'],
    [ada, 'Ada'],
    [mo, 'Alfred'],
    [vic, 'Vic'],
    [zed, 'Zed'],
  ] as const) {
    await setDisplayName(db, p, name);
  }
  home = await createLocation(t, db, ann, 'complete', 'Home');
  garage = await createLocation(t, db, ann, 'complete', 'Garage');
  flat = await createLocation(t, db, zed, 'complete', 'Flat');
  studio = await createLocation(t, db, ann, 'complete', 'Studio');
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  await join(db, garage.id, mo.userId, 'member');
  await join(db, flat.id, ann.userId, 'member');
});

beforeEach(() => {
  sent.splice(0);
});

const move = (as: Person, body: object) => call(t, '/api/v1/things/move', { as, body });
const preview = (as: Person, body: object) => call(t, '/api/v1/things/move/preview', { as, body });

type Row = {
  location_id: string;
  place_id: string | null;
  container_id: string | null;
  last_seen_at: Date;
  location_uncertain: boolean;
  quantity: string;
  type_id: string | null;
};

async function row(id: string): Promise<Row> {
  const [r] = await own<Row>(
    db,
    `SELECT location_id, place_id, container_id, last_seen_at, location_uncertain,
            quantity::text AS quantity, type_id
       FROM public.things WHERE id = $1`,
    [id],
  );
  return r as Row;
}

async function box(loc: Loc, name: string, where: object = {}): Promise<Json> {
  return createThing(t, ann, loc, { name, typeId: await builtinType(db, 'box_bin'), ...where });
}

async function subjectsOf(eventId: string): Promise<string[]> {
  const rows = await own<{ thing_id: string }>(
    db,
    'SELECT thing_id FROM public.audit_event_subjects WHERE event_id = $1 ORDER BY thing_id',
    [eventId],
  );
  return rows.map((r) => r.thing_id);
}

const lastAudit = async (locationId: string, entityId: string) =>
  (await eventsOf(db, locationId, entityId)).at(-1);

/** Every audit row a location got from one request's actor, of one action. */
const auditOf = (locationId: string, action: string) =>
  own<{ id: string; entity_id: string; diff: Record<string, Record<string, unknown>> }>(
    db,
    'SELECT id, entity_id, diff FROM public.audit_events WHERE location_id = $1 AND action = $2 ORDER BY at, id',
    [locationId, action],
  );

describe('POST /api/v1/things/move within a location', () => {
  // catalogue: POST /api/v1/things/move
  it('moves into a place and into a container: seen now, no longer "not here", one audit row each', async () => {
    const kitchen = await place(db, home, 'Kitchen');
    const shelf = await place(db, home, 'Shelf', kitchen);
    const crate = await box(home, 'Crate', { placeId: kitchen });
    const lamp = await createThing(t, mo, home, { name: 'Lamp' });
    await own(
      db,
      `UPDATE public.things SET location_uncertain = true, last_seen_at = now() - interval '9 days'
        WHERE id = $1`,
      [lamp.id],
    );

    const res = ok(await move(mo, { thingIds: [lamp.id], to: { placeId: shelf } }));
    expect(res).toEqual({ moved: [lamp.id] });
    const now = await row(lamp.id);
    expect(now).toMatchObject({ place_id: shelf, container_id: null, location_uncertain: false });
    expect(Date.now() - now.last_seen_at.getTime()).toBeLessThan(60_000);
    const audit = await lastAudit(home.id, lamp.id);
    expect(audit).toMatchObject({ action: 'thing.move', actor_id: mo.userId });
    expect(audit?.undoable_until).not.toBeNull();
    expect(audit?.diff).toEqual({
      place_id: { before: home.unplacedId, after: shelf, class: 'plain' },
      path: { before: [expect.any(String)], after: ['Kitchen', 'Shelf'], class: 'plain' },
    });
    expect(await subjectsOf(audit?.id as string)).toEqual([lamp.id]);

    ok(await move(mo, { thingIds: [lamp.id], to: { containerId: crate.id } }));
    expect(await row(lamp.id)).toMatchObject({ place_id: null, container_id: crate.id });
    expect((await lastAudit(home.id, lamp.id))?.diff).toMatchObject({
      place_id: { before: shelf, after: null },
      container_id: { before: null, after: crate.id },
      path: { after: ['Kitchen', 'Crate'] },
    });
  });

  // catalogue: POST /api/v1/things/move
  it('moves a container as one audit event whose subjects are its contents; their last-seen stays (D45)', async () => {
    const hall = await place(db, home, 'Hall');
    const attic = await place(db, home, 'Attic');
    const box3 = await box(home, 'Box 3', { placeId: hall });
    const pouch = await box(home, 'Pouch', { containerId: box3.id });
    const cable = await createThing(t, ann, home, { name: 'Cable', containerId: box3.id });
    const plug = await createThing(t, ann, home, { name: 'Plug', containerId: pouch.id });
    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    await own(db, 'UPDATE public.things SET last_seen_at = $2 WHERE id = ANY ($1::uuid[])', [
      [pouch.id, cable.id, plug.id],
      old,
    ]);
    const before = await eventsOf(db, home.id, cable.id);

    ok(await move(ann, { thingIds: [box3.id], to: { placeId: attic } }));
    expect(await row(box3.id)).toMatchObject({ place_id: attic });
    for (const id of [pouch.id, cable.id, plug.id]) {
      expect((await row(id)).last_seen_at.getTime()).toBe(old.getTime());
    }
    // One event, about the box; the contents get none of their own…
    const audit = await lastAudit(home.id, box3.id);
    expect(audit?.action).toBe('thing.move');
    expect(await eventsOf(db, home.id, cable.id)).toEqual(before);
    // …but their timelines reach it through the subjects ("moved with Box 3").
    expect(await subjectsOf(audit?.id as string)).toEqual(
      [box3.id, pouch.id, cable.id, plug.id].sort(),
    );
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
  });

  it("refreshes the contents' paths when a box moves within its location, before any reindex", async () => {
    const shelfA = await place(db, home, 'Shelf A');
    const shelfB = await place(db, home, 'Shelf B');
    const crate = await box(home, 'Box', { placeId: shelfA });
    const tray = await box(home, 'Tray', { containerId: crate.id });
    const torch = await createThing(t, ann, home, { name: 'Torch', containerId: crate.id });
    const fuse = await createThing(t, ann, home, { name: 'Fuse', containerId: tray.id });
    // The box written after its contents (the row order 0047 found across locations).
    await own(db, `UPDATE public.things SET notes = 'moved often' WHERE id = $1`, [crate.id]);
    const cacheOf = async (id: string) =>
      (
        await own<{ place_path: string; version: number }>(
          db,
          'SELECT place_path, row_version AS version FROM public.things WHERE id = $1',
          [id],
        )
      )[0];
    const versionBefore = (await cacheOf(torch.id))?.version;
    expect((await cacheOf(torch.id))?.place_path).toBe('Shelf A › Box');

    ok(await move(ann, { thingIds: [crate.id], to: { placeId: shelfB } }));
    // The reindex job is only recorded here, never run: this is the move's own doing.
    expect((await cacheOf(torch.id))?.place_path).toBe('Shelf B › Box');
    expect((await cacheOf(tray.id))?.place_path).toBe('Shelf B › Box');
    expect((await cacheOf(fuse.id))?.place_path).toBe('Shelf B › Box › Tray');
    // The search document's "where it is" follows; the row's version doesn't (a quiet cache).
    const found = await own<{ id: string }>(
      db,
      `SELECT id FROM public.things
        WHERE id = $1 AND search_tsv @@ to_tsquery('simple', 'shelf & b')`,
      [torch.id],
    );
    expect(found).toHaveLength(1);
    expect((await cacheOf(torch.id))?.version).toBe(versionBefore);
  });

  it('refuses moving something into itself or into something inside it (409)', async () => {
    const outer = await box(home, 'Outer');
    const inner = await box(home, 'Inner', { containerId: outer.id });
    for (const into of [outer.id, inner.id]) {
      const res = await move(ann, { thingIds: [outer.id], to: { containerId: into } });
      expect(res.statusCode).toBe(409);
      expect(res.json().hint).toMatch(/inside itself/);
    }
    expect(await row(outer.id)).toMatchObject({ place_id: home.unplacedId });
  });

  it('checks the target first (404), then each thing: 404 unseen, 403 read-only', async () => {
    const lamp = await createThing(t, ann, home, { name: 'Desk lamp' });
    const bobs = await createLocation(t, db, bob, 'essentials', 'Bob home');
    const bobsThing = await createThing(t, bob, bobs, { name: "Bob's" });
    // A target the caller can't see, and one they can only view: both 404.
    expect(
      (await move(ann, { thingIds: [lamp.id], to: { placeId: bobs.unplacedId } })).statusCode,
    ).toBe(404);
    expect(
      (await move(vic, { thingIds: [lamp.id], to: { placeId: home.unplacedId } })).statusCode,
    ).toBe(404);
    expect((await move(mo, { thingIds: [lamp.id], to: { placeId: newId() } })).statusCode).toBe(
      404,
    );
    // A thing the caller can't see is a 404; one they can only view a 403.
    expect(
      (await move(ann, { thingIds: [bobsThing.id], to: { placeId: home.unplacedId } })).statusCode,
    ).toBe(404);
    const val = await person(t, db, 'val');
    await join(db, studio.id, val.userId, 'viewer');
    await join(db, garage.id, val.userId, 'member');
    const easel = await createThing(t, ann, studio, { name: 'Easel' });
    const res = await move(val, { thingIds: [easel.id], to: { placeId: garage.unplacedId } });
    expect(res.statusCode).toBe(403);
    expect(await row(easel.id)).toMatchObject({ location_id: studio.id });
    expect(
      (await move(bob, { thingIds: [lamp.id], to: { placeId: bobs.unplacedId } })).statusCode,
    ).toBe(404);
  });

  it('takes 1–200 things; quantity only with one (400)', async () => {
    const lamp = await createThing(t, ann, home, { name: 'Floor lamp' });
    const to = { placeId: home.unplacedId };
    expect((await move(ann, { thingIds: [], to })).statusCode).toBe(400);
    const many = Array.from({ length: 201 }, () => newId());
    expect((await move(ann, { thingIds: many, to })).statusCode).toBe(400);
    const two = await move(ann, { thingIds: [lamp.id, lamp.id], to, quantity: 1 });
    expect(two.statusCode).toBe(200); // the same id twice is one thing
    const other = await createThing(t, ann, home, { name: 'Wall lamp' });
    const res = await move(ann, { thingIds: [lamp.id, other.id], to, quantity: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().hint).toMatch(/quantity/);
  });

  // catalogue: POST /api/v1/things/move
  it('moves part of a quantity by splitting it first (D10), and audits both', async () => {
    const pantry = await place(db, home, 'Pantry');
    const batteries = await createThing(t, ann, home, {
      name: 'AA batteries',
      typeId: await builtinType(db, 'batteries'),
      quantity: 8,
    });
    const res = ok(
      await move(ann, { thingIds: [batteries.id], to: { placeId: pantry }, quantity: 3 }),
    );
    const [part] = res.moved as string[];
    expect(part).not.toBe(batteries.id);
    expect(await row(batteries.id)).toMatchObject({ quantity: '5.000', place_id: home.unplacedId });
    expect(await row(part as string)).toMatchObject({ quantity: '3.000', place_id: pantry });
    expect((await lastAudit(home.id, batteries.id))?.action).toBe('thing.split');
    expect((await lastAudit(home.id, part as string))?.action).toBe('thing.move');

    // All of it moves as itself.
    const all = ok(
      await move(ann, { thingIds: [batteries.id], to: { placeId: pantry }, quantity: 5 }),
    );
    expect(all.moved).toEqual([batteries.id]);
    expect(await row(batteries.id)).toMatchObject({ quantity: '5.000', place_id: pantry });
  });

  // catalogue: POST /api/v1/things/move
  it('moves 200 things in one request, one audit row each, in under a second', async () => {
    const shed = await place(db, home, 'Big shed');
    const ids = Array.from({ length: 200 }, () => newId());
    await own(
      db,
      `INSERT INTO public.things (id, location_id, place_id, name)
       SELECT x, $2, $3, 'Screw ' || n FROM unnest($1::uuid[]) WITH ORDINALITY AS u(x, n)`,
      [ids, home.id, home.unplacedId],
    );
    const started = performance.now();
    const res = ok(await move(ann, { thingIds: ids, to: { placeId: shed } }));
    const took = performance.now() - started;
    expect(res.moved).toHaveLength(200);
    const audits = (await auditOf(home.id, 'thing.move')).filter((e) => ids.includes(e.entity_id));
    expect(audits).toHaveLength(200);
    expect(took).toBeLessThan(1000);
  });

  it('writes nothing for a thing already where it is sent', async () => {
    const lamp = await createThing(t, ann, home, { name: 'Night lamp' });
    const before = await eventsOf(db, home.id, lamp.id);
    ok(await move(ann, { thingIds: [lamp.id], to: { placeId: home.unplacedId } }));
    expect(await eventsOf(db, home.id, lamp.id)).toEqual(before);
  });
});

describe('POST /api/v1/things/move across locations (D45, D161)', () => {
  // catalogue: POST /api/v1/things/move
  it('moves a box with its contents to another location: audit rows in both, tombstones, dropped links audited', async () => {
    const bench = await place(db, garage, 'Bench');
    const kit = await box(home, 'Tool kit');
    const drill = await createThing(t, ann, home, { name: 'Drill', containerId: kit.id });
    const manual = await createThing(t, ann, home, { name: 'Drill manual' });
    const link = ok(
      await call(t, `/api/v1/things/${drill.id}/links`, {
        as: ann,
        body: { toThingId: manual.id, kind: 'accessory_of' },
      }),
      201,
    );

    ok(await move(ann, { thingIds: [kit.id], to: { placeId: bench } }));
    expect(await row(kit.id)).toMatchObject({ location_id: garage.id, place_id: bench });
    expect(await row(drill.id)).toMatchObject({ location_id: garage.id, container_id: kit.id });

    // The same event in both locations, with the location change in its diff.
    for (const loc of [garage.id, home.id]) {
      const audit = await lastAudit(loc, kit.id);
      expect(audit?.action).toBe('thing.move');
      expect(audit?.diff).toMatchObject({
        location_id: { before: home.id, after: garage.id },
        place_id: { before: home.unplacedId, after: bench },
        path: { after: ['Bench'] },
      });
      expect(await subjectsOf(audit?.id as string)).toEqual([kit.id, drill.id].sort());
    }
    // Sync (§7.4): gone from home, box and contents.
    const tombs = await own<{ entity_id: string }>(
      db,
      `SELECT entity_id FROM public.sync_tombstones
        WHERE location_id = $1 AND entity_type = 'thing' AND entity_id = ANY ($2::uuid[])`,
      [home.id, [kit.id, drill.id]],
    );
    expect(tombs.map((x) => x.entity_id).sort()).toEqual([kit.id, drill.id].sort());
    // The drill's link to the manual left behind would cross locations: dropped, and audited.
    expect(await own(db, 'SELECT 1 FROM public.thing_links WHERE id = $1', [link.id])).toEqual([]);
    const unlink = await lastAudit(home.id, link.id);
    expect(unlink).toMatchObject({ action: 'thing.unlink', actor_id: ann.userId });
    expect(unlink?.diff).toMatchObject({
      from_thing_id: { before: drill.id, after: null },
      to_thing_id: { before: manual.id, after: null },
    });
    // Both locations reindex.
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: garage.id } });
  });

  it('needs write access to the target location (404 for a viewer there)', async () => {
    const aba = await person(t, db, 'aba');
    await join(db, studio.id, aba.userId, 'admin');
    await join(db, garage.id, aba.userId, 'viewer');
    const lamp = await createThing(t, ann, studio, { name: 'Studio lamp' });
    const res = await move(aba, { thingIds: [lamp.id], to: { placeId: garage.unplacedId } });
    expect(res.statusCode).toBe(404);
    expect(await row(lamp.id)).toMatchObject({ location_id: studio.id });
  });

  it('refuses a code the target location already has (409 naming the code and its holder, D208)', async () => {
    const addCode = (id: string, code: string) =>
      call(t, `/api/v1/things/${id}/codes`, { as: ann, body: { code } });
    const crate = await box(home, 'Code crate');
    const clamp = await createThing(t, ann, home, { name: 'Clamp', containerId: crate.id });
    const spanner = await createThing(t, ann, garage, { name: 'Spanner' });
    ok(await addCode(clamp.id, 'SHED-7'), 201);
    ok(await addCode(spanner.id, 'SHED-7'), 201);
    const to = { placeId: garage.unplacedId };

    // Something inside the box carries it: the whole move is refused, preview first.
    for (const res of [
      await preview(mo, { thingIds: [crate.id], to }),
      await move(mo, { thingIds: [crate.id], to }),
    ]) {
      expect(res.statusCode, res.body).toBe(409);
      const body = res.json();
      expect(body.code).toBe('conflict');
      expect(body.hint).toBe(
        'Garage already has the code SHED-7, on Spanner. Change or remove it on one of them, then move again.',
      );
      expect(body).toMatchObject({
        ownCode: 'SHED-7',
        taken: { kind: 'thing', id: spanner.id, name: 'Spanner' },
        location: { id: garage.id, name: 'Garage' },
      });
    }
    expect(await row(crate.id)).toMatchObject({ location_id: home.id });
    expect(await row(clamp.id)).toMatchObject({ location_id: home.id });

    // Whatever the code's source there (an import's legacy code counts too, §7.16).
    const removed = await call(t, `/api/v1/things/${spanner.id}/codes/SHED-7`, {
      as: ann,
      method: 'DELETE',
    });
    expect(removed.statusCode, removed.body).toBe(204);
    await own(
      db,
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
       VALUES ($1, 'csv', '', 'SHED-7', $2)`,
      [garage.id, spanner.id],
    );
    expect((await move(mo, { thingIds: [crate.id], to })).statusCode).toBe(409);

    // Once the code is free there, the box moves with it.
    await own(db, `DELETE FROM public.legacy_codes WHERE location_id = $1 AND code = 'SHED-7'`, [
      garage.id,
    ]);
    ok(await move(mo, { thingIds: [crate.id], to }));
    const [moved] = await own<{ location_id: string }>(
      db,
      `SELECT location_id FROM public.legacy_codes WHERE thing_id = $1 AND code = 'SHED-7'`,
      [clamp.id],
    );
    expect(moved?.location_id).toBe(garage.id);
  });

  it('refuses a thing with secrets its mover may not carry elsewhere (403 with a hint, not 404)', async () => {
    const router = await createThing(t, ann, home, {
      name: 'Router',
      typeId: await builtinType(db, 'network_device'),
    });
    const [field] = await own<{ id: string }>(
      db,
      `SELECT f.id FROM public.type_fields f JOIN public.types ty ON ty.id = f.type_id
        WHERE ty.owner_account_id IS NULL AND ty.builtin_key = 'network_device'
          AND f.key = 'wifi_password'`,
    );
    await own(
      db,
      `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                         key_version, updated_by)
       VALUES ($1, $2, $3, 'wifi_password', '{"c": "x"}', 1, $4)`,
      [home.id, router.id, field?.id, ann.userId],
    );
    const to = { placeId: garage.unplacedId };
    const refused = await move(mo, { thingIds: [router.id], to });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().hint).toMatch(/owner can move something with secret fields/);
    // The preview says so too, before the user confirms.
    expect((await preview(mo, { thingIds: [router.id], to })).statusCode).toBe(403);
    expect(await row(router.id)).toMatchObject({ location_id: home.id });
    // The home's owner may.
    ok(await move(ann, { thingIds: [router.id], to }));
    expect(await row(router.id)).toMatchObject({ location_id: garage.id });
  });

  it('is undone through the audit event: back in the old location (D150)', async () => {
    const shelf = await place(db, home, 'Book shelf');
    const book = await createThing(t, ann, home, { name: 'Atlas', placeId: shelf });
    ok(await move(ann, { thingIds: [book.id], to: { placeId: garage.unplacedId } }));
    const event = await lastAudit(garage.id, book.id);
    const res = ok(await call(t, `/api/v1/audit/${event?.id}/undo`, { as: ann, body: {} }));
    expect(res.undoOf).toBe(event?.id);
    expect(await row(book.id)).toMatchObject({ location_id: home.id, place_id: shelf });
    expect(await lastAudit(garage.id, book.id)).toMatchObject({
      action: 'thing.move',
      undo_of: event?.id,
    });
  });

  it('is undone within a location too, and refuses once it moved again (D124)', async () => {
    const a = await place(db, home, 'Drawer A');
    const b = await place(db, home, 'Drawer B');
    const pen = await createThing(t, ann, home, { name: 'Pen', placeId: a });
    ok(await move(mo, { thingIds: [pen.id], to: { placeId: b } }));
    const first = await lastAudit(home.id, pen.id);
    ok(await call(t, `/api/v1/audit/${first?.id}/undo`, { as: mo, body: {} }));
    expect(await row(pen.id)).toMatchObject({ place_id: a });

    ok(await move(mo, { thingIds: [pen.id], to: { placeId: b } }));
    const second = await lastAudit(home.id, pen.id);
    ok(await move(ann, { thingIds: [pen.id], to: { placeId: home.unplacedId } }));
    const late = await call(t, `/api/v1/audit/${second?.id}/undo`, { as: mo, body: {} });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ changedBy: { displayName: 'Ann' } });
  });
});

describe('moving across owner accounts (Q13, D161)', () => {
  let phone: Json;
  let foldable: string;

  beforeAll(async () => {
    foldable = newId();
    await own(
      db,
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
       VALUES ($1, $2, (SELECT id FROM public.types WHERE owner_account_id IS NULL
                                                    AND builtin_key = 'phone'),
               'Foldable', 'lucide:box')`,
      [foldable, home.accountId],
    );
    const brand = newId();
    const tag = newId();
    const pal = newId();
    const souq = newId();
    await own(
      db,
      `INSERT INTO public.brands (id, owner_account_id, name) VALUES ($1, $2, 'Acme')`,
      [brand, home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, 'Travel')`,
      [tag, home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, 'Juha')`,
      [pal, home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, 'Souq')`,
      [souq, home.accountId],
    );
    const purchase = newId();
    const line = newId();
    await own(
      db,
      `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total)
       VALUES ($1, $2, $3, '2026-09-01', 'EGP', 9000)`,
      [purchase, home.id, souq],
    );
    await own(
      db,
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description)
       VALUES ($1, $2, $3, 'Phone')`,
      [line, home.id, purchase],
    );
    phone = await createThing(t, ann, home, { name: 'Flip phone', typeId: foldable });
    await own(
      db,
      `UPDATE public.things SET brand_id = $2, belongs_to_person_id = $3, purchase_line_id = $4
        WHERE id = $1`,
      [phone.id, brand, pal, line],
    );
    await own(
      db,
      'INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)',
      [home.id, phone.id, tag],
    );
  });

  const registryCount = async (accountId: string) =>
    (
      await own<{ n: number }>(
        db,
        `SELECT ((SELECT count(*) FROM public.types WHERE owner_account_id = $1)
               + (SELECT count(*) FROM public.brands WHERE owner_account_id = $1)
               + (SELECT count(*) FROM public.tags WHERE owner_account_id = $1)
               + (SELECT count(*) FROM public.people WHERE owner_account_id = $1)
               + (SELECT count(*) FROM public.vendors WHERE owner_account_id = $1))::int AS n`,
        [accountId],
      )
    )[0]?.n;

  it('previews what would be copied and who loses sight, changing nothing', async () => {
    const before = await registryCount(flat.accountId);
    const eventsBefore = await eventsOf(db, home.id, phone.id);
    const res = ok(await preview(ann, { thingIds: [phone.id], to: { placeId: flat.unplacedId } }));
    expect(res).toEqual({
      crossLocation: true,
      crossAccount: true,
      targetLocation: { id: flat.id, name: 'Flat' },
      losesSight: [{ displayName: 'Ada' }, { displayName: 'Alfred' }, { displayName: 'Vic' }],
      copies: { types: 1, tags: 1, people: 1, vendors: 1, brands: 1, purchases: 1 },
    });
    expect(await registryCount(flat.accountId)).toBe(before);
    expect(await row(phone.id)).toMatchObject({ location_id: home.id, type_id: foldable });
    expect(await eventsOf(db, home.id, phone.id)).toEqual(eventsBefore);
  });

  // catalogue: POST /api/v1/things/move
  it('copies the registries and the purchase, with account-level audit rows for each', async () => {
    ok(await move(ann, { thingIds: [phone.id], to: { placeId: flat.unplacedId } }));
    const now = await row(phone.id);
    expect(now.location_id).toBe(flat.id);
    expect(now.type_id).not.toBe(foldable);

    const accountAudit = await own<{ action: string; entity_id: string; diff: object }>(
      db,
      `SELECT action, entity_id, diff FROM public.audit_events
        WHERE owner_account_id = $1 AND location_id IS NULL AND actor_id = $2 ORDER BY action`,
      [flat.accountId, ann.userId],
    );
    expect(accountAudit.map((e) => e.action)).toEqual([
      'brand.create',
      'person.create',
      'tag.create',
      'type.create',
      'vendor.create',
    ]);
    const typeEvent = accountAudit.find((e) => e.action === 'type.create');
    expect(typeEvent?.entity_id).toBe(now.type_id);
    expect(typeEvent?.diff).toMatchObject({
      name: { after: 'Foldable' },
      copied_by_move: { after: true },
    });
    const [purchase] = await auditOf(flat.id, 'purchase.create');
    expect(purchase?.diff).toMatchObject({ copied_by_move: { after: true } });
    expect(Object.keys(purchase?.diff ?? {})).not.toContain('total');
    const move_ = await lastAudit(flat.id, phone.id);
    expect(move_?.diff).toMatchObject({ location_id: { before: home.id, after: flat.id } });
  });

  it('a same-location preview has nothing to warn about', async () => {
    const lamp = await createThing(t, ann, home, { name: 'Reading lamp' });
    const res = ok(await preview(ann, { thingIds: [lamp.id], to: { placeId: home.unplacedId } }));
    expect(res).toEqual({
      crossLocation: false,
      crossAccount: false,
      targetLocation: { id: home.id, name: 'Home' },
      losesSight: [],
      copies: { types: 0, tags: 0, people: 0, vendors: 0, brands: 0, purchases: 0 },
    });
    const toGarage = ok(
      await preview(ann, { thingIds: [lamp.id], to: { placeId: garage.unplacedId } }),
    );
    expect(toGarage).toMatchObject({
      crossLocation: true,
      crossAccount: false,
      losesSight: [{ displayName: 'Ada' }, { displayName: 'Vic' }],
    });
    expect(
      (await preview(bob, { thingIds: [lamp.id], to: { placeId: home.unplacedId } })).statusCode,
    ).toBe(404);
  });
});

describe('blob locks before a move copies files (security review #16, #18; D161)', () => {
  /** A file row in `loc` with a thumbnail, as kept_owner: {id, key, thumb}. */
  async function fileIn(loc: Loc): Promise<{ id: string; key: string; thumb: string }> {
    const id = newId();
    const sha = randomBytes(32).toString('hex');
    const [f] = await own<{ storage_key: string }>(
      db,
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, 'x', $3, 10, 'image/jpeg', 'photo', 'ready', $4) RETURNING storage_key`,
      [id, loc.id, sha, ann.userId],
    );
    const [d] = await own<{ storage_key: string }>(
      db,
      `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                            height, bytes)
       VALUES ($1, 'thumb', $2, 'x', 10, 10, 10) RETURNING storage_key`,
      [id, loc.id],
    );
    return { id, key: f?.storage_key as string, thumb: d?.storage_key as string };
  }

  /** Holds the blob lock of `key` (blob-locks.ts) in another transaction while `run` starts;
   * answers whether `run` waited for it, and its result once the lock is let go. */
  async function waitsFor(key: string, run: () => Promise<{ statusCode: number }>) {
    const holder = await db.pools.system.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('kept.blobs'), hashtext($1))", [
        key,
      ]);
      let settled = false;
      const pending = run().then((res) => {
        settled = true;
        return res;
      });
      await new Promise((r) => setTimeout(r, 400));
      const waited = !settled;
      await holder.query('COMMIT');
      return { waited, res: await pending };
    } finally {
      holder.release();
    }
  }

  it("waits on the blob locks of a moved thing's photos, and of its receipts across accounts", async () => {
    const lamp = await createThing(t, ann, home, { name: 'Brass lamp' });
    const photo = await fileIn(home);
    await own(
      db,
      `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
       VALUES ($1, $2, $3, 'photo', $4)`,
      [home.id, photo.id, lamp.id, ann.userId],
    );
    const photoMove = await waitsFor(photo.thumb, () =>
      move(ann, { thingIds: [lamp.id], to: { placeId: flat.unplacedId } }),
    );
    expect(photoMove.res.statusCode).toBe(200);
    expect(photoMove.waited).toBe(true);

    const radio = await createThing(t, ann, home, {
      name: 'Radio',
      purchase: { purchasedOn: '2026-09-01', currency: 'EGP', price: '800' },
    });
    const receipt = await fileIn(home);
    await own(
      db,
      `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by)
       SELECT $1, $2, pl.purchase_id, 'receipt', $4
         FROM public.things t JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
        WHERE t.id = $3`,
      [home.id, receipt.id, radio.id, ann.userId],
    );
    const receiptMove = await waitsFor(receipt.key, () =>
      move(ann, { thingIds: [radio.id], to: { placeId: flat.unplacedId } }),
    );
    expect(receiptMove.res.statusCode).toBe(200);
    expect(receiptMove.waited).toBe(true);
    expect((await row(radio.id)).location_id).toBe(flat.id);
  });

  it("waits on the blob locks of a moved thing's warranty and claim documents (step 4)", async () => {
    const kettle = await createThing(t, ann, home, { name: 'Kettle' });
    const card = await fileIn(home);
    const invoice = await fileIn(home);
    const [w] = await own<{ id: string }>(
      db,
      `INSERT INTO public.warranties (location_id, thing_id, kind, starts_on, term_months,
                                      created_by)
       VALUES ($1, $2, 'manufacturer', '2026-01-01', 24, $3) RETURNING id`,
      [home.id, kettle.id, ann.userId],
    );
    const [c] = await own<{ id: string }>(
      db,
      `INSERT INTO public.claims (location_id, thing_id, opened_on, created_by)
       VALUES ($1, $2, '2026-02-01', $3) RETURNING id`,
      [home.id, kettle.id, ann.userId],
    );
    await own(
      db,
      `INSERT INTO public.attachments (location_id, file_id, warranty_id, role, created_by)
       VALUES ($1, $2, $3, 'warranty_doc', $4)`,
      [home.id, card.id, w?.id, ann.userId],
    );
    await own(
      db,
      `INSERT INTO public.attachments (location_id, file_id, claim_id, role, created_by)
       VALUES ($1, $2, $3, 'invoice', $4)`,
      [home.id, invoice.id, c?.id, ann.userId],
    );
    const warrantyMove = await waitsFor(card.thumb, () =>
      move(ann, { thingIds: [kettle.id], to: { placeId: flat.unplacedId } }),
    );
    expect(warrantyMove.res.statusCode).toBe(200);
    expect(warrantyMove.waited).toBe(true);
    const back = await waitsFor(invoice.key, () =>
      move(ann, { thingIds: [kettle.id], to: { placeId: home.unplacedId } }),
    );
    expect(back.res.statusCode).toBe(200);
    expect(back.waited).toBe(true);
  });
});

describe('POST /api/v1/things/:id/empty-into (D45)', () => {
  // catalogue: POST /api/v1/things/:id/empty-into
  it('moves everything directly inside one box into another, one audit row each', async () => {
    const box3 = await box(home, 'Box 3');
    const box5 = await box(home, 'Box 5');
    const bag = await box(home, 'Bag', { containerId: box3.id });
    const sock = await createThing(t, mo, home, { name: 'Sock', containerId: bag.id });
    const hat = await createThing(t, mo, home, { name: 'Hat', containerId: box3.id });

    const res = ok(
      await call(t, `/api/v1/things/${box3.id}/empty-into`, {
        as: mo,
        body: { to: { containerId: box5.id } },
      }),
    );
    expect(new Set(res.moved as string[])).toEqual(new Set([bag.id, hat.id]));
    expect(await row(bag.id)).toMatchObject({ container_id: box5.id });
    expect(await row(hat.id)).toMatchObject({ container_id: box5.id });
    expect(await row(sock.id)).toMatchObject({ container_id: bag.id });
    const bagAudit = await lastAudit(home.id, bag.id);
    expect(bagAudit?.diff).toMatchObject({
      container_id: { before: box3.id, after: box5.id },
    });
    expect(await subjectsOf(bagAudit?.id as string)).toEqual([bag.id, sock.id].sort());
    expect((await lastAudit(home.id, hat.id))?.action).toBe('thing.move');

    const empty = ok(
      await call(t, `/api/v1/things/${box3.id}/empty-into`, {
        as: mo,
        body: { to: { containerId: box5.id } },
      }),
    );
    expect(empty.moved).toEqual([]);
  });

  it('refuses a viewer (403), an outsider (404), and emptying a box into what it holds (409)', async () => {
    const outer = await box(home, 'Chest');
    const inner = await box(home, 'Casket', { containerId: outer.id });
    await createThing(t, ann, home, { name: 'Ring', containerId: inner.id });
    const url = `/api/v1/things/${outer.id}/empty-into`;
    const body = { to: { placeId: home.unplacedId } };
    expect((await call(t, url, { as: vic, body })).statusCode).toBe(403);
    expect((await call(t, url, { as: bob, body })).statusCode).toBe(404);
    const loop = await call(t, url, { as: ann, body: { to: { containerId: inner.id } } });
    expect(loop.statusCode).toBe(409);
  });
});

describe('route security review (step 2): moves', () => {
  // catalogue: POST /api/v1/things/move
  it('takes an optional If-Match for a one-thing move: stale is 412; with several things 400', async () => {
    const shelf = await place(db, home, 'Review shelf');
    const lamp = await createThing(t, mo, home, { name: 'Review lamp' });
    const vase = await createThing(t, mo, home, { name: 'Review vase' });
    const to = { placeId: shelf };
    const stale = await call(t, '/api/v1/things/move', {
      as: mo,
      headers: { 'if-match': String((lamp.rowVersion as number) + 4) },
      body: { thingIds: [lamp.id], to },
    });
    expect(stale.statusCode, stale.body).toBe(412);
    expect((await row(lamp.id)).place_id).toBe(home.unplacedId);
    const several = await call(t, '/api/v1/things/move', {
      as: mo,
      headers: { 'if-match': String(lamp.rowVersion) },
      body: { thingIds: [lamp.id, vase.id], to },
    });
    expect(several.statusCode, several.body).toBe(400);
    ok(
      await call(t, '/api/v1/things/move', {
        as: mo,
        headers: { 'if-match': String(lamp.rowVersion) },
        body: { thingIds: [lamp.id], to },
      }),
    );
    expect((await row(lamp.id)).place_id).toBe(shelf);
    expect((await lastAudit(home.id, lamp.id))?.action).toBe('thing.move');
  });

  it('answers an empty-into a container into itself as moving nothing', async () => {
    const crate = await box(home, 'Review crate');
    const cup = await createThing(t, mo, home, { name: 'Review cup', containerId: crate.id });
    const res = ok(
      await call(t, `/api/v1/things/${crate.id}/empty-into`, {
        as: mo,
        body: { to: { containerId: crate.id } },
      }),
    );
    expect(res.moved).toEqual([]);
    expect((await row(cup.id)).container_id).toBe(crate.id);
  });

  it('refuses to preview a move of more than 1000 things with their contents (400)', async () => {
    const hoard = await box(home, 'Review hoard');
    await own(
      db,
      `INSERT INTO public.things (location_id, container_id, name)
       SELECT $1, $2, 'bead ' || n FROM generate_series(1, 1000) AS n`,
      [home.id, hoard.id],
    );
    const res = await preview(ann, { thingIds: [hoard.id], to: { placeId: garage.unplacedId } });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('limits previews to 60 a minute per person (429 with Retry-After)', async () => {
    const pia = await person(t, db, 'pia');
    await join(db, home.id, pia.userId, 'member');
    const thing = await createThing(t, pia, home, { name: 'Review pebble' });
    const body = { thingIds: [thing.id], to: { placeId: home.unplacedId } };
    for (let i = 0; i < 60; i++) {
      const res = await preview(pia, body);
      expect(res.statusCode, res.body).toBe(200);
    }
    const limited = await preview(pia, body);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('refuses to undo an edit once the thing moved to another location (409 on location_id)', async () => {
    const lamp = await createThing(t, ann, home, { name: 'Review desk lamp' });
    ok(
      await call(t, `/api/v1/things/${lamp.id}`, {
        method: 'PATCH',
        as: ann,
        headers: { 'if-match': String(lamp.rowVersion) },
        body: { name: 'Review reading lamp' },
      }),
    );
    const edit = await lastAudit(home.id, lamp.id);
    ok(await move(ann, { thingIds: [lamp.id], to: { placeId: garage.unplacedId } }));
    const res = await call(t, `/api/v1/audit/${edit?.id}/undo`, { as: ann, body: {} });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().conflicts).toEqual(['location_id']);
    const [now] = await own<{ name: string }>(db, 'SELECT name FROM public.things WHERE id = $1', [
      lamp.id,
    ]);
    expect(now?.name).toBe('Review reading lamp');
  });

  it('undoes a move whose old place is in the trash into the Unplaced area', async () => {
    const a = await place(db, home, 'Review drawer A');
    const b = await place(db, home, 'Review drawer B');
    const pen = await createThing(t, ann, home, { name: 'Review pen', placeId: a });
    ok(await move(mo, { thingIds: [pen.id], to: { placeId: b } }));
    const moved = await lastAudit(home.id, pen.id);
    ok(await call(t, `/api/v1/places/${a}/trash`, { as: mo, body: {} }));
    const res = ok(await call(t, `/api/v1/audit/${moved?.id}/undo`, { as: mo, body: {} }));
    expect(await row(pen.id)).toMatchObject({ place_id: home.unplacedId, container_id: null });
    expect(await lastAudit(home.id, pen.id)).toMatchObject({
      id: res.eventId,
      action: 'thing.move',
      undo_of: moved?.id,
      undoable_until: null,
    });
  });

  it('undoes a move across locations with the rows a forward move writes (dropped links)', async () => {
    const drill = await createThing(t, ann, home, { name: 'Review drill' });
    ok(await move(ann, { thingIds: [drill.id], to: { placeId: garage.unplacedId } }));
    const moved = await lastAudit(garage.id, drill.id);
    const bits = await createThing(t, ann, garage, { name: 'Review drill bits' });
    const link = ok(
      await call(t, `/api/v1/things/${bits.id}/links`, {
        as: ann,
        body: { toThingId: drill.id, kind: 'accessory_of' },
      }),
      201,
    );
    ok(await call(t, `/api/v1/audit/${moved?.id}/undo`, { as: ann, body: {} }));
    expect(await row(drill.id)).toMatchObject({ location_id: home.id });
    const unlinks = await auditOf(garage.id, 'thing.unlink');
    expect(unlinks.map((u) => u.entity_id)).toContain(link.id);
    // Both ends see the move back; the undone location's row points at the event.
    expect(await lastAudit(garage.id, drill.id)).toMatchObject({ undo_of: moved?.id });
    expect((await lastAudit(home.id, drill.id))?.action).toBe('thing.move');
  });
});
