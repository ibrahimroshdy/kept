/**
 * Vehicles (product design D26, D52, D188; engineering spec §3.4; step-5 plan T1, Q2, Q5, Q8, Q19,
 * Q25): what counts as a vehicle, the cost categories, the starter schedules, the usage estimate's
 * inputs, and the distance driven over a period.
 *
 * The estimate itself has one implementation, in SQL (`kept.meter_estimate`, `kept.meter_eta`,
 * plan T7, Q8), used by the API, the vehicles list, the report and the reminder scan; the constants
 * here are its inputs (and the web mock's), so a change is made in both places at once.
 */

import { milli, milliOut } from './fuel.js';

/**
 * The built-in type every vehicle reaches (`types.builtin_key`, builtin-types.ts): a thing is a
 * vehicle when its type's chain reaches it through `parent_id` or `copied_from_id`
 * (`kept.is_vehicle_type`, Q2), so cars, motorbikes, bicycles and generators, and custom types
 * under Vehicle.
 */
export const VEHICLE_TYPE_KEY = 'vehicle';

/** A vehicle's running costs by category (the board's Fuel · Service & parts · Fees & insurance;
 * D26, Q5): fills' costs, confirmed services' totals, and documents' costs by their issue date. */
export const COST_CATEGORIES = ['fuel', 'service', 'fees'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

// ---------------------------------------------------------------------------------------------
// The usage estimate (D52, D188; screens §8; Q8)
// ---------------------------------------------------------------------------------------------

/** The rate is the accepted readings' rise over this many days before the latest reading. */
export const RATE_WINDOW_DAYS = 90;
/** …and needs two readings at least this many days apart. */
export const MIN_SPAN_DAYS = 7;
/** A reading this old gets advice: "reading is 34 days old". */
export const ADVICE_DAYS = 30;
/** A reading this old makes the estimate "unknown — reading needed": estimated dates disappear. */
export const UNKNOWN_DAYS = 60;
/** The stale-reading nudge's default interval (`meters.nudge_days`, §3.4, Q19): 7–365, or none. */
export const NUDGE_DAYS_DEFAULT = 30;
export const NUDGE_DAYS_MIN = 7;
export const NUDGE_DAYS_MAX = 365;

/** `kept.meter_estimate().advice`. */
export const READING_ADVICE = ['none', 'fresh', 'stale', 'unknown'] as const;
export type ReadingAdvice = (typeof READING_ADVICE)[number];

/** The advice for a latest reading `ageDays` whole days old (null: no reading yet). */
export function readingAdvice(ageDays: number | null): ReadingAdvice {
  if (ageDays === null) return 'none';
  if (ageDays >= UNKNOWN_DAYS) return 'unknown';
  if (ageDays >= ADVICE_DAYS) return 'stale';
  return 'fresh';
}

// ---------------------------------------------------------------------------------------------
// Starter schedules (D52, engineering spec §3.4: "editable defaults, not manufacturer advice")
// ---------------------------------------------------------------------------------------------

export const STARTER_KEYS = ['oil_change', 'tyre_rotation', 'brake_fluid', 'air_filter'] as const;
export type StarterKey = (typeof STARTER_KEYS)[number];

export type StarterSchedule = {
  key: StarterKey;
  /** English; the web translates by key. */
  name: string;
  everyMonths: number;
  /** In kilometres; null for a months-only schedule. */
  everyKm: string | null;
};

/** The four starter schedules, whichever comes first. Never created automatically (Q25). */
export const STARTER_SCHEDULES: readonly StarterSchedule[] = Object.freeze([
  { key: 'oil_change', name: 'Oil change', everyMonths: 12, everyKm: '10000' },
  { key: 'tyre_rotation', name: 'Tyre rotation', everyMonths: 12, everyKm: '10000' },
  { key: 'brake_fluid', name: 'Brake fluid', everyMonths: 24, everyKm: null },
  { key: 'air_filter', name: 'Air filter', everyMonths: 24, everyKm: '20000' },
]);

/**
 * A starter schedule's interval on a meter in `meterUnit` (Q25): the distance applies only to a
 * distance meter in km; on miles, or with no distance meter, the months alone (no rounded
 * conversion presented as advice).
 */
export function starterInterval(
  s: StarterSchedule,
  meter: { kind: string; unit: string } | null,
): { everyMonths: number; everyUnits: string | null } {
  const km = meter?.kind === 'distance' && meter.unit.trim().toLowerCase() === 'km';
  return { everyMonths: s.everyMonths, everyUnits: km ? s.everyKm : null };
}

// ---------------------------------------------------------------------------------------------
// Distance over a period
// ---------------------------------------------------------------------------------------------

export type SeriesPoint = {
  /** Offset-corrected (meter replacements, D52), as meters/check.ts compares them. */
  value: string;
  takenAt: Date | string;
};

const ms = (at: Date | string) => (at instanceof Date ? at.getTime() : Date.parse(at));

/**
 * The distance driven between two instants (T13's cost per km), from a meter's accepted readings:
 * linear interpolation between the readings around each end, and **no extrapolation** past the
 * first or last reading (the period is clipped to them). Null when fewer than two readings, or when
 * the clipped period is empty. A decimal string, 3 decimals at most.
 */
export function distanceBetween(
  series: readonly SeriesPoint[],
  from: Date | string,
  to: Date | string,
): string | null {
  const points = series
    .map((p) => ({ t: ms(p.takenAt), v: milli(p.value) }))
    .sort((a, b) => a.t - b.t);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return null;
  const start = Math.max(ms(from), first.t);
  const end = Math.min(ms(to), last.t);
  if (!(end > start)) return null;

  const at = (t: number): bigint => {
    let before = first;
    let after = last;
    for (const p of points) {
      if (p.t <= t) before = p;
      if (p.t >= t) {
        after = p;
        break;
      }
    }
    if (after.t === before.t) return before.v;
    // before.v + (after.v − before.v) × (t − before.t) / (after.t − before.t), rounded half up.
    const span = BigInt(after.t - before.t);
    const num = (after.v - before.v) * BigInt(t - before.t);
    const step = num >= 0n ? (2n * num + span) / (2n * span) : -((-2n * num + span) / (2n * span));
    return before.v + step;
  };
  return milliOut(at(end) - at(start));
}
