import {
  ADVICE_DAYS,
  MIN_SPAN_DAYS,
  milli,
  newId,
  RATE_WINDOW_DAYS,
  readingAdvice,
  UNKNOWN_DAYS,
} from '@kept/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, seedTenant, type Tenant } from '../../test/tenancy.js';
import { placeReading } from '../meters/check.js';
import { withScope } from './scope.js';

// Step 5, task 7 (0066): kept.meter_estimate() and kept.meter_eta(), the one implementation of the
// usage estimate (D52, D188; plan Q8), against @kept/shared vehicles.ts's constants and
// meters/check.ts's offset correction.

const db = await testDb();

let ibrahim: Tenant;
let meter: string;

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const as = <T extends pg.QueryResultRow>(userId: string, sql: string, values: unknown[] = []) =>
  withScope(
    db.pools.app,
    { userId, mfa: true },
    async (_tx, c) => (await c.query<T>(sql, values)).rows,
  );

async function meterOf(t: Tenant): Promise<string> {
  const thing = newId();
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Corolla')`,
    [thing, t.locationId, t.unplacedId],
  );
  await own(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit)
     VALUES ($1, $2, $3, 'distance', 'km')`,
    [id, t.locationId, thing],
  );
  return id;
}

const read = (value: number, takenAt: string, state = 'accepted', m = meter, t = ibrahim) =>
  own(
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [t.locationId, m, value, takenAt, state],
  );

type Estimate = {
  last_value: string | null;
  per_day: string | null;
  basis_days: number | null;
  age_days: number | null;
  advice: string;
};
const estimate = async (now: string, userId = ibrahim.userId, m = meter) =>
  as<Estimate>(
    userId,
    `SELECT last_value::text, per_day::text, basis_days, age_days, advice
       FROM kept.meter_estimate($1, $2)`,
    [m, now],
  );
const eta = async (value: string, now: string, userId = ibrahim.userId, m = meter) =>
  (
    await as<{ d: string | null }>(userId, 'SELECT kept.meter_eta($1, $2, $3)::text AS d', [
      m,
      value,
      now,
    ])
  )[0]?.d ?? null;

const DAY = 86_400_000;
const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString();
const cairoDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date(ms));

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'est-ibrahim');
  meter = await meterOf(ibrahim);
});

describe('kept.meter_estimate() (Q8)', () => {
  const now = '2026-09-30T10:00:00Z';

  it('answers "none" before the first reading, and nothing for a meter it can’t see', async () => {
    expect(await estimate(now)).toEqual([
      { last_value: null, per_day: null, basis_days: null, age_days: null, advice: 'none' },
    ]);
    const louis = await seedTenant(db, 'est-louis');
    await read(1000, '2026-09-20T09:00:00Z');
    expect(await estimate(now, louis.userId)).toEqual([]);
    expect(await eta('2000', now, louis.userId)).toBeNull();
  });

  it(`rates the rise over the ${RATE_WINDOW_DAYS} days before the latest reading`, async () => {
    await read(40000, '2026-06-01T09:00:00Z'); // outside the window
    await read(41000, '2026-07-01T09:00:00Z');
    await read(99999, '2026-08-01T09:00:00Z', 'needs_review'); // not accepted: ignored
    await read(46000, '2026-09-20T09:00:00Z');
    const [e] = await estimate(now);
    // 5,000 km over the 81 days from 1 July to 20 September.
    expect(e).toEqual({
      last_value: '46000.000',
      per_day: (5000 / 81).toFixed(6),
      basis_days: 81,
      age_days: 10,
      advice: 'fresh',
    });
    // 1,000 km more at that rate: 16.2 days after 20 September 12:00 Cairo.
    const perDay = Number(e?.per_day);
    expect(await eta('47000', now)).toBe(
      cairoDate(Date.parse('2026-09-20T09:00:00Z') + (1000 / perDay) * DAY),
    );
    // Already there, or no rise to go on: no date.
    expect(await eta('46000', now)).toBeNull();
    expect(await eta('45000', now)).toBeNull();
  });

  it(`needs 2 readings at least ${MIN_SPAN_DAYS} days apart`, async () => {
    await read(1000, '2026-09-20T09:00:00Z');
    expect((await estimate(now))[0]).toMatchObject({ per_day: null, basis_days: null });
    await read(1300, '2026-09-26T09:00:00Z');
    expect((await estimate(now))[0]).toMatchObject({ per_day: null, basis_days: 6 });
    expect(await eta('2000', now)).toBeNull();
    await read(1400, '2026-09-27T09:00:00Z');
    expect((await estimate(now))[0]).toMatchObject({ per_day: '57.142857', basis_days: 7 });
  });

  it('corrects values across a replacement as meters/check.ts does', async () => {
    await read(41000, '2026-07-01T09:00:00Z');
    await own(
      `INSERT INTO public.meter_events (location_id, meter_id, kind, at, "offset")
       VALUES ($1, $2, 'replaced', '2026-08-01T09:00:00Z', 45000)`,
      [ibrahim.locationId, meter],
    );
    await read(1000, '2026-09-20T09:00:00Z'); // the new odometer: 46,000 in all
    const [e] = await estimate(now);
    expect(e).toMatchObject({ last_value: '46000.000', per_day: (5000 / 81).toFixed(6) });
    // check.ts reads the same series the same way: the new odometer's 1,000 is no step back.
    const placed = placeReading(
      { value: '1000', takenAt: new Date('2026-09-20T09:00:00Z') },
      [{ id: 'a', value: '41000', takenAt: new Date('2026-07-01T09:00:00Z') }],
      [{ at: new Date('2026-08-01T09:00:00Z'), offset: '45000' }],
      null,
    );
    expect(placed.reason).toBeNull();
    expect(milli(e?.last_value as string)).toBe(milli('1000') + milli('45000'));
  });

  it(`advises at ${ADVICE_DAYS} days and loses the rate at ${UNKNOWN_DAYS}, as readingAdvice()`, async () => {
    await read(41000, '2026-07-01T09:00:00Z');
    const last = '2026-09-20T09:00:00Z';
    await read(46000, last);
    for (const age of [0, 1, 29, 30, 34, 59, 60, 61, 200]) {
      const at = plusDays(last, age);
      const [e] = await estimate(at);
      expect(e, `age ${age}`).toMatchObject({ age_days: age, advice: readingAdvice(age) });
      expect(e?.per_day === null, `age ${age}`).toBe(age >= UNKNOWN_DAYS);
      expect((await eta('47000', at)) === null, `age ${age}`).toBe(age >= UNKNOWN_DAYS);
    }
  });

  it('counts the age in the location’s own days', async () => {
    // 23:30 Cairo on 19 September (20:30 UTC); "now" 00:30 Cairo on 20 September.
    await read(1000, '2026-09-19T20:30:00Z');
    expect((await estimate('2026-09-19T21:30:00Z'))[0]?.age_days).toBe(1);
  });
});
