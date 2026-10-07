import { EXTRACTION_SCHEMAS, newId, parseLenient } from '@kept/shared';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jpeg } from '../../test/ai-kit.js';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { type Keyring, seal } from '../crypto/envelope.js';
import { type AiRuntime, type CallRequest, callModel, embedValues } from './call.js';
import { DbBudgetGate } from './db-gate.js';
import { DbKeyStore, providerKeyAad } from './db-keys.js';
import { DbPacer } from './db-pacer.js';
import { dbPriceLookup } from './db-prices.js';
import { doorRunner } from './db-run.js';
import { createMockEmbeddingModel, mockKey } from './mock.js';
import type { ReserveRequest } from './ports.js';
import { wireName, wireSchema } from './wire.js';

// Step-3 T6: the DB adapters for the provider layer's ports, run through the scenarios
// memory.test.ts runs against the in-memory ones (bucketsFor, the D206 caps, the default
// budgets, a manual pause, the 80%/100% crossings, payer and key slots, clearAuth), then
// callModel end to end on them: one ledger row per call, a held-back row when a cap refuses.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

const MASTER = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const keyring: Keyring = new Map([[1, MASTER.key]]);

let ibrahim: Tenant;
let second: { locationId: string };
let alfred: string;
let talia: Tenant;
let groqKey: string;
let openaiKey: string;

const own = async <T extends object>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query(sql, values)).rows as T[]);
const runAs = (userId: string) => doorRunner(db.pools, { userId, mfa: true });
const gateFor = (userId: string) => new DbBudgetGate(runAs(userId));
const dbTime = async (sql: string) => (await own<{ t: Date }>(`SELECT ${sql} AS t`))[0]?.t as Date;

beforeEach(async () => {
  await db.reset();
  ibrahim = await seedTenant(db, 'db-ibrahim');
  second = await ownerTx(db, (c) =>
    insertLocation(
      c,
      { userId: ibrahim.userId, accountId: ibrahim.accountId },
      { name: 'Cottage' },
    ),
  );
  alfred = await seedUser(db, 'db-alfred');
  await addMember(db, ibrahim.locationId, alfred, 'member');
  talia = await seedTenant(db, 'db-talia');
  groqKey = newId();
  openaiKey = newId();
  await own(
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, user_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $3, NULL, 'groq', $4, 1, '{"vision": "qwen/qwen3.8-27b"}', $5),
            ($2, 'user', NULL, $5, 'openai', $6, 1, '{"chat": "gpt-chat"}', $5)`,
    [
      groqKey,
      openaiKey,
      ibrahim.accountId,
      JSON.stringify(seal(MASTER, 'gsk_TESTKEY-groq', providerKeyAad(groqKey))),
      ibrahim.userId,
      JSON.stringify(seal(MASTER, 'sk-TESTKEY-openai', providerKeyAad(openaiKey))),
    ],
  );
});

const req = (over: Partial<ReserveRequest> = {}): ReserveRequest => ({
  payer: { scope: 'account', accountId: ibrahim.accountId, userId: null, fellBack: false },
  locationId: ibrahim.locationId,
  ownerAccountId: ibrahim.accountId,
  userId: ibrahim.userId,
  budgetTask: 'extraction',
  estimateTokens: 1000,
  estimateCost: null,
  jobId: `j-${newId()}`,
  now: new Date(),
  ...over,
});

const cap = (values: Record<string, unknown>) => {
  const cols = Object.keys(values);
  return own<{ id: string }>(
    `INSERT INTO public.ai_budgets (${cols.join(', ')}, set_by)
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
    [...Object.values(values), ibrahim.userId],
  ).then((r) => r[0]?.id as string);
};

describe('DbBudgetGate: buckets (memory.test.ts "bucketsFor")', () => {
  const bucketsOf = async (r: ReserveRequest, who = ibrahim.userId) => {
    const res = await gateFor(who).reserve(r);
    if (!res.ok) throw new Error(`refused: ${JSON.stringify(res)}`);
    return res.reservation.buckets;
  };

  it('account-paid work in a location', async () => {
    expect(await bucketsOf(req())).toEqual(
      [
        `account:${ibrahim.accountId}`,
        `account:${ibrahim.accountId}:extraction`,
        `location:${ibrahim.locationId}`,
        `member:${ibrahim.accountId}:${ibrahim.userId}`,
      ].sort(),
    );
  });

  it("a viewer's assistant turn is paid by the location's account; their extraction isn't", async () => {
    const viewer = await seedUser(db, 'db-viewer');
    await addMember(db, ibrahim.locationId, viewer, 'viewer');
    const asViewer = (budgetTask: ReserveRequest['budgetTask']) =>
      gateFor(viewer).reserve(req({ userId: viewer, budgetTask }));
    expect((await asViewer('assistant')).ok).toBe(true);
    expect((await asViewer('embeddings')).ok).toBe(true);
    await expect(asViewer('extraction')).rejects.toMatchObject({ code: '42501' });
    // A stranger to the location is refused whatever the task.
    await expect(
      gateFor(talia.userId).reserve(req({ userId: talia.userId, budgetTask: 'assistant' })),
    ).rejects.toMatchObject({ code: '42501' });
    // The key's pacer bookkeeping is reachable from a location of its account the viewer sees.
    const admitted = await new DbPacer(runAs(viewer)).admit(
      { id: groqKey, kind: 'groq' },
      1,
      'v',
      new Date(),
    );
    expect(admitted.ok).toBe(true);
  });

  it('a personal key counts against user:, never the account', async () => {
    expect(
      await bucketsOf(
        req({ payer: { scope: 'user', accountId: null, userId: ibrahim.userId, fellBack: false } }),
      ),
    ).toEqual(
      [
        `location:${ibrahim.locationId}`,
        `member:${ibrahim.accountId}:${ibrahim.userId}`,
        `user:${ibrahim.userId}`,
      ].sort(),
    );
  });

  it('the instance key counts against instance, instance:<task> and the account’s allowance', async () => {
    expect(
      await bucketsOf(
        req({
          payer: { scope: 'instance', accountId: null, userId: null, fellBack: true },
          locationId: null,
          userId: null,
        }),
      ),
    ).toEqual(['instance', 'instance:extraction', `instance_account:${ibrahim.accountId}`]);
  });
});

describe('DbBudgetGate (memory.test.ts "D206 caps")', () => {
  it('a location cap pauses that location only', async () => {
    await cap({
      scope: 'location',
      owner_account_id: ibrahim.accountId,
      location_id: ibrahim.locationId,
      tokens_per_month: 500,
    });
    const gate = gateFor(ibrahim.userId);
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      kind: 'cap',
      bucket: `location:${ibrahim.locationId}`,
    });
    expect((await gate.reserve(req({ locationId: second.locationId }))).ok).toBe(true);
  });

  it('a member cap pauses one person, not the household', async () => {
    await cap({
      scope: 'member',
      owner_account_id: ibrahim.accountId,
      user_id: alfred,
      tokens_per_month: 500,
    });
    expect(await gateFor(alfred).reserve(req({ userId: alfred }))).toMatchObject({
      ok: false,
      bucket: `member:${ibrahim.accountId}:${alfred}`,
    });
    expect((await gateFor(ibrahim.userId).reserve(req())).ok).toBe(true);
  });

  it('the per-account allowance on the instance key pauses one account, not another', async () => {
    await cap({
      scope: 'instance_account',
      owner_account_id: ibrahim.accountId,
      tokens_per_month: 500,
    });
    const inst = { scope: 'instance' as const, accountId: null, userId: null, fellBack: true };
    expect(await gateFor(ibrahim.userId).reserve(req({ payer: inst }))).toMatchObject({
      ok: false,
      bucket: `instance_account:${ibrahim.accountId}`,
    });
    expect(
      (
        await gateFor(talia.userId).reserve(
          req({
            payer: inst,
            ownerAccountId: talia.accountId,
            locationId: talia.locationId,
            userId: talia.userId,
          }),
        )
      ).ok,
    ).toBe(true);
  });

  it('a money cap refuses when the estimate would pass it (its currency, or one with a rate)', async () => {
    await cap({
      scope: 'account',
      owner_account_id: ibrahim.accountId,
      monthly_cap_amount: '0.01',
      cap_currency: 'USD',
    });
    const gate = gateFor(ibrahim.userId);
    expect(
      await gate.reserve(req({ estimateCost: { amount: '0.02', currency: 'USD' } })),
    ).toMatchObject({ ok: false, reason: 'cap_money' });
    // Reaching the cap paused it until the 1st (§7.15's state machine).
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      reason: 'cap_money',
      until: await dbTime(`date_trunc('month', now(), 'UTC') + interval '1 month'`),
    });
    await own('UPDATE public.ai_budgets SET paused_until = NULL, paused_reason = NULL');
    expect((await gate.reserve(req({ estimateCost: { amount: '5', currency: 'EGP' } }))).ok).toBe(
      true,
    );
  });

  // Step 4 (0049): other currencies count through the account's exchange rates (D76).
  it("a USD cap counts an EGP estimate and cost through the account's USD→EGP rate", async () => {
    await own(
      `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
       VALUES ($1, 'USD', 'EGP', 50, (now() AT TIME ZONE 'UTC')::date, $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const id = await cap({
      scope: 'account',
      owner_account_id: ibrahim.accountId,
      monthly_cap_amount: '1',
      cap_currency: 'USD',
    });
    const gate = gateFor(ibrahim.userId);
    const first = await gate.reserve(req({ estimateCost: { amount: '30', currency: 'EGP' } }));
    if (!first.ok) throw new Error('expected a reservation');
    // EGP 45 is USD 0.90: the 80% warning, on the counted sum.
    expect(
      await gate.settle(first.reservation, {
        tokens: 900,
        cost: { amount: '45', currency: 'EGP' },
        callId: newId(),
        now: new Date(),
      }),
    ).toEqual([expect.objectContaining({ budgetId: id, level: 80 })]);
    // EGP 10 more (USD 0.20) would pass USD 1.
    expect(
      await gate.reserve(req({ estimateCost: { amount: '10', currency: 'EGP' } })),
    ).toMatchObject({ ok: false, kind: 'cap', reason: 'cap_money' });
  });

  it('the default per-task budget applies without a row (Q7): TPM is a wait, the day a pause', async () => {
    expect(await gateFor(ibrahim.userId).reserve(req({ estimateTokens: 60_001 }))).toMatchObject({
      ok: false,
      kind: 'wait',
      reason: 'tpm',
      until: await dbTime(`date_trunc('minute', now()) + interval '1 minute'`),
    });
    await own('DELETE FROM public.ai_budgets');
    await cap({
      scope: 'account',
      owner_account_id: ibrahim.accountId,
      task: 'extraction',
      tokens_per_day: 1500,
    });
    const day = gateFor(ibrahim.userId);
    expect((await day.reserve(req())).ok).toBe(true);
    expect(await day.reserve(req())).toMatchObject({
      ok: false,
      kind: 'cap',
      reason: 'tokens_day',
      until: await dbTime(`date_trunc('day', now(), 'UTC') + interval '1 day'`),
    });
  });

  it('a manual pause refuses everything under it', async () => {
    await cap({
      scope: 'account',
      owner_account_id: ibrahim.accountId,
      paused_until: 'infinity',
      paused_reason: 'manual',
    });
    expect(await gateFor(ibrahim.userId).reserve(req())).toMatchObject({
      ok: false,
      kind: 'cap',
      reason: 'manual',
    });
  });

  it('settle trues up and crosses 80% and 100% once each per month', async () => {
    const id = await cap({
      scope: 'account',
      owner_account_id: ibrahim.accountId,
      tokens_per_month: 10_000,
    });
    const gate = gateFor(ibrahim.userId);
    const month = (
      await own<{ m: string }>(`SELECT date_trunc('month', now(), 'UTC')::date::text AS m`)
    )[0]?.m;
    const step = async (tokens: number) => {
      const r = await gate.reserve(req({ estimateTokens: 1 }));
      if (!r.ok) throw new Error('refused');
      return gate.settle(r.reservation, { tokens, cost: null, callId: 'c', now: new Date() });
    };
    expect(await step(7000)).toEqual([]);
    expect(await step(1500)).toEqual([
      { budgetId: id, bucket: `account:${ibrahim.accountId}`, level: 80, month },
    ]);
    expect(await step(100)).toEqual([]);
    expect(await step(2000)).toEqual([
      { budgetId: id, bucket: `account:${ibrahim.accountId}`, level: 100, month },
    ]);
    expect(
      await own('SELECT paused_reason, paused_until FROM public.ai_budgets WHERE id = $1', [id]),
    ).toEqual([
      {
        paused_reason: 'cap_tokens',
        paused_until: await dbTime(`date_trunc('month', now(), 'UTC') + interval '1 month'`),
      },
    ]);
  });

  it('the payer has two slots; the third waits (concurrency)', async () => {
    const gate = gateFor(ibrahim.userId);
    expect((await gate.reserve(req())).ok).toBe(true);
    expect((await gate.reserve(req())).ok).toBe(true);
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      kind: 'wait',
      reason: 'concurrency',
    });
  });
});

describe('DbPacer (memory.test.ts "InMemoryPacer")', () => {
  it('one slot per Groq key, two otherwise', async () => {
    const pacer = new DbPacer(runAs(ibrahim.userId));
    const now = new Date();
    expect((await pacer.admit({ id: groqKey, kind: 'groq' }, 1, 'a', now)).ok).toBe(true);
    expect(await pacer.admit({ id: groqKey, kind: 'groq' }, 1, 'b', now)).toMatchObject({
      ok: false,
      reason: 'concurrency',
    });
    expect((await pacer.admit({ id: openaiKey, kind: 'openai' }, 1, 'a', now)).ok).toBe(true);
    expect((await pacer.admit({ id: openaiKey, kind: 'openai' }, 1, 'b', now)).ok).toBe(true);
  });

  it('clearAuth lifts a rejected key', async () => {
    const pacer = new DbPacer(runAs(ibrahim.userId));
    const now = new Date();
    await pacer.observe(
      { id: groqKey, kind: 'groq' },
      { headers: undefined, signal: { kind: 'auth' } },
      now,
    );
    expect(await pacer.admit({ id: groqKey, kind: 'groq' }, 1, 'a', now)).toMatchObject({
      ok: false,
      reason: 'auth',
    });
    await pacer.clearAuth(groqKey);
    expect((await pacer.admit({ id: groqKey, kind: 'groq' }, 1, 'a', now)).ok).toBe(true);
  });

  it('stores the provider’s window from its headers and holds a call it can’t fit', async () => {
    const pacer = new DbPacer(runAs(ibrahim.userId));
    const limits = await pacer.observe(
      { id: groqKey, kind: 'groq' },
      {
        headers: {
          'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '120',
          'x-ratelimit-reset-tokens': '1m26.4s',
        },
        signal: { kind: 'ok' },
      },
      new Date(),
    );
    expect(limits).toMatchObject({ limitTokens: 8000, remainingTokens: 120 });
    expect(await pacer.admit({ id: groqKey, kind: 'groq' }, 3000, 'a', new Date())).toMatchObject({
      ok: false,
      kind: 'hold',
      reason: 'limits',
    });
    expect((await pacer.admit({ id: groqKey, kind: 'groq' }, 100, 'a', new Date())).ok).toBe(true);
  });

  it('learns an output-token limit from a 429 and holds the call whose output would pass it (0045)', async () => {
    const pacer = new DbPacer(runAs(ibrahim.userId));
    const key = { id: openaiKey, kind: 'openai' as const };
    // Nothing is counted before a limit is known.
    await pacer.observe(
      key,
      { headers: {}, signal: { kind: 'ok' }, outputTokens: 5000 },
      new Date(),
    );
    expect((await pacer.admit(key, 1, 'a', new Date(), 5000)).ok).toBe(true);
    // The 429 names the limit: 997 used, free again in 11.34 s (sleep in place, ≤ 10 s? no: hold).
    await pacer.observe(
      key,
      {
        headers: { 'retry-after': '12' },
        signal: { kind: 'rate_limited', retryAfterMs: 12_000 },
        outputLimit: { limit: 1000, used: 997, requested: 192, retryMs: 11_340, tooLarge: false },
      },
      new Date(),
    );
    // (The breaker's trip is its own matter: end it to see the output window alone.)
    await ownerTx(db, (c) =>
      c.query('UPDATE public.ai_breakers SET reason = NULL, until = NULL WHERE provider_id = $1', [
        openaiKey,
      ]),
    );
    const held = await pacer.admit(key, 1, 'a', new Date(), 200);
    expect(held).toMatchObject({ ok: false, reason: 'limits' });
    // A call that fits in the three tokens left goes.
    expect((await pacer.admit(key, 1, 'a', new Date(), 3)).ok).toBe(true);

    // Groq's "Request too large" refusal names no use and no retry: the window is full for a
    // whole minute from now, so even a one-token call waits (not an immediate retry).
    const refusedAt = new Date();
    await pacer.observe(
      key,
      {
        headers: {},
        signal: { kind: 'rate_limited', retryAfterMs: null },
        outputLimit: { limit: 1000, used: 1000, requested: 1308, retryMs: null, tooLarge: true },
      },
      refusedAt,
    );
    await ownerTx(db, (c) =>
      c.query('UPDATE public.ai_breakers SET reason = NULL, until = NULL WHERE provider_id = $1', [
        openaiKey,
      ]),
    );
    const refused = await pacer.admit(key, 1, 'a', new Date(), 1);
    expect(refused).toMatchObject({ ok: false, kind: 'hold', reason: 'limits' });
    const until = (refused as { until: Date }).until.getTime();
    expect(until - refusedAt.getTime()).toBeGreaterThan(55_000);
    expect(until - refusedAt.getTime()).toBeLessThan(65_000);
  });
});

describe('DbKeyStore', () => {
  it('resolves the cascade and opens the key, only for a caller who may use it', async () => {
    const keys = new DbKeyStore(runAs(alfred), keyring);
    const r = await keys.resolve({
      locationId: ibrahim.locationId,
      userId: alfred,
      task: 'extraction',
    });
    expect(r).toMatchObject({
      provider: { id: groqKey, kind: 'groq', model: 'qwen/qwen3.8-27b' },
      apiKey: 'gsk_TESTKEY-groq',
      payer: { scope: 'account', accountId: ibrahim.accountId, fellBack: false },
      ownerAccountId: ibrahim.accountId,
    });
    // No provider has an assistant model for the home: AI is off for that task.
    expect(
      await keys.resolve({ locationId: ibrahim.locationId, userId: alfred, task: 'assistant' }),
    ).toBeNull();
    await expect(
      new DbKeyStore(runAs(talia.userId), keyring).resolve({
        locationId: ibrahim.locationId,
        userId: talia.userId,
        task: 'extraction',
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('forProvider opens a provider its manager tests, and nobody else', async () => {
    const r = await new DbKeyStore(runAs(ibrahim.userId), keyring).forProvider(
      openaiKey,
      'assistant',
    );
    expect(r).toMatchObject({ apiKey: 'sk-TESTKEY-openai', payer: { scope: 'user' } });
    await expect(
      new DbKeyStore(runAs(alfred), keyring).forProvider(openaiKey, 'assistant'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('callModel on the DB adapters', () => {
  async function runtime(userId: string, answers: AiRuntime['mock']) {
    const run = runAs(userId);
    const gate = new DbBudgetGate(run);
    return {
      keys: new DbKeyStore(run, keyring),
      ledger: gate,
      gate,
      pacer: new DbPacer(run),
      prices: dbPriceLookup(run),
      fetch: (() => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
      now: () => new Date(),
      sleep: async () => {},
      log: { warn: () => {}, info: () => {} },
      mock: answers,
    } satisfies AiRuntime;
  }

  async function request(userId: string) {
    const img = await jpeg('#336699');
    const rt = await runtime(userId, {
      [mockKey(img.bytes)]: {
        output: { value: { value: 52340, confidence: 0.98 } },
        usage: { input: 877, output: 37, reasoning: 0 },
      },
    });
    const resolved = await rt.keys.resolve({
      locationId: ibrahim.locationId,
      userId,
      task: 'extraction',
    });
    if (!resolved) throw new Error('no provider');
    const schema = EXTRACTION_SCHEMAS.reading;
    const call: CallRequest<unknown> = {
      resolved,
      task: 'extract_reading',
      locationId: ibrahim.locationId,
      userId,
      links: {},
      instructions: 'Read the meter.',
      text: 'Read this meter.',
      images: [img],
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
      jobId: `job-${newId()}`,
    };
    return { rt, call };
  }

  it('writes one sent row, costed from the price table, and frees every slot', async () => {
    const [price] = await own<{ id: string }>(
      `INSERT INTO public.ai_model_prices (provider_kind, model, version, input_per_mtok,
                                           output_per_mtok, currency, source, created_by,
                                           effective_from)
       VALUES ('groq', 'qwen/qwen3.8-27b', 1, 0.2, 0.6, 'USD', 'admin', $1,
               now() - interval '1 minute')
       RETURNING id`,
      [ibrahim.userId],
    );
    const { rt, call } = await request(alfred);
    const r = await callModel(rt, call);
    expect(r.status).toBe('ok');
    const rows = await own<Record<string, unknown>>(
      `SELECT sent, outcome, input_tokens, output_tokens, cost_source, price_id, cost_amount,
              user_id, paying_account_id
         FROM public.llm_calls`,
    );
    expect(rows).toEqual([
      {
        sent: true,
        outcome: 'ok',
        input_tokens: 877,
        output_tokens: 37,
        cost_source: 'price_table',
        price_id: price?.id,
        // 877 × 0.2 and 37 × 0.6 per million, each rounded half up to 6 places (cost.ts).
        cost_amount: '0.000197',
        user_id: alfred,
        paying_account_id: ibrahim.accountId,
      },
    ]);
    expect(await own('SELECT lease_key FROM public.ai_leases')).toEqual([]);
    const [w] = await own<{ tokens: string }>(
      `SELECT tokens FROM public.ai_usage_windows
        WHERE bucket = $1 AND window_kind = 'month'`,
      [`location:${ibrahim.locationId}`],
    );
    expect(Number(w?.tokens)).toBe(877 + 37);
  });

  it('a cap that refuses writes exactly one held-back row', async () => {
    await cap({ scope: 'account', owner_account_id: ibrahim.accountId, tokens_per_month: 10 });
    const { rt, call } = await request(alfred);
    const r = await callModel(rt, call);
    expect(r).toMatchObject({ status: 'paused', kind: 'cap', reason: 'cap_tokens' });
    expect(
      await own('SELECT sent, outcome, error_code, cost_source FROM public.llm_calls'),
    ).toEqual([
      {
        sent: false,
        outcome: 'over_budget',
        error_code: 'account_cap_tokens',
        cost_source: 'not_sent',
      },
    ]);
  });

  // Step 6 (T8): the conversation never reaches the ledger (D206). A question, a tool argument, a
  // tool result and an embedding input each carry a marker; no llm_calls column holds any.
  it('a two-step tool turn and an embedding: four markers, none in any ledger column', async () => {
    const marks = ['QMARK8842', 'ARGMARK1196', 'RESMARK5521', 'EMBMARK7730'];
    const u = (i: number, o: number) => ({
      inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: o, text: o, reasoning: 0 },
    });
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        step++ === 0
          ? {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'where_is',
                  input: JSON.stringify({ query: marks[1] }),
                },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: u(900, 40),
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'In the Garage.' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: u(1100, 60),
              warnings: [],
            },
    });
    const rt: AiRuntime = { ...(await runtime(ibrahim.userId, {})), modelFactory: () => model };
    const resolved = await rt.keys.resolve({
      locationId: null,
      userId: ibrahim.userId,
      task: 'assistant',
    });
    if (!resolved) throw new Error('no provider');
    const threadId = newId();
    const base: CallRequest<string> = {
      resolved,
      task: 'assistant_turn',
      locationId: null,
      userId: ibrahim.userId,
      links: { threadId },
      instructions: 'You are Kept.',
      text: `Where is the drill? ${marks[0]}`,
      images: [],
      output: null,
      maxOutputTokens: 1200,
      expectedOutputTokens: 400,
      promptVersion: 'assistant-1',
      requestId: 'job-a',
      attempt: 1,
      jobId: `job-${newId()}`,
      tools: {
        defs: [
          {
            name: 'where_is',
            description: 'Where is a thing?',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
        choice: 'auto',
      },
    };
    const first = await callModel(rt, base);
    expect(first.status).toBe('ok');
    const second = await callModel(rt, {
      ...base,
      task: 'assistant_followup',
      text: '',
      conversation: {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: base.text }] },
          {
            role: 'assistant',
            parts: [
              { type: 'tool_call', callId: 'c1', tool: 'where_is', input: { query: marks[1] } },
            ],
          },
          {
            role: 'tool',
            parts: [
              {
                type: 'tool_result',
                callId: 'c1',
                tool: 'where_is',
                locationIds: [],
                output: { untrusted: { name: marks[2] } },
              },
            ],
          },
        ],
      },
    });
    expect(second).toMatchObject({ status: 'ok', value: 'In the Garage.' });
    const embedRt: AiRuntime = {
      ...(await runtime(ibrahim.userId, {})),
      embeddingModelFactory: () => createMockEmbeddingModel(),
    };
    const embedded = await embedValues(embedRt, {
      resolved,
      task: 'embed_query',
      locationId: null,
      userId: ibrahim.userId,
      links: {},
      values: [`drill ${marks[3]}`],
      requestId: 'job-e',
      attempt: 1,
      jobId: `job-${newId()}`,
    });
    expect(embedded.status).toBe('ok');
    const rows = await own<{ task: string; thread_id: string | null; j: string }>(
      'SELECT task, thread_id, row_to_json(c)::text AS j FROM public.llm_calls c ORDER BY id',
    );
    expect(rows.map((r) => r.task)).toEqual([
      'assistant_turn',
      'assistant_followup',
      'embed_query',
    ]);
    expect(rows.slice(0, 2).every((r) => r.thread_id === threadId)).toBe(true);
    for (const r of rows) for (const m of marks) expect(r.j).not.toContain(m);
  });
});
