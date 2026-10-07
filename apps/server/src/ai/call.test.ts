import { EXTRACTION_SCHEMAS, parseLenient } from '@kept/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { jpeg, kit, resolved, T0 } from '../../test/ai-kit.js';
import { type CallRequest, callModel, capErrorCode } from './call.js';
import type { Price } from './cost.js';
import { capRow } from './memory.js';
import { createMockModel, type MockAnswer, mockKey } from './mock.js';
import { wireName, wireSchema } from './wire.js';

function readingRequest(
  image: Awaited<ReturnType<typeof jpeg>>,
  over: Partial<CallRequest<unknown>> = {},
) {
  const schema = EXTRACTION_SCHEMAS.reading;
  return {
    resolved: resolved('groq'),
    task: 'extract_reading',
    locationId: 'loc-1',
    userId: 'user-1',
    links: { extractionId: 'ext-1', thingId: 'thing-1' },
    instructions: 'Read the meter.',
    text: 'Read this meter.',
    images: [{ ...image, attachmentId: 'att-1' }],
    output: {
      name: wireName('reading'),
      schema: wireSchema('reading'),
      parse: (raw: unknown) => parseLenient(schema, raw),
    },
    maxOutputTokens: 2248,
    expectedOutputTokens: 200,
    promptVersion: 'reading-1',
    requestId: 'job-1',
    attempt: 1,
    jobId: 'job-1',
    ...over,
  } as CallRequest<unknown>;
}

async function withAnswer(answer: MockAnswer, colour = '#336699') {
  const img = await jpeg(colour);
  return { img, answers: { [mockKey(img.bytes)]: answer } };
}

describe('callModel: outcomes (D206 table)', () => {
  it('ok: a usable object, one sent ledger row with the tokens the model reported', async () => {
    const { img, answers } = await withAnswer({
      output: {
        value: { value: 52340, confidence: 0.98 },
        unit: { value: 'kms', confidence: 0.5 },
      },
      usage: { input: 877, output: 37, reasoning: 157 },
    });
    const { rt, ledger } = kit({ runtime: { mock: answers } });
    const r = await callModel(rt, readingRequest(img));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // parseLenient dropped the bad optional `unit` and kept the rest (L52).
    expect(r.value).toEqual({
      value: { value: { value: 52340, confidence: 0.98 } },
      dropped: ['unit'],
    });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      id: r.callId,
      sent: true,
      outcome: 'ok',
      task: 'extract_reading',
      inputTokens: 877,
      outputTokens: 194,
      reasoningTokens: 157,
      imageCount: 1,
      imageTokensEach: 2048,
      imageBytes: img.bytes.byteLength,
      attachmentIds: ['att-1'],
      locationId: 'loc-1',
      userId: 'user-1',
      payingScope: 'account',
      payingAccountId: 'acct-1',
      promptVersion: 'reading-1',
      extractionId: 'ext-1',
      thingId: 'thing-1',
      costSource: 'unknown',
      finishReason: 'stop',
    });
  });

  it.each<[string, MockAnswer, { outcome: string; errorCode: string; retryable: boolean }]>([
    [
      'length, truncated JSON',
      { text: '{"value": {"val', finishReason: 'length' },
      { outcome: 'truncated', errorCode: 'length', retryable: false },
    ],
    [
      'length, complete JSON (resolves)',
      { output: { value: { value: 1, confidence: 1 } }, finishReason: 'length' },
      { outcome: 'truncated', errorCode: 'length', retryable: false },
    ],
    [
      'content filter',
      { output: { value: { value: 1, confidence: 1 } }, finishReason: 'content-filter' },
      { outcome: 'refused', errorCode: 'content_filter', retryable: false },
    ],
    [
      'invalid JSON',
      { text: 'User Safety: safe' },
      { outcome: 'schema_invalid', errorCode: 'invalid_json', retryable: false },
    ],
    [
      'a required field fails',
      { output: { value: { value: -3, confidence: 2 } } },
      { outcome: 'schema_invalid', errorCode: 'schema', retryable: false },
    ],
    [
      '5xx',
      { error: { status: 502 } },
      { outcome: 'provider_error', errorCode: 'http_5xx', retryable: true },
    ],
    [
      'an error inside a 200',
      { error: { status: 200, body: '{"error":{"message":"grammar"}}' } },
      { outcome: 'provider_error', errorCode: 'error_in_200', retryable: true },
    ],
    [
      'a 400',
      { error: { status: 400, body: 'bad schema' } },
      { outcome: 'provider_error', errorCode: 'http_4xx', retryable: false },
    ],
  ])('%s', async (_name, answer, want) => {
    const { img, answers } = await withAnswer(answer);
    const { rt, ledger } = kit({ runtime: { mock: answers } });
    const r = await callModel(rt, readingRequest(img));
    expect(r).toMatchObject({ status: 'failed', ...want });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      sent: true,
      outcome: want.outcome,
      errorCode: want.errorCode,
    });
  });

  it('timeout: the abort signal fires, outcome timeout, retryable', async () => {
    const { img, answers } = await withAnswer({ delayMs: 500 });
    const { rt, ledger } = kit({ runtime: { mock: answers, callTimeoutMs: 20 } });
    const r = await callModel(rt, readingRequest(img));
    expect(r).toMatchObject({
      status: 'failed',
      outcome: 'timeout',
      errorCode: 'timeout',
      retryable: true,
    });
    expect(ledger.rows[0]).toMatchObject({ sent: true, outcome: 'timeout' });
  });

  it('a network failure is provider_error network, retryable', async () => {
    const img = await jpeg('#111111');
    const { rt, ledger } = kit({
      runtime: {
        mock: null,
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      },
    });
    const r = await callModel(rt, readingRequest(img));
    expect(r).toMatchObject({
      status: 'failed',
      outcome: 'provider_error',
      errorCode: 'network',
      retryable: true,
    });
    expect(ledger.rows[0]?.sent).toBe(true);
  });
});

describe('callModel: the breaker and the pacer', () => {
  it('learns an output-token limit from its 429 and holds the call that would pass it, unsent', async () => {
    const otpm =
      '{"error":{"message":"Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 997, Requested 192. Please try again in 11.34s.","type":"tokens","code":"rate_limit_exceeded"}}';
    const first = await withAnswer({
      error: { status: 429, headers: { 'retry-after': '12' }, body: otpm },
    });
    const big = await withAnswer({ usage: { output: 900 } }, '#00ff00');
    const next = await jpeg('#ff00ff');
    let calls = 0;
    const { rt, clock } = kit({
      runtime: {
        modelFactory: () => {
          calls++;
          return createMockModel({ ...first.answers, ...big.answers });
        },
      },
    });
    expect(await callModel(rt, readingRequest(first.img))).toMatchObject({
      status: 'paused',
      reason: 'rate_limited',
    });
    // Past the retry: the window the 429 named has ended, so the next call goes.
    clock.advance(13_000);
    expect((await callModel(rt, readingRequest(big.img))).status).toBe('ok');
    // 900 output tokens this minute: another 200 would pass 1,000, so it waits, unsent.
    clock.advance(1000);
    const held = await callModel(rt, readingRequest(next));
    expect(held).toMatchObject({ status: 'paused', kind: 'provider', reason: 'limits' });
    expect(calls).toBe(2);
    clock.advance(60_000);
    expect((await callModel(rt, readingRequest(next))).status).toBe('ok');
  });

  it('an OTPM "Request too large" refusal holds the key a full minute, not an immediate retry', async () => {
    // Recorded 2026-09-29 (T11's log, cut at 200 characters; organisation id removed). No
    // retry-after came with it.
    const refusal =
      '{"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1308. The request\'s e","type":"tokens","code":"rate_limit_exceeded"}}';
    const first = await withAnswer({ error: { status: 429, body: refusal } });
    const small = await withAnswer({ usage: { output: 100 } }, '#00ff00');
    let calls = 0;
    const { rt, clock, pacer } = kit({
      runtime: {
        modelFactory: () => {
          calls++;
          return createMockModel({ ...first.answers, ...small.answers });
        },
      },
    });
    expect(await callModel(rt, readingRequest(first.img))).toMatchObject({
      status: 'paused',
      reason: 'rate_limited',
    });
    expect(pacer.output.get('prov-groq')).toMatchObject({ limit: 1000, used: 1000 });
    clock.advance(30_000);
    expect((await callModel(rt, readingRequest(small.img))).status).toBe('paused');
    expect(calls).toBe(1);
    clock.advance(31_000);
    expect((await callModel(rt, readingRequest(small.img))).status).toBe('ok');
    expect(calls).toBe(2);
  });

  it('a 429 trips until retry-after; the next call is held without a request', async () => {
    const { img, answers } = await withAnswer({
      error: { status: 429, headers: { 'retry-after': '7' } },
    });
    const other = await jpeg('#00ff00');
    let calls = 0;
    const { rt, ledger, clock } = kit({
      runtime: {
        modelFactory: () => {
          calls++;
          return createMockModel(answers);
        },
      },
    });
    const first = await callModel(rt, readingRequest(img));
    expect(first).toMatchObject({
      status: 'paused',
      kind: 'provider',
      reason: 'rate_limited',
      until: new Date(T0.getTime() + 7000),
    });
    expect(ledger.rows[0]).toMatchObject({
      sent: true,
      outcome: 'rate_limited',
      errorCode: 'http_429',
      httpStatus: 429,
    });

    clock.advance(1000);
    const second = await callModel(rt, readingRequest(other));
    expect(calls).toBe(1);
    expect(second).toMatchObject({ status: 'paused', kind: 'provider', reason: 'rate_limited' });
    expect(ledger.rows[1]).toMatchObject({
      sent: false,
      outcome: 'rate_limited',
      errorCode: 'rate_limited',
      costSource: 'not_sent',
      inputTokens: null,
    });

    clock.advance(7000);
    expect((await callModel(rt, readingRequest(other))).status).toBe('ok');
  });

  it('a quota error and a rejected key pause for the provider', async () => {
    const q = await withAnswer(
      { error: { status: 429, body: '{"error":{"type":"insufficient_quota"}}' } },
      '#aa0000',
    );
    const k1 = kit({ runtime: { mock: q.answers } });
    expect(await callModel(k1.rt, readingRequest(q.img))).toMatchObject({
      status: 'paused',
      reason: 'quota',
    });
    expect(k1.ledger.rows[0]).toMatchObject({ outcome: 'rate_limited', errorCode: 'quota' });

    const a = await withAnswer({ error: { status: 401 } }, '#00aa00');
    const k2 = kit({ runtime: { mock: a.answers } });
    expect(await callModel(k2.rt, readingRequest(a.img))).toMatchObject({
      status: 'paused',
      reason: 'auth',
    });
    expect(k2.ledger.rows[0]).toMatchObject({ outcome: 'provider_error', errorCode: 'auth' });
    const again = await callModel(k2.rt, readingRequest(await jpeg('#0000aa')));
    expect(again).toMatchObject({ status: 'paused', reason: 'auth' });
    expect(k2.ledger.rows[1]).toMatchObject({
      sent: false,
      outcome: 'provider_error',
      errorCode: 'auth',
    });
  });

  it('holds the call when the provider’s remaining tokens are below the estimate', async () => {
    const img = await jpeg('#222222');
    let calls = 0;
    const { rt, ledger, pacer, sleeps } = kit({
      runtime: {
        modelFactory: () => {
          calls++;
          return createMockModel();
        },
      },
    });
    pacer.limits.set('prov-groq', {
      limitTokens: 8000,
      remainingTokens: 500,
      resetAt: new Date(T0.getTime() + 30_000),
    });
    const held = await callModel(rt, readingRequest(img));
    expect(held).toMatchObject({
      status: 'paused',
      kind: 'provider',
      reason: 'limits',
      until: new Date(T0.getTime() + 30_000),
    });
    expect(held.status === 'paused' && held.callId).toBeFalsy();
    expect(ledger.rows).toHaveLength(0); // a wait under 60 s is not a row (§3.5)
    expect(calls).toBe(0);

    pacer.limits.set('prov-groq', {
      limitTokens: 8000,
      remainingTokens: 500,
      resetAt: new Date(T0.getTime() + 90_000),
    });
    await callModel(rt, readingRequest(img));
    expect(ledger.rows[0]).toMatchObject({
      sent: false,
      outcome: 'rate_limited',
      errorCode: 'limits',
    });

    pacer.limits.set('prov-groq', {
      limitTokens: 8000,
      remainingTokens: 500,
      resetAt: new Date(T0.getTime() + 4_000),
    });
    expect((await callModel(rt, readingRequest(img))).status).toBe('ok');
    expect(sleeps).toEqual([4000]);
  });

  it('stores the provider’s headers on the row and for the next call', async () => {
    const { img, answers } = await withAnswer({
      headers: {
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '5195',
        'x-ratelimit-reset-tokens': '21.037s',
      },
    });
    const { rt, ledger, pacer } = kit({ runtime: { mock: answers } });
    await callModel(rt, readingRequest(img));
    expect(ledger.rows[0]).toMatchObject({
      rlRemainingTokens: 5195,
      rlResetAt: new Date(T0.getTime() + 21_037),
    });
    expect(pacer.limits.get('prov-groq')?.remainingTokens).toBe(5195);
  });

  it('two concurrent calls on one Groq key: the second is held (concurrency) and never sent', async () => {
    const { img, answers } = await withAnswer({ delayMs: 50 });
    const { rt, ledger } = kit({ runtime: { mock: answers } });
    const results = await Promise.all(
      [
        () => callModel(rt, readingRequest(img, { jobId: 'j1' })),
        () => callModel(rt, readingRequest(img, { jobId: 'j2' })),
      ].map((f) => f()),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'paused']);
    expect(results.find((r) => r.status === 'paused')).toMatchObject({
      kind: 'provider',
      reason: 'concurrency',
    });
    expect(ledger.rows).toHaveLength(1);
  });

  it('three concurrent calls for one payer: the third is held (concurrency)', async () => {
    const { img, answers } = await withAnswer({ delayMs: 50 });
    const { rt, ledger } = kit({ runtime: { mock: answers } });
    const openai = resolved('openai');
    const results = await Promise.all(
      [1, 2, 3]
        .map((n) => () => callModel(rt, readingRequest(img, { resolved: openai, jobId: `j${n}` })))
        .map((f) => f()),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'ok', 'paused']);
    expect(results.find((r) => r.status === 'paused')).toMatchObject({ reason: 'concurrency' });
    expect(ledger.rows).toHaveLength(2);
  });

  it('releases the key slot and settles the reservation when the provider throws', async () => {
    const { img, answers } = await withAnswer({ error: { status: 500 } });
    const { rt, gate, pacer } = kit({ runtime: { mock: answers } });
    await callModel(rt, readingRequest(img));
    expect(gate.reservations.size).toBe(0);
    expect(pacer.slots.get('prov-groq')).toEqual([null]);
    expect([...gate.leases.values()].flat().every((s) => s === null)).toBe(true);
  });
});

describe('callModel: budgets and caps', () => {
  it('a location at its cap: held with one over_budget row, never sent', async () => {
    const img = await jpeg('#333333');
    let calls = 0;
    const { rt, ledger } = kit({
      caps: [
        capRow({
          scope: 'location',
          ownerAccountId: 'acct-1',
          locationId: 'loc-1',
          tokensPerMonth: 100,
        }),
      ],
      runtime: {
        modelFactory: () => {
          calls++;
          return createMockModel();
        },
      },
    });
    const r = await callModel(rt, readingRequest(img));
    expect(r).toMatchObject({
      status: 'paused',
      kind: 'cap',
      reason: 'cap_tokens',
      bucket: 'location:loc-1',
      until: new Date('2026-10-01T00:00:00Z'),
    });
    expect(calls).toBe(0);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      sent: false,
      outcome: 'over_budget',
      errorCode: 'location_cap_tokens',
      costSource: 'not_sent',
    });
  });

  it('a cap crossing returns crossed and notifies exactly once', async () => {
    const img = await jpeg('#444444');
    const notices: unknown[] = [];
    const cap = capRow({ scope: 'account', ownerAccountId: 'acct-1', tokensPerMonth: 5000 });
    const { answers } = await withAnswer({ usage: { input: 3000, output: 1100 } }, '#444444');
    const { rt } = kit({
      caps: [cap],
      runtime: { mock: answers, onCrossed: async (c) => void notices.push(c) },
    });
    const r = await callModel(rt, readingRequest(img, { maxOutputTokens: 300 }));
    expect(r.status).toBe('ok');
    expect(notices).toEqual([
      { budgetId: cap.id, bucket: 'account:acct-1', level: 80, month: '2026-09-01' },
    ]);
    const r2 = await callModel(rt, readingRequest(img, { maxOutputTokens: 300 }));
    expect(r2).toMatchObject({ status: 'paused', kind: 'cap', reason: 'cap_tokens' });
    expect(notices).toHaveLength(1);
  });

  it('capErrorCode names the bucket kind and the reason', () => {
    expect(capErrorCode('member:acct:user', 'cap_money')).toBe('member_cap_money');
    expect(capErrorCode('instance_account:acct', 'tokens_day')).toBe('instance_account_tokens_day');
    expect(capErrorCode('instance', 'manual')).toBe('instance_manual');
  });
});

describe('callModel: cost', () => {
  const price: Price = {
    id: 'price-7',
    inputPerMtok: '0.8',
    outputPerMtok: '4',
    reasoningPerMtok: null,
    cachedInputPerMtok: null,
    perImage: null,
    currency: 'USD',
  };

  it('a price row → price_table with its id', async () => {
    const { img, answers } = await withAnswer({
      usage: { input: 1917, output: 328, reasoning: 257 },
    });
    const { rt, ledger } = kit({ runtime: { mock: answers, prices: async () => price } });
    await callModel(rt, readingRequest(img));
    expect(ledger.rows[0]).toMatchObject({
      costAmount: '0.003874',
      costCurrency: 'USD',
      costSource: 'price_table',
      priceId: 'price-7',
    });
  });

  it('OpenRouter’s reported cost wins over the price row', async () => {
    const { img, answers } = await withAnswer({
      providerMetadata: { openrouter: { usage: { cost: 0.0021 } } },
    });
    const { rt, ledger } = kit({ runtime: { mock: answers, prices: async () => price } });
    await callModel(rt, readingRequest(img, { resolved: resolved('openrouter') }));
    expect(ledger.rows[0]).toMatchObject({
      costAmount: '0.0021',
      costCurrency: 'USD',
      costSource: 'provider',
      priceId: null,
    });
  });

  it('no price → unknown', async () => {
    const img = await jpeg('#555555');
    const { rt, ledger } = kit();
    await callModel(rt, readingRequest(img));
    expect(ledger.rows[0]).toMatchObject({ costAmount: null, costSource: 'unknown' });
  });
});

describe('callModel: what never leaves the call', () => {
  it('the prompt, the reply and the image never reach the ledger', async () => {
    const PROMPT = 'PROMPT-MARKER-7f3a';
    const REPLY = 'REPLY-MARKER-9c1d';
    const { img, answers } = await withAnswer({
      output: { value: { value: 1, confidence: 1 }, display: 'digital', note: REPLY },
    });
    const { rt, ledger } = kit({ runtime: { mock: answers } });
    await callModel(rt, readingRequest(img, { instructions: PROMPT, text: PROMPT }));
    const json = JSON.stringify(ledger.rows);
    expect(json).not.toContain(PROMPT);
    expect(json).not.toContain(REPLY);
    expect(json).not.toContain(Buffer.from(img.bytes).toString('base64').slice(0, 40));
  });

  it('the key never appears in logs, the ledger or the result, even when the provider echoes it', async () => {
    // Built so that no key-shaped literal is committed (a prefix scan of the repo stays empty).
    const key = `${'gsk'}_ECHOEDKEY0123456789ABCDEF`;
    const img = await jpeg('#666666');
    const fetchStub = (async () =>
      new Response(JSON.stringify({ error: { message: `Invalid API Key: ${key}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const { rt, ledger, logs } = kit({ runtime: { mock: null, fetch: fetchStub } });
    const r = await callModel(
      rt,
      readingRequest(img, { resolved: { ...resolved('groq'), apiKey: key } }),
    );
    expect(r).toMatchObject({ status: 'paused', reason: 'auth' });
    for (const text of [JSON.stringify(logs), JSON.stringify(ledger.rows), JSON.stringify(r)]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain('ECHOEDKEY');
    }
    expect(logs[0]?.obj.ai).toMatchObject({ type: 'APICallError', statusCode: 401 });
  });

  it('refuses an image that carries EXIF (GPS), before anything else', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '30/1 2/1 0/1' } })
      .toBuffer();
    const { rt, ledger } = kit();
    await expect(
      callModel(rt, readingRequest({ bytes, mediaType: 'image/jpeg', width: 8, height: 8 })),
    ).rejects.toThrow(/EXIF/);
    expect(ledger.rows).toHaveLength(0);
  });
});

describe('callModel: what reaches the provider (wire shapes, stubbed fetch)', () => {
  async function capture(
    kind: 'groq' | 'openrouter' | 'openai' | 'openai_compatible',
    structured?: boolean,
  ) {
    const img = await jpeg('#777777');
    const seen: { url: string; body: Record<string, unknown>; count: number } = {
      url: '',
      body: {},
      count: 0,
    };
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.count++;
      seen.url = String(url);
      seen.body = JSON.parse(String(init.body));
      return new Response('{"error":{"message":"stop here"}}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { rt } = kit({ runtime: { mock: null, fetch: fetchStub } });
    const res = resolved(kind, structured === undefined ? {} : { structured });
    const r = await callModel(rt, readingRequest(img, { resolved: res }));
    return { r, seen };
  }

  it('sends one request with retries off (maxRetries: 0), even on a 5xx', async () => {
    const { r, seen } = await capture('groq');
    expect(r).toMatchObject({ status: 'failed', errorCode: 'http_5xx' });
    expect(seen.count).toBe(1);
  });

  it('Groq: json_schema with strict off, reasoning_effort low, the image as a data URL', async () => {
    const { seen } = await capture('groq');
    expect(seen.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(seen.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: false, name: 'kept_reading' },
    });
    expect(seen.body.reasoning_effort).toBe('low');
    expect(seen.body.max_tokens ?? seen.body.max_completion_tokens).toBe(2248);
    expect(JSON.stringify(seen.body.messages)).toContain('data:image/jpeg;base64,');
  });

  it('OpenRouter: reasoning and usage on the model, strict off', async () => {
    const { seen } = await capture('openrouter');
    expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen.body.reasoning).toEqual({ effort: 'low' });
    expect(seen.body.usage).toEqual({ include: true });
    expect(seen.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: false },
    });
  });

  it('OpenAI: strict off and detail high on the image', async () => {
    const { seen } = await capture('openai');
    expect(seen.url).toBe('https://api.openai.com/v1/responses');
    const text = JSON.stringify(seen.body);
    expect(text).toContain('"detail":"high"');
    expect(text).toContain('"strict":false');
  });

  it('OpenAI-compatible without structured outputs: the schema goes into the instructions', async () => {
    const { seen } = await capture('openai_compatible', false);
    expect(seen.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(JSON.stringify(seen.body.messages)).toContain('JSON Schema');
  });
});
