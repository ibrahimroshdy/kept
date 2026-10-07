import type { SeriesPoint } from '@kept/shared';
import type pg from 'pg';
import { AppError, notFound } from '../http/errors.js';

// What fuel, costs and the series share about a vehicle's odometer (step 5, T11 and T13).
//
// - A vehicle's odometer is its first distance meter, else its first meter (a generator's hours):
//   the web mock's `mainMeter()`, and the meter a fill's reading goes on unless it names another.
// - A meter's series is its accepted readings with each value offset-corrected by the latest
//   replacement at or before it (`meter_events`, D52), exactly as `kept.meter_estimate()` corrects
//   them (0066), so a distance across a replaced odometer is the distance driven.

export type VehicleMeter = { id: string; kind: string; unit: string };

/** The thing's odometer (first distance meter, else first meter), or null when it has none. */
export async function odometerOf(
  client: pg.ClientBase,
  thingId: string,
): Promise<VehicleMeter | null> {
  const { rows } = await client.query<VehicleMeter>(
    `SELECT m.id, m.kind, m.unit FROM public.meters m WHERE m.thing_id = $1
      ORDER BY (m.kind = 'distance') DESC, m.created_at, m.id LIMIT 1`,
    [thingId],
  );
  return rows[0] ?? null;
}

/** 400 `fuel_needs_meter`: a fill's odometer needs a meter on the thing. */
export const fuelNeedsMeter = () =>
  new AppError('fuel_needs_meter', 400, 'This thing has no meter for the odometer.');

/** The meter a fill's reading goes on: `meterId` when it is the thing's, else its odometer. */
export async function fillMeter(
  client: pg.ClientBase,
  thingId: string,
  meterId?: string | null,
): Promise<VehicleMeter> {
  if (meterId) {
    const { rows } = await client.query<VehicleMeter>(
      'SELECT id, kind, unit FROM public.meters WHERE id = $1 AND thing_id = $2',
      [meterId.toLowerCase(), thingId],
    );
    const m = rows[0];
    if (!m) throw notFound();
    return m;
  }
  const m = await odometerOf(client, thingId);
  if (!m) throw fuelNeedsMeter();
  return m;
}

/** SQL: a reading `d`'s value, offset-corrected by the replacement in force when it was taken. */
export const correctedValueSql = (d = 'd') => `(${d}.value + coalesce(
    (SELECT e."offset" FROM public.meter_events e
      WHERE e.meter_id = ${d}.meter_id AND e.kind = 'replaced' AND e.at <= ${d}.taken_at
      ORDER BY e.at DESC, e.id DESC LIMIT 1), 0))`;

export type CorrectedReading = SeriesPoint & {
  id: string;
  takenAt: Date;
  source: string;
};

/** A meter's accepted readings, oldest first, offset-corrected; between `from` and `to` when
 * given (`to` exclusive). */
export async function correctedSeries(
  client: pg.ClientBase,
  meterId: string,
  range: { from?: Date | null; to?: Date | null } = {},
): Promise<CorrectedReading[]> {
  const { rows } = await client.query<{
    id: string;
    value: string;
    taken_at: Date;
    source: string;
  }>(
    `SELECT d.id, trim_scale(${correctedValueSql('d')})::text AS value, d.taken_at, d.source
       FROM public.meter_readings d
      WHERE d.meter_id = $1 AND d.state = 'accepted'
        AND ($2::timestamptz IS NULL OR d.taken_at >= $2)
        AND ($3::timestamptz IS NULL OR d.taken_at < $3)
      ORDER BY d.taken_at, d.id`,
    [meterId, range.from ?? null, range.to ?? null],
  );
  return rows.map((r) => ({ id: r.id, value: r.value, takenAt: r.taken_at, source: r.source }));
}

/** The local-month boundaries of a location, as instants: the start of the current month, and
 * of `back` months before it. */
export async function monthBounds(
  client: pg.ClientBase,
  locationId: string,
  back: number,
): Promise<{ timezone: string; thisMonth: string; thisStart: Date; fromStart: Date }> {
  const { rows } = await client.query<{
    timezone: string;
    this_month: string;
    this_start: Date;
    from_start: Date;
  }>(
    `SELECT l.timezone,
            to_char(now() AT TIME ZONE l.timezone, 'YYYY-MM') AS this_month,
            (date_trunc('month', now() AT TIME ZONE l.timezone) AT TIME ZONE l.timezone)
              AS this_start,
            ((date_trunc('month', now() AT TIME ZONE l.timezone) - make_interval(months => $2))
              AT TIME ZONE l.timezone) AS from_start
       FROM public.locations l WHERE l.id = $1`,
    [locationId, back],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return {
    timezone: r.timezone,
    thisMonth: r.this_month,
    thisStart: r.this_start,
    fromStart: r.from_start,
  };
}

/** A live thing the caller can see, with its location; 404 otherwise. */
export async function liveThingOf(
  client: pg.ClientBase,
  thingId: string,
): Promise<{ id: string; location_id: string; name: string | null; lifecycle: string }> {
  const { rows } = await client.query<{
    id: string;
    location_id: string;
    name: string | null;
    lifecycle: string;
  }>(
    'SELECT id, location_id, name, lifecycle FROM public.things WHERE id = $1 AND deleted_at IS NULL',
    [thingId.toLowerCase()],
  );
  const t = rows[0];
  if (!t) throw notFound();
  return t;
}
