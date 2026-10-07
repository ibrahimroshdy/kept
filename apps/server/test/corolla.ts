import { newId } from '@kept/shared';
import { expect } from 'vitest';
import type { TestApp } from './app.js';
import type { TestDb } from './db.js';
import { call, type Person } from './people.js';
import { own } from './things.js';

// The Corolla of the web mock (apps/web/src/api/vehicles/mock/state.ts, the board's numbers), for
// the server's step-5 tests: 22 fills from the first instant of April to the first of October
// 2026 in Cairo, a missed fill-up in May and a partial in August; two services; an insurance
// document issued in May for 3,500 EGP. April to September cost 29,800 EGP (fuel 19,855.50,
// service 6,444.50, fees 3,500) over 11,346 km: 2.63 EGP a km, fuel 1.75, about 3,300 a month on
// fuel; the last 5 full fills give 7.3 L/100 km.
//
// A test can't move the database's clock, so the fixture's months are moved instead: its last
// fill lands on the first instant of the current Cairo month, so April to September become the
// six full months before this one, whatever day the suite runs. Mid-month times move by whole
// months (a day past a month's end is its last day), which changes no interval's litres or
// kilometres; the two ends are the months' first instants exactly.

/** [takenAt, litres, full, missed a fill-up before, odometer, cost EGP] (the mock's). */
export const COROLLA_FILLS: readonly [string, string, boolean, boolean, string, string][] = [
  ['2026-03-31T22:00:00.000Z', '40.387', true, false, '41195', '918.8'],
  ['2026-04-09T05:30:00.000Z', '42.559', true, false, '41778', '968.22'],
  ['2026-04-18T05:30:00.000Z', '46.136', true, false, '42410', '1049.59'],
  ['2026-04-27T05:30:00.000Z', '46.063', true, false, '43041', '1047.93'],
  ['2026-05-06T05:30:00.000Z', '46.136', true, false, '43673', '1049.59'],
  ['2026-05-15T05:30:00.000Z', '27.638', true, true, '44304', '628.76'],
  ['2026-05-24T05:30:00.000Z', '46.136', true, false, '44936', '1049.59'],
  ['2026-06-02T05:30:00.000Z', '46.063', true, false, '45567', '1082.48'],
  ['2026-06-11T05:30:00.000Z', '46.136', true, false, '46199', '1084.2'],
  ['2026-06-20T05:30:00.000Z', '46.063', true, false, '46830', '1082.48'],
  ['2026-06-29T05:30:00.000Z', '46.136', true, false, '47462', '1084.2'],
  ['2026-07-08T05:30:00.000Z', '46.136', true, false, '48094', '1118.8'],
  ['2026-07-17T05:30:00.000Z', '46.063', true, false, '48725', '1117.03'],
  ['2026-07-26T05:30:00.000Z', '46.136', true, false, '49357', '1118.8'],
  ['2026-08-04T05:30:00.000Z', '46.063', true, false, '49988', '1117.03'],
  ['2026-08-13T05:30:00.000Z', '27.682', false, false, '50620', '671.29'],
  ['2026-08-22T05:30:00.000Z', '62.546', true, false, '51224', '1516.74'],
  ['2026-08-31T05:30:00.000Z', '21.827', true, false, '51523', '529.3'],
  ['2026-09-09T05:30:00.000Z', '21.827', true, false, '51822', '540.22'],
  ['2026-09-18T05:30:00.000Z', '21.827', true, false, '52121', '540.22'],
  ['2026-09-27T05:30:00.000Z', '21.827', true, false, '52420', '540.23'],
  ['2026-09-30T21:00:00.000Z', '8.833', true, false, '52541', '218.62'],
];

/** The mock's two services: [servicedOn, odometer, total EGP, first line]. */
export const COROLLA_SERVICES: readonly [string, string, string, string][] = [
  ['2026-06-18', '46695', '2250', 'Engine oil 5W-30'],
  ['2026-08-27', '51392', '4194.5', 'Front brake pads'],
];

export type Shift = {
  /** Months the fixture moves by (0 in October 2026, −1 in September, …). */
  months: number;
  /** The first instant of the current Cairo month, and of six months before it. */
  thisStart: string;
  fromStart: string;
  /** YYYY-MM of the current Cairo month. */
  thisMonth: string;
  /** A fixture time or day, moved. */
  at: (iso: string) => string;
  day: (date: string) => string;
  month: (yyyyMm: string) => string;
};

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export async function corollaShift(db: TestDb): Promise<Shift> {
  const [b] = await own<{ this_start: Date; from_start: Date; this_month: string }>(
    db,
    `SELECT (date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')
              AS this_start,
            ((date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') - interval '6 months')
              AT TIME ZONE 'Africa/Cairo') AS from_start,
            to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM') AS this_month`,
  );
  if (!b) throw new Error('no clock');
  const [ty, tm] = b.this_month.split('-').map(Number) as [number, number];
  const months = ty * 12 + tm - (2026 * 12 + 10);
  const moveDay = (date: string) => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    const nd = Math.min(d, daysIn(ny, nm));
    return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
  };
  const first = COROLLA_FILLS[0]?.[0];
  const last = COROLLA_FILLS.at(-1)?.[0];
  return {
    months,
    thisStart: b.this_start.toISOString(),
    fromStart: b.from_start.toISOString(),
    thisMonth: b.this_month,
    at: (iso) =>
      iso === first
        ? b.from_start.toISOString()
        : iso === last
          ? b.this_start.toISOString()
          : `${moveDay(iso.slice(0, 10))}${iso.slice(10)}`,
    day: moveDay,
    month: (yyyyMm) => moveDay(`${yyyyMm}-01`).slice(0, 7),
  };
}

/** Logs the fixture's fills on `thingId` through POST /api/v1/things/:id/fuel. */
export async function logCorollaFills(
  t: TestApp,
  as: Person,
  thingId: string,
  shift: Shift,
  opts: { vendor?: { id: string } | { name: string } } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const [at, amount, isFull, missedBefore, value, cost] of COROLLA_FILLS) {
    const id = newId();
    const res = await call(t, `/api/v1/things/${thingId}/fuel`, {
      as,
      body: {
        id,
        takenAt: shift.at(at),
        amount,
        unit: 'L',
        isFull,
        missedBefore,
        cost,
        currency: 'EGP',
        ...(opts.vendor ? { vendor: opts.vendor } : {}),
        reading: { value },
      },
      headers: { 'idempotency-key': newId() },
    });
    expect(res.statusCode, res.body).toBe(201);
    ids.push(id);
  }
  return ids;
}
