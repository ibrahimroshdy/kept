import { canonicalAmount } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  AttachmentSubjectSchema,
  attachmentViews,
} from '../files/views.js';
import { notFound } from '../http/errors.js';
import { type Gate, stripMoney } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';

// Purchases on the wire (T12; D13, D115, D136, D168; plan Q2): the web contract's PurchaseView
// (apps/web/src/api/inventory/types.ts, "currencies and purchases"), and the request shapes.
//
// Money leaves only through serialize/gates.ts: `total`, `tax` and each line's `unitPrice` are
// omitted, never null, when the caller's gate hides money, and the objects that held them carry
// `moneyHidden: true` (T26). The receipts and invoices go with them (`receipts: []`): a receipt
// shows the price (security review #10). `flagged` is derived from those amounts, so it is false too then.
// Amounts are returned as stored, at full precision, in the canonical parseAmount() form
// ("1200.5", not "1200.5000"): rounding to minor units is the display's (Q2).

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** An amount as typed: any digits parseAmount() reads (Western, Eastern Arabic, Persian; `٫`). */
const AmountIn = z.string().trim().min(1).max(40);
/** A currency as sent. "$" is refused with its own hint (D189: no default between USD and CAD). */
const CurrencyIn = z.string().trim().min(1).max(8);
const IsoDate = z.iso.date();
const Quantity = z.number().positive().max(999_999_999).multipleOf(0.001);
const Description = z.string().trim().min(1).max(300);
const Notes = z.string().max(5000);

export const LineBody = z.object({
  id: z.uuid().optional(),
  description: Description,
  quantity: Quantity.default(1),
  unitPrice: AmountIn.optional(),
  thingId: z.uuid().optional(),
});
export type LineBody = z.infer<typeof LineBody>;

export const CreateBody = z.object({
  id: z.uuid().optional(),
  locationId: z.uuid(),
  vendorId: z.uuid().optional(),
  purchasedOn: IsoDate,
  currency: CurrencyIn.optional(),
  total: AmountIn.optional(),
  tax: AmountIn.optional(),
  notes: Notes.optional(),
  lines: z.array(LineBody).max(500).default([]),
});
export type CreateBody = z.infer<typeof CreateBody>;

/**
 * A line in a PATCH. One with the `id` of an existing line changes only the fields it sends
 * (`unitPrice: null` clears a price; a member who can't see money never clears one by leaving it
 * out); one without, or with a new id, is added and needs a description. Lines the PATCH leaves
 * out are removed.
 */
export const PatchLineBody = z.object({
  id: z.uuid().optional(),
  description: Description.optional(),
  quantity: Quantity.optional(),
  unitPrice: AmountIn.nullable().optional(),
  thingId: z.uuid().nullable().optional(),
});
export type PatchLineBody = z.infer<typeof PatchLineBody>;

/** Every field optional; `null` clears one that may be empty. */
export const PatchBody = z.object({
  vendorId: z.uuid().nullable().optional(),
  purchasedOn: IsoDate.optional(),
  currency: CurrencyIn.nullable().optional(),
  total: AmountIn.nullable().optional(),
  tax: AmountIn.nullable().optional(),
  notes: Notes.nullable().optional(),
  lines: z.array(PatchLineBody).max(500).optional(),
});
export type PatchBody = z.infer<typeof PatchBody>;

export const LinkBody = z.object({ thingId: z.uuid() });
export const UnlinkQuery = z.object({ thingId: z.uuid().optional() });

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

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
  deduplicatedFrom: z.string().optional(),
});

const AttachmentSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  sort: z.number(),
  file: FileViewSchema.nullable(),
  url: z.string().nullable(),
  subject: AttachmentSubjectSchema,
  createdBy: z.object({ displayName: z.string() }),
  rowVersion: z.number().optional(),
});

const LineSchema = z.object({
  id: z.uuid(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.string().optional(),
  moneyHidden: z.literal(true).optional(),
  thing: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});

export const PurchaseViewSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  vendor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  purchasedOn: z.string(),
  currency: z.string().nullable(),
  total: z.string().optional(),
  tax: z.string().optional(),
  moneyHidden: z.literal(true).optional(),
  notes: z.string().nullable(),
  lines: z.array(LineSchema),
  receipts: z.array(AttachmentSchema),
  flagged: z.boolean(),
  rowVersion: z.number(),
});

export type PurchaseLineView = {
  id: string;
  description: string;
  quantity: number;
  unitPrice?: string;
  moneyHidden?: true;
  thing: { id: string; name: string } | null;
};

export type PurchaseView = {
  id: string;
  locationId: string;
  vendor: { id: string; name: string } | null;
  purchasedOn: string;
  currency: string | null;
  total?: string;
  tax?: string;
  moneyHidden?: true;
  notes: string | null;
  lines: PurchaseLineView[];
  receipts: Awaited<ReturnType<typeof attachmentViews>>;
  flagged: boolean;
  rowVersion: number;
};

/** The paths stripMoney() removes when the gate hides money. */
export const MONEY_PATHS = ['total', 'tax', 'lines[].unitPrice'] as const;

// ---------------------------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------------------------

/** A stored numeric in canonical form: `"1200.5000"` → `"1200.5"`; null stays null. The shared
 * canonicalAmount(), which every money output uses (things, custom values, audit diffs). */
export const amountOut = canonicalAmount;

/** A decimal string as an integer scaled by 10^places (exact; no floating point). */
function scaled(value: string, places: number): bigint {
  const [int = '0', frac = ''] = value.split('.');
  return BigInt(int + frac.slice(0, places).padEnd(places, '0'));
}

/**
 * Screens §7, engineering spec §2: the lines don't reconcile with the total within ±1%. Checked
 * only when there is a total and every line has a price; the lines may add up to the total with
 * or without the tax. Never an error, only a flag.
 */
export function isFlagged(
  total: string | null,
  tax: string | null,
  lines: readonly { quantity: string; unitPrice: string | null }[],
): boolean {
  if (total === null || lines.length === 0) return false;
  if (lines.some((l) => l.unitPrice === null)) return false;
  // Prices have 4 decimals and quantities 3: line totals are exact at 10^7.
  const sum = lines.reduce(
    (acc, l) => acc + scaled(l.unitPrice as string, 4) * scaled(l.quantity, 3),
    0n,
  );
  const t = scaled(total, 7);
  const within = (candidate: bigint) => {
    const diff = candidate > t ? candidate - t : t - candidate;
    return diff * 100n <= t;
  };
  return !(within(sum) || (tax !== null && within(sum + scaled(tax, 7))));
}

// ---------------------------------------------------------------------------------------------
// Reading a purchase
// ---------------------------------------------------------------------------------------------

export type PurchaseRow = {
  id: string;
  location_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  purchased_on: string;
  currency: string | null;
  total: string | null;
  tax: string | null;
  notes: string | null;
  row_version: number;
};

export type LineRow = {
  id: string;
  description: string;
  quantity: string;
  unit_price: string | null;
  sort: number;
  thing_id: string | null;
  thing_name: string | null;
};

/** The purchase as the caller sees it (RLS), locked for a write when `lock`. 404 when unseen. */
export async function purchaseRow(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<PurchaseRow> {
  const { rows } = await client.query<PurchaseRow>(
    `SELECT p.id, p.location_id, p.vendor_id, v.name AS vendor_name,
            p.purchased_on::text AS purchased_on, p.currency::text AS currency,
            p.total::text AS total, p.tax::text AS tax, p.notes, p.row_version
       FROM public.purchases p LEFT JOIN public.vendors v ON v.id = p.vendor_id
      WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Its lines in order, each with the first live thing (the caller can see) that came from it. */
export async function lineRows(client: pg.ClientBase, purchaseId: string): Promise<LineRow[]> {
  const { rows } = await client.query<LineRow>(
    `SELECT pl.id, pl.description, pl.quantity::text AS quantity,
            pl.unit_price::text AS unit_price, pl.sort, t.id AS thing_id, t.name AS thing_name
       FROM public.purchase_lines pl
       LEFT JOIN LATERAL (
         SELECT th.id, th.name FROM public.things th
          WHERE th.purchase_line_id = pl.id AND th.deleted_at IS NULL
          ORDER BY th.id LIMIT 1) t ON true
      WHERE pl.purchase_id = $1
      ORDER BY pl.sort, pl.id`,
    [purchaseId],
  );
  return rows;
}

/** Its receipts and invoices, as kept.thing_receipts() counts them (D115). Only where the gate
 * shows money. */
async function receiptsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  purchaseId: string,
): Promise<PurchaseView['receipts']> {
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT}
      WHERE a.purchase_id = $1 AND a.role IN ('receipt', 'invoice')
      ORDER BY a.sort, a.id`,
    [purchaseId],
  );
  return attachmentViews(client, files, rows);
}

/** The whole view, gated for the caller. */
export async function purchaseView(
  client: pg.ClientBase,
  files: FileStorage | null,
  gate: Gate,
  id: string,
): Promise<PurchaseView> {
  const p = await purchaseRow(client, id);
  const lines = await lineRows(client, id);
  const total = amountOut(p.total);
  const tax = amountOut(p.tax);
  const view: PurchaseView = {
    id: p.id,
    locationId: p.location_id,
    vendor: p.vendor_id ? { id: p.vendor_id, name: p.vendor_name ?? '' } : null,
    purchasedOn: p.purchased_on,
    currency: p.currency,
    ...(total !== null ? { total } : {}),
    ...(tax !== null ? { tax } : {}),
    notes: p.notes,
    lines: lines.map((l) => {
      const unitPrice = amountOut(l.unit_price);
      return {
        id: l.id,
        description: l.description,
        quantity: Number(l.quantity),
        ...(unitPrice !== null ? { unitPrice } : {}),
        thing: l.thing_id ? { id: l.thing_id, name: l.thing_name ?? '' } : null,
      };
    }),
    // A receipt or invoice shows the price: withheld with the amounts (security review #10).
    receipts: gate.showMoney ? await receiptsOf(client, files, id) : [],
    flagged: gate.showMoney
      ? isFlagged(
          p.total,
          p.tax,
          lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price })),
        )
      : false,
    rowVersion: p.row_version,
  };
  if (gate.showMoney) return view;
  // Hidden: every object that could hold money is marked, whether or not it held any, so the
  // marker's absence can't say nothing was paid (gates.ts).
  const stripped = stripMoney(gate, view, MONEY_PATHS);
  return {
    ...stripped,
    moneyHidden: true,
    lines: stripped.lines.map((l) => ({ ...l, moneyHidden: true as const })),
  };
}
