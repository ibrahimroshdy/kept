import { CSV_BOM, CSV_EOL, type CsvValue, canonicalAmount, csvLine } from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { typeNameOf } from '../reports/gather.js';
import { type ReportLocale, wordsFor } from '../reports/labels.js';
import { gateFor } from '../serialize/gates.js';
import { type ThingListFilter, thingListOrder, thingListWhere } from '../things/service.js';
import type { ListQuery } from '../things/validate.js';

// The things list you're looking at, as a CSV (D169; step-7 plan T16; engineering spec §3.5):
// GET /api/v1/things.csv takes every GET /things parameter and writes the same rows in the same
// order, through the one safe cell writer (@kept/shared safeCsvCell: formula triggers defused,
// a BOM, CRLF). Any member can export what they can see.
//
// - Never a secret, a custom field, a person's contact detail or a document: only the built-in
//   columns below.
// - Money (purchase date, price, currency) only where the caller's gate shows it (D13, D110):
//   the columns are present when at least one location in the file shows money, and blank on
//   the rows of a location that hides it. kept.thing_purchase() is never called for those, as in
//   the report (reports/gather.ts), so no amount is read to leak.
// - At most CSV_MAX_ROWS rows; past that the file stops and `truncated` says so.

export const CSV_MAX_ROWS = 100_000;
/** §3.5: five CSV exports an hour per person. */
export const CSV_PER_HOUR = 5;
/** Rows read per query. */
const BATCH = 1000;

const COLUMNS = [
  'short_id',
  'name',
  'place',
  'type',
  'brand',
  'model',
  'serial',
  'quantity',
  'condition',
  'tags',
  'lifecycle',
  'last_seen',
  'own_codes',
] as const;
const MONEY_COLUMNS = ['purchase_date', 'price', 'currency'] as const;

export type ThingsCsvQuery = ThingListFilter & Pick<ListQuery, 'group' | 'sort' | 'dir'>;

type Row = {
  id: string;
  location_id: string;
  name: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  brand: string | null;
  model: string | null;
  serial: string | null;
  quantity: string;
  condition: string | null;
  lifecycle: string;
  last_seen_at: Date | null;
  short_code: string | null;
  tags: string[];
  own_codes: string[];
  path: { name: string | null; isUnplaced: boolean }[];
  purchased_on: string | null;
  unit_price: string | null;
  currency: string | null;
};

export type ThingsCsv = {
  csv: string;
  rows: number;
  truncated: boolean;
  /** Rows per location, for the audit (one event per location the file drew from). */
  perLocation: Map<string, number>;
  money: boolean;
};

async function localeOf(client: pg.ClientBase): Promise<ReportLocale> {
  const { rows } = await client.query<{ locale: string | null }>(
    'SELECT locale FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  return rows[0]?.locale?.startsWith('ar') ? 'ar' : 'en';
}

async function readRows(
  client: pg.ClientBase,
  ids: string[],
  moneyLocations: string[],
): Promise<Row[]> {
  const { rows } = await client.query<Row>(
    `SELECT t.id, t.location_id, t.name, ty.name AS type_name, ty.builtin_key AS type_builtin_key,
            b.name AS brand, t.model, t.serial, t.quantity::text AS quantity, t.condition,
            t.lifecycle, t.last_seen_at,
            (SELECT s.code FROM public.short_ids s
              WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1) AS short_code,
            ARRAY(SELECT g.name FROM public.thing_tags tt JOIN public.tags g ON g.id = tt.tag_id
                   WHERE tt.thing_id = t.id ORDER BY lower(g.name), g.id) AS tags,
            ARRAY(SELECT c.code FROM public.legacy_codes c
                   WHERE c.thing_id = t.id AND c.source = 'own' ORDER BY c.code) AS own_codes,
            (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'name', e->>'name',
                      'isUnplaced', coalesce((SELECT pl.is_unplaced FROM public.places pl
                                               WHERE e->>'kind' = 'place'
                                                 AND pl.id = (e->>'id')::uuid), false))
                    ORDER BY n), '[]'::jsonb)
               FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                    WITH ORDINALITY AS x(e, n)) AS path,
            tp.purchased_on::text AS purchased_on, tp.unit_price::text AS unit_price, tp.currency
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
       LEFT JOIN public.brands b ON b.id = t.brand_id
       LEFT JOIN LATERAL (
         SELECT x.purchased_on, x.unit_price, x.currency FROM kept.thing_purchase(t.id) x
          WHERE t.location_id = ANY ($2::uuid[])
       ) tp ON true
      WHERE t.id = ANY ($1::uuid[])`,
    [ids, moneyLocations],
  );
  return rows;
}

/**
 * The CSV of GET /things for `q`, read in the caller's scoped transaction. 404 (from the list's
 * own filter) for a named location the caller can't see.
 */
export async function thingsCsv(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  q: ThingsCsvQuery,
): Promise<ThingsCsv> {
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = await thingListWhere(client, q, p);
  const { group, sort, desc } = thingListOrder(q);
  const { rows: order } = await client.query<{ id: string; location_id: string }>(
    `SELECT t.id, t.location_id
       FROM public.things t LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${group}, ${sort} ${desc ? 'DESC' : 'ASC'}, t.id
      LIMIT ${p(CSV_MAX_ROWS + 1)}`,
    values,
  );
  const truncated = order.length > CSV_MAX_ROWS;
  const ids = order.slice(0, CSV_MAX_ROWS);

  const perLocation = new Map<string, number>();
  for (const r of ids) perLocation.set(r.location_id, (perLocation.get(r.location_id) ?? 0) + 1);
  const moneyLocations: string[] = [];
  for (const id of perLocation.keys()) {
    if ((await gateFor(tx, id, scope)).showMoney) moneyLocations.push(id);
  }
  const money = moneyLocations.length > 0;
  const locale = await localeOf(client);
  const words = wordsFor(locale);

  const lines: string[] = [csvLine([...COLUMNS, ...(money ? MONEY_COLUMNS : [])])];
  for (let at = 0; at < ids.length; at += BATCH) {
    const batch = ids.slice(at, at + BATCH).map((r) => r.id);
    const byId = new Map((await readRows(client, batch, moneyLocations)).map((r) => [r.id, r]));
    for (const id of batch) {
      const r = byId.get(id);
      if (!r) continue;
      const cells: CsvValue[] = [
        r.short_code,
        r.name,
        r.path.map((s) => s.name ?? (s.isUnplaced ? words.unplaced : '')).join(' › '),
        typeNameOf(r.type_name, r.type_builtin_key, locale),
        r.brand,
        r.model,
        r.serial,
        r.quantity,
        r.condition,
        r.tags.join('; '),
        r.lifecycle,
        r.last_seen_at?.toISOString() ?? null,
        r.own_codes.join('; '),
      ];
      // Canonical amounts (`1250.5`, not numeric's `1250.5000`): a spreadsheet reads a number.
      if (money) {
        cells.push(r.purchased_on, canonicalAmount(r.unit_price), r.currency);
      }
      lines.push(csvLine(cells));
    }
  }
  return {
    csv: CSV_BOM + lines.map((l) => l + CSV_EOL).join(''),
    rows: lines.length - 1,
    truncated,
    perLocation,
    money,
  };
}
