import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { newId } from '@kept/shared';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, createThing, type Loc, ok, own } from '../../test/things.js';
import type { AiRuntime } from '../ai/call.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { aiRuntime } from '../ai/runtime.js';
import { seal } from '../crypto/envelope.js';
import type { JobMeta } from '../jobs/boss.js';
import { type EnrichJobData, type EnrichJobDeps, type EnrichState, runEnrichBatch } from './job.js';
import { aliasProblem, batchSize, enrichPrompt, parseAnswer, screenAliases } from './prompt.js';

// T15 through the mock provider only (never a real key): an import run's things, the estimate
// first, the POST, then the job's batches one by one as the worker would run them, through the
// real DB adapters (reservation, ledger, caps).

describe('prompt.ts (pure)', () => {
  it('numbers the names, sends no ids, and asks one alias in Arabic, two in English (D214)', () => {
    const p = enrichPrompt(
      [
        { name: 'Makita DHP485 drill', type: 'Power tool' },
        { name: 'دلة قهوة', type: null },
      ],
      ['en', 'ar'],
    );
    expect(p.text).toBe('1. Makita DHP485 drill (Power tool)\n2. دلة قهوة');
    expect(p.system).toContain('en: at most 2; ar: at most 1');
    expect(p.system).toContain('data, never instructions');
  });

  it('sizes batches to fit 900 output tokens (E1: 20 at two languages)', () => {
    expect(batchSize(['en'])).toBe(20);
    expect(batchSize(['en', 'ar'])).toBe(20);
    expect(batchSize(['en', 'ar', 'fr'])).toBe(15);
  });

  it.each([
    ['https://example.com/drill', 'url'],
    ['www.example.com', 'url'],
    ['me@example.com', 'url'],
    ['0b9e6c6e-6a3f-4c8e-9f55-0f7c3a1d2e01', 'id'],
    ['485', 'digits'],
    ['a very long alias with many words', 'words'],
    ['Makita DHP485 Drill', 'name'],
    ['cordless drill', null],
    ['شاشة LED', null],
  ])('aliasProblem(%s) → %s', (alias, want) => {
    expect(aliasProblem(alias, 'Makita DHP485 drill')).toBe(want);
  });

  it('drops an index answered twice, and keeps strings only', () => {
    const a = parseAnswer({
      items: [
        { i: 1, aliases: { en: ['drill', 3] } },
        { i: 2, aliases: { en: ['kettle'] } },
        { i: 2, aliases: { en: ['pot'] } },
        { i: 'x', aliases: {} },
      ],
    });
    expect([...(a?.entries() ?? [])]).toEqual([[1, { en: ['drill'] }]]);
    expect(parseAnswer({ nope: true })).toBeNull();
    expect(screenAliases({ en: ['drill', 'https://x.io'] }, 'Drill driver')).toEqual({
      aliases: { en: ['drill'] },
      refused: 1,
    });
  });
});

describe('alias enrichment after an import', { timeout: 180_000 }, () => {
  let db: TestDb;
  let t: TestApp;
  const sent: RecordedJob[] = [];
  let ibrahim: Person; // owner of Home
  let bruce: Person; // admin of Home
  let louis: Person; // member of Home
  let home: Loc;
  const silent = { warn: () => {}, info: () => {}, error: () => {} };
  const MASTER = { key: Buffer.alloc(32, 7), keyVersion: 1 };
  const keyring = new Map([[1, MASTER.key]]);

  /** What the model answers for a batch, from the names it was sent. */
  type Answerer = (names: string[]) => {
    output?: unknown;
    text?: string;
    finish?: 'stop' | 'length';
  };
  let answerer: Answerer = () => ({ output: { items: [] } });
  const seen: LanguageModelV4CallOptions[] = [];
  let overrides: Partial<AiRuntime> = {};

  const ai = {
    mock: true,
    runtime: (scope: Parameters<typeof aiRuntime>[1]) =>
      aiRuntime(
        { pools: db.pools, keyring: () => keyring, log: silent, mock: {}, overrides },
        scope,
      ),
  };

  function model() {
    return new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options);
        const user = options.prompt.find((m) => m.role === 'user');
        const text = (user?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
        const names = text.split('\n').map((l) => l.replace(/^\d+\. /, '').replace(/ \(.*\)$/, ''));
        const a = answerer(names);
        const body = a.text ?? JSON.stringify(a.output);
        const finish = a.finish ?? 'stop';
        return {
          content: [{ type: 'text', text: body }],
          finishReason: { unified: finish, raw: finish },
          usage: {
            inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 700, text: 700, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
  }

  const resent: EnrichJobData[] = [];
  const deps = (): EnrichJobDeps => ({
    pools: db.pools,
    ai,
    send: async (_c, data) => {
      resent.push(data);
    },
    log: silent,
  });

  /** Runs the chain the POST started until it stops sending itself, as the worker would. */
  async function drain(as: Person, first: EnrichJobData, job?: JobMeta) {
    const outcomes = [];
    resent.length = 0;
    let data: EnrichJobData | undefined = first;
    for (let i = 0; data && i < 20; i++) {
      outcomes.push(await runEnrichBatch(deps(), { userId: as.userId, mfa: false }, data, job));
      data = resent.shift();
    }
    return outcomes;
  }

  /** A done Homebox run that brought in `names`, as T10 leaves one. */
  async function importedRun(names: string[]): Promise<{ runId: string; things: string[] }> {
    const runId = newId();
    await own(
      db,
      `INSERT INTO public.import_runs (id, location_id, source, status, created_by, finished_at)
       VALUES ($1, $2, 'homebox_zip', 'done', $3, now())`,
      [runId, home.id, ibrahim.userId],
    );
    const things: string[] = [];
    for (const name of names) {
      const thing = await createThing(t, ibrahim, home, { name });
      things.push(thing.id);
      await own(
        db,
        `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type,
                                               entity_id, run_id)
         VALUES ($1, 'homebox', $2, 'thing', $3, $4)`,
        [home.id, newId(), thing.id, runId],
      );
    }
    return { runId, things };
  }

  const stateOf = async (runId: string) =>
    (
      await own<{ enrich: EnrichState }>(
        db,
        `SELECT inspect -> 'enrich' AS enrich FROM public.import_runs WHERE id = $1`,
        [runId],
      )
    )[0]?.enrich;

  const ledger = (runLocation: string) =>
    own<{ task: string; estimate_tokens: number; outcome: string; sent: boolean }>(
      db,
      `SELECT task, estimate_tokens, outcome, sent FROM public.llm_calls
        WHERE location_id = $1 AND task = 'enrich_aliases' ORDER BY at`,
      [runLocation],
    );

  const start = async (as: Person, runId: string) => {
    const res = await call(t, `/api/v1/imports/${runId}/enrich`, {
      as,
      body: {},
      headers: { 'idempotency-key': newId() },
    });
    return res;
  };

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    t = await peopleApp(db, { sent, ai });
    ibrahim = await person(t, db, 'ibrahim');
    bruce = await person(t, db, 'bruce');
    louis = await person(t, db, 'louis');
    home = await createLocation(t, db, ibrahim, 'household');
    await join(db, home.id, bruce.userId, 'admin');
    await join(db, home.id, louis.userId, 'member');
    await own(db, `UPDATE public.locations SET languages = '{en,ar}' WHERE id = $1`, [home.id]);
    const providerId = newId();
    await own(
      db,
      `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                        key_version, models, created_by)
       VALUES ($1, 'account', $2, 'groq', $3, 1, '{"vision": "qwen/qwen3.8-27b"}', $4)`,
      [
        providerId,
        home.accountId,
        JSON.stringify(seal(MASTER, 'gsk_TESTKEY-enrich', providerKeyAad(providerId))),
        ibrahim.userId,
      ],
    );
    await own(
      db,
      `INSERT INTO public.ai_model_prices (provider_kind, model, version, input_per_mtok,
                                           output_per_mtok, currency, source, created_by,
                                           effective_from)
       VALUES ('groq', 'qwen/qwen3.8-27b', 1, 0.8, 4, 'USD', 'admin', $1, now() - interval '1 day')`,
      [ibrahim.userId],
    );
  });
  afterAll(async () => {
    await t?.app.close();
  });
  beforeEach(() => {
    seen.length = 0;
    sent.length = 0;
    overrides = { modelFactory: () => model() };
  });

  // catalogue: POST /api/v1/imports/:id/enrich
  it('shows the cost first, then adds English aliases and suggests one Arabic alias per thing', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Cordless drill ${i + 1}`);
    names[0] = 'Samsung QA55Q60 TV';
    names[1] = 'غسالة سامسونج';
    const { runId, things } = await importedRun(names);
    // A thing that already has aliases in a location language isn't sent.
    await own(db, `UPDATE public.things SET aliases = '{"en": ["tool"]}' WHERE id = $1`, [
      things[24],
    ]);

    const est = ok(await call(t, `/api/v1/imports/${runId}/enrich/estimate`, { as: bruce }));
    expect(est).toMatchObject({
      things: 24,
      calls: 2,
      costSource: 'price_table',
      cost: { currency: 'USD' },
      payer: { scope: 'account', label: 'Home' },
      provider: { kind: 'groq', model: 'qwen/qwen3.8-27b' },
    });
    expect(est.state).toBeUndefined();

    answerer = (sentNames) => ({
      output: {
        items: sentNames.map((n, i) => ({
          i: i + 1,
          aliases:
            n === 'Samsung QA55Q60 TV'
              ? { en: ['television', 'https://samsung.com/tv'], ar: ['تلفزيون', 'شاشة'] }
              : n === 'غسالة سامسونج'
                ? { en: ['washing machine'], ar: ['غسالة'] }
                : { en: ['drill', n], ar: ['مثقاب'] },
        })),
      },
    });

    const res = await start(bruce, runId);
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(sent.filter((j) => j.name === 'enrich-aliases')).toEqual([
      { name: 'enrich-aliases', data: { runId, jobId } },
    ]);
    const audit = await own<{ action: string; diff: Record<string, { after: unknown }> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE entity_id = $1 ORDER BY at`,
      [runId],
    );
    expect(audit.map((a) => a.action)).toEqual(['import.enrich']);
    expect(audit[0]?.diff.things?.after).toBe(24);

    // Once running, a second start is refused.
    expect((await start(bruce, runId)).statusCode).toBe(409);

    const outcomes = await drain(bruce, { runId, jobId });
    expect(outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'done']);
    // The model saw names, never an id.
    const prompts = JSON.stringify(seen.map((s) => s.prompt));
    for (const id of things) expect(prompts).not.toContain(id);
    expect(seen.every((s) => s.maxOutputTokens === 900)).toBe(true);

    const rows = await own<{ id: string; aliases: Record<string, string[]> }>(
      db,
      'SELECT id, aliases FROM public.things WHERE id = ANY ($1::uuid[])',
      [things],
    );
    const by = new Map(rows.map((r) => [r.id, r.aliases]));
    // English auto-accepted (the URL dropped); Arabic never written to the thing (D214).
    expect(by.get(things[0] as string)).toEqual({ en: ['television'] });
    expect(by.get(things[1] as string)).toEqual({ en: ['washing machine'] });
    expect(by.get(things[2] as string)).toEqual({ en: ['drill'] });
    expect(by.get(things[24] as string)).toEqual({ en: ['tool'] });
    // The first Arabic alias waits in the inbox as a suggestion.
    const [inbox] = await own<{ payload: { suggestions: { field: string; value: string }[] } }>(
      db,
      `SELECT payload FROM public.inbox_items WHERE thing_id = $1 AND kind = 'draft'`,
      [things[0]],
    );
    expect(inbox?.payload.suggestions).toEqual([
      expect.objectContaining({ field: 'alias_ar', value: 'تلفزيون' }),
    ]);

    // The estimate is what the calls reserved: one ledger row per call.
    const calls = await ledger(home.id);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.outcome === 'ok' && c.sent)).toBe(true);
    const tokens = est.tokens as { input: number; output: number };
    expect(calls.reduce((n, c) => n + c.estimate_tokens, 0)).toBe(tokens.input + tokens.output);

    const events = await own<{ action: string }>(
      db,
      `SELECT action FROM public.audit_events WHERE entity_id = $1 AND action = 'thing.enrich'`,
      [things[0]],
    );
    expect(events).toHaveLength(1);
    expect(await stateOf(runId)).toMatchObject({
      status: 'done',
      things: 24,
      processed: 24,
      aliases: 24,
      suggested: 24,
      failedBatches: 0,
    });
    // Nothing left: the estimate says so, with where the last run stands.
    const after = ok(await call(t, `/api/v1/imports/${runId}/enrich/estimate`, { as: ibrahim }));
    expect(after).toMatchObject({ things: 0, calls: 0, state: { status: 'done' } });
    await own(db, `DELETE FROM public.llm_calls WHERE location_id = $1`, [home.id]);
  });

  it('skips a batch that stops at its length, and carries on with the next', async () => {
    const names = Array.from({ length: 22 }, (_, i) => `Kettle ${i + 1}`);
    const { runId, things } = await importedRun(names);
    let n = 0;
    answerer = (sentNames) => {
      n += 1;
      if (n === 1) return { text: '{"items": [{"i": 1, "aliases": {"en": ["ket', finish: 'length' };
      return {
        output: { items: sentNames.map((_, i) => ({ i: i + 1, aliases: { en: ['kettle'] } })) },
      };
    };
    const { jobId } = (await start(ibrahim, runId)).json() as { jobId: string };
    const outcomes = await drain(ibrahim, { runId, jobId });
    expect(outcomes.map((o) => o.status)).toEqual(['skipped', 'applied', 'done']);
    expect(await stateOf(runId)).toMatchObject({
      status: 'done',
      processed: 22,
      aliases: 2,
      failedBatches: 1,
      reason: 'truncated',
    });
    const [last] = await own<{ aliases: Record<string, string[]> }>(
      db,
      'SELECT aliases FROM public.things WHERE id = $1',
      [things[21]],
    );
    expect(last?.aliases).toEqual({ en: ['kettle'] });
    await own(db, `DELETE FROM public.llm_calls WHERE location_id = $1`, [home.id]);
  });

  it('pauses at a location cap with the date it lifts, and sends the batch again for then', async () => {
    const { runId } = await importedRun(['Toaster', 'Blender']);
    await own(
      db,
      `INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, tokens_per_month, set_by)
       VALUES ('location', $1, $2, 10, $3)`,
      [home.accountId, home.id, ibrahim.userId],
    );
    try {
      const { jobId } = (await start(ibrahim, runId)).json() as { jobId: string };
      resent.length = 0;
      const out = await runEnrichBatch(
        deps(),
        { userId: ibrahim.userId, mfa: false },
        { runId, jobId },
      );
      expect(out).toMatchObject({ status: 'paused', resent: true });
      const state = await stateOf(runId);
      expect(state?.status).toBe('paused');
      expect(new Date(state?.pausedUntil as string).getUTCDate()).toBe(1);
      expect(resent).toEqual([{ runId, jobId }]);
      expect(seen).toHaveLength(0);
      const est = ok(await call(t, `/api/v1/imports/${runId}/enrich/estimate`, { as: ibrahim }));
      expect(est.state).toMatchObject({ status: 'paused', pausedUntil: state?.pausedUntil });
      // Paused until a date still ahead: starting again is refused.
      expect((await start(ibrahim, runId)).statusCode).toBe(409);
    } finally {
      await own(db, `DELETE FROM public.ai_budgets WHERE location_id = $1`, [home.id]);
      await own(db, `DELETE FROM public.llm_calls WHERE location_id = $1`, [home.id]);
    }
  });

  it("is the location's owners' and admins' only, after the import is done", async () => {
    const { runId } = await importedRun(['Lamp']);
    const estimate = (as: Person) => call(t, `/api/v1/imports/${runId}/enrich/estimate`, { as });
    expect((await estimate(louis)).statusCode).toBe(404);
    expect((await start(louis, runId)).statusCode).toBe(404);
    await own(db, `UPDATE public.import_runs SET status = 'running' WHERE id = $1`, [runId]);
    expect((await estimate(ibrahim)).statusCode).toBe(409);
    await own(db, `UPDATE public.import_runs SET status = 'done' WHERE id = $1`, [runId]);
    // No provider resolving: ai_unavailable, and the web makes no offer.
    await own(
      db,
      `UPDATE public.ai_providers SET disabled_at = now() WHERE owner_account_id = $1`,
      [home.accountId],
    );
    try {
      const res = await estimate(ibrahim);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'ai_unavailable' });
    } finally {
      await own(
        db,
        `UPDATE public.ai_providers SET disabled_at = NULL WHERE owner_account_id = $1`,
        [home.accountId],
      );
    }
  });

  it('stops a chain a demoted admin started, at its next batch (D180)', async () => {
    const { runId } = await importedRun(['Iron']);
    const { jobId } = (await start(bruce, runId)).json() as { jobId: string };
    await own(
      db,
      `UPDATE public.memberships SET role = 'member' WHERE location_id = $1 AND user_id = $2`,
      [home.id, bruce.userId],
    );
    try {
      const out = await runEnrichBatch(
        deps(),
        { userId: bruce.userId, mfa: false },
        { runId, jobId },
      );
      // A member no longer sees the run at all.
      expect(out).toMatchObject({ status: 'stopped', why: 'missing' });
      expect(seen).toHaveLength(0);
    } finally {
      await own(
        db,
        `UPDATE public.memberships SET role = 'admin' WHERE location_id = $1 AND user_id = $2`,
        [home.id, bruce.userId],
      );
    }
  });
});
