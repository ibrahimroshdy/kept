import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner } from '../../test/tenancy.js';
import { createLocation, type Loc, own } from '../../test/things.js';
import { createLogger } from '../http/logger.js';
import { FEED_FETCHES_PER_MINUTE } from './routes.js';

// The calendar feed through the front door (plan T17; D142, D181, Q23): a link shown once and
// stored as a hash, at most 3 live, revocable; the public .ics in the owner's own scope, with the
// kinds they get and nothing hidden; 404 for anything wrong; 60 fetches a minute; the token never
// in a log line.

let db: TestDb;
let t: TestApp;
const lines: string[] = [];

type Feed = {
  id: string;
  createdAt: string;
  lastFetchedAt: string | null;
  fetches: number;
  revokedAt: string | null;
};

beforeAll(async () => {
  db = await testDb();
  const logger = createLogger(
    { KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' },
    new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  t = await peopleApp(db, { logger });
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await db.reset();
  lines.length = 0;
});

/** The person's account-level audit events, oldest first (as kept_owner). */
const accountAudit = (userId: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; entity_id: string | null }>(
      `SELECT e.action, e.entity_id FROM public.audit_events e
         JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
        WHERE oa.user_id = $1 AND e.location_id IS NULL ORDER BY e.at, e.id`,
      [userId],
    );
    return rows;
  });

async function createFeed(as: Person): Promise<{ id: string; url: string; path: string }> {
  const res = await call(t, '/api/v1/me/calendar-feeds', { as, method: 'POST' });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; url: string };
  return { ...body, path: new URL(body.url).pathname };
}

const feeds = async (as: Person) =>
  ((await call(t, '/api/v1/me/calendar-feeds', { as })).json() as { items: Feed[] }).items;

const fetchFeed = (path: string) => t.app.inject({ method: 'GET', url: path });

/** A thing in `Garage` that expires `inDays` from today (Cairo), a thing-expiry reminder. */
async function expiring(loc: Loc, name: string, inDays: number): Promise<string> {
  const id = newId();
  const place = newId();
  await own(db, 'INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
    place,
    loc.id,
    `Garage ${name}`,
  ]);
  await own(
    db,
    `INSERT INTO public.things (id, location_id, place_id, name, place_path, expires_on)
     VALUES ($1, $2, $3, $4, $5, (now() AT TIME ZONE 'Africa/Cairo')::date + $6::int)`,
    [id, loc.id, place, name, `Garage ${name}`, inDays],
  );
  return id;
}

describe('the feed links', () => {
  // catalogue: POST /api/v1/me/calendar-feeds
  it('makes a link shown once and stored as a hash, at most 3 live, audited', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await createFeed(bruce);
    expect(made.url).toMatch(/^http:\/\/localhost:5173\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    const token = made.path.slice('/cal/'.length, -'.ics'.length);
    const [row] = await own<{ token_hash: string }>(
      db,
      'SELECT token_hash FROM public.calendar_feeds WHERE id = $1',
      [made.id],
    );
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await feeds(bruce)).toEqual([
      expect.objectContaining({ id: made.id, fetches: 0, lastFetchedAt: null, revokedAt: null }),
    ]);
    expect(JSON.stringify(await feeds(bruce))).not.toContain(token);
    const events = await accountAudit(bruce.userId);
    expect(events).toContainEqual({ action: 'calendar_feed.create', entity_id: made.id });
    expect(JSON.stringify(events)).not.toContain(token);

    await createFeed(bruce);
    await createFeed(bruce);
    const fourth = await call(t, '/api/v1/me/calendar-feeds', { as: bruce, method: 'POST' });
    expect(fourth.statusCode).toBe(409);
  });

  // catalogue: DELETE /api/v1/me/calendar-feeds/:id
  it('revokes a link (audited): it answers 404 after, and the list says so', async () => {
    const bruce = await person(t, db, 'bruce');
    const louis = await person(t, db, 'louis');
    const made = await createFeed(bruce);
    expect((await fetchFeed(made.path)).statusCode).toBe(200);
    const del = (as: Person) =>
      call(t, `/api/v1/me/calendar-feeds/${made.id}`, { as, method: 'DELETE' });
    expect((await del(louis)).statusCode).toBe(404);
    expect((await del(bruce)).statusCode).toBe(204);
    expect((await del(bruce)).statusCode).toBe(404);
    expect((await fetchFeed(made.path)).statusCode).toBe(404);
    expect((await feeds(bruce))[0]?.revokedAt).not.toBeNull();
    expect(await accountAudit(bruce.userId)).toContainEqual({
      action: 'calendar_feed.revoke',
      entity_id: made.id,
    });
    // A revoked link no longer counts toward the 3.
    for (let i = 0; i < 3; i++) await createFeed(bruce);
  });
});

describe('GET /cal/:token.ics', () => {
  it('serves the owner’s agenda as all-day events, private and unindexed, counting fetches', async () => {
    const bruce = await person(t, db, 'bruce');
    const home = await createLocation(t, db, bruce, 'complete');
    const drill = await expiring(home, 'Drill', 20);
    await expiring(home, 'Ladder', 500); // past 13 months
    await expiring(home, 'Tent', -60); // more than a month back
    const made = await createFeed(bruce);
    const res = await fetchFeed(made.path);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, max-age=900');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const ics = res.body;
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Expires · Drill');
    expect(unfolded).toContain('DESCRIPTION:Garage Drill · Home');
    expect(unfolded).toContain(`URL:http://localhost:5173/t/${drill}`);
    expect(unfolded).toMatch(
      new RegExp(`UID:thing_expiry-${drill}-date:\\d{4}-\\d{2}-\\d{2}@localhost:5173`),
    );
    expect(unfolded).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
    expect(unfolded).not.toContain('Ladder');
    expect(unfolded).not.toContain('Tent');

    const [feed] = await feeds(bruce);
    expect(feed?.fetches).toBe(1);
    expect(feed?.lastFetchedAt).not.toBeNull();
  });

  it('keeps to the kinds its owner gets, the modules they see, and their language', async () => {
    const bruce = await person(t, db, 'bruce');
    const talia = await person(t, db, 'talia');
    const home = await createLocation(t, db, bruce, 'complete');
    await expiring(home, 'Drill', 10);
    await join(db, home.id, talia.userId, 'viewer');
    const count = async (p: Person) => {
      const made = await createFeed(p);
      const body = (await fetchFeed(made.path)).body;
      await call(t, `/api/v1/me/calendar-feeds/${made.id}`, { as: p, method: 'DELETE' });
      return (body.match(/BEGIN:VEVENT/g) ?? []).length;
    };
    expect(await count(bruce)).toBe(1);
    // A viewer gets no reminder kinds by default (Q8).
    expect(await count(talia)).toBe(0);

    // Every channel off for thing expiries: gone.
    const off = ['inapp', 'email', 'webpush', 'webhook'].map((channel) => ({
      locationId: home.id,
      kind: 'thing_expiry',
      channel,
      enabled: false,
    }));
    const put = await call(t, '/api/v1/me/notification-preferences', {
      as: bruce,
      method: 'PUT',
      body: { items: off },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await count(bruce)).toBe(0);
    await call(t, '/api/v1/me/notification-preferences', {
      as: bruce,
      method: 'PUT',
      body: { items: off.map((o) => ({ ...o, enabled: true })) },
    });
    expect(await count(bruce)).toBe(1);

    // A module hidden for themselves: gone.
    await own(
      db,
      `INSERT INTO public.user_hidden_modules (user_id, location_id, module) VALUES ($1, $2, 'schedules')`,
      [bruce.userId, home.id],
    );
    expect(await count(bruce)).toBe(0);
    await own(db, 'DELETE FROM public.user_hidden_modules WHERE user_id = $1', [bruce.userId]);

    // In Arabic for an Arabic profile.
    await own(db, `UPDATE public.user_profiles SET locale = 'ar-EG' WHERE user_id = $1`, [
      bruce.userId,
    ]);
    const made = await createFeed(bruce);
    expect((await fetchFeed(made.path)).body.replace(/\r\n /g, '')).toContain(
      'SUMMARY:انتهاء الصلاحية · Drill',
    );
  });

  it('answers 404 for anything wrong, a disabled owner included, never saying which', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await createFeed(bruce);
    const unknown = await fetchFeed(`/cal/${'A'.repeat(43)}.ics`);
    expect(unknown.statusCode).toBe(404);
    expect((await fetchFeed('/cal/short.ics')).statusCode).toBe(404);
    await own(db, 'UPDATE auth."user" SET banned = true WHERE id = $1', [bruce.userId]);
    const banned = await fetchFeed(made.path);
    expect(banned.statusCode).toBe(404);
    expect(banned.body).toBe(unknown.body);
  });

  it('allows 60 fetches a minute per link', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await createFeed(bruce);
    for (let i = 0; i < FEED_FETCHES_PER_MINUTE; i++) {
      expect((await fetchFeed(made.path)).statusCode).toBe(200);
    }
    const over = await fetchFeed(made.path);
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('never writes the token to a log line (D181)', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await createFeed(bruce);
    const token = made.path.slice('/cal/'.length, -'.ics'.length);
    await fetchFeed(made.path);
    await fetchFeed(`/cal/${token.slice(0, 40)}xyz.ics`);
    const text = lines.join('');
    expect(text).toContain('/cal/[redacted]');
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(0, 40));
  });
});
