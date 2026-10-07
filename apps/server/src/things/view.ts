import {
  type Condition,
  canonicalAmount,
  DERIVED_STATES,
  type DerivedState,
  type LinkKind,
  LOAN_DIRECTIONS,
  type LoanDirection,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  AttachmentSubjectSchema,
  type AttachmentView,
  attachmentViews,
  type DerivativeKeys,
  type FileRow,
  fileViewOf,
} from '../files/views.js';
import { notFound } from '../http/errors.js';
import { type Estimate, EstimateSchema, estimatesOf } from '../meters/estimate.js';
import { currentValueOf } from '../money/valuations.js';
import { type CurrentValue, CurrentValueSchema } from '../money/view.js';
import { derivedStatesOf, householdStateSql, isContainerSql, pathSql } from '../search/query.js';
import { thumbKeysOf, thumbUrlOf } from '../search/service.js';
import {
  customForView,
  type Gate,
  type GatedField,
  gateFor,
  moneyProps,
} from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { moneyShaped } from './audit-image.js';
import { type ResolvedFieldView, resolvedFields } from './fields.js';

// The one thing serialiser (plan T14 view.ts): `ThingRow` for every list, and `ThingView` for the
// detail screen, in the shapes of the web contract (apps/web/src/api/inventory/types.ts). Moves
// (T15), trash and history (T21) and the seed (T23) import it.
//
// Everything is read as the caller on kept_app, so RLS decides what exists. Money leaves only
// through the thing's location gate (serialize/gates.ts): a withheld field is left out, never
// null, and the object that held it carries `moneyHidden: true`. Secret values never leave here
// at all: `secrets` says which fields are set and whether the caller may reveal them (T19's
// routes reveal). A row adds `isContainer` to the contract's ThingRow (T25 decision 3).

// ---------------------------------------------------------------------------------------------
// ThingRow
// ---------------------------------------------------------------------------------------------

export type PathStep = {
  id: string;
  name: string;
  kind: 'place' | 'container';
  isUnplaced: boolean;
  /** The step's primary short ID, so a breadcrumb links by code (D208, T19); absent where a
   * path is built without it (a capture batch's). */
  shortCode?: string | null;
};

export type ThingRow = {
  id: string;
  locationId: string;
  shortCode: string | null;
  name: string | null;
  type: { id: string; icon: string; name: string | null; builtinKey: string | null } | null;
  quantity: number;
  lifecycle: string;
  derivedState: DerivedState[];
  path: PathStep[];
  containerThumbUrl: string | null;
  thumbUrl: string | null;
  lastSeenAt: string | null;
  isContainer: boolean;
};

/** The first photo of `thing` that has a thumbnail (D195). */
const firstThumb = (thing: string) => `(
  SELECT a.file_id FROM public.attachments a
    JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
   WHERE a.thing_id = ${thing} AND a.role = 'photo'
   ORDER BY a.sort, a.created_at, a.id LIMIT 1)`;

/** The columns of a row, over `public.things t LEFT JOIN public.types ty`. */
export const ROW_COLUMNS = `t.id, t.location_id, t.name, t.quantity::text AS quantity, t.lifecycle,
       t.location_uncertain, t.review_state, t.last_seen_at,
       ${pathSql('t.place_id', 't.container_id')} AS path,
       (SELECT s.code FROM public.short_ids s
         WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1) AS short_code,
       ty.id AS type_id, ty.icon AS type_icon, ty.name AS type_name,
       ty.builtin_key AS type_builtin_key,
       ${firstThumb('t.id')} AS thumb_file_id,
       CASE WHEN t.container_id IS NULL THEN NULL ELSE ${firstThumb('t.container_id')} END
         AS container_thumb_file_id,
       ${isContainerSql('t.id', 't.type_id')} AS is_container,
       ${householdStateSql('t')}`;

export type RowRecord = {
  id: string;
  location_id: string;
  name: string | null;
  quantity: string;
  lifecycle: string;
  location_uncertain: boolean;
  review_state: string;
  last_seen_at: Date | null;
  path: {
    id: string;
    name: string | null;
    kind: 'place' | 'container';
    isUnplaced: boolean;
    shortCode?: string | null;
  }[];
  short_code: string | null;
  type_id: string | null;
  type_icon: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  thumb_file_id: string | null;
  container_thumb_file_id: string | null;
  is_container: boolean;
  /** Step 4 (search/query.ts householdStateSql): a claim is in repair (T9). */
  in_repair: boolean;
  /** T10: the open loan's direction (householdStateSql). */
  loan_direction: 'out' | 'in' | null;
};

/** The row's derived states, as every thing list derives them (search/query.ts). */
export function derivedStateOf(r: Parameters<typeof derivedStatesOf>[0]): DerivedState[] {
  return derivedStatesOf(r);
}

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

export async function rowOf(
  files: FileStorage | null,
  keys: DerivativeKeys,
  r: RowRecord,
): Promise<ThingRow> {
  return {
    id: r.id,
    locationId: r.location_id,
    shortCode: r.short_code,
    name: r.name,
    type:
      r.type_id && r.type_icon
        ? { id: r.type_id, icon: r.type_icon, name: r.type_name, builtinKey: r.type_builtin_key }
        : null,
    quantity: Number(r.quantity),
    lifecycle: r.lifecycle,
    derivedState: derivedStateOf(r),
    path: (r.path ?? []).map((s) => ({
      id: s.id,
      name: s.name ?? '',
      kind: s.kind,
      isUnplaced: s.isUnplaced === true,
      shortCode: s.shortCode ?? null,
    })),
    containerThumbUrl: await thumbUrlOf(files, keys, r.container_thumb_file_id),
    thumbUrl: await thumbUrlOf(files, keys, r.thumb_file_id),
    lastSeenAt: iso(r.last_seen_at),
    isContainer: r.is_container,
  };
}

/** The thumbnail keys rows need, read only when there is storage to sign them with. */
async function rowThumbKeys(
  client: pg.ClientBase,
  files: FileStorage | null,
  rows: readonly RowRecord[],
): Promise<DerivativeKeys> {
  if (!files) return new Map();
  return thumbKeysOf(
    client,
    rows.flatMap((r) => [r.thumb_file_id, r.container_thumb_file_id]),
  );
}

/** Rows for `ids`, in that order; ids the caller can't see (or trashed ones) are left out. */
export async function rowsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  ids: readonly string[],
): Promise<ThingRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<RowRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM public.things t LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE t.id = ANY ($1::uuid[]) AND t.deleted_at IS NULL`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keys = await rowThumbKeys(client, files, rows);
  const out: ThingRow[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) out.push(await rowOf(files, keys, r));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ThingView
// ---------------------------------------------------------------------------------------------

export type SecretSummary = {
  fieldKey: string;
  label: string | null;
  set: boolean;
  canReveal: boolean;
};

export type ThingPurchase = {
  purchaseId: string | null;
  purchasedOn: string | null;
  vendor: { id: string; name: string } | null;
  /** Left out with the price when the gate hides money (security review #22). */
  currency?: string | null;
  lineDescription: string | null;
  quantity: number | null;
  unitPrice?: string;
  moneyHidden?: true;
  receipts: AttachmentView[];
};

export type ThingView = ThingRow & {
  brand: { id: string; name: string } | null;
  model: string | null;
  serial: string | null;
  barcode: string | null;
  colour: string | null;
  condition: Condition | null;
  notes: string | null;
  aliases: Record<string, string[]>;
  tags: { id: string; name: string; colour: string | null }[];
  belongsTo: { id: string; displayName: string } | null;
  manualUrl: string | null;
  expiresOn: string | null;
  expiryLeadDays: number | null;
  ended: {
    on: string | null;
    price?: string;
    currency?: string;
    moneyHidden?: true;
    to: string | null;
    notes: string | null;
  } | null;
  acquiredFrom: string | null;
  provenanceNotes: string | null;
  locationUncertain: boolean;
  reviewState: 'draft' | 'confirmed';
  fieldStatus: Record<string, unknown>;
  fields: ResolvedFieldView[];
  custom: Record<string, unknown>;
  archivedCustom: Record<string, unknown>;
  secrets: SecretSummary[];
  placeId: string | null;
  containerId: string | null;
  contentsCount: number;
  purchase: ThingPurchase | null;
  photos: AttachmentView[];
  attachmentsCount: number;
  meters: {
    id: string;
    kind: string;
    unit: string;
    label: string | null;
    latest: { value: string; takenAt: string } | null;
    needsReview: number;
    /** For PATCH /api/v1/meters/:id (If-Match), T16. */
    rowVersion: number;
    /** Step 5 (T8, Q8): the usage estimate, kept.meter_estimate(). */
    estimate: Estimate;
    /** Step 5 (Q19): the stale-reading nudge's days, or null for none. */
    nudgeDays: number | null;
  }[];
  links: { id: string; kind: LinkKind; direction: 'from' | 'to'; thing: ThingRow }[];
  /** Set when this caller's gate withholds money here (custom money values are left out). */
  moneyHidden?: true;
  /** Step 4, T8 (D158): the newest valuation, gated; null for none; absent with Money off. */
  currentValue?: CurrentValue | null;
  /** Step 4, T9 (D54): the claim in repair, "at <vendor>"; null when none is. */
  repairAt: { vendorName: string | null } | null;
  /** Step 4, T10 (D57): the open loan, "with Murdock since 3 Oct · due 17 Oct" (the web words it);
   * a person's name only, never a contact detail (Q34). Null when it isn't on loan. */
  loanLine: ThingLoanLine | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

type DetailRecord = RowRecord & {
  place_id: string | null;
  container_id: string | null;
  brand_id: string | null;
  brand_name: string | null;
  model: string | null;
  serial: string | null;
  barcode: string | null;
  colour: string | null;
  condition: Condition | null;
  notes: string | null;
  aliases: Record<string, string[]> | null;
  person_id: string | null;
  person_name: string | null;
  manual_url: string | null;
  expires_on: string | null;
  expiry_lead_days: number | null;
  ended_on: string | null;
  ended_price: string | null;
  ended_currency: string | null;
  ended_to: string | null;
  ended_notes: string | null;
  acquired_from: string | null;
  provenance_notes: string | null;
  field_status: Record<string, unknown> | null;
  custom: Record<string, unknown> | null;
  archived_custom: Record<string, unknown> | null;
  purchase_line_id: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  contents_count: number;
  attachments_count: number;
  /** Its receipts and invoices (files/views.ts MONEY_ROLES), not counted where money is hidden. */
  money_attachments_count: number;
};

/** The detail of a live thing the caller can see; 404 otherwise. */
export async function viewOf(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  thingId: string,
): Promise<ThingView> {
  const { rows } = await client.query<DetailRecord>(
    `SELECT ${ROW_COLUMNS},
            t.place_id, t.container_id, t.brand_id, b.name AS brand_name, t.model, t.serial,
            t.barcode, t.colour, t.condition, t.notes, t.aliases,
            t.belongs_to_person_id AS person_id, p.display_name AS person_name,
            t.manual_url, t.expires_on::text AS expires_on, t.expiry_lead_days,
            t.ended_on::text AS ended_on, t.ended_price::text AS ended_price,
            t.ended_currency::text AS ended_currency, t.ended_to, t.ended_notes,
            t.acquired_from, t.provenance_notes, t.field_status, t.custom, t.archived_custom,
            t.purchase_line_id, t.row_version, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM public.things c
              WHERE c.container_id = t.id AND c.deleted_at IS NULL) AS contents_count,
            (SELECT count(*)::int FROM public.attachments a WHERE a.thing_id = t.id)
              AS attachments_count,
            (SELECT count(*)::int FROM public.attachments a
              WHERE a.thing_id = t.id AND a.role IN ('receipt', 'invoice'))
              AS money_attachments_count
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
       LEFT JOIN public.brands b ON b.id = t.brand_id
       LEFT JOIN public.people p ON p.id = t.belongs_to_person_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [thingId],
  );
  const r = rows[0];
  if (!r) throw notFound();
  const gate = await gateFor(tx, r.location_id, scope);
  const fields = await resolvedFields(client, r.type_id);

  // One after another: they share the request's connection.
  const tags = await tagsOf(client, r.id);
  const secrets = await secretsOf(client, gate, r.id, r.location_id, fields);
  const purchase = r.purchase_line_id ? await purchaseOf(client, files, gate, r.id) : null;
  const photos = await photosOf(client, files, r.id);
  const meters = await metersOf(client, r.id);
  const links = await linksOf(client, files, r.id);
  const currentValue = await currentValueOf(client, gate, r.id);
  const repairAt = r.in_repair ? await repairAtOf(client, r.id) : null;
  const loanLine = r.loan_direction ? await loanLineOf(client, r.id) : null;

  const row = await rowOf(files, await rowThumbKeys(client, files, [r]), r);
  const ended =
    r.lifecycle === 'in_use'
      ? null
      : {
          on: r.ended_on,
          ...moneyProps(gate, {
            price: canonicalAmount(r.ended_price),
            currency: r.ended_currency,
          }),
          to: r.ended_to,
          notes: r.ended_notes,
        };
  // Values are gated as their fields are, except that a value shaped like money (or a list
  // holding one) is money whatever its field says, and an archived value whose field is gone
  // entirely is shown only if it isn't shaped like money (security review #19: a re-type or a
  // stray key must never turn an amount into plain text).
  const customDefs = moneyAwareDefs(fields, r.custom, false);
  const archivedDefs = moneyAwareDefs(fields, r.archived_custom, true);
  return {
    ...row,
    brand: r.brand_id && r.brand_name ? { id: r.brand_id, name: r.brand_name } : null,
    model: r.model,
    serial: r.serial,
    barcode: r.barcode,
    colour: r.colour,
    condition: r.condition,
    notes: r.notes,
    aliases: r.aliases ?? {},
    tags,
    belongsTo:
      r.person_id && r.person_name ? { id: r.person_id, displayName: r.person_name } : null,
    manualUrl: r.manual_url,
    expiresOn: r.expires_on,
    expiryLeadDays: r.expiry_lead_days,
    ended,
    acquiredFrom: r.acquired_from,
    provenanceNotes: r.provenance_notes,
    locationUncertain: r.location_uncertain,
    reviewState: r.review_state as 'draft' | 'confirmed',
    fieldStatus: r.field_status ?? {},
    fields,
    custom: customForView(gate, customDefs, r.custom),
    archivedCustom: customForView(gate, archivedDefs, r.archived_custom),
    secrets,
    placeId: r.place_id,
    containerId: r.container_id,
    contentsCount: r.contents_count,
    purchase,
    photos,
    attachmentsCount: gate.showMoney
      ? r.attachments_count
      : r.attachments_count - r.money_attachments_count,
    meters,
    links,
    ...(gate.showMoney ? {} : { moneyHidden: true as const }),
    ...(currentValue === undefined ? {} : { currentValue }),
    repairAt,
    loanLine,
    rowVersion: r.row_version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Where a thing in repair is: its claim's vendor (D54, screens §8 "at <service centre>"). */
async function repairAtOf(
  client: pg.ClientBase,
  thingId: string,
): Promise<{ vendorName: string | null }> {
  const { rows } = await client.query<{ name: string | null }>(
    `SELECT v.name FROM public.claims c LEFT JOIN public.vendors v ON v.id = c.vendor_id
      WHERE c.thing_id = $1 AND c.status = 'in_repair' LIMIT 1`,
    [thingId],
  );
  return { vendorName: rows[0]?.name ?? null };
}

export type ThingLoanLine = {
  direction: LoanDirection;
  personName: string;
  startedAt: string;
  dueOn: string | null;
  overdue: boolean;
};

/** The thing's open loan (D57): whom it is with, since when, and when it is due, overdue on the
 * location's own date (§7.13). */
async function loanLineOf(client: pg.ClientBase, thingId: string): Promise<ThingLoanLine | null> {
  const { rows } = await client.query<{
    direction: LoanDirection;
    name: string | null;
    started_at: Date;
    due_on: string | null;
    overdue: boolean;
  }>(
    `SELECT o.direction, pe.display_name AS name, o.started_at, o.due_on::text AS due_on,
            (o.due_on IS NOT NULL AND (now() AT TIME ZONE l.timezone)::date > o.due_on) AS overdue
       FROM public.loans o
       JOIN public.locations l ON l.id = o.location_id
       LEFT JOIN public.people pe ON pe.id = o.person_id
      WHERE o.thing_id = $1 AND o.returned_at IS NULL LIMIT 1`,
    [thingId],
  );
  const o = rows[0];
  if (!o) return null;
  return {
    direction: o.direction,
    personName: o.name ?? '',
    startedAt: o.started_at.toISOString(),
    dueOn: o.due_on,
    overdue: o.overdue,
  };
}

/** The field definitions `customForView()` gates `values` by: each key's field, classed money
 * when its value is money-shaped (audit-image.ts's `moneyShaped()`: arrays too). A key no field
 * defines gets a stand-in (text, or money when money-shaped) only with `standIns` (archived
 * values); otherwise it stays undefined, and customForView() drops it (fail closed). */
function moneyAwareDefs(
  fields: readonly ResolvedFieldView[],
  values: Readonly<Record<string, unknown>> | null | undefined,
  standIns: boolean,
): GatedField[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: GatedField[] = [];
  for (const [key, v] of Object.entries(values ?? {})) {
    const field = byKey.get(key);
    if (!field && !standIns) continue;
    out.push({
      key,
      kind: moneyShaped(v) ? 'money' : (field?.kind ?? 'text'),
      secret: field?.secret ?? false,
    });
  }
  return out;
}

async function tagsOf(client: pg.ClientBase, thingId: string): Promise<ThingView['tags']> {
  const { rows } = await client.query<{ id: string; name: string; colour: string | null }>(
    `SELECT g.id, g.name, g.colour FROM public.thing_tags x JOIN public.tags g ON g.id = x.tag_id
      WHERE x.thing_id = $1 ORDER BY lower(g.name), g.id`,
    [thingId],
  );
  return rows;
}

/**
 * Every secret field of the type, and any other field with a value stored: whether a value is
 * set, and whether this caller may reveal it (the secrets module on, then the field's policy:
 * kept.can_reveal_secret, D116, D177). Never a value.
 */
async function secretsOf(
  client: pg.ClientBase,
  gate: Gate,
  thingId: string,
  locationId: string,
  fields: readonly ResolvedFieldView[],
): Promise<SecretSummary[]> {
  const secretFields = fields.filter((f) => f.secret && f.archivedAt === null);
  const { rows: set } = await client.query<{
    type_field_id: string;
    field_key: string;
    can_reveal: boolean;
  }>('SELECT type_field_id, field_key, can_reveal FROM kept.secret_fields_set($1, NULL)', [
    thingId,
  ]);
  const setKeys = new Map(set.map((s) => [s.field_key, s]));
  const unsetIds = secretFields.filter((f) => !setKeys.has(f.key)).map((f) => f.id);
  const reveal = new Map<string, boolean>();
  if (unsetIds.length > 0) {
    const { rows } = await client.query<{ id: string; ok: boolean }>(
      'SELECT f.id, kept.can_reveal_secret($1, f.id) AS ok FROM unnest($2::uuid[]) AS f(id)',
      [locationId, unsetIds],
    );
    for (const x of rows) reveal.set(x.id, x.ok);
  }
  const out: SecretSummary[] = secretFields.map((f) => {
    const s = setKeys.get(f.key);
    return {
      fieldKey: f.key,
      label: f.label,
      set: s !== undefined,
      canReveal: gate.showSecrets && (s ? s.can_reveal : (reveal.get(f.id) ?? false)),
    };
  });
  for (const s of set) {
    if (secretFields.some((f) => f.key === s.field_key)) continue;
    out.push({
      fieldKey: s.field_key,
      label: fields.find((f) => f.key === s.field_key)?.label ?? null,
      set: true,
      canReveal: gate.showSecrets && s.can_reveal,
    });
  }
  return out;
}

type PurchaseRecord = {
  purchase_id: string;
  location_id: string;
  purchased_on: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  currency: string | null;
  line_description: string | null;
  line_quantity: string | null;
  unit_price: string | null;
  visible_purchase: boolean;
};

/**
 * The purchase a thing came from (kept.thing_purchase(), D115): wherever the purchase is, even in
 * a location the caller can't open after a move within the account. Then `purchaseId` is null
 * (the whole purchase isn't theirs to open); the vendor comes from the definer by id (0027), in
 * the thing's account, where the move keeps it. Money is gated by the *thing's* location: the
 * unit price, the currency, and the receipts and invoices (a receipt shows the price; security
 * review #1, #22) are all left out when the gate hides money.
 */
async function purchaseOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  gate: Gate,
  thingId: string,
): Promise<ThingPurchase | null> {
  const { rows } = await client.query<PurchaseRecord>(
    `SELECT purchase_id, location_id, purchased_on::text AS purchased_on, vendor_id, vendor_name,
            currency, line_description, line_quantity::text AS line_quantity,
            unit_price::text AS unit_price, visible_purchase
       FROM kept.thing_purchase($1)`,
    [thingId],
  );
  const p = rows[0];
  if (!p) return null;
  const vendor: ThingPurchase['vendor'] =
    p.vendor_id !== null && p.vendor_name !== null
      ? { id: p.vendor_id, name: p.vendor_name }
      : null;
  return {
    purchaseId: p.visible_purchase ? p.purchase_id : null,
    purchasedOn: p.purchased_on,
    vendor,
    lineDescription: p.line_description,
    quantity: p.line_quantity === null ? null : Number(p.line_quantity),
    ...(gate.showMoney ? { currency: p.currency } : {}),
    ...moneyProps(gate, { unitPrice: canonicalAmount(p.unit_price) }),
    receipts: gate.showMoney ? await receiptsOf(client, files, thingId) : [],
  };
}

/**
 * A thing's receipts and invoices, from kept.thing_receipts() (D115), not from a read of the
 * attachments: after a move within the account the purchase, and its receipts, stay in a location
 * the caller may not see (security review #12). A receipt the caller can read is its full view; one
 * they can't is built from the definer's row (0033: the file's metadata and its derivative keys,
 * signed here for the caller, D157), so it gets the same previews. Its original is served only
 * through kept.thing_receipt_file(), to a member or above of the thing's location (D117). The
 * caller checks the gate.
 */
async function receiptsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  thingId: string,
): Promise<AttachmentView[]> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT attachment_id, file_id, role, sort, sha256, bytes::text AS bytes, mime, class,
            has_gps, width, height, derivative_state, thumb_key, display_key
       FROM kept.thing_receipts($1)`,
    [thingId],
  );
  if (rows.length === 0) return [];
  const { rows: readable } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.id = ANY ($1::uuid[])`,
    [rows.map((r) => r.attachment_id)],
  );
  const full = new Map(
    (await attachmentViews(client, files, readable)).map((v) => [v.id, v] as const),
  );
  const out: AttachmentView[] = [];
  for (const r of rows) {
    const seen = full.get(r.attachment_id);
    if (seen?.file) {
      out.push(seen);
      continue;
    }
    const keys: DerivativeKeys = new Map([
      [
        r.file_id,
        new Map(
          [
            ['thumb', r.thumb_key],
            ['display', r.display_key],
          ].filter((e): e is [string, string] => e[1] !== null),
        ),
      ],
    ]);
    const file = await fileViewOf(
      files,
      {
        id: r.file_id,
        location_id: '',
        storage_key: '',
        sha256: r.sha256,
        bytes: r.bytes,
        mime: r.mime,
        class: r.class,
        has_gps: r.has_gps,
        width: r.width,
        height: r.height,
        derivative_state: r.derivative_state,
        created_by: '',
      },
      keys,
    );
    out.push({
      id: r.attachment_id,
      role: r.role as AttachmentView['role'],
      sort: r.sort,
      file,
      url: null,
      subject: { thingId },
      createdBy: { displayName: '' },
      rowVersion: 0,
    });
  }
  return out;
}

/** A row of kept.thing_receipts() (0033). */
type ReceiptRow = {
  attachment_id: string;
  file_id: string;
  role: string;
  sort: number;
  sha256: string;
  bytes: string;
  mime: string;
  class: FileRow['class'];
  has_gps: boolean;
  width: number | null;
  height: number | null;
  derivative_state: FileRow['derivative_state'];
  thumb_key: string | null;
  display_key: string | null;
};

async function photosOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  thingId: string,
): Promise<AttachmentView[]> {
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.thing_id = $1 AND a.role = 'photo'
      ORDER BY a.sort, a.created_at, a.id LIMIT 50`,
    [thingId],
  );
  return attachmentViews(client, files, rows);
}

async function metersOf(client: pg.ClientBase, thingId: string): Promise<ThingView['meters']> {
  const { rows } = await client.query<{
    id: string;
    kind: string;
    unit: string;
    label: string | null;
    value: string | null;
    taken_at: Date | null;
    needs_review: number;
    row_version: number;
    nudge_days: number | null;
  }>(
    `SELECT m.id, m.kind, m.unit, m.label, trim_scale(l.value)::text AS value, l.taken_at,
            m.row_version, m.nudge_days,
            (SELECT count(*)::int FROM public.meter_readings r
              WHERE r.meter_id = m.id AND r.state = 'needs_review') AS needs_review
       FROM public.meters m
       LEFT JOIN LATERAL (
         SELECT r.value, r.taken_at FROM public.meter_readings r
          WHERE r.meter_id = m.id AND r.state = 'accepted'
          ORDER BY r.taken_at DESC, r.id DESC LIMIT 1) l ON true
      WHERE m.thing_id = $1
      ORDER BY m.created_at, m.id`,
    [thingId],
  );
  const estimates = await estimatesOf(
    client,
    rows.map((m) => m.id),
  );
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    unit: m.unit,
    label: m.label,
    latest:
      m.value !== null && m.taken_at ? { value: m.value, takenAt: m.taken_at.toISOString() } : null,
    needsReview: m.needs_review,
    rowVersion: m.row_version,
    estimate: estimates.get(m.id) ?? {
      perDay: null,
      basisDays: null,
      ageDays: null,
      advice: 'none' as const,
    },
    nudgeDays: m.nudge_days,
  }));
}

async function linksOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  thingId: string,
): Promise<ThingView['links']> {
  const { rows } = await client.query<{
    id: string;
    kind: LinkKind;
    direction: 'from' | 'to';
    other: string;
  }>(
    `SELECT k.id, k.kind, 'from' AS direction, k.to_thing_id AS other
       FROM public.thing_links k WHERE k.from_thing_id = $1
     UNION ALL
     SELECT k.id, k.kind, 'to', k.from_thing_id
       FROM public.thing_links k WHERE k.to_thing_id = $1
     ORDER BY 1`,
    [thingId],
  );
  const others = await rowsOf(
    client,
    files,
    rows.map((r) => r.other),
  );
  const byId = new Map(others.map((o) => [o.id, o]));
  return rows.flatMap((r) => {
    const thing = byId.get(r.other);
    return thing ? [{ id: r.id, kind: r.kind, direction: r.direction, thing }] : [];
  });
}

/** One link as POST …/links answers it. */
export async function linkViewOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  link: { id: string; kind: LinkKind; toThingId: string },
): Promise<ThingView['links'][number]> {
  const [thing] = await rowsOf(client, files, [link.toThingId]);
  if (!thing) throw notFound();
  return { id: link.id, kind: link.kind, direction: 'from', thing };
}

// ---------------------------------------------------------------------------------------------
// Response schemas (Fastify serialises through these; extra keys would be dropped, so every key
// the contract names is here)
// ---------------------------------------------------------------------------------------------

const Iso = z.string();
export const PathStepSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
  shortCode: z.string().nullable().optional(),
});
export const ThingRowSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  shortCode: z.string().nullable(),
  name: z.string().nullable(),
  type: z
    .object({
      id: z.uuid(),
      icon: z.string(),
      name: z.string().nullable(),
      builtinKey: z.string().nullable(),
    })
    .nullable(),
  quantity: z.number(),
  lifecycle: z.string(),
  derivedState: z.array(z.enum(DERIVED_STATES)),
  path: z.array(PathStepSchema),
  containerThumbUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  lastSeenAt: Iso.nullable(),
  isContainer: z.boolean(),
});
const FileViewSchema = z.object({
  id: z.uuid(),
  sha256: z.string(),
  bytes: z.number(),
  mime: z.string(),
  class: z.string(),
  hasGps: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  derivativeState: z.string(),
  thumbUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
});
const AttachmentSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  sort: z.number(),
  file: FileViewSchema.nullable(),
  url: z.string().nullable(),
  subject: AttachmentSubjectSchema,
  createdBy: z.object({ displayName: z.string() }),
  rowVersion: z.number(),
});
const ResolvedFieldSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string().nullable(),
  labelKey: z.string().nullable(),
  kind: z.string(),
  unit: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  repeatable: z.boolean(),
  required: z.boolean(),
  secret: z.boolean(),
  sort: z.number(),
  archivedAt: Iso.nullable(),
  source: z.object({ typeId: z.uuid(), via: z.enum(['own', 'inherited', 'group']) }),
  rowVersion: z.number(),
});
export const LinkSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  direction: z.enum(['from', 'to']),
  thing: ThingRowSchema,
});
export const ThingViewSchema = ThingRowSchema.extend({
  brand: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  barcode: z.string().nullable(),
  colour: z.string().nullable(),
  condition: z.string().nullable(),
  notes: z.string().nullable(),
  aliases: z.record(z.string(), z.array(z.string())),
  tags: z.array(z.object({ id: z.uuid(), name: z.string(), colour: z.string().nullable() })),
  belongsTo: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  manualUrl: z.string().nullable(),
  expiresOn: z.string().nullable(),
  expiryLeadDays: z.number().nullable(),
  ended: z
    .object({
      on: z.string().nullable(),
      price: z.string().optional(),
      currency: z.string().optional(),
      moneyHidden: z.literal(true).optional(),
      to: z.string().nullable(),
      notes: z.string().nullable(),
    })
    .nullable(),
  acquiredFrom: z.string().nullable(),
  provenanceNotes: z.string().nullable(),
  locationUncertain: z.boolean(),
  reviewState: z.enum(['draft', 'confirmed']),
  fieldStatus: z.record(z.string(), z.unknown()),
  fields: z.array(ResolvedFieldSchema),
  custom: z.record(z.string(), z.unknown()),
  archivedCustom: z.record(z.string(), z.unknown()),
  secrets: z.array(
    z.object({
      fieldKey: z.string(),
      label: z.string().nullable(),
      set: z.boolean(),
      canReveal: z.boolean(),
    }),
  ),
  placeId: z.uuid().nullable(),
  containerId: z.uuid().nullable(),
  contentsCount: z.number(),
  purchase: z
    .object({
      purchaseId: z.uuid().nullable(),
      purchasedOn: z.string().nullable(),
      vendor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      currency: z.string().nullable().optional(),
      lineDescription: z.string().nullable(),
      quantity: z.number().nullable(),
      unitPrice: z.string().optional(),
      moneyHidden: z.literal(true).optional(),
      receipts: z.array(AttachmentSchema),
    })
    .nullable(),
  photos: z.array(AttachmentSchema),
  attachmentsCount: z.number(),
  meters: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      unit: z.string(),
      label: z.string().nullable(),
      latest: z.object({ value: z.string(), takenAt: Iso }).nullable(),
      needsReview: z.number(),
      rowVersion: z.number(),
      estimate: EstimateSchema,
      nudgeDays: z.number().nullable(),
    }),
  ),
  links: z.array(LinkSchema),
  moneyHidden: z.literal(true).optional(),
  currentValue: CurrentValueSchema.nullable().optional(),
  repairAt: z.object({ vendorName: z.string().nullable() }).nullable(),
  loanLine: z
    .object({
      direction: z.enum(LOAN_DIRECTIONS),
      personName: z.string(),
      startedAt: Iso,
      dueOn: z.string().nullable(),
      overdue: z.boolean(),
    })
    .nullable(),
  rowVersion: z.number(),
  createdAt: Iso,
  updatedAt: Iso,
});
