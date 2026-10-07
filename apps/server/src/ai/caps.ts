/**
 * Monthly caps and per-task budgets (plan T9; D19, D167, D206; engineering spec §3.5, §7.15):
 * one `ai_budgets` row each, read under its SELECT policy and written only through the doors
 * (`kept.ai_cap_set`, `ai_cap_clear`, `ai_pause`, `ai_resume`), which check the caller and the
 * account-cap rule themselves (42501 → 404 for a scope you don't manage; P0001
 * `cap_above_account` → 400). A cap's month so far comes from `kept.ai_cap_usage` (0043): the
 * counters the reserve door pauses on, never a guess.
 */
import { AI_TASKS, suggestedCap } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { notFound } from '../http/errors.js';
import { amount, Currency, Decimal, isoTime, MoneySchema, type Who } from './api-kit.js';

export const CapScope = z.enum([
  'instance',
  'instance_account',
  'account',
  'location',
  'member',
  'user',
]);
export type CapScope = z.infer<typeof CapScope>;
export const AiScope = z.enum(['me', 'location', 'account', 'instance']);
export type AiScope = z.infer<typeof AiScope>;

const CurrencyAmount = z.object({ currency: z.string(), amount: z.string() });

export const CapSchema = z.object({
  id: z.uuid(),
  scope: CapScope,
  target: z.object({ id: z.string().nullable(), label: z.string() }),
  task: z.enum(AI_TASKS).nullable(),
  tokensPerMinute: z.number().optional(),
  tokensPerDay: z.number().optional(),
  tokensPerMonth: z.number().optional(),
  monthlyCap: MoneySchema.optional(),
  used: z.object({
    tokens: z.number(),
    cost: z.array(CurrencyAmount),
    unknownCostCalls: z.number(),
    /** Currencies spent this month that a money cap can't count: no exchange rate to its
     * currency (D76, never estimated). Empty for a token cap. */
    notCounted: z.array(z.string()),
  }),
  percent: z.number().nullable(),
  state: z.enum(['active', 'warned', 'paused']),
  pausedUntil: z.string().optional(),
  reason: z.enum(['manual', 'cap_money', 'cap_tokens', 'tokens_day']).optional(),
  cappedByAccount: z.boolean(),
  rowVersion: z.number(),
  canEdit: z.boolean(),
});
export type CapView = z.infer<typeof CapSchema>;

export const SuggestedSchema = z.object({
  monthlyCap: MoneySchema.optional(),
  tokensPerMonth: z.number().optional(),
});

/** PUT /api/v1/ai/caps: the whole cap (a field left out is cleared). */
export const PutCapBody = z.object({
  scope: CapScope,
  accountId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  userId: z.uuid().optional(),
  task: z.enum(AI_TASKS).optional(),
  monthlyCap: z.object({ amount: Decimal, currency: Currency }).nullable().optional(),
  tokensPerMonth: z.number().int().positive().max(1e12).optional(),
  tokensPerDay: z.number().int().positive().max(2e9).optional(),
  tokensPerMinute: z.number().int().positive().max(2e9).optional(),
});
export type PutCapBody = z.infer<typeof PutCapBody>;

export const PauseBody = z.object({
  scope: CapScope,
  accountId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

export const ResumeBody = z.object({
  raiseTo: z
    .union([
      z.object({ amount: Decimal, currency: Currency }),
      z.object({ tokens: z.number().int().positive().max(1e12) }),
    ])
    .optional(),
  remove: z.literal(true).optional(),
});

export type CapRow = {
  id: string;
  scope: CapScope;
  owner_account_id: string | null;
  location_id: string | null;
  user_id: string | null;
  task: (typeof AI_TASKS)[number] | null;
  tokens_per_minute: number | null;
  tokens_per_day: number | null;
  tokens_per_month: string | null;
  monthly_cap_amount: string | null;
  cap_currency: string | null;
  paused_until: Date | number | null;
  paused_reason: CapView['reason'] | null;
  warned_80_month: string | null;
  row_version: number;
  target_label: string | null;
};

const CAP_COLUMNS = `b.id, b.scope, b.owner_account_id, b.location_id, b.user_id, b.task,
  b.tokens_per_minute, b.tokens_per_day, b.tokens_per_month::text AS tokens_per_month,
  b.monthly_cap_amount::text AS monthly_cap_amount, b.cap_currency::text AS cap_currency,
  b.paused_until, b.paused_reason, to_char(b.warned_80_month, 'YYYY-MM-DD') AS warned_80_month,
  b.row_version,
  CASE b.scope
    WHEN 'location' THEN (SELECT l.name FROM public.locations l WHERE l.id = b.location_id)
    WHEN 'member' THEN (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = b.user_id)
    WHEN 'user' THEN (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = b.user_id)
    WHEN 'account' THEN (SELECT p.display_name FROM public.owner_accounts oa
                           JOIN public.user_profiles p ON p.user_id = oa.user_id
                          WHERE oa.id = b.owner_account_id)
    ELSE NULL END AS target_label`;

/** The cap rows a scope shows, under ai_budgets' SELECT policy (§7.15 "Who reads"). */
export async function capRows(
  client: pg.ClientBase,
  who: Who,
  scope: AiScope,
  locationId: string | null,
): Promise<CapRow[]> {
  let where: string;
  let args: unknown[];
  switch (scope) {
    case 'instance':
      if (!who.instanceAdmin) throw notFound();
      where = `b.scope IN ('instance', 'instance_account')`;
      args = [];
      break;
    case 'me':
      where = `b.scope IN ('user', 'member') AND b.user_id = $1`;
      args = [who.userId];
      break;
    case 'location': {
      if (!locationId) throw notFound();
      const { rows } = await client.query<{ acct: string }>(
        'SELECT owner_account_id AS acct FROM public.locations WHERE id = $1',
        [locationId],
      );
      if (!rows[0]) throw notFound();
      where = `((b.scope = 'location' AND b.location_id = $1)
                OR (b.scope = 'member' AND b.user_id = $2 AND b.owner_account_id = $3))`;
      args = [locationId, who.userId, rows[0].acct];
      break;
    }
    case 'account':
      if (!who.accountId) throw notFound();
      where = `b.scope IN ('account', 'location', 'member') AND b.owner_account_id = $1`;
      args = [who.accountId];
      break;
  }
  const { rows } = await client.query<CapRow>(
    `SELECT ${CAP_COLUMNS} FROM public.ai_budgets b WHERE ${where}
      ORDER BY CASE b.scope WHEN 'instance' THEN 1 WHEN 'instance_account' THEN 2
                            WHEN 'account' THEN 3 WHEN 'location' THEN 4 WHEN 'member' THEN 5
                            ELSE 6 END, b.task NULLS FIRST, b.id`,
    args,
  );
  return rows;
}

/** One cap row the caller may read, or 404. */
export async function capRow(client: pg.ClientBase, id: string): Promise<CapRow> {
  const { rows } = await client.query<CapRow>(
    `SELECT ${CAP_COLUMNS} FROM public.ai_budgets b WHERE b.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

type Usage = {
  budget_id: string;
  tokens: string;
  cost: { currency: string; amount: string | number }[];
  unknown_cost_calls: number;
  /** The month in the cap's currency, others counted through the account's rates (0049). */
  spent: string | null;
  not_counted: string[];
};

/** Whether the caller writes a cap row (§7.15 "Who writes"; kept.ai_budget_writable's rule). */
export function canEditCap(r: Pick<CapRow, 'scope' | 'owner_account_id' | 'user_id'>, who: Who) {
  switch (r.scope) {
    case 'instance':
    case 'instance_account':
      return who.instanceAdmin;
    case 'user':
      return r.user_id === who.userId;
    default:
      return !!who.accountId && r.owner_account_id === who.accountId;
  }
}

const THIS_MONTH = () => new Date().toISOString().slice(0, 7);

/** The caps as the web contract has them, with their month so far. */
export async function capViews(
  client: pg.ClientBase,
  who: Who,
  rows: CapRow[],
): Promise<CapView[]> {
  if (rows.length === 0) return [];
  const { rows: usage } = await client.query<Usage>(
    `SELECT budget_id, tokens::text AS tokens, cost, unknown_cost_calls, spent::text AS spent,
            not_counted
       FROM kept.ai_cap_usage($1)`,
    [rows.map((r) => r.id)],
  );
  const byId = new Map(usage.map((u) => [u.budget_id, u]));
  const accountCaps = new Map(
    rows
      .filter((r) => r.scope === 'account' && r.task === null)
      .map((r) => [r.owner_account_id, r]),
  );
  const now = Date.now();
  return rows.map((r) => {
    const u = byId.get(r.id);
    const tokens = Number(u?.tokens ?? 0);
    const cost = (u?.cost ?? []).map((c) => ({
      currency: c.currency.trim(),
      amount: amount(String(c.amount)) ?? '0',
    }));
    let percent: number | null = null;
    if (r.tokens_per_month) percent = (tokens * 100) / Number(r.tokens_per_month);
    if (r.monthly_cap_amount && Number(r.monthly_cap_amount) > 0) {
      // Other currencies count through the account's exchange rates (kept.ai_spent, 0049).
      const spent = Number(u?.spent ?? 0);
      percent = Math.max(percent ?? 0, (spent * 100) / Number(r.monthly_cap_amount));
    }
    const pausedUntil = isoTime(r.paused_until);
    const paused =
      pausedUntil !== null && (pausedUntil === 'infinity' || new Date(pausedUntil).getTime() > now);
    const warned = r.warned_80_month?.slice(0, 7) === THIS_MONTH();
    const account = r.scope === 'location' ? accountCaps.get(r.owner_account_id) : undefined;
    const cappedByAccount =
      !!account &&
      ((!!account.tokens_per_month &&
        !!r.tokens_per_month &&
        Number(account.tokens_per_month) < Number(r.tokens_per_month)) ||
        (!!account.monthly_cap_amount &&
          !!r.monthly_cap_amount &&
          account.cap_currency === r.cap_currency &&
          Number(account.monthly_cap_amount) < Number(r.monthly_cap_amount)));
    const view: CapView = {
      id: r.id,
      scope: r.scope,
      target: {
        id:
          r.scope === 'location'
            ? r.location_id
            : r.scope === 'member' || r.scope === 'user'
              ? r.user_id
              : r.owner_account_id,
        label: r.target_label ?? '',
      },
      task: r.task,
      used: {
        tokens,
        cost,
        unknownCostCalls: u?.unknown_cost_calls ?? 0,
        notCounted: u?.not_counted ?? [],
      },
      percent: percent === null ? null : Math.floor(percent),
      state: paused ? 'paused' : warned ? 'warned' : 'active',
      cappedByAccount,
      rowVersion: r.row_version,
      canEdit: canEditCap(r, who),
    };
    if (r.tokens_per_minute) view.tokensPerMinute = r.tokens_per_minute;
    if (r.tokens_per_day) view.tokensPerDay = r.tokens_per_day;
    if (r.tokens_per_month) view.tokensPerMonth = Number(r.tokens_per_month);
    if (r.monthly_cap_amount && r.cap_currency) {
      view.monthlyCap = {
        amount: amount(r.monthly_cap_amount) ?? '0',
        currency: r.cap_currency.trim(),
      };
    }
    if (paused && pausedUntil) view.pausedUntil = pausedUntil;
    if (paused && r.paused_reason) view.reason = r.paused_reason;
    return view;
  });
}

/** The cap AI setup suggests while a scope has none (§3.5): money in the price's currency when
 * the scope's model has a price, else tokens. */
export function suggestion(
  price: { currency: string } | null,
  projectedMonth: string | null,
): z.infer<typeof SuggestedSchema> {
  return suggestedCap({ projectedMonth, currency: price?.currency ?? null });
}

/** The door's scope fields for a PUT, pause or the target of a cap. */
export function capTarget(b: {
  scope: CapScope;
  accountId?: string | undefined;
  locationId?: string | undefined;
  userId?: string | undefined;
  task?: string | undefined;
}) {
  return {
    scope: b.scope,
    ...(b.accountId ? { accountId: b.accountId.toLowerCase() } : {}),
    ...(b.locationId ? { locationId: b.locationId.toLowerCase() } : {}),
    ...(b.userId ? { userId: b.userId.toLowerCase() } : {}),
    ...(b.task ? { task: b.task } : {}),
  };
}

/** The existing row a PUT names, found by its key fields under the caller's policy. */
export async function existingCap(
  client: pg.ClientBase,
  who: Who,
  b: PutCapBody,
): Promise<CapRow | null> {
  const acct =
    b.scope === 'location'
      ? null
      : b.scope === 'instance'
        ? null
        : b.scope === 'user'
          ? null
          : (b.accountId?.toLowerCase() ?? (b.scope === 'instance_account' ? null : who.accountId));
  const user =
    b.scope === 'member' || b.scope === 'user' ? (b.userId?.toLowerCase() ?? who.userId) : null;
  const { rows } = await client.query<CapRow>(
    `SELECT ${CAP_COLUMNS} FROM public.ai_budgets b
      WHERE b.scope = $1 AND b.task IS NOT DISTINCT FROM $2
        AND ($1 = 'location' OR b.owner_account_id IS NOT DISTINCT FROM $3)
        AND b.location_id IS NOT DISTINCT FROM $4 AND b.user_id IS NOT DISTINCT FROM $5`,
    [b.scope, b.task ?? null, acct, b.locationId?.toLowerCase() ?? null, user],
  );
  return rows[0] ?? null;
}

/** A cap row as the audit keeps it (no labels). */
export function capAudit(r: CapRow | null): Record<string, unknown> | null {
  if (!r) return null;
  return {
    scope: r.scope,
    owner_account_id: r.owner_account_id,
    location_id: r.location_id,
    user_id: r.user_id,
    task: r.task,
    tokens_per_minute: r.tokens_per_minute,
    tokens_per_day: r.tokens_per_day,
    tokens_per_month: r.tokens_per_month,
    monthly_cap_amount: amount(r.monthly_cap_amount),
    cap_currency: r.cap_currency?.trim() ?? null,
    paused_reason: r.paused_reason,
  };
}
