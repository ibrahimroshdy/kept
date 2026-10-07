import { builtinType, type Digits } from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { gateFor } from '../serialize/gates.js';
import type { ReportLocale } from './labels.js';

// What goes into a report (D201), read in the requester's scope: the `report` job runs as a
// tenant job (jobs/boss.ts), inside withScope() on kept_app, so row-level security decides which
// locations, places, things, photos and purchases it can read, exactly as it would for a request.
//
// - Locations: the run's `location_ids` (fixed and audited when it was requested) that are still
//   visible and not deleted.
// - Money: read at all only for the locations where the requester's gate shows it
//   (serialize/gates.ts: the `money` module on, and a role that may see money there, D13, D110)
//   and the request asked for it. The purchase date is money too (D201). For any other location
//   kept.thing_purchase() is never called, so no amount is in memory to leak.
// - Secrets: never read. The report shows the built-in columns only (type, brand, model, serial,
//   condition), never `custom`, so neither secret_values nor a custom field reaches it.
// - Drafts (captures not yet confirmed) are left out; ended and trashed things only on request.

/** A report's size limit: past it the run fails with `too_many_things` (filter it instead). The
 * spike rendered 500 things in about 2 s and 280 MB; four times that still fits the budget. */
export const MAX_THINGS = 2000;

export class TooManyThingsError extends Error {
  constructor() {
    super(`a report holds at most ${MAX_THINGS} things`);
    this.name = 'TooManyThingsError';
  }
}

export type ReportFilters = {
  placeIds: string[];
  typeIds: string[];
  tagIds: string[];
  /** Exactly these things (a printed list, step-7 T16). Runs made before it have none. */
  thingIds?: string[];
  includeEnded: boolean;
  includeTrashed: boolean;
};

export type ReportOptions = {
  filters: ReportFilters;
  include: { photos: boolean; qr: boolean; money: boolean };
  locale: ReportLocale;
  digits: Digits;
};

export type RunScope = { locationId: string } | { accountId: string };

export type PathStep = {
  id: string;
  name: string | null;
  kind: 'place' | 'container';
  isUnplaced: boolean;
};

export type GatheredMoney = {
  /** `YYYY-MM-DD`. */
  purchasedOn: string | null;
  unitPrice: string | null;
  currency: string | null;
  /** unit price × quantity, exact (numeric), as a decimal string. */
  value: string | null;
};

export type GatheredThing = {
  id: string;
  locationId: string;
  name: string;
  typeName: string | null;
  brand: string | null;
  model: string | null;
  serial: string | null;
  condition: string | null;
  lifecycle: string;
  quantity: string;
  shortCode: string | null;
  trashed: boolean;
  /** The storage key of its first photo's thumbnail, when the report includes photos. */
  thumbKey: string | null;
  path: PathStep[];
  /** Null where money is hidden (or wasn't asked for); never a partial object. */
  money: GatheredMoney | null;
};

export type Gathered = {
  locations: { id: string; name: string }[];
  /** An account report: the account owner's display name; null for a location report. */
  accountOwnerName: string | null;
  requesterName: string;
  requesterTimezone: string;
  /** Whether any covered location shows money, and whether any hides it. */
  moneyShown: boolean;
  moneyHidden: boolean;
  things: GatheredThing[];
  filterNames: { places: string[]; types: string[]; tags: string[] };
};

type ThingRow = {
  id: string;
  location_id: string;
  name: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  brand: string | null;
  model: string | null;
  serial: string | null;
  condition: string | null;
  lifecycle: string;
  quantity: string;
  short_code: string | null;
  trashed: boolean;
  thumb_key: string | null;
  path: PathStep[];
  purchased_on: string | null;
  unit_price: string | null;
  currency: string | null;
  value: string | null;
};

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export function typeNameOf(
  name: string | null,
  builtinKey: string | null,
  locale: ReportLocale,
): string | null {
  if (name) return name;
  const builtin = builtinKey ? builtinType(builtinKey) : undefined;
  return builtin ? builtin.names[locale] : null;
}

/** One page of a paged read (readThingsPage): the things after `after` (by id), at most `limit`. */
type Page = { after: string | null; limit: number };

/** The things of a report, in the requester's scope. */
async function readThings(
  client: pg.ClientBase,
  locationIds: string[],
  moneyLocationIds: string[],
  options: ReportOptions,
  page?: Page,
): Promise<ThingRow[]> {
  const p = new Params();
  const f = options.filters;
  const ctes: string[] = [];
  const where = [
    `t.location_id = ANY (${p.add(locationIds)}::uuid[])`,
    `t.review_state <> 'draft'`,
  ];
  if (!f.includeTrashed) where.push('t.deleted_at IS NULL');
  if (!f.includeEnded) where.push(`t.lifecycle = 'in_use'`);
  if (f.placeIds.length > 0) {
    // Each place's whole subtree (or a container's, given its id), and everything inside the
    // containers within, however deep: the search route's rule (search/query.ts).
    const roots = p.add(f.placeIds);
    ctes.push(`sub(id) AS (
        SELECT pl.id FROM public.places pl WHERE pl.id = ANY (${roots}::uuid[])
        UNION
        SELECT c.id FROM public.places c JOIN sub ON c.parent_id = sub.id
      ),
      inside(id) AS (
        SELECT x.id FROM public.things x
         WHERE x.place_id IN (SELECT id FROM sub) OR x.container_id = ANY (${roots}::uuid[])
        UNION
        SELECT x.id FROM public.things x JOIN inside i ON x.container_id = i.id
      )`);
    where.push('t.id IN (SELECT id FROM inside)');
  }
  if (f.typeIds.length > 0) {
    // A type and every type under it.
    ctes.push(`tsub(id) AS (
        SELECT ty.id FROM public.types ty WHERE ty.id = ANY (${p.add(f.typeIds)}::uuid[])
        UNION
        SELECT c.id FROM public.types c JOIN tsub ON c.parent_id = tsub.id
      )`);
    where.push('t.type_id IN (SELECT id FROM tsub)');
  }
  if (f.thingIds && f.thingIds.length > 0) {
    where.push(`t.id = ANY (${p.add(f.thingIds)}::uuid[])`);
  }
  if (page?.after) where.push(`t.id > ${p.add(page.after)}::uuid`);
  if (f.tagIds.length > 0) {
    where.push(`EXISTS (SELECT 1 FROM public.thing_tags g
                         WHERE g.thing_id = t.id AND g.tag_id = ANY (${p.add(f.tagIds)}::uuid[]))`);
  }
  const thumb = options.include.photos
    ? `(SELECT d.storage_key FROM public.attachments a
          JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
         WHERE a.thing_id = t.id AND a.role = 'photo'
         ORDER BY a.sort, a.created_at, a.id LIMIT 1)`
    : 'NULL::text';
  const moneyLocs = p.add(moneyLocationIds);
  const text = `${ctes.length > 0 ? `WITH RECURSIVE ${ctes.join(',\n')}` : ''}
    SELECT t.id, t.location_id, t.name, ty.name AS type_name, ty.builtin_key AS type_builtin_key,
           b.name AS brand, t.model, t.serial, t.condition, t.lifecycle,
           t.quantity::text AS quantity, t.deleted_at IS NOT NULL AS trashed,
           (SELECT s.code FROM public.short_ids s
             WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1) AS short_code,
           ${thumb} AS thumb_key,
           (SELECT coalesce(jsonb_agg(e || jsonb_build_object('isUnplaced',
                     coalesce((SELECT pl.is_unplaced FROM public.places pl
                                WHERE e->>'kind' = 'place' AND pl.id = (e->>'id')::uuid), false))
                   ORDER BY n), '[]'::jsonb)
              FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                   WITH ORDINALITY AS x(e, n)) AS path,
           tp.purchased_on::text AS purchased_on, tp.unit_price::text AS unit_price, tp.currency,
           (tp.unit_price * t.quantity)::text AS value
      FROM public.things t
      LEFT JOIN public.types ty ON ty.id = t.type_id
      LEFT JOIN public.brands b ON b.id = t.brand_id
      LEFT JOIN LATERAL (
        SELECT x.purchased_on, x.unit_price, x.currency FROM kept.thing_purchase(t.id) x
         WHERE t.location_id = ANY (${moneyLocs}::uuid[])
      ) tp ON true
     WHERE ${where.join('\n       AND ')}
     ORDER BY t.id
     LIMIT ${p.add(page ? page.limit : MAX_THINGS + 1)}`;
  const { rows } = await client.query<ThingRow>(text, p.values);
  return rows;
}

async function namesOf(client: pg.ClientBase, options: ReportOptions) {
  const f = options.filters;
  const read = async (sql: string, ids: string[]) =>
    ids.length === 0
      ? []
      : (await client.query<{ name: string | null; builtin_key?: string | null }>(sql, [ids])).rows;
  const places = await read(
    'SELECT name FROM public.places WHERE id = ANY ($1::uuid[]) UNION ALL SELECT name FROM public.things WHERE id = ANY ($1::uuid[])',
    f.placeIds,
  );
  const types = await read(
    'SELECT name, builtin_key FROM public.types WHERE id = ANY ($1::uuid[])',
    f.typeIds,
  );
  const tags = await read('SELECT name FROM public.tags WHERE id = ANY ($1::uuid[])', f.tagIds);
  const sorted = (xs: (string | null)[]) =>
    xs.filter((x): x is string => !!x).sort(new Intl.Collator(options.locale).compare);
  return {
    places: sorted(places.map((r) => r.name)),
    types: sorted(types.map((r) => typeNameOf(r.name, r.builtin_key ?? null, options.locale))),
    tags: sorted(tags.map((r) => r.name)),
  };
}

/**
 * Reads a report's contents in `tx`/`client`, the requester's scoped transaction. Throws
 * TooManyThingsError past MAX_THINGS.
 */
export async function gather(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  run: { locationIds: string[]; scope: RunScope; options: ReportOptions },
): Promise<Gathered> {
  const { rows: locations } = await client.query<{ id: string; name: string }>(
    `SELECT l.id, l.name FROM public.locations l
      WHERE l.id = ANY ($1::uuid[]) AND l.deleted_at IS NULL
      ORDER BY l.name, l.id`,
    [run.locationIds],
  );
  const ids = locations.map((l) => l.id);
  const moneyIds: string[] = [];
  let moneyHidden = false;
  for (const id of ids) {
    const gate = await gateFor(tx, id, scope);
    if (run.options.include.money && gate.showMoney) moneyIds.push(id);
    else if (run.options.include.money) moneyHidden = true;
  }

  const { rows: me } = await client.query<{ display_name: string; timezone: string }>(
    'SELECT display_name, timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  let accountOwnerName: string | null = null;
  if ('accountId' in run.scope) {
    const { rows } = await client.query<{ display_name: string }>(
      `SELECT p.display_name FROM public.memberships m
         JOIN public.locations l ON l.id = m.location_id
         JOIN public.user_profiles p ON p.user_id = m.user_id
        WHERE l.owner_account_id = $1 AND m.role = 'owner'
        LIMIT 1`,
      [run.scope.accountId],
    );
    accountOwnerName = rows[0]?.display_name ?? null;
  }

  const rows = ids.length === 0 ? [] : await readThings(client, ids, moneyIds, run.options);
  if (rows.length > MAX_THINGS) throw new TooManyThingsError();
  const shown = new Set(moneyIds);

  return {
    locations,
    accountOwnerName,
    requesterName: me[0]?.display_name ?? '',
    requesterTimezone: me[0]?.timezone ?? 'UTC',
    moneyShown: moneyIds.length > 0,
    moneyHidden,
    things: rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      name: r.name ?? '',
      typeName: typeNameOf(r.type_name, r.type_builtin_key, run.options.locale),
      brand: r.brand,
      model: r.model,
      serial: r.serial,
      condition: r.condition,
      lifecycle: r.lifecycle,
      quantity: r.quantity,
      shortCode: r.short_code,
      trashed: r.trashed,
      thumbKey: r.thumb_key,
      path: r.path ?? [],
      money: shown.has(r.location_id)
        ? {
            purchasedOn: r.purchased_on,
            unitPrice: r.unit_price,
            currency: r.currency,
            value: r.value,
          }
        : null,
    })),
    filterNames: await namesOf(client, run.options),
  };
}

/**
 * A page of one location's things as a report reads them, with no MAX_THINGS cap: the readable
 * copy of an export (exports/readable/, step-7 T13) reads every thing this way, in pages, in the
 * requester's scope. `showMoney` is the requester's gate there; the report path keeps its cap.
 */
export async function readThingsPage(
  client: pg.ClientBase,
  locationId: string,
  showMoney: boolean,
  options: ReportOptions,
  page: Page,
): Promise<GatheredThing[]> {
  const rows = await readThings(client, [locationId], showMoney ? [locationId] : [], options, page);
  return rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    name: r.name ?? '',
    typeName: typeNameOf(r.type_name, r.type_builtin_key, options.locale),
    brand: r.brand,
    model: r.model,
    serial: r.serial,
    condition: r.condition,
    lifecycle: r.lifecycle,
    quantity: r.quantity,
    shortCode: r.short_code,
    trashed: r.trashed,
    thumbKey: r.thumb_key,
    path: r.path ?? [],
    money: showMoney
      ? {
          purchasedOn: r.purchased_on,
          unitPrice: r.unit_price,
          currency: r.currency,
          value: r.value,
        }
      : null,
  }));
}
