import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';

// The step-1 maintenance jobs (task 24): each is one call to a kept_system door (migrations
// 0005 and 0011), so kept_system never needs DDL or rights in schema auth.

/** Monthly audit partitions made ahead of time (§7.13): this month and the next three. */
export const AUDIT_MONTHS_AHEAD = 3;

/** `audit-partitions`: returns how many partitions it created (usually 0; 1 at a month's turn).
 * Fails by name (23514 audit_events_default_has_rows) when a month's rows already fell into the
 * default partition; the admin alert for that is task 25's. */
export async function ensureAuditPartitions(pools: Pick<Pools, 'system'>): Promise<number> {
  return withSystem(pools.system, async (_tx, client) => {
    const { rows } = await client.query<{ created: number }>(
      'SELECT kept.ensure_audit_partitions($1) AS created',
      [AUDIT_MONTHS_AHEAD],
    );
    return rows[0]?.created ?? 0;
  });
}

export type Pruned = Record<string, number>;

/** `prune-stale-rows`: expired sign-in limiter rows, the second-factor flags of expired
 * sessions, and idempotency keys past 30 days (§3.3). Returns the count removed per table. */
export async function pruneStaleRows(pools: Pick<Pools, 'system'>): Promise<Pruned> {
  return withSystem(pools.system, async (_tx, client) => {
    const { rows } = await client.query<{ what: string; removed: string }>(
      'SELECT what, removed FROM kept.prune_stale_rows()',
    );
    return Object.fromEntries(rows.map((r) => [r.what, Number(r.removed)]));
  });
}

/** The AI call ledger's retention (engineering spec §3.3, §3.5): `instance_settings`
 * `ai_ledger_months`, 3–60 months, 13 when unset or out of range. */
export const AI_LEDGER_MONTHS = { default: 13, min: 3, max: 60 } as const;
export const LLM_MONTHS_AHEAD = 3;

export type AiMaintenance = {
  partitionsCreated: number;
  partitionsRolledUp: number;
  keepMonths: number;
  pruned: Pruned;
};

/**
 * `ai-maintenance` (daily; step-3 T6, migration 0040): the AI call ledger's partitions made ahead
 * (this month and the next three), partitions older than the retention summed into
 * ai_usage_months and dropped (which also runs daily: a month's partition goes on the first run
 * after it passes the retention), and the pacing counters pruned (minute windows past 2 hours,
 * ended leases, cost windows past 13 months). No prompt or reply is ever stored, so there is
 * nothing else to prune (D206).
 */
export async function aiMaintenance(
  pools: Pick<Pools, 'system'>,
  now: Date = new Date(),
): Promise<AiMaintenance> {
  return withSystem(pools.system, async (_tx, client) => {
    const setting = await client.query<{ value: unknown }>(
      `SELECT value FROM public.instance_settings WHERE key = 'ai_ledger_months'`,
    );
    const raw = Number(setting.rows[0]?.value);
    const keepMonths =
      Number.isInteger(raw) && raw >= AI_LEDGER_MONTHS.min && raw <= AI_LEDGER_MONTHS.max
        ? raw
        : AI_LEDGER_MONTHS.default;
    const created = await client.query<{ n: number }>(
      'SELECT kept.ensure_llm_partitions($1) AS n',
      [LLM_MONTHS_AHEAD],
    );
    const rolled = await client.query<{ n: number }>('SELECT kept.ai_rollup_and_drop($1) AS n', [
      keepMonths,
    ]);
    const pruned = await client.query<{ what: string; removed: string }>(
      'SELECT what, removed FROM kept.prune_ai_windows($1)',
      [now],
    );
    return {
      partitionsCreated: created.rows[0]?.n ?? 0,
      partitionsRolledUp: rolled.rows[0]?.n ?? 0,
      keepMonths,
      pruned: Object.fromEntries(pruned.rows.map((r) => [r.what, Number(r.removed)])),
    };
  });
}
