// Where a reading sits in its meter's series (plan T16; D26, D52, D112; engineering spec §3.4,
// §7.13). Pure: the service reads the meter, its replacement events and its accepted readings,
// and this decides.
//
// - Readings are ordered by when they were taken (D112), not when they arrived. A reading's
//   neighbours are the accepted readings just before and just after it in time; one that fits
//   between them is accepted, however late it arrives.
// - Values are compared after replacement offsets (D52): a meter replaced at `at` with offset `o`
//   reads `value + o` from then on, so the drop to a new odometer's 0 is not "backwards".
// - Backwards (below the one before, or above the one after) is an ordering fault; a rise faster
//   than the meter's `max_per_day` (§3.4: 1,500 km a day for distance, 24 h a day for hours) is
//   an implausible jump. What the caller does with each is the service's rule (D26: online, a
//   backwards reading is refused at entry and a jump waits for review; by sync, step 3, both go
//   to the Inbox).
// - A reading made from a service (step 5) is taken at the service date, 12:00 in the location's
//   timezone (§7.13); its caller computes that `takenAt` before it gets here.
//
// Values are numeric(14,3) (§7.13): compared exactly, as whole thousandths in BigInt.

import { decimalOut, milli } from '@kept/shared';

export type ReviewReason = 'lower_than_previous' | 'higher_than_next' | 'implausible_jump';

export type SeriesReading = { id: string; value: string; takenAt: Date };
export type ReplacementEvent = { at: Date; offset: string };

export type Placement = {
  /** Null when the reading fits. */
  reason: ReviewReason | null;
  previous: SeriesReading | null;
  next: SeriesReading | null;
};

/** A meter value: at most 11 digits before the point and 3 after (numeric(14,3)). */
export const METER_VALUE = /^\d{1,11}(\.\d{1,3})?$/;
/** A replacement offset may be negative (a replacement unit that already showed more). */
export const METER_OFFSET = /^-?\d{1,11}(\.\d{1,3})?$/;

const DAY_MS = 86_400_000n;

// `milli` (thousandths of a decimal string) and `decimalOut` (a numeric(14,3) without trailing
// zeros) live in @kept/shared's fuel.ts since step 5, so the fuel maths shares one copy.
export { decimalOut, milli };

/**
 * The daily limit that applies: the meter's own, else the §3.4 default for its kind. Distance
 * defaults only for the units whose scale is known (km, mi); a custom meter has none.
 */
export function dailyLimit(meter: {
  kind: string;
  unit: string;
  maxPerDay: string | null;
}): bigint | null {
  if (meter.maxPerDay !== null) return milli(meter.maxPerDay);
  if (meter.kind === 'hours') return milli('24');
  if (meter.kind === 'distance') {
    const unit = meter.unit.trim().toLowerCase();
    if (unit === 'km') return milli('1500');
    if (unit === 'mi') return milli('932');
  }
  return null;
}

/** The offset in force at `t`: the latest replacement at or before it, else 0. */
function offsetAt(events: readonly ReplacementEvent[], t: Date): bigint {
  let found: ReplacementEvent | null = null;
  for (const e of events) {
    if (e.at.getTime() <= t.getTime() && (!found || e.at.getTime() >= found.at.getTime())) {
      found = e;
    }
  }
  return found ? milli(found.offset) : 0n;
}

/** Whether rising `delta` over `ms` beats `limit` a day. Any gap counts as at least a day, so
 * two readings minutes apart may still differ by a day's worth. */
function tooFast(delta: bigint, ms: bigint, limit: bigint): boolean {
  if (delta <= 0n) return false;
  const span = ms > DAY_MS ? ms : DAY_MS;
  return delta * DAY_MS > limit * span;
}

/**
 * Where `candidate` falls among `accepted` (the meter's accepted readings, the candidate itself
 * excluded). A reading taken at the same instant as another counts as after it.
 */
export function placeReading(
  candidate: { value: string; takenAt: Date },
  accepted: readonly SeriesReading[],
  events: readonly ReplacementEvent[],
  limit: bigint | null,
): Placement {
  const t = candidate.takenAt.getTime();
  let previous: SeriesReading | null = null;
  let next: SeriesReading | null = null;
  for (const r of accepted) {
    const rt = r.takenAt.getTime();
    if (rt <= t) {
      if (!previous || rt > previous.takenAt.getTime()) previous = r;
    } else if (!next || rt < next.takenAt.getTime()) next = r;
  }
  const at = (r: { value: string; takenAt: Date }) => milli(r.value) + offsetAt(events, r.takenAt);
  const value = at(candidate);

  let reason: ReviewReason | null = null;
  if (previous && value < at(previous)) reason = 'lower_than_previous';
  else if (next && value > at(next)) reason = 'higher_than_next';
  else if (limit !== null) {
    const fromPrevious =
      previous && tooFast(value - at(previous), BigInt(t - previous.takenAt.getTime()), limit);
    const toNext = next && tooFast(at(next) - value, BigInt(next.takenAt.getTime() - t), limit);
    if (fromPrevious || toNext) reason = 'implausible_jump';
  }
  return { reason, previous, next };
}
