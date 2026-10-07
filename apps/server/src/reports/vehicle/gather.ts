import { type Digits, milli, milliOut } from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../../db/scope.js';
import { type FuelSummary, fillsOf, fuelSummary } from '../../fuel/summary.js';
import { notFound } from '../../http/errors.js';
import { gateFor } from '../../serialize/gates.js';
import { correctedValueSql, odometerOf, type VehicleMeter } from '../../vehicles/meters.js';
import { typeNameOf } from '../gather.js';
import type { ReportLocale } from '../labels.js';

// What the vehicle history report holds (step-5 plan T15; D51, D201; Q16), read in the
// requester's scope: the `report` job runs as a tenant job inside withScope() on kept_app, so
// row-level security decides what it can see, as for a request.
//
// - The vehicle: its name, type, short ID, VIN and plate (the built-in `vin` and `plate` fields of
//   `custom`; a secret is never in `custom`, and the secrets store is never read), location, and
//   cover photo.
// - Odometer history, bounded by rows (V39, docs/spikes/2026-09-30-step5-vehicle-report.md: rows
//   drive the render's memory, not photos): every accepted reading that has a proof photo or was
//   typed by hand, plus the latest of each local month. A fill's or a service's own reading also
//   shows in its section. Proof photos: the latest PROOF_LIMIT (the measured load), "N more" past
//   that.
// - Services: confirmed records only (a draft counts nowhere, 0063), each with its reading,
//   vendor, lines and invoice thumbnails (at most INVOICE_THUMBS each).
// - Fuel: fuel/summary.ts's consumption and per-distance cost, and the fills per local year;
//   omitted when the location has `fuel` off.
// - Documents: the vehicle's expiring documents, current and renewed.
// - Money (service totals and lines, fill costs, document costs) only when the requester's gate
//   shows it there (serialize/gates.ts) and the request asked for it; otherwise never read.
// - Photos are thumbnail derivatives (GPS-stripped, D117), never originals.

/** Proof photos printed: the measured load of V39 (200 at five years, ~300 MB). */
export const PROOF_LIMIT = 200;
/** Invoice thumbnails printed per service (the spike's three). */
export const INVOICE_THUMBS = 3;

export type VehicleReportOptions = {
  kind: 'vehicle_history';
  thingId: string;
  /** `YYYY-MM-DD`, inclusive, in the location's days; null for the whole history. */
  from: string | null;
  to: string | null;
  include: { costs: boolean; proofPhotos: boolean; fuel: boolean; documents: boolean };
  locale: ReportLocale;
  digits: Digits;
};

export type GatheredReading = {
  id: string;
  /** The location's day. */
  day: string;
  value: string;
  source: string;
  by: string | null;
  /** A proof photo's thumbnail key, when the reading has one. */
  proofKey: string | null;
};

export type GatheredService = {
  id: string;
  servicedOn: string;
  reading: string | null;
  vendor: string | null;
  notes: string | null;
  by: string | null;
  lines: { description: string; quantity: string | null; unitCost: string | null }[];
  /** Null where money is hidden. */
  money: { total: string | null; currency: string | null } | null;
  invoices: { id: string; thumbKey: string }[];
  moreInvoices: number;
};

export type GatheredDocument = {
  id: string;
  kind: string;
  title: string | null;
  issuedOn: string | null;
  expiresOn: string;
  renewed: boolean;
  money: { cost: string | null; currency: string | null } | null;
};

export type GatheredVehicle = {
  thing: {
    id: string;
    locationId: string;
    name: string;
    typeName: string | null;
    shortCode: string | null;
    vin: string | null;
    plate: string | null;
    lifecycle: string;
    thumbKey: string | null;
  };
  locationName: string;
  locationTimezone: string;
  requesterName: string;
  requesterTimezone: string;
  meter: VehicleMeter | null;
  latest: { value: string; day: string } | null;
  /** Accepted readings in the range, before the bound (the cover counts them). */
  readingCount: number;
  readings: GatheredReading[];
  proofs: GatheredReading[];
  moreProofs: number;
  services: GatheredService[];
  fuel: {
    summary: FuelSummary;
    years: { year: string; fills: number; amounts: { unit: string; amount: string }[] }[];
  } | null;
  documents: GatheredDocument[] | null;
  showMoney: boolean;
  moneyHidden: boolean;
};

type ThingRow = {
  id: string;
  location_id: string;
  name: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  short_code: string | null;
  vin: string | null;
  plate: string | null;
  lifecycle: string;
  thumb_key: string | null;
  location_name: string;
  timezone: string;
};

const THUMB_OF = (subject: string, role: string, id: string) =>
  `(SELECT td.storage_key FROM public.attachments ta
      JOIN public.file_derivatives td ON td.file_id = ta.file_id AND td.variant = 'thumb'
     WHERE ta.${subject} = ${id} AND ta.role = '${role}'
     ORDER BY ta.sort, ta.created_at, ta.id LIMIT 1)`;

/** A day filter on a timestamp column, in the location's zone. */
const inRange = (column: string, tz: string, from: string, to: string) =>
  `(${from}::date IS NULL OR (${column} AT TIME ZONE ${tz})::date >= ${from}::date)
   AND (${to}::date IS NULL OR (${column} AT TIME ZONE ${tz})::date <= ${to}::date)`;

async function readThing(client: pg.ClientBase, id: string): Promise<ThingRow> {
  const { rows } = await client.query<ThingRow>(
    `SELECT t.id, t.location_id, t.name, ty.name AS type_name, ty.builtin_key AS type_builtin_key,
            (SELECT s.code FROM public.short_ids s
              WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1)
              AS short_code,
            nullif(t.custom->>'vin', '') AS vin, nullif(t.custom->>'plate', '') AS plate,
            t.lifecycle, ${THUMB_OF('thing_id', 'photo', 't.id')} AS thumb_key,
            l.name AS location_name, l.timezone
       FROM public.things t
       JOIN public.locations l ON l.id = t.location_id
       LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE t.id = $1 AND t.deleted_at IS NULL AND t.review_state = 'confirmed'`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Everything the report prints, as the requester may see it. */
export async function gatherVehicle(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  options: VehicleReportOptions,
): Promise<GatheredVehicle> {
  const t = await readThing(client, options.thingId);
  const gate = await gateFor(tx, t.location_id, scope);
  const showMoney = options.include.costs && gate.showMoney;
  const { rows: me } = await client.query<{ display_name: string; timezone: string }>(
    'SELECT display_name, timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const meter = await odometerOf(client, t.id);
  const range = [options.from, options.to];

  // Readings: accepted, in range, offset-corrected; the bound is applied below.
  let readings: GatheredReading[] = [];
  let latest: GatheredVehicle['latest'] = null;
  if (meter) {
    const { rows } = await client.query<{
      id: string;
      day: string;
      value: string;
      source: string;
      by: string | null;
      proof_key: string | null;
    }>(
      `SELECT d.id, (d.taken_at AT TIME ZONE $4)::date::text AS day,
              trim_scale(${correctedValueSql('d')})::text AS value,
              -- A service's reading is entered as typed; it is the service's (Q11).
              CASE WHEN EXISTS (SELECT 1 FROM public.service_records sr
                                 WHERE sr.meter_reading_id = d.id)
                   THEN 'service' ELSE d.source END AS source,
              (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = d.logged_by) AS by,
              ${options.include.proofPhotos ? THUMB_OF('meter_reading_id', 'proof', 'd.id') : 'NULL::text'}
                AS proof_key
         FROM public.meter_readings d
        WHERE d.meter_id = $1 AND d.state = 'accepted'
          AND ${inRange('d.taken_at', '$4', '$2', '$3')}
        ORDER BY d.taken_at, d.id`,
      [meter.id, ...range, t.timezone],
    );
    readings = rows.map((r) => ({
      id: r.id,
      day: r.day,
      value: r.value,
      source: r.source,
      by: r.by,
      proofKey: r.proof_key,
    }));
    const last = readings.at(-1);
    if (last) latest = { value: last.value, day: last.day };
  }
  const lastOfMonth = new Map<string, string>();
  for (const r of readings) lastOfMonth.set(r.day.slice(0, 7), r.id);
  const monthly = new Set(lastOfMonth.values());
  const printed = readings.filter(
    (r) => r.proofKey !== null || r.source === 'manual' || monthly.has(r.id),
  );
  const withProof = readings.filter((r) => r.proofKey !== null);
  const proofs = withProof.slice(-PROOF_LIMIT);

  // Services: confirmed, in range, with their lines and invoices.
  const { rows: svc } = await client.query<{
    id: string;
    serviced_on: string;
    reading: string | null;
    vendor: string | null;
    notes: string | null;
    by: string | null;
    total: string | null;
    currency: string | null;
  }>(
    `SELECT r.id, r.serviced_on::text AS serviced_on,
            trim_scale(${correctedValueSql('d')})::text AS reading, v.name AS vendor, r.notes,
            (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = r.logged_by) AS by,
            CASE WHEN $4 THEN trim_scale(r.total)::text END AS total,
            CASE WHEN $4 THEN r.currency END AS currency
       FROM public.service_records r
       LEFT JOIN public.meter_readings d ON d.id = r.meter_reading_id AND d.state = 'accepted'
       LEFT JOIN public.vendors v ON v.id = r.vendor_id
      WHERE r.thing_id = $1 AND r.review_state = 'confirmed'
        AND ($2::date IS NULL OR r.serviced_on >= $2::date)
        AND ($3::date IS NULL OR r.serviced_on <= $3::date)
      ORDER BY r.serviced_on, r.created_at, r.id`,
    [t.id, ...range, showMoney],
  );
  const ids = svc.map((s) => s.id);
  const { rows: lines } = await client.query<{
    service_record_id: string;
    description: string;
    quantity: string | null;
    unit_cost: string | null;
  }>(
    `SELECT l.service_record_id, l.description, trim_scale(l.quantity)::text AS quantity,
            CASE WHEN $2 THEN trim_scale(l.unit_cost)::text END AS unit_cost
       FROM public.service_lines l
      WHERE l.service_record_id = ANY ($1::uuid[])
      ORDER BY l.service_record_id, l.sort, l.created_at, l.id`,
    [ids, showMoney],
  );
  // An invoice is money (files/attachments.ts: a money role): only where money shows.
  const { rows: invoices } = showMoney
    ? await client.query<{ service_record_id: string; id: string; thumb_key: string | null }>(
        `SELECT a.service_record_id, a.id, d.storage_key AS thumb_key
           FROM public.attachments a
           LEFT JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
          WHERE a.service_record_id = ANY ($1::uuid[]) AND a.role = 'invoice'
          ORDER BY a.service_record_id, a.sort, a.created_at, a.id`,
        [ids],
      )
    : { rows: [] };
  const services: GatheredService[] = svc.map((s) => {
    const mine = invoices.filter((i) => i.service_record_id === s.id && i.thumb_key !== null);
    return {
      id: s.id,
      servicedOn: s.serviced_on,
      reading: s.reading,
      vendor: s.vendor,
      notes: s.notes,
      by: s.by,
      lines: lines
        .filter((l) => l.service_record_id === s.id)
        .map((l) => ({ description: l.description, quantity: l.quantity, unitCost: l.unit_cost })),
      money: showMoney ? { total: s.total, currency: s.currency } : null,
      invoices: mine
        .slice(0, INVOICE_THUMBS)
        .map((i) => ({ id: i.id, thumbKey: i.thumb_key as string })),
      moreInvoices: Math.max(0, mine.length - INVOICE_THUMBS),
    };
  });

  // Fuel: the summary (money through its own gate), and the fills per local year in range.
  let fuel: GatheredVehicle['fuel'] = null;
  if (options.include.fuel && gate.modules.has('fuel')) {
    const ctx = { tx, client, scope, requestId: '', files: null, jobs: null };
    const summary = await fuelSummary(ctx, t.id, { window: 5, months: 12 });
    const yearOf = new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone, year: 'numeric' });
    const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone });
    const byYear = new Map<string, { fills: number; amounts: Map<string, bigint> }>();
    for (const f of await fillsOf(client, t.id)) {
      const day = dayOf.format(f.takenAt);
      if ((options.from && day < options.from) || (options.to && day > options.to)) continue;
      const year = yearOf.format(f.takenAt);
      const y = byYear.get(year) ?? { fills: 0, amounts: new Map<string, bigint>() };
      y.fills += 1;
      y.amounts.set(f.unit, (y.amounts.get(f.unit) ?? 0n) + milli(f.amount));
      byYear.set(year, y);
    }
    fuel = {
      summary: showMoney ? summary : withoutMoney(summary),
      years: [...byYear.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([year, y]) => ({
          year,
          fills: y.fills,
          amounts: [...y.amounts.entries()].map(([unit, m]) => ({ unit, amount: milliOut(m) })),
        })),
    };
  }

  // Documents: the vehicle's, current and renewed.
  let documents: GatheredDocument[] | null = null;
  if (options.include.documents) {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      title: string | null;
      issued_on: string | null;
      expires_on: string;
      renewed: boolean;
      cost: string | null;
      currency: string | null;
    }>(
      `SELECT d.id, d.kind, d.title, d.issued_on::text AS issued_on,
              d.expires_on::text AS expires_on, d.superseded_by_id IS NOT NULL AS renewed,
              CASE WHEN $2 THEN trim_scale(d.cost)::text END AS cost,
              CASE WHEN $2 THEN d.currency END AS currency
         FROM public.expiring_documents d
        WHERE d.thing_id = $1
        ORDER BY d.expires_on DESC, d.id`,
      [t.id, showMoney],
    );
    documents = rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      issuedOn: d.issued_on,
      expiresOn: d.expires_on,
      renewed: d.renewed,
      money: showMoney ? { cost: d.cost, currency: d.currency } : null,
    }));
  }

  return {
    thing: {
      id: t.id,
      locationId: t.location_id,
      name: t.name ?? '',
      typeName: typeNameOf(t.type_name, t.type_builtin_key, options.locale),
      shortCode: t.short_code,
      vin: t.vin,
      plate: t.plate,
      lifecycle: t.lifecycle,
      thumbKey: t.thumb_key,
    },
    locationName: t.location_name,
    locationTimezone: t.timezone,
    requesterName: me[0]?.display_name ?? '',
    requesterTimezone: me[0]?.timezone ?? 'UTC',
    meter,
    latest,
    readingCount: readings.length,
    readings: printed,
    proofs,
    moreProofs: withProof.length - proofs.length,
    services,
    fuel,
    documents,
    showMoney,
    moneyHidden: options.include.costs && !gate.showMoney,
  };
}

/** The summary without its money (the gate hid it, or the request left costs out). */
function withoutMoney(s: FuelSummary): FuelSummary {
  return { byUnit: s.byUnit, moneyHidden: true };
}
