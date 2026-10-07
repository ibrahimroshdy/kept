/**
 * Money on the wire and on screen (D136, D143, D172; engineering spec §7.13).
 *
 * - Amounts travel as canonical decimal strings (`"1234.5"`) next to an ISO 4217 `currency`, and
 *   are stored as `numeric(16,4)`: at most 12 integer digits and 4 decimals, never negative on
 *   input, never exponent notation.
 * - Input is stored as received, and totals are computed at full precision. Rounding to the
 *   currency's minor units happens only at the output edges: display, export and reports (Q2).
 *   It rounds half away from zero.
 * - Display goes through `Intl.NumberFormat`. EGP is "EGP" in every non-Arabic locale and
 *   "ج.م." in Arabic, never a bare "£" (D136). Arabic results are isolated left-to-right
 *   (U+2066 … U+2069) so an amount keeps its shape inside Arabic text.
 */

import { minorUnits } from './currencies.js';
import { fromScaled, roundDiv, SCALE, toScaled } from './decimal.js';

/** Thrown by `parseAmount` (and `roundForDisplay` on a malformed string). Maps to a 400. */
export class AmountError extends Error {
  readonly code = 'invalid_amount' as const;
  constructor(readonly input: string) {
    super(`Not an amount: ${JSON.stringify(input)}`);
    this.name = 'AmountError';
  }
}

export type Digits = 'western' | 'eastern';
export type MoneyFormatOptions = { locale?: string; digits?: Digits };

/** The largest integer part `numeric(16,4)` can hold. */
const MAX_INT_DIGITS = 12;
const MAX_DECIMALS = 4;

const LOCAL_DIGIT = /[٠-٩۰-۹]/g;
const GROUPED = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/;
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;
const BIDI_MARKS = /[‎‏؜]/g;
const LAST_LETTER = /\p{L}(?=\P{L}*$)/u;
const ARABIC_LETTER = /\p{Script=Arabic}/u;

function westernDigit(d: string): string {
  const c = d.charCodeAt(0);
  return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
}

/**
 * Parse what a person typed into a canonical amount string. Accepts Western, Eastern Arabic
 * (٠–٩) and Persian (۰–۹) digits, `.` or `٫` as the decimal separator, and `,` or `٬` grouping in
 * threes (D172). Leading zeros and trailing fractional zeros are dropped: `"١٬٢٠٠٫٥٠"` → `"1200.5"`.
 * Throws `AmountError` (`invalid_amount`) for anything else, including negatives, exponents,
 * more than 4 significant decimals or more than 12 integer digits.
 */
export function parseAmount(input: string): string {
  const s = input.trim().replace(LOCAL_DIGIT, westernDigit).replace(/٫/g, '.').replace(/٬/g, ',');
  const m = GROUPED.exec(s);
  if (!m) throw new AmountError(input);
  const intRaw = (m[1] ?? '').replaceAll(',', '');
  const fracRaw = m[2] ?? '';
  if (intRaw === '' && fracRaw === '') throw new AmountError(input);
  const int = intRaw.replace(/^0+(?=\d)/, '') || '0';
  const frac = fracRaw.replace(/0+$/, '');
  if (int.length > MAX_INT_DIGITS || frac.length > MAX_DECIMALS) throw new AmountError(input);
  return frac ? `${int}.${frac}` : int;
}

/**
 * An amount as it leaves the server: the `parseAmount` form of a stored value, so the wire has
 * one shape whatever the column pads it to (`numeric(16,4)` answers `"150.0000"` → `"150"`).
 * Null for null. A value that isn't an amount (never expected) is returned unchanged rather
 * than failing a read.
 */
export function canonicalAmount(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  try {
    return parseAmount(stored);
  } catch (err) {
    if (err instanceof AmountError) return stored;
    throw err;
  }
}

/**
 * `canonicalAmount` through the shapes money takes in custom fields and audit diffs: a bare
 * amount string, an `{amount, currency}` value, or a list of either. Anything else is returned
 * unchanged.
 */
export function canonicalMoney(value: unknown): unknown {
  if (typeof value === 'string') return canonicalAmount(value);
  if (Array.isArray(value)) return value.map(canonicalMoney);
  if (value !== null && typeof value === 'object' && 'amount' in value && 'currency' in value) {
    const money = value as { amount: unknown };
    return typeof money.amount === 'string'
      ? { ...value, amount: canonicalAmount(money.amount) }
      : value;
  }
  return value;
}

/**
 * Round a decimal string to `units` decimals, half away from zero, with exactly `units` digits
 * after the point (`"1.005", 2` → `"1.01"`; `"2.5", 0` → `"3"`). Exact: no floating point.
 * Used at the output edges only (Q2).
 */
export function roundForDisplay(amount: string, units: number): string {
  const m = DECIMAL.exec(amount.trim());
  if (!m) throw new AmountError(amount);
  const negative = m[1] === '-';
  const int = m[2] ?? '0';
  const frac = m[3] ?? '';
  const kept = frac.slice(0, units).padEnd(units, '0');
  let scaled = BigInt(int + kept);
  if ((frac.charCodeAt(units) || 48) >= 53) scaled += 1n; // next digit ≥ '5'
  const digits = scaled.toString().padStart(units + 1, '0');
  const whole = units === 0 ? digits : `${digits.slice(0, -units)}.${digits.slice(-units)}`;
  return negative && scaled !== 0n ? `-${whole}` : whole;
}

function isArabicLocale(locale: string): boolean {
  return /^ar(?:-|$)/i.test(locale);
}

function numberingSystem(locale: string, digits: Digits): string {
  return isArabicLocale(locale) && digits === 'eastern' ? 'arab' : 'latn';
}

/**
 * ICU marks an Arabic amount for right-to-left display with RLM/ALM. Kept shows amounts
 * left-to-right (D136), so drop the marks and isolate the whole. One RLM is put back after a
 * trailing Arabic symbol, so the full stop of "ج.م." stays with its letters.
 */
function isolateLtr(formatted: string): string {
  let s = formatted.replace(BIDI_MARKS, '');
  const last = LAST_LETTER.exec(s)?.[0];
  if (last && ARABIC_LETTER.test(last)) s += '‏';
  return `⁦${s}⁩`;
}

/**
 * Format an amount in `currency` for display. Rounds to the currency's minor units first (half
 * away from zero). `digits` applies to Arabic locales only (D143); English always uses 0–9.
 */
export function formatMoney(
  amount: string,
  currency: string,
  { locale = 'en', digits = 'western' }: MoneyFormatOptions = {},
): string {
  const units = minorUnits(currency);
  const arabic = isArabicLocale(locale);
  const nf = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: currency === 'EGP' && !arabic ? 'code' : 'symbol',
    numberingSystem: numberingSystem(locale, digits),
    minimumFractionDigits: units,
    maximumFractionDigits: units,
  });
  const out = nf.format(roundForDisplay(amount, units) as Intl.StringNumericLiteral);
  return arabic ? isolateLtr(out) : out;
}

/**
 * The number alone, grouped and in the reader's digits, for amount inputs. Not rounded (up to 4
 * decimals, as stored) and not isolated; `parseAmount` reads it back unchanged.
 */
export function formatAmount(
  amount: string,
  { locale = 'en', digits = 'western' }: MoneyFormatOptions = {},
): string {
  const nf = new Intl.NumberFormat(locale, {
    numberingSystem: numberingSystem(locale, digits),
    minimumFractionDigits: 0,
    maximumFractionDigits: MAX_DECIMALS,
  });
  return nf.format(amount as Intl.StringNumericLiteral).replace(BIDI_MARKS, '');
}

/** An exchange rate as `fx_rates` holds it (D136): 1 `fromCcy` = `rate` `toCcy` from `validFrom`. */
export type FxRate = { fromCcy: string; toCcy: string; rate: string; validFrom: string };

export type Converted = { amount: string } | { missing: { from: string; to: string } };

/** Decimals a converted amount keeps: the stored money scale, numeric(16,4). */
const CONVERTED_DECIMALS = 4;

function newestOn(rates: readonly FxRate[], from: string, to: string, on: string): FxRate | null {
  let best: FxRate | null = null;
  for (const r of rates) {
    if (r.fromCcy === from && r.toCcy === to && r.validFrom <= on) {
      if (best === null || r.validFrom > best.validFrom) best = r;
    }
  }
  return best;
}

/**
 * Convert `amount` from one currency to another as of the day `on` (D76, D136; step-4 plan Q21).
 *
 * - The same currency returns the amount unchanged (canonical).
 * - Otherwise the newest rate for the pair with `validFrom ≤ on` is used; only when the pair has
 *   none is the newest inverse pair's `1/rate` used.
 * - Never chained through a third currency, and never estimated: with no rate either way the
 *   answer is `{missing: {from, to}}`.
 *
 * Exact decimal arithmetic, rounded once, half away from zero, to 4 decimals; the result is a
 * canonical amount (§7.7). Rounding to the currency's minor units is left to display (Q2).
 * T4's SQL for the AI caps follows the same order: the pair first, then its inverse.
 */
export function convert(
  amount: string,
  from: string,
  to: string,
  on: string,
  rates: readonly FxRate[],
): Converted {
  const a = toScaled(amount);
  if (from === to) return { amount: fromScaled(a, CONVERTED_DECIMALS) };
  const direct = newestOn(rates, from, to, on);
  if (direct) {
    // a × r, both scaled by 10^SCALE: the product is scaled by 10^(2·SCALE).
    return { amount: fromScaled(a * toScaled(direct.rate), CONVERTED_DECIMALS, 2 * SCALE) };
  }
  const inverse = newestOn(rates, to, from, on);
  if (inverse) {
    const r = toScaled(inverse.rate);
    const unit = 10n ** BigInt(CONVERTED_DECIMALS);
    return { amount: fromScaled(roundDiv(a * unit, r), CONVERTED_DECIMALS, CONVERTED_DECIMALS) };
  }
  return { missing: { from, to } };
}
