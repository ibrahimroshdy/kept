/**
 * A call's cost, worked out once, at settle (D167, D206; engineering spec §7.15 "Cost"):
 * 1. the provider's reported cost wins (OpenRouter's `providerMetadata.openrouter.usage.cost`,
 *    USD, with `usage: {include: true}` set in providers.ts);
 * 2. else the current price-table version: uncached input × input, cached input × cached
 *    (else input), output **minus reasoning** × output, reasoning × reasoning (else output),
 *    plus images × per-image when set;
 * 3. else unknown: shown as "cost unknown", never guessed (Q8).
 *
 * Money is exact: rates and amounts are decimal strings with at most 6 places (the columns are
 * numeric(16,6)); the arithmetic runs on BigInt millionths and rounds half up once.
 */
import type { CostSource } from '@kept/shared';

export type Price = {
  id: string;
  /** Per million tokens, canonical decimal strings. */
  inputPerMtok: string;
  outputPerMtok: string;
  reasoningPerMtok: string | null;
  cachedInputPerMtok: string | null;
  perImage: string | null;
  currency: string;
};

export type CallUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Inside `outputTokens` (the AI SDK's output total includes reasoning). */
  reasoningTokens: number | null;
  /** Inside `inputTokens`. */
  cachedInputTokens: number | null;
};

export type Cost = {
  amount: string | null;
  currency: string | null;
  source: Extract<CostSource, 'provider' | 'price_table' | 'unknown'>;
  priceId: string | null;
};

const SCALE = 1_000_000n;

/** A decimal string or number → millionths (half up past 6 places). */
export function toMicro(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toFixed(9) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal amount: ${s}`);
  const [, sign, whole, frac = ''] = m;
  const six = frac.padEnd(6, '0').slice(0, 6);
  let micro = BigInt(whole as string) * SCALE + BigInt(six);
  if ((frac[6] ?? '0') >= '5') micro += 1n;
  return sign === '-' ? -micro : micro;
}

/** Millionths → the canonical decimal string (`"0.0039"`, `"5"`). */
export function fromMicro(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** tokens × (rate per million) → millionths, half up. */
function tokensAt(tokens: number, ratePerMtok: string): bigint {
  const product = BigInt(Math.max(0, Math.trunc(tokens))) * toMicro(ratePerMtok);
  return (product + SCALE / 2n) / SCALE;
}

export function costOf(input: {
  providerCost: { amount: number | string; currency: string } | null;
  price: Price | null;
  usage: CallUsage;
  imageCount: number;
}): Cost {
  const { providerCost, price, usage, imageCount } = input;
  if (
    providerCost &&
    (typeof providerCost.amount === 'string' || Number.isFinite(providerCost.amount))
  ) {
    return {
      amount: fromMicro(toMicro(providerCost.amount)),
      currency: providerCost.currency,
      source: 'provider',
      priceId: null,
    };
  }
  if (!price || usage.inputTokens === null || usage.outputTokens === null) {
    return { amount: null, currency: null, source: 'unknown', priceId: null };
  }
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const reasoning = Math.min(usage.reasoningTokens ?? 0, usage.outputTokens);
  const micro =
    tokensAt(usage.inputTokens - cached, price.inputPerMtok) +
    tokensAt(cached, price.cachedInputPerMtok ?? price.inputPerMtok) +
    tokensAt(usage.outputTokens - reasoning, price.outputPerMtok) +
    tokensAt(reasoning, price.reasoningPerMtok ?? price.outputPerMtok) +
    (price.perImage === null ? 0n : BigInt(imageCount) * toMicro(price.perImage));
  return {
    amount: fromMicro(micro),
    currency: price.currency,
    source: 'price_table',
    priceId: price.id,
  };
}

/**
 * The reservation's cost (§7.15 "Reservation"): the estimated input at the input rate plus the
 * output allowance at the output rate. Null without a price: only tokens are reserved.
 */
export function estimateCost(
  price: Price | null,
  estimate: { inputTokens: number; outputTokens: number },
): { amount: string; currency: string } | null {
  if (!price) return null;
  const micro =
    tokensAt(estimate.inputTokens, price.inputPerMtok) +
    tokensAt(estimate.outputTokens, price.outputPerMtok);
  return { amount: fromMicro(micro), currency: price.currency };
}

/** OpenRouter's reported cost (USD), when the answer carries one. */
export function providerReportedCost(
  providerMetadata: unknown,
): { amount: number; currency: 'USD' } | null {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
    ?.openrouter?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? { amount: cost, currency: 'USD' }
    : null;
}
