import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { type Gate, gateFor } from '../serialize/gates.js';

// Insights (1.x, D234; builds D39 item 8, D54, D113, D158; screens §1): what was spent on things
// each year, what they are worth per place and per location, what the vehicles cost month by
// month, and how much is under warranty. One read, global across the caller's locations with Money
// on (Insights is part of Money, D113), narrowed by `f.location` (the location chip, D174).
//
// - Read as the caller on kept_app: row-level security decides which rows exist.
// - Money leaves only through each location's gate (serialize/gates.ts, D13): an amount is summed
//   in SQL only over the locations whose gate shows money (`FILTER (WHERE shown)`), so a hidden
//   location's amounts are never in memory. Counts that say nothing about money (purchases,
//   things, fills, services, warranties) count every location; counts that would say whether an
//   amount exists (unpriced purchases, valued things) count only where money shows. Each section
//   names the locations it left out (`hiddenIn`), and a per-location or per-vehicle row whose
//   amounts are withheld carries `moneyHidden: true`, whether or not there was an amount.
// - Per currency, never added across currencies and never converted (D76, Q22): the account's
//   exchange rates convert only in the insurance report, which asks for a report currency.
// - The current year and month are "so far" (D188): returned apart, never in the full periods.
// - Vehicles only where Vehicles is on, warranties only where Warranties & claims is on (D113).
// - Aggregated in SQL over existing indexes (purchases_location_date_idx, valuations_thing_idx,
//   fuel_entries_thing_idx, service_records_thing_idx, expiring_documents_thing_idx,
//   warranties_thing_idx, things_place_idx/things_container_idx), with the lists capped.

export type Amount = { currency: string; amount: string };
export type CostAmounts = {
  currency: string;
  fuel: string;
  service: string;
  fees: string;
  total: string;
};

export type InsightsQuery = { 'f.location'?: string[] | undefined };

export type Insights = {
  locations: Array<{ id: string; money: boolean; vehicles: boolean; warranties: boolean }>;
  thisYear: number;
  spending: {
    years: Array<{
      year: number;
      soFar: boolean;
      purchases: number;
      /** Purchases with neither a total nor a priced line, where money shows. */
      unpriced: number;
      byCurrency: Amount[];
    }>;
    hiddenIn: string[];
  };
  value: {
    locations: Array<{
      locationId: string;
      things: number;
      valued?: number;
      byCurrency?: Amount[];
      moneyHidden?: true;
      places: Array<{
        /** Null for the folded rest (`others` places) and for things whose place is gone. */
        id: string | null;
        shortCode: string | null;
        name: string | null;
        unplaced: boolean;
        others?: number;
        things: number;
        valued?: number;
        byCurrency?: Amount[];
      }>;
    }>;
    hiddenIn: string[];
  };
  vehicles: {
    thisMonth: string;
    months: Array<{ month: string; byCurrency: CostAmounts[] }>;
    items: Array<{
      id: string;
      shortCode: string | null;
      name: string | null;
      locationId: string;
      ended: boolean;
      years: Array<{
        year: number;
        soFar: boolean;
        fills: number;
        services: number;
        byCurrency?: CostAmounts[];
      }>;
      moneyHidden?: true;
    }>;
    more: number;
    hiddenIn: string[];
  } | null;
  warranties: {
    things: number;
    covered: number;
    expiring: number;
    ended: number;
    none: number;
    expiringSoon: Array<{
      id: string;
      shortCode: string | null;
      name: string | null;
      locationId: string;
      endsOn: string;
    }>;
    repairs: Array<{
      year: number;
      soFar: boolean;
      resolved: number;
      byCurrency?: Array<{ currency: string; cost: string; covered: string }>;
    }>;
    hiddenIn: string[];
  } | null;
};

/** Full years of spending shown before this one. */
export const SPENDING_YEARS = 10;
/** Full months of vehicle costs. */
export const VEHICLE_MONTHS = 12;
/** Places listed per location; the rest fold into one row. */
export const MAX_PLACES = 30;
/** Vehicles listed; every vehicle still counts in the months. */
export const MAX_VEHICLES = 50;
/** Warranties ending soon, listed. */
export const MAX_EXPIRING = 10;

// Money as whole ten-thousandths (numeric(16,4); SQL rounds to 4 places first), added exactly.
const SCALE = 10_000n;
export const toUnits = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(whole) * SCALE + BigInt(frac.padEnd(4, '0').slice(0, 4));
  return neg ? -n : n;
};
export const fromUnits = (n: bigint): string => {
  const frac = (n % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return `${n / SCALE}${frac ? `.${frac}` : ''}`;
};

/** Per-currency sums, in insertion order then sorted by currency code. */
class Sums {
  readonly by = new Map<string, bigint>();
  add(currency: string | null, amount: string | null): void {
    if (!currency || amount === null) return;
    this.by.set(currency, (this.by.get(currency) ?? 0n) + toUnits(amount));
  }
  merge(other: Sums): void {
    for (const [c, n] of other.by) this.by.set(c, (this.by.get(c) ?? 0n) + n);
  }
  list(): Amount[] {
    return [...this.by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, n]) => ({ currency, amount: fromUnits(n) }));
  }
}

type CostKey = 'fuel' | 'service' | 'fees';
class CostSums {
  readonly by = new Map<string, Record<CostKey, bigint>>();
  add(currency: string | null, key: CostKey, amount: string | null): void {
    if (!currency || amount === null) return;
    const row = this.by.get(currency) ?? { fuel: 0n, service: 0n, fees: 0n };
    row[key] += toUnits(amount);
    this.by.set(currency, row);
  }
  list(): CostAmounts[] {
    return [...this.by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, r]) => ({
        currency,
        fuel: fromUnits(r.fuel),
        service: fromUnits(r.service),
        fees: fromUnits(r.fees),
        total: fromUnits(r.fuel + r.service + r.fees),
      }));
  }
}

/** YYYY-MM `offset` months from `month`. */
export function addMonths(month: string, offset: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

type LocRow = { id: string; this_year: number; this_month: string };
type InScope = LocRow & { gate: Gate };

/** The caller's visible, live locations with Money on, narrowed to `filter` when it has ids. */
async function locationsInScope(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  filter: string[] | undefined,
): Promise<InScope[]> {
  const ids = filter?.length ? filter.map((v) => v.toLowerCase()) : null;
  const { rows } = await client.query<LocRow>(
    `SELECT l.id, extract(year FROM now() AT TIME ZONE l.timezone)::int AS this_year,
            to_char(now() AT TIME ZONE l.timezone, 'YYYY-MM') AS this_month
       FROM public.locations l
      WHERE l.id IN (SELECT kept.visible_location_ids()) AND l.deleted_at IS NULL
        AND ($1::uuid[] IS NULL OR l.id = ANY ($1::uuid[]))
      ORDER BY l.created_at, l.id`,
    [ids],
  );
  const out: InScope[] = [];
  for (const r of rows) {
    const gate = await gateFor(tx, r.id, scope);
    if (gate.modules.has('money')) out.push({ ...r, gate });
  }
  return out;
}

const shownOf = (locs: readonly InScope[]) => locs.filter((l) => l.gate.showMoney).map((l) => l.id);
const hiddenOf = (locs: readonly InScope[]) =>
  locs.filter((l) => !l.gate.showMoney).map((l) => l.id);

const SHORT_CODE = (col: string, alias: string) =>
  `(SELECT s.code FROM public.short_ids s
     WHERE s.${col} = ${alias}.id AND s.is_primary AND s.state = 'assigned' LIMIT 1)`;

// ---------------------------------------------------------------------------------------------
// Spending per year: confirmed purchases by their date. A purchase's amount is its total, else
// the sum of its priced lines (quantity × unit price); one with neither is "unpriced".
// ---------------------------------------------------------------------------------------------

async function spending(
  client: pg.ClientBase,
  locs: readonly InScope[],
  thisYear: number,
): Promise<Insights['spending']> {
  const from = thisYear - SPENDING_YEARS;
  const { rows } = await client.query<{
    year: number;
    currency: string | null;
    purchases: number;
    unpriced: number;
    amount: string | null;
  }>(
    `WITH p AS (
       SELECT extract(year FROM p.purchased_on)::int AS year, p.currency::text AS currency,
              p.location_id = ANY ($2::uuid[]) AS shown,
              coalesce(p.total,
                       (SELECT sum(pl.quantity * pl.unit_price) FROM public.purchase_lines pl
                         WHERE pl.purchase_id = p.id AND pl.unit_price IS NOT NULL)) AS amount
         FROM public.purchases p
        WHERE p.location_id = ANY ($1::uuid[]) AND p.review_state = 'confirmed'
          AND p.purchased_on BETWEEN make_date($3, 1, 1) AND make_date($4, 12, 31))
     SELECT year, CASE WHEN shown THEN currency END AS currency, count(*)::int AS purchases,
            count(*) FILTER (WHERE shown AND amount IS NULL)::int AS unpriced,
            trim_scale(round(sum(amount) FILTER (WHERE shown), 4))::text AS amount
       FROM p
      GROUP BY year, CASE WHEN shown THEN currency END`,
    [locs.map((l) => l.id), shownOf(locs), from, thisYear],
  );
  const byYear = new Map<number, { purchases: number; unpriced: number; sums: Sums }>();
  for (const r of rows) {
    const y = byYear.get(r.year) ?? { purchases: 0, unpriced: 0, sums: new Sums() };
    y.purchases += r.purchases;
    y.unpriced += r.unpriced;
    y.sums.add(r.currency, r.amount);
    byYear.set(r.year, y);
  }
  // Every year from the first with a purchase, so the bars keep time to scale.
  const first = Math.min(thisYear, ...byYear.keys());
  const years: Insights['spending']['years'] = [];
  for (let year = first; year <= thisYear; year++) {
    const y = byYear.get(year);
    years.push({
      year,
      soFar: year >= thisYear,
      purchases: y?.purchases ?? 0,
      unpriced: y?.unpriced ?? 0,
      byCurrency: y?.sums.list() ?? [],
    });
  }
  return { years, hiddenIn: hiddenOf(locs) };
}

// ---------------------------------------------------------------------------------------------
// Value per place and location: each live thing in use (not a draft) at its current value, the
// newest valuation (D158; no valuation, no value: nothing is estimated), under the top-level place
// it sits in, through its containers and the places above it.
// ---------------------------------------------------------------------------------------------

async function value(client: pg.ClientBase, locs: readonly InScope[]): Promise<Insights['value']> {
  const shown = new Set(shownOf(locs));
  const { rows } = await client.query<{
    location_id: string;
    place_id: string | null;
    currency: string | null;
    things: number;
    valued: number;
    amount: string | null;
  }>(
    `WITH RECURSIVE
     pr AS (
       SELECT p.id, p.id AS root FROM public.places p
        WHERE p.location_id = ANY ($1::uuid[]) AND p.parent_id IS NULL AND p.deleted_at IS NULL
       UNION ALL
       SELECT c.id, pr.root FROM public.places c JOIN pr ON c.parent_id = pr.id
        WHERE c.deleted_at IS NULL),
     tp AS (
       SELECT t.id, t.place_id FROM public.things t
        WHERE t.location_id = ANY ($1::uuid[]) AND t.place_id IS NOT NULL AND t.deleted_at IS NULL
       UNION ALL
       SELECT t.id, tp.place_id FROM public.things t JOIN tp ON t.container_id = tp.id
        WHERE t.deleted_at IS NULL),
     cv AS (
       SELECT DISTINCT ON (v.thing_id) v.thing_id, v.value, v.currency::text AS currency
         FROM public.valuations v
        WHERE v.location_id = ANY ($2::uuid[])
        ORDER BY v.thing_id, v.valued_on DESC, v.created_at DESC, v.id DESC)
     SELECT t.location_id, pr.root AS place_id, cv.currency, count(*)::int AS things,
            count(cv.thing_id)::int AS valued, trim_scale(round(sum(cv.value), 4))::text AS amount
       FROM public.things t
       JOIN tp ON tp.id = t.id
       LEFT JOIN pr ON pr.id = tp.place_id
       LEFT JOIN cv ON cv.thing_id = t.id
      WHERE t.lifecycle = 'in_use' AND t.review_state <> 'draft'
      GROUP BY t.location_id, pr.root, cv.currency`,
    [locs.map((l) => l.id), [...shown]],
  );
  const roots = [...new Set(rows.map((r) => r.place_id).filter((id): id is string => !!id))];
  const { rows: names } = roots.length
    ? await client.query<{
        id: string;
        name: string;
        is_unplaced: boolean;
        short_code: string | null;
      }>(
        `SELECT p.id, p.name, p.is_unplaced, ${SHORT_CODE('place_id', 'p')} AS short_code
           FROM public.places p WHERE p.id = ANY ($1::uuid[])`,
        [roots],
      )
    : { rows: [] };
  const nameOf = new Map(names.map((n) => [n.id, n]));

  type Acc = { things: number; valued: number; sums: Sums };
  const acc = () => ({ things: 0, valued: 0, sums: new Sums() });
  const perLoc = new Map<string, { total: Acc; places: Map<string | null, Acc> }>();
  for (const l of locs) perLoc.set(l.id, { total: acc(), places: new Map() });
  for (const r of rows) {
    const loc = perLoc.get(r.location_id);
    if (!loc) continue;
    const place = loc.places.get(r.place_id) ?? acc();
    for (const a of [loc.total, place]) {
      a.things += r.things;
      a.valued += r.valued;
      a.sums.add(r.currency, r.amount);
    }
    loc.places.set(r.place_id, place);
  }

  const view = (a: Acc, money: boolean) =>
    money
      ? { things: a.things, valued: a.valued, byCurrency: a.sums.list() }
      : { things: a.things };
  return {
    locations: locs.map((l) => {
      const loc = perLoc.get(l.id) as { total: Acc; places: Map<string | null, Acc> };
      const money = shown.has(l.id);
      // Most things first, then by name; the rest (and things whose place is gone) fold together.
      const sorted = [...loc.places]
        .filter(([id]) => id !== null)
        .sort(([a, x], [b, y]) => {
          if (y.things !== x.things) return y.things - x.things;
          return (nameOf.get(a as string)?.name ?? '').localeCompare(
            nameOf.get(b as string)?.name ?? '',
          );
        });
      const listed = sorted.slice(0, MAX_PLACES);
      const rest = [...sorted.slice(MAX_PLACES), ...[...loc.places].filter(([id]) => id === null)];
      const places: Insights['value']['locations'][number]['places'] = listed.map(([id, a]) => {
        const n = nameOf.get(id as string);
        return {
          id,
          shortCode: n?.short_code ?? null,
          name: n?.name ?? null,
          unplaced: n?.is_unplaced ?? false,
          ...view(a, money),
        };
      });
      if (rest.length > 0) {
        const other = acc();
        for (const [, a] of rest) {
          other.things += a.things;
          other.valued += a.valued;
          other.sums.merge(a.sums);
        }
        places.push({
          id: null,
          shortCode: null,
          name: null,
          unplaced: false,
          others: rest.filter(([id]) => id !== null).length,
          ...view(other, money),
        });
      }
      return {
        locationId: l.id,
        ...view(loc.total, money),
        ...(money ? {} : { moneyHidden: true as const }),
        places,
      };
    }),
    hiddenIn: hiddenOf(locs),
  };
}

// ---------------------------------------------------------------------------------------------
// Vehicle costs: the Costs tab's sources (vehicles/costs.ts), across vehicles. Fills by the month
// they were taken in the location's zone, confirmed services by their day, documents by their
// issue date. The last VEHICLE_MONTHS full months for the trend; per vehicle, two full years and
// this year so far, with the number of fills and services.
// ---------------------------------------------------------------------------------------------

async function vehicles(
  client: pg.ClientBase,
  locs: readonly InScope[],
  thisYear: number,
  thisMonth: string,
): Promise<Insights['vehicles']> {
  const shown = new Set(shownOf(locs));
  const from = thisYear - 2;
  const { rows: list } = await client.query<{
    id: string;
    location_id: string;
    name: string | null;
    ended: boolean;
    short_code: string | null;
  }>(
    `SELECT t.id, t.location_id, t.name, t.lifecycle <> 'in_use' AS ended,
            ${SHORT_CODE('thing_id', 't')} AS short_code
       FROM public.things t
      WHERE t.location_id = ANY ($1::uuid[]) AND t.deleted_at IS NULL
        AND t.type_id IN (SELECT ty.id FROM public.types ty WHERE kept.is_vehicle_type(ty.id))`,
    [locs.map((l) => l.id)],
  );
  const { rows } = await client.query<{
    thing_id: string;
    month: string;
    currency: string | null;
    category: CostKey;
    n: number;
    amount: string | null;
  }>(
    `WITH v AS (
       SELECT t.id, t.location_id, l.timezone, t.location_id = ANY ($3::uuid[]) AS shown
         FROM public.things t JOIN public.locations l ON l.id = t.location_id
        WHERE t.id = ANY ($1::uuid[])),
     x AS (
       SELECT v.id AS thing_id, v.shown,
              to_char(f.taken_at AT TIME ZONE v.timezone, 'YYYY-MM') AS month,
              f.currency::text AS currency, 'fuel' AS category, f.cost AS amount
         FROM v JOIN public.fuel_entries f ON f.thing_id = v.id
        WHERE f.taken_at >= (make_date($2, 1, 1)::timestamp AT TIME ZONE v.timezone)
       UNION ALL
       SELECT v.id, v.shown, to_char(r.serviced_on, 'YYYY-MM'), r.currency::text, 'service', r.total
         FROM v JOIN public.service_records r ON r.thing_id = v.id
        WHERE r.review_state = 'confirmed' AND r.serviced_on >= make_date($2, 1, 1)
       UNION ALL
       SELECT v.id, v.shown, to_char(d.issued_on, 'YYYY-MM'), d.currency::text, 'fees', d.cost
         FROM v JOIN public.expiring_documents d ON d.thing_id = v.id
        WHERE d.issued_on >= make_date($2, 1, 1) AND d.cost IS NOT NULL)
     SELECT thing_id, month, CASE WHEN shown THEN currency END AS currency, category,
            count(*)::int AS n,
            trim_scale(round(sum(amount) FILTER (WHERE shown), 4))::text AS amount
       FROM x
      GROUP BY thing_id, month, CASE WHEN shown THEN currency END, category`,
    [list.map((v) => v.id), from, [...shown]],
  );

  const firstMonth = addMonths(thisMonth, -VEHICLE_MONTHS);
  const months = new Map<string, CostSums>();
  for (let m = firstMonth; m < thisMonth; m = addMonths(m, 1)) months.set(m, new CostSums());
  type Year = { fills: number; services: number; sums: CostSums };
  const perVehicle = new Map<string, Map<number, Year>>();
  const active = new Set<string>();
  for (const r of rows) {
    active.add(r.thing_id);
    months.get(r.month)?.add(r.currency, r.category, r.amount);
    const year = Number(r.month.slice(0, 4));
    const ys = perVehicle.get(r.thing_id) ?? new Map<number, Year>();
    const y = ys.get(year) ?? { fills: 0, services: 0, sums: new CostSums() };
    if (r.category === 'fuel') y.fills += r.n;
    if (r.category === 'service') y.services += r.n;
    y.sums.add(r.currency, r.category, r.amount);
    ys.set(year, y);
    perVehicle.set(r.thing_id, ys);
  }

  // In use, or with costs in the window (a vehicle sold this year still cost something).
  const shownVehicles = list
    .filter((v) => !v.ended || active.has(v.id))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));
  return {
    thisMonth,
    months: [...months].map(([month, sums]) => ({ month, byCurrency: sums.list() })),
    items: shownVehicles.slice(0, MAX_VEHICLES).map((v) => {
      const money = shown.has(v.location_id);
      const ys = perVehicle.get(v.id);
      return {
        id: v.id,
        shortCode: v.short_code,
        name: v.name,
        locationId: v.location_id,
        ended: v.ended,
        years: [from, from + 1, thisYear].map((year) => {
          const y = ys?.get(year);
          return {
            year,
            soFar: year >= thisYear,
            fills: y?.fills ?? 0,
            services: y?.services ?? 0,
            ...(money ? { byCurrency: y?.sums.list() ?? [] } : {}),
          };
        }),
        ...(money ? {} : { moneyHidden: true as const }),
      };
    }),
    more: Math.max(0, shownVehicles.length - MAX_VEHICLES),
    hiddenIn: hiddenOf(locs),
  };
}

// ---------------------------------------------------------------------------------------------
// Warranty coverage: each live thing in use (not a draft), by the warranty that covers it longest
// (D53), as the thing's coverage bar reads it (@kept/shared coverage(), D195: one that starts later
// still counts), on the location's own date (L2: ends inclusive). Covered; expiring (that cover is
// within its lead days, as the agenda says, 0053); cover ended (it had warranties, all ended); no
// warranty. Repairs (D54): claims resolved this year so
// far and last year, with what they cost and what the warranty covered where money shows.
// ---------------------------------------------------------------------------------------------

async function warranties(
  client: pg.ClientBase,
  locs: readonly InScope[],
  thisYear: number,
): Promise<Insights['warranties']> {
  const ids = locs.map((l) => l.id);
  const { rows: states } = await client.query<{ state: string; n: number }>(
    `WITH th AS (
       SELECT t.id, (now() AT TIME ZONE l.timezone)::date AS today
         FROM public.things t JOIN public.locations l ON l.id = t.location_id
        WHERE t.location_id = ANY ($1::uuid[]) AND t.deleted_at IS NULL
          AND t.lifecycle = 'in_use' AND t.review_state <> 'draft'),
     cur AS (
       SELECT DISTINCT ON (w.thing_id) w.thing_id, w.lifetime, w.effective_ends_on, w.lead_days
         FROM public.warranties w JOIN th ON th.id = w.thing_id
        WHERE w.lifetime OR w.effective_ends_on >= th.today
        ORDER BY w.thing_id, w.lifetime DESC, w.effective_ends_on DESC)
     SELECT CASE
              WHEN cur.thing_id IS NOT NULL THEN
                CASE WHEN NOT cur.lifetime AND th.today >= cur.effective_ends_on - cur.lead_days
                     THEN 'expiring' ELSE 'covered' END
              WHEN EXISTS (SELECT 1 FROM public.warranties w
                            WHERE w.thing_id = th.id AND w.effective_ends_on < th.today)
                THEN 'ended'
              ELSE 'none' END AS state,
            count(*)::int AS n
       FROM th LEFT JOIN cur ON cur.thing_id = th.id
      GROUP BY 1`,
    [ids],
  );
  const { rows: soon } = await client.query<{
    id: string;
    location_id: string;
    name: string | null;
    short_code: string | null;
    ends_on: string;
  }>(
    `WITH th AS (
       SELECT t.id, t.location_id, t.name, (now() AT TIME ZONE l.timezone)::date AS today
         FROM public.things t JOIN public.locations l ON l.id = t.location_id
        WHERE t.location_id = ANY ($1::uuid[]) AND t.deleted_at IS NULL
          AND t.lifecycle = 'in_use' AND t.review_state <> 'draft'),
     cur AS (
       SELECT DISTINCT ON (w.thing_id) w.thing_id, w.lifetime, w.effective_ends_on, w.lead_days
         FROM public.warranties w JOIN th ON th.id = w.thing_id
        WHERE w.lifetime OR w.effective_ends_on >= th.today
        ORDER BY w.thing_id, w.lifetime DESC, w.effective_ends_on DESC)
     SELECT th.id, th.location_id, th.name, ${SHORT_CODE('thing_id', 'th')} AS short_code,
            cur.effective_ends_on::text AS ends_on
       FROM th JOIN cur ON cur.thing_id = th.id
      WHERE NOT cur.lifetime AND th.today >= cur.effective_ends_on - cur.lead_days
      ORDER BY cur.effective_ends_on, th.name, th.id
      LIMIT ${MAX_EXPIRING}`,
    [ids],
  );
  const { rows: repairs } = await client.query<{
    year: number;
    currency: string | null;
    resolved: number;
    cost: string | null;
    covered: string | null;
  }>(
    `SELECT extract(year FROM c.closed_on)::int AS year,
            CASE WHEN c.location_id = ANY ($2::uuid[]) THEN c.currency::text END AS currency,
            count(*)::int AS resolved,
            trim_scale(round(sum(c.cost) FILTER (WHERE c.location_id = ANY ($2::uuid[])), 4))::text
              AS cost,
            trim_scale(round(sum(c.covered_amount)
                               FILTER (WHERE c.location_id = ANY ($2::uuid[])), 4))::text
              AS covered
       FROM public.claims c
       JOIN public.things t ON t.id = c.thing_id AND t.deleted_at IS NULL
      WHERE c.location_id = ANY ($1::uuid[]) AND c.status = 'resolved'
        AND c.closed_on >= make_date($3, 1, 1)
      GROUP BY 1, 2`,
    [ids, shownOf(locs), thisYear - 1],
  );

  const count = (s: string) => states.find((r) => r.state === s)?.n ?? 0;
  const anyShown = locs.some((l) => l.gate.showMoney);
  return {
    things: states.reduce((a, r) => a + r.n, 0),
    covered: count('covered'),
    expiring: count('expiring'),
    ended: count('ended'),
    none: count('none'),
    expiringSoon: soon.map((r) => ({
      id: r.id,
      shortCode: r.short_code,
      name: r.name,
      locationId: r.location_id,
      endsOn: r.ends_on,
    })),
    repairs: [thisYear - 1, thisYear].map((year) => {
      const ofYear = repairs.filter((r) => r.year === year);
      const cost = new Sums();
      const covered = new Sums();
      for (const r of ofYear) {
        cost.add(r.currency, r.cost);
        covered.add(r.currency, r.covered);
      }
      const currencies = [...new Set([...cost.by.keys(), ...covered.by.keys()])].sort();
      return {
        year,
        soFar: year >= thisYear,
        resolved: ofYear.reduce((a, r) => a + r.resolved, 0),
        ...(anyShown
          ? {
              byCurrency: currencies.map((currency) => ({
                currency,
                cost: fromUnits(cost.by.get(currency) ?? 0n),
                covered: fromUnits(covered.by.get(currency) ?? 0n),
              })),
            }
          : {}),
      };
    }),
    hiddenIn: hiddenOf(locs),
  };
}

/** GET /api/v1/insights?f.location* → Insights. */
export async function insightsOf(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  query: InsightsQuery,
): Promise<Insights> {
  const locs = await locationsInScope(tx, client, scope, query['f.location']);
  // "This year" and "this month" are the latest among the locations (time zones a day apart
  // differ only around midnight on the 31st).
  const utc = new Date().toISOString();
  const thisYear = locs.length
    ? Math.max(...locs.map((l) => l.this_year))
    : Number(utc.slice(0, 4));
  const thisMonth =
    locs
      .map((l) => l.this_month)
      .sort()
      .at(-1) ?? utc.slice(0, 7);
  if (locs.length === 0) {
    return {
      locations: [],
      thisYear,
      spending: { years: [], hiddenIn: [] },
      value: { locations: [], hiddenIn: [] },
      vehicles: null,
      warranties: null,
    };
  }
  const withVehicles = locs.filter((l) => l.gate.modules.has('vehicles'));
  const withWarranties = locs.filter((l) => l.gate.modules.has('warranties'));
  return {
    locations: locs.map((l) => ({
      id: l.id,
      money: l.gate.showMoney,
      vehicles: l.gate.modules.has('vehicles'),
      warranties: l.gate.modules.has('warranties'),
    })),
    thisYear,
    spending: await spending(client, locs, thisYear),
    value: await value(client, locs),
    vehicles: withVehicles.length
      ? await vehicles(client, withVehicles, thisYear, thisMonth)
      : null,
    warranties: withWarranties.length ? await warranties(client, withWarranties, thisYear) : null,
  };
}
