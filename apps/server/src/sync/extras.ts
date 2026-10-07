import {
  canonicalAmount,
  KEEP_OFFLINE,
  KEEP_OFFLINE_ROLES,
  type KeepOfflineRole,
  SYNC_EXTRAS_PAGE,
  type SyncExtra,
  type SyncExtraDocument,
  type SyncExtrasEstimate,
  type SyncExtrasPage,
  SyncExtrasQuery,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { MONEY_ROLES } from '../files/views.js';
import type { KeptApp } from '../http/app.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import { type Gate, gateFor } from '../serialize/gates.js';

// "Keep this location available offline" (D159, D181; plan T12, Q21, Q22): what a phone keeps
// of one location beyond the snapshot, behind its app lock. Registered by http/routes.ts.
//
// GET /api/v1/sync/extras?locationId&cursor → SyncExtrasPage, SYNC_EXTRAS_PAGE things a page;
// GET /api/v1/sync/extras?locationId&estimate=1 → SyncExtrasEstimate (what keeping it would take).
//
// - **Who:** any member of the location, viewers included; anyone else gets 404 (the gate's own
//   membership read, §7.7).
// - **Money** through serialize/gates.ts: where the reader's gate hides it (the money module off,
//   or a viewer where viewers don't see money) an item carries `moneyHidden: true`, its purchase
//   only the date (`price` and `currency` null, as the thing page shows a purchase's date and
//   withholds its price), `currentValue: null` whether or not one exists, and receipts, invoices
//   and a valuation's documents are left out, as from every attachment list (security review
//   #10). The purchase is kept.thing_purchase()'s (D115): its date, the line's unit price and the
//   currency; the value is the newest valuation (D158).
// - **Documents** are the KEEP_OFFLINE_ROLES (receipts, invoices, manuals, warranty documents,
//   registrations, paperwork), never photos: on the thing itself, or on its warranty or claim
//   (Warranties on; a `warranty_doc` anywhere needs it too), valuation (money shown), service
//   record (core), or current expiring document (Paperwork on, or Vehicles on a vehicle; never a
//   superseded term), and its purchase's receipts through kept.thing_receipts() (they may sit in
//   a location the reader can't open after a move). A module that is off takes its documents with
//   it. The phone fetches each one's original through the existing signed-URL route
//   (`POST /api/v1/files/:fileId/url?thingId=` with the item's thing, which also serves a moved
//   receipt), so **only members and above get documents**: originals are for members and above
//   (D117), and a viewer's items carry money only.
// - **Never** a secret value, never a person's contact details, never a vendor (D36, D159).
// - A thing with nothing to keep is left out; the cursor walks every live thing by id, so a page
//   may hold fewer than SYNC_EXTRAS_PAGE items while `next_cursor` says there is more.
//   `totalBytes` is this page's documents within KEEP_OFFLINE.fileBytes, each file once; the
//   estimate's is the whole location's the same way, and its `documents` counts every document,
//   too large or not (the phone lists those as "too large to keep offline").

const WRITERS = new Set(['owner', 'admin', 'member']);

type Purchase = {
  thing_id: string;
  purchased_on: string | null;
  currency: string | null;
  unit_price: string | null;
};
type Value = { thing_id: string; value: string; currency: string };
type Doc = {
  thing_id: string;
  attachment_id: string;
  file_id: string;
  role: KeepOfflineRole;
  title: string | null;
  mime: string;
  bytes: string | number;
  sha256: string;
};

/** The roles the reader may keep in this location (money roles only where money shows). */
function rolesFor(gate: Gate): KeepOfflineRole[] {
  return KEEP_OFFLINE_ROLES.filter(
    (r) =>
      (gate.showMoney || !(MONEY_ROLES as readonly string[]).includes(r)) &&
      (r !== 'warranty_doc' || gate.modules.has('warranties')),
  );
}

async function documentsOf(
  client: pg.ClientBase,
  gate: Gate,
  thingIds: readonly string[],
): Promise<Map<string, SyncExtraDocument[]>> {
  const out = new Map<string, SyncExtraDocument[]>();
  if (thingIds.length === 0 || !WRITERS.has(gate.role)) return out;
  const { rows } = await client.query<Doc>(
    `SELECT s.thing_id, a.id AS attachment_id, a.file_id, a.role, d.title, f.mime, f.bytes,
            f.sha256::text AS sha256
       FROM public.attachments a
       JOIN public.files f ON f.id = a.file_id
       LEFT JOIN public.warranties w ON w.id = a.warranty_id
       LEFT JOIN public.claims c ON c.id = a.claim_id
       LEFT JOIN public.valuations v ON v.id = a.valuation_id
       LEFT JOIN public.service_records sr ON sr.id = a.service_record_id
       LEFT JOIN public.expiring_documents d ON d.id = a.expiring_document_id
      CROSS JOIN LATERAL (
        SELECT coalesce(a.thing_id, w.thing_id, c.thing_id, v.thing_id, sr.thing_id, d.thing_id)
                 AS thing_id) s
      WHERE a.location_id = $1
        AND a.role = ANY ($2::text[])
        AND s.thing_id = ANY ($3::uuid[])
        AND a.place_id IS NULL AND a.purchase_id IS NULL AND a.meter_reading_id IS NULL
        AND a.loan_id IS NULL AND a.incident_id IS NULL AND a.fuel_entry_id IS NULL
        AND ((a.warranty_id IS NULL AND a.claim_id IS NULL) OR $4::boolean)
        AND (a.valuation_id IS NULL OR $5::boolean)
        AND (a.expiring_document_id IS NULL
             OR (d.superseded_by_id IS NULL
                 AND (kept.module_on(d.location_id, 'paperwork')
                      OR (kept.module_on(d.location_id, 'vehicles')
                          AND EXISTS (SELECT 1 FROM public.things vt
                                       WHERE vt.id = d.thing_id
                                         AND kept.is_vehicle_type(vt.type_id))))))
      ORDER BY s.thing_id, a.sort, a.id`,
    [gate.locationId, rolesFor(gate), thingIds, gate.modules.has('warranties'), gate.showMoney],
  );
  const receipts: Doc[] = [];
  if (gate.showMoney) {
    // A thing's purchase's receipts and invoices, wherever the purchase is (D115).
    const { rows: r } = await client.query<Doc>(
      `SELECT t.id AS thing_id, r.attachment_id, r.file_id, r.role, NULL::text AS title, r.mime,
              r.bytes, r.sha256
         FROM unnest($1::uuid[]) AS t(id)
        CROSS JOIN LATERAL kept.thing_receipts(t.id) r
        ORDER BY t.id, r.sort, r.attachment_id`,
      [thingIds],
    );
    receipts.push(...r);
  }
  for (const d of [...rows, ...receipts]) {
    const list = out.get(d.thing_id) ?? [];
    if (list.some((x) => x.attachmentId === d.attachment_id)) continue;
    list.push({
      attachmentId: d.attachment_id,
      fileId: d.file_id,
      kind: d.role,
      title: d.title,
      mime: d.mime,
      bytes: Number(d.bytes),
      sha256: d.sha256,
    });
    out.set(d.thing_id, list);
  }
  return out;
}

async function moneyOf(
  client: pg.ClientBase,
  thingIds: readonly string[],
  showMoney: boolean,
): Promise<{ purchases: Map<string, Purchase>; values: Map<string, Value> }> {
  const { rows: purchases } = await client.query<Purchase>(
    `SELECT t.id AS thing_id, p.purchased_on::text AS purchased_on, p.currency,
            p.unit_price::text AS unit_price
       FROM unnest($1::uuid[]) AS t(id)
      CROSS JOIN LATERAL kept.thing_purchase(t.id) p`,
    [thingIds],
  );
  const out = {
    purchases: new Map(purchases.map((p) => [p.thing_id, p])),
    values: new Map<string, Value>(),
  };
  if (!showMoney) return out;
  // The newest valuation of each (money/valuations.ts ORDER: valued_on, then the latest made).
  const { rows: values } = await client.query<Value>(
    `SELECT DISTINCT ON (v.thing_id) v.thing_id, v.value::text AS value,
            v.currency::text AS currency
       FROM public.valuations v
      WHERE v.thing_id = ANY ($1::uuid[])
      ORDER BY v.thing_id, v.valued_on DESC, v.created_at DESC, v.id DESC`,
    [thingIds],
  );
  out.values = new Map(values.map((v) => [v.thing_id, v]));
  return out;
}

/** The bytes of `docs` the phone would keep: each file once, none over the per-file cap. */
export function keptBytes(docs: readonly SyncExtraDocument[], seen = new Set<string>()): number {
  let total = 0;
  for (const d of docs) {
    if (d.bytes > KEEP_OFFLINE.fileBytes || seen.has(d.fileId)) continue;
    seen.add(d.fileId);
    total += d.bytes;
  }
  return total;
}

/** One page of a location's extras: the live things after the id `after` (exclusive). */
export async function extrasPage(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
  after: string | null,
  limit: number = SYNC_EXTRAS_PAGE,
): Promise<{ items: SyncExtra[]; next: string | null }> {
  const gate = await gateFor(tx, locationId, scope);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.things
      WHERE location_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2::uuid)
      ORDER BY id
      LIMIT $3`,
    [gate.locationId, after, limit + 1],
  );
  const page = rows.slice(0, limit).map((r) => r.id);
  const next = rows.length > limit ? (page.at(-1) ?? null) : null;
  if (page.length === 0) return { items: [], next };

  const money = await moneyOf(client, page, gate.showMoney);
  const docs = await documentsOf(client, gate, page);
  const items: SyncExtra[] = [];
  for (const thingId of page) {
    const documents = docs.get(thingId) ?? [];
    const p = money.purchases.get(thingId);
    if (!gate.showMoney) {
      // Money hidden: the marker on every item, whether or not anything was paid
      // (serialize/gates.ts); the purchase's date only.
      const purchase = p ? { date: p.purchased_on, price: null, currency: null } : null;
      if (purchase || documents.length > 0) {
        items.push({ thingId, purchase, currentValue: null, moneyHidden: true, documents });
      }
      continue;
    }
    const v = money.values.get(thingId);
    const purchase = p
      ? { date: p.purchased_on, price: canonicalAmount(p.unit_price), currency: p.currency }
      : null;
    const currentValue = v
      ? { amount: canonicalAmount(v.value) ?? v.value, currency: v.currency }
      : null;
    if (!purchase && !currentValue && documents.length === 0) continue;
    items.push({ thingId, purchase, currentValue, documents });
  }
  return { items, next };
}

/** What keeping the whole location would take (`estimate=1`). */
export async function extrasEstimate(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
): Promise<SyncExtrasEstimate> {
  const seen = new Set<string>();
  const out: SyncExtrasEstimate = { things: 0, documents: 0, totalBytes: 0 };
  let after: string | null = null;
  for (;;) {
    const { items, next } = await extrasPage(tx, client, scope, locationId, after);
    for (const item of items) {
      out.things += 1;
      out.documents += item.documents.length;
      out.totalBytes += keptBytes(item.documents, seen);
    }
    if (next === null) return out;
    after = next;
  }
}

const DocumentSchema = z.object({
  attachmentId: z.uuid(),
  fileId: z.uuid(),
  kind: z.enum(KEEP_OFFLINE_ROLES),
  title: z.string().nullable(),
  mime: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

const PageSchema = z.object({
  items: z.array(
    z.object({
      thingId: z.uuid(),
      purchase: z
        .object({
          date: z.string().nullable(),
          price: z.string().nullable(),
          currency: z.string().nullable(),
        })
        .nullable(),
      currentValue: z.object({ amount: z.string(), currency: z.string() }).nullable(),
      moneyHidden: z.boolean().optional(),
      documents: z.array(DocumentSchema),
    }),
  ),
  next_cursor: z.string().nullable(),
  totalBytes: z.number(),
});

const EstimateSchema = z.object({
  things: z.number(),
  documents: z.number(),
  totalBytes: z.number(),
});

export async function syncExtrasRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  app.get(
    '/api/v1/sync/extras',
    {
      schema: {
        querystring: SyncExtrasQuery,
        response: { 200: z.union([PageSchema, EstimateSchema]) },
      },
    },
    async (req): Promise<SyncExtrasPage | SyncExtrasEstimate> => {
      const { locationId, cursor, estimate } = req.query;
      const location = locationId.toLowerCase();
      if (estimate === '1') {
        return scopedRead(pools, req, (tx, client, scope) =>
          extrasEstimate(tx, client, scope, location),
        );
      }
      let after: string | null = null;
      if (cursor !== undefined) {
        const parsed = z.uuid().safeParse(decodeCursor(cursor));
        if (!parsed.success) {
          throw invalid('The cursor is not valid; start again from the first page.');
        }
        after = parsed.data.toLowerCase();
      }
      const { items, next } = await scopedRead(pools, req, (tx, client, scope) =>
        extrasPage(tx, client, scope, location, after),
      );
      const seen = new Set<string>();
      return {
        items,
        next_cursor: next === null ? null : encodeCursor(next),
        totalBytes: items.reduce((n, x) => n + keptBytes(x.documents, seen), 0),
      };
    },
  );
}
