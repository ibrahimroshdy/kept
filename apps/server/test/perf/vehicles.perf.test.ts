import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../src/jobs/boss.js';
import { packageRoot } from '../../src/package-root.js';
import { reportJobs } from '../../src/reports/jobs.js';
import { RENDER_MEMORY_MB } from '../../src/reports/render/render.js';
import type { TestApp } from '../app.js';
import { type TestDb, testDb } from '../db.js';
import { type TestFiles, testFiles } from '../files.js';
import { call, join, type Person, peopleApp, type RecordedJob } from '../people.js';
import { builtinType, createLocation, createThing, type Loc, ok, own } from '../things.js';
import { seedHousehold } from './household.js';
import { timed } from './timing.js';

// Step 5's performance checks (plan T25 "Perf", full mode only: scripts/ci-local.sh `perf`, and
// `pnpm --filter @kept/server exec vitest run --config vitest.perf.config.ts`).
//
// The fixture: step 4's household (test/perf/household.ts: 10,000 things, 2,000 warranties, 500
// schedules, 300 loans, 200 documents in Home), plus
// - 49 cars in Home, made through the API, each with its four starter schedules (POST
//   …/starter-schedules: oil change, tyre rotation and air filter every N km or M months on its
//   odometer, brake fluid by months only) and 12 accepted odometer readings over the last 110
//   days, so every unit schedule's due date goes through `kept.meter_estimate` /
//   `kept.meter_eta` (150 unit schedules in the agenda, with the Corolla's three);
// - the Corolla in the Garage (Complete, so Fuel is on), the 50th vehicle, with five years of
//   history: 600 full fills (each with its own `fuel` reading and a cost in EGP), 60 confirmed
//   services (each with its own `service` reading and two lines), 5 insurance renewals with a
//   cost, and its four starter schedules;
// - a compressor in Home (no type, so not a vehicle) with 3 meters (hours, distance and a custom
//   counter), each with 12 readings: the thing page with 3 meters (plan T8: one
//   `kept.meter_estimate` per meter).
// The cars, schedules and meters go through the front door; the readings, fills and services are
// bulk-inserted as kept_owner with every trigger firing, then ANALYZEd.
//
// The checks, and their limits (plan T25; engineering spec §3.1):
// - `agenda_items` with step 5's branches: Home (GET /api/v1/home) and the agenda's first page
//   (GET /api/v1/agenda) no slower than step 4's recorded figures by more than 20%. Step 4's
//   figures (docs/perf/2026-09-30-step4.md, .tmp/perf/step4.json at 14:31 on 2026-09-30, after
//   0071): Home p95 92.0 ms, the agenda's first page p95 122.1 ms. So 110.4 ms and 146.5 ms.
//   Measured before the vehicles are added too, on the same rows in the same run, and recorded:
//   the ratio is the fairer comparison on a loaded machine; the gate is the recorded figure.
// - The vehicles list, all 50 in one page: p95 < 200 ms.
// - The Corolla's running costs over the last 60 months (600 fills, 60 services): p95 < 200 ms.
// - Its fuel summary over 600 fills: p95 < 100 ms.
// - The compressor's thing page (GET /api/v1/things/:id) with 3 meters: p95 < 200 ms (§3.1).
// - The Corolla's history report over the five years, with costs and fuel: the `report` job
//   renders it (Typst in its child process, killed past RENDER_MEMORY_MB, render/render.ts).
//   Passing means it rendered under that limit; its time and size are recorded.
//
// The requests go through the app in-process (fastify inject): server time, no network.

const STEP4 = { homeP95Ms: 92.0, agendaP95Ms: 122.1 };
const SLOWER_BY = 1.2;
const LIMITS = {
  homeP95Ms: Math.round(STEP4.homeP95Ms * SLOWER_BY * 10) / 10,
  agendaP95Ms: Math.round(STEP4.agendaP95Ms * SLOWER_BY * 10) / 10,
  vehiclesP95Ms: 200,
  costsP95Ms: 200,
  fuelSummaryP95Ms: 100,
  thingPageP95Ms: 200,
};
const CARS_IN_HOME = 49;
const READINGS_PER_METER = 12;
const FILLS = 600;
const SERVICES = 60;
const WARMUP = 5;
const RUNS = 50;

let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let home: Loc;
let garage: Loc;
let corolla: { id: string; meterId: string };
let compressorId: string;
const results: Record<string, unknown> = {};

const home$ = async () => {
  const res = await call(t, '/api/v1/home', { as: ibrahim });
  expect(res.statusCode, res.body).toBe(200);
};
const agenda$ = async () => {
  const res = await call(t, '/api/v1/agenda', { as: ibrahim });
  expect(res.statusCode, res.body).toBe(200);
};

/** 12 accepted readings on `meterId`, one every 10 days up to an hour ago, rising `perDay`. */
async function readings(locId: string, meterId: string, start: number, perDay: number) {
  await own(
    db,
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source, logged_by)
     SELECT $1, $2, $3::numeric + (n * 10 * $4::numeric),
            now() - interval '1 hour' - make_interval(days => ($5 - n) * 10), 'manual', $6
       FROM generate_series(0, $5) AS n`,
    [locId, meterId, start, perDay, READINGS_PER_METER - 1, ibrahim.userId],
  );
}

async function car(loc: Loc, name: string): Promise<{ id: string; meterId: string }> {
  const thing = await createThing(t, ibrahim, loc, {
    name,
    typeId: await builtinType(db, 'car'),
  });
  const meterId = (thing.meters as { id: string }[])[0]?.id as string;
  ok(await call(t, `/api/v1/things/${thing.id}/starter-schedules`, { as: ibrahim, body: {} }), 201);
  return { id: thing.id, meterId };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  const fixture = await seedHousehold(db, t);
  ibrahim = fixture.ibrahim;
  home = fixture.home;
  garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
  await join(db, garage.id, fixture.bruce.userId, 'admin');
  await own(db, 'ANALYZE');

  // Step 4's figures on these rows, before any vehicle.
  results.before = {
    home: await timed(WARMUP, RUNS, home$),
    agendaFirstPage: await timed(WARMUP, RUNS, agenda$),
  };

  const started = performance.now();
  for (let i = 1; i <= CARS_IN_HOME; i++) {
    const c = await car(home, `Car ${String(i).padStart(2, '0')}`);
    // 30 to 79 km a day from 10,000 to 60,000 km: some schedules due, most not.
    await readings(home.id, c.meterId, 10_000 + i * 1_000, 30 + i);
  }

  // The thing with 3 meters: a workshop compressor with no type (not a vehicle, so not listed),
  // given an hours meter, a distance meter and a custom counter.
  compressorId = (await createThing(t, ibrahim, home, { name: 'Compressor' })).id;
  const meterIds: string[] = [];
  for (const body of [
    { kind: 'hours', unit: 'h', label: 'Motor' },
    { kind: 'distance', unit: 'km', label: 'Trailer' },
    { kind: 'custom', unit: 'starts', label: 'Starts' },
  ]) {
    meterIds.push(
      ok(await call(t, `/api/v1/things/${compressorId}/meters`, { as: ibrahim, body }), 201).id,
    );
  }
  expect(meterIds).toHaveLength(3);
  for (const [i, m] of meterIds.entries()) await readings(home.id, m, 100 * (i + 1), 2 + i);

  // The Corolla: five years of fills and services, in the Garage.
  corolla = await car(garage, 'Toyota Corolla');
  // A fill every 3 days for 1,800 days, ~35 km a day: 105 km between fills, 7.5 L/100 km.
  await own(
    db,
    `WITH r AS (
       INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source,
                                          logged_by)
       SELECT $1, $2, 20000 + n * 105, now() - make_interval(days => ($4 - n) * 3, hours => 2),
              'fuel', $3
         FROM generate_series(1, $4) AS n
       RETURNING id, value, taken_at)
     INSERT INTO public.fuel_entries (location_id, thing_id, taken_at, amount, unit, currency,
                                      cost, is_full, meter_reading_id, logged_by)
     SELECT $1, $5, r.taken_at, 7.875, 'L', 'EGP', 7.875 * 22.75, true, r.id, $3 FROM r`,
    [garage.id, corolla.meterId, ibrahim.userId, FILLS, corolla.id],
  );
  // A service every 30 days, a day after a fill, at that fill's odometer plus 35 km.
  await own(
    db,
    `WITH r AS (
       INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source,
                                          logged_by)
       SELECT $1, $2, 20000 + n * 1050 + 35, now() - make_interval(days => ($4 - n) * 30 - 1),
              'service', $3
         FROM generate_series(1, $4) AS n
       RETURNING id, taken_at),
     s AS (
       INSERT INTO public.service_records (location_id, thing_id, serviced_on, meter_reading_id,
                                           total, currency, logged_by)
       SELECT $1, $5, (r.taken_at AT TIME ZONE 'Africa/Cairo')::date, r.id, 2250, 'EGP', $3
         FROM r
       RETURNING id)
     INSERT INTO public.service_lines (location_id, service_record_id, kind, description,
                                       quantity, unit_cost, sort)
     SELECT $1, s.id, l.kind, l.description, l.quantity, l.unit_cost, l.sort
       FROM s CROSS JOIN (VALUES ('fluid', 'Engine oil 5W-30', 4, 350, 0),
                                 ('labour', 'Oil change', 1, 850, 1))
                         AS l(kind, description, quantity, unit_cost, sort)`,
    [garage.id, corolla.meterId, ibrahim.userId, SERVICES, corolla.id],
  );
  await own(
    db,
    `INSERT INTO public.expiring_documents (location_id, thing_id, kind, title, issued_on,
                                            expires_on, cost, currency, created_by)
     SELECT $1, $2, 'insurance', 'Insurance ' || n,
            (now() AT TIME ZONE 'Africa/Cairo')::date - 365 * n + 30,
            (now() AT TIME ZONE 'Africa/Cairo')::date - 365 * n + 395, 3500, 'EGP', $3
       FROM generate_series(1, 5) AS n`,
    [garage.id, corolla.id, ibrahim.userId],
  );
  await own(db, 'ANALYZE');
  const counted = await own<Record<string, number>>(
    db,
    `SELECT (SELECT count(*)::int FROM public.fuel_entries WHERE thing_id = $1) AS fills,
            (SELECT count(*)::int FROM public.service_records WHERE thing_id = $1) AS services,
            (SELECT count(*)::int FROM public.meters m JOIN public.things x ON x.id = m.thing_id
              WHERE kept.is_vehicle_type(x.type_id)) AS vehicle_meters,
            (SELECT count(*)::int FROM public.schedules WHERE meter_id IS NOT NULL)
              AS unit_schedules,
            (SELECT count(*)::int FROM public.meters WHERE thing_id = $2) AS compressor_meters`,
    [corolla.id, compressorId],
  );
  expect(counted[0]).toMatchObject({
    fills: FILLS,
    services: SERVICES,
    vehicle_meters: CARS_IN_HOME + 1,
    compressor_meters: 3,
  });
  results.fixture = {
    ...fixture.counted,
    ...counted[0],
    vehiclesSeedMs: Math.round(performance.now() - started),
  };
}, 900_000);

afterAll(async () => {
  await t?.app.close();
  const dir = path.join(packageRoot(), '../../.tmp/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'step5.json');
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`step5 perf: ${JSON.stringify(results)} → ${file}`);
});

describe('step-5 performance (plan T25, full mode only)', () => {
  it(`reads Home and the agenda with step 5's branches within 20% of step 4's figures (${LIMITS.homeP95Ms} / ${LIMITS.agendaP95Ms} ms p95)`, async () => {
    const first = ok(await call(t, '/api/v1/home', { as: ibrahim })) as unknown as {
      attention: { overdue: number; due: number; expiring: number };
    };
    const homeStats = await timed(WARMUP, RUNS, home$);
    const agendaStats = await timed(WARMUP, RUNS, agenda$);
    const before = results.before as { home: { p95: number }; agendaFirstPage: { p95: number } };
    results.after = {
      home: { ...homeStats, attention: first.attention },
      agendaFirstPage: agendaStats,
      ratioToBefore: {
        home: Math.round((homeStats.p95 / before.home.p95) * 100) / 100,
        agendaFirstPage: Math.round((agendaStats.p95 / before.agendaFirstPage.p95) * 100) / 100,
      },
    };
    expect(homeStats.p95).toBeLessThan(LIMITS.homeP95Ms);
    expect(agendaStats.p95).toBeLessThan(LIMITS.agendaP95Ms);
  }, 300_000);

  it(`lists 50 vehicles in one page with p95 under ${LIMITS.vehiclesP95Ms} ms`, async () => {
    const page = ok(await call(t, '/api/v1/vehicles?limit=50', { as: ibrahim })) as unknown as {
      items: { meter?: { estimate: { advice: string } } }[];
    };
    expect(page.items).toHaveLength(CARS_IN_HOME + 1);
    // Every car's odometer has an estimate (a rate from its readings) for its schedules' dates.
    expect(page.items.every((v) => v.meter?.estimate.advice === 'fresh')).toBe(true);
    const s = await timed(WARMUP, RUNS, async () => {
      const res = await call(t, '/api/v1/vehicles?limit=50', { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.vehicles = s;
    expect(s.p95).toBeLessThan(LIMITS.vehiclesP95Ms);
  }, 300_000);

  it(`gives five years of running costs with p95 under ${LIMITS.costsP95Ms} ms`, async () => {
    const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const total = y * 12 + (m - 1) - 60;
    const from = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
    const url = `/api/v1/things/${corolla.id}/costs?from=${from}&to=${month}`;
    const report = ok(await call(t, url, { as: ibrahim })) as unknown as {
      months: unknown[];
      totals: { currency: string; fuel: string; service: string }[];
    };
    expect(report.months.length).toBe(61);
    expect(Number(report.totals[0]?.fuel)).toBeGreaterThan(0);
    expect(Number(report.totals[0]?.service)).toBeGreaterThan(0);
    const s = await timed(WARMUP, RUNS, async () => {
      const res = await call(t, url, { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.costs5y = s;
    expect(s.p95).toBeLessThan(LIMITS.costsP95Ms);
  }, 300_000);

  it(`summarises 600 fills with p95 under ${LIMITS.fuelSummaryP95Ms} ms`, async () => {
    const url = `/api/v1/things/${corolla.id}/fuel/summary`;
    const summary = ok(await call(t, url, { as: ibrahim }));
    expect(JSON.stringify(summary)).toContain('7.5');
    const s = await timed(WARMUP, RUNS, async () => {
      const res = await call(t, url, { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.fuelSummary = s;
    expect(s.p95).toBeLessThan(LIMITS.fuelSummaryP95Ms);
  }, 300_000);

  it(`opens a thing with 3 meters with p95 under ${LIMITS.thingPageP95Ms} ms`, async () => {
    const thing = ok(
      await call(t, `/api/v1/things/${compressorId}`, { as: ibrahim }),
    ) as unknown as {
      meters: { estimate: { advice: string } }[];
    };
    expect(thing.meters).toHaveLength(3);
    expect(thing.meters.every((m) => m.estimate.advice === 'fresh')).toBe(true);
    const s = await timed(WARMUP, RUNS, async () => {
      const res = await call(t, `/api/v1/things/${compressorId}`, { as: ibrahim });
      expect(res.statusCode, res.body).toBe(200);
    });
    results.thingPage3Meters = s;
    expect(s.p95).toBeLessThan(LIMITS.thingPageP95Ms);
  }, 300_000);

  it(`renders five years' history report under the renderer's ${RENDER_MEMORY_MB} MB limit`, async () => {
    const job = reportJobs({
      pools: db.pools,
      mailer: { send: async () => {} },
      publicUrl: 'https://kept.example',
      log: { info: () => {}, error: () => {} },
      files,
    } as never).find((j) => j.name === 'report');
    if (!job) throw new Error('no report job');
    const { id } = ok(
      await call(t, '/api/v1/reports/vehicle-history', {
        as: ibrahim,
        body: { thingId: corolla.id, locale: 'en' },
      }),
      202,
    );
    const start = performance.now();
    await runJob(job, { userId: ibrahim.userId, mfa: false, data: { runId: id } }, db.pools);
    const ms = Math.round(performance.now() - start);
    const run = ok(await call(t, `/api/v1/reports/${id}`, { as: ibrahim }));
    expect(run.status, JSON.stringify(run)).toBe('done');
    const res = await t.app.inject({ method: 'GET', url: run.fileUrl as string });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    results.report5y = { ms, bytes: res.rawPayload.length, memoryLimitMb: RENDER_MEMORY_MB };
  }, 300_000);
});
