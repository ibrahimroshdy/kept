import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 21: history and the activity feed through the front door (D76, D110, D150, D174, D183;
// engineering spec §7.5). Events are written as kept_owner in the stored shape audited() gives
// them (the real writes and their audit rows are each area's own tests); every read goes through
// the app on kept_app, so the audit_events policy decides what exists and renderAudit() what
// each field shows, for the caller's role in that event's location.

let db: TestDb;
let t: TestApp;

type Loc = { id: string; unplacedId: string; accountId: string };

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function createLocation(as: Person, name: string, preset = 'complete'): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  const [row] = await own<{ unplaced: string; account: string }>(
    `SELECT (SELECT id FROM public.places WHERE location_id = l.id AND is_unplaced) AS unplaced,
            l.owner_account_id AS account
       FROM public.locations l WHERE l.id = $1`,
    [id],
  );
  return { id, unplacedId: row?.unplaced as string, accountId: row?.account as string };
}

async function thing(loc: Loc, name: string, typeId: string | null = null): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, loc.id, loc.unplacedId, name, typeId],
  );
  return id;
}

async function place(loc: Loc, name: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.places (id, location_id, name, kind_key) VALUES ($1, $2, $3, 'room')`,
    [id, loc.id, name],
  );
  return id;
}

type Change = { before?: unknown; after?: unknown; class: string; changed?: true };

let minutes = 0;
/** Writes a stored event, each one a minute after the last (so their order is known). */
async function event(e: {
  loc: Loc | null;
  accountId?: string;
  actor: Person;
  action: string;
  entity: { type: string; id: string | null };
  rootThingId?: string | null;
  diff?: Record<string, Change> | null;
  subjects?: string[];
  undoOf?: string;
  undoable?: boolean;
}): Promise<string> {
  const id = newId();
  minutes += 1;
  await ownerTx(db, async (c) => {
    const { rows } = await c.query<{ at: Date }>(
      `INSERT INTO public.audit_events (id, at, location_id, owner_account_id, actor_type, actor_id,
                                        action, entity_type, entity_id, root_thing_id, diff, undo_of,
                                        undoable_until)
       VALUES ($1, date_trunc('milliseconds', now()) - interval '1 day'
                   + make_interval(mins => $2), $3, $4, 'user', $5, $6, $7, $8, $9, $10, $11,
               CASE WHEN $12 THEN now() + interval '6 days' END)
       RETURNING at`,
      [
        id,
        minutes,
        e.loc?.id ?? null,
        e.loc?.accountId ?? e.accountId ?? null,
        e.actor.userId,
        e.action,
        e.entity.type,
        e.entity.id,
        e.rootThingId ?? (e.entity.type === 'thing' ? e.entity.id : null),
        e.diff === undefined ? {} : e.diff,
        e.undoOf ?? null,
        e.undoable ?? false,
      ],
    );
    for (const thingId of e.subjects ?? []) {
      await c.query(
        `INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
         VALUES ($1, $2, $3, $4)`,
        [id, rows[0]?.at, e.loc?.id, thingId],
      );
    }
  });
  return id;
}

async function ok<T>(res: Promise<LightMyRequestResponse>, status = 200): Promise<T> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
}

const get = (as: Person, url: string) => call(t, url, { as });

type HistoryEvent = {
  id: string;
  at: string;
  location_id: string | null;
  action: string;
  actor: { type: string; id: string | null; displayName: string | null };
  entity: { type: string; id: string | null; shortCode: string | null };
  root_thing_id: string | null;
  diff: Record<string, Change & { hidden?: true; label?: string; labelKey?: string }> | null;
  undo_of: string | null;
  undoable_until: string | null;
  summary: string;
  summaryKey: string;
  summaryParams: Record<string, string>;
  movedInFromElsewhere?: true;
};
type Page = { items: HistoryEvent[]; next_cursor: string | null };

const history = (as: Person, id: string, query = '') =>
  ok<Page>(get(as, `/api/v1/things/${id}/history${query}`));
const feed = (as: Person, query = '') => ok<Page>(get(as, `/api/v1/activity${query}`));

let ola: Person; // owner of home, garage and cabin
let ada: Person; // admin of home
let max: Person; // member of home
let vic: Person; // viewer of home
let bob: Person; // outsider
let home: Loc; // Money on
let garage: Loc; // Money off (essentials)
let cabin: Loc; // ola's alone
let bobs: Loc;
const names = new Map<string, string>();

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ola = await person(t, db, 'ola');
  ada = await person(t, db, 'ada');
  max = await person(t, db, 'max');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  home = await createLocation(ola, 'Home');
  garage = await createLocation(ola, 'Garage', 'essentials');
  cabin = await createLocation(ola, 'Cabin');
  bobs = await createLocation(bob, 'Bob home');
  await join(db, home.id, ada.userId, 'admin');
  await join(db, home.id, max.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  await join(db, garage.id, max.userId, 'member');
  for (const p of [ola, ada, max, vic, bob]) {
    const [row] = await own<{ display_name: string }>(
      'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
      [p.userId],
    );
    names.set(p.userId, row?.display_name as string);
  }
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/things/:id/history: redaction per viewer (D110)', () => {
  let tv: string;
  let customType: string;
  let builtinKey: string;

  beforeAll(async () => {
    // A custom type under a built-in one that has fields: its own money and secret fields have
    // labels; the inherited built-in field is named by its key.
    const [builtin] = await own<{ id: string; key: string }>(
      `SELECT ty.id, f.key FROM public.types ty
         JOIN public.type_fields f ON f.type_id = ty.id
        WHERE ty.owner_account_id IS NULL AND NOT ty.is_field_group AND NOT f.secret
          AND f.kind IN ('text', 'number') AND f.label IS NULL
        ORDER BY ty.builtin_key, f.key LIMIT 1`,
    );
    expect(builtin, 'a built-in type with a field').toBeDefined();
    builtinKey = builtin?.key as string;
    customType = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
       VALUES ($1, $2, $3, 'Television', 'lucide:tv')`,
      [customType, home.accountId, builtin?.id],
    );
    await own(
      `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, secret)
       VALUES ($1, $2, 'insured_value', 'Insured value', 'money', false),
              ($1, $2, 'pin', 'Parental PIN', 'text', true)`,
      [home.accountId, customType],
    );
    tv = await thing(home, 'Samsung TV', customType);
    await event({
      loc: home,
      actor: max,
      action: 'thing.update',
      entity: { type: 'thing', id: tv },
      diff: {
        notes: { before: null, after: 'Wall-mounted', class: 'plain' },
        ended_price: { before: null, after: '350.0000', class: 'money' },
        'custom.insured_value': { before: '12000', after: '14500', class: 'money' },
        [`custom.${builtinKey}`]: { before: 'a', after: 'b', class: 'plain' },
        'custom.pin': { changed: true, class: 'secret' },
      },
    });
  });

  it('shows money to members and above, labelled, and never a secret', async () => {
    for (const as of [ola, ada, max]) {
      const [e] = (await history(as, tv)).items;
      expect(e?.diff).toEqual({
        notes: { before: null, after: 'Wall-mounted', class: 'plain' },
        // Money leaves in canonical form whatever the diff stored (numeric pads it).
        ended_price: { before: null, after: '350', class: 'money' },
        'custom.insured_value': {
          before: '12000',
          after: '14500',
          class: 'money',
          label: 'Insured value',
        },
        [`custom.${builtinKey}`]: { before: 'a', after: 'b', class: 'plain', labelKey: builtinKey },
        'custom.pin': { changed: true, class: 'secret', label: 'Parental PIN' },
      });
      expect(e).toMatchObject({
        action: 'thing.update',
        actor: { type: 'user', id: max.userId, displayName: names.get(max.userId) },
        summaryKey: 'thing.update',
        summaryParams: { name: 'Samsung TV' },
        summary: 'Edited Samsung TV',
      });
    }
  });

  it('hides ended_price and custom money from a viewer, unless the location allows it', async () => {
    const [e] = (await history(vic, tv)).items;
    expect(e?.diff?.ended_price).toEqual({ changed: true, class: 'money', hidden: true });
    expect(e?.diff?.['custom.insured_value']).toEqual({
      changed: true,
      class: 'money',
      hidden: true,
      label: 'Insured value',
    });
    expect(e?.diff?.['custom.pin']).toEqual({
      changed: true,
      class: 'secret',
      label: 'Parental PIN',
    });
    expect(JSON.stringify(e)).not.toMatch(/350|12000|14500/);

    await own('UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      const [shown] = (await history(vic, tv)).items;
      expect(shown?.diff?.ended_price).toEqual({ before: null, after: '350', class: 'money' });
    } finally {
      await own('UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });

  it('hides money from everyone where the Money module is off', async () => {
    const drill = await thing(garage, 'Drill');
    await event({
      loc: garage,
      actor: ola,
      action: 'thing.lifecycle',
      entity: { type: 'thing', id: drill },
      diff: {
        lifecycle: { before: 'in_use', after: 'sold', class: 'plain' },
        ended_price: { before: null, after: '99.0000', class: 'money' },
      },
    });
    for (const as of [ola, max]) {
      const [e] = (await history(as, drill)).items;
      expect(e?.diff?.ended_price).toEqual({ changed: true, class: 'money', hidden: true });
      expect(e).toMatchObject({
        summaryKey: 'thing.lifecycle',
        summaryParams: { name: 'Drill', lifecycle: 'sold' },
        summary: 'Marked Drill as sold',
      });
      expect(JSON.stringify(e)).not.toContain('99.0000');
    }
  });

  it('passes the lifecycle as its code for the web to localise, English only in summary', async () => {
    const lamp = await thing(garage, 'Lamp');
    await event({
      loc: garage,
      actor: ola,
      action: 'thing.lifecycle',
      entity: { type: 'thing', id: lamp },
      diff: { lifecycle: { before: 'in_use', after: 'given_away', class: 'plain' } },
    });
    const [e] = (await history(ola, lamp)).items;
    expect(e).toMatchObject({
      summaryKey: 'thing.lifecycle',
      summaryParams: { name: 'Lamp', lifecycle: 'given_away' },
      summary: 'Marked Lamp as given away',
    });
  });

  it('is 404 to anyone who cannot see the thing', async () => {
    expect((await get(bob, `/api/v1/things/${tv}/history`)).statusCode).toBe(404);
    expect((await get(max, `/api/v1/things/${newId()}/history`)).statusCode).toBe(404);
  });
});

describe('GET /api/v1/things/:id/history: what is about the thing', () => {
  it('holds its own events, those rooted at it and those fanned out to it, newest first', async () => {
    const box = await thing(home, 'Box 3');
    const cable = await thing(home, 'HDMI cable');
    const own1 = await event({
      loc: home,
      actor: ola,
      action: 'thing.create',
      entity: { type: 'thing', id: cable },
      diff: { name: { before: null, after: 'HDMI cable', class: 'plain' } },
    });
    const rooted = await event({
      loc: home,
      actor: max,
      action: 'attachment.create',
      entity: { type: 'attachment', id: newId() },
      rootThingId: cable,
    });
    const fanned = await event({
      loc: home,
      actor: max,
      action: 'thing.move',
      entity: { type: 'thing', id: box },
      diff: { place_id: { before: home.unplacedId, after: newId(), class: 'plain' } },
      subjects: [cable],
    });
    await event({
      loc: home,
      actor: max,
      action: 'thing.update',
      entity: { type: 'thing', id: box },
    });

    const page = await history(max, cable);
    expect(page.items.map((e) => e.id)).toEqual([fanned, rooted, own1]);
    expect(page.items.map((e) => e.summary)).toEqual([
      'Moved Box 3',
      'Attached a file to HDMI cable',
      'Added HDMI cable',
    ]);
  });

  it('pages with a cursor, newest first, without repeats', async () => {
    const mug = await thing(home, 'Mug');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await event({
          loc: home,
          actor: max,
          action: 'thing.seen',
          entity: { type: 'thing', id: mug },
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await history(max, mug, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    expect((await get(max, `/api/v1/things/${mug}/history?cursor=bad`)).statusCode).toBe(400);
  });

  it('keeps the history of a trashed thing, and says who restored it by undo', async () => {
    const vase = await thing(home, 'Vase');
    await own('UPDATE public.things SET deleted_at = now() WHERE id = $1', [vase]);
    const trashed = await event({
      loc: home,
      actor: max,
      action: 'thing.trash',
      entity: { type: 'thing', id: vase },
      diff: { deleted_at: { before: null, after: '2026-09-20T10:00:00.000Z', class: 'plain' } },
      undoable: true,
    });
    await event({
      loc: home,
      actor: ola,
      action: 'thing.trash',
      entity: { type: 'thing', id: vase },
      diff: { deleted_at: { before: '2026-09-20T10:00:00.000Z', after: null, class: 'plain' } },
      undoOf: trashed,
    });
    const page = await history(vic, vase);
    expect(page.items.map((e) => [e.summaryKey, e.summary])).toEqual([
      ['thing.restore', 'Restored Vase'],
      ['thing.trash', 'Trashed Vase'],
    ]);
  });
});

describe('moves across locations (D183)', () => {
  it('shows a move in from a location the viewer cannot see, with no old path', async () => {
    const lamp = await thing(home, 'Brass lamp');
    const cabinShelf = await place(cabin, 'Cabin shelf');
    const homeShelf = await place(home, 'Hall shelf');
    // Before the move, in the cabin: an edit max must never see.
    await event({
      loc: cabin,
      actor: ola,
      action: 'thing.update',
      entity: { type: 'thing', id: lamp },
      diff: { notes: { before: null, after: 'From the cabin loft', class: 'plain' } },
    });
    const move = {
      actor: ola,
      action: 'thing.move',
      entity: { type: 'thing', id: lamp },
      diff: {
        location_id: { before: cabin.id, after: home.id, class: 'plain' },
        place_id: { before: cabinShelf, after: homeShelf, class: 'plain' },
      },
    };
    const outOfCabin = await event({ ...move, loc: cabin });
    const intoHome = await event({ ...move, loc: home });

    const mine = await history(max, lamp);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      id: intoHome,
      action: 'thing.move',
      diff: null,
      movedInFromElsewhere: true,
      summaryKey: 'thing.move.in',
      summaryParams: {},
      summary: 'Moved in from another location',
    });
    const text = JSON.stringify(mine);
    for (const leak of [cabin.id, cabinShelf, 'cabin loft', 'Cabin']) {
      expect(text).not.toContain(leak);
    }

    // The owner sees both ends: the move once (the destination's copy), in full, and the edit.
    const hers = await history(ola, lamp);
    expect(hers.items.map((e) => e.id)).toEqual([intoHome, expect.any(String)]);
    expect(hers.items.map((e) => e.id)).not.toContain(outOfCabin);
    expect(hers.items[0]?.movedInFromElsewhere).toBeUndefined();
    expect(hers.items[0]?.diff?.location_id).toEqual({
      before: cabin.id,
      after: home.id,
      class: 'plain',
    });
  });

  it('names a thing or place with its short ID, for the short address (D208)', async () => {
    const kettle = await thing(home, 'Labelled kettle');
    const bare = await thing(home, 'Unlabelled kettle');
    const shelf = await place(home, 'Labelled shelf');
    await own(
      `INSERT INTO public.short_ids (code, location_id, thing_id, state, is_primary)
       VALUES ('K3TT3A', $1, $2, 'assigned', true), ('K3TT3B', $1, $2, 'assigned', false)`,
      [home.id, kettle],
    );
    await own(
      `INSERT INTO public.short_ids (code, location_id, place_id, state, is_primary)
       VALUES ('SH3FF1', $1, $2, 'assigned', true)`,
      [home.id, shelf],
    );
    const made = [
      await event({
        loc: home,
        actor: max,
        action: 'thing.create',
        entity: { type: 'thing', id: kettle },
      }),
      await event({
        loc: home,
        actor: max,
        action: 'thing.create',
        entity: { type: 'thing', id: bare },
      }),
      await event({
        loc: home,
        actor: max,
        action: 'place.create',
        entity: { type: 'place', id: shelf },
      }),
    ];
    const items = (await feed(max, '?limit=200')).items;
    const entityOf = (id: string) => items.find((e) => e.id === id)?.entity;
    expect(made.map(entityOf)).toEqual([
      { type: 'thing', id: kettle, shortCode: 'K3TT3A' },
      { type: 'thing', id: bare, shortCode: null },
      { type: 'place', id: shelf, shortCode: 'SH3FF1' },
    ]);
    // The thing's own history carries it too.
    const first = (await history(vic, kettle)).items.find((e) => e.id === made[0]);
    expect(first?.entity.shortCode).toBe('K3TT3A');
  });

  it('shows a move out to a location the viewer cannot see without saying where', async () => {
    const rug = await thing(cabin, 'Rug');
    const homeCorner = await place(home, 'Corner');
    const out = await event({
      loc: home,
      actor: ola,
      action: 'thing.move',
      entity: { type: 'thing', id: rug },
      diff: {
        location_id: { before: home.id, after: cabin.id, class: 'plain' },
        place_id: { before: homeCorner, after: newId(), class: 'plain' },
      },
    });
    const items = (await feed(max, `?locationId=${home.id}&entityType=thing&limit=200`)).items;
    const newest = items.find((e) => e.id === out);
    expect(newest).toMatchObject({
      diff: null,
      summaryKey: 'thing.move.out',
      summaryParams: { name: 'a thing' },
      summary: 'Moved a thing to another location',
    });
    expect(newest?.movedInFromElsewhere).toBeUndefined();
    expect(JSON.stringify(newest)).not.toContain(cabin.id);
  });
});

describe('GET /api/v1/places/:id/history', () => {
  it("is the place's own events, 404 to anyone who can't see it", async () => {
    const study = await place(home, 'Study');
    const created = await event({
      loc: home,
      actor: ola,
      action: 'place.create',
      entity: { type: 'place', id: study },
      diff: { name: { before: null, after: 'Study', class: 'plain' } },
    });
    await event({
      loc: home,
      actor: ola,
      action: 'thing.create',
      entity: { type: 'thing', id: newId() },
    });
    const page = await ok<Page>(get(vic, `/api/v1/places/${study}/history`));
    expect(page.items.map((e) => [e.id, e.summary])).toEqual([[created, 'Added Study']]);
    expect((await get(bob, `/api/v1/places/${study}/history`)).statusCode).toBe(404);
  });
});

describe('GET /api/v1/activity (D174)', () => {
  let brandEvent: string;
  let bobEvent: string;
  let homeEvent: string;
  let garageEvent: string;

  beforeAll(async () => {
    const brand = newId();
    await own('INSERT INTO public.brands (id, owner_account_id, name) VALUES ($1, $2, $3)', [
      brand,
      home.accountId,
      'Acme',
    ]);
    brandEvent = await event({
      loc: null,
      accountId: home.accountId,
      actor: ada,
      action: 'brand.create',
      entity: { type: 'brand', id: brand },
      diff: { name: { before: null, after: 'Acme', class: 'plain' } },
    });
    bobEvent = await event({
      loc: bobs,
      actor: bob,
      action: 'thing.create',
      entity: { type: 'thing', id: await thing(bobs, 'Bob kettle') },
    });
    homeEvent = await event({
      loc: home,
      actor: max,
      action: 'thing.create',
      entity: { type: 'thing', id: await thing(home, 'Espresso machine') },
    });
    garageEvent = await event({
      loc: garage,
      actor: ola,
      action: 'place.create',
      entity: { type: 'place', id: await place(garage, 'Workbench') },
    });
  });

  const ids = async (as: Person, query = '') => (await feed(as, query)).items.map((e) => e.id);

  it('spans every location the caller can see, and no other (RLS)', async () => {
    const maxs = await ids(max, '?limit=200');
    expect(maxs).toEqual(expect.arrayContaining([homeEvent, garageEvent]));
    expect(maxs).not.toContain(bobEvent);
    const vics = await ids(vic, '?limit=200');
    expect(vics).toContain(homeEvent);
    expect(vics).not.toContain(garageEvent);
    const bobs2 = await ids(bob, '?limit=200');
    expect(bobs2).toContain(bobEvent);
    expect(bobs2).not.toContain(homeEvent);
    expect(bobs2).not.toContain(brandEvent);
  });

  it("shows the account's registry events to its admins only (Q15)", async () => {
    for (const as of [ola, ada]) {
      const items = (await feed(as, '?limit=200')).items;
      expect(items.find((e) => e.id === brandEvent)).toMatchObject({
        location_id: null,
        summaryKey: 'event',
        summaryParams: { action: 'brand.create' },
        summary: 'Brand added',
      });
    }
    for (const as of [max, vic]) expect(await ids(as, '?limit=200')).not.toContain(brandEvent);
    // A location filter leaves account-level events out.
    expect(await ids(ola, `?locationId=${home.id}&limit=200`)).not.toContain(brandEvent);
  });

  it('filters by location, person, kind, date and words', async () => {
    expect(await ids(max, `?locationId=${garage.id}&limit=200`)).toEqual(
      expect.not.arrayContaining([homeEvent]),
    );
    expect(await ids(max, `?locationId=${garage.id}&limit=200`)).toContain(garageEvent);
    expect((await get(max, `/api/v1/activity?locationId=${bobs.id}`)).statusCode).toBe(404);

    const byMax = (await feed(ola, `?actorId=${max.userId}&limit=200`)).items;
    expect(byMax.length).toBeGreaterThan(0);
    expect(byMax.every((e) => e.actor.id === max.userId)).toBe(true);

    const places = (await feed(ola, '?entityType=place&limit=200')).items;
    expect(places.map((e) => e.id)).toContain(garageEvent);
    expect(places.every((e) => e.entity.type === 'place')).toBe(true);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(await ids(ola, `?from=${encodeURIComponent(future)}`)).toEqual([]);
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(await ids(ola, `?to=${encodeURIComponent(past)}`)).toEqual([]);
    expect(await ids(ola, '?from=2020-01-01&limit=200')).toContain(homeEvent);

    expect(await ids(max, '?q=espresso')).toEqual([homeEvent]);
    expect(await ids(max, '?q=workbench')).toEqual([garageEvent]);
    // Who did it: display names here are `max-<uuid>`.
    const byName = (await feed(ola, '?q=max&limit=200')).items;
    expect(byName.map((e) => e.id)).toContain(homeEvent);
    expect(byName.every((e) => e.actor.id === max.userId)).toBe(true);
    expect((await get(max, '/api/v1/activity?from=yesterday')).statusCode).toBe(400);
  });

  it('takes several people, kinds and locations, and "is none of" each (D205)', async () => {
    const all = await ids(ola, '?limit=200');
    // Two people: exactly their events.
    const both = (await feed(ola, `?actorId=${max.userId}&actorId=${ola.userId}&limit=200`)).items;
    expect(both.map((e) => e.id)).toEqual(expect.arrayContaining([homeEvent, garageEvent]));
    expect(both.every((e) => e.actor.id === max.userId || e.actor.id === ola.userId)).toBe(true);
    // None of a person: everyone else's, and events no person made.
    const notMax = (await feed(ola, `?actorId=${max.userId}&not=actorId&limit=200`)).items;
    expect(notMax.map((e) => e.id)).toContain(garageEvent);
    expect(notMax.some((e) => e.actor.id === max.userId)).toBe(false);
    expect(notMax.length + (await ids(ola, `?actorId=${max.userId}&limit=200`)).length).toBe(
      all.length,
    );
    // None of a kind.
    const notPlaces = (await feed(ola, '?entityType=place&not=entityType&limit=200')).items;
    expect(notPlaces.map((e) => e.id)).toContain(homeEvent);
    expect(notPlaces.some((e) => e.entity.type === 'place')).toBe(false);
    expect(await ids(ola, '?entityType=place&entityType=brand&limit=200')).toEqual(
      expect.arrayContaining([garageEvent, brandEvent]),
    );
    // Two locations; none of one (account-level events belong to none, so they stay).
    const two = await ids(ola, `?locationId=${home.id}&locationId=${garage.id}&limit=200`);
    expect(two).toEqual(expect.arrayContaining([homeEvent, garageEvent]));
    expect(two).not.toContain(brandEvent);
    const notHome = await ids(ola, `?locationId=${home.id}&not=locationId&limit=200`);
    expect(notHome).toEqual(expect.arrayContaining([garageEvent, brandEvent]));
    expect(notHome).not.toContain(homeEvent);
    // Every location named must be one the caller sees, "none of" too (review #36).
    expect(
      (await get(max, `/api/v1/activity?locationId=${bobs.id}&not=locationId`)).statusCode,
    ).toBe(404);
    expect((await get(max, '/api/v1/activity?not=q')).statusCode).toBe(400);
  });

  it('pages newest first (Home asks for 3 or 5)', async () => {
    const first = await feed(max, '?limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();
    const second = await feed(max, `?limit=3&cursor=${first.next_cursor}`);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    const times = all.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());
  });
});

describe('GET /api/v1/locations/:id/actors', () => {
  it('lists who acted in the location, and is 404 elsewhere', async () => {
    const { items } = await ok<{ items: { id: string; displayName: string | null }[] }>(
      get(vic, `/api/v1/locations/${home.id}/actors`),
    );
    const byId = new Map(items.map((a) => [a.id, a.displayName]));
    expect(byId.get(max.userId)).toBe(names.get(max.userId));
    expect(byId.get(ola.userId)).toBe(names.get(ola.userId));
    expect(byId.has(bob.userId)).toBe(false);
    expect((await get(bob, `/api/v1/locations/${home.id}/actors`)).statusCode).toBe(404);
  });
});
