import type pg from 'pg';
import { invalid, notFound } from '../http/errors.js';
import { estimateOf } from '../meters/estimate.js';
import { type Ctx, todayIn } from '../schedules/service.js';
import { gateFor } from '../serialize/gates.js';
import { correctedSeries } from './meters.js';

// A meter's series for the vehicle's charts (step-5 plan T13; D52, D188; Q8): its accepted
// readings (offset-corrected, D52, so a replaced odometer draws one line), the usage estimate
// dashed on to the next threshold, and the thresholds of step 4's unit schedules on the meter
// with their estimated dates (kept.schedule_next(), 0066: the same dates the agenda and the
// reminder scan use). The estimate is kept.meter_estimate()'s rate (meters/estimate.ts); with no
// rate (under two readings a week apart, or the latest 60 days old) there is none.

export type MeterSeries = {
  unit: string;
  points: Array<{ takenAt: string; value: string; source: string }>;
  estimate?: { perDay: string; through: Array<{ at: string; value: string }> };
  thresholds: Array<{
    scheduleId: string;
    name: string;
    value: string;
    estimatedOn: string | null;
  }>;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A bound as an instant: a day is its first instant in `timezone` (`to` a day: the next day's,
 * so the day itself is in), a time is itself. */
async function boundOf(
  client: pg.ClientBase,
  value: string | undefined,
  timezone: string,
  end: boolean,
): Promise<Date | null> {
  if (!value) return null;
  if (DATE.test(value)) {
    const { rows } = await client.query<{ at: Date }>(
      `SELECT (($1::date + $3::int)::timestamp AT TIME ZONE $2) AS at`,
      [value, timezone, end ? 1 : 0],
    );
    return (rows[0] as { at: Date }).at;
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid('Check from and to: a day or a time.');
  return at;
}

/** GET /api/v1/meters/:id/series?from&to → MeterSeries. */
export async function meterSeries(
  ctx: Ctx,
  meterId: string,
  q: { from?: string | undefined; to?: string | undefined },
): Promise<MeterSeries> {
  const { client } = ctx;
  const { rows } = await client.query<{
    id: string;
    unit: string;
    location_id: string;
    timezone: string;
  }>(
    `SELECT m.id, m.unit, m.location_id, l.timezone
       FROM public.meters m
       JOIN public.things t ON t.id = m.thing_id AND t.deleted_at IS NULL
       JOIN public.locations l ON l.id = m.location_id
      WHERE m.id = $1`,
    [meterId],
  );
  const meter = rows[0];
  if (!meter) throw notFound();
  const from = await boundOf(client, q.from, meter.timezone, false);
  const to = await boundOf(client, q.to, meter.timezone, true);
  const points = await correctedSeries(client, meter.id, { from, to });

  let thresholds: MeterSeries['thresholds'] = [];
  if ((await gateFor(ctx.tx, meter.location_id, ctx.scope)).modules.has('schedules')) {
    const today = await todayIn(client, meter.location_id);
    const { rows: due } = await client.query<{
      id: string;
      name: string;
      value: string;
      estimated_on: string | null;
    }>(
      `SELECT s.id, s.name, trim_scale(n.due_value)::text AS value,
              n.estimated_on::text AS estimated_on
         FROM public.schedules s
        CROSS JOIN LATERAL kept.schedule_next(s.id, $2::date) n
        WHERE s.meter_id = $1 AND s.active AND n.due_value IS NOT NULL
        ORDER BY n.due_value, s.name, s.id`,
      [meter.id, today],
    );
    thresholds = due.map((d) => ({
      scheduleId: d.id,
      name: d.name,
      value: d.value,
      estimatedOn: d.estimated_on,
    }));
  }

  const series: MeterSeries = {
    unit: meter.unit,
    points: points.map((p) => ({
      takenAt: p.takenAt.toISOString(),
      value: p.value,
      source: p.source,
    })),
    thresholds,
  };
  const estimate = await estimateOf(client, meter.id);
  const last = (await correctedSeries(client, meter.id)).at(-1);
  if (estimate.perDay && last) {
    // Dashed on to the next threshold ahead, or 90 days on when there is none.
    const target = thresholds.find((x) => Number(x.value) > Number(last.value));
    const { rows: end } = await client.query<{ at: string | null; value: string }>(
      target
        ? `SELECT kept.meter_eta($1, $2::numeric)::text AS at, $2::text AS value`
        : `SELECT (($3::timestamptz + interval '90 days') AT TIME ZONE l.timezone)::date::text AS at,
                  trim_scale(round($2::numeric + $4::numeric * 90, 3))::text AS value
             FROM public.meters m JOIN public.locations l ON l.id = m.location_id
            WHERE m.id = $1`,
      target ? [meter.id, target.value] : [meter.id, last.value, last.takenAt, estimate.perDay],
    );
    const e = end[0];
    if (e?.at) {
      series.estimate = {
        perDay: estimate.perDay,
        through: [
          { at: last.takenAt.toISOString(), value: last.value },
          { at: `${e.at}T12:00:00.000Z`, value: e.value },
        ],
      };
    }
  }
  return series;
}
