import { describe, expect, it } from 'vitest';
import {
  AI_TASKS,
  budgetTaskOf,
  COST_SOURCES,
  concurrencyOf,
  DATA_USE_NOTE_KEYS,
  DEFAULT_BUDGETS,
  DEFAULT_MODELS,
  DEFAULT_REASONING,
  detectKind,
  estimateImageTokens,
  estimateTextTokens,
  KIND_CONCURRENCY,
  LEDGER_OUTCOMES,
  LEDGER_TASKS,
  PROVIDER_KINDS,
  REASONING_LEVELS,
  RECOMMENDED,
  RECOMMENDED_PRICE,
  REFERENCE_FIGURES,
  suggestedCap,
} from './ai.js';

describe('provider kinds and key detection', () => {
  it('lists the six kinds (D202 added openrouter and groq)', () => {
    expect(PROVIDER_KINDS).toEqual([
      'openai',
      'anthropic',
      'google',
      'openai_compatible',
      'openrouter',
      'groq',
    ]);
  });

  it.each([
    ['sk-ant-api03-abc', 'anthropic'],
    ['  sk-ant-xyz  ', 'anthropic'],
    ['AIzaSyExample', 'google'],
    ['sk-proj-abc', 'openai'],
    ['sk-abc', 'openai'],
    // D202: OpenRouter's `sk-or-` and Groq's `gsk_` (the prefixes seen on real keys, spike
    // 2026-09-26-step3-ai-sdk.md §6). `sk-or-` is also an `sk-`, so it is checked first.
    [`sk-or-v1-${'0'.repeat(64)}`, 'openrouter'],
    ['sk-or-abc', 'openrouter'],
    [`gsk_${'A1'.repeat(26)}`, 'groq'],
    ['  gsk_abc ', 'groq'],
    ['gsk-abc', null],
    ['GSK_abc', null],
    ['sk-ork-abc', 'openai'],
    ['hb_123', null],
    ['', null],
    ['aiza-lowercase', null],
  ])('%j → %j', (key, kind) => {
    expect(detectKind(key)).toBe(kind);
  });
});

describe('defaults', () => {
  it('has dated default models for every kind and task; compatible servers have none', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(DEFAULT_MODELS[kind].asOf).toBe('2026-09-26');
      expect(Object.keys(DEFAULT_MODELS[kind].models).sort()).toEqual([...AI_TASKS].sort());
    }
    expect(Object.values(DEFAULT_MODELS.openai_compatible.models).every((m) => m === null)).toBe(
      true,
    );
    expect(DEFAULT_MODELS.anthropic.models.embeddings).toBeNull();
    expect(DEFAULT_MODELS.openai.models.extraction).toBeTruthy();
  });

  it('suggests the models the real-provider spike found for groq and openrouter (D202)', () => {
    expect(DEFAULT_MODELS.groq.models).toEqual({
      extraction: 'qwen/qwen3.8-27b',
      assistant: 'openai/gpt-oss-120b',
      embeddings: null,
    });
    expect(DEFAULT_MODELS.openrouter.models).toEqual({
      extraction: 'openai/gpt-6-luna',
      assistant: 'openai/gpt-6-luna',
      embeddings: null,
    });
  });

  it('budgets extraction per Q7', () => {
    expect(DEFAULT_BUDGETS.extraction).toEqual({
      tokensPerMinute: 60_000,
      tokensPerDay: 2_000_000,
      tokensPerMonth: 20_000_000,
      moneyPerMonth: null,
      concurrency: 2,
    });
  });

  it('reasons low by default, with none on offer (Q6)', () => {
    expect(REASONING_LEVELS).toEqual(['none', 'minimal', 'low', 'medium', 'high']);
    expect(DEFAULT_REASONING).toBe('low');
  });

  it('has a data-use note key per kind (D83, L63)', () => {
    expect(Object.keys(DATA_USE_NOTE_KEYS).sort()).toEqual([...PROVIDER_KINDS].sort());
    for (const key of Object.values(DATA_USE_NOTE_KEYS)) expect(key).toMatch(/^ai\.data_use\./);
  });
});

describe('estimateTextTokens (L43: the high estimate)', () => {
  it('is ceil(chars / 2.4)', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a')).toBe(1);
    expect(estimateTextTokens('abcdefghijkl')).toBe(5);
    expect(estimateTextTokens('كابل HDMI')).toBe(Math.ceil(9 / 2.4));
  });
});

describe('estimateImageTokens, against each provider’s documented numbers', () => {
  // platform.claude.com/docs/en/build-with-claude/vision, "Resolution and token cost",
  // high-resolution tier (Claude 4.7 and later), read 2026-09-26.
  it.each([
    [200, 200, 64],
    [1000, 1000, 1296],
    [1092, 1092, 1521],
    [1920, 1080, 2691],
    [2000, 1500, 3888],
    [3840, 2160, 4784],
  ])('anthropic %i×%i → %i', (w, h, tokens) => {
    expect(estimateImageTokens('anthropic', w, h)).toBe(tokens);
  });

  // developers.openai.com/api/docs/guides/images-vision, patch-based examples at detail
  // "high" with a 2,500-patch budget and the 1.2 multiplier, read 2026-09-26.
  it.each([
    [1024, 1024, 1229],
    [2048, 2048, 3000],
    [4096, 512, 2458],
  ])('openai %i×%i → %i', (w, h, tokens) => {
    expect(estimateImageTokens('openai', w, h)).toBe(tokens);
  });

  // ai.google.dev/gemini-api/docs/image-understanding: 258 at ≤384 px; else crop unit
  // floor(min/1.5), tiles per side, 258 each (the 960×540 → 6 tiles example).
  it.each([
    [384, 384, 258],
    [300, 100, 258],
    [960, 540, 6 * 258],
    [2048, 1536, 4 * 258],
  ])('google %i×%i → %i', (w, h, tokens) => {
    expect(estimateImageTokens('google', w, h)).toBe(tokens);
  });

  it('takes the highest of the three for an unknown compatible server', () => {
    for (const [w, h] of [
      [200, 200],
      [2048, 1536],
      [3072, 4096],
    ] as const) {
      const compat = estimateImageTokens('openai_compatible', w, h);
      for (const kind of ['openai', 'anthropic', 'google'] as const) {
        expect(compat).toBeGreaterThanOrEqual(estimateImageTokens(kind, w, h));
      }
    }
  });

  // console.groq.com vision docs: a flat 2048 tokens per image, which the spike's rate-limit
  // headers matched (2026-09-26-step3-ai-sdk.md §4).
  it.each([
    [64, 64],
    [2048, 1536],
    [3072, 4096],
  ])('groq %i×%i → 2048', (w, h) => {
    expect(estimateImageTokens('groq', w, h)).toBe(2048);
  });

  it('takes the highest documented figure for openrouter, which routes to any model', () => {
    for (const [w, h] of [
      [64, 64],
      [2048, 1536],
      [3072, 4096],
    ] as const) {
      const routed = estimateImageTokens('openrouter', w, h);
      for (const kind of ['openai', 'anthropic', 'google', 'groq'] as const) {
        expect(routed).toBeGreaterThanOrEqual(estimateImageTokens(kind, w, h));
      }
    }
  });

  it('refuses sizes that are not positive integers', () => {
    expect(() => estimateImageTokens('openai', 0, 10)).toThrow(RangeError);
    expect(() => estimateImageTokens('openai', 10.5, 10)).toThrow(RangeError);
  });
});

describe('D206 additions', () => {
  it('marks the defaults no Kept call has exercised as untested', () => {
    expect(DEFAULT_MODELS.groq.untested).toEqual(['assistant']);
    expect(DEFAULT_MODELS.openrouter.untested).toEqual(['extraction', 'assistant']);
    for (const kind of ['openai', 'anthropic', 'google'] as const) {
      const set = Object.entries(DEFAULT_MODELS[kind].models)
        .filter(([, m]) => m !== null)
        .map(([t]) => t);
      expect(DEFAULT_MODELS[kind].untested).toEqual(set);
    }
    expect(DEFAULT_MODELS.openai_compatible.untested).toEqual([]);
  });

  it('recommends Groq qwen/qwen3.8-27b, which is also its extraction default', () => {
    expect(RECOMMENDED).toEqual({ kind: 'groq', model: 'qwen/qwen3.8-27b', asOf: '2026-09-26' });
    expect(DEFAULT_MODELS.groq.models.extraction).toBe(RECOMMENDED.model);
  });

  it('carries the spike’s measured reference figures, dated and labelled synthetic', () => {
    expect(REFERENCE_FIGURES.asOf).toBe('2026-09-26');
    expect(REFERENCE_FIGURES.basis).toBe('synthetic images');
    expect(REFERENCE_FIGURES.currency).toBe('USD');
    expect(REFERENCE_FIGURES.tasks.extract_receipt).toEqual({
      inputTokens: 1917,
      outputTokens: 585,
      reasoningTokens: 257,
      cost: '0.0039',
    });
    expect(Object.keys(REFERENCE_FIGURES.tasks).sort()).toEqual([
      'connection_test',
      'extract_label',
      'extract_reading',
      'extract_receipt',
      'extract_thing',
    ]);
  });

  it('prices the recommended model as Groq listed it, the price the reference figures were costed at', () => {
    expect(RECOMMENDED_PRICE).toMatchObject({ kind: RECOMMENDED.kind, model: RECOMMENDED.model });
    expect(RECOMMENDED_PRICE.listingFetchedAt.slice(0, 10)).toBe(REFERENCE_FIGURES.asOf);
    // Each figure is input × the input rate + output × the output rate, to 4 places.
    for (const f of Object.values(REFERENCE_FIGURES.tasks)) {
      const usd =
        (f.inputTokens * Number(RECOMMENDED_PRICE.inputPerMtok) +
          f.outputTokens * Number(RECOMMENDED_PRICE.outputPerMtok)) /
        1_000_000;
      expect(usd.toFixed(4)).toBe(f.cost);
    }
  });

  it('lists the ledger tasks, outcomes and cost sources of §7.15', () => {
    expect(LEDGER_TASKS).toEqual([
      'extract_thing',
      'extract_receipt',
      'extract_label',
      'extract_reading',
      'assistant_turn',
      'assistant_followup',
      'embed_thing',
      'embed_query',
      'connection_test',
      'enrich_aliases',
    ]);
    expect(LEDGER_OUTCOMES).toEqual([
      'ok',
      'refused',
      'rate_limited',
      'over_budget',
      'provider_error',
      'timeout',
      'schema_invalid',
      'truncated',
    ]);
    expect(COST_SOURCES).toEqual([
      'provider',
      'price_table',
      'price_table_later',
      'unknown',
      'not_sent',
    ]);
  });

  it.each([
    ['extract_thing', 'extraction'],
    ['extract_reading', 'extraction'],
    ['enrich_aliases', 'extraction'],
    ['assistant_turn', 'assistant'],
    ['assistant_followup', 'assistant'],
    ['embed_query', 'embeddings'],
    ['connection_test', 'test'],
  ] as const)('budgetTaskOf(%s) = %s (the generated column)', (task, budget) => {
    expect(budgetTaskOf(task)).toBe(budget);
  });

  it('allows one call at a time per Groq key, two otherwise', () => {
    expect(concurrencyOf('groq')).toBe(1);
    for (const k of PROVIDER_KINDS.filter((k) => k !== 'groq')) expect(concurrencyOf(k)).toBe(2);
    expect(KIND_CONCURRENCY).toEqual({ groq: 1 });
  });

  it.each([
    [{ projectedMonth: '0.40', currency: 'USD' }, { monthlyCap: { amount: '5', currency: 'USD' } }],
    [{ projectedMonth: '2.01', currency: 'USD' }, { monthlyCap: { amount: '7', currency: 'USD' } }],
    [{ projectedMonth: '10', currency: 'EGP' }, { monthlyCap: { amount: '30', currency: 'EGP' } }],
    [{ projectedMonth: null, currency: 'USD' }, { monthlyCap: { amount: '5', currency: 'USD' } }],
    [{ projectedMonth: '3', currency: null }, { tokensPerMonth: 3_000_000 }],
  ] as const)('suggestedCap(%j) per §3.5', (input, expected) => {
    expect(suggestedCap(input)).toEqual(expected);
  });
});
