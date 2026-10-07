import type { ReadingAdvice } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';

// A meter's usage estimate (step 5, T8; D52, D188; plan Q8), read from the one implementation in
// SQL, kept.meter_estimate() (0066): the rate over the 90 days before the latest accepted
// reading (two readings at least 7 days apart), offset-corrected by the meter's replacements,
// and the reading's age in the location's days with its advice (`fresh`, `stale` from 30 days,
// `unknown` from 60 with no rate). The function is an invoker: RLS decides which meters it sees,
// and one the caller can't see answers `none`, as a meter with no reading does. The screens, the
// vehicles list, the report, kept.schedule_next() and the reminder scan all read the same
// function, so they agree.

export type Estimate = {
  /** Units a day as a decimal string; null without a rate, and always null when `unknown`. */
  perDay: string | null;
  basisDays: number | null;
  /** Whole days since the latest reading; null with none. */
  ageDays: number | null;
  advice: ReadingAdvice;
};

export const EstimateSchema = z.object({
  perDay: z.string().nullable(),
  basisDays: z.number().nullable(),
  ageDays: z.number().nullable(),
  advice: z.enum(['none', 'fresh', 'stale', 'unknown']),
});

const NONE: Estimate = Object.freeze({
  perDay: null,
  basisDays: null,
  ageDays: null,
  advice: 'none',
});

/** Each meter's estimate, in one query (the thing page's meters, the snapshot's). */
export async function estimatesOf(
  client: pg.ClientBase,
  meterIds: readonly string[],
  now?: Date,
): Promise<Map<string, Estimate>> {
  const out = new Map<string, Estimate>();
  if (meterIds.length === 0) return out;
  const { rows } = await client.query<{
    id: string;
    per_day: string | null;
    basis_days: number | null;
    age_days: number | null;
    advice: ReadingAdvice | null;
  }>(
    `SELECT x.id, trim_scale(e.per_day)::text AS per_day, e.basis_days, e.age_days, e.advice
       FROM unnest($1::uuid[]) AS x(id)
       LEFT JOIN LATERAL kept.meter_estimate(x.id, coalesce($2::timestamptz, now())) e ON true`,
    [[...new Set(meterIds)], now ?? null],
  );
  for (const r of rows) {
    out.set(r.id, {
      perDay: r.per_day,
      basisDays: r.basis_days,
      ageDays: r.age_days,
      advice: r.advice ?? 'none',
    });
  }
  return out;
}

/** One meter's estimate (`none` when the caller can't see it). */
export async function estimateOf(
  client: pg.ClientBase,
  meterId: string,
  now?: Date,
): Promise<Estimate> {
  return (await estimatesOf(client, [meterId], now)).get(meterId) ?? NONE;
}
