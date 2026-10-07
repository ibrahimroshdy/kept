import { describe, expect, it } from 'vitest';
import { bucketsFor, capRow, InMemoryBudgetGate, InMemoryPacer } from './memory.js';
import type { ReserveRequest } from './ports.js';

const now = new Date('2026-09-26T12:00:00Z');
const req = (over: Partial<ReserveRequest> = {}): ReserveRequest => ({
  payer: { scope: 'account', accountId: 'acct-1', userId: null, fellBack: false },
  locationId: 'loc-1',
  ownerAccountId: 'acct-1',
  userId: 'user-1',
  budgetTask: 'extraction',
  estimateTokens: 1000,
  estimateCost: null,
  jobId: 'j',
  now,
  ...over,
});

describe('bucketsFor (§7.15)', () => {
  it('account-paid work in a location', () => {
    expect(bucketsFor(req())).toEqual([
      'account:acct-1',
      'account:acct-1:extraction',
      'location:loc-1',
      'member:acct-1:user-1',
    ]);
  });
  it('a personal key counts against user:, never the account', () => {
    expect(
      bucketsFor(
        req({ payer: { scope: 'user', accountId: null, userId: 'user-1', fellBack: false } }),
      ),
    ).toEqual(['location:loc-1', 'member:acct-1:user-1', 'user:user-1']);
  });
  it('the instance key counts against instance, instance:<task> and the account’s allowance', () => {
    expect(
      bucketsFor(
        req({
          payer: { scope: 'instance', accountId: null, userId: null, fellBack: true },
          locationId: null,
          userId: null,
        }),
      ),
    ).toEqual(['instance', 'instance:extraction', 'instance_account:acct-1']);
  });
});

describe('InMemoryBudgetGate (D206 caps)', () => {
  it('a location cap pauses that location only', async () => {
    const gate = new InMemoryBudgetGate([
      capRow({
        scope: 'location',
        ownerAccountId: 'acct-1',
        locationId: 'loc-1',
        tokensPerMonth: 500,
      }),
    ]);
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      kind: 'cap',
      bucket: 'location:loc-1',
    });
    expect((await gate.reserve(req({ locationId: 'loc-2' }))).ok).toBe(true);
  });

  it('a member cap pauses one person, not the household', async () => {
    const gate = new InMemoryBudgetGate([
      capRow({ scope: 'member', ownerAccountId: 'acct-1', userId: 'user-1', tokensPerMonth: 500 }),
    ]);
    expect(await gate.reserve(req())).toMatchObject({ ok: false, bucket: 'member:acct-1:user-1' });
    expect((await gate.reserve(req({ userId: 'user-2' }))).ok).toBe(true);
  });

  it('the per-account allowance on the instance key pauses one account, not another', async () => {
    const gate = new InMemoryBudgetGate([
      capRow({ scope: 'instance_account', ownerAccountId: 'acct-1', tokensPerMonth: 500 }),
    ]);
    const inst = { scope: 'instance' as const, accountId: null, userId: null, fellBack: true };
    expect(await gate.reserve(req({ payer: inst }))).toMatchObject({
      ok: false,
      bucket: 'instance_account:acct-1',
    });
    expect(
      (await gate.reserve(req({ payer: inst, ownerAccountId: 'acct-2', locationId: 'loc-9' }))).ok,
    ).toBe(true);
  });

  it('a money cap refuses when the estimate would pass it (same currency only)', async () => {
    const cap = () => [
      capRow({
        scope: 'account',
        ownerAccountId: 'acct-1',
        monthlyCapAmount: '0.01',
        capCurrency: 'USD',
      }),
    ];
    const gate = new InMemoryBudgetGate(cap());
    expect(
      await gate.reserve(req({ estimateCost: { amount: '0.02', currency: 'USD' } })),
    ).toMatchObject({ ok: false, reason: 'cap_money' });
    // Reaching the cap paused it until the 1st (§7.15's state machine).
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      reason: 'cap_money',
      until: new Date('2026-10-01T00:00:00Z'),
    });
    const other = new InMemoryBudgetGate(cap());
    expect((await other.reserve(req({ estimateCost: { amount: '5', currency: 'EGP' } }))).ok).toBe(
      true,
    );
  });

  it('the default per-task budget applies without a row (Q7): TPM is a wait, the day a pause', async () => {
    const gate = new InMemoryBudgetGate();
    expect(await gate.reserve(req({ estimateTokens: 60_001 }))).toMatchObject({
      ok: false,
      kind: 'wait',
      reason: 'tpm',
      until: new Date('2026-09-26T12:01:00Z'),
    });
    const day = new InMemoryBudgetGate([
      capRow({
        scope: 'account',
        ownerAccountId: 'acct-1',
        task: 'extraction',
        tokensPerDay: 1500,
      }),
    ]);
    expect((await day.reserve(req())).ok).toBe(true);
    expect(await day.reserve(req())).toMatchObject({
      ok: false,
      kind: 'cap',
      reason: 'tokens_day',
      until: new Date('2026-09-27T00:00:00Z'),
    });
  });

  it('a manual pause refuses everything under it', async () => {
    const gate = new InMemoryBudgetGate([
      capRow({
        scope: 'account',
        ownerAccountId: 'acct-1',
        pausedUntil: new Date(8.64e15),
        pausedReason: 'manual',
      }),
    ]);
    expect(await gate.reserve(req())).toMatchObject({ ok: false, kind: 'cap', reason: 'manual' });
  });

  it('settle trues up and crosses 80% and 100% once each per month', async () => {
    const cap = capRow({ scope: 'account', ownerAccountId: 'acct-1', tokensPerMonth: 10_000 });
    const gate = new InMemoryBudgetGate([cap]);
    const settle = async (tokens: number) => {
      const r = await gate.reserve(req({ estimateTokens: 1 }));
      if (!r.ok) throw new Error('refused');
      return gate.settle(r.reservation, { tokens, cost: null, callId: 'c', now });
    };
    expect(await settle(7000)).toEqual([]);
    expect(await settle(1500)).toEqual([
      { budgetId: cap.id, bucket: 'account:acct-1', level: 80, month: '2026-09-01' },
    ]);
    expect(await settle(100)).toEqual([]);
    expect(await settle(2000)).toEqual([
      { budgetId: cap.id, bucket: 'account:acct-1', level: 100, month: '2026-09-01' },
    ]);
    expect(cap.pausedReason).toBe('cap_tokens');
    expect(cap.pausedUntil).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('the payer has two slots; the third waits (concurrency)', async () => {
    const gate = new InMemoryBudgetGate();
    expect((await gate.reserve(req())).ok).toBe(true);
    expect((await gate.reserve(req())).ok).toBe(true);
    expect(await gate.reserve(req())).toMatchObject({
      ok: false,
      kind: 'wait',
      reason: 'concurrency',
    });
  });
});

describe('InMemoryPacer', () => {
  it('one slot per Groq key, two otherwise', async () => {
    const pacer = new InMemoryPacer();
    expect((await pacer.admit({ id: 'g', kind: 'groq' }, 1, 'a', now)).ok).toBe(true);
    expect(await pacer.admit({ id: 'g', kind: 'groq' }, 1, 'b', now)).toMatchObject({
      ok: false,
      reason: 'concurrency',
    });
    expect((await pacer.admit({ id: 'o', kind: 'openai' }, 1, 'a', now)).ok).toBe(true);
    expect((await pacer.admit({ id: 'o', kind: 'openai' }, 1, 'b', now)).ok).toBe(true);
  });

  it('clearAuth lifts a rejected key', async () => {
    const pacer = new InMemoryPacer();
    await pacer.observe(
      { id: 'g', kind: 'groq' },
      { headers: undefined, signal: { kind: 'auth' } },
      now,
    );
    expect(await pacer.admit({ id: 'g', kind: 'groq' }, 1, 'a', now)).toMatchObject({
      ok: false,
      reason: 'auth',
    });
    await pacer.clearAuth('g');
    expect((await pacer.admit({ id: 'g', kind: 'groq' }, 1, 'a', now)).ok).toBe(true);
  });
});
