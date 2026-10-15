/**
 * The showcase's money (`?demo=…&showcase=1`, src/demo.ts): the docs site's and the README's
 * screenshots show US dollars, while the fixtures keep the Egyptian pounds the tests assert.
 *
 * `inDollars` turns every location to USD and every EGP amount already in the state into dollars.
 * The data the mock seeds later (the vehicles' fills, services and fees, the sync extras) and the
 * figures Insights adds up ask `fixtureMoney`, so they follow.
 *
 * One rate, 25 pounds to the dollar. Not the market's (about 48): at that rate a litre of fuel
 * would cost $0.46 and an oil change $47. At 25 the fixtures read as US prices (fuel about $0.90
 * a litre, an oil change $90, the 55″ TV $1,159.96), and every whole-pound amount becomes exact
 * cents, so the hand-written totals still add up.
 */
import type { MockState } from './fixtures';

export const SHOWCASE_EGP_PER_USD = 25;

const SHOWCASE = new WeakSet<MockState>();

/** Amounts that sit beside `currency` in the fixtures' shapes (prices, values, receipts, costs). */
const MONEY_KEYS = ['amount', 'price', 'unitPrice', 'cost', 'covered', 'total', 'tax'] as const;

const NUMBER = /^-?\d+(\.\d+)?$/;

/** An amount in Egyptian pounds, in dollars: a canonical decimal string, rounded to the cent. */
export function dollars(egp: string): string {
  const cents = Math.round((Number(egp) * 100) / SHOWCASE_EGP_PER_USD);
  return String(cents / 100);
}

/** A fixture amount written in Egyptian pounds: in dollars when the state is the showcase's. */
export function fixtureMoney(state: MockState, egp: string): { amount: string; currency: string } {
  return SHOWCASE.has(state)
    ? { amount: dollars(egp), currency: 'USD' }
    : { amount: egp, currency: 'EGP' };
}

/** One entry per currency, the amounts added up (a fixture's EGP and USD meet in dollars). */
export function perCurrency<T extends { currency: string; amount: string }>(list: T[]): T[] {
  const out = new Map<string, T>();
  for (const m of list) {
    const seen = out.get(m.currency);
    if (!seen) out.set(m.currency, { ...m });
    else seen.amount = String(Math.round((Number(seen.amount) + Number(m.amount)) * 100) / 100);
  }
  return [...out.values()];
}

/** The showcase: every location in US dollars, and every amount the state holds in pounds. */
export function inDollars(state: MockState): void {
  SHOWCASE.add(state);
  convert(state, new WeakSet());
}

function convert(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const v of value.values()) convert(v, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) convert(v, seen);
    return;
  }
  const o = value as Record<string, unknown>;
  if (o.currency === 'EGP') {
    o.currency = 'USD';
    for (const key of MONEY_KEYS) {
      const v = o[key];
      if (typeof v === 'string' && NUMBER.test(v)) o[key] = dollars(v);
    }
    // A receipt's lines are priced in the receipt's currency.
    if (Array.isArray(o.lines))
      for (const line of o.lines as Record<string, unknown>[]) {
        const v = line?.unitPrice;
        if (typeof v === 'string' && NUMBER.test(v)) line.unitPrice = dollars(v);
      }
  }
  for (const v of Object.values(o)) convert(v, seen);
}
