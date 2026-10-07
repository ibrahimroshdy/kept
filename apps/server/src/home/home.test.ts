import { HINT_KEYS, newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { cookieHeader, requestHeaders } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, PASSWORD, type Person, peopleApp, person } from '../../test/people.js';
import { insertInvite, ownerTx } from '../../test/tenancy.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { seal } from '../crypto/envelope.js';

// Task 22 through the front door: GET /api/v1/home and the hints, as the web calls them
// (apps/web/src/api/inventory/{types,paths}.ts and mock/home.ts). Rows are seeded as
// kept_owner; every read and write goes through the app as a signed-in user on kept_app.

let db: TestDb;
let t: TestApp;

type Loc = { id: string; unplacedId: string };
type Item = { key: string; done: boolean };
type Home = {
  checklist: { dismissed: boolean; items: Item[] };
  attention: { toReview: number; uncertain: number; longUnseen: number; unplaced: number } & {
    [step4: string]: number;
  };
  counts: { inbox: number; unprintedLabels: number };
  locations: { id: string; thingCount: number; unplacedCount: number }[];
};
type Hint = { key: string; seenAt: string | null; dismissedAt: string | null };

/** Step 4's rows (T13) when nothing is due, lent or borrowed: src/agenda/agenda.test.ts tests them. */
const NO_AGENDA = { overdue: 0, due: 0, expiring: 0, lentOut: 0, borrowedIn: 0, lowStock: 0 };

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function unplacedOf(locationId: string): Promise<string> {
  const rows = await own<{ id: string }>(
    'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
    [locationId],
  );
  return rows[0]?.id as string;
}

async function createLocation(as: Person, preset: string, name = 'Home'): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  return { id, unplacedId: await unplacedOf(id) };
}

const personal = async (p: Person): Promise<Loc> => ({
  id: p.personalLocationId,
  unplacedId: await unplacedOf(p.personalLocationId),
});

async function place(loc: Loc, name: string): Promise<string> {
  const id = newId();
  await own('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
    id,
    loc.id,
    name,
  ]);
  return id;
}

type ThingFields = {
  by?: Person;
  placeId?: string;
  lifecycle?: string;
  uncertain?: boolean;
  lastSeenAt?: string;
  deleted?: boolean;
};

async function thing(loc: Loc, f: ThingFields = {}): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, lifecycle, location_uncertain,
                                last_seen_at, created_by, deleted_at)
     VALUES ($1, $2, $3, 'Thing', $4, $5, coalesce($6::timestamptz, now()), $7,
             CASE WHEN $8 THEN now() END)`,
    [
      id,
      loc.id,
      f.placeId ?? loc.unplacedId,
      f.lifecycle ?? 'in_use',
      f.uncertain ?? false,
      f.lastSeenAt ?? null,
      f.by?.userId ?? null,
      f.deleted ?? false,
    ],
  );
  return id;
}

/** A thing with an hours meter, and `n` readings waiting for review. */
async function toReview(loc: Loc, n = 1): Promise<string> {
  const id = await thing(loc, { placeId: await place(loc, 'Garage') });
  const meter = newId();
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
    [meter, loc.id, id],
  );
  for (let i = 0; i < n; i++) {
    await own(
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, state)
       VALUES ($1, $2, $3, now() - make_interval(days => $4), 'needs_review')`,
      [loc.id, meter, i + 1, i + 1],
    );
  }
  return id;
}

async function switchModule(locationId: string, module: string, enabled: boolean): Promise<void> {
  await own(
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

async function home(as: Person): Promise<Home> {
  const res = await call(t, '/api/v1/home', { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Home;
}

const keys = (h: Home) => h.checklist.items.map((i) => i.key);
const done = (h: Home, key: string) => h.checklist.items.find((i) => i.key === key)?.done;

async function hints(as: Person): Promise<Hint[]> {
  const res = await call(t, '/api/v1/me/hints', { as });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { hints: Hint[] }).hints;
}

const putHint = (as: Person, key: string, body: unknown) =>
  call(t, `/api/v1/me/hints/${encodeURIComponent(key)}`, { as, method: 'PUT', body });

/** The user's hint events (account-level audit rows), oldest first, as kept_owner. */
const hintAudit = (p: Person) =>
  own<{ action: string; location_id: string | null; owner_account_id: string; diff: unknown }>(
    `SELECT action, location_id, owner_account_id, diff FROM public.audit_events
      WHERE actor_id = $1 AND entity_type = 'hint' ORDER BY at, id`,
    [p.userId],
  );

const ownerAccountOf = async (p: Person) =>
  (
    await own<{ id: string }>('SELECT id FROM public.owner_accounts WHERE user_id = $1', [p.userId])
  )[0]?.id;

/** A second sign-in of the same person: another session, as on another phone. */
async function secondDevice(p: Person): Promise<Person> {
  const { headers } = await t.auth.api.signInEmail({
    body: { email: p.email, password: PASSWORD },
    headers: requestHeaders(),
    returnHeaders: true,
  });
  const cookie = cookieHeader(headers);
  expect(cookie).not.toBe(p.cookie);
  return { ...p, cookie };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/home: the Get-started checklist (D138)', () => {
  let ann: Person;

  beforeEach(async () => {
    ann = await person(t, db, 'ann');
  });

  it('needs a session', async () => {
    expect((await call(t, '/api/v1/home')).statusCode).toBe(401);
  });

  it('first run: only the personal location, so no invite and no AI step', async () => {
    const h = await home(ann);
    expect(h.checklist).toEqual({
      dismissed: false,
      items: [
        { key: 'locationCreated', done: false },
        { key: 'threeThings', done: false },
        { key: 'labelPrinted', done: false },
        { key: 'installed', done: false },
      ],
    });
  });

  it('flips "your first home" when she creates one, and adds invite and AI (Household)', async () => {
    await createLocation(ann, 'household');
    const h = await home(ann);
    expect(h.checklist.items).toEqual([
      { key: 'locationCreated', done: true },
      { key: 'threeThings', done: false },
      { key: 'labelPrinted', done: false },
      { key: 'invited', done: false },
      { key: 'aiConnected', done: false },
      { key: 'installed', done: false },
    ]);
  });

  it('never carries "Put Kept on HTTPS": the client adds it over http (D193)', async () => {
    await createLocation(ann, 'household');
    for (const proto of ['http', 'https']) {
      const res = await call(t, '/api/v1/home', {
        as: ann,
        headers: { 'x-forwarded-proto': proto },
      });
      expect(res.statusCode).toBe(200);
      expect(keys(res.json() as Home)).toEqual([
        'locationCreated',
        'threeThings',
        'labelPrinted',
        'invited',
        'aiConnected',
        'installed',
      ]);
    }
  });

  it('counts 3 things she captured herself, not trashed ones or anyone else’s (Q22)', async () => {
    const bob = await person(t, db, 'bob');
    const loc = await createLocation(ann, 'household');
    await join(db, loc.id, bob.userId, 'member');
    await thing(loc, { by: ann });
    await thing(loc, { by: ann });
    await thing(loc, { by: ann, deleted: true });
    await thing(loc, { by: bob });
    await thing(loc);
    expect(done(await home(ann), 'threeThings')).toBe(false);
    await thing(await personal(ann), { by: ann });
    expect(done(await home(ann), 'threeThings')).toBe(true);
    expect(done(await home(bob), 'threeThings')).toBe(false);
  });

  it('flips "a label printed" on a printed short ID in her locations only', async () => {
    const bob = await person(t, db, 'bob');
    const bobs = await createLocation(bob, 'household', 'Bob home');
    const bobThing = await thing(bobs, { by: bob });
    await own(
      'INSERT INTO public.short_ids (code, location_id, thing_id, printed_at) VALUES ($1, $2, $3, now())',
      [randomShortCode(), bobs.id, bobThing],
    );
    const loc = await createLocation(ann, 'household');
    const mine = await thing(loc, { by: ann });
    await own('INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)', [
      randomShortCode(),
      loc.id,
      mine,
    ]);
    expect(done(await home(ann), 'labelPrinted')).toBe(false);
    expect(done(await home(bob), 'labelPrinted')).toBe(true);
    await own('UPDATE public.short_ids SET printed_at = now() WHERE thing_id = $1', [mine]);
    expect(done(await home(ann), 'labelPrinted')).toBe(true);
  });

  it('flips "someone invited" on a pending invite or another member, not an expired invite', async () => {
    const loc = await createLocation(ann, 'household');
    await insertInvite(db, loc.id, ann.userId, { expiresAt: new Date(Date.now() - 60_000) });
    expect(done(await home(ann), 'invited')).toBe(false);
    await insertInvite(db, loc.id, ann.userId);
    expect(done(await home(ann), 'invited')).toBe(true);

    const dan = await person(t, db, 'dan');
    const cara = await person(t, db, 'cara');
    const solo = await createLocation(dan, 'household');
    expect(done(await home(dan), 'invited')).toBe(false);
    await join(db, solo.id, cara.userId, 'viewer');
    expect(done(await home(dan), 'invited')).toBe(true);
  });

  it('does not count a member of a home she only belongs to as her invite', async () => {
    const olga = await person(t, db, 'olga');
    const theirs = await createLocation(olga, 'household', 'Olga home');
    await join(db, theirs.id, ann.userId, 'member');
    await createLocation(ann, 'household');
    expect(done(await home(ann), 'invited')).toBe(false);
  });

  it('leaves out "connect AI" on Essentials (D191), and where both AI modules are off', async () => {
    await createLocation(ann, 'essentials');
    expect(keys(await home(ann))).not.toContain('aiConnected');
    expect(keys(await home(ann))).toContain('invited');

    const other = await createLocation(ann, 'household', 'Cabin');
    expect(done(await home(ann), 'aiConnected')).toBe(false);
    await switchModule(other.id, 'ai_capture', false);
    expect(keys(await home(ann))).toContain('aiConnected');
    await switchModule(other.id, 'ai_assistant', false);
    expect(keys(await home(ann))).not.toContain('aiConnected');
  });

  it('leaves out "a label printed" when Labels is off in every location she has', async () => {
    const loc = await createLocation(ann, 'household');
    await switchModule(ann.personalLocationId, 'labels', false);
    expect(keys(await home(ann))).toContain('labelPrinted');
    await switchModule(loc.id, 'labels', false);
    expect(keys(await home(ann))).not.toContain('labelPrinted');
  });

  it('an invited member or viewer: home done by joining, no invite and no AI step', async () => {
    const owner = await person(t, db, 'olga');
    const loc = await createLocation(owner, 'complete');
    const vic = await person(t, db, 'vic');
    await join(db, loc.id, ann.userId, 'member');
    await join(db, loc.id, vic.userId, 'viewer');
    for (const p of [ann, vic]) {
      expect((await home(p)).checklist.items).toEqual([
        { key: 'locationCreated', done: true },
        { key: 'threeThings', done: false },
        { key: 'labelPrinted', done: false },
        { key: 'installed', done: false },
      ]);
    }
    // An admin of someone else's home is not an invited member: she can invite.
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.memberships SET role = 'admin' WHERE location_id = $1 AND user_id = $2`,
        [loc.id, ann.userId],
      ),
    );
    expect(keys(await home(ann))).toEqual([
      'locationCreated',
      'threeThings',
      'labelPrinted',
      'invited',
      'aiConnected',
      'installed',
    ]);
    expect(done(await home(ann), 'invited')).toBe(true);
  });

  it('flips "installed" once Kept posts the installed_standalone hint', async () => {
    expect(done(await home(ann), 'installed')).toBe(false);
    expect((await putHint(ann, 'installed_standalone', { seen: true })).statusCode).toBe(204);
    expect(done(await home(ann), 'installed')).toBe(true);
  });

  it('dismissal is the checklist hint, and every device agrees (D138)', async () => {
    const phone = await secondDevice(ann);
    expect((await home(phone)).checklist.dismissed).toBe(false);
    expect((await putHint(ann, 'checklist', { dismissed: true })).statusCode).toBe(204);
    expect((await home(phone)).checklist.dismissed).toBe(true);
    // Help brings it back, from the phone this time.
    expect((await putHint(phone, 'checklist', { dismissed: false })).statusCode).toBe(204);
    expect((await home(ann)).checklist.dismissed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/home: attention counts and location cards', () => {
  let ann: Person;
  let bob: Person;
  let vic: Person;
  let loc: Loc;
  let bobs: Loc;

  beforeAll(async () => {
    ann = await person(t, db, 'ann');
    bob = await person(t, db, 'bob');
    vic = await person(t, db, 'vic');
    loc = await createLocation(ann, 'essentials');
    await join(db, loc.id, vic.userId, 'viewer');
    bobs = await createLocation(bob, 'household', 'Bob home');

    const shelf = await place(loc, 'Shelf');
    await thing(loc, { by: ann, placeId: shelf });
    await thing(loc, { by: ann, placeId: shelf, uncertain: true });
    await thing(loc, { by: ann }); // Unplaced
    await thing(loc, { by: ann }); // Unplaced
    await thing(loc, { by: ann, deleted: true }); // Unplaced, but trashed
    await thing(loc, { placeId: shelf, lastSeenAt: '2020-01-01' }); // long unseen
    await thing(loc, { placeId: shelf, lastSeenAt: '2020-01-01', lifecycle: 'sold' }); // ended
    await toReview(loc, 2); // one thing, two readings to review
    await thing(await personal(ann), { by: ann }); // Unplaced in Personal

    // Bob's home: one of everything, none of which Ann may ever count.
    await thing(bobs, { by: bob });
    await thing(bobs, { by: bob, uncertain: true, lastSeenAt: '2019-01-01' });
    await toReview(bobs);
  });

  it('counts each row over the locations she can see (§8 order; one per thing)', async () => {
    expect((await home(ann)).attention).toEqual({
      toReview: 1,
      uncertain: 1,
      longUnseen: 1,
      unplaced: 3,
      ...NO_AGENDA,
    });
  });

  it('never counts a thing in someone else’s location (RLS)', async () => {
    expect((await home(bob)).attention).toEqual({
      toReview: 1,
      uncertain: 1,
      longUnseen: 1,
      unplaced: 2,
      ...NO_AGENDA,
    });
  });

  it('gives a viewer the counts of the location she views, and nothing of Ann’s Personal', async () => {
    const h = await home(vic);
    expect(h.attention).toEqual({
      toReview: 1,
      uncertain: 1,
      longUnseen: 1,
      unplaced: 2,
      ...NO_AGENDA,
    });
    expect(h.locations.map((l) => l.id).sort()).toEqual([vic.personalLocationId, loc.id].sort());
  });

  it('agrees with the search list each row opens (task 29)', async () => {
    const a = (await home(ann)).attention;
    const states = {
      toReview: 'to_review',
      uncertain: 'uncertain',
      longUnseen: 'long_unseen',
      unplaced: 'unplaced',
    } as const;
    for (const [row, state] of Object.entries(states)) {
      const res = await call(t, `/api/v1/search?state=${state}&kind=things&limit=100`, { as: ann });
      expect(res.statusCode, res.body).toBe(200);
      const found = (res.json() as { things: { items: unknown[] } }).things.items.length;
      expect(found, state).toBe(a[row as keyof typeof a]);
    }
  });

  it('lists her locations, Personal first, with thing and Unplaced counts', async () => {
    // Seven things in her Home (the trashed one aside), one of them sold: the card counts six.
    expect((await home(ann)).locations).toEqual([
      { id: ann.personalLocationId, thingCount: 1, unplacedCount: 1 },
      { id: loc.id, thingCount: 6, unplacedCount: 2 },
    ]);
    expect((await home(bob)).locations).toEqual([
      { id: bob.personalLocationId, thingCount: 0, unplacedCount: 0 },
      { id: bobs.id, thingCount: 3, unplacedCount: 2 },
    ]);
  });

  it('uses the location’s own long_unseen_months', async () => {
    const recent = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const cabin = await createLocation(bob, 'household', 'Cabin');
    await thing(cabin, { by: bob, lastSeenAt: recent });
    expect((await home(bob)).attention.longUnseen).toBe(1);
    await own('UPDATE public.locations SET long_unseen_months = 1 WHERE id = $1', [cabin.id]);
    expect((await home(bob)).attention.longUnseen).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe('hints: GET /api/v1/me/hints, PUT /api/v1/me/hints/:key (D138)', () => {
  let ann: Person;

  beforeEach(async () => {
    ann = await person(t, db, 'ann');
  });

  it('starts empty, and needs a session', async () => {
    expect(await hints(ann)).toEqual([]);
    expect((await call(t, '/api/v1/me/hints')).statusCode).toBe(401);
    expect((await putHint({ ...ann, cookie: '' }, 'camera', { seen: true })).statusCode).toBe(401);
  });

  // catalogue: PUT /api/v1/me/hints/:key
  it('records a hint as seen once, with an account-level audit row', async () => {
    const before = Date.now();
    expect((await putHint(ann, 'capture.mode_strip', { seen: true })).statusCode).toBe(204);
    const [h] = await hints(ann);
    expect(h).toMatchObject({ key: 'capture.mode_strip', dismissedAt: null });
    expect(Date.parse(h?.seenAt ?? '')).toBeGreaterThanOrEqual(before - 1000);

    // Seeing it again changes nothing and writes nothing.
    expect((await putHint(ann, 'capture.mode_strip', { seen: true })).statusCode).toBe(204);
    expect((await hints(ann))[0]?.seenAt).toBe(h?.seenAt);

    const audit = await hintAudit(ann);
    expect(audit).toEqual([
      {
        action: 'hint.seen',
        location_id: null,
        owner_account_id: await ownerAccountOf(ann),
        diff: {
          'capture.mode_strip': {
            before: { seen: false, dismissed: false },
            after: { seen: true, dismissed: false },
            class: 'plain',
          },
        },
      },
    ]);
  });

  // catalogue: PUT /api/v1/me/hints/:key
  it('audits a dismissal and its undo, and reports when it was dismissed', async () => {
    expect((await putHint(ann, 'checklist', { dismissed: true })).statusCode).toBe(204);
    const [dismissed] = await hints(ann);
    expect(dismissed?.key).toBe('checklist');
    expect(dismissed?.dismissedAt).not.toBeNull();
    expect(dismissed?.seenAt).not.toBeNull();

    expect((await putHint(ann, 'checklist', { dismissed: true })).statusCode).toBe(204);
    expect((await putHint(ann, 'checklist', { dismissed: false })).statusCode).toBe(204);
    expect(await hints(ann)).toEqual([
      { key: 'checklist', seenAt: dismissed?.seenAt, dismissedAt: null },
    ]);

    const audit = await hintAudit(ann);
    expect(audit.map((e) => e.action)).toEqual(['hint.dismiss', 'hint.restore']);
    expect(audit[0]?.diff).toEqual({
      checklist: {
        before: { seen: false, dismissed: false },
        after: { seen: true, dismissed: true },
        class: 'plain',
      },
    });
    expect(audit[1]?.diff).toEqual({
      checklist: {
        before: { seen: true, dismissed: true },
        after: { seen: true, dismissed: false },
        class: 'plain',
      },
    });

    // Dismissed again later: dismissedAt is the newer dismissal.
    await new Promise((r) => setTimeout(r, 5));
    expect((await putHint(ann, 'checklist', { dismissed: true })).statusCode).toBe(204);
    const [again] = await hints(ann);
    expect(Date.parse(again?.dismissedAt ?? '')).toBeGreaterThan(
      Date.parse(dismissed?.dismissedAt ?? ''),
    );
  });

  it('restoring a hint never seen stores nothing', async () => {
    expect((await putHint(ann, 'checklist', { dismissed: false })).statusCode).toBe(204);
    expect(await hints(ann)).toEqual([]);
    expect(await hintAudit(ann)).toEqual([]);
  });

  it('refuses a malformed key or an empty body', async () => {
    for (const key of ['Camera', 'has space', 'x'.repeat(65), 'ünï', 'made.up_hint']) {
      expect((await putHint(ann, key, { seen: true })).statusCode, key).toBe(400);
    }
    expect((await putHint(ann, 'camera', {})).statusCode).toBe(400);
    expect((await putHint(ann, 'camera', { seen: 'yes' })).statusCode).toBe(400);
  });

  it('keeps each person’s hints their own (RLS)', async () => {
    const bob = await person(t, db, 'bob');
    await putHint(ann, 'checklist', { dismissed: true });
    await putHint(ann, 'installed_standalone', { seen: true });
    expect(await hints(bob)).toEqual([]);
    const h = await home(bob);
    expect(h.checklist.dismissed).toBe(false);
    expect(done(h, 'installed')).toBe(false);
  });

  it('are the same on every device', async () => {
    const phone = await secondDevice(ann);
    await putHint(ann, 'inbox.suggested', { seen: true, dismissed: true });
    expect(await hints(phone)).toEqual(await hints(ann));
    expect((await hints(phone))[0]).toMatchObject({ key: 'inbox.suggested' });
  });
});

// ---------------------------------------------------------------------------------------------
// Step 3 (T22): "connect AI" follows the provider, the inbox joins "to review", and the counts.

/** An account-scope AI provider on `owner`'s account (sealed as T9 seals it). */
async function connectAi(owner: Person): Promise<void> {
  const id = newId();
  const [acct] = await own<{ id: string }>(
    'SELECT id FROM public.owner_accounts WHERE user_id = $1',
    [owner.userId],
  );
  const master = { key: Buffer.alloc(32, 7), keyVersion: 1 };
  await own(
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $2, 'groq', $3, 1, '{"vision": "qwen/qwen3.8-27b"}', $4)`,
    [
      id,
      acct?.id,
      JSON.stringify(seal(master, 'gsk_TESTKEY-home', providerKeyAad(id))),
      owner.userId,
    ],
  );
}

/** An open inbox item, as capture and extraction leave them (as kept_owner). */
async function inboxItem(
  loc: Loc,
  by: Person,
  item: { kind: string; thingId?: string; meterReadingId?: string; resolved?: boolean },
): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, meter_reading_id,
                                     created_by, resolved_at, resolution)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END,
             CASE WHEN $7 THEN 'accepted' END)`,
    [
      id,
      loc.id,
      item.kind,
      item.thingId ?? null,
      item.meterReadingId ?? null,
      by.userId,
      item.resolved ?? false,
    ],
  );
  return id;
}

describe('GET /api/v1/home: "connect AI" follows the provider (D191)', () => {
  let ann: Person;

  beforeEach(async () => {
    ann = await person(t, db, 'ann');
  });

  it('ticks once a provider resolves where she administers', async () => {
    await createLocation(ann, 'household');
    expect(done(await home(ann), 'aiConnected')).toBe(false);
    await connectAi(ann);
    expect(done(await home(ann), 'aiConnected')).toBe(true);
  });

  it('shows on Essentials once she opened AI settings, or a provider is connected', async () => {
    const loc = await createLocation(ann, 'essentials');
    expect(keys(await home(ann))).not.toContain('aiConnected');
    expect((await putHint(ann, 'ai_settings_opened', { seen: true })).statusCode).toBe(204);
    expect(done(await home(ann), 'aiConnected')).toBe(false);
    await connectAi(ann);
    expect(done(await home(ann), 'aiConnected')).toBe(true);
    // Both AI modules switched off there: nothing to connect for.
    await switchModule(loc.id, 'ai_capture', false);
    await switchModule(loc.id, 'ai_assistant', false);
    expect(keys(await home(ann))).not.toContain('aiConnected');
  });

  it('shows on Essentials when the provider comes first, without the hint', async () => {
    await createLocation(ann, 'essentials');
    await connectAi(ann);
    expect(done(await home(ann), 'aiConnected')).toBe(true);
  });

  it('never shows to an invited member, even with a provider (screens §5)', async () => {
    const owner = await person(t, db, 'olga');
    const loc = await createLocation(owner, 'household', 'Olga home');
    await join(db, loc.id, ann.userId, 'member');
    await connectAi(owner);
    expect(keys(await home(ann))).not.toContain('aiConnected');
    expect(done(await home(owner), 'aiConnected')).toBe(true);
  });
});

describe('GET /api/v1/home: "a label printed" through the labels flow (T16)', () => {
  it('flips when a batch is confirmed printed, and counts what is still unprinted', async () => {
    const ann = await person(t, db, 'ann');
    const loc = await createLocation(ann, 'household');
    const made: string[] = [];
    for (const name of ['Drill', 'Saw']) {
      const res = await call(t, '/api/v1/things', {
        as: ann,
        body: { locationId: loc.id, placeId: loc.unplacedId, name },
      });
      expect(res.statusCode, res.body).toBe(201);
      made.push((res.json() as { id: string }).id);
    }
    let h = await home(ann);
    expect(done(h, 'labelPrinted')).toBe(false);
    expect(h.counts.unprintedLabels).toBe(2);

    const batch = await call(t, '/api/v1/labels/batches', {
      as: ann,
      body: { locationId: loc.id, kind: 'things', thingIds: [made[0]], stock: 'a4_24_70x37' },
    });
    expect(batch.statusCode, batch.body).toBe(201);
    const batchId = (batch.json() as { batch: { id: string } }).batch.id;
    expect(done(await home(ann), 'labelPrinted')).toBe(false);
    const printed = await call(t, `/api/v1/labels/batches/${batchId}/printed`, {
      as: ann,
      body: {},
    });
    expect(printed.statusCode, printed.body).toBe(200);
    h = await home(ann);
    expect(done(h, 'labelPrinted')).toBe(true);
    expect(h.counts.unprintedLabels).toBe(1);

    // Labels off everywhere: no step, and nothing counted.
    await switchModule(ann.personalLocationId, 'labels', false);
    await switchModule(loc.id, 'labels', false);
    h = await home(ann);
    expect(keys(h)).not.toContain('labelPrinted');
    expect(h.counts.unprintedLabels).toBe(0);
  });
});

describe('GET /api/v1/home: the inbox in "to review" and the Inbox badge (T22, T27)', () => {
  let ibrahim: Person; // owner of Home
  let bruce: Person; // admin of Home
  let louis: Person; // member of Home
  let talia: Person; // viewer of Home
  let alfred: Person; // another household
  let loc: Loc;

  beforeAll(async () => {
    ibrahim = await person(t, db, 'ibrahim');
    bruce = await person(t, db, 'bruce');
    louis = await person(t, db, 'louis');
    talia = await person(t, db, 'talia');
    alfred = await person(t, db, 'alfred');
    loc = await createLocation(ibrahim, 'household');
    await join(db, loc.id, bruce.userId, 'admin');
    await join(db, loc.id, louis.userId, 'member');
    await join(db, loc.id, talia.userId, 'viewer');
    const theirs = await createLocation(alfred, 'household', 'بيت العائلة');

    // Two drafts: Louis's and Ibrahim's ("Mine" and everyone's both count).
    await inboxItem(loc, louis, { kind: 'draft', thingId: await thing(loc, { by: louis }) });
    await inboxItem(loc, ibrahim, { kind: 'draft', thingId: await thing(loc, { by: ibrahim }) });
    // Resolved, and one whose draft is in the trash: neither counts.
    await inboxItem(loc, louis, { kind: 'draft', thingId: await thing(loc), resolved: true });
    await inboxItem(loc, louis, { kind: 'draft', thingId: await thing(loc, { deleted: true }) });
    // A photo reading waiting as an inbox item: one item, not also a reading to review.
    const metered = await toReview(loc);
    const [reading] = await own<{ id: string }>(
      `SELECT r.id FROM public.meter_readings r JOIN public.meters m ON m.id = r.meter_id
        WHERE m.thing_id = $1`,
      [metered],
    );
    await inboxItem(loc, louis, { kind: 'reading', meterReadingId: reading?.id as string });
    // A reading to review with no inbox item: counted as a reading.
    await toReview(loc);
    // Alfred's own household: never counted for anyone else.
    await inboxItem(theirs, alfred, {
      kind: 'draft',
      thingId: await thing(theirs, { by: alfred }),
    });
  });

  it('counts open items of every writable location, mine and everyone’s, per role', async () => {
    for (const p of [ibrahim, bruce, louis]) {
      const h = await home(p);
      expect(h.counts.inbox).toBe(3);
      expect(h.attention.toReview).toBe(4); // 3 items + the reading without one
    }
  });

  it('gives a viewer no inbox: only the readings to review, both of them', async () => {
    const h = await home(talia);
    expect(h.counts.inbox).toBe(0);
    expect(h.attention.toReview).toBe(2);
  });

  it('never counts another household’s items (RLS)', async () => {
    const h = await home(alfred);
    expect(h.counts.inbox).toBe(1);
    expect(h.attention.toReview).toBe(1);
  });

  it('agrees with the inbox list it opens (everyone’s)', async () => {
    const res = await call(t, '/api/v1/inbox?mine=0&limit=100', { as: louis });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: unknown[] };
    expect(page.items).toHaveLength((await home(louis)).counts.inbox);
  });
});

describe('hints: every step-3 hint key round-trips (D138)', () => {
  it('accepts each of HINT_KEYS, seen then dismissed, and reads them back', async () => {
    const ann = await person(t, db, 'ann');
    for (const key of HINT_KEYS) {
      expect((await putHint(ann, key, { seen: true })).statusCode, key).toBe(204);
    }
    await putHint(ann, 'labels.first_print', { dismissed: true });
    const got = await hints(ann);
    expect(got.map((h) => h.key)).toEqual([...HINT_KEYS].sort());
    expect(got.every((h) => h.seenAt !== null)).toBe(true);
    expect(got.find((h) => h.key === 'labels.first_print')?.dismissedAt).not.toBeNull();
    expect(got.find((h) => h.key === 'scan.first_open')?.dismissedAt).toBeNull();
  });
});
