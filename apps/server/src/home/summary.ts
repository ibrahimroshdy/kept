import type pg from 'pg';
import { z } from 'zod';
import { LISTED_SOURCES } from '../agenda/query.js';
import { LOW } from '../consumables/service.js';

// GET /api/v1/summary (1.x, D244; builds D59, D240): Home's "Needs you" counts per location, for
// what reads Kept from outside: the Home Assistant integration's sensors and dashboard widgets
// (Homepage, Glance, Homarr). One read-only call a personal token may make (tokens/access.ts).
//
// Every count uses the condition Home's attention row uses (home/service.ts; search's `state`
// filter), grouped by location, so each `totals` value equals GET /api/v1/home's `attention` for
// the same caller (home/summary.test.ts checks it):
// - overdue, due, expiring: the agenda view's rows of that state, low stock left out
//   (agenda/query.ts LISTED_SOURCES); the view already pauses a source whose module is off;
// - lentOut, borrowedIn: open loans on live things, null where Lending is off;
// - lowStock: things in use below their minimum, null where Consumables is off;
// - uncertain, longUnseen (the location's own months), unplaced;
// - things: the things in use, as a location card counts them.
// A null is "doesn't apply here", never zero; a total sums the locations where it applies.
//
// Read as the caller on kept_app: row-level security, intersected with a token's own locations,
// decides which locations appear and what is counted. No names of things, no money.

const Count = z.number().int();
const NullableCount = Count.nullable();

export const SummaryCounts = z.object({
  things: Count,
  unplaced: Count,
  overdue: Count,
  due: Count,
  expiring: Count,
  lentOut: NullableCount,
  borrowedIn: NullableCount,
  uncertain: Count,
  longUnseen: Count,
  lowStock: NullableCount,
});
export type SummaryCounts = z.infer<typeof SummaryCounts>;

export const SummaryResponse = z.object({
  asOf: z.string(),
  totals: SummaryCounts.extend({ lentOut: Count, borrowedIn: Count, lowStock: Count }),
  locations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.string(),
      timeZone: z.string(),
      counts: SummaryCounts,
    }),
  ),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;

type Row = {
  id: string;
  name: string;
  kind: string;
  timezone: string;
  lending: boolean;
  consumables: boolean;
  things: number;
  unplaced: number;
  uncertain: number;
  long_unseen: number;
  overdue: number;
  due: number;
  expiring: number;
  lent_out: number;
  borrowed_in: number;
  low_stock: number;
  as_of: Date;
};

/** GET /api/v1/summary for the caller (a session or a personal token). */
export async function summaryOf(client: pg.ClientBase): Promise<SummaryResponse> {
  const { rows } = await client.query<Row>(
    `WITH locs AS (
       SELECT l.id, l.name, l.kind, l.timezone, l.long_unseen_months,
              kept.module_on(l.id, 'lending') AS lending,
              kept.module_on(l.id, 'consumables') AS consumables
         FROM public.locations l
        WHERE l.id IN (SELECT kept.visible_location_ids())
     ),
     th AS (
       SELECT t.location_id,
              count(*) FILTER (WHERE t.lifecycle = 'in_use')::int AS things,
              count(*) FILTER (WHERE pl.is_unplaced)::int AS unplaced,
              count(*) FILTER (WHERE t.location_uncertain)::int AS uncertain,
              count(*) FILTER (WHERE t.lifecycle = 'in_use'
                AND t.last_seen_at < now() - make_interval(months => l.long_unseen_months))::int
                AS long_unseen
         FROM public.things t
         JOIN locs l ON l.id = t.location_id
         LEFT JOIN public.places pl ON pl.id = t.place_id
        WHERE t.deleted_at IS NULL
        GROUP BY t.location_id
     ),
     ag AS (
       SELECT a.location_id,
              count(*) FILTER (WHERE a.state = 'overdue')::int AS overdue,
              count(*) FILTER (WHERE a.state = 'due')::int AS due,
              count(*) FILTER (WHERE a.state = 'expiring')::int AS expiring
         FROM public.agenda_items a
        WHERE a.state IN ('overdue', 'due', 'expiring') AND a.source_type = ANY ($1::text[])
        GROUP BY a.location_id
     ),
     lo AS (
       SELECT o.location_id,
              count(*) FILTER (WHERE o.direction = 'out')::int AS lent_out,
              count(*) FILTER (WHERE o.direction = 'in')::int AS borrowed_in
         FROM public.loans o
         JOIN public.things t ON t.id = o.thing_id
        WHERE o.returned_at IS NULL AND t.deleted_at IS NULL
        GROUP BY o.location_id
     ),
     st AS (
       SELECT r.location_id, count(*)::int AS low_stock
         FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
        WHERE t.deleted_at IS NULL AND t.lifecycle = 'in_use' AND ${LOW}
        GROUP BY r.location_id
     )
     SELECT l.id, l.name, l.kind, l.timezone, l.lending, l.consumables,
            coalesce(th.things, 0) AS things, coalesce(th.unplaced, 0) AS unplaced,
            coalesce(th.uncertain, 0) AS uncertain, coalesce(th.long_unseen, 0) AS long_unseen,
            coalesce(ag.overdue, 0) AS overdue, coalesce(ag.due, 0) AS due,
            coalesce(ag.expiring, 0) AS expiring,
            coalesce(lo.lent_out, 0) AS lent_out, coalesce(lo.borrowed_in, 0) AS borrowed_in,
            coalesce(st.low_stock, 0) AS low_stock,
            now() AS as_of
       FROM locs l
       LEFT JOIN th ON th.location_id = l.id
       LEFT JOIN ag ON ag.location_id = l.id
       LEFT JOIN lo ON lo.location_id = l.id
       LEFT JOIN st ON st.location_id = l.id
      ORDER BY CASE WHEN l.kind = 'personal' THEN 0 ELSE 1 END, lower(l.name), l.id`,
    [LISTED_SOURCES],
  );

  const locations = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    timeZone: r.timezone,
    counts: {
      things: r.things,
      unplaced: r.unplaced,
      overdue: r.overdue,
      due: r.due,
      expiring: r.expiring,
      lentOut: r.lending ? r.lent_out : null,
      borrowedIn: r.lending ? r.borrowed_in : null,
      uncertain: r.uncertain,
      longUnseen: r.long_unseen,
      lowStock: r.consumables ? r.low_stock : null,
    },
  }));
  const sum = (key: keyof SummaryCounts) => locations.reduce((n, l) => n + (l.counts[key] ?? 0), 0);
  // `now()` is the transaction's start; with no location there is no row to carry it.
  const asOf = (rows[0]?.as_of ?? new Date()).toISOString();
  return {
    asOf,
    totals: {
      things: sum('things'),
      unplaced: sum('unplaced'),
      overdue: sum('overdue'),
      due: sum('due'),
      expiring: sum('expiring'),
      lentOut: sum('lentOut'),
      borrowedIn: sum('borrowedIn'),
      uncertain: sum('uncertain'),
      longUnseen: sum('longUnseen'),
      lowStock: sum('lowStock'),
    },
    locations,
  };
}
