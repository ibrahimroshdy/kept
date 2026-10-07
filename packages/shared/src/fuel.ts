/**
 * Fuel and charging maths (product design D28, D170; engineering spec §1.6; step-5 plan T1, Q6,
 * Q7, Q22). Pure: the server's fuel summary (apps/server/src/fuel/summary.ts) and the web's mock
 * both call these, so the screen and the API agree.
 *
 * - Values are decimal strings. Amounts and readings are numeric(…,3): compared and summed as whole
 *   thousandths in BigInt (`milli`), exactly as the meters' neighbours check does
 *   (apps/server/src/meters/check.ts re-exports `milli` and `decimalOut` from here). Money is
 *   numeric(16,4) and goes through the exact decimal helpers in ./decimal.ts.
 * - Consumption is measured full to full (Q6): an interval runs from one full fill to the next, and
 *   its fuel is every fill after the first full up to and including the closing full (partials in
 *   between count). An interval is skipped when an end has no reading, when a fill in it is marked
 *   "I missed a fill-up before this one" (D170), when it mixes units (a plug-in hybrid), or when
 *   the distance isn't positive.
 * - Stored values are never converted (D76); only the derived figure follows the person's units
 *   (Q7): metric L/100 km and kWh/100 km, imperial mpg (US) and mi/kWh. `gal` is the US gallon.
 */

import { fromScaled, roundDiv, SCALE, toScaled } from './decimal.js';

/** `fuel_entries.unit` (Q7). `gal` is the US gallon: UK and Canadian pumps sell litres. */
export const FUEL_UNITS = ['L', 'kWh', 'gal'] as const;
export type FuelUnit = (typeof FUEL_UNITS)[number];

/** How many fill intervals the headline consumption covers by default (Q6). */
export const CONSUMPTION_WINDOW = 5;

/** Exact conversion constants (Q7): 1 US gallon = 3.785411784 L; 1 mile = 1.609344 km. */
export const LITRES_PER_US_GALLON = '3.785411784';
export const KM_PER_MILE = '1.609344';

// ---------------------------------------------------------------------------------------------
// Thousandths
// ---------------------------------------------------------------------------------------------

/** Thousandths of a decimal string (`"53000.5"` → 53000500n). Digits past the third are cut. */
export function milli(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const n = BigInt(whole) * 1000n + BigInt(`${frac}000`.slice(0, 3));
  return negative ? -n : n;
}

/** A numeric(…,3) as the API writes it: no trailing zeros (`"53000.500"` → `"53000.5"`). */
export function decimalOut(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Thousandths back to a canonical decimal string (`53000500n` → `"53000.5"`). */
export function milliOut(n: bigint): string {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------------------------

/** One fill or charge, as the consumption needs it. */
export type ConsumptionFill = {
  takenAt: Date | string;
  /** A decimal string, > 0. */
  amount: string;
  unit: FuelUnit;
  /** Filled (or charged) to full. On a charge, "to your usual full" (Q6). */
  isFull: boolean;
  /** "I missed a fill-up before this one" (D170): no consumption across the gap. */
  missedBefore: boolean;
  /** Its odometer reading, offset-corrected by the caller (meter replacements, D52); null: none. */
  reading: { value: string } | null;
};

export type ConsumptionInterval = {
  /** Fuel per 100 of the meter's unit (L/100 km for litres on a km odometer), 3 decimals at most. */
  perHundred: string;
  unit: FuelUnit;
  /** The fuel in the interval and the distance it covered, decimal strings. */
  amount: string;
  distance: string;
  /** The opening and closing full fills' times, as given. */
  fromAt: Date | string;
  toAt: Date | string;
  /** How many fills the interval's fuel adds up (the closing full and the partials before it). */
  fills: number;
};

/** Why no consumption can be shown. */
export type ConsumptionWhyNone =
  | 'too_few_full_fills'
  | 'missed_fill'
  | 'mixed_units'
  | 'no_readings';

export type Consumption = {
  /** The last `window` usable intervals, oldest first. */
  intervals: ConsumptionInterval[];
  /** The intervals together (their fuel over their distance), when they share one unit. */
  overall: ConsumptionInterval | null;
  /** Only when `intervals` is empty. */
  whyNone?: ConsumptionWhyNone;
};

/** Fuel per 100 distance units, in thousandths, rounded half up. */
const perHundredMilli = (amount: bigint, distance: bigint): bigint =>
  roundDiv(amount * 100n * 1000n, distance);

/**
 * Consumption over a vehicle's fills, oldest first (Q6). With `unit`, only full fills in that
 * unit open and close intervals (the per-unit summary of a plug-in hybrid); a fill in another unit
 * inside an interval still breaks it (`mixed_units`).
 */
export function consumption(
  fills: readonly ConsumptionFill[],
  opts: { window?: number; unit?: FuelUnit } = {},
): Consumption {
  const window = opts.window ?? CONSUMPTION_WINDOW;
  const bounds = fills
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.isFull && (!opts.unit || f.unit === opts.unit))
    .map(({ i }) => i);

  const usable: (ConsumptionInterval & { amountMilli: bigint; distanceMilli: bigint })[] = [];
  let lastSkip: ConsumptionWhyNone | null = null;
  for (let b = 1; b < bounds.length; b++) {
    const open = fills[bounds[b - 1] as number] as ConsumptionFill;
    const closeAt = bounds[b] as number;
    const close = fills[closeAt] as ConsumptionFill;
    const inside = fills.slice((bounds[b - 1] as number) + 1, closeAt + 1);

    let skip: ConsumptionWhyNone | null = null;
    if (!open.reading || !close.reading) skip = 'no_readings';
    else if (inside.some((f) => f.missedBefore)) skip = 'missed_fill';
    else if ([open, ...inside].some((f) => f.unit !== close.unit)) skip = 'mixed_units';
    const distance =
      open.reading && close.reading ? milli(close.reading.value) - milli(open.reading.value) : 0n;
    // A distance of 0 or less can't give a consumption (inferred: counted as missing readings).
    if (!skip && distance <= 0n) skip = 'no_readings';
    if (skip) {
      lastSkip = skip;
      continue;
    }
    const amount = inside.reduce((sum, f) => sum + milli(f.amount), 0n);
    usable.push({
      perHundred: milliOut(perHundredMilli(amount, distance)),
      unit: close.unit,
      amount: milliOut(amount),
      distance: milliOut(distance),
      fromAt: open.takenAt,
      toAt: close.takenAt,
      fills: inside.length,
      amountMilli: amount,
      distanceMilli: distance,
    });
  }

  const kept = usable.slice(-window);
  const intervals = kept.map(({ amountMilli: _a, distanceMilli: _d, ...i }) => i);
  const first = kept[0];
  const last = kept.at(-1);
  let overall: ConsumptionInterval | null = null;
  if (first && last && kept.every((i) => i.unit === first.unit)) {
    const amount = kept.reduce((s, i) => s + i.amountMilli, 0n);
    const distance = kept.reduce((s, i) => s + i.distanceMilli, 0n);
    overall = {
      perHundred: milliOut(perHundredMilli(amount, distance)),
      unit: first.unit,
      amount: milliOut(amount),
      distance: milliOut(distance),
      fromAt: first.fromAt,
      toAt: last.toAt,
      fills: kept.reduce((s, i) => s + i.fills, 0),
    };
  }
  if (intervals.length > 0) return { intervals, overall };
  return {
    intervals,
    overall,
    whyNone: bounds.length < 2 ? 'too_few_full_fills' : (lastSkip ?? 'too_few_full_fills'),
  };
}

// ---------------------------------------------------------------------------------------------
// Display units (Q7)
// ---------------------------------------------------------------------------------------------

export type UnitSystem = 'metric' | 'imperial';

export type ConsumptionDisplay = {
  /** One decimal, canonical (`"6.9"`, `"34.1"`). */
  value: string;
  /** `L/100 km`, `kWh/100 km`, `mpg`, `mi/kWh`; per hour for an hours meter (`L/h`). */
  unit: string;
};

/** A positive rational, rounded half up to `dp` decimals. */
function ratio(n: bigint, d: bigint, dp: number): string {
  return fromScaled(roundDiv(n * 10n ** BigInt(dp), d), dp, dp);
}

/**
 * A derived consumption in the person's units (Q7). `perHundred` is `fuelUnit` per 100
 * `distanceUnit` (a meter's unit: `km`, `mi`, or `h` for an hours meter). Only this derived figure
 * is converted; stored entries never are (D76).
 *
 * - metric: litres (a gallon converted) or kWh per 100 km;
 * - imperial: US miles per gallon (litres converted), or miles per kWh;
 * - an hours meter (a generator): fuel per hour in the stored unit, in both systems (inferred);
 * - any other unit: per 100 of it, as stored.
 */
export function displayConsumption(
  perHundred: string,
  fuelUnit: FuelUnit,
  distanceUnit: string,
  units: UnitSystem,
): ConsumptionDisplay {
  const unit = distanceUnit.trim().toLowerCase();
  const per = toScaled(perHundred);
  const ONE = 10n ** BigInt(SCALE);
  if (unit === 'h') return { value: ratio(per, 100n * ONE, 1), unit: `${fuelUnit}/h` };
  if (unit !== 'km' && unit !== 'mi') {
    return { value: ratio(per, ONE, 1), unit: `${fuelUnit}/100 ${distanceUnit.trim()}` };
  }
  // Everything in scaled units: litres (or kWh) per 100 km first.
  const kmPer = unit === 'mi' ? toScaled(KM_PER_MILE) : ONE;
  const galL = toScaled(LITRES_PER_US_GALLON);
  const fuelL = fuelUnit === 'gal' ? galL : ONE;
  const mile = toScaled(KM_PER_MILE);

  if (units === 'metric') {
    // perHundred × fuelL / kmPer, scaled once.
    const value = ratio(per * fuelL, kmPer * ONE, 1);
    return { value, unit: fuelUnit === 'kWh' ? 'kWh/100 km' : 'L/100 km' };
  }
  if (fuelUnit === 'kWh') {
    // Miles per kWh: 100 × kmPer / mile ÷ perHundred.
    return { value: ratio(100n * kmPer * ONE, mile * per, 1), unit: 'mi/kWh' };
  }
  // Miles per US gallon: (100 × kmPer / mile) ÷ (perHundred × fuelL / galL).
  return { value: ratio(100n * kmPer * galL * ONE, mile * per * fuelL, 1), unit: 'mpg' };
}

// ---------------------------------------------------------------------------------------------
// Prices and cost per distance (Q22: per currency, never mixed)
// ---------------------------------------------------------------------------------------------

export type MoneyAmount = { amount: string; currency: string };

/** A fill's price per unit (cost ÷ amount), 4 decimals at most; null without a cost. */
export function pricePerUnit(fill: {
  amount: string;
  cost?: string | null;
  currency?: string | null;
}): MoneyAmount | null {
  if (fill.cost == null || fill.currency == null) return null;
  const amount = toScaled(fill.amount);
  if (amount === 0n) return null;
  return { amount: ratio(toScaled(fill.cost), amount, 4), currency: fill.currency };
}

/**
 * Costs per unit of distance, one figure per currency (never added across currencies, Q22), 4
 * decimals at most. Empty when the distance isn't positive.
 */
export function perDistance(costs: readonly MoneyAmount[], distance: string): MoneyAmount[] {
  const d = toScaled(distance.startsWith('-') ? '0' : distance);
  if (d === 0n) return [];
  const sums = new Map<string, bigint>();
  for (const c of costs) sums.set(c.currency, (sums.get(c.currency) ?? 0n) + toScaled(c.amount));
  return [...sums].map(([currency, sum]) => ({ currency, amount: ratio(sum, d, 4) }));
}
