import { COST_CATEGORIES, type CostCategory, distanceBetween, perDistance } from '@kept/shared';
import type pg from 'pg';
import { invalid } from '../http/errors.js';
import type { Ctx } from '../schedules/service.js';
import { gateFor } from '../serialize/gates.js';
import { correctedSeries, liveThingOf, monthBounds, odometerOf } from './meters.js';

// A vehicle's running costs (step-5 plan T13; D26, D76, D188; Q5, Q22), the Costs tab:
// - fuel: the fills' costs, by the month they were taken in the location's zone;
// - service: confirmed service records' totals, by the day they were done (a draft counts
//   nowhere, Q12);
// - fees: documents' costs, current and superseded, by their issue date (none without one, Q5).
// Per currency, never added across currencies (Q22), and never converted: step 4's exchange
// rates exist, but the contract has no report currency yet, so none is asked for.
//
// The current month is "so far" (D188): shown, never totalled, averaged or divided by distance.
// The distance is the odometer's rise over the full months only (@kept/shared distanceBetween,
// offset-corrected, interpolated at the months' first instants, never extrapolated); on an hours
// meter it is hours, so a generator's cost is per hour the same way. Money leaves only through the
// gate: with it hidden, months carry their notes and no amounts, and `moneyHidden: true`.

export type CostAmounts = Record<CostCategory, string> & { total: string };

export type CostReport = {
  period: { from: string; to: string };
  distance: { value: string; unit: string; basis: 'readings' } | null;
  months: Array<{
    month: string;
    soFar: boolean;
    byCurrency: Array<CostAmounts & { currency: string }>;
    notes: string[];
  }>;
  totals: Array<CostAmounts & { currency: string; perDistance?: string; monthlyAverage: string }>;
  moneyHidden?: true;
};

const MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;
const MAX_MONTHS = 120;

/** YYYY-MM `offset` months from `month`. */
export function addMonths(month: string, offset: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function monthOf(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  const m = MONTH.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw invalid(`Check ${name}: a month (YYYY-MM) or a day (YYYY-MM-DD).`);
  }
  return `${m[1]}-${m[2]}`;
}

/** The last day of a YYYY-MM month. */
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

// Money as whole ten-thousandths (numeric(16,4)), added exactly.
const SCALE = 10_000n;
const toUnits = (s: string): bigint => {
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(4, '0').slice(0, 4));
};
const fromUnits = (n: bigint): string => {
  const frac = (n % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return `${n / SCALE}${frac ? `.${frac}` : ''}`;
};

type Sums = Record<CostCategory, bigint>;
const zero = (): Sums => ({ fuel: 0n, service: 0n, fees: 0n });
const amountsOf = (row: Sums): CostAmounts => ({
  fuel: fromUnits(row.fuel),
  service: fromUnits(row.service),
  fees: fromUnits(row.fees),
  total: fromUnits(row.fuel + row.service + row.fees),
});

/** The first instant of a local month, in `timezone`. */
async function monthStart(client: pg.ClientBase, timezone: string, month: string): Promise<Date> {
  const { rows } = await client.query<{ at: Date }>(
    `SELECT (($1 || '-01')::date::timestamp AT TIME ZONE $2) AS at`,
    [month, timezone],
  );
  return (rows[0] as { at: Date }).at;
}

/** GET /api/v1/things/:id/costs?from&to → CostReport. Default: the last 6 full months and the
 * current month so far. */
export async function costReport(
  ctx: Ctx,
  thingId: string,
  q: { from?: string | undefined; to?: string | undefined },
): Promise<CostReport> {
  const { client } = ctx;
  const thing = await liveThingOf(client, thingId);
  const bounds = await monthBounds(client, thing.location_id, 6);
  const from = monthOf(q.from, addMonths(bounds.thisMonth, -6), 'from');
  const to = monthOf(q.to, bounds.thisMonth, 'to');
  if (from > to) throw invalid('Check from: on or before to.');
  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    months.push(m);
    if (months.length > MAX_MONTHS) throw invalid(`At most ${MAX_MONTHS} months at a time.`);
  }

  const { rows: sums } = await client.query<{
    month: string;
    currency: string;
    category: CostCategory;
    amount: string;
  }>(
    `SELECT x.month, x.currency, x.category, trim_scale(sum(x.amount))::text AS amount
       FROM (
         SELECT to_char(f.taken_at AT TIME ZONE $2, 'YYYY-MM') AS month, f.currency,
                'fuel' AS category, f.cost AS amount
           FROM public.fuel_entries f WHERE f.thing_id = $1 AND f.cost IS NOT NULL
         UNION ALL
         SELECT to_char(r.serviced_on, 'YYYY-MM'), r.currency, 'service', r.total
           FROM public.service_records r
          WHERE r.thing_id = $1 AND r.review_state = 'confirmed' AND r.total IS NOT NULL
         UNION ALL
         SELECT to_char(d.issued_on, 'YYYY-MM'), d.currency, 'fees', d.cost
           FROM public.expiring_documents d
          WHERE d.thing_id = $1 AND d.issued_on IS NOT NULL AND d.cost IS NOT NULL) x
      WHERE x.month BETWEEN $3 AND $4
      GROUP BY x.month, x.currency, x.category
      ORDER BY x.month, x.currency`,
    [thing.id, bounds.timezone, from, to],
  );
  // A service's summary for the chart's direct labels: the schedule it completed, else its first
  // line. Not money.
  const { rows: notes } = await client.query<{ month: string; note: string | null }>(
    `SELECT to_char(r.serviced_on, 'YYYY-MM') AS month,
            coalesce(
              (SELECT s.name FROM public.service_completions c
                 JOIN public.schedules s ON s.id = c.schedule_id
                WHERE c.service_record_id = r.id ORDER BY s.name LIMIT 1),
              (SELECT l.description FROM public.service_lines l
                WHERE l.service_record_id = r.id ORDER BY l.sort, l.id LIMIT 1)) AS note
       FROM public.service_records r
      WHERE r.thing_id = $1 AND r.review_state = 'confirmed'
        AND to_char(r.serviced_on, 'YYYY-MM') BETWEEN $2 AND $3
      ORDER BY r.serviced_on, r.id`,
    [thing.id, from, to],
  );

  const byMonth = new Map<string, Map<string, Sums>>();
  for (const s of sums) {
    const cur = byMonth.get(s.month) ?? new Map<string, Sums>();
    const row = cur.get(s.currency) ?? zero();
    row[s.category] += toUnits(s.amount);
    cur.set(s.currency, row);
    byMonth.set(s.month, cur);
  }
  const notesOf = new Map<string, string[]>();
  for (const n of notes) {
    if (!n.note) continue;
    notesOf.set(n.month, [...(notesOf.get(n.month) ?? []), n.note]);
  }

  const full = months.filter((m) => m < bounds.thisMonth);
  const meter = await odometerOf(client, thing.id);
  let distance: string | null = null;
  const first = full[0];
  const last = full.at(-1);
  if (meter && first && last) {
    distance = distanceBetween(
      await correctedSeries(client, meter.id),
      await monthStart(client, bounds.timezone, first),
      await monthStart(client, bounds.timezone, addMonths(last, 1)),
    );
  }

  const money = (await gateFor(ctx.tx, thing.location_id, ctx.scope)).showMoney;
  const report: CostReport = {
    period: { from: `${from}-01`, to: lastDay(to) },
    distance: distance && meter ? { value: distance, unit: meter.unit, basis: 'readings' } : null,
    months: months.map((month) => ({
      month,
      soFar: month === bounds.thisMonth,
      byCurrency: money
        ? [...(byMonth.get(month) ?? new Map<string, Sums>())].map(([currency, row]) => ({
            currency,
            ...amountsOf(row),
          }))
        : [],
      notes: notesOf.get(month) ?? [],
    })),
    totals: [],
  };
  if (!money) return { ...report, moneyHidden: true };

  const totals = new Map<string, Sums>();
  for (const month of full) {
    for (const [currency, row] of byMonth.get(month) ?? []) {
      const acc = totals.get(currency) ?? zero();
      for (const c of COST_CATEGORIES) acc[c] += row[c];
      totals.set(currency, acc);
    }
  }
  report.totals = [...totals].map(([currency, row]) => {
    const total = fromUnits(row.fuel + row.service + row.fees);
    const per = distance ? perDistance([{ amount: total, currency }], distance)[0] : undefined;
    const average = perDistance([{ amount: total, currency }], String(full.length))[0];
    return {
      currency,
      ...amountsOf(row),
      ...(per ? { perDistance: per.amount } : {}),
      monthlyAverage: average?.amount ?? '0',
    };
  });
  return report;
}
