import { describe, expect, it } from 'vitest';
import {
  costOf,
  estimateCost,
  fromMicro,
  type Price,
  providerReportedCost,
  toMicro,
} from './cost.js';

/** Groq's listing for qwen/qwen3.8-27b on 2026-09-26: USD 0.0000008 / 0.000004 per token. */
const groqQwen: Price = {
  id: 'price-1',
  inputPerMtok: '0.8',
  outputPerMtok: '4',
  reasoningPerMtok: null,
  cachedInputPerMtok: null,
  perImage: null,
  currency: 'USD',
};
const usage = (input: number, output: number, reasoning = 0, cached = 0) => ({
  inputTokens: input,
  outputTokens: output,
  reasoningTokens: reasoning,
  cachedInputTokens: cached,
});

describe('decimal helpers', () => {
  it.each([
    ['0.8', 800_000n],
    ['4', 4_000_000n],
    ['0.0000004', 0n],
    ['0.0000005', 1n],
    ['12.3456789', 12_345_679n],
  ])('toMicro(%s)', (s, micro) => {
    expect(toMicro(s)).toBe(micro);
  });
  it('fromMicro gives the canonical form', () => {
    expect(fromMicro(3_874n)).toBe('0.003874');
    expect(fromMicro(5_000_000n)).toBe('5');
    expect(fromMicro(0n)).toBe('0');
  });
});

describe('costOf (§7.15)', () => {
  it('reproduces the spike’s English receipt on Groq: ≈ USD 0.0039', () => {
    const c = costOf({
      providerCost: null,
      price: groqQwen,
      usage: usage(1917, 585, 257),
      imageCount: 1,
    });
    expect(c).toEqual({
      amount: '0.003874',
      currency: 'USD',
      source: 'price_table',
      priceId: 'price-1',
    });
  });

  it('bills reasoning inside output at the reasoning rate when set', () => {
    const price = { ...groqQwen, reasoningPerMtok: '10' };
    // 328 text × 4 + 257 reasoning × 10 + 1000 in × 0.8 = 0.001312 + 0.00257 + 0.0008
    const c = costOf({ providerCost: null, price, usage: usage(1000, 585, 257), imageCount: 0 });
    expect(c.amount).toBe('0.004682');
  });

  it('prices cached input at the cached rate, else the input rate', () => {
    const withCached = { ...groqQwen, cachedInputPerMtok: '0.4' };
    expect(
      costOf({
        providerCost: null,
        price: withCached,
        usage: usage(1000, 0, 0, 500),
        imageCount: 0,
      }).amount,
    ).toBe('0.0006');
    expect(
      costOf({ providerCost: null, price: groqQwen, usage: usage(1000, 0, 0, 500), imageCount: 0 })
        .amount,
    ).toBe('0.0008');
  });

  it('adds a per-image rate only where the price has one', () => {
    const perImage = { ...groqQwen, perImage: '0.001' };
    expect(
      costOf({ providerCost: null, price: perImage, usage: usage(0, 0), imageCount: 3 }).amount,
    ).toBe('0.003');
  });

  it('a provider-reported cost overrides a price row', () => {
    const c = costOf({
      providerCost: { amount: 0.00123, currency: 'USD' },
      price: groqQwen,
      usage: usage(1917, 585),
      imageCount: 1,
    });
    expect(c).toEqual({ amount: '0.00123', currency: 'USD', source: 'provider', priceId: null });
  });

  it('no price → unknown, never guessed', () => {
    expect(
      costOf({ providerCost: null, price: null, usage: usage(10, 10), imageCount: 0 }),
    ).toEqual({
      amount: null,
      currency: null,
      source: 'unknown',
      priceId: null,
    });
  });
});

describe('estimateCost', () => {
  it('estimated input at the input rate plus the output allowance at the output rate', () => {
    expect(estimateCost(groqQwen, { inputTokens: 2220, outputTokens: 4548 })).toEqual({
      amount: '0.019968',
      currency: 'USD',
    });
    expect(estimateCost(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe('providerReportedCost', () => {
  it('reads OpenRouter’s usage.cost and nothing else', () => {
    expect(providerReportedCost({ openrouter: { usage: { cost: 0.0021 } } })).toEqual({
      amount: 0.0021,
      currency: 'USD',
    });
    expect(providerReportedCost({ openrouter: { usage: {} } })).toBeNull();
    expect(providerReportedCost({ groq: {} })).toBeNull();
    expect(providerReportedCost(undefined)).toBeNull();
  });
});
