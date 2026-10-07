import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import {
  addMember,
  insertLocation,
  ownerTx,
  pgError,
  seedTenant,
  seedUser,
  type Tenant,
} from '../../test/tenancy.js';
import { withScope, withSystem } from './scope.js';

// Step-3 T6: AI providers, caps, pacing doors and the partitioned call ledger (engineering spec
// §3.5, §7.15; D121, D167, D206; plan Q5–Q8). Ibrahim owns an account with a Personal location
// and a shared home; Alfred is a member there, Bruce a viewer, Louis an admin. Talia is another
// household; Peter is an instance admin.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // personal location = ibrahim.locationId
let home: { locationId: string; unplacedId: string };
let alfred: string;
let bruce: string;
let louis: string;
let talia: Tenant;
let peter: string;
let userKey: string;
let accountKey: string;
let instanceKey: string;

const as = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withScope(db.pools.app, { userId, mfa: true }, (_tx, c) => fn(c));
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  withSystem(db.pools.system, (_tx, c) => fn(c));
const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);

const DEFAULTS = {
  extraction: {
    tokens_per_minute: 60_000,
    tokens_per_day: 2_000_000,
    tokens_per_month: 20_000_000,
  },
};

type Ctx = Record<string, unknown>;
const accountPaid = (over: Ctx = {}): Ctx => ({
  paying_scope: 'account',
  paying_account_id: ibrahim.accountId,
  location_id: home.locationId,
  owner_account_id: ibrahim.accountId,
  user_id: ibrahim.userId,
  budget_task: 'extraction',
  estimate_tokens: 1000,
  job_id: `job-${newId()}`,
  request_id: 'req-1',
  task: 'extract_thing',
  provider_id: accountKey,
  provider_kind: 'groq',
  model: 'qwen/qwen3.8-27b',
  ...over,
});

type Reserved = {
  ok: boolean;
  retry_at: Date | null;
  reason: string | null;
  bucket: string | null;
  call_id: string | null;
  buckets: string[];
  slot: number | null;
};
const reserve = (userId: string, ctx: Ctx) =>
  as(userId, async (c) => {
    const { rows } = await c.query<Reserved>('SELECT * FROM kept.ai_reserve($1)', [
      JSON.stringify(ctx),
    ]);
    return rows[0] as Reserved;
  });
const settle = (
  userId: string,
  ctx: Ctx,
  r: Reserved,
  usage: Ctx,
  cost: Ctx | null = null,
  outcome = 'ok',
) =>
  as(userId, async (c) => {
    const { rows } = await c.query<{ call_id: string; crossed: unknown[] }>(
      'SELECT * FROM kept.ai_settle($1, $2, $3, $4)',
      [
        JSON.stringify({
          ...ctx,
          reservation: {
            id: r.call_id,
            slot: r.slot,
            estimate_tokens: ctx.estimate_tokens,
            estimate_cost: ctx.estimate_cost ?? null,
          },
        }),
        JSON.stringify({ sent: true, ...usage }),
        outcome,
        cost ? JSON.stringify(cost) : null,
      ],
    );
    return rows[0] as { call_id: string; crossed: unknown[] };
  });
const window = async (bucket: string, kind = 'month') =>
  Number(
    (
      await own<{ tokens: string }>(
        `SELECT coalesce(sum(tokens), 0) AS tokens FROM public.ai_usage_windows
          WHERE bucket = $1 AND window_kind = $2`,
        [bucket, kind],
      )
    )[0]?.tokens ?? 0,
  );
const nextMonth = async () =>
  (await own<{ t: Date }>(`SELECT date_trunc('month', now(), 'UTC') + interval '1 month' AS t`))[0]
    ?.t as Date;

async function addProvider(values: {
  scope: 'instance' | 'account' | 'user';
  accountId?: string;
  userId?: string;
  kind: string;
  vision: string | null;
  createdBy: string;
}): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, user_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, $2, $3, $4, $5, '{"v": 1}', 1, $6, $7)`,
    [
      id,
      values.scope,
      values.accountId ?? null,
      values.userId ?? null,
      values.kind,
      JSON.stringify(values.vision ? { vision: values.vision } : {}),
      values.createdBy,
    ],
  );
  return id;
}

async function household(): Promise<void> {
  await db.reset();
  ibrahim = await seedTenant(db, 'ai-ibrahim', { kind: 'personal', name: 'Personal' });
  home = await ownerTx(db, (c) =>
    insertLocation(c, { userId: ibrahim.userId, accountId: ibrahim.accountId }, { name: 'Home' }),
  );
  alfred = await seedUser(db, 'ai-alfred');
  await addMember(db, home.locationId, alfred, 'member');
  bruce = await seedUser(db, 'ai-bruce');
  await addMember(db, home.locationId, bruce, 'viewer');
  louis = await seedUser(db, 'ai-louis');
  await addMember(db, home.locationId, louis, 'admin');
  talia = await seedTenant(db, 'ai-talia');
  peter = await seedUser(db, 'ai-peter');
  await own('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [peter]);
  userKey = await addProvider({
    scope: 'user',
    userId: ibrahim.userId,
    kind: 'openai',
    vision: 'gpt-vision',
    createdBy: ibrahim.userId,
  });
  accountKey = await addProvider({
    scope: 'account',
    accountId: ibrahim.accountId,
    kind: 'groq',
    vision: 'qwen/qwen3.8-27b',
    createdBy: ibrahim.userId,
  });
  instanceKey = await addProvider({
    scope: 'instance',
    kind: 'openai',
    vision: 'gpt-vision',
    createdBy: peter,
  });
}

type ProviderFor = { provider_id: string; paying_scope: string; fell_back: boolean };
const providerFor = (userId: string, location: string | null) =>
  as(userId, async (c) => {
    const { rows } = await c.query<ProviderFor>(
      `SELECT provider_id, paying_scope, fell_back FROM kept.ai_provider_for($1, 'extraction')`,
      [location],
    );
    return rows[0];
  });

describe('resolution (plan Q5, D121)', () => {
  beforeAll(household);

  it('a Personal location takes its owner’s key; a shared one the account’s', async () => {
    expect(await providerFor(ibrahim.userId, ibrahim.locationId)).toMatchObject({
      provider_id: userKey,
      paying_scope: 'user',
      fell_back: false,
    });
    expect(await providerFor(ibrahim.userId, home.locationId)).toMatchObject({
      provider_id: accountKey,
      paying_scope: 'account',
      fell_back: false,
    });
  });

  it("a member's personal key never pays for someone else's home", async () => {
    const own_ = await addProvider({
      scope: 'user',
      userId: alfred,
      kind: 'openai',
      vision: 'gpt-vision',
      createdBy: alfred,
    });
    expect((await providerFor(alfred, home.locationId))?.provider_id).toBe(accountKey);
    // Their own work with no location is theirs.
    expect((await providerFor(alfred, null))?.provider_id).toBe(own_);
  });

  it('falls back to the instance key when the account has none usable', async () => {
    await own('UPDATE public.ai_providers SET disabled_at = now() WHERE id = $1', [accountKey]);
    try {
      expect(await providerFor(ibrahim.userId, home.locationId)).toMatchObject({
        provider_id: instanceKey,
        paying_scope: 'instance',
        fell_back: true,
      });
    } finally {
      await own('UPDATE public.ai_providers SET disabled_at = NULL WHERE id = $1', [accountKey]);
    }
  });

  it('skips a key its provider rejected (auth)', async () => {
    await as(ibrahim.userId, (c) =>
      c.query(`SELECT kept.ai_trip($1, 'infinity', 'auth')`, [accountKey]),
    );
    expect((await providerFor(ibrahim.userId, home.locationId))?.provider_id).toBe(instanceKey);
    expect(
      (await as(ibrahim.userId, (c) => c.query('SELECT kept.ai_clear_trip($1) AS v', [accountKey])))
        .rows[0].v,
    ).toBe(true);
    expect((await providerFor(ibrahim.userId, home.locationId))?.provider_id).toBe(accountKey);
  });

  it('refuses a viewer, another household and a random id alike (42501)', async () => {
    for (const [who, loc] of [
      [bruce, home.locationId],
      [talia.userId, home.locationId],
      [ibrahim.userId, newId()],
    ] as const) {
      expect((await pgError(providerFor(who, loc))).code).toBe('42501');
    }
    // A viewer still reads the status line, with no key in it.
    const status = await as(bruce, (c) =>
      c.query('SELECT * FROM kept.ai_status($1)', [home.locationId]),
    );
    expect(status.rows[0]).toMatchObject({ resolved: true, source: 'account', can_manage: false });
    expect(JSON.stringify(status.rows[0])).not.toContain('"v":1');
  });

  it('keeps the key column unreadable by kept_app (42501)', async () => {
    for (const sql of [
      'SELECT key_ciphertext FROM public.ai_providers',
      'SELECT * FROM public.ai_providers',
    ]) {
      expect((await pgError(as(ibrahim.userId, (c) => c.query(sql)))).code, sql).toBe('42501');
    }
    const rows = await as(ibrahim.userId, (c) =>
      c.query('SELECT id, key_hint FROM public.ai_providers ORDER BY id'),
    );
    expect(rows.rowCount).toBe(2);
  });
});

describe('the gate: reserve and settle (§7.15)', () => {
  beforeEach(household);

  it('keeps the windows exact under 10 concurrent reservations', async () => {
    const people = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const u = await seedUser(db, `ai-louis-${i}`);
        await addMember(db, home.locationId, u, 'member');
        return u;
      }),
    );
    const ctxs = people.map((u) =>
      accountPaid({
        paying_scope: 'user',
        paying_account_id: null,
        paying_user_id: u,
        user_id: u,
        provider_id: null,
      }),
    );
    const reserved = await Promise.all(
      people.map((u, i) => () => reserve(u, ctxs[i] as Ctx)).map((f) => f()),
    );
    expect(reserved.every((r) => r.ok)).toBe(true);
    expect(await window(`location:${home.locationId}`)).toBe(10_000);
    await Promise.all(
      people
        .map((u, i) => () => settle(u, ctxs[i] as Ctx, reserved[i] as Reserved, { tokens: 1500 }))
        .map((f) => f()),
    );
    expect(await window(`location:${home.locationId}`)).toBe(15_000);
    expect(await window(`location:${home.locationId}`, 'minute')).toBe(15_000);
  });

  it('gives the payer two slots: the third concurrent job waits (concurrency)', async () => {
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
    expect(await reserve(ibrahim.userId, accountPaid())).toMatchObject({
      ok: false,
      reason: 'concurrency',
      call_id: null,
    });
  });

  it('holds a second concurrent call on one groq key (concurrency 1)', async () => {
    const admit = (job: string) =>
      as(
        ibrahim.userId,
        async (c) =>
          (await c.query('SELECT * FROM kept.ai_key_admit($1, 100, $2)', [accountKey, job]))
            .rows[0],
      );
    expect(await admit('a')).toMatchObject({ ok: true, kind: 'ok', slot: 1 });
    expect(await admit('b')).toMatchObject({ ok: false, kind: 'hold', reason: 'concurrency' });
    await as(ibrahim.userId, (c) =>
      c.query(`SELECT kept.ai_key_release($1, 1, 'a')`, [accountKey]),
    );
    expect(await admit('b')).toMatchObject({ ok: true });
  });

  it('a month token cap pauses its bucket until the 1st, with one sent = false row', async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, tokens_per_month, set_by)
       VALUES ('account', $1, 500, $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const ctx = accountPaid();
    const r = await reserve(ibrahim.userId, { ...ctx, call: ctx });
    expect(r).toMatchObject({
      ok: false,
      reason: 'cap_tokens',
      bucket: `account:${ibrahim.accountId}`,
    });
    expect(r.retry_at).toEqual(await nextMonth());
    const rows = await own<Record<string, unknown>>(
      'SELECT sent, outcome, error_code, cost_source FROM public.llm_calls WHERE id = $1',
      [r.call_id],
    );
    expect(rows).toEqual([
      {
        sent: false,
        outcome: 'over_budget',
        error_code: 'account_cap_tokens',
        cost_source: 'not_sent',
      },
    ]);
    // Paused now: a smaller call is refused too, and writes its own row.
    const again = await reserve(ibrahim.userId, {
      ...accountPaid({ estimate_tokens: 1 }),
      call: ctx,
    });
    expect(again).toMatchObject({ ok: false, reason: 'cap_tokens' });
    expect(again.call_id).not.toBe(r.call_id);
  });

  it('a tpm or concurrency wait writes no ledger row', async () => {
    const ctx = accountPaid({ estimate_tokens: 60_001, defaults: DEFAULTS });
    const r = await reserve(ibrahim.userId, { ...ctx, call: ctx });
    expect(r).toMatchObject({ ok: false, reason: 'tpm', call_id: null });
    expect(await own('SELECT 1 FROM public.llm_calls')).toEqual([]);
  });

  it('a location cap pauses that location only', async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, tokens_per_month,
                                      set_by)
       VALUES ('location', $1, $2, 500, $3)`,
      [ibrahim.accountId, home.locationId, ibrahim.userId],
    );
    expect(await reserve(ibrahim.userId, accountPaid())).toMatchObject({
      ok: false,
      bucket: `location:${home.locationId}`,
    });
    expect(
      (await reserve(ibrahim.userId, accountPaid({ location_id: ibrahim.locationId }))).ok,
    ).toBe(true);
  });

  it('a member cap pauses one person, not the household', async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, user_id, tokens_per_month, set_by)
       VALUES ('member', $1, $2, 500, $3)`,
      [ibrahim.accountId, alfred, ibrahim.userId],
    );
    expect(await reserve(alfred, accountPaid({ user_id: alfred }))).toMatchObject({
      ok: false,
      bucket: `member:${ibrahim.accountId}:${alfred}`,
    });
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
  });

  it("a personal key's work never touches the account's buckets", async () => {
    const ctx = accountPaid({
      paying_scope: 'user',
      paying_account_id: null,
      paying_user_id: ibrahim.userId,
      location_id: ibrahim.locationId,
      provider_id: userKey,
    });
    const r = await reserve(ibrahim.userId, ctx);
    expect(r.buckets).toEqual(
      [
        `location:${ibrahim.locationId}`,
        `member:${ibrahim.accountId}:${ibrahim.userId}`,
        `user:${ibrahim.userId}`,
      ].sort(),
    );
    expect(await window(`account:${ibrahim.accountId}`)).toBe(0);
    expect(await window(`user:${ibrahim.userId}`)).toBe(1000);
  });

  it("the instance key counts against instance, instance:<task> and the account's allowance", async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, tokens_per_month, set_by)
       VALUES ('instance_account', NULL, 1500, $1)`,
      [peter],
    );
    const inst = (who: Tenant | 'ibrahim', over: Ctx = {}) =>
      accountPaid({
        paying_scope: 'instance',
        paying_account_id: null,
        provider_id: instanceKey,
        ...(who === 'ibrahim'
          ? {}
          : { location_id: who.locationId, owner_account_id: who.accountId, user_id: who.userId }),
        ...over,
      });
    const first = await reserve(ibrahim.userId, inst('ibrahim'));
    expect(first.buckets).toEqual(
      expect.arrayContaining([
        'instance',
        'instance:extraction',
        `instance_account:${ibrahim.accountId}`,
      ]),
    );
    await settle(ibrahim.userId, inst('ibrahim'), first, { tokens: 1600 });
    // Ibrahim's account has passed the default allowance and is paused; Talia's isn't.
    expect(await reserve(ibrahim.userId, inst('ibrahim'))).toMatchObject({
      ok: false,
      bucket: `instance_account:${ibrahim.accountId}`,
    });
    expect((await reserve(talia.userId, inst(talia))).ok).toBe(true);
    // The pause lives on Ibrahim's own copy of the allowance, not on the default row.
    const rows = await own<{ owner_account_id: string | null; paused_reason: string | null }>(
      `SELECT owner_account_id, paused_reason FROM public.ai_budgets WHERE scope = 'instance_account'`,
    );
    const byOwner = Object.fromEntries(
      rows.map((r) => [r.owner_account_id ?? 'default', r.paused_reason]),
    );
    expect(byOwner).toEqual({
      default: null,
      [ibrahim.accountId]: 'cap_tokens',
      [talia.accountId]: null,
    });
  });

  it('refuses a location cap above its account’s (cap_above_account)', async () => {
    await as(ibrahim.userId, (c) =>
      c.query(
        `SELECT kept.ai_cap_set('{"scope": "account", "monthlyCapAmount": "5", "capCurrency": "USD"}')`,
      ),
    );
    const err = await pgError(
      as(ibrahim.userId, (c) =>
        c.query('SELECT kept.ai_cap_set($1)', [
          JSON.stringify({
            scope: 'location',
            locationId: home.locationId,
            monthlyCapAmount: '6',
            capCurrency: 'USD',
          }),
        ]),
      ),
    );
    expect(err).toMatchObject({ code: 'P0001', constraint: 'cap_above_account' });
    // A member can't set caps at all.
    expect(
      (
        await pgError(
          as(alfred, (c) =>
            c.query(`SELECT kept.ai_cap_set('{"scope": "account", "tokensPerMonth": 5}')`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('a money cap in EGP does not count USD costs without a USD→EGP rate (D76)', async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, monthly_cap_amount, cap_currency,
                                      set_by)
       VALUES ('account', $1, 1, 'EGP', $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const ctx = accountPaid({ estimate_cost: { amount: '5', currency: 'USD' } });
    const r = await reserve(ibrahim.userId, ctx);
    expect(r.ok).toBe(true);
    await settle(
      ibrahim.userId,
      ctx,
      r,
      { tokens: 1000 },
      { amount: '5', currency: 'USD', source: 'provider' },
    );
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
    // In its own currency it counts.
    const egp = accountPaid({ estimate_cost: { amount: '2', currency: 'EGP' } });
    expect(await reserve(ibrahim.userId, egp)).toMatchObject({ ok: false, reason: 'cap_money' });
  });

  // Step-4 T4 (0049): the step-3 plan's "counted through an exchange-rate row" case.
  it("a USD cap counts an EGP cost through the account's USD→EGP rate, and names what it can't", async () => {
    await own(
      `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
       VALUES ($1, 'USD', 'EGP', 50, (now() AT TIME ZONE 'UTC')::date - 1, $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const cap = (
      await own<{ id: string }>(
        `INSERT INTO public.ai_budgets (scope, owner_account_id, monthly_cap_amount, cap_currency,
                                        set_by)
         VALUES ('account', $1, 1, 'USD', $2) RETURNING id`,
        [ibrahim.accountId, ibrahim.userId],
      )
    )[0]?.id as string;
    // EGP 25 is USD 0.50 against the USD 1 cap.
    const ctx = accountPaid({ estimate_cost: { amount: '25', currency: 'EGP' } });
    const r = await reserve(ibrahim.userId, ctx);
    expect(r.ok).toBe(true);
    // EGP 40 spent is USD 0.80: the 80% warning, on the counted sum.
    const { crossed } = await settle(
      ibrahim.userId,
      ctx,
      r,
      { tokens: 1000 },
      { amount: '40', currency: 'EGP', source: 'provider' },
    );
    expect(crossed).toEqual([expect.objectContaining({ budgetId: cap, level: 80 })]);
    // Another EGP 15 (USD 0.30) would pass the cap.
    const more = accountPaid({ estimate_cost: { amount: '15', currency: 'EGP' } });
    expect(await reserve(ibrahim.userId, more)).toMatchObject({ ok: false, reason: 'cap_money' });
    // A currency with no rate is left out, and named.
    await own(
      `INSERT INTO public.ai_cost_windows (bucket, month_start, currency, amount)
       VALUES ($1, date_trunc('month', now(), 'UTC')::date, 'GBP', 3)`,
      [`account:${ibrahim.accountId}`],
    );
    const usage = await as(ibrahim.userId, async (c) => {
      const { rows } = await c.query<{ spent: string; not_counted: string[] }>(
        'SELECT spent::text, not_counted FROM kept.ai_cap_usage($1)',
        [[cap]],
      );
      return rows[0];
    });
    expect(Number(usage?.spent)).toBeCloseTo(0.8, 6);
    expect(usage?.not_counted).toEqual(['GBP']);
  });

  it('settle returns crossed once at 80% and once at 100% per month', async () => {
    const cap = (
      await own<{ id: string }>(
        `INSERT INTO public.ai_budgets (scope, owner_account_id, tokens_per_month, set_by)
         VALUES ('account', $1, 10000, $2) RETURNING id`,
        [ibrahim.accountId, ibrahim.userId],
      )
    )[0]?.id;
    const step = async (tokens: number) => {
      const ctx = accountPaid({ estimate_tokens: 1 });
      const r = await reserve(ibrahim.userId, ctx);
      expect(r.ok).toBe(true);
      return (await settle(ibrahim.userId, ctx, r, { tokens })).crossed;
    };
    const month = (
      await own<{ m: string }>(`SELECT date_trunc('month', now(), 'UTC')::date::text AS m`)
    )[0]?.m;
    expect(await step(7000)).toEqual([]);
    expect(await step(1500)).toEqual([
      { budgetId: cap, bucket: `account:${ibrahim.accountId}`, level: 80, month },
    ]);
    expect(await step(100)).toEqual([]);
    expect(await step(2000)).toEqual([
      { budgetId: cap, bucket: `account:${ibrahim.accountId}`, level: 100, month },
    ]);
    expect(
      await own('SELECT paused_reason, paused_until FROM public.ai_budgets WHERE id = $1', [cap]),
    ).toEqual([{ paused_reason: 'cap_tokens', paused_until: await nextMonth() }]);
  });

  it('writes nothing a kept_app or kept_system statement could forge (42501)', async () => {
    const insert = `INSERT INTO public.llm_calls (request_id, task, paying_scope, provider_kind,
                      model, sent, outcome, cost_source)
                    VALUES ('x', 'extract_thing', 'instance', 'groq', 'm', false, 'ok', 'not_sent')`;
    expect((await pgError(as(ibrahim.userId, (c) => c.query(insert)))).code).toBe('42501');
    expect((await pgError(asSystem((c) => c.query(insert)))).code).toBe('42501');
  });

  it('puts each ledger row in its month’s partition', async () => {
    const ctx = accountPaid();
    const r = await reserve(ibrahim.userId, ctx);
    const { call_id } = await settle(ibrahim.userId, ctx, r, {
      input_tokens: 900,
      output_tokens: 50,
    });
    const [row] = await own<{ part: string; at: Date }>(
      'SELECT tableoid::regclass::text AS part, at FROM public.llm_calls WHERE id = $1',
      [call_id],
    );
    const at = row?.at as Date;
    expect(row?.part).toBe(
      `llm_calls_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  });
});

describe('resume, rollover and prices', () => {
  beforeEach(household);

  async function pausedExtractions(n: number): Promise<string[]> {
    const ids: string[] = [];
    await ownerTx(db, async (c) => {
      const file = newId();
      await c.query(
        `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                   derivative_state, created_by)
         VALUES ($1, $2, $3, repeat('a', 64), 10, 'image/jpeg', 'photo', 'ready', $4)`,
        [file, home.locationId, `f/${home.locationId}/${file}`, ibrahim.userId],
      );
      for (let i = 0; i < n; i++) {
        const att = newId();
        await c.query(
          `INSERT INTO public.attachments (id, location_id, file_id, role, created_by)
           VALUES ($1, $2, $3, 'photo', $4)`,
          [att, home.locationId, file, ibrahim.userId],
        );
        const id = newId();
        await c.query(
          `INSERT INTO public.extractions (id, location_id, attachment_id, mode, status,
                                           requested_by, created_at)
           VALUES ($1, $2, $3, 'thing', 'paused_budget', $4, now() - make_interval(mins => $5))`,
          [id, home.locationId, att, ibrahim.userId, n - i],
        );
        ids.push(id);
      }
    });
    return ids;
  }

  it('Resume now, after raising the cap, clears the pause and returns the paused work', async () => {
    const cap = (
      await own<{ id: string }>(
        `INSERT INTO public.ai_budgets (scope, owner_account_id, tokens_per_month, set_by)
         VALUES ('account', $1, 500, $2) RETURNING id`,
        [ibrahim.accountId, ibrahim.userId],
      )
    )[0]?.id as string;
    // A call estimated under the cap that came back over it: the cap is reached and paused.
    const ctx = accountPaid({ estimate_tokens: 100 });
    const r = await reserve(ibrahim.userId, ctx);
    await settle(ibrahim.userId, ctx, r, { tokens: 600 });
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(false);
    const paused = await pausedExtractions(2);
    expect(
      (await pgError(as(alfred, (c) => c.query(`SELECT * FROM kept.ai_resume($1, '{}')`, [cap]))))
        .code,
    ).toBe('42501');
    // Still over the cap: refused, stays paused.
    expect(
      (
        await pgError(
          as(ibrahim.userId, (c) => c.query(`SELECT * FROM kept.ai_resume($1, '{}')`, [cap])),
        )
      ).constraint,
    ).toBe('ai_cap_still_reached');
    const { rows } = await as(ibrahim.userId, (c) =>
      c.query(`SELECT * FROM kept.ai_resume($1, '{"tokens": 100000}')`, [cap]),
    );
    expect(rows.map((r) => r.extraction_id)).toEqual(paused);
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
  });

  it('a manual pause holds until resumed', async () => {
    const id = (
      await as(ibrahim.userId, (c) => c.query(`SELECT kept.ai_pause('{"scope": "account"}') AS id`))
    ).rows[0].id as string;
    expect(await reserve(ibrahim.userId, accountPaid())).toMatchObject({
      ok: false,
      reason: 'manual',
    });
    await as(ibrahim.userId, (c) => c.query(`SELECT * FROM kept.ai_resume($1, '{}')`, [id]));
    expect((await reserve(ibrahim.userId, accountPaid())).ok).toBe(true);
  });

  it('the rollover clears pauses whose time has passed, and only those', async () => {
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, tokens_per_month,
                                      paused_until, paused_reason, set_by)
       VALUES ('location', $1, $2, 5, now() - interval '1 minute', 'cap_tokens', $3),
              ('account', $1, NULL, 5, now() + interval '1 day', 'cap_tokens', $3)`,
      [ibrahim.accountId, home.locationId, ibrahim.userId],
    );
    await own(
      `INSERT INTO public.ai_budgets (scope, owner_account_id, task, tokens_per_day, paused_until,
                                      paused_reason, set_by)
       VALUES ('account', $1, 'extraction', 5, now() - interval '1 minute', 'tokens_day', $2)`,
      [ibrahim.accountId, ibrahim.userId],
    );
    const paused = await pausedExtractions(1);
    const { rows } = await asSystem((c) => c.query('SELECT * FROM kept.ai_rollover()'));
    expect(rows.map((r) => r.extraction_id)).toEqual(paused);
    expect(
      await own(
        `SELECT scope, task, paused_reason FROM public.ai_budgets ORDER BY scope, task NULLS FIRST`,
      ),
    ).toEqual([
      { scope: 'account', task: null, paused_reason: 'cap_tokens' },
      { scope: 'account', task: 'extraction', paused_reason: null },
      { scope: 'location', task: null, paused_reason: null },
    ]);
    expect(
      (await pgError(as(ibrahim.userId, (c) => c.query('SELECT * FROM kept.ai_rollover()')))).code,
    ).toBe('42501');
  });

  it('versions prices, keeps a settled call on its version, and recosts only unknown rows', async () => {
    const setPrice = (input: string) =>
      as(
        peter,
        async (c) =>
          (
            await c.query('SELECT kept.ai_price_set($1) AS id', [
              JSON.stringify({
                providerKind: 'groq',
                model: 'qwen/qwen3.8-27b',
                inputPerMtok: input,
                outputPerMtok: '0.6',
                currency: 'USD',
              }),
            ])
          ).rows[0].id as string,
      );
    const v1 = await setPrice('0.2');
    // A call costed with version 1, and one whose cost was unknown.
    const ctx = accountPaid();
    const priced = await reserve(ibrahim.userId, ctx);
    const pricedCall = await settle(
      ibrahim.userId,
      ctx,
      priced,
      { input_tokens: 1_000_000, output_tokens: 0 },
      { amount: '0.2', currency: 'USD', source: 'price_table', price_id: v1 },
    );
    const unknown = await reserve(ibrahim.userId, ctx);
    const unknownCall = await settle(ibrahim.userId, ctx, unknown, {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      reasoning_tokens: 500_000,
    });
    const v2 = await setPrice('0.4');
    expect(
      await own(
        `SELECT version, superseded_at IS NULL AS current FROM public.ai_model_prices ORDER BY version`,
      ),
    ).toEqual([
      { version: 1, current: false },
      { version: 2, current: true },
    ]);
    expect(
      (await pgError(as(ibrahim.userId, (c) => c.query(`SELECT kept.ai_price_set('{}')`)))).code,
    ).toBe('42501');
    const n = (
      await as(peter, (c) =>
        c.query(`SELECT kept.ai_recost_unknown('groq', 'qwen/qwen3.8-27b', '-infinity') AS n`),
      )
    ).rows[0].n;
    expect(n).toBe(1);
    const calls = await own<Record<string, unknown>>(
      'SELECT id, cost_amount, cost_source, price_id FROM public.llm_calls ORDER BY at, id',
    );
    expect(calls).toEqual([
      { id: pricedCall.call_id, cost_amount: '0.200000', cost_source: 'price_table', price_id: v1 },
      // 1M input × 0.4 + 0.5M output × 0.6 + 0.5M reasoning × 0.6 (no reasoning rate).
      {
        id: unknownCall.call_id,
        cost_amount: '1.000000',
        cost_source: 'price_table_later',
        price_id: v2,
      },
    ]);
    const [cost] = await own<{ amount: string }>(
      `SELECT amount FROM public.ai_cost_windows WHERE bucket = $1 AND currency = 'USD'`,
      [`account:${ibrahim.accountId}`],
    );
    expect(cost?.amount).toBe('1.200000');
  });

  it('ai_ensure_brand makes a member’s brand once, by its normalised name', async () => {
    expect(
      (
        await pgError(
          as(alfred, (c) =>
            c.query('INSERT INTO public.brands (owner_account_id, name) VALUES ($1, $2)', [
              ibrahim.accountId,
              'Bosch',
            ]),
          ),
        )
      ).code,
    ).toBe('42501');
    const ensure = (who: string, name: string) =>
      as(
        who,
        async (c) =>
          (await c.query('SELECT kept.ai_ensure_brand($1, $2) AS id', [home.locationId, name]))
            .rows[0].id as string,
      );
    const a = await ensure(alfred, 'Bosch');
    expect(await ensure(alfred, '  BOSCH ')).toBe(a);
    expect((await pgError(ensure(bruce, 'Makita'))).code).toBe('42501');
  });
});

describe('the ledger: who sees what (D206)', () => {
  beforeAll(household);

  let homeCall: string;
  let personalCall: string;
  let alfredCall: string;
  let instanceCall: string;

  beforeAll(async () => {
    const run = async (who: string, ctx: Ctx) => {
      const r = await reserve(who, ctx);
      return (await settle(who, ctx, r, { input_tokens: 10, output_tokens: 5 })).call_id;
    };
    homeCall = await run(ibrahim.userId, accountPaid());
    personalCall = await run(
      ibrahim.userId,
      accountPaid({ location_id: ibrahim.locationId, thing_id: newId() }),
    );
    alfredCall = await run(alfred, accountPaid({ user_id: alfred }));
    instanceCall = await run(
      talia.userId,
      accountPaid({
        paying_scope: 'instance',
        paying_account_id: null,
        provider_id: instanceKey,
        location_id: talia.locationId,
        owner_account_id: talia.accountId,
        user_id: talia.userId,
        extraction_id: newId(),
      }),
    );
  });

  const seen = (who: string) =>
    as(who, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM public.llm_calls ORDER BY id')).rows
        .map((r) => r.id)
        .sort(),
    );

  it('a member reads their own; an admin their location’s; the owner the account’s', async () => {
    expect(await seen(alfred)).toEqual([alfredCall]);
    expect(await seen(louis)).toEqual([homeCall, alfredCall].sort());
    expect(await seen(ibrahim.userId)).toEqual([homeCall, personalCall, alfredCall].sort());
    expect(await seen(bruce)).toEqual([]);
  });

  it('an instance admin reads no tenant row, only the instance calls without location detail', async () => {
    expect(await seen(peter)).toEqual([]);
    const { rows, fields } = await as(peter, (c) =>
      c.query(`SELECT * FROM kept.ai_instance_calls('{}', NULL)`),
    );
    expect(rows.map((r) => r.id)).toEqual([instanceCall]);
    const names = fields.map((f) => f.name);
    for (const hidden of [
      'location_id',
      'thing_id',
      'extraction_id',
      'thread_id',
      'attachment_ids',
    ])
      expect(names).not.toContain(hidden);
    expect(
      (
        await pgError(
          as(ibrahim.userId, (c) => c.query(`SELECT * FROM kept.ai_instance_calls('{}', NULL)`)),
        )
      ).code,
    ).toBe('42501');
  });

  it('ai_usage gives the same totals before and after the rollup drops a partition', async () => {
    // A month older than the retention, filled as kept_owner.
    await own(`SELECT kept.create_llm_partition('2024-01-01')`);
    await own(
      `INSERT INTO public.llm_calls (at, request_id, task, location_id, owner_account_id, user_id,
                                     paying_scope, paying_account_id, provider_kind, model, sent,
                                     input_tokens, output_tokens, image_count, outcome,
                                     cost_amount, cost_currency, cost_source)
       SELECT '2024-01-15'::timestamptz + make_interval(hours => g), 'old', 'extract_thing', $1,
              $2, $3, 'account', $2, 'groq', 'qwen/qwen3.8-27b', true, 100, 10, 1,
              CASE WHEN g = 1 THEN 'truncated' ELSE 'ok' END, 0.001, 'USD', 'provider'
         FROM generate_series(1, 3) g`,
      [home.locationId, ibrahim.accountId, ibrahim.userId],
    );
    const usage = () =>
      as(ibrahim.userId, (c) =>
        c.query(
          `SELECT key, calls, sent_calls, input_tokens, output_tokens, images, cost, cost_currency,
                  outcomes
             FROM kept.ai_usage('account', $1, '2024-01-01', '2024-02-01', 'task')`,
          [ibrahim.accountId],
        ),
      );
    const before = (await usage()).rows;
    expect(before).toEqual([
      {
        key: 'extract_thing',
        calls: 3,
        sent_calls: 3,
        input_tokens: '300',
        output_tokens: '30',
        images: 3,
        cost: '0.003000',
        cost_currency: 'USD',
        outcomes: { ok: 2, truncated: 1 },
      },
    ]);
    const dropped = await asSystem(
      async (c) => (await c.query('SELECT kept.ai_rollup_and_drop(13) AS n')).rows[0].n,
    );
    expect(dropped).toBe(1);
    expect(await own(`SELECT to_regclass('public.llm_calls_2024_01') AS r`)).toEqual([{ r: null }]);
    expect((await usage()).rows).toEqual(before);
    expect(
      (await pgError(as(ibrahim.userId, (c) => c.query('SELECT kept.ai_rollup_and_drop(13)'))))
        .code,
    ).toBe('42501');
  });
});
