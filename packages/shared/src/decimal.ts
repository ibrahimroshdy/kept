/**
 * Exact non-negative decimal arithmetic on strings, for the pure helpers that need it (money
 * conversion, unit schedules). Values are held as BigInt scaled by 10^SCALE; no floating point.
 * Internal to @kept/shared: not exported from the package index.
 */

/** Decimal places carried internally: rates are numeric(18,8), amounts numeric(16,4). */
export const SCALE = 12;
const TEN = 10n;
const UNIT = TEN ** BigInt(SCALE);
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** `"12.5"` → 12.5 × 10^SCALE. Throws a RangeError on anything that isn't a plain decimal. */
export function toScaled(value: string): bigint {
  const m = DECIMAL.exec(value.trim());
  if (!m || (m[2] ?? '').length > SCALE) throw new RangeError(`Not a decimal: ${value}`);
  return BigInt(m[1] ?? '0') * UNIT + BigInt((m[2] ?? '').padEnd(SCALE, '0'));
}

/** `n / d`, both non-negative, rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** A scaled value as a canonical decimal string with at most `dp` decimals, rounded half away
 * from zero: no trailing fractional zeros, no leading zeros (`"150"`, `"0.5"`). */
export function fromScaled(value: bigint, dp: number, scale: number = SCALE): string {
  const rounded =
    dp >= scale ? value * TEN ** BigInt(dp - scale) : roundDiv(value, TEN ** BigInt(scale - dp));
  const digits = rounded.toString().padStart(dp + 1, '0');
  const int = dp === 0 ? digits : digits.slice(0, -dp);
  const frac = dp === 0 ? '' : digits.slice(-dp).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
