import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { newId, SHARE_LINK_VIEWS_PER_MINUTE } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { createLogger } from '../http/logger.js';
import { derivativeKey } from '../storage/blob-store.js';

// Read-only share links through the front door (1.5, D233; D39 item 7, D72, D116, D180): made by
// a location's owner or admin, shown once and stored as a hash; the public page shows the D116
// whitelist and nothing else, for the box, place or list shared, with photos as short-lived URLs
// for those things only; revoked, expired or unbacked links are a 404 that never says which; views
// are counted and limited; the token never reaches a log line.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const lines: string[] = [];

beforeAll(async () => {
  db = await testDb();
  files = await testFiles();
  const logger = createLogger(
    { KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' },
    new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  t = await peopleApp(db, { files, logger });
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

beforeEach(async () => {
  await db.reset();
  lines.length = 0;
});

type Link = {
  id: string;
  scope: string;
  subject: { id: string; name: string | null } | null;
  title: string | null;
  state: string;
  views: number;
  revokedAt: string | null;
  expiresAt: string;
};
type Shared = {
  scope: string;
  title: string | null;
  thing: Record<string, unknown> | null;
  place: Record<string, unknown> | null;
  total: number;
  nextPage: number | null;
  items: {
    name: string;
    path: { name: string }[];
    photo: { url: string; thumbUrl: string | null } | null;
  }[];
};

const shareLinks = (loc: Loc) => `/api/v1/locations/${loc.id}/share-links`;

async function share(
  as: Person,
  loc: Loc,
  body: Record<string, unknown>,
): Promise<{ link: Link; url: string; path: string; token: string }> {
  const res = await call(t, `/api/v1/locations/${loc.id}/share-links`, { as, body });
  expect(res.statusCode, res.body).toBe(201);
  const out = res.json() as { link: Link; url: string };
  const p = new URL(out.url).pathname;
  return { ...out, path: p, token: p.slice('/s/'.length) };
}

const linksOf = async (as: Person, loc: Loc) =>
  (ok(await call(t, shareLinks(loc), { as })) as unknown as { items: Link[] }).items;

const open = (token: string, page?: number) =>
  t.app.inject({
    method: 'GET',
    url: `/api/v1/shared/${token}${page === undefined ? '' : `?page=${page}`}`,
  });

const shared = async (token: string) => {
  const res = await open(token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Shared;
};

/** A cover photo for `thingId`, with its thumb and share renditions in the store. */
async function photo(loc: Loc, thingId: string, by: Person): Promise<string> {
  const file = newId();
  await own(
    db,
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
    [file, loc.id, `f/${loc.id}/${file}`, file.replaceAll('-', '').padEnd(64, '0'), by.userId],
  );
  for (const variant of ['thumb', 'share'] as const) {
    const key = derivativeKey(file, variant);
    const tmp = path.join(files.dir, `${file}-${variant}.jpg`);
    await writeFile(tmp, `jpeg ${variant}`);
    await files.blobs.put(key, tmp, { contentType: 'image/jpeg', bytes: 10 });
    await own(
      db,
      `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                            height, bytes)
       VALUES ($1, $2, $3, $4, 10, 10, 10)`,
      [file, variant, loc.id, key],
    );
  }
  await own(
    db,
    `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
     VALUES ($1, $2, $3, 'photo', $4)`,
    [loc.id, file, thingId, by.userId],
  );
  return file;
}

/** Home with a garage shelf, a box on it holding a drill (and a pouch with bits), and things
 * that must not show: a draft, a trashed thing, a sold one. The drill carries everything D116
 * keeps off the page: a price, a serial, a model, a brand, an owner, a tag. */
async function household(owner: Person) {
  const home = await createLocation(t, db, owner, 'complete');
  const garage = await place(db, home, 'Garage');
  const shelf = await place(db, home, 'Shelf 2', garage);
  const boxType = await builtinType(db, 'box_bin');
  const box = await createThing(t, owner, home, {
    name: 'Camping box',
    typeId: boxType,
    placeId: shelf,
    notes: 'Blue lid',
  });
  const [person] = await own<{ id: string }>(
    db,
    `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Selina Kyle')
     RETURNING id`,
    [home.accountId],
  );
  const [brand] = await own<{ id: string }>(
    db,
    `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Wayne Tools') RETURNING id`,
    [home.accountId],
  );
  const [tag] = await own<{ id: string }>(
    db,
    `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'camping') RETURNING id`,
    [home.accountId],
  );
  const drill = await createThing(t, owner, home, {
    name: 'Cordless drill',
    containerId: box.id,
    quantity: 2,
    condition: 'good',
    notes: 'Charger in the side pocket',
    serial: 'SN-SECRET-4471',
    model: 'DX-990',
    brandId: brand?.id,
    belongsToPersonId: person?.id,
    tagIds: [tag?.id],
    purchase: { purchasedOn: '2024-03-12', currency: 'EGP', price: '987654' },
  });
  const pouch = await createThing(t, owner, home, { name: 'Bit pouch', containerId: box.id });
  const bits = await createThing(t, owner, home, { name: 'Drill bits', containerId: pouch.id });
  const draft = await createThing(t, owner, home, { name: 'Draft lantern', containerId: box.id });
  await own(db, `UPDATE public.things SET review_state = 'draft' WHERE id = $1`, [draft.id]);
  const trashed = await createThing(t, owner, home, { name: 'Old stove', containerId: box.id });
  await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [trashed.id]);
  const sold = await createThing(t, owner, home, { name: 'Sold tent', containerId: box.id });
  await own(db, `UPDATE public.things SET lifecycle = 'sold' WHERE id = $1`, [sold.id]);
  const lamp = await createThing(t, owner, home, { name: 'Desk lamp', placeId: garage });
  return { home, garage, shelf, box, drill, pouch, bits, lamp, tag: tag?.id as string };
}

describe('making, listing and revoking links', () => {
  // catalogue: POST /api/v1/locations/:id/share-links
  it('makes a link shown once and stored as a hash, audited without the token', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const made = await share(bruce, h.home, { thingId: h.box.id });
    expect(made.url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9_-]{43}$/);
    expect(made.link).toMatchObject({
      scope: 'thing',
      subject: { id: h.box.id, name: 'Camping box' },
      state: 'active',
      views: 0,
      revokedAt: null,
    });
    // 30 days by default.
    const days = (Date.parse(made.link.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.01); // the database's clock against this one
    const [row] = await own<{ token_hash: string }>(
      db,
      'SELECT token_hash FROM public.share_links WHERE id = $1',
      [made.link.id],
    );
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(made.token);
    const listed = await linksOf(bruce, h.home);
    expect(listed.map((l) => l.id)).toEqual([made.link.id]);
    expect(JSON.stringify(listed)).not.toContain(made.token);
    const events = await eventsOf(db, h.home.id, made.link.id);
    expect(events.map((e) => e.action)).toEqual(['share_link.create']);
    expect(JSON.stringify(events)).not.toContain(made.token);
    expect(events[0]?.diff).toMatchObject({ scope_type: { after: 'thing' } });
  });

  it('is for the location’s owner and admins only, never in Personal', async () => {
    const bruce = await person(t, db, 'bruce');
    const alfred = await person(t, db, 'alfred');
    const dick = await person(t, db, 'dick');
    const jason = await person(t, db, 'jason');
    const h = await household(bruce);
    await join(db, h.home.id, alfred.userId, 'admin');
    await join(db, h.home.id, dick.userId, 'member');
    const body = { placeId: h.garage };
    expect((await call(t, shareLinks(h.home), { as: alfred, body })).statusCode).toBe(201);
    expect((await call(t, shareLinks(h.home), { as: dick, body })).statusCode).toBe(403);
    expect((await call(t, shareLinks(h.home), { as: dick })).statusCode).toBe(403);
    expect((await call(t, shareLinks(h.home), { as: jason, body })).statusCode).toBe(404);
    const personal = { id: bruce.personalLocationId } as Loc;
    const res = await call(t, shareLinks(personal), {
      as: bruce,
      body: { view: {}, title: 'Mine' },
    });
    expect(res.statusCode).toBe(400);
    // A box of another location, or none at all.
    const other = await createLocation(t, db, bruce, 'essentials', 'Office');
    expect(
      (await call(t, shareLinks(other), { as: bruce, body: { thingId: h.box.id } })).statusCode,
    ).toBe(404);
    expect(
      (await call(t, shareLinks(h.home), { as: bruce, body: { expiresInDays: 7 } })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(t, shareLinks(h.home), {
          as: bruce,
          body: { placeId: h.garage, expiresInDays: 366 },
        })
      ).statusCode,
    ).toBe(400);
  });

  // catalogue: DELETE /api/v1/share-links/:id
  it('revokes a link (audited): it stops at once, and the list says so', async () => {
    const bruce = await person(t, db, 'bruce');
    const dick = await person(t, db, 'dick');
    const h = await household(bruce);
    await join(db, h.home.id, dick.userId, 'member');
    const made = await share(bruce, h.home, { placeId: h.garage });
    expect((await open(made.token)).statusCode).toBe(200);
    const revoke = (as: Person) =>
      call(t, `/api/v1/share-links/${made.link.id}`, { as, method: 'DELETE' });
    expect((await revoke(dick)).statusCode).toBe(404);
    expect((await revoke(bruce)).statusCode).toBe(204);
    expect((await revoke(bruce)).statusCode).toBe(404);
    expect((await open(made.token)).statusCode).toBe(404);
    const [link] = await linksOf(bruce, h.home);
    expect(link?.state).toBe('revoked');
    expect(link?.revokedAt).not.toBeNull();
    const events = await eventsOf(db, h.home.id, made.link.id);
    expect(events.map((e) => e.action)).toEqual(['share_link.create', 'share_link.revoke']);
    expect(events[1]?.diff).toMatchObject({ revoked_at: { before: null } });
  });

  it('caps a location at 100 live links (409)', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    await own(
      db,
      `INSERT INTO public.share_links (location_id, scope_type, place_id, token_hash, expires_at,
                                       created_by)
       SELECT $1, 'place', $2, encode(sha256(convert_to(g::text, 'UTF8')), 'hex'),
              now() + interval '1 day', $3
         FROM generate_series(1, 100) g`,
      [h.home.id, h.garage, bruce.userId],
    );
    const res = await call(t, shareLinks(h.home), { as: bruce, body: { placeId: h.garage } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ hint: expect.stringContaining('100 live share links') });
  });
});

describe('GET /api/v1/shared/:token', () => {
  it('shows a box and what is in it, the D116 whitelist and nothing else', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const made = await share(bruce, h.home, { thingId: h.box.id });
    const res = await open(made.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const page = res.json() as Shared;
    expect(page.thing).toEqual({
      name: 'Camping box',
      type: { icon: expect.any(String), name: null, builtinKey: 'box_bin' },
      path: [
        { name: 'Garage', kind: 'place', isUnplaced: false },
        { name: 'Shelf 2', kind: 'place', isUnplaced: false },
      ],
      quantity: 1,
      condition: null,
      description: 'Blue lid',
      photo: null,
    });
    expect(page.items.map((i) => i.name)).toEqual(['Bit pouch', 'Cordless drill', 'Drill bits']);
    expect(page.total).toBe(3);
    expect(page.nextPage).toBeNull();
    expect(page.items[1]).toEqual({
      name: 'Cordless drill',
      type: null,
      path: [
        { name: 'Garage', kind: 'place', isUnplaced: false },
        { name: 'Shelf 2', kind: 'place', isUnplaced: false },
        { name: 'Camping box', kind: 'container', isUnplaced: false },
      ],
      quantity: 2,
      condition: 'good',
      description: 'Charger in the side pocket',
      photo: null,
    });
    const body = res.body;
    for (const leak of [
      'SN-SECRET-4471',
      'DX-990',
      'Wayne Tools',
      'Selina Kyle',
      'camping',
      '987654',
      'EGP',
      'Draft lantern',
      'Old stove',
      'Sold tent',
      'Desk lamp',
      h.box.id,
      h.drill.id,
      h.home.id,
      bruce.userId,
    ]) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('serves the cover photos of the things it shows, as short-lived URLs', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const file = await photo(h.home, h.drill.id, bruce);
    const outside = await photo(h.home, h.lamp.id, bruce);
    const made = await share(bruce, h.home, { thingId: h.box.id });
    const res = await open(made.token);
    const drill = (res.json() as Shared).items.find((i) => i.name === 'Cordless drill');
    expect(drill?.photo?.url).toMatch(/^\/f\//);
    expect(drill?.photo?.thumbUrl).toMatch(/^\/f\//);
    const bytes = await t.app.inject({ method: 'GET', url: drill?.photo?.url as string });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe('jpeg share');
    const maxAge = Number(bytes.headers['cache-control']?.toString().match(/max-age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(300);
    // Only the shared things' photos: the lamp is in the garage, not in the box.
    expect(res.body).not.toContain(outside);
    expect(res.body).not.toContain(`f/${h.home.id}/${file}`);
  });

  it('shows a place and everything under it, boxes and sub-places included', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const made = await share(bruce, h.home, { placeId: h.garage });
    const page = await shared(made.token);
    expect(page.place).toEqual({ name: 'Garage', isUnplaced: false, path: [] });
    expect(page.thing).toBeNull();
    expect(page.items.map((i) => i.name)).toEqual([
      'Bit pouch',
      'Camping box',
      'Cordless drill',
      'Desk lamp',
      'Drill bits',
    ]);
  });

  it('shows a filtered list: its words and filters, in its location only', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const office = await createLocation(t, db, bruce, 'essentials', 'Office');
    await createThing(t, bruce, office, { name: 'Office drill' });
    const words = await share(bruce, h.home, { view: { q: 'drill' }, title: 'Drills' });
    let page = await shared(words.token);
    expect(page).toMatchObject({ scope: 'view', title: 'Drills', thing: null, place: null });
    expect(page.items.map((i) => i.name)).toEqual(['Cordless drill', 'Drill bits']);

    const tagged = await share(bruce, h.home, {
      view: { filters: { tag: [h.tag] } },
      title: 'Camping',
    });
    page = await shared(tagged.token);
    expect(page.items.map((i) => i.name)).toEqual(['Cordless drill']);

    const notInBox = await share(bruce, h.home, {
      view: { filters: { place: [h.box.id] }, not: ['place'] },
      title: 'Not packed',
    });
    page = await shared(notInBox.token);
    expect(page.items.map((i) => i.name)).toEqual(['Camping box', 'Desk lamp']);

    // A place of another location is refused when the link is made.
    const res = await call(t, shareLinks(h.home), {
      as: bruce,
      body: { view: { filters: { place: [office.unplacedId] } }, title: 'Elsewhere' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers 404 for anything that does not open, never saying which', async () => {
    const bruce = await person(t, db, 'bruce');
    const alfred = await person(t, db, 'alfred');
    const h = await household(bruce);
    await join(db, h.home.id, alfred.userId, 'admin');
    const unknown = await open('A'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    expect((await open('short')).statusCode).toBe(404);

    // Expired.
    const expired = await share(bruce, h.home, { placeId: h.garage });
    await own(
      db,
      `UPDATE public.share_links SET created_at = now() - interval '40 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [expired.link.id],
    );
    const gone = await open(expired.token);
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toBe(unknown.body);

    // Its creator no longer administers the location (D180): stopped, and back if they do again.
    const byAlfred = await share(alfred, h.home, { placeId: h.garage });
    expect((await open(byAlfred.token)).statusCode).toBe(200);
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [h.home.id, alfred.userId],
    );
    expect((await open(byAlfred.token)).statusCode).toBe(404);
    const states = Object.fromEntries((await linksOf(bruce, h.home)).map((l) => [l.id, l.state]));
    expect(states).toMatchObject({ [expired.link.id]: 'expired', [byAlfred.link.id]: 'stopped' });

    // The box left the location, or went to the trash.
    const boxLink = await share(bruce, h.home, { thingId: h.pouch.id });
    expect((await open(boxLink.token)).statusCode).toBe(200);
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [h.pouch.id]);
    expect((await open(boxLink.token)).statusCode).toBe(404);
    const office = await createLocation(t, db, bruce, 'essentials', 'Office');
    const moved = await share(bruce, h.home, { thingId: h.drill.id });
    expect((await open(moved.token)).statusCode).toBe(200);
    await own(
      db,
      'UPDATE public.things SET location_id = $2, place_id = $3, container_id = NULL WHERE id = $1',
      [h.drill.id, office.id, office.unplacedId],
    );
    expect((await open(moved.token)).statusCode).toBe(404);

    // A banned creator.
    const banned = await share(bruce, h.home, { placeId: h.garage });
    await own(db, 'UPDATE auth."user" SET banned = true WHERE id = $1', [bruce.userId]);
    expect((await open(banned.token)).statusCode).toBe(404);
  });

  it('counts a view per opening, and allows 60 a minute per link', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const made = await share(bruce, h.home, { placeId: h.garage });
    await open(made.token);
    await open(made.token, 1);
    let [link] = await linksOf(bruce, h.home);
    expect(link?.views).toBe(1);
    for (let i = 2; i < SHARE_LINK_VIEWS_PER_MINUTE; i++) {
      expect((await open(made.token)).statusCode).toBe(200);
    }
    const over = await open(made.token);
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    [link] = await linksOf(bruce, h.home);
    expect(link?.views).toBeGreaterThanOrEqual(SHARE_LINK_VIEWS_PER_MINUTE - 1);
  });

  it('pages A to Z, 60 at a time', async () => {
    const bruce = await person(t, db, 'bruce');
    const home = await createLocation(t, db, bruce, 'essentials');
    const room = await place(db, home, 'Store room');
    await own(
      db,
      `INSERT INTO public.things (location_id, place_id, name, place_path)
       SELECT $1, $2, 'Jar ' || lpad(g::text, 3, '0'), 'Store room' FROM generate_series(1, 70) g`,
      [home.id, room],
    );
    const made = await share(bruce, home, { placeId: room });
    const first = await shared(made.token);
    expect(first.total).toBe(70);
    expect(first.items).toHaveLength(60);
    expect(first.nextPage).toBe(1);
    const second = (await open(made.token, 1)).json() as Shared;
    expect(second.items.map((i) => i.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Jar ${String(61 + i).padStart(3, '0')}`),
    );
    expect(second.nextPage).toBeNull();
  });

  it('never writes the token to a log line (D181)', async () => {
    const bruce = await person(t, db, 'bruce');
    const h = await household(bruce);
    const made = await share(bruce, h.home, { placeId: h.garage });
    await open(made.token);
    await t.app.inject({ method: 'GET', url: made.path });
    expect(lines.join('\n')).not.toContain(made.token);
    expect(lines.join('\n')).toContain('/api/v1/shared/[redacted]');
  });
});

describe('GET /api/v1/share-links/:id/preview', () => {
  it('shows the location’s admins what a recipient sees, without counting a view', async () => {
    const bruce = await person(t, db, 'bruce');
    const dick = await person(t, db, 'dick');
    const h = await household(bruce);
    await join(db, h.home.id, dick.userId, 'member');
    const made = await share(bruce, h.home, { thingId: h.box.id });
    const preview = (as: Person) => call(t, `/api/v1/share-links/${made.link.id}/preview`, { as });
    const res = await preview(bruce);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Shared).items.map((i) => i.name)).toEqual([
      'Bit pouch',
      'Cordless drill',
      'Drill bits',
    ]);
    expect((await preview(dick)).statusCode).toBe(404);
    // A revoked link can still be previewed; nothing was counted.
    await call(t, `/api/v1/share-links/${made.link.id}`, { as: bruce, method: 'DELETE' });
    expect((await preview(bruce)).statusCode).toBe(200);
    expect((await linksOf(bruce, h.home))[0]?.views).toBe(0);
  });
});
