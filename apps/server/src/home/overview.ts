import type pg from 'pg';
import { z } from 'zod';
import { LISTED_SOURCES } from '../agenda/query.js';
import type { Scope, Tx } from '../db/scope.js';
import { Sums, spending } from '../insights/service.js';
import { type Gate, gateFor } from '../serialize/gates.js';

// Home's overview (1.6, D240; builds D138, D194, D234; screens spec §5 Home): what the redesigned
// Home shows beyond `GET /api/v1/home`, in one read that only Home makes. `/home` stays the
// shell's (the sidebar's Inbox badge reads it on every page), so nothing here slows other pages.
//
// - **Location cards:** each location's places (live, Unplaced left out), its flags (overdue,
//   due and expiring from the agenda; lent out where Lending is on; uncertain; low stock where
//   Consumables is on), and its value where Money is on and shows to the caller: each live thing
//   in use (not a draft) at its newest valuation, per currency, as Insights' Value by place adds
//   it up (D158: no valuation, no value). Money on but hidden from the caller (D13): no amount and
//   no count of valued things, only `moneyHidden: true`.
// - **Needs you's tiles:** the most urgent item of each, for the desktop tile's second line:
//   the earliest due agenda item per state (the agenda's own order, so it is the first row of
//   the list the tile opens); the most overdue open loan, else the oldest, out and in; the most
//   recently flagged uncertain thing; the longest unseen; the lowest stock against its minimum.
// - **The Insights teaser** (D234), only where Money is on: this year's spending so far and the
//   three full years before it, and the value of what you own, both per currency and never
//   converted, summed only over the locations whose gate shows money, exactly as Insights sums
//   them (insights/service.ts `spending`). It names the locations it leaves out: Money off, or
//   money hidden from the caller. Null when no location shows the caller money, or when nothing
//   in them was bought or valued yet.
//
// Read as the caller on kept_app, so row-level security decides every count. The agenda view is
// read once (the counts and the top rows share one materialised CTE; at 10,000 things a read of
// it is most of Home's cost, docs/perf/2026-09-30-step4.md).

/** Full years of spending the teaser shows before this one. */
export const TEASER_YEARS = 3;

const Id = z.uuid();
const AmountSchema = z.object({ currency: z.string(), amount: z.string() });
const Counts = z.object({
  overdue: z.number().int(),
  due: z.number().int(),
  expiring: z.number().int(),
  lentOut: z.number().int(),
  uncertain: z.number().int(),
  lowStock: z.number().int(),
});
const Value = z.object({
  things: z.number().int(),
  valued: z.number().int(),
  byCurrency: z.array(AmountSchema),
});
/** One item a tile names. `name` is the thing's or place's name, or the reminder's title. */
const Top = z.object({
  name: z.string().nullable(),
  locationId: Id,
  dueOn: z.string().nullable().optional(),
  person: z.string().nullable().optional(),
  quantity: z.string().optional(),
  minimum: z.string().optional(),
  lastSeenAt: z.string().optional(),
});
export type OverviewTop = z.infer<typeof Top>;

export const HomeOverview = z.object({
  locations: z.array(
    z.object({
      id: Id,
      places: z.number().int(),
      flags: Counts,
      value: Value.optional(),
      moneyHidden: z.literal(true).optional(),
    }),
  ),
  top: z.object({
    overdue: Top.optional(),
    due: Top.optional(),
    expiring: Top.optional(),
    lentOut: Top.optional(),
    borrowedIn: Top.optional(),
    uncertain: Top.optional(),
    longUnseen: Top.optional(),
    lowStock: Top.optional(),
  }),
  insights: z
    .object({
      thisYear: z.number().int(),
      years: z.array(
        z.object({ year: z.number().int(), soFar: z.boolean(), byCurrency: z.array(AmountSchema) }),
      ),
      value: Value,
      /** The locations whose amounts are in the figures. */
      included: z.array(Id),
      /** Money is on there, but its amounts are hidden from the caller (D13). */
      hiddenIn: z.array(Id),
      /** Money is off there (D113: Insights is part of Money). */
      moneyOff: z.array(Id),
    })
    .nullable(),
});
export type HomeOverview = z.infer<typeof HomeOverview>;

type Loc = { id: string; this_year: number; gate: Gate };
type Flags = z.infer<typeof Counts>;
const noFlags = (): Flags => ({
  overdue: 0,
  due: 0,
  expiring: 0,
  lentOut: 0,
  uncertain: 0,
  lowStock: 0,
});

async function locationsOf(tx: Tx, client: pg.ClientBase, scope: Scope): Promise<Loc[]> {
  const { rows } = await client.query<{ id: string; this_year: number }>(
    `SELECT l.id, extract(year FROM now() AT TIME ZONE l.timezone)::int AS this_year
       FROM public.locations l
      WHERE l.id IN (SELECT kept.visible_location_ids()) AND l.deleted_at IS NULL
      ORDER BY CASE WHEN l.kind = 'personal' THEN 0 ELSE 1 END, lower(l.name), l.id`,
  );
  const out: Loc[] = [];
  for (const r of rows) out.push({ ...r, gate: await gateFor(tx, r.id, scope) });
  return out;
}

type AgendaTop = {
  state: 'overdue' | 'due' | 'expiring';
  location_id: string;
  due_on: string | null;
  name: string | null;
  person: string | null;
};

/** The agenda's counts per location and state, and the first row of each state, in one read. */
async function agenda(client: pg.ClientBase) {
  const { rows } = await client.query<{
    counts: { location_id: string; state: string; n: number }[];
    top: AgendaTop[];
  }>(
    `WITH a AS MATERIALIZED (
       SELECT a.location_id, a.state, a.source_type, a.source_id, a.kind, a.due_period,
              a.due_on, a.thing_id, a.place_id, a.title
         FROM public.agenda_items a
        WHERE a.state IN ('overdue', 'due', 'expiring') AND a.source_type = ANY ($1::text[])),
     first AS (
       SELECT DISTINCT ON (a.state) a.*
         FROM a
        ORDER BY a.state, coalesce(a.due_on::text, '9999-12-31') COLLATE "C",
                 (a.source_type || ':' || a.source_id || ':' || a.kind || ':' || a.due_period)
                   COLLATE "C")
     SELECT
       (SELECT coalesce(json_agg(c), '[]'::json) FROM (
          SELECT location_id, state, count(*)::int AS n FROM a GROUP BY location_id, state) c)
         AS counts,
       (SELECT coalesce(json_agg(json_build_object(
          'state', f.state, 'location_id', f.location_id, 'due_on', f.due_on::text,
          'name', CASE f.source_type
                    WHEN 'warranty' THEN coalesce(f.title, w.kind)
                    WHEN 'registration' THEN coalesce(f.title, w.kind)
                    WHEN 'document' THEN coalesce(f.title, d.kind)
                    WHEN 'loan' THEN t.name
                    WHEN 'thing_expiry' THEN t.name
                    ELSE coalesce(f.title, t.name, p.name) END,
          'person', pe.display_name)), '[]'::json)
          FROM first f
          LEFT JOIN public.warranties w
            ON f.source_type IN ('warranty', 'registration') AND w.id = f.source_id
          LEFT JOIN public.expiring_documents d ON f.source_type = 'document' AND d.id = f.source_id
          LEFT JOIN public.things t ON t.id = f.thing_id
          LEFT JOIN public.places p ON p.id = f.place_id
          LEFT JOIN public.loans o ON f.source_type = 'loan' AND o.id = f.source_id
          LEFT JOIN public.people pe ON pe.id = o.person_id) AS top`,
    [LISTED_SOURCES],
  );
  return rows[0] ?? { counts: [], top: [] };
}

type LoanTop = {
  direction: 'out' | 'in';
  location_id: string;
  name: string | null;
  person: string | null;
  due_on: string | null;
};

/** Open loans on live things where Lending is on: lent out per location, and the most urgent
 * loan each way (overdue first, by due date, then the oldest). */
async function loans(client: pg.ClientBase) {
  const { rows } = await client.query<{
    counts: { location_id: string; n: number }[];
    top: LoanTop[];
  }>(
    `WITH o AS MATERIALIZED (
       SELECT o.id, o.location_id, o.direction, o.due_on, o.started_at, o.person_id, t.name
         FROM public.loans o
         JOIN public.things t ON t.id = o.thing_id
        WHERE o.returned_at IS NULL AND t.deleted_at IS NULL
          AND kept.module_on(o.location_id, 'lending'))
     SELECT
       (SELECT coalesce(json_agg(c), '[]'::json) FROM (
          SELECT location_id, count(*)::int AS n FROM o WHERE direction = 'out'
           GROUP BY location_id) c) AS counts,
       (SELECT coalesce(json_agg(json_build_object(
          'direction', f.direction, 'location_id', f.location_id, 'name', f.name,
          'person', pe.display_name, 'due_on', f.due_on::text)), '[]'::json)
          FROM (SELECT DISTINCT ON (o.direction) o.*
                  FROM o ORDER BY o.direction, o.due_on NULLS LAST, o.started_at, o.id) f
          LEFT JOIN public.people pe ON pe.id = f.person_id) AS top`,
  );
  return rows[0] ?? { counts: [], top: [] };
}

/** Uncertain things per location, and the most recently flagged one and the longest unseen. */
async function things(client: pg.ClientBase) {
  const { rows } = await client.query<{
    counts: { location_id: string; n: number }[];
    uncertain: { location_id: string; name: string | null } | null;
    unseen: { location_id: string; name: string | null; last_seen_at: string } | null;
  }>(
    `SELECT
       (SELECT coalesce(json_agg(c), '[]'::json) FROM (
          SELECT t.location_id, count(*)::int AS n FROM public.things t
           WHERE t.deleted_at IS NULL AND t.location_uncertain GROUP BY t.location_id) c)
         AS counts,
       (SELECT json_build_object('location_id', t.location_id, 'name', t.name)
          FROM public.things t
         WHERE t.deleted_at IS NULL AND t.location_uncertain
         ORDER BY t.updated_at DESC, t.id LIMIT 1) AS uncertain,
       (SELECT json_build_object('location_id', t.location_id, 'name', t.name,
                                 'last_seen_at', t.last_seen_at)
          FROM public.things t JOIN public.locations l ON l.id = t.location_id
         WHERE t.deleted_at IS NULL AND t.lifecycle = 'in_use'
           AND t.last_seen_at < now() - make_interval(months => l.long_unseen_months)
         ORDER BY t.last_seen_at, t.id LIMIT 1) AS unseen`,
  );
  return rows[0] ?? { counts: [], uncertain: null, unseen: null };
}

/** Things below their "keep at least" where Consumables is on (GET /consumables?state=low): per
 * location, and the lowest against its minimum. */
async function lowStock(client: pg.ClientBase) {
  const { rows } = await client.query<{
    counts: { location_id: string; n: number }[];
    top: { location_id: string; name: string | null; quantity: string; minimum: string } | null;
  }>(
    `WITH low AS MATERIALIZED (
       SELECT r.location_id, t.id, t.name, t.quantity, r.min_quantity
         FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
        WHERE t.deleted_at IS NULL AND t.lifecycle = 'in_use' AND t.quantity < r.min_quantity
          AND kept.module_on(r.location_id, 'consumables'))
     SELECT
       (SELECT coalesce(json_agg(c), '[]'::json) FROM (
          SELECT location_id, count(*)::int AS n FROM low GROUP BY location_id) c) AS counts,
       (SELECT json_build_object('location_id', l.location_id, 'name', l.name,
                                 'quantity', trim_scale(l.quantity)::text,
                                 'minimum', trim_scale(l.min_quantity)::text)
          FROM low l
         ORDER BY l.quantity / nullif(l.min_quantity, 0), l.name, l.id LIMIT 1) AS top`,
  );
  return rows[0] ?? { counts: [], top: null };
}

/** Live places per location, Unplaced left out. */
async function places(client: pg.ClientBase, ids: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await client.query<{ location_id: string; n: number }>(
    `SELECT p.location_id, count(*)::int AS n FROM public.places p
      WHERE p.location_id = ANY ($1::uuid[]) AND p.deleted_at IS NULL AND NOT p.is_unplaced
      GROUP BY p.location_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.location_id, r.n]));
}

type ValueAcc = { things: number; valued: number; sums: Sums };

/** Each live thing in use (not a draft) at its newest valuation, per location and currency, in
 * the locations given (those whose gate shows money). Things are reached the way Insights reaches
 * them: by their place, or through the containers they sit in. */
async function values(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, ValueAcc>> {
  const out = new Map<string, ValueAcc>();
  for (const id of ids) out.set(id, { things: 0, valued: 0, sums: new Sums() });
  if (ids.length === 0) return out;
  const { rows } = await client.query<{
    location_id: string;
    currency: string | null;
    things: number;
    valued: number;
    amount: string | null;
  }>(
    `WITH RECURSIVE
     tp AS (
       SELECT t.id FROM public.things t
        WHERE t.location_id = ANY ($1::uuid[]) AND t.place_id IS NOT NULL AND t.deleted_at IS NULL
       UNION ALL
       SELECT t.id FROM public.things t JOIN tp ON t.container_id = tp.id
        WHERE t.deleted_at IS NULL),
     cv AS (
       SELECT DISTINCT ON (v.thing_id) v.thing_id, v.value, v.currency::text AS currency
         FROM public.valuations v
        WHERE v.location_id = ANY ($1::uuid[])
        ORDER BY v.thing_id, v.valued_on DESC, v.created_at DESC, v.id DESC)
     SELECT t.location_id, cv.currency, count(*)::int AS things,
            count(cv.thing_id)::int AS valued, trim_scale(round(sum(cv.value), 4))::text AS amount
       FROM public.things t
       JOIN tp ON tp.id = t.id
       LEFT JOIN cv ON cv.thing_id = t.id
      WHERE t.lifecycle = 'in_use' AND t.review_state <> 'draft'
      GROUP BY t.location_id, cv.currency`,
    [ids],
  );
  for (const r of rows) {
    const acc = out.get(r.location_id);
    if (!acc) continue;
    acc.things += r.things;
    acc.valued += r.valued;
    acc.sums.add(r.currency, r.amount);
  }
  return out;
}

const per = (rows: readonly { location_id: string; n: number }[]) =>
  new Map(rows.map((r) => [r.location_id, r.n]));

/** GET /api/v1/home/overview for the signed-in user. */
export async function homeOverviewOf(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
): Promise<HomeOverview> {
  const locs = await locationsOf(tx, client, scope);
  const ids = locs.map((l) => l.id);
  const withMoney = locs.filter((l) => l.gate.modules.has('money'));
  const shown = withMoney.filter((l) => l.gate.showMoney);

  const a = await agenda(client);
  const o = await loans(client);
  const t = await things(client);
  const s = await lowStock(client);
  const placeCounts = await places(client, ids);
  const value = await values(
    client,
    shown.map((l) => l.id),
  );

  const flags = new Map<string, Flags>(ids.map((id) => [id, noFlags()]));
  for (const c of a.counts) {
    const f = flags.get(c.location_id);
    if (f && (c.state === 'overdue' || c.state === 'due' || c.state === 'expiring'))
      f[c.state] = c.n;
  }
  const lent = per(o.counts);
  const uncertain = per(t.counts);
  const low = per(s.counts);
  for (const [id, f] of flags) {
    f.lentOut = lent.get(id) ?? 0;
    f.uncertain = uncertain.get(id) ?? 0;
    f.lowStock = low.get(id) ?? 0;
  }

  const top: HomeOverview['top'] = {};
  for (const r of a.top) {
    top[r.state] = { name: r.name, locationId: r.location_id, dueOn: r.due_on, person: r.person };
  }
  for (const r of o.top) {
    top[r.direction === 'out' ? 'lentOut' : 'borrowedIn'] = {
      name: r.name,
      locationId: r.location_id,
      dueOn: r.due_on,
      person: r.person,
    };
  }
  if (t.uncertain) top.uncertain = { name: t.uncertain.name, locationId: t.uncertain.location_id };
  if (t.unseen) {
    top.longUnseen = {
      name: t.unseen.name,
      locationId: t.unseen.location_id,
      lastSeenAt: new Date(t.unseen.last_seen_at).toISOString(),
    };
  }
  if (s.top) {
    top.lowStock = {
      name: s.top.name,
      locationId: s.top.location_id,
      quantity: s.top.quantity,
      minimum: s.top.minimum,
    };
  }

  const shownIds = new Set(shown.map((l) => l.id));
  const moneyOn = new Set(withMoney.map((l) => l.id));
  const valueView = (acc: ValueAcc) => ({
    things: acc.things,
    valued: acc.valued,
    byCurrency: acc.sums.list(),
  });

  let insights: HomeOverview['insights'] = null;
  if (shown.length > 0) {
    const thisYear = Math.max(...shown.map((l) => l.this_year));
    const spent = await spending(client, shown, thisYear, TEASER_YEARS);
    const total: ValueAcc = { things: 0, valued: 0, sums: new Sums() };
    for (const acc of value.values()) {
      total.things += acc.things;
      total.valued += acc.valued;
      total.sums.merge(acc.sums);
    }
    // Nothing bought or valued yet: nothing to tease (day one, or Money on in an empty location).
    const anything = total.sums.by.size > 0 || spent.years.some((y) => y.byCurrency.length > 0);
    if (anything) {
      insights = {
        thisYear,
        years: spent.years.map((y) => ({ year: y.year, soFar: y.soFar, byCurrency: y.byCurrency })),
        value: valueView(total),
        included: [...shownIds],
        hiddenIn: withMoney.filter((l) => !l.gate.showMoney).map((l) => l.id),
        moneyOff: ids.filter((id) => !moneyOn.has(id)),
      };
    }
  }

  return {
    locations: locs.map((l) => {
      const acc = value.get(l.id);
      return {
        id: l.id,
        places: placeCounts.get(l.id) ?? 0,
        flags: flags.get(l.id) ?? noFlags(),
        ...(acc ? { value: valueView(acc) } : {}),
        ...(moneyOn.has(l.id) && !shownIds.has(l.id) ? { moneyHidden: true as const } : {}),
      };
    }),
    top,
    insights,
  };
}
