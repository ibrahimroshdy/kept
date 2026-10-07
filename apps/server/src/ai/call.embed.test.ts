// The embedding door (step-6 plan T8 step 6; spike S6.4): one request, one ledger row, retries
// off, and neither the values nor the vectors in the ledger or the logs (D206).
import { APICallError } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { kit, resolved } from '../../test/ai-kit.js';
import { type EmbedRequest, embedValues } from './call.js';
import type { Price } from './cost.js';
import { capRow } from './memory.js';
import { createMockEmbeddingModel, mockVector } from './mock.js';

const MARK = 'EMBEDMARKER4417';

function counting(opts: { tokens?: number; fail?: Error; max?: number } = {}) {
  let requests = 0;
  const seen: { values: string[]; providerOptions?: unknown }[] = [];
  const model = new MockEmbeddingModelV4({
    modelId: 'text-embedding-3-small',
    maxEmbeddingsPerCall: opts.max ?? 2048,
    supportsParallelCalls: true,
    doEmbed: async (o) => {
      requests++;
      seen.push({ values: o.values, providerOptions: o.providerOptions });
      if (opts.fail) throw opts.fail;
      return {
        embeddings: o.values.map((v) => mockVector(v, 4)),
        ...(opts.tokens === undefined ? {} : { usage: { tokens: opts.tokens } }),
        warnings: [],
      };
    },
  });
  return { model, seen, requests: () => requests };
}

function req(over: Partial<EmbedRequest> = {}): EmbedRequest {
  return {
    resolved: resolved('openai', { model: 'text-embedding-3-small' }),
    task: 'embed_thing',
    locationId: 'loc-1',
    userId: 'user-1',
    links: {},
    values: [`HDMI cable ${MARK}`, 'Drill', 'Ladder'],
    requestId: 'job-9',
    attempt: 1,
    jobId: 'job-9',
    ...over,
  };
}

describe('embedValues', () => {
  it('three values: one request, one row, tokens from usage, no value or vector in the ledger', async () => {
    const m = counting({ tokens: 12 });
    const { rt, ledger, logs } = kit({ runtime: { embeddingModelFactory: () => m.model } });
    const r = await embedValues(rt, req({ dimensions: 768 }));
    expect(m.requests()).toBe(1);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.vectors).toHaveLength(3);
    expect(r.usage.tokens).toBe(12);
    expect(m.seen[0]?.providerOptions).toEqual({ openai: { dimensions: 768 } });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      sent: true,
      outcome: 'ok',
      task: 'embed_thing',
      inputTokens: 12,
      outputTokens: 0,
      imageCount: 0,
      thingId: null,
      costSource: 'unknown',
    });
    const dump = JSON.stringify({ rows: ledger.rows, logs });
    expect(dump).not.toContain(MARK);
    expect(dump).not.toContain(String(r.vectors[0]?.[0]));
  });

  it('a single thing names it; the cost comes from the price table', async () => {
    const m = counting({ tokens: 1_000_000 });
    const price: Price = {
      id: 'price-e',
      inputPerMtok: '0.02',
      outputPerMtok: '0',
      reasoningPerMtok: null,
      cachedInputPerMtok: null,
      perImage: null,
      currency: 'USD',
    };
    const { rt, ledger } = kit({
      runtime: { embeddingModelFactory: () => m.model, prices: async () => price },
    });
    await embedValues(rt, req({ values: ['Drill'], links: { thingId: 'thing-1' } }));
    expect(ledger.rows[0]).toMatchObject({
      thingId: 'thing-1',
      costAmount: '0.02',
      costCurrency: 'USD',
      costSource: 'price_table',
      priceId: 'price-e',
    });
  });

  it('a provider that reports no tokens: the row carries the estimate, flagged, and so do the budgets', async () => {
    const m = counting();
    const { rt, ledger, gate } = kit({ runtime: { embeddingModelFactory: () => m.model } });
    const r = await embedValues(
      rt,
      req({ resolved: resolved('google', { model: 'gemini-embedding-001' }) }),
    );
    expect(r).toMatchObject({ status: 'ok', usage: { tokens: null } });
    expect(ledger.rows[0]?.estimateTokens).toBeGreaterThan(0);
    expect(ledger.rows[0]).toMatchObject({
      inputTokens: ledger.rows[0]?.estimateTokens,
      usageEstimated: true,
    });
    expect(gate.reservations.size).toBe(0);
  });

  it('retries are off, and a thrown error settles and releases its lease', async () => {
    const m = counting({
      fail: new APICallError({
        message: 'mock 503',
        url: 'https://mock.invalid/v1/embeddings',
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: {},
        responseBody: '',
        isRetryable: true,
      }),
    });
    const { rt, ledger, gate, pacer } = kit({ runtime: { embeddingModelFactory: () => m.model } });
    const r = await embedValues(rt, req());
    expect(m.requests()).toBe(1);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    expect(ledger.rows).toHaveLength(1);
    expect(gate.reservations.size).toBe(0);
    expect([...pacer.slots.values()].flat().every((s) => s === null)).toBe(true);
  });

  it('a cap: paused, one over_budget row, nothing sent', async () => {
    const m = counting({ tokens: 3 });
    const { rt, ledger } = kit({
      caps: [
        capRow({
          scope: 'location',
          ownerAccountId: 'acct-1',
          locationId: 'loc-1',
          tokensPerMonth: 1,
        }),
      ],
      runtime: { embeddingModelFactory: () => m.model },
    });
    const r = await embedValues(rt, req());
    expect(r).toMatchObject({ status: 'paused', kind: 'cap' });
    expect(m.requests()).toBe(0);
    expect(ledger.rows).toEqual([expect.objectContaining({ sent: false, outcome: 'over_budget' })]);
  });

  it('more values than one request carries is a programming error, before anything is reserved', async () => {
    const m = counting({ max: 2 });
    const { rt, ledger } = kit({ runtime: { embeddingModelFactory: () => m.model } });
    await expect(embedValues(rt, req())).rejects.toThrow(/1–2 values/);
    await expect(embedValues(rt, req({ values: [] }))).rejects.toThrow();
    expect(ledger.rows).toHaveLength(0);
    expect(m.requests()).toBe(0);
  });

  it('the mock model (KEPT_AI_MOCK) embeds equal texts equally', async () => {
    const { rt } = kit({ runtime: { mock: {} } });
    const r = await embedValues(rt, req({ values: ['Drill', 'Drill', 'Ladder'] }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.vectors[0]).toEqual(r.vectors[1]);
    expect(r.vectors[0]).not.toEqual(r.vectors[2]);
    expect(createMockEmbeddingModel().modelId).toBe('kept-mock-embed');
  });
});
