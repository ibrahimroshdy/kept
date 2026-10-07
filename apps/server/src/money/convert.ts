import { type Converted, convert, type FxRate } from '@kept/shared';
import type pg from 'pg';
import { rateOut } from './fx.js';

// The server's conversions (step-4 plan T8; D76, D136, Q21): @kept/shared `convert()` over an
// account's own rates, read once per request. The pair's newest rate valid on the day, else the
// inverse pair's; never chained through a third currency and never estimated, so a pair with no
// rate is `{missing: {from, to}}`, which T18's report answers with 409 `rate_missing` listing the
// pairs. The AI money caps convert in SQL instead (kept.fx_rate(), 0049), in the same order.

/** Converts amounts as of a day through one account's rates. */
export type Converter = {
  convert: (amount: string, from: string, to: string, on: string) => Converted;
  /** The rates it reads, as stored (for a report's footnote). */
  rates: readonly FxRate[];
};

/**
 * The account's rates, read once as the caller (0049: anyone who sees one of its locations), and
 * a converter over them. `accountId` is the owner account of the rows being converted.
 */
export async function converterFor(client: pg.ClientBase, accountId: string): Promise<Converter> {
  const { rows } = await client.query<{
    from_ccy: string;
    to_ccy: string;
    rate: string;
    valid_from: string;
  }>(
    `SELECT from_ccy::text AS from_ccy, to_ccy::text AS to_ccy, rate::text AS rate,
            valid_from::text AS valid_from
       FROM public.fx_rates WHERE owner_account_id = $1`,
    [accountId],
  );
  const rates: FxRate[] = rows.map((r) => ({
    fromCcy: r.from_ccy,
    toCcy: r.to_ccy,
    rate: rateOut(r.rate),
    validFrom: r.valid_from,
  }));
  return {
    rates,
    convert: (amount, from, to, on) => convert(amount, from, to, on, rates),
  };
}

/** Totals per currency, converted into `to` when every one has a rate on `on`: the pairs that
 * have none otherwise (Q21: totals per currency always, a converted total only when complete). */
export function convertTotals(
  converter: Converter,
  totals: ReadonlyMap<string, string>,
  to: string,
  on: string,
): { amount: string } | { missing: { from: string; to: string }[] } {
  const missing: { from: string; to: string }[] = [];
  const parts: string[] = [];
  for (const [currency, amount] of totals) {
    const out = converter.convert(amount, currency, to, on);
    if ('missing' in out) missing.push(out.missing);
    else parts.push(out.amount);
  }
  if (missing.length > 0) return { missing };
  return { amount: sumDecimals(parts) };
}

/** Exact sum of canonical decimal strings (4 decimals at most, as converted amounts are). */
function sumDecimals(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) {
    const [int = '0', frac = ''] = v.split('.');
    total += BigInt(int + frac.padEnd(4, '0').slice(0, 4));
  }
  const s = total.toString().padStart(5, '0');
  const int = s.slice(0, -4).replace(/^0+(?=\d)/, '');
  const frac = s.slice(-4).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
