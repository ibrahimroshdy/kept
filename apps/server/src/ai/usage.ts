/**
 * Usage per scope and "What uses AI in Kept" (plan T9; D188, D206; engineering spec §3.5, §7.15).
 * Totals come from `kept.ai_usage` (the ledger plus the monthly totals of rolled-up months, with
 * §7.15's visibility: `me`, a location's admins, an account's owner, instance admins per account
 * only), one row per group and currency, merged here into one group with a cost per currency.
 */
import {
  type BudgetTask,
  budgetTaskOf,
  LEDGER_OUTCOMES,
  type LedgerOutcome,
  type LedgerTask,
  REFERENCE_FIGURES,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { notFound } from '../http/errors.js';
import { amount, type Who } from './api-kit.js';
import type { AiScope } from './caps.js';
import { costOf, fromMicro, type Price, toMicro } from './cost.js';

const CurrencyAmount = z.object({ currency: z.string(), amount: z.string() });
const TokenCounts = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cached: z.number(),
});
const Totals = z.object({
  calls: z.number(),
  sentCalls: z.number(),
  tokens: TokenCounts,
  images: z.number(),
  cost: z.array(CurrencyAmount),
  unknownCostCalls: z.number(),
  outcomes: z.partialRecord(z.enum(LEDGER_OUTCOMES), z.number()),
  tasks: z
    .partialRecord(
      z.enum(['extraction', 'assistant', 'embeddings', 'test']),
      z.object({ calls: z.number(), tokens: z.number() }),
    )
    .optional(),
});
export const UsageGroupSchema = Totals.extend({ key: z.string(), label: z.string() });
export type UsageGroup = z.infer<typeof UsageGroupSchema>;
export type UsageTotals = z.infer<typeof Totals>;

export const GroupBy = z.enum(['day', 'task', 'model', 'person', 'location', 'account']);
export type GroupBy = z.infer<typeof GroupBy>;

type UsageRow = {
  key: string;
  label: string | null;
  calls: number;
  sent_calls: number;
  input_tokens: string;
  output_tokens: string;
  reasoning_tokens: string;
  cached_tokens: string;
  images: number;
  cost: string | null;
  cost_currency: string | null;
  unknown_cost_calls: number;
  outcomes: Record<string, number>;
};

/** The door's scope id: the location, the caller's own account, or nothing. */
export function scopeId(who: Who, scope: AiScope, locationId: string | null): string | null {
  if (scope === 'location') {
    if (!locationId) throw notFound();
    return locationId;
  }
  if (scope === 'account') {
    if (!who.accountId) throw notFound();
    return who.accountId;
  }
  return null;
}

export async function usageRows(
  client: pg.ClientBase,
  scope: AiScope,
  id: string | null,
  from: Date,
  to: Date,
  group: GroupBy,
): Promise<UsageRow[]> {
  const { rows } = await client.query<UsageRow>(
    `SELECT key, label, calls, sent_calls, input_tokens::text, output_tokens::text,
            reasoning_tokens::text, cached_tokens::text, images, cost::text AS cost,
            cost_currency::text AS cost_currency, unknown_cost_calls, outcomes
       FROM kept.ai_usage($1, $2, $3, $4, $5)`,
    [scope, id, from, to, group],
  );
  return rows;
}

const empty = (): UsageTotals => ({
  calls: 0,
  sentCalls: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0 },
  images: 0,
  cost: [],
  unknownCostCalls: 0,
  outcomes: {},
});

function add(into: UsageTotals, r: UsageRow | UsageTotals): void {
  if ('sent_calls' in r) {
    into.calls += r.calls;
    into.sentCalls += r.sent_calls;
    into.tokens.input += Number(r.input_tokens);
    into.tokens.output += Number(r.output_tokens);
    into.tokens.reasoning += Number(r.reasoning_tokens);
    into.tokens.cached += Number(r.cached_tokens);
    into.images += r.images;
    into.unknownCostCalls += r.unknown_cost_calls;
    for (const [k, v] of Object.entries(r.outcomes ?? {})) {
      const o = k as LedgerOutcome;
      into.outcomes[o] = (into.outcomes[o] ?? 0) + Number(v);
    }
    if (r.cost !== null && r.cost_currency) addCost(into, r.cost_currency.trim(), r.cost);
    return;
  }
  into.calls += r.calls;
  into.sentCalls += r.sentCalls;
  into.tokens.input += r.tokens.input;
  into.tokens.output += r.tokens.output;
  into.tokens.reasoning += r.tokens.reasoning;
  into.tokens.cached += r.tokens.cached;
  into.images += r.images;
  into.unknownCostCalls += r.unknownCostCalls;
  for (const [k, v] of Object.entries(r.outcomes)) {
    const o = k as LedgerOutcome;
    into.outcomes[o] = (into.outcomes[o] ?? 0) + (v ?? 0);
  }
  for (const c of r.cost) addCost(into, c.currency, c.amount);
}

/** Money added in micro-units, so sums of 6-decimal amounts stay exact. */
function addCost(into: UsageTotals, currency: string, value: string): void {
  const had = into.cost.find((c) => c.currency === currency);
  const next = fromMicro((had ? toMicro(had.amount) : 0n) + toMicro(value));
  if (had) had.amount = next;
  else into.cost.push({ currency, amount: next });
}

/** The door's rows merged per group (one row per group and currency), in the door's order. */
export function mergeGroups(rows: UsageRow[], group: GroupBy): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of rows) {
    let g = groups.get(r.key);
    if (!g) {
      g = { key: r.key, label: labelOf(r, group), ...empty() };
      groups.set(r.key, g);
    }
    add(g, r);
  }
  return [...groups.values()];
}

function labelOf(r: UsageRow, group: GroupBy): string {
  if (r.label) return r.label;
  if (group === 'model') return r.key.slice(r.key.indexOf(':') + 1);
  if (group === 'location' || group === 'account') return r.key === 'none' ? '' : '';
  return r.key;
}

export function totalsOf(groups: UsageGroup[]): UsageTotals {
  const t = empty();
  for (const g of groups) add(t, g);
  return t;
}

/** Calls and tokens per budget task and UTC day, for the day chart's stacks (web contract
 * `AiUsageGroup.tasks`). Read from the ledger under its policy with kept.ai_usage's scope rule;
 * the instance scope has no row access, so it gets none. */
export async function dayTasks(
  client: pg.ClientBase,
  who: Who,
  scope: AiScope,
  id: string | null,
  from: Date,
  to: Date,
): Promise<Map<string, Partial<Record<BudgetTask, { calls: number; tokens: number }>>>> {
  const out = new Map<string, Partial<Record<BudgetTask, { calls: number; tokens: number }>>>();
  if (scope === 'instance') return out;
  const cond =
    scope === 'me'
      ? 'c.user_id = $3'
      : scope === 'location'
        ? 'c.location_id = $3'
        : '(c.owner_account_id = $3 OR c.paying_account_id = $3)';
  const { rows } = await client.query<{ day: string; task: LedgerTask; n: number; t: string }>(
    `SELECT to_char(c.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, c.task, count(*)::int AS n,
            sum(coalesce(c.input_tokens, 0) + coalesce(c.output_tokens, 0))::text AS t
       FROM public.llm_calls c
      WHERE c.at >= $1 AND c.at < $2 AND ${cond}
      GROUP BY 1, 2`,
    [from, to, scope === 'me' ? who.userId : id],
  );
  for (const r of rows) {
    const day = out.get(r.day) ?? {};
    const k = budgetTaskOf(r.task);
    const e = day[k] ?? { calls: 0, tokens: 0 };
    e.calls += r.n;
    e.tokens += Number(r.t);
    day[k] = e;
    out.set(r.day, day);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// "What uses AI in Kept"
// ---------------------------------------------------------------------------------------------

/** The actions the panel lists, in the screens' order (§5 AI settings). */
export const EXPLAIN_TASKS: LedgerTask[] = [
  'extract_thing',
  'extract_receipt',
  'extract_label',
  'extract_reading',
  'assistant_turn',
  'embed_query',
  'connection_test',
];
/** A scope's own figures replace the reference ones from this many calls of a task (§3.5). */
export const HISTORY_MIN_CALLS = 5;

export const ExplainSchema = z.object({
  actions: z.array(
    z.object({
      task: z.string(),
      callsPerAction: z.number(),
      tokensTypical: z.number(),
      costTypical: CurrencyAmount.optional(),
      basis: z.enum(['history', 'reference']),
      referenceDate: z.string().optional(),
    }),
  ),
  projection: z.object({
    days: z.number(),
    calls: z.number(),
    tokens: z.number(),
    cost: z.array(CurrencyAmount),
    unknownCostCalls: z.number(),
  }),
});
export type Explain = z.infer<typeof ExplainSchema>;

/** The panel: per task, the scope's last 30 days once it has ≥ 5 sent calls of the task, else
 * the dated reference figures (costed only with a current price for the scope's model: no price,
 * no cost); and the 30 days' calls, tokens and cost per currency. */
export function explainFrom(rows: UsageRow[], price: Price | null): Explain {
  const byTask = new Map<string, UsageRow[]>();
  for (const r of rows) byTask.set(r.key, [...(byTask.get(r.key) ?? []), r]);
  const actions = EXPLAIN_TASKS.map((task) => {
    const mine = byTask.get(task) ?? [];
    const sent = mine.reduce((n, r) => n + r.sent_calls, 0);
    const perAction = task === 'connection_test' ? 2 : 1;
    if (sent >= HISTORY_MIN_CALLS) {
      const tokens = mine.reduce((n, r) => n + Number(r.input_tokens) + Number(r.output_tokens), 0);
      const priced = mine
        .filter((r) => r.cost !== null && r.cost_currency)
        .sort((a, b) => b.sent_calls - a.sent_calls)[0];
      const pricedCalls = priced ? priced.sent_calls - priced.unknown_cost_calls : 0;
      return {
        task,
        callsPerAction: perAction,
        tokensTypical: Math.round(tokens / sent),
        ...(priced && pricedCalls > 0
          ? {
              costTypical: {
                currency: (priced.cost_currency ?? '').trim(),
                amount: amount((Number(priced.cost) / pricedCalls).toFixed(6)) ?? '0',
              },
            }
          : {}),
        basis: 'history' as const,
      };
    }
    const f = REFERENCE_FIGURES.tasks[task as keyof typeof REFERENCE_FIGURES.tasks];
    const cost =
      f && price
        ? costOf({
            providerCost: null,
            price,
            usage: {
              inputTokens: f.inputTokens,
              outputTokens: f.outputTokens,
              reasoningTokens: f.reasoningTokens,
              cachedInputTokens: 0,
            },
            imageCount: task === 'connection_test' || task.startsWith('extract_') ? 1 : 0,
          })
        : null;
    return {
      task,
      callsPerAction: perAction,
      tokensTypical: f ? f.inputTokens + f.outputTokens : 0,
      ...(cost?.amount && cost.currency
        ? { costTypical: { currency: cost.currency, amount: amount(cost.amount) ?? '0' } }
        : {}),
      basis: 'reference' as const,
      referenceDate: REFERENCE_FIGURES.asOf,
    };
  });
  const t = totalsOf(mergeGroups(rows, 'task'));
  return {
    actions,
    projection: {
      days: 30,
      calls: t.calls,
      tokens: t.tokens.input + t.tokens.output,
      cost: t.cost,
      unknownCostCalls: t.unknownCostCalls,
    },
  };
}
