import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/package-root.js';
import type { ChannelSender } from '../../src/reminders/channel.js';
import { runScan, type ScanDeps, type ScanResult } from '../../src/reminders/scan.js';
import type { TestApp } from '../app.js';
import { type TestDb, testDb } from '../db.js';
import { call, type Person, peopleApp } from '../people.js';
import { type Loc, ok, own } from '../things.js';
import { seedHousehold, THINGS } from './household.js';
import { stats, timed } from './timing.js';

// Step 4's performance checks (plan T30 "Perf", full mode only: scripts/ci-local.sh `perf`, and
// `pnpm --filter @kept/server exec vitest run --config vitest.perf.config.ts`). The normal test
// run leaves test/perf out (vitest.config.ts).
//
// The fixture: one household location (Home, Africa/Cairo) owned by Ibrahim, with Bruce (admin),
// Louis (member) and Talia (viewer), holding 10,000 things in 20 places, 2,000 warranties (every
// tenth unregistered with a registration deadline), 500 schedules (every 3, 6 or 12 months), 300
// open loans (a fifth borrowed in) to or from Murdock, and 200 expiring documents (150 on things,
// 50 on a place). The due points are spread so that some of each source is due, overdue or
// expiring today and most are not. Going through the API would take far longer than the checks
// themselves, so these rows are bulk-inserted with SQL as kept_owner (`own`), with every trigger
// firing as it does for a request; the location, the people and their memberships go through the
// front door. The tables are then ANALYZEd, as autovacuum would do after a load like this.
//
// - The agenda behind Home's counts: GET /api/v1/home as the owner (home/service.ts homeOf:
//   agenda/query.ts agendaCounts and agendaCountsBySource over public.agenda_items, plus the
//   rest of Home's one read). 5 warm-ups, then 50 timed reads. GET /api/v1/agenda's first page
//   is timed the same way and recorded, without a limit (the plan names none).
// - A full reminder scan pass: reminders/scan.ts runScan(), the function the `reminder-scan`
//   job calls (reminders/jobs.ts), with every occurrence new (the heaviest pass: each one written
//   in its own transaction with a notification and an email delivery for the owner and the
//   admin). 1 warm-up pass, then 3 timed; the occurrences (and, by cascade, their notifications
//   and deliveries) are deleted before each. Then 3 steady passes, nothing new, as every later
//   15-minute pass is. The senders and the job queue are recorders: the real `send` inserts a
//   pg-boss job on the same transaction for each overdue delivery, which this leaves out.
// - The notification count: GET /api/v1/notifications/count as the owner, with the scan's
//   unread reminders plus 1,500 read notifications over the last 90 days (the prune window).
//   10 warm-ups, then 100 timed.
//
// The requests go through the app in-process (fastify inject): server time, no network, as the
// §3.1 targets are stated.
//
// LIMITS, from docs/perf/2026-09-30-step4.md (M1 Pro, load 3–12 from other agents' runs):
// - Home: the plan's provisional p95 < 150 ms, kept. First measured at p95 232–295 ms: homeOf
//   read public.agenda_items twice (fixed in 4913da8), and the view called kept.module_on() once
//   per source row (it has SET search_path, so it is never inlined). 0071 decides each
//   location's modules once: p95 208 → 92 ms, and the agenda's first page 301 → 122 ms, in back
//   to back runs at load 5–14.
// - A full scan pass: 10 s, tighter than the plan's 20 s (the worst pass measured 2.8 s).
// - The count: the plan's 20 ms (p95 measured 5.4–6.2 ms).

const READ_NOTIFICATIONS = 1_500;
const HOME_WARMUP = 5;
const HOME_RUNS = 50;
const SCAN_WARMUP = 1;
const SCAN_RUNS = 3;
const SCAN_STEADY = 3;
const COUNT_WARMUP = 10;
const COUNT_RUNS = 100;
const LIMITS = { homeP95Ms: 150, scanPassMaxMs: 10_000, notificationCountP95Ms: 20 };

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let home: Loc;
const results: Record<string, unknown> = {};

const recorder: ChannelSender = { send: async () => ({ status: 'sent' }) };
let queued = 0;
const scanDeps = (): ScanDeps => ({
  pools: db.pools,
  channels: { email: recorder, webpush: recorder, webhook: recorder },
  send: async () => {
    queued += 1;
  },
});

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  const started = performance.now();
  const fixture = await seedHousehold(db, t);
  ibrahim = fixture.ibrahim;
  home = fixture.home;
  results.fixture = { ...fixture.counted, seedMs: Math.round(performance.now() - started) };
}, 600_000);

afterAll(async () => {
  await t?.app.close();
  const dir = path.join(packageRoot(), '../../.tmp/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'step4.json');
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`step4 perf: ${JSON.stringify(results)} → ${file}`);
});

describe('step-4 performance (plan T30, full mode only)', () => {
  it(`reads Home's agenda counts at ${THINGS} things with p95 under ${LIMITS.homeP95Ms} ms`, async () => {
    const first = ok(await call(t, '/api/v1/home', { as: ibrahim })) as unknown as {
      attention: { overdue: number; due: number; expiring: number };
    };
    const { overdue, due, expiring } = first.attention;
    expect(overdue + due + expiring).toBeGreaterThan(0);
    const s = await timed(HOME_WARMUP, HOME_RUNS, async () => {
      const res = await call(t, '/api/v1/home', { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.home = { ...s, agenda: { overdue, due, expiring } };

    const agenda = await timed(HOME_WARMUP, HOME_RUNS, async () => {
      const res = await call(t, '/api/v1/agenda', { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.agendaFirstPage = agenda;
    expect(s.p95).toBeLessThan(LIMITS.homeP95Ms);
  }, 300_000);

  it(`runs a full reminder scan pass in under ${LIMITS.scanPassMaxMs} ms`, async () => {
    const full: number[] = [];
    let last: ScanResult | null = null;
    for (let i = 0; i < SCAN_WARMUP + SCAN_RUNS; i++) {
      await own(db, 'DELETE FROM public.reminder_occurrences WHERE location_id = $1', [home.id]);
      queued = 0;
      const start = performance.now();
      last = await runScan(scanDeps());
      const ms = performance.now() - start;
      expect(last.occurrences).toBeGreaterThan(0);
      if (i >= SCAN_WARMUP) full.push(ms);
    }
    const written = last as ScanResult;
    const jobs = queued;
    const steady: number[] = [];
    for (let i = 0; i < SCAN_STEADY; i++) {
      const start = performance.now();
      const pass = await runScan(scanDeps());
      steady.push(performance.now() - start);
      expect(pass.occurrences).toBe(0);
    }
    const s = stats(full);
    results.scanFullPass = {
      ...s,
      occurrences: written.occurrences,
      notifications: written.notifications,
      deliveries: written.deliveries,
      deliverJobs: jobs,
    };
    results.scanSteadyPass = stats(steady);
    expect(s.max).toBeLessThan(LIMITS.scanPassMaxMs);
    expect(stats(steady).max).toBeLessThan(LIMITS.scanPassMaxMs);
  }, 600_000);

  it(`counts the owner's unread notifications with p95 under ${LIMITS.notificationCountP95Ms} ms`, async () => {
    // The scan's reminders (unread) plus the last 90 days' read ones.
    await own(
      db,
      `INSERT INTO public.notifications (user_id, location_id, kind, payload, read_at, created_at)
       SELECT $1, $2, 'membership_added', '{}',
              now() - make_interval(days => n % 90), now() - make_interval(days => n % 90)
         FROM generate_series(1, $3) AS n`,
      [ibrahim.userId, home.id, READ_NOTIFICATIONS],
    );
    await own(db, 'ANALYZE public.notifications');
    const mine = await own<{ total: number; unread: number }>(
      db,
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM public.notifications WHERE user_id = $1`,
      [ibrahim.userId],
    );
    const unread = (
      ok(await call(t, '/api/v1/notifications/count', { as: ibrahim })) as unknown as {
        unread: number;
      }
    ).unread;
    expect(unread).toBe(mine[0]?.unread);
    expect(unread).toBeGreaterThan(0);
    const s = await timed(COUNT_WARMUP, COUNT_RUNS, async () => {
      const res = await call(t, '/api/v1/notifications/count', { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.notificationCount = { ...s, total: mine[0]?.total, unread };
    expect(s.p95).toBeLessThan(LIMITS.notificationCountP95Ms);
  }, 300_000);
});
