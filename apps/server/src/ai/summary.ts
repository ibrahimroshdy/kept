import type pg from 'pg';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { Mailer } from '../mail/mailer.js';
import { aiSummaryChannels, insertNotice } from '../notify/notices.js';

// The AI monthly summary (product design §8a: "AI in September: 312 calls, 0.8M tokens, ≈ USD
// 1.12"; engineering spec §7.15 `ai.monthly_summary`, the 1st; plan Q35), never built in step 3.
// The `ai-summary` job runs early on the 1st (UTC, as the ledger's months) and, for last month,
// tells each person who paid for AI (an account owner for their account's key, or someone with a
// key of their own) what it came to: kept.ai_month_summaries() (0059), totals only.
//
// - On by default; Settings → Me → Notifications turns it off (aiSummaryChannels, Q35): `inapp`
//   off silences it entirely, else it lands in the centre (`ai_summary`, its payload the month,
//   calls and tokens: never money), and it is mailed while `email` is on too.
// - Once per person and month: instance_settings `ai_summary` records who has had this month's,
//   in the transaction that writes their notice, so a retried job sends nobody a second one. The
//   mail goes after that commit; a failed send is logged, never retried into a duplicate.

export const AI_SUMMARY_JOB = 'ai-summary';
const SETTING = 'ai_summary';

export type SummaryDeps = {
  pools: Pick<Pools, 'system'>;
  mailer: Mailer;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

type Row = {
  user_id: string;
  email: string;
  locale: string | null;
  calls: number;
  tokens: string;
  unknown_cost_calls: number;
  cost: { currency: string; amount: string | number }[];
};

/** The month before `now`'s, as YYYY-MM (UTC). */
export function lastMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** Marks `userId` as told of `month`; false when they already were. */
async function claim(client: pg.ClientBase, month: string, userId: string): Promise<boolean> {
  await client.query(
    `INSERT INTO public.instance_settings (key, value)
     VALUES ($1, jsonb_build_object('month', $2::text, 'users', '[]'::jsonb))
     ON CONFLICT (key) DO NOTHING`,
    [SETTING, month],
  );
  const { rows } = await client.query<{ value: { month?: string; users?: string[] } }>(
    'SELECT value FROM public.instance_settings WHERE key = $1 FOR UPDATE',
    [SETTING],
  );
  const v = rows[0]?.value ?? {};
  const users = v.month === month && Array.isArray(v.users) ? v.users : [];
  if (users.includes(userId)) return false;
  await client.query('UPDATE public.instance_settings SET value = $2::jsonb WHERE key = $1', [
    SETTING,
    JSON.stringify({ month, users: [...users, userId] }),
  ]);
  return true;
}

/** Sends last month's summaries. Returns how many people were told (centre or mail). */
export async function runAiSummary(deps: SummaryDeps, now: Date = new Date()): Promise<number> {
  const month = lastMonth(now);
  const rows = await withSystem(deps.pools.system, async (_tx, client) => {
    const r = await client.query<Row>(
      `SELECT user_id, email, locale, calls, tokens::text AS tokens, unknown_cost_calls, cost
         FROM kept.ai_month_summaries($1::date)`,
      [`${month}-01`],
    );
    return r.rows;
  });
  let told = 0;
  for (const r of rows) {
    const mail = await withSystem(deps.pools.system, async (_tx, client) => {
      if (!(await claim(client, month, r.user_id))) return false;
      const channels = await aiSummaryChannels(client, r.user_id);
      if (!channels.inapp) return false;
      await insertNotice(client, {
        userId: r.user_id,
        locationId: null,
        kind: 'ai_summary',
        payload: { month, calls: r.calls, tokens: r.tokens },
      });
      told += 1;
      return channels.email;
    });
    if (!mail || isUndeliverableEmail(r.email)) continue;
    try {
      await deps.mailer.send({
        kind: 'ai-summary',
        to: r.email,
        locale: r.locale,
        month,
        calls: r.calls,
        tokens: r.tokens,
        cost: r.cost.map((c) => ({ currency: c.currency, amount: String(c.amount) })),
        unknownCostCalls: r.unknown_cost_calls,
      });
    } catch (err) {
      deps.log.error({ err, userId: r.user_id, month }, 'AI summary mail failed');
    }
  }
  return told;
}
