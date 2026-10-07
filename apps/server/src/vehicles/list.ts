import { consumption, type FuelUnit } from '@kept/shared';
import type pg from 'pg';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import type { Estimate } from '../meters/estimate.js';
import type { Ctx } from '../schedules/service.js';
import { gateFor } from '../serialize/gates.js';
import { rowsOf, type ThingRow } from '../things/view.js';
import { correctedValueSql } from './meters.js';

// The Vehicles list (step-5 plan T13; D26, D52, D188; screens §1, §8; Q2, Q24): global across the
// caller's locations with Vehicles on. A vehicle is a live thing whose type reaches the built-in
// Vehicle (`kept.is_vehicle_type`, Q2), read as the caller, so RLS decides what exists.
//
// Each row: the thing (step 2's ThingRow), its odometer (first distance meter, else first meter)
// with the latest accepted reading and the usage estimate (`kept.meter_estimate`, Q8), the next
// schedule due from `agenda_items` (its date the estimated one when that comes first, labelled
// `estimated`, D52), its documents that aren't `ok`, and its consumption when Fuel is on. Sold
// and other ended vehicles show only when `f.state` asks (Q24): the agenda leaves them out, so
// they have nothing due.
//
// Filters (the `vehicles` surface): `q` (the name), `f.location`, `f.type`, `f.state` (default
// `in_use`), `f.reading` (the estimate's advice: fresh · stale · unknown · none), `f.due`
// (overdue: the next schedule is overdue; soon: it is due, or a document is expiring or
// expired), each "is none of" when named in `not` (D205). Sorts: name (A to Z), lastReading
// (newest first), nextDue (soonest first), location (then name); `dir` reverses.

export type VehicleRow = {
  thing: ThingRow;
  meter?: {
    id: string;
    unit: string;
    latest?: { value: string; takenAt: string; source: string; by: { displayName: string } };
    estimate: Estimate;
  };
  nextDue?: {
    name: string;
    dueOn?: string;
    dueValue?: string;
    estimated: boolean;
    state: string;
  };
  documentsDue: Array<{ id: string; kind: string; expiresOn: string; state: string }>;
  fuel?: { perHundred: string; unit: FuelUnit; distanceUnit: string };
};

export type VehicleListQuery = {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  'f.location'?: string[] | undefined;
  'f.type'?: string[] | undefined;
  'f.state'?: string[] | undefined;
  'f.reading'?: ('fresh' | 'stale' | 'unknown' | 'none')[] | undefined;
  'f.due'?: ('overdue' | 'soon')[] | undefined;
  not?: ('location' | 'type' | 'state' | 'reading' | 'due')[] | undefined;
  sort?: 'name' | 'lastReading' | 'nextDue' | 'location' | undefined;
  dir?: 'asc' | 'desc' | undefined;
};

type Record_ = {
  id: string;
  location_id: string;
  meter_id: string | null;
  meter_unit: string | null;
  latest_value: string | null;
  latest_at: Date | null;
  latest_source: string | null;
  latest_by: string | null;
  per_day: string | null;
  basis_days: number | null;
  age_days: number | null;
  advice: Estimate['advice'];
  due_name: string | null;
  due_on: string | null;
  due_value: string | null;
  estimated: boolean | null;
  due_state: string | null;
  sort_key: string;
};

const SEVERITY = `CASE a.state WHEN 'overdue' THEN 4 WHEN 'expired' THEN 3 WHEN 'due' THEN 2
                              WHEN 'expiring' THEN 1 ELSE 0 END`;

const SORT_KEYS = {
  name: `lower(coalesce(x.name, ''))`,
  lastReading: `coalesce(to_char(x.latest_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '')`,
  nextDue: `coalesce(x.due_on::text, '9999-12-31')`,
  location: `lower(x.location_name) || chr(1) || lower(coalesce(x.name, ''))`,
} as const;

/** GET /api/v1/vehicles → `{items: VehicleRow[], next_cursor}`. */
export async function listVehicles(
  ctx: Ctx,
  page: VehicleListQuery,
): Promise<{ items: VehicleRow[]; next_cursor: string | null }> {
  const { client } = ctx;
  const sort = page.sort ?? 'name';
  const desc = (page.dir ?? (sort === 'lastReading' ? 'desc' : 'asc')) === 'desc';
  let after: [string, string] | null = null;
  if (page.cursor) {
    const raw = decodeCursor<unknown>(page.cursor);
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 ||
      typeof raw[0] !== 'string' ||
      typeof raw[1] !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(raw[1]) ||
      raw[0].length > 600
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    after = raw as [string, string];
  }

  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  const not = new Set<string>(page.not ?? []);
  const base: string[] = [];
  const outer: string[] = [];
  const filter = (into: string[], name: string, cond: string) =>
    into.push(not.has(name) ? `NOT coalesce(${cond}, false)` : `coalesce(${cond}, false)`);
  const q = page.q?.trim();
  if (q) {
    base.push(`strpos(kept.normalize(coalesce(t.name, '')), kept.normalize(${arg(q)})) > 0`);
  }
  if (page['f.location']?.length) {
    const ids = page['f.location'].map((v) => v.toLowerCase());
    filter(base, 'location', `t.location_id = ANY (${arg(ids)}::uuid[])`);
  }
  if (page['f.type']?.length) {
    const ids = page['f.type'].map((v) => v.toLowerCase());
    filter(base, 'type', `t.type_id = ANY (${arg(ids)}::uuid[])`);
  }
  if (page['f.state']?.length) {
    filter(base, 'state', `t.lifecycle = ANY (${arg(page['f.state'])}::text[])`);
  } else {
    base.push(`t.lifecycle = 'in_use'`);
  }
  if (page['f.reading']?.length) {
    filter(outer, 'reading', `x.advice = ANY (${arg(page['f.reading'])}::text[])`);
  }
  if (page['f.due']?.length) {
    filter(outer, 'due', `x.due_class = ANY (${arg(page['f.due'])}::text[])`);
  }
  const key = SORT_KEYS[sort];
  if (after) {
    outer.push(
      `(${key} COLLATE "C", x.id) ${desc ? '<' : '>'} (${arg(after[0])} COLLATE "C", ${arg(after[1])}::uuid)`,
    );
  }
  const dir = desc ? 'DESC' : 'ASC';
  const { rows } = await client.query<Record_ & { location_name: string }>(
    `WITH vt AS (SELECT ty.id FROM public.types ty WHERE kept.is_vehicle_type(ty.id)),
     b AS (
       SELECT t.id, t.location_id, t.name, l.name AS location_name,
              om.id AS meter_id, om.unit AS meter_unit
         FROM public.things t
         JOIN public.locations l ON l.id = t.location_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.unit FROM public.meters m WHERE m.thing_id = t.id
            ORDER BY (m.kind = 'distance') DESC, m.created_at, m.id LIMIT 1) om ON true
        WHERE t.deleted_at IS NULL AND t.type_id IN (SELECT vt.id FROM vt)
          AND kept.module_on(t.location_id, 'vehicles')
          ${base.map((c) => `AND ${c}`).join('\n          ')}),
     x AS (
       SELECT b.*, lr.value AS latest_value, lr.taken_at AS latest_at, lr.source AS latest_source,
              lr.by AS latest_by, trim_scale(e.per_day)::text AS per_day, e.basis_days,
              e.age_days, coalesce(e.advice, 'none') AS advice,
              nd.title AS due_name, nd.due_on::text AS due_on,
              trim_scale(nd.due_value)::text AS due_value, nd.estimated, nd.state AS due_state,
              CASE WHEN nd.state = 'overdue' THEN 'overdue'
                   WHEN nd.state = 'due' OR EXISTS (
                     SELECT 1 FROM public.agenda_items da
                      WHERE da.source_type = 'document' AND da.thing_id = b.id
                        AND da.state IN ('expiring', 'overdue')) THEN 'soon' END AS due_class
         FROM b
         LEFT JOIN LATERAL (
           SELECT trim_scale(r.value)::text AS value, r.taken_at, r.source,
                  up.display_name AS by
             FROM public.meter_readings r
             LEFT JOIN public.user_profiles up ON up.user_id = r.logged_by
            WHERE r.meter_id = b.meter_id AND r.state = 'accepted'
            ORDER BY r.taken_at DESC, r.id DESC LIMIT 1) lr ON true
         LEFT JOIN LATERAL kept.meter_estimate(b.meter_id) e ON b.meter_id IS NOT NULL
         LEFT JOIN LATERAL (
           SELECT a.title, a.due_value, a.estimated, a.state,
                  CASE WHEN a.estimated THEN a.estimated_on ELSE a.due_on END AS due_on
             FROM public.agenda_items a
            WHERE a.source_type = 'schedule' AND a.thing_id = b.id
            ORDER BY ${SEVERITY} DESC,
                     CASE WHEN a.estimated THEN a.estimated_on ELSE a.due_on END NULLS LAST,
                     a.title, a.source_id
            LIMIT 1) nd ON true)
     SELECT x.*, ${key} AS sort_key FROM x
      ${outer.length > 0 ? `WHERE ${outer.join(' AND ')}` : ''}
      ORDER BY ${key} COLLATE "C" ${dir}, x.id ${dir}
      LIMIT ${arg(page.limit + 1)}`,
    args,
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: await vehicleRowsOf(ctx, items),
    next_cursor: rows.length > page.limit && last ? encodeCursor([last.sort_key, last.id]) : null,
  };
}

/** The documents of `thingIds` that aren't `ok` (expiring or expired), soonest first. */
async function documentsDue(
  client: pg.ClientBase,
  thingIds: readonly string[],
): Promise<Map<string, VehicleRow['documentsDue']>> {
  const out = new Map<string, VehicleRow['documentsDue']>();
  if (thingIds.length === 0) return out;
  const { rows } = await client.query<{
    thing_id: string;
    id: string;
    kind: string;
    expires_on: string;
    state: string;
  }>(
    `SELECT d.thing_id, d.id, d.kind, d.expires_on::text AS expires_on,
            CASE WHEN a.state = 'overdue' THEN 'expired' ELSE 'expiring' END AS state
       FROM public.expiring_documents d
       JOIN public.agenda_items a ON a.source_type = 'document' AND a.source_id = d.id
      WHERE d.thing_id = ANY ($1::uuid[]) AND a.state IN ('expiring', 'overdue')
      ORDER BY d.expires_on, d.id`,
    [[...thingIds]],
  );
  for (const r of rows) {
    out.set(r.thing_id, [
      ...(out.get(r.thing_id) ?? []),
      { id: r.id, kind: r.kind, expiresOn: r.expires_on, state: r.state },
    ]);
  }
  return out;
}

/** Each vehicle's consumption over its last 5 usable intervals, where Fuel is on. */
async function consumptionOf(
  ctx: Ctx,
  records: readonly (Record_ & { location_id: string })[],
): Promise<Map<string, VehicleRow['fuel']>> {
  const out = new Map<string, VehicleRow['fuel']>();
  const fuelOn = new Set<string>();
  for (const loc of new Set(records.map((r) => r.location_id))) {
    if ((await gateFor(ctx.tx, loc, ctx.scope)).modules.has('fuel')) fuelOn.add(loc);
  }
  const ids = records.filter((r) => fuelOn.has(r.location_id) && r.meter_id).map((r) => r.id);
  if (ids.length === 0) return out;
  const { rows } = await ctx.client.query<{
    thing_id: string;
    taken_at: Date;
    amount: string;
    unit: FuelUnit;
    is_full: boolean;
    missed_before: boolean;
    reading_value: string | null;
  }>(
    `SELECT f.thing_id, f.taken_at, trim_scale(f.amount)::text AS amount, f.unit, f.is_full,
            f.missed_before,
            CASE WHEN d.state = 'accepted' THEN trim_scale(${correctedValueSql('d')})::text END
              AS reading_value
       FROM public.fuel_entries f
       LEFT JOIN public.meter_readings d ON d.id = f.meter_reading_id
      WHERE f.thing_id = ANY ($1::uuid[])
      ORDER BY f.thing_id, f.taken_at, f.id`,
    [ids],
  );
  const byThing = new Map<string, typeof rows>();
  for (const r of rows) byThing.set(r.thing_id, [...(byThing.get(r.thing_id) ?? []), r]);
  for (const r of records) {
    const fills = byThing.get(r.id);
    if (!fills || !r.meter_unit) continue;
    const c = consumption(
      fills.map((f) => ({
        takenAt: f.taken_at,
        amount: f.amount,
        unit: f.unit,
        isFull: f.is_full,
        missedBefore: f.missed_before,
        reading: f.reading_value === null ? null : { value: f.reading_value },
      })),
    ).overall;
    if (c) out.set(r.id, { perHundred: c.perHundred, unit: c.unit, distanceUnit: r.meter_unit });
  }
  return out;
}

async function vehicleRowsOf(
  ctx: Ctx,
  records: readonly (Record_ & { location_id: string })[],
): Promise<VehicleRow[]> {
  const ids = records.map((r) => r.id);
  // One client, one query at a time (pg queues concurrent ones, and deprecates doing so).
  const things = await rowsOf(ctx.client, ctx.files, ids);
  const docs = await documentsDue(ctx.client, ids);
  const fuel = await consumptionOf(ctx, records);
  const thingOf = new Map(things.map((t) => [t.id, t]));
  const out: VehicleRow[] = [];
  for (const r of records) {
    const thing = thingOf.get(r.id);
    if (!thing) continue;
    const f = fuel.get(r.id);
    out.push({
      thing,
      ...(r.meter_id && r.meter_unit
        ? {
            meter: {
              id: r.meter_id,
              unit: r.meter_unit,
              ...(r.latest_value !== null && r.latest_at && r.latest_source
                ? {
                    latest: {
                      value: r.latest_value,
                      takenAt: r.latest_at.toISOString(),
                      source: r.latest_source,
                      by: { displayName: r.latest_by ?? '' },
                    },
                  }
                : {}),
              estimate: {
                perDay: r.per_day,
                basisDays: r.basis_days,
                ageDays: r.age_days,
                advice: r.advice,
              },
            },
          }
        : {}),
      ...(r.due_name !== null && r.due_state
        ? {
            nextDue: {
              name: r.due_name,
              ...(r.due_on ? { dueOn: r.due_on } : {}),
              ...(r.due_value ? { dueValue: r.due_value } : {}),
              estimated: r.estimated === true,
              state: r.due_state,
            },
          }
        : {}),
      documentsDue: docs.get(r.id) ?? [],
      ...(f ? { fuel: f } : {}),
    });
  }
  return out;
}
