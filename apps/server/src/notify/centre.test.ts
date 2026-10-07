import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { withSystem } from '../db/scope.js';
import { runScan } from '../reminders/scan.js';
import type { Notification } from './centre.js';
import { aiSummaryChannels } from './notices.js';

// Plan T16 through the front door, as the web calls it (apps/web/src/api/household/{types,paths}.ts
// and mock/notify.ts): the centre lists the caller's own notifications while they see the
// location, a reminder as it is now (its state, subject, title and actions), membership and AI
// notices in words the web renders, the bell's count, and marking read. Rows come from the scan
// and the notice jobs (kept_system) or are seeded as kept_owner.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owns Home
let bruce: Person; // admin of Home
let talia: Person; // viewer of Home
let home: string;
let drill: string;
let murdock: string;
let today: string;

vi.setConfig({ testTimeout: 60_000 });

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

const plus = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Page = { items: Notification[]; unread: number; next_cursor: string | null };
const list = async (as: Person, query = '') => {
  const res = await call(t, `/api/v1/notifications${query}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
};
const count = async (as: Person) =>
  ((await call(t, '/api/v1/notifications/count', { as })).json() as { unread: number }).unread;

async function lend(thingId: string, dueOn: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, $3, 'out', $4, now() - interval '20 days', $5, $6)`,
    [id, home, thingId, murdock, dueOn, ibrahim.userId],
  );
  return id;
}

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  talia = await person(t, db, 'talia');
  const made = await call(t, '/api/v1/locations', {
    as: ibrahim,
    body: {
      name: 'Home',
      kind: 'home',
      preset: 'household',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(made.statusCode, made.body).toBe(201);
  home = (made.json() as { id: string }).id;
  await join(db, home, bruce.userId, 'admin');
  await join(db, home, talia.userId, 'viewer');
  const [row] = await own<{ today: string; unplaced: string }>(
    `SELECT (now() AT TIME ZONE l.timezone)::date::text AS today,
            (SELECT p.id FROM public.places p WHERE p.location_id = l.id AND p.is_unplaced) AS unplaced
       FROM public.locations l WHERE l.id = $1`,
    [home],
  );
  today = row?.today as string;
  const kitchen = newId();
  await own(`INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, 'Kitchen')`, [
    kitchen,
    home,
  ]);
  drill = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
    [drill, home, kitchen],
  );
  murdock = newId();
  await own(
    `INSERT INTO public.people (id, owner_account_id, display_name)
     SELECT $1, owner_account_id, 'Murdock' FROM public.locations WHERE id = $2`,
    [murdock, home],
  );
});

describe('GET /api/v1/notifications', () => {
  it('lists a reminder as it is now: subject, title, state and a writer’s actions', async () => {
    const lent = await lend(drill, plus(-2));
    await runScan({ pools: db.pools });
    const page = await list(ibrahim);
    expect(page.unread).toBe(1);
    expect(page.next_cursor).toBeNull();
    const [n] = page.items;
    expect(n).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      createdAt: expect.any(String),
      readAt: null,
      locationId: home,
      reminder: {
        occurrenceId: expect.any(String),
        sourceType: 'loan',
        sourceId: lent,
        kind: 'overdue',
        dueOn: plus(-2),
        dueValue: null,
        state: 'open',
        subject: {
          type: 'thing',
          id: drill,
          name: 'Drill',
          path: expect.stringMatching(/ › Kitchen$/),
          shortCode: null,
        },
        title: 'Drill',
        actions: ['mark_returned', 'open'],
      },
    });
    // Contact details and names of people never reach the centre.
    expect(JSON.stringify(page)).not.toMatch(/Murdock/);
  });

  it('a returned loan reads done with no actions at once, before the next scan', async () => {
    const lent = await lend(drill, plus(-2));
    await runScan({ pools: db.pools });
    await own('UPDATE public.loans SET returned_at = now() WHERE id = $1', [lent]);
    const [n] = (await list(ibrahim)).items;
    expect(n?.reminder).toMatchObject({ state: 'done', actions: [] });
    // And after it, from the occurrence itself.
    await runScan({ pools: db.pools });
    expect((await list(ibrahim)).items[0]?.reminder).toMatchObject({ state: 'done', actions: [] });
  });

  it("a viewer's reminder only opens; a location left takes its notifications with it", async () => {
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, $2, 'loan', 'inapp', true)`,
      [talia.userId, home],
    );
    const lent = await lend(drill, plus(-2));
    // Viewers aren't recipients (Q8); write Talia's notice as the scan would.
    await runScan({ pools: db.pools });
    const [occ] = await own<{ id: string }>(
      'SELECT id FROM public.reminder_occurrences WHERE source_id = $1',
      [lent],
    );
    await withSystem(db.pools.system, (_tx, c) =>
      c.query(
        `INSERT INTO public.notifications (user_id, location_id, occurrence_id, kind)
         VALUES ($1, $2, $3, 'reminder')`,
        [talia.userId, home, occ?.id],
      ),
    );
    expect((await list(talia)).items[0]?.reminder?.actions).toEqual(['open']);
    await own('DELETE FROM public.memberships WHERE user_id = $1 AND location_id = $2', [
      talia.userId,
      home,
    ]);
    expect(await list(talia)).toEqual({ items: [], unread: 0, next_cursor: null });
    expect(await count(talia)).toBe(0);
  });

  it('names membership, AI cap and export notices in the words the web renders', async () => {
    await withSystem(db.pools.system, async (_tx, c) => {
      await c.query(
        `INSERT INTO public.notifications (user_id, location_id, kind, payload) VALUES
           ($1, $2, 'membership_added', $3::jsonb),
           ($1, NULL, 'ai_cap', '{"scope": "account", "level": 80, "month": "2026-09-01", "budgetId": "x"}'),
           ($1, $2, 'export_ready', $4::jsonb)`,
        [
          ibrahim.userId,
          home,
          JSON.stringify({
            userId: bruce.userId,
            userName: 'Bruce',
            role: 'admin',
            managed: false,
          }),
          JSON.stringify({ runId: newId(), kind: 'claim_pack' }),
        ],
      );
    });
    const byKind = Object.fromEntries((await list(ibrahim)).items.map((n) => [n.kind, n]));
    expect(byKind.membership_added?.membership).toEqual({
      userName: 'Bruce',
      role: 'admin',
      locationName: 'Home',
    });
    expect(byKind.ai_cap?.aiCap).toEqual({ scope: 'account', level: 80, month: '2026-09-01' });
    expect(byKind.export_ready?.exportReady).toMatchObject({ kind: 'claim_pack' });
    // Someone else's notifications are nobody else's, even in the same location.
    expect((await list(bruce)).items).toEqual([]);
  });

  it('filters by unread, kind and location, and pages newest first with a cursor', async () => {
    await withSystem(db.pools.system, async (_tx, c) => {
      for (let i = 0; i < 5; i++) {
        await c.query(
          `INSERT INTO public.notifications (user_id, location_id, kind, payload, created_at)
           VALUES ($1, $2, 'membership_added', $3::jsonb, now() - make_interval(mins => $4))`,
          [ibrahim.userId, home, JSON.stringify({ userName: `Louis ${i}`, role: 'member' }), i],
        );
      }
      await c.query(
        `INSERT INTO public.notifications (user_id, kind, payload)
         VALUES ($1, 'ai_summary', '{}'::jsonb)`,
        [ibrahim.userId],
      );
    });
    const first = await list(ibrahim, '?limit=2&kind=membership_added');
    expect(first.items.map((n) => n.membership?.userName)).toEqual(['Louis 0', 'Louis 1']);
    const second = await list(
      ibrahim,
      `?limit=2&kind=membership_added&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
    );
    expect(second.items.map((n) => n.membership?.userName)).toEqual(['Louis 2', 'Louis 3']);
    expect((await list(ibrahim, `?locationId=${home}`)).items).toHaveLength(5);
    expect(first.unread).toBe(6);
    expect((await call(t, '/api/v1/notifications?kind=nope', { as: ibrahim })).statusCode).toBe(
      400,
    );
  });
});

describe('the bell and marking read', () => {
  it('the count matches the list; read by ids, then all', async () => {
    await lend(drill, plus(-2));
    await runScan({ pools: db.pools });
    await withSystem(db.pools.system, (_tx, c) =>
      c.query(
        `INSERT INTO public.notifications (user_id, kind, payload)
         VALUES ($1, 'ai_summary', '{}'::jsonb), ($1, 'ai_summary', '{}'::jsonb)`,
        [ibrahim.userId],
      ),
    );
    const page = await list(ibrahim);
    expect(await count(ibrahim)).toBe(page.items.length);
    expect(page.unread).toBe(3);
    const read = await call(t, '/api/v1/notifications/read', {
      as: ibrahim,
      body: { ids: [page.items[0]?.id] },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ unread: 2 });
    expect((await list(ibrahim, '?unread=1')).items).toHaveLength(2);
    expect(await count(ibrahim)).toBe(2);
    // Another's ids change nothing of theirs.
    const bruces = await call(t, '/api/v1/notifications/read', {
      as: bruce,
      body: { ids: page.items.map((n) => n.id) },
    });
    expect(bruces.json()).toEqual({ unread: expect.any(Number) });
    expect(await count(ibrahim)).toBe(2);
    const all = await call(t, '/api/v1/notifications/read', { as: ibrahim, body: { all: true } });
    expect(all.json()).toEqual({ unread: 0 });
    expect((await list(ibrahim, '?unread=true')).items).toEqual([]);
  });

  it('refuses a body that is neither ids nor all, or over 200 ids', async () => {
    for (const body of [{}, { ids: [], all: true }, { ids: Array.from({ length: 201 }, newId) }]) {
      const res = await call(t, '/api/v1/notifications/read', { as: ibrahim, body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('the AI monthly summary opt-out (Q35)', () => {
  it('is on by default, off by email alone, and off entirely when the kind is silenced', async () => {
    const channels = () =>
      withSystem(db.pools.system, (_tx, c) => aiSummaryChannels(c, ibrahim.userId));
    expect(await channels()).toEqual({ inapp: true, email: true });
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, NULL, 'ai_summary', 'email', false)`,
      [ibrahim.userId],
    );
    expect(await channels()).toEqual({ inapp: true, email: false });
    await own(
      `UPDATE public.notification_preferences SET enabled = true
        WHERE user_id = $1 AND kind = 'ai_summary'`,
      [ibrahim.userId],
    );
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, NULL, 'ai_summary', 'inapp', false)`,
      [ibrahim.userId],
    );
    expect(await channels()).toEqual({ inapp: false, email: false });
  });
});
