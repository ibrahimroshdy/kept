import {
  type ConsumptionFill,
  consumption,
  distanceBetween,
  type FuelUnit,
  perDistance,
  pricePerUnit,
} from '@kept/shared';
import type { Ctx } from '../schedules/service.js';
import { gateFor } from '../serialize/gates.js';
import {
  correctedSeries,
  correctedValueSql,
  liveThingOf,
  monthBounds,
  odometerOf,
} from '../vehicles/meters.js';

// A vehicle's fuel summary (step-5 plan T11; D28, D170; Q6, Q7, Q22): consumption per unit over
// the last `window` usable full-to-full intervals (@kept/shared consumption(), the web mock's
// twin), its trend, the price per unit, and the cost per distance and a month's average over the
// last `months` full local months. Reading values are offset-corrected (D52) and only accepted
// readings count. Money (prices, costs) only through the gate; per currency, never added
// together (Q22). Stored units are never converted (D76): the web converts the derived figure.

export type FuelSummary = {
  byUnit: Array<{
    unit: FuelUnit;
    consumption: {
      perHundred: string;
      distanceUnit: string;
      fills: number;
      from: string;
      to: string;
    } | null;
    whyNone?: 'too_few_full_fills' | 'missed_fill' | 'mixed_units' | 'no_readings';
    trend: Array<{ at: string; perHundred: string }>;
  }>;
  pricePerUnit?: Array<{
    unit: FuelUnit;
    currency: string;
    latest: string;
    trend: Array<{ at: string; price: string }>;
  }>;
  perDistance?: Array<{
    currency: string;
    amount: string;
    distanceUnit: string;
    from: string;
    to: string;
  }>;
  monthlyAverage?: Array<{ currency: string; amount: string; months: number }>;
  moneyHidden?: true;
};

type FillRow = {
  taken_at: Date;
  amount: string;
  unit: FuelUnit;
  is_full: boolean;
  missed_before: boolean;
  cost: string | null;
  currency: string | null;
  reading_value: string | null;
};

const iso = (at: Date | string) => (at instanceof Date ? at.toISOString() : at);

/** Every fill of a thing, oldest first, with its accepted reading's corrected value. */
export async function fillsOf(
  client: Ctx['client'],
  thingId: string,
): Promise<(ConsumptionFill & { takenAt: Date; cost: string | null; currency: string | null })[]> {
  const { rows } = await client.query<FillRow>(
    `SELECT f.taken_at, trim_scale(f.amount)::text AS amount, f.unit, f.is_full, f.missed_before,
            trim_scale(f.cost)::text AS cost, f.currency,
            CASE WHEN d.state = 'accepted' THEN trim_scale(${correctedValueSql('d')})::text END
              AS reading_value
       FROM public.fuel_entries f
       LEFT JOIN public.meter_readings d ON d.id = f.meter_reading_id
      WHERE f.thing_id = $1
      ORDER BY f.taken_at, f.id`,
    [thingId],
  );
  return rows.map((r) => ({
    takenAt: r.taken_at,
    amount: r.amount,
    unit: r.unit,
    isFull: r.is_full,
    missedBefore: r.missed_before,
    cost: r.cost,
    currency: r.currency,
    reading: r.reading_value === null ? null : { value: r.reading_value },
  }));
}

/** GET /api/v1/things/:id/fuel/summary?window=5&months=6. */
export async function fuelSummary(
  ctx: Ctx,
  thingId: string,
  opts: { window: number; months: number },
): Promise<FuelSummary> {
  const { client } = ctx;
  const thing = await liveThingOf(client, thingId);
  const meter = await odometerOf(client, thing.id);
  const fills = await fillsOf(client, thing.id);
  const units = [...new Set(fills.map((f) => f.unit))];
  const summary: FuelSummary = {
    byUnit: units.map((unit) => {
      const c = consumption(fills, { window: opts.window, unit });
      const all = consumption(fills, { window: Number.MAX_SAFE_INTEGER, unit });
      return {
        unit,
        consumption:
          c.overall && meter
            ? {
                perHundred: c.overall.perHundred,
                distanceUnit: meter.unit,
                fills: c.overall.fills,
                from: iso(c.overall.fromAt),
                to: iso(c.overall.toAt),
              }
            : null,
        ...(c.whyNone ? { whyNone: c.whyNone } : {}),
        trend: all.intervals.map((i) => ({ at: iso(i.toAt), perHundred: i.perHundred })),
      };
    }),
  };
  if (!(await gateFor(ctx.tx, thing.location_id, ctx.scope)).showMoney) {
    return { ...summary, moneyHidden: true };
  }

  const priced = fills.filter(
    (f): f is typeof f & { cost: string; currency: string } =>
      f.cost !== null && f.currency !== null,
  );
  const pairs = [...new Set(priced.map((f) => `${f.unit}|${f.currency}`))];
  summary.pricePerUnit = pairs.map((pair) => {
    const [unit, currency] = pair.split('|') as [FuelUnit, string];
    const trend = priced
      .filter((f) => f.unit === unit && f.currency === currency)
      .map((f) => ({ at: f.takenAt.toISOString(), price: pricePerUnit(f)?.amount ?? '0' }));
    return { unit, currency, latest: trend.at(-1)?.price ?? '0', trend };
  });

  // The cost per distance and the month's average over the last `months` full local months: the
  // current month is "so far" and never averaged (D188).
  const bounds = await monthBounds(client, thing.location_id, opts.months);
  const inWindow = priced.filter(
    (f) => f.takenAt >= bounds.fromStart && f.takenAt < bounds.thisStart,
  );
  const costs = inWindow.map((f) => ({ amount: f.cost, currency: f.currency }));
  const from = bounds.fromStart.toISOString();
  const to = bounds.thisStart.toISOString();
  if (meter) {
    const distance = distanceBetween(
      await correctedSeries(client, meter.id),
      bounds.fromStart,
      bounds.thisStart,
    );
    if (distance) {
      summary.perDistance = perDistance(costs, distance).map((x) => ({
        ...x,
        distanceUnit: meter.unit,
        from,
        to,
      }));
    }
  }
  summary.monthlyAverage = perDistance(costs, String(opts.months)).map((x) => ({
    currency: x.currency,
    amount: x.amount,
    months: opts.months,
  }));
  return summary;
}
