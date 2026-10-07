import {
  type CAPTURE_MODES,
  canonicalAmount,
  EXTRACTION_STATUSES,
  INBOX_KINDS,
  type InboxKind,
  normalize,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { CALL_COLUMNS, type CallRow, CallSummary, callSummaryOf } from '../extraction/routes.js';
import { type PageRequest, pageOf } from '../http/conventions.js';
import { forbidden, invalid } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { thumbKeysOf, thumbUrlOf } from '../search/service.js';
import { type Gate, gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { type PathStep, rowsOf, type ThingRow, ThingRowSchema } from '../things/view.js';

// The review inbox on the wire (plan T15; D18, D19, D36, D175, D191; screens §5, §8). The web
// contract is apps/web/src/api/capture/types.ts "inbox (T15)": InboxItem, InboxPage, InboxParams.
//
// GET /api/v1/inbox?locationId&mine(default 1)&kind&batchId&q&cursor&limit
//   → {items: InboxItem[], counts: {byKind, mine, everyone}, next_cursor}
//
// - Read as the caller on kept_app: inbox_items' policy shows items of writable locations only
//   (members and above), so a viewer's location has no inbox. Asked for a location, a viewer gets
//   403 and an invisible location 404. Without one the list is global across the caller's writable
//   locations; every account owns its Personal location, so that list is never refused.
// - "Mine" (the default) is `created_by = me`; `mine=0` is everyone's.
// - Open items only, and never one whose subject is in the trash: a draft trashed by "Undo this
//   batch", or by hand, keeps its item open (the undo of that brings both back), hidden here.
// - Ordered by capture batch, newest batch first, then newest item first. A batch's time is its
//   earliest open item's, so the order is the inbox's own and a page is one indexed read of the
//   open items (inbox_open_loc_idx / inbox_open_mine_idx), never a scan of things.
// - `q` (the list standard's search, L88) matches the draft's name, brand and model, a receipt's
//   vendor (as seen and as chosen) and line text, a reading's meter, the subject's place, a label
//   claim's target and a sync drop's entity, normalised (the shared normaliser, D42) and as a
//   substring. It filters the open items, joined to their subjects by primary key: the match
//   never runs over the things table, so it needs no index door (§7.2).
// - `counts` ignore `kind`, `batchId`, `q` and the cursor: `byKind` counts the scope ("Mine" or
//   everyone's, the location), `mine` and `everyone` the location's. The web hides zero chips.
// - Money follows the gate of the item's location: a receipt's total, tax and prices are omitted,
//   with `moneyHidden: true`, where it hides money, and so are its pages (a receipt shows the
//   price, as on the purchase view) and a money suggestion.
// - A currency question carries its receipt's summary too (`receipt`: the shop as read, the total
//   and the pages, under the same gate), so it reads as "ACE HARDWARE receipt · Total $ 312.5".

export const Flag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

export const InboxQuery = z.object({
  locationId: z.uuid().optional(),
  mine: Flag.optional(),
  kind: z.enum(INBOX_KINDS).optional(),
  batchId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().max(2048).optional(),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

const Photo = z.object({ fileId: z.uuid(), thumbUrl: z.string().nullable() });
const PathStepSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
});
const FieldStatus = z.object({
  state: z.enum(['manual', 'extracted', 'confirmed']),
  confidence: z.number().optional(),
});
const SuggestionSchema = z.object({
  field: z.string(),
  value: z.unknown(),
  confidence: z.number(),
  source: z.object({ extractionId: z.uuid(), attachmentId: z.uuid() }),
});
const ReceiptLineSchema = z.object({
  index: z.number(),
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string().optional(),
});
const Actor = z.object({ displayName: z.string() });

export const InboxItemSchema = z.object({
  id: z.uuid(),
  kind: z.enum(INBOX_KINDS),
  locationId: z.uuid(),
  createdAt: z.string(),
  createdBy: Actor,
  rowVersion: z.number(),
  batch: z
    .object({
      id: z.uuid(),
      capturedAt: z.string(),
      placePath: z.array(PathStepSchema),
      count: z.number(),
    })
    .nullable(),
  thing: ThingRowSchema.extend({
    brand: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    model: z.string().nullable(),
    colour: z.string().nullable(),
    serial: z.string().nullable(),
    photos: z.array(Photo),
    fieldStatus: z.record(z.string(), FieldStatus),
  }).optional(),
  suggestions: z.array(SuggestionSchema).optional(),
  extraction: z
    .object({
      id: z.uuid(),
      status: z.enum(EXTRACTION_STATUSES),
      statusReason: z.string().optional(),
      pausedUntil: z.string().optional(),
      call: CallSummary.nullable().optional(),
    })
    .optional(),
  receipt: z
    .object({
      purchaseId: z.uuid(),
      pages: z.array(Photo),
      vendorSeen: z.string().optional(),
      purchasedOn: z.string().optional(),
      currency: z.string().optional(),
      total: z.string().optional(),
      tax: z.string().optional(),
      lines: z.array(ReceiptLineSchema),
      flagged: z.boolean(),
      moneyHidden: z.literal(true).optional(),
    })
    .optional(),
  reading: z
    .object({
      meter: z.object({ id: z.uuid(), label: z.string().nullable(), unit: z.string() }),
      value: z.string(),
      takenAt: z.string(),
      reason: z.string(),
      neighbours: z.object({
        before: z.object({ value: z.string(), takenAt: z.string() }).optional(),
        after: z.object({ value: z.string(), takenAt: z.string() }).optional(),
      }),
      proofThumbUrl: z.string().nullable(),
    })
    .optional(),
  duplicate: z
    .object({ other: ThingRowSchema, reason: z.enum(['serial', 'brand_model_place']) })
    .optional(),
  claim: z
    .object({
      code: z.string(),
      claimedFor: z.object({
        kind: z.enum(['thing', 'place']),
        id: z.uuid(),
        name: z.string(),
      }),
    })
    .optional(),
  currency: z.object({ seen: z.string(), options: z.array(z.string()) }).optional(),
  syncDrop: z
    .object({
      op: z.unknown(),
      reason: z.string(),
      entity: z.object({ type: z.string(), id: z.uuid(), name: z.string() }).optional(),
      by: Actor.optional(),
    })
    .optional(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

const Counts = z.object({
  byKind: z.record(z.enum(INBOX_KINDS), z.number()),
  mine: z.number(),
  everyone: z.number(),
});

export const InboxPageSchema = z.object({
  items: z.array(InboxItemSchema),
  counts: Counts,
  next_cursor: z.string().nullable(),
});
export type InboxPage = z.infer<typeof InboxPageSchema>;

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** An open item as the routes read it. */
export type ItemRow = {
  id: string;
  location_id: string;
  kind: InboxKind;
  thing_id: string | null;
  purchase_id: string | null;
  meter_reading_id: string | null;
  extraction_id: string | null;
  other_thing_id: string | null;
  code: string | null;
  batch_id: string | null;
  created_by: string;
  created_by_name: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  row_version: number;
};

export const ITEM_COLUMNS = `i.id, i.location_id, i.kind, i.thing_id, i.purchase_id,
  i.meter_reading_id, i.extraction_id, i.other_thing_id, i.code::text AS code, i.batch_id,
  i.created_by, i.payload, i.created_at, i.row_version`;

/**
 * Open, and its subject not in the trash (over `public.inbox_items i`). A draft trashed by "Undo
 * this batch" keeps its item open: hidden here, back with the draft when that is undone.
 */
export const LIVE_SUBJECT = `i.resolved_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.things t
                   WHERE t.id IN (i.thing_id, i.other_thing_id) AND t.deleted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM public.meter_readings r
                    JOIN public.meters m ON m.id = r.meter_id
                    JOIN public.things t ON t.id = m.thing_id
                   WHERE r.id = i.meter_reading_id AND t.deleted_at IS NOT NULL)`;

type ListRow = ItemRow & { sort_at: string; group_key: string };

/** The resume key: the page's last batch time (full precision, as text), group and id. */
type Key = [string, string, string];

/** A LIKE pattern matching `q` anywhere, normalised as kept.normalize() does (D42). */
function containsPattern(q: string): string | null {
  const n = normalize(q);
  if (!n) return null;
  return `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * What `q` is matched against, per item (see the header): the subject's words, each read by a
 * scalar subquery on a primary key. A qual holding a subquery or a JSON operator isn't leakproof,
 * so under the policies it can't be an index condition (§7.2); the subjects' ids are therefore
 * worked out first, a layer at a time (SUBJECT_LAYERS, materialised), and the lookups below
 * compare a key with a plain column of the item.
 */
const SUBJECT_LAYERS = `,
     located AS MATERIALIZED (
       SELECT f.*, (f.payload->>'meterId')::uuid AS payload_meter,
              (SELECT r.meter_id FROM public.meter_readings r WHERE r.id = f.meter_reading_id)
                AS reading_meter
         FROM filtered f),
     metered AS MATERIALIZED (
       SELECT l.*, coalesce(l.reading_meter, l.payload_meter) AS subject_meter FROM located l),
     subjects AS MATERIALIZED (
       SELECT m.*, coalesce(m.thing_id,
                            (SELECT x.thing_id FROM public.meters x WHERE x.id = m.subject_meter))
                     AS subject_thing
         FROM metered m)`;
const SEARCH_TEXT = `kept.normalize(concat_ws(' ',
    (SELECT concat_ws(' ', st.name, sb.name, st.model,
              (SELECT string_agg(e->>'name', ' ')
                 FROM jsonb_array_elements(kept.path_of(st.place_id, st.container_id)) e))
       FROM public.things st LEFT JOIN public.brands sb ON sb.id = st.brand_id
      WHERE st.id = s.subject_thing),
    s.payload->>'vendorSeen',
    (SELECT concat_ws(' ', v.name,
              (SELECT string_agg(pl.description, ' ') FROM public.purchase_lines pl
                WHERE pl.purchase_id = p.id))
       FROM public.purchases p LEFT JOIN public.vendors v ON v.id = p.vendor_id
      WHERE p.id = s.purchase_id),
    (SELECT m.label FROM public.meters m WHERE m.id = s.subject_meter),
    s.payload->'claimedFor'->>'name',
    s.payload->'entity'->>'name'))`;

/** 403/404 for a location the caller may not review; nothing for a global list. */
async function requireReviewer(client: pg.ClientBase, locationId: string | null): Promise<void> {
  if (!locationId) {
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM kept.writable_location_ids()',
    );
    if ((rows[0]?.n ?? 0) === 0) throw forbidden('Viewers have no inbox.');
    return;
  }
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'things.edit', 'Viewers have no inbox.');
}

/** GET /api/v1/inbox. */
export async function listInbox(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  query: InboxQuery,
  page: PageRequest<Key>,
): Promise<InboxPage> {
  const locationId = query.locationId?.toLowerCase() ?? null;
  await requireReviewer(client, locationId);
  const mine = query.mine ?? true;
  const after = page.after;
  if (
    after !== null &&
    !(
      Array.isArray(after) &&
      after.length === 3 &&
      after.every((x) => typeof x === 'string') &&
      !Number.isNaN(Date.parse(after[0])) &&
      z.uuid().safeParse(after[1]).success &&
      z.uuid().safeParse(after[2]).success
    )
  ) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  const pattern = query.q ? containsPattern(query.q) : null;

  const values: unknown[] = [
    locationId,
    mine,
    query.kind ?? null,
    query.batchId?.toLowerCase() ?? null,
    after?.[0] ?? null,
    after?.[1] ?? null,
    after?.[2] ?? null,
    page.limit + 1,
  ];
  if (pattern) values.push(pattern);
  const { rows } = await client.query<ListRow>(
    `WITH scope AS (
       SELECT ${ITEM_COLUMNS},
              min(i.created_at) OVER (PARTITION BY coalesce(i.batch_id, i.id)) AS sort_at
         FROM public.inbox_items i
        WHERE ${LIVE_SUBJECT}
          AND ($1::uuid IS NULL OR i.location_id = $1::uuid)
          AND (NOT $2::boolean OR i.created_by = kept.current_user_id())
     ),
     filtered AS MATERIALIZED (
       SELECT s.* FROM scope s
        WHERE ($3::text IS NULL OR s.kind = $3::text)
          AND ($4::uuid IS NULL OR s.batch_id = $4::uuid)
          AND ($5::timestamptz IS NULL
               OR (s.sort_at, coalesce(s.batch_id, s.id), s.id)
                  < ($5::timestamptz, $6::uuid, $7::uuid))
     )${pattern ? SUBJECT_LAYERS : ''}
     SELECT s.id, s.location_id, s.kind, s.thing_id, s.purchase_id, s.meter_reading_id,
            s.extraction_id, s.other_thing_id, s.code, s.batch_id, s.created_by, s.payload,
            s.created_at, s.row_version, up.display_name AS created_by_name,
            s.sort_at::text AS sort_at, coalesce(s.batch_id, s.id) AS group_key
       FROM ${pattern ? 'subjects' : 'filtered'} s
       LEFT JOIN public.user_profiles up ON up.user_id = s.created_by
      ${pattern ? `WHERE ${SEARCH_TEXT} LIKE $9` : ''}
      ORDER BY s.sort_at DESC, coalesce(s.batch_id, s.id) DESC, s.id DESC
      LIMIT $8`,
    values,
  );
  const shown = rows.slice(0, page.limit);
  const items = await itemsOf(tx, client, scope, files, shown);
  const paged = pageOf(rows, page.limit, (r): Key => [r.sort_at, r.group_key, r.id]);
  return {
    items,
    counts: await countsOf(client, locationId, mine),
    next_cursor: paged.next_cursor,
  };
}

async function countsOf(
  client: pg.ClientBase,
  locationId: string | null,
  mine: boolean,
): Promise<InboxPage['counts']> {
  const { rows } = await client.query<{
    kind: InboxKind;
    n: number;
    mine: number;
    everyone: number;
  }>(
    `SELECT i.kind,
            (count(*) FILTER (WHERE NOT $2::boolean OR i.created_by = kept.current_user_id()))::int
              AS n,
            (count(*) FILTER (WHERE i.created_by = kept.current_user_id()))::int AS mine,
            count(*)::int AS everyone
       FROM public.inbox_items i
      WHERE ${LIVE_SUBJECT}
        AND ($1::uuid IS NULL OR i.location_id = $1::uuid)
      GROUP BY i.kind`,
    [locationId, mine],
  );
  const byKind = Object.fromEntries(INBOX_KINDS.map((k) => [k, 0])) as Record<InboxKind, number>;
  let mineN = 0;
  let everyone = 0;
  for (const r of rows) {
    byKind[r.kind] = r.n;
    mineN += r.mine;
    everyone += r.everyone;
  }
  return { byKind, mine: mineN, everyone };
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

const iso = (d: Date | string | null | undefined): string | undefined =>
  d === null || d === undefined ? undefined : new Date(d).toISOString();

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The money-shaped suggestion fields (web contract `Suggestion`): left out where money hides. */
const MONEY_FIELDS = new Set(['price']);

type ThingExtra = {
  id: string;
  brand_id: string | null;
  brand_name: string | null;
  model: string | null;
  colour: string | null;
  serial: string | null;
  field_status: Record<string, { state?: string; confidence?: number }> | null;
};

type ExtractionRow = CallRow & {
  id: string;
  status: (typeof EXTRACTION_STATUSES)[number];
  status_reason: string | null;
  paused_until: Date | number | null;
  mode: (typeof CAPTURE_MODES)[number];
  result: { fields?: Record<string, unknown> } | null;
};

type PurchaseRow = {
  id: string;
  purchased_on: string | null;
  currency: string | null;
  total: string | null;
  tax: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
};

type LineRow = {
  purchase_id: string;
  description: string;
  quantity: string;
  unit_price: string | null;
};

type ReadingRow = {
  id: string;
  value: string;
  taken_at: Date;
  review_reason: string | null;
  meter_id: string;
};

type MeterRow = { id: string; label: string | null; unit: string };

type BatchRow = {
  batch_id: string;
  created_by: string;
  captured_at: Date;
  count: number;
  path: PathStep[] | null;
};

const pausedIso = (v: Date | number | null): string | undefined => {
  if (v === null) return undefined;
  if (typeof v === 'number') return v > 0 ? 'infinity' : undefined;
  return v.toISOString();
};

/** A decimal as stored (numeric(16,4) text) in the canonical wire form. */
const amount = (v: string | null | undefined): string | undefined =>
  canonicalAmount(v) ?? undefined;

/** A number AI read, as a canonical amount. */
const readAmount = (n: unknown): string | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? amount(n.toFixed(4)) : undefined;

/** The extraction an item names: the payload's latest attempt, else the one that opened it. */
const extractionIdOf = (r: ItemRow): string | null =>
  str(r.payload.extractionId) ?? r.extraction_id;

/** Serialises items for the caller (their gates), in order. */
export async function itemsOf(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  items: readonly ItemRow[],
): Promise<InboxItem[]> {
  if (items.length === 0) return [];
  const gates = new Map<string, Gate>();
  for (const loc of new Set(items.map((i) => i.location_id))) {
    gates.set(loc, await gateFor(tx, loc, scope));
  }
  const showMoney = (loc: string) => gates.get(loc)?.showMoney === true;

  // Things: the draft (or the item's own) and the other of a duplicate pair.
  const thingIds = [...new Set(items.flatMap((i) => (i.thing_id ? [i.thing_id] : [])))];
  const otherIds = [...new Set(items.flatMap((i) => (i.other_thing_id ? [i.other_thing_id] : [])))];
  const rows = new Map<string, ThingRow>();
  for (const r of await rowsOf(client, files, [...new Set([...thingIds, ...otherIds])])) {
    rows.set(r.id, r);
  }
  const extras = new Map<string, ThingExtra>();
  const photos = new Map<string, { fileId: string; thumbUrl: string | null }[]>();
  if (thingIds.length > 0) {
    const { rows: ex } = await client.query<ThingExtra>(
      `SELECT t.id, t.brand_id, b.name AS brand_name, t.model, t.colour, t.serial, t.field_status
         FROM public.things t LEFT JOIN public.brands b ON b.id = t.brand_id
        WHERE t.id = ANY ($1::uuid[])`,
      [thingIds],
    );
    for (const r of ex) extras.set(r.id, r);
    const { rows: ph } = await client.query<{ thing_id: string; file_id: string }>(
      `SELECT a.thing_id, a.file_id FROM public.attachments a
        WHERE a.thing_id = ANY ($1::uuid[]) AND a.role = 'photo' AND a.file_id IS NOT NULL
        ORDER BY a.thing_id, a.sort, a.created_at, a.id`,
      [thingIds],
    );
    const keys = await thumbKeysOf(
      client,
      ph.map((p) => p.file_id),
    );
    for (const p of ph) {
      const list = photos.get(p.thing_id) ?? [];
      if (list.length >= 10) continue;
      list.push({ fileId: p.file_id, thumbUrl: await thumbUrlOf(files, keys, p.file_id) });
      photos.set(p.thing_id, list);
    }
  }

  // Extractions, with the AI line.
  const extractionIds = [...new Set(items.flatMap((i) => extractionIdOf(i) ?? []))];
  const extractions = new Map<string, ExtractionRow>();
  if (extractionIds.length > 0) {
    const { rows: ex } = await client.query<ExtractionRow>(
      `SELECT e.id, e.status, e.status_reason, e.paused_until, e.mode, e.result, ${CALL_COLUMNS}
         FROM public.extractions e
         JOIN public.locations l ON l.id = e.location_id
         LEFT JOIN public.llm_calls c ON c.id = e.llm_call_id AND c.at >= e.created_at
        WHERE e.id = ANY ($1::uuid[])`,
      [extractionIds],
    );
    for (const r of ex) extractions.set(r.id, r);
  }

  // Receipts: the purchase, its lines and pages.
  const purchaseIds = [...new Set(items.flatMap((i) => (i.purchase_id ? [i.purchase_id] : [])))];
  const purchases = new Map<string, PurchaseRow>();
  const lines = new Map<string, LineRow[]>();
  const pages = new Map<string, { fileId: string; thumbUrl: string | null }[]>();
  if (purchaseIds.length > 0) {
    const { rows: ps } = await client.query<PurchaseRow>(
      `SELECT p.id, p.purchased_on::text AS purchased_on, p.currency::text AS currency,
              p.total::text AS total, p.tax::text AS tax, p.vendor_id, v.name AS vendor_name
         FROM public.purchases p LEFT JOIN public.vendors v ON v.id = p.vendor_id
        WHERE p.id = ANY ($1::uuid[])`,
      [purchaseIds],
    );
    for (const p of ps) purchases.set(p.id, p);
    const { rows: ls } = await client.query<LineRow>(
      `SELECT pl.purchase_id, pl.description, pl.quantity::text AS quantity,
              pl.unit_price::text AS unit_price
         FROM public.purchase_lines pl
        WHERE pl.purchase_id = ANY ($1::uuid[])
        ORDER BY pl.purchase_id, pl.sort, pl.id`,
      [purchaseIds],
    );
    for (const l of ls) lines.set(l.purchase_id, [...(lines.get(l.purchase_id) ?? []), l]);
    const { rows: rp } = await client.query<{ purchase_id: string; file_id: string }>(
      `SELECT a.purchase_id, a.file_id FROM public.attachments a
        WHERE a.purchase_id = ANY ($1::uuid[]) AND a.file_id IS NOT NULL
        ORDER BY a.purchase_id, a.sort, a.created_at, a.id`,
      [purchaseIds],
    );
    const keys = await thumbKeysOf(
      client,
      rp.map((p) => p.file_id),
    );
    for (const p of rp) {
      const list = pages.get(p.purchase_id) ?? [];
      list.push({ fileId: p.file_id, thumbUrl: await thumbUrlOf(files, keys, p.file_id) });
      pages.set(p.purchase_id, list);
    }
  }

  // Readings: the reading, its meter, the proof.
  const readingIds = [...new Set(items.flatMap((i) => i.meter_reading_id ?? []))];
  const readings = new Map<string, ReadingRow>();
  if (readingIds.length > 0) {
    const { rows: rs } = await client.query<ReadingRow>(
      `SELECT r.id, trim_scale(r.value)::text AS value, r.taken_at, r.review_reason, r.meter_id
         FROM public.meter_readings r WHERE r.id = ANY ($1::uuid[])`,
      [readingIds],
    );
    for (const r of rs) readings.set(r.id, r);
  }
  const meterIds = [
    ...new Set(
      items.flatMap((i) => {
        if (i.kind !== 'reading') return [];
        const fromReading = i.meter_reading_id ? readings.get(i.meter_reading_id)?.meter_id : null;
        const id = fromReading ?? str(i.payload.meterId);
        return id ? [id] : [];
      }),
    ),
  ];
  const meters = new Map<string, MeterRow>();
  if (meterIds.length > 0) {
    const { rows: ms } = await client.query<MeterRow>(
      'SELECT m.id, m.label, m.unit FROM public.meters m WHERE m.id = ANY ($1::uuid[])',
      [meterIds],
    );
    for (const m of ms) meters.set(m.id, m);
  }
  const proofIds = [
    ...new Set(
      items.flatMap((i) => (i.kind === 'reading' ? (str(i.payload.attachmentId) ?? []) : [])),
    ),
  ];
  const proofs = new Map<string, string>();
  if (proofIds.length > 0) {
    const { rows: pr } = await client.query<{ id: string; file_id: string }>(
      `SELECT a.id, a.file_id FROM public.attachments a
        WHERE a.id = ANY ($1::uuid[]) AND a.file_id IS NOT NULL`,
      [proofIds],
    );
    const keys = await thumbKeysOf(
      client,
      pr.map((p) => p.file_id),
    );
    for (const p of pr) {
      const url = await thumbUrlOf(files, keys, p.file_id);
      if (url) proofs.set(p.id, url);
    }
  }

  // Batches: the things a capture session made (one person's; things_capture_batch_idx).
  const batchKeys = [
    ...new Map(
      items.flatMap((i) =>
        i.batch_id ? [[`${i.created_by}:${i.batch_id}`, [i.created_by, i.batch_id]] as const] : [],
      ),
    ).values(),
  ];
  const batches = new Map<string, BatchRow>();
  if (batchKeys.length > 0) {
    const { rows: bs } = await client.query<BatchRow>(
      `WITH b AS (
         SELECT t.capture_batch_id AS batch_id, t.created_by,
                date_trunc('milliseconds', min(t.created_at)) AS captured_at,
                count(*)::int AS count,
                (array_agg(t.id ORDER BY t.created_at, t.id))[1] AS first_id
           FROM public.things t
           JOIN unnest($1::uuid[], $2::uuid[]) AS k(created_by, batch_id)
             ON t.created_by = k.created_by AND t.capture_batch_id = k.batch_id
          WHERE t.deleted_at IS NULL
          GROUP BY t.capture_batch_id, t.created_by)
       SELECT b.batch_id, b.created_by, b.captured_at, b.count,
              kept.path_of(f.place_id, f.container_id) AS path
         FROM b JOIN public.things f ON f.id = b.first_id`,
      [batchKeys.map((k) => k[0]), batchKeys.map((k) => k[1])],
    );
    for (const b of bs) batches.set(`${b.created_by}:${b.batch_id}`, b);
  }
  // A batch without live things (receipts and readings carry none): its items say when.
  const itemBatchTimes = new Map<string, { at: Date; n: number }>();
  for (const i of items) {
    if (!i.batch_id) continue;
    const was = itemBatchTimes.get(i.batch_id);
    itemBatchTimes.set(i.batch_id, {
      at: was && was.at < i.created_at ? was.at : i.created_at,
      n: (was?.n ?? 0) + 1,
    });
  }
  const isUnplacedOf = new Map<string, boolean>();
  const pathIds = [...batches.values()].flatMap((b) => (b.path ?? []).map((s) => s.id));
  if (pathIds.length > 0) {
    const { rows: un } = await client.query<{ id: string }>(
      'SELECT id FROM public.places WHERE id = ANY ($1::uuid[]) AND is_unplaced',
      [pathIds],
    );
    for (const u of un) isUnplacedOf.set(u.id, true);
  }

  return items.map((i): InboxItem => {
    const money = showMoney(i.location_id);
    const batch = i.batch_id ? batches.get(`${i.created_by}:${i.batch_id}`) : undefined;
    const fallback = i.batch_id ? itemBatchTimes.get(i.batch_id) : undefined;
    const out: InboxItem = {
      id: i.id,
      kind: i.kind,
      locationId: i.location_id,
      createdAt: i.created_at.toISOString(),
      createdBy: { displayName: i.created_by_name ?? '' },
      rowVersion: i.row_version,
      batch: i.batch_id
        ? {
            id: i.batch_id,
            capturedAt: (batch?.captured_at ?? fallback?.at ?? i.created_at).toISOString(),
            placePath: (batch?.path ?? []).map((s) => ({
              id: s.id,
              name: s.name ?? '',
              kind: s.kind,
              isUnplaced: isUnplacedOf.get(s.id) === true,
            })),
            count: batch?.count ?? fallback?.n ?? 0,
          }
        : null,
    };

    const row = i.thing_id ? rows.get(i.thing_id) : undefined;
    const extra = i.thing_id ? extras.get(i.thing_id) : undefined;
    if (row && extra && i.kind !== 'reading') {
      const fieldStatus: Record<
        string,
        { state: 'manual' | 'extracted' | 'confirmed'; confidence?: number }
      > = {};
      for (const [field, st] of Object.entries(extra.field_status ?? {})) {
        const state = st?.state;
        if (state !== 'manual' && state !== 'extracted' && state !== 'confirmed') continue;
        fieldStatus[field] = {
          state,
          ...(typeof st.confidence === 'number' ? { confidence: st.confidence } : {}),
        };
      }
      out.thing = {
        ...row,
        brand:
          extra.brand_id && extra.brand_name
            ? { id: extra.brand_id, name: extra.brand_name }
            : null,
        model: extra.model,
        colour: extra.colour,
        serial: extra.serial,
        photos: photos.get(row.id) ?? [],
        fieldStatus,
      };
    }

    if (i.kind === 'draft') {
      const list = Array.isArray(i.payload.suggestions) ? i.payload.suggestions : [];
      out.suggestions = list
        .map((s) => obj(s))
        .filter((s) => typeof s.field === 'string' && (money || !MONEY_FIELDS.has(s.field)))
        .map((s) => ({
          field: s.field as string,
          value: s.value,
          confidence: typeof s.confidence === 'number' ? s.confidence : 0,
          source: {
            extractionId: str(obj(s.source).extractionId) ?? '',
            attachmentId: str(obj(s.source).attachmentId) ?? '',
          },
        }))
        .filter((s) => s.source.extractionId && s.source.attachmentId);
    }

    const exId = extractionIdOf(i);
    const ex = exId ? extractions.get(exId) : undefined;
    if (ex) {
      out.extraction = {
        id: ex.id,
        status: ex.status,
        ...(ex.status_reason ? { statusReason: ex.status_reason } : {}),
        ...(pausedIso(ex.paused_until) ? { pausedUntil: pausedIso(ex.paused_until) } : {}),
        call: callSummaryOf(ex, money, scope.userId),
      };
    }

    if ((i.kind === 'receipt' || i.kind === 'currency') && i.purchase_id) {
      const p = purchases.get(i.purchase_id);
      const read = obj(ex?.mode === 'receipt' ? ex.result?.fields : undefined);
      // A receipt item keeps the shop as read in its payload; a currency item has only the read.
      const vendorSeen = str(i.payload.vendorSeen) ?? str(obj(obj(read.vendor).name).value);
      const readLines = Array.isArray(read.lines) ? read.lines.map(obj) : [];
      const readMoney = (v: unknown): string | undefined => readAmount(obj(v).value);
      const total = amount(p?.total) ?? readMoney(read.total);
      const tax = amount(p?.tax) ?? readMoney(read.tax);
      const ls = lines.get(i.purchase_id) ?? [];
      out.receipt = {
        purchaseId: i.purchase_id,
        pages: money ? (pages.get(i.purchase_id) ?? []) : [],
        ...(vendorSeen ? { vendorSeen } : {}),
        ...(p?.purchased_on ? { purchasedOn: p.purchased_on } : {}),
        ...(p?.currency ? { currency: p.currency.trim() } : {}),
        ...(money && total ? { total } : {}),
        ...(money && tax ? { tax } : {}),
        lines: ls.map((l, index) => {
          const price =
            amount(l.unit_price) ?? (money ? unitPriceRead(readLines[index]) : undefined);
          return {
            index,
            description: l.description,
            quantity: amount(l.quantity) ?? l.quantity,
            ...(money && price ? { unitPrice: price } : {}),
          };
        }),
        flagged: i.payload.flagged === true,
        ...(money ? {} : { moneyHidden: true as const }),
      };
    }

    if (i.kind === 'currency') {
      out.currency = {
        seen: str(i.payload.seen) ?? '',
        options: Array.isArray(i.payload.options)
          ? i.payload.options.filter((o): o is string => typeof o === 'string')
          : [],
      };
    }

    if (i.kind === 'reading') {
      const r = i.meter_reading_id ? readings.get(i.meter_reading_id) : undefined;
      const meterId = r?.meter_id ?? str(i.payload.meterId);
      const m = meterId ? meters.get(meterId) : undefined;
      const n = obj(i.payload.neighbours);
      const neighbour = (v: unknown) => {
        const x = obj(v);
        return typeof x.value === 'string' && typeof x.takenAt === 'string'
          ? { value: x.value, takenAt: x.takenAt }
          : undefined;
      };
      const before = neighbour(n.before);
      const afterN = neighbour(n.after);
      if (m) {
        out.reading = {
          meter: { id: m.id, label: m.label, unit: m.unit },
          value: r?.value ?? str(i.payload.value) ?? '',
          takenAt: iso(r?.taken_at) ?? str(i.payload.takenAt) ?? i.created_at.toISOString(),
          reason: str(i.payload.reason) ?? r?.review_reason ?? 'ai_read',
          neighbours: { ...(before ? { before } : {}), ...(afterN ? { after: afterN } : {}) },
          proofThumbUrl: proofs.get(str(i.payload.attachmentId) ?? '') ?? null,
        };
      }
    }

    if (i.kind === 'duplicate' && i.other_thing_id) {
      const other = rows.get(i.other_thing_id);
      const reason = i.payload.reason === 'serial' ? 'serial' : 'brand_model_place';
      if (other) out.duplicate = { other, reason };
    }

    if (i.kind === 'label_claim' && i.code) {
      const c = obj(i.payload.claimedFor);
      if ((c.kind === 'thing' || c.kind === 'place') && typeof c.id === 'string') {
        out.claim = {
          code: i.code,
          claimedFor: { kind: c.kind, id: c.id, name: str(c.name) ?? '' },
        };
      }
    }

    if (i.kind === 'sync_drop') {
      const e = obj(i.payload.entity);
      const by = obj(i.payload.by);
      out.syncDrop = {
        op: i.payload.op ?? null,
        reason: str(i.payload.reason) ?? 'dropped',
        ...(typeof e.type === 'string' && typeof e.id === 'string'
          ? { entity: { type: e.type, id: e.id, name: str(e.name) ?? '' } }
          : {}),
        ...(typeof by.displayName === 'string' ? { by: { displayName: by.displayName } } : {}),
      };
    }
    return out;
  });
}

/** A receipt line's price as AI read it (for a purchase still without a currency). */
function unitPriceRead(line: Record<string, unknown> | undefined): string | undefined {
  if (!line) return undefined;
  const unit = readAmount(obj(line.unitPrice).value);
  if (unit) return unit;
  const total = obj(line.lineTotal).value;
  const q = obj(line.quantity).value;
  if (typeof total !== 'number') return undefined;
  return readAmount(total / (typeof q === 'number' && q > 0 ? q : 1));
}
