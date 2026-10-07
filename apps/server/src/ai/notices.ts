/**
 * AI notices (plan T9; D166, D206; engineering spec §7.15 "Notices and alerts"):
 * - a monthly cap a call took past **80%** or **100%** (`kept.ai_settle` returns each crossing
 *   once per cap, level and month) mails whoever set it and the people it governs, and for the
 *   instance's caps also raises the admin alert `ai_instance_cap_warning` / `_reached`;
 * - an **instance key the provider rejects** (401/403, the breaker's `auth` trip) raises
 *   `ai_instance_key_rejected`, resolved when an admin saves a new instance key.
 *
 * Both go through the `ai-notice` system job, sent on kept_system's own transaction from the
 * runtime's hooks (`onCrossed`, `onKeyRejected`), so the mail never delays the call that crossed
 * and a failed send is retried (JOB_POLICIES). The job trusts nothing in its payload but ids: it
 * reads the cap, the recipients and the key's state through the SYS doors of 0043.
 *
 * Step 4 (plan T16, D206's "notification centre from step 4"): each person a cap notice mails
 * also gets an `ai_cap` notification in the centre (notify/notices.ts noticeAiCap).
 */
import type pg from 'pg';
import { raiseAlert, resolveAlert } from '../alerts/alerts.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { JobQueue } from '../jobs/queue.js';
import type { AiCapFacts, Mailer } from '../mail/mailer.js';
import { noticeAiCap } from '../notify/notices.js';
import { amount } from './api-kit.js';
import type { Crossed } from './ports.js';

export const AI_NOTICE_JOB = 'ai-notice';

export type AiNotice =
  | { kind: 'cap'; budgetId: string; level: 80 | 100; month: string }
  | { kind: 'key_rejected'; providerId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The provider's name as its own brand writes it (never translated). */
export const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  openai_compatible: 'The custom provider',
};

/** Sends an `ai-notice` job on a short kept_system transaction of its own. */
async function enqueue(pools: Pick<Pools, 'system'>, jobs: JobQueue, notice: AiNotice) {
  await withSystem(pools.system, (_tx, client) => jobs.send(client, AI_NOTICE_JOB, notice));
}

/**
 * The runtime hooks (ai/runtime.ts RuntimeOptions) that queue AI notices: for each cap a call
 * crossed, and for a key a provider rejected. A failure to queue is logged, never thrown: the
 * call it follows has settled and stands.
 */
export function aiNoticeHooks(
  pools: Pick<Pools, 'system'>,
  jobs: JobQueue | null,
  log?: { error: (obj: object, msg: string) => void },
): {
  onCrossed: (c: Crossed) => Promise<void>;
  onKeyRejected: (providerId: string) => Promise<void>;
} {
  const send = async (notice: AiNotice) => {
    if (!jobs) return;
    await enqueue(pools, jobs, notice).catch((err: unknown) =>
      log?.error({ err, notice: notice.kind }, 'AI notice not queued'),
    );
  };
  return {
    onCrossed: (c) => send({ kind: 'cap', budgetId: c.budgetId, level: c.level, month: c.month }),
    onKeyRejected: (providerId) => send({ kind: 'key_rejected', providerId }),
  };
}

type CapFactsRow = {
  scope: AiCapFacts['scope'];
  owner_account_id: string | null;
  tokens_per_month: string | null;
  monthly_cap_amount: string | null;
  cap_currency: string | null;
  paused_until: Date | number | null;
  used_tokens: string;
  used_amount: string | null;
  target_label: string | null;
};

/** The cap as the mail says it: in the unit that crossed (the higher share of the two). */
export function capFacts(r: CapFactsRow, level: 80 | 100): AiCapFacts {
  const tokenShare = r.tokens_per_month ? Number(r.used_tokens) / Number(r.tokens_per_month) : -1;
  const moneyShare =
    r.monthly_cap_amount && Number(r.monthly_cap_amount) > 0
      ? Number(r.used_amount ?? 0) / Number(r.monthly_cap_amount)
      : -1;
  const money = moneyShare >= tokenShare && moneyShare >= 0;
  const next = new Date();
  const firstOfNext = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1));
  const paused =
    r.paused_until instanceof Date && r.paused_until.getTime() < 8e15
      ? r.paused_until
      : firstOfNext;
  return {
    scope: r.scope,
    target: r.target_label ?? '',
    unit: money ? 'money' : 'tokens',
    used: money ? (amount(r.used_amount) ?? '0') : r.used_tokens,
    limit: money ? (amount(r.monthly_cap_amount) ?? '0') : (r.tokens_per_month ?? '0'),
    currency: money ? (r.cap_currency?.trim() ?? null) : null,
    pausedUntil: level === 100 ? paused.toISOString() : null,
  };
}

export type NoticeDeps = {
  pools: Pick<Pools, 'system'>;
  mailer: Mailer;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

function parse(data: unknown): AiNotice | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.kind === 'cap' && typeof d.budgetId === 'string' && UUID.test(d.budgetId)) {
    const level = d.level === 100 ? 100 : d.level === 80 ? 80 : null;
    if (level === null || typeof d.month !== 'string') return null;
    return { kind: 'cap', budgetId: d.budgetId, level, month: d.month };
  }
  if (d.kind === 'key_rejected' && typeof d.providerId === 'string' && UUID.test(d.providerId)) {
    return { kind: 'key_rejected', providerId: d.providerId };
  }
  return null;
}

/** The `ai-notice` job's work. Returns how many were told (mails sent, or 1 for an alert). */
export async function runAiNotice(deps: NoticeDeps, data: unknown): Promise<number> {
  const notice = parse(data);
  if (!notice) return 0;
  if (notice.kind === 'key_rejected') {
    const rows = await withSystem(deps.pools.system, async (_tx, client: pg.PoolClient) => {
      const r = await client.query<{
        scope: string;
        kind: string;
        active: boolean;
        rejected: boolean;
      }>('SELECT * FROM kept.ai_notice_provider($1)', [notice.providerId]);
      return r.rows;
    });
    const p = rows[0];
    // Only the instance's own key, still in use and still rejected now: the database's word.
    if (p?.scope !== 'instance' || !p.active || !p.rejected) return 0;
    await raiseAlert(deps, 'ai_instance_key_rejected', 'ai_instance_key_rejected', {
      provider: PROVIDER_NAMES[p.kind] ?? p.kind,
    });
    return 1;
  }

  const found = await withSystem(deps.pools.system, async (_tx, client: pg.PoolClient) => {
    const cap = await client.query<CapFactsRow>(
      `SELECT scope, owner_account_id, tokens_per_month::text AS tokens_per_month,
              monthly_cap_amount::text AS monthly_cap_amount, cap_currency, paused_until,
              used_tokens::text AS used_tokens, used_amount::text AS used_amount, target_label
         FROM kept.ai_notice_cap($1)`,
      [notice.budgetId],
    );
    const people = await client.query<{ user_id: string; email: string; locale: string | null }>(
      'SELECT user_id, email, locale FROM kept.ai_notice_recipients($1)',
      [notice.budgetId],
    );
    // Step 4 (T16, D206): the same people find it in the notification centre, once per cap,
    // level and month, whatever the mail does (a retry of this job writes nothing twice).
    const row = cap.rows[0];
    if (row) {
      await noticeAiCap(client, {
        budgetId: notice.budgetId,
        level: notice.level,
        month: notice.month,
        scope: row.scope,
        userIds: people.rows.map((p) => p.user_id),
      });
    }
    return { cap: row, people: people.rows };
  });
  if (!found.cap) return 0;
  const facts = capFacts(found.cap, notice.level);
  let told = 0;
  let failed = 0;
  for (const person of found.people) {
    if (isUndeliverableEmail(person.email)) continue;
    try {
      await deps.mailer.send({
        kind: 'ai-cap',
        to: person.email,
        locale: person.locale,
        level: notice.level,
        cap: facts,
      });
      told += 1;
    } catch (err) {
      failed += 1;
      deps.log.error({ err, budgetId: notice.budgetId }, 'AI cap notice mail failed');
    }
  }
  if (facts.scope === 'instance' || facts.scope === 'instance_account') {
    const kind = notice.level === 80 ? 'ai_instance_cap_warning' : 'ai_instance_cap_reached';
    await raiseAlert(deps, kind, `${kind}:${notice.budgetId}`, { ...facts, month: notice.month });
    told += 1;
  }
  // Nobody got it: fail, so pg-boss retries (a mail server briefly away).
  if (failed > 0 && told === 0) throw new Error('no AI cap notice was delivered');
  deps.log.info({ budgetId: notice.budgetId, level: notice.level, told }, 'AI cap notice sent');
  return told;
}

/** A new instance key ends the rejected-key alert. */
export function resolveKeyRejected(pools: Pick<Pools, 'system'>): Promise<boolean> {
  return resolveAlert(pools, 'ai_instance_key_rejected');
}

/** Resuming, raising or removing an instance cap ends its alerts for the month. */
export async function resolveCapAlerts(
  pools: Pick<Pools, 'system'>,
  budgetId: string,
): Promise<void> {
  await resolveAlert(pools, `ai_instance_cap_reached:${budgetId}`);
  await resolveAlert(pools, `ai_instance_cap_warning:${budgetId}`);
}

/**
 * `ai-rollover` (daily, 00:05 UTC; D188): day-budget pauses whose day has ended and cap pauses
 * whose month has turned are cleared (`kept.ai_rollover`), and the instance caps' alerts of the
 * past month are resolved on the 1st. The paused extractions it names were sent again by the
 * extract job itself for their pause's end (`startAfter`, T10); a manual pause waits for Resume.
 */
export async function aiRollover(deps: Pick<NoticeDeps, 'pools'>): Promise<number> {
  return withSystem(deps.pools.system, async (_tx, client) => {
    const { rows } = await client.query<{ extraction_id: string }>(
      'SELECT extraction_id FROM kept.ai_rollover()',
    );
    if (new Date().getUTCDate() === 1) {
      await client.query(
        `UPDATE public.admin_alerts SET resolved_at = now()
          WHERE kind IN ('ai_instance_cap_warning', 'ai_instance_cap_reached')
            AND resolved_at IS NULL AND first_at < date_trunc('month', now(), 'UTC')`,
      );
    }
    return rows.length;
  });
}
