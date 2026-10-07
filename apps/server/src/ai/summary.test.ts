import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from '../../test/db.js';
import { ownerTx, seedTenant, seedUser, type Tenant } from '../../test/tenancy.js';
import type { Mail } from '../mail/mailer.js';
import { lastMonth, runAiSummary } from './summary.js';

// The AI monthly summary (product design §8a; §7.15 `ai.monthly_summary`; Q35; 0059): last
// month's calls, tokens and cost for whoever paid, in the centre and by mail, once, and not at
// all for someone who turned it off.

const db = await testDb();
vi.setConfig({ testTimeout: 60_000 });

let ibrahim: Tenant; // an account owner whose account key paid
let louis: string; // paid with a key of his own
let alfred: Tenant; // paid nothing
let sent: Mail[];

const own = <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(sql, values)).rows);
const NOW = new Date('2026-10-01T00:30:00Z');
const deps = () => ({
  pools: db.pools,
  mailer: {
    send: async (m: Mail) => {
      sent.push(m);
    },
  },
  log: { info() {}, error() {} },
});

async function call(at: string, payer: { account?: string; user?: string }, cost: string | null) {
  await own(
    `INSERT INTO public.llm_calls (at, request_id, task, paying_scope, paying_account_id,
                                   paying_user_id, provider_kind, model, sent, input_tokens,
                                   output_tokens, outcome, cost_amount, cost_currency, cost_source)
     VALUES ($1, 'r', 'extract_thing', $2, $3, $4, 'groq', 'm', true, 1000, 200, 'ok', $5,
             CASE WHEN $5::numeric IS NULL THEN NULL ELSE 'USD' END,
             CASE WHEN $5::numeric IS NULL THEN 'unknown' ELSE 'provider' END)`,
    [at, payer.account ? 'account' : 'user', payer.account ?? null, payer.user ?? null, cost],
  );
}

beforeEach(async () => {
  await db.reset();
  sent = [];
  ibrahim = await seedTenant(db, 'sum-ibrahim');
  louis = await seedUser(db, 'sum-louis');
  alfred = await seedTenant(db, 'sum-alfred');
  await call('2026-09-02T10:00:00Z', { account: ibrahim.accountId }, '0.5');
  await call('2026-09-30T23:59:00Z', { account: ibrahim.accountId }, '0.62');
  await call('2026-09-15T08:00:00Z', { account: ibrahim.accountId }, null);
  // Outside September: not counted.
  await call('2026-08-31T23:59:00Z', { account: ibrahim.accountId }, '9');
  await call('2026-10-01T00:10:00Z', { account: ibrahim.accountId }, '9');
  await call('2026-09-10T12:00:00Z', { user: louis }, '0.01');
});

describe('the AI monthly summary', () => {
  it('counts last month in UTC', () => {
    expect(lastMonth(NOW)).toBe('2026-09');
    expect(lastMonth(new Date('2026-01-01T00:20:00Z'))).toBe('2025-12');
  });

  it('tells each payer their month once, in the centre and by mail, never money in the centre', async () => {
    expect(await runAiSummary(deps(), NOW)).toBe(2);
    const notices = await own<{ user_id: string; payload: Record<string, unknown> }>(
      `SELECT user_id, payload FROM public.notifications WHERE kind = 'ai_summary' ORDER BY user_id`,
    );
    expect(notices).toEqual(
      [
        { user_id: ibrahim.userId, payload: { month: '2026-09', calls: 3, tokens: '3600' } },
        { user_id: louis, payload: { month: '2026-09', calls: 1, tokens: '1200' } },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    const mine = sent.find((m) => m.kind === 'ai-summary' && m.calls === 3);
    expect(mine).toMatchObject({
      kind: 'ai-summary',
      month: '2026-09',
      tokens: '3600',
      cost: [{ currency: 'USD', amount: expect.stringMatching(/^1\.12/) }],
      unknownCostCalls: 1,
    });
    expect(sent.map((m) => m.to).some((to) => to.includes('sum-alfred'))).toBe(false);
    // A second run (a retried job) tells nobody again.
    expect(await runAiSummary(deps(), NOW)).toBe(0);
    expect(sent).toHaveLength(2);
    void alfred;
  });

  it('mails nobody who turned the mail off, and tells nobody who turned it off entirely', async () => {
    await own(
      `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
       VALUES ($1, NULL, 'ai_summary', 'email', false), ($2, NULL, 'ai_summary', 'inapp', false)`,
      [ibrahim.userId, louis],
    );
    expect(await runAiSummary(deps(), NOW)).toBe(1);
    expect(sent).toEqual([]);
    expect(await own(`SELECT user_id FROM public.notifications WHERE kind = 'ai_summary'`)).toEqual(
      [{ user_id: ibrahim.userId }],
    );
  });

  it("is kept_system's door alone", async () => {
    const { withScope } = await import('../db/scope.js');
    const refused = await withScope(db.pools.app, { userId: ibrahim.userId, mfa: true }, (_tx, c) =>
      c.query(`SELECT * FROM kept.ai_month_summaries('2026-09-01')`),
    ).catch((err: { code?: string }) => err.code);
    expect(refused).toBe('42501');
  });
});
