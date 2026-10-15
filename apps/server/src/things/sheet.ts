import { canonicalAmount } from '@kept/shared';
import { z } from 'zod';
import { forgetUndoableSince, undoableMark, undoableSince } from '../audit/audited.js';
import { decodeCursor, encodeCursor, PAGE_MAX } from '../http/conventions.js';
import { AppError, invalid, toErrorReply } from '../http/errors.js';
import { type Gate, gateFor, moneyProps } from '../serialize/gates.js';
import { trashThing } from '../trash/service.js';
import { moveThings } from './move.js';
import {
  type Ctx,
  requireThingVersion,
  targetOf,
  thingListOrder,
  thingListWhere,
  writableThing,
  writeThingUpdate,
} from './service.js';
import { ListQuery, MoveTarget, type UpdateBody, UpdateFields } from './validate.js';
import { rowsOf, type ThingRow, ThingRowSchema } from './view.js';

// The spreadsheet view (1.x, D250; D39 item 2, D128, D156, D150), in the shapes of the web
// contract (apps/web/src/api/inventory/types.ts SheetRow, BulkEditBody, …):
//
// GET  /api/v1/things/sheet?<GET /things's filters>&sort&dir&group&limit(≤200)&cursor
//                                               → {items: SheetRow[], next_cursor}
// POST /api/v1/things/bulk-edit {edits: [{id, rowVersion, set}] (≤ 200)}
//                                               → {results, rows, events}
// POST /api/v1/things/bulk-trash {thingIds (≤ 200), contents?}
//                                               → {trashed, moved, events}
//
// - **Rows** are GET /things's rows (same filters, same keyset paging, no thumbnails) and the
//   columns a sheet edits or shows: brand, model, serial, barcode, colour, condition, notes, tags,
//   belongs to, expires, manual link, the row version (If-Match per row), whether the quantity is
//   fixed at 1 (D10), and, read-only, the purchase (date, and the unit price and currency only
//   where the row's location gate shows money: never selected otherwise, as the CSV does) and the
//   warranty that covers it longest (where Warranties is on). A sheet sorts by more columns than
//   the list: brand, model, serial, quantity and expiry too.
// - **Bulk edit** is the "Save N changes" bar (D128): each row's staged change with the version it
//   was read at (D156). Each row is written in a savepoint of its own through the thing's own edit
//   (writeThingUpdate: the same validation, money gate, audit image and undo window as PATCH) and,
//   for a new place, the move (a place or box in the thing's own location; another location is a
//   move from the thing's page). A row that fails (gone, refused, 412 stale, 400 invalid) is
//   reported with its code, conflicts and current version, and leaves the others saved: "rows
//   without conflicts save; conflicted rows stay staged" (screens §6). `events` lists the undoable
//   events the saved rows wrote, in write order, for POST /api/v1/audit/undo (one Undo for the
//   whole save, D150); X-Kept-Audit-Event carries them too, one per thing.
// - **Bulk trash** sends a selection to the Trash, all or none (a 404, 403 or 409 names no row
//   done). A thing that holds things needs `contents` (D45: move them out to where it is, or trash
//   them too); one already trashed with a container earlier in the request is skipped. Each thing
//   is its own `thing.trash` event, undone together through POST /api/v1/audit/undo.

/** Edits per request: the server's page (§7.7). */
export const BULK_MAX = 200;
/** Rows a sheet reads per page by default (the web asks for 100). */
const SHEET_PAGE = 100;

const ICU = 'COLLATE "und-x-icu"';

export const SHEET_SORTS = [
  'name',
  'updated',
  'lastSeen',
  'brand',
  'model',
  'serial',
  'quantity',
  'expires',
] as const;
export type SheetSort = (typeof SHEET_SORTS)[number];

export const SheetQuery = ListQuery.extend({
  sort: z.enum(SHEET_SORTS).default('name'),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(SHEET_PAGE),
});
export type SheetQuery = z.infer<typeof SheetQuery>;

const Tag = z.object({ id: z.uuid(), name: z.string(), colour: z.string().nullable() });

export const SheetRowSchema = ThingRowSchema.extend({
  rowVersion: z.number(),
  updatedAt: z.string(),
  placeId: z.uuid().nullable(),
  containerId: z.uuid().nullable(),
  brand: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  barcode: z.string().nullable(),
  colour: z.string().nullable(),
  condition: z.string().nullable(),
  notes: z.string().nullable(),
  manualUrl: z.string().nullable(),
  expiresOn: z.string().nullable(),
  tags: z.array(Tag),
  belongsTo: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  reviewState: z.enum(['draft', 'confirmed']),
  /** D10: serialized, metered or with a meter, so its quantity stays 1. */
  quantityFixed: z.boolean(),
  purchase: z
    .object({
      purchasedOn: z.string().nullable(),
      price: z.string().optional(),
      currency: z.string().optional(),
      moneyHidden: z.literal(true).optional(),
    })
    .nullable(),
  /** The warranty that covers it longest; absent where Warranties is off. */
  warranty: z
    .object({ endsOn: z.string().nullable(), lifetime: z.boolean() })
    .nullable()
    .optional(),
});
export type SheetRow = z.infer<typeof SheetRowSchema>;

export const SheetPageSchema = z.object({
  items: z.array(SheetRowSchema),
  next_cursor: z.string().nullable(),
});

/** What a sheet edits in place: the built-in fields, and `to` (a place or box here). */
export const SheetSet = UpdateFields.pick({
  name: true,
  typeId: true,
  quantity: true,
  brandId: true,
  model: true,
  serial: true,
  barcode: true,
  colour: true,
  condition: true,
  notes: true,
  tagIds: true,
  belongsToPersonId: true,
  manualUrl: true,
  expiresOn: true,
})
  .partial()
  .extend({ to: MoveTarget.optional() })
  .strict()
  .refine((s) => Object.keys(s).length > 0, { message: 'Nothing to change.' });

export const BulkEditBody = z.strictObject({
  edits: z
    .array(
      z.strictObject({
        id: z.uuid(),
        rowVersion: z.number().int().min(1),
        set: SheetSet,
      }),
    )
    .min(1)
    .max(BULK_MAX)
    .refine((e) => new Set(e.map((x) => x.id.toLowerCase())).size === e.length, {
      message: 'Each thing once.',
    }),
});
export type BulkEditBody = z.infer<typeof BulkEditBody>;

const RowResult = z.object({
  id: z.uuid(),
  ok: z.boolean(),
  status: z.number().optional(),
  code: z.string().optional(),
  hint: z.string().optional(),
  /** 412 (D156): the fields that changed under it, its version now, and who changed it. */
  conflicts: z.array(z.string()).optional(),
  rowVersion: z.number().optional(),
  changedBy: z.object({ displayName: z.string() }).optional(),
});
export const BulkEditResultSchema = z.object({
  results: z.array(RowResult),
  rows: z.array(SheetRowSchema),
  events: z.array(z.uuid()),
});
export type BulkEditResult = z.infer<typeof BulkEditResultSchema>;

export const BulkTrashBody = z.strictObject({
  thingIds: z.array(z.uuid()).min(1).max(BULK_MAX),
  contents: z.enum(['move', 'trash']).optional(),
});
export type BulkTrashBody = z.infer<typeof BulkTrashBody>;
export const BulkTrashResultSchema = z.object({
  trashed: z.array(z.uuid()),
  moved: z.array(z.uuid()),
  events: z.array(z.uuid()),
});

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** The sort's expression and the cast its cursor value takes, over `things t` and `brands b`. */
function sortOf(sort: SheetSort): { sql: string; cast: string; date: boolean } {
  const text = (col: string) => ({
    sql: `lower(coalesce(${col}, '')) ${ICU}`,
    cast: `::text ${ICU}`,
    date: false,
  });
  switch (sort) {
    case 'brand':
      return text('b.name');
    case 'model':
      return text('t.model');
    case 'serial':
      return text('t.serial');
    case 'quantity':
      return { sql: 't.quantity', cast: '::numeric', date: false };
    case 'expires':
      // Things without an expiry last whichever way it's sorted.
      return { sql: `coalesce(t.expires_on, 'infinity'::date)`, cast: '::date', date: false };
    case 'updated':
      return { sql: 't.updated_at', cast: '::timestamptz', date: true };
    case 'lastSeen':
      return { sql: 't.last_seen_at', cast: '::timestamptz', date: true };
    default:
      return text('t.name');
  }
}

const SheetCursor = z.tuple([z.string().max(400), z.string().max(400), z.uuid()]);

type Extra = {
  id: string;
  location_id: string;
  row_version: number;
  updated_at: Date;
  place_id: string | null;
  container_id: string | null;
  brand_id: string | null;
  brand_name: string | null;
  model: string | null;
  serial: string | null;
  barcode: string | null;
  colour: string | null;
  condition: string | null;
  notes: string | null;
  manual_url: string | null;
  expires_on: string | null;
  review_state: 'draft' | 'confirmed';
  person_id: string | null;
  person_name: string | null;
  tags: { id: string; name: string; colour: string | null }[];
  quantity_fixed: boolean;
  has_purchase: boolean;
  purchased_on: string | null;
  unit_price: string | null;
  currency: string | null;
  warranty_lifetime: boolean | null;
  warranty_ends_on: string | null;
  warranties: number;
};

/** The sheet rows of `ids`, in that order (trashed and invisible ones left out). */
export async function sheetRowsOf(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope'>,
  ids: readonly string[],
): Promise<SheetRow[]> {
  if (ids.length === 0) return [];
  const { client } = ctx;
  const base = await rowsOf(client, null, ids);
  const gates = new Map<string, Gate>();
  for (const loc of new Set(base.map((r) => r.locationId))) {
    gates.set(loc, await gateFor(ctx.tx, loc, ctx.scope));
  }
  const money = [...gates.values()].filter((g) => g.showMoney).map((g) => g.locationId);
  const warranties = [...gates.values()]
    .filter((g) => g.modules.has('warranties'))
    .map((g) => g.locationId);
  const { rows } = await client.query<Extra>(
    `SELECT t.id, t.location_id, t.row_version, t.updated_at, t.place_id, t.container_id,
            b.id AS brand_id, b.name AS brand_name, t.model, t.serial, t.barcode, t.colour,
            t.condition, t.notes, t.manual_url, t.expires_on::text AS expires_on, t.review_state,
            p.id AS person_id, p.display_name AS person_name,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
                                                          'colour', g.colour)
                                       ORDER BY lower(g.name), g.id)
                        FROM public.thing_tags x JOIN public.tags g ON g.id = x.tag_id
                       WHERE x.thing_id = t.id), '[]'::jsonb) AS tags,
            ('serialized' = ANY (kept.type_capabilities(t.type_id))
             OR 'metered' = ANY (kept.type_capabilities(t.type_id))
             OR EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = t.id)) AS quantity_fixed,
            tp.has_purchase IS TRUE AS has_purchase, tp.purchased_on,
            CASE WHEN t.location_id = ANY ($2::uuid[]) THEN tp.unit_price END AS unit_price,
            CASE WHEN t.location_id = ANY ($2::uuid[]) THEN tp.currency END AS currency,
            w.lifetime AS warranty_lifetime, w.ends_on AS warranty_ends_on,
            coalesce(w.n, 0)::int AS warranties
       FROM public.things t
       LEFT JOIN public.brands b ON b.id = t.brand_id
       LEFT JOIN public.people p ON p.id = t.belongs_to_person_id
       LEFT JOIN LATERAL (
         SELECT true AS has_purchase, x.purchased_on::text AS purchased_on,
                x.unit_price::text AS unit_price, x.currency
           FROM kept.thing_purchase(t.id) x LIMIT 1
       ) tp ON true
       LEFT JOIN LATERAL (
         SELECT bool_or(w.lifetime) AS lifetime, max(w.effective_ends_on)::text AS ends_on,
                count(*) AS n
           FROM public.warranties w
          WHERE w.thing_id = t.id AND t.location_id = ANY ($3::uuid[])
       ) w ON true
      WHERE t.id = ANY ($1::uuid[])`,
    [base.map((r) => r.id), money, warranties],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SheetRow[] = [];
  for (const row of base) {
    const x = byId.get(row.id);
    const gate = gates.get(row.locationId);
    if (!x || !gate) continue;
    out.push(sheetRowOf(row, x, gate));
  }
  return out;
}

function sheetRowOf(row: ThingRow, x: Extra, gate: Gate): SheetRow {
  return {
    ...row,
    rowVersion: x.row_version,
    updatedAt: new Date(x.updated_at).toISOString(),
    placeId: x.place_id,
    containerId: x.container_id,
    brand: x.brand_id && x.brand_name !== null ? { id: x.brand_id, name: x.brand_name } : null,
    model: x.model,
    serial: x.serial,
    barcode: x.barcode,
    colour: x.colour,
    condition: x.condition,
    notes: x.notes,
    manualUrl: x.manual_url,
    expiresOn: x.expires_on,
    tags: x.tags ?? [],
    belongsTo:
      x.person_id && x.person_name !== null
        ? { id: x.person_id, displayName: x.person_name }
        : null,
    reviewState: x.review_state,
    quantityFixed: x.quantity_fixed,
    purchase: x.has_purchase
      ? {
          purchasedOn: x.purchased_on,
          ...moneyProps(gate, {
            price: canonicalAmount(x.unit_price),
            currency: x.currency,
          }),
        }
      : null,
    ...(gate.modules.has('warranties')
      ? {
          warranty:
            x.warranties > 0
              ? { endsOn: x.warranty_ends_on, lifetime: x.warranty_lifetime === true }
              : null,
        }
      : {}),
  };
}

/**
 * GET /api/v1/things/sheet: GET /things's rows (its filters through thingListWhere, so the sheet
 * and the list show the same things), sorted by any of SHEET_SORTS, one keyset page at a time.
 */
export async function listSheet(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope'>,
  q: SheetQuery,
): Promise<{ items: SheetRow[]; next_cursor: string | null }> {
  const { client } = ctx;
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = await thingListWhere(client, q, p);
  const { group } = thingListOrder({
    group: q.group,
    sort: 'name',
    ...(q.dir ? { dir: q.dir } : {}),
  });
  const s = sortOf(q.sort);
  const desc = q.dir ? q.dir === 'desc' : s.date;

  if (q.cursor) {
    const parsed = SheetCursor.safeParse(decodeCursor(q.cursor));
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    const [g, v, lastId] = parsed.data;
    const G = `${p(g)}::text ${ICU}`;
    const S = `${p(v)}${s.cast}`;
    const I = `${p(lastId)}::uuid`;
    where.push(`(${group} > ${G}
                 OR (${group} = ${G} AND (${s.sql} ${desc ? '<' : '>'} ${S}
                                          OR (${s.sql} = ${S} AND t.id > ${I}))))`);
  }

  const { rows } = await client.query<{ id: string; g: string; s: string }>(
    `SELECT t.id, ${group} AS g, (${s.sql})::text AS s
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
       LEFT JOIN public.brands b ON b.id = t.brand_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${group}, ${s.sql} ${desc ? 'DESC' : 'ASC'}, t.id
      LIMIT ${p(q.limit + 1)}`,
    values,
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await sheetRowsOf(
      ctx,
      page.map((r) => r.id),
    ),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.g, last.s, last.id]) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Bulk edit
// ---------------------------------------------------------------------------------------------

type RowResult = z.infer<typeof RowResult>;

/** One row of a bulk edit, in the request's transaction (its savepoint is the caller's). */
async function editOne(
  ctx: Ctx,
  id: string,
  rowVersion: number,
  set: BulkEditBody['edits'][number]['set'],
) {
  const { client } = ctx;
  const { to, ...fields } = set;
  const thing = await writableThing(client, id, 'things.edit');
  // A place in the thing's own location (404 for one elsewhere, as an unknown id).
  const target = to ? await targetOf(client, thing.location_id, to) : null;
  if (Object.keys(fields).length > 0) {
    await writeThingUpdate(ctx, id, rowVersion, fields as UpdateBody);
  } else {
    await requireThingVersion(client, id, rowVersion, ['to']);
  }
  if (target) {
    const moveTo = target.containerId
      ? { containerId: target.containerId }
      : { placeId: target.placeId as string };
    await moveThings(ctx, { thingIds: [id], to: moveTo });
  }
}

/** POST /api/v1/things/bulk-edit. */
export async function bulkEdit(ctx: Ctx, body: BulkEditBody): Promise<BulkEditResult> {
  const { client, tx } = ctx;
  const results: RowResult[] = [];
  const saved: string[] = [];
  const events: string[] = [];
  for (const edit of body.edits) {
    const id = edit.id.toLowerCase();
    const mark = undoableMark(tx);
    await client.query('SAVEPOINT sheet_row');
    try {
      await editOne(ctx, id, edit.rowVersion, edit.set);
      await client.query('RELEASE SAVEPOINT sheet_row');
      events.push(...undoableSince(tx, mark));
      saved.push(id);
      results.push({ id, ok: true });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sheet_row');
      forgetUndoableSince(tx, mark);
      const reply = toErrorReply(err);
      if (reply.status >= 500) throw err;
      const b = reply.body as Record<string, unknown>;
      results.push({
        id,
        ok: false,
        status: reply.status,
        code: String(b.code),
        ...(typeof b.hint === 'string' ? { hint: b.hint } : {}),
        ...(Array.isArray(b.conflicts) ? { conflicts: b.conflicts.map(String) } : {}),
        ...(typeof b.row_version === 'number' ? { rowVersion: b.row_version } : {}),
        ...(b.changedBy && typeof b.changedBy === 'object'
          ? { changedBy: b.changedBy as { displayName: string } }
          : {}),
      });
    }
  }
  return { results, rows: await sheetRowsOf(ctx, saved), events };
}

// ---------------------------------------------------------------------------------------------
// Bulk trash
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/things/bulk-trash: every thing, or none (the transaction's error). */
export async function bulkTrash(
  ctx: Ctx,
  body: BulkTrashBody,
): Promise<{ trashed: string[]; moved: string[]; events: string[] }> {
  const { client, tx } = ctx;
  const ids = [...new Set(body.thingIds.map((x) => x.toLowerCase()))];
  const trashed = new Set<string>();
  const moved = new Set<string>();
  const mark = undoableMark(tx);
  for (const id of ids) {
    if (trashed.has(id)) continue;
    try {
      const r = await trashThing(
        { tx, client, scope: ctx.scope, requestId: ctx.requestId, jobs: ctx.jobs },
        id,
        body.contents ? { contents: body.contents } : undefined,
      );
      for (const x of r.trashed) trashed.add(x);
      for (const x of r.moved) moved.add(x);
    } catch (err) {
      // Name the thing that stopped the batch, so the screen can point at its row.
      if (err instanceof AppError) {
        throw new AppError(
          err.code,
          err.status,
          err.hint,
          { ...(err.extra ?? {}), thingId: id },
          err.message,
        );
      }
      throw err;
    }
  }
  return {
    trashed: [...trashed],
    moved: [...moved].filter((x) => !trashed.has(x)),
    events: undoableSince(tx, mark),
  };
}
