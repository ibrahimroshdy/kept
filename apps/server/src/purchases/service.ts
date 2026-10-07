import { AmountError, can, newId, parseAmount, type Role } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { type Gate, gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  amountOut,
  type CreateBody,
  type LineRow,
  lineRows,
  type PatchBody,
  type PurchaseRow,
  type PurchaseView,
  purchaseRow,
  purchaseView,
} from './view.js';

// Purchases and their lines (T12; D13, D115, D136, D161, D168, D189; engineering spec §7.13;
// plan Q2). Location rows under 0018's policies: anyone who sees the location reads them, writers
// write them. The routes check can() first, so a viewer gets 403 rather than the 404 a refused
// policy would give; changing a purchase is `things.edit` (members and up).
//
// Money (D13, D110; plan "Money and secrets"):
// - an amount in a request is read with parseAmount() (Eastern Arabic and Persian digits, `٫`,
//   grouping; D172) and stored as received at full precision (Q2);
// - every amount needs a currency, one that is enabled (D168). None is ever picked for the caller:
//   "$" is refused with a hint to choose USD or CAD (D189), and a purchase with amounts and no
//   currency is a 400, not a silent location default;
// - writing money the caller's gate hides (the money module is off there) is 409 `module_off`, as
//   for things (T14). A member who can't see money edits the rest: an omitted price is kept.
// - audit rows class total, tax and unit_price as money (audit/classes.ts), so renderAudit()
//   hides them from viewers.
//
// Links to things: a line's things are those whose purchase_line_id is the line (a split keeps
// its line; a move within the account keeps it too, D115). Linking a thing needs it in the
// purchase's location (0018's guard). Removing a line, or the purchase, while a thing in another
// location still comes from it is 409 `in_use` (kept.purchase_lines_used_elsewhere, 0027): the
// foreign key would clear those links unseen and unaudited. Links in the same location are
// cleared first, each audited on the thing.

export type Ctx = {
  tx: Tx;
  client: pg.ClientBase;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
};

export function ctxOf(
  req: FastifyRequest,
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
): Ctx {
  return { tx, client, scope, requestId: req.id, files };
}

const EDIT_HINT = 'Viewers can’t change purchases.';
const IN_USE_HINT =
  'A thing moved to another location still comes from this purchase. Ask someone there to unlink it first.';

const actor = (scope: Scope) => actorOf(scope);

/** Writing money where the caller's gate hides it (the money module is off here): 409. */
const moneyOff = () => new AppError('module_off', 409, 'Money is turned off for this location.');

type Access = { role: Role; gate: Gate };

/** 404 unless the caller sees the location; 403 unless they may change purchases there. */
async function editAccess(ctx: Ctx, locationId: string): Promise<Access> {
  const me = await requireMembership(ctx.client, locationId);
  requireCan(me.role, 'things.edit', EDIT_HINT);
  return { role: me.role, gate: await gateFor(ctx.tx, locationId, ctx.scope) };
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** An amount as typed, in canonical form; 400 naming the field when it isn't one. */
function amountIn(raw: string, where: string): string {
  try {
    return parseAmount(raw);
  } catch (err) {
    if (err instanceof AmountError) {
      throw invalid(`Check ${where}: a decimal amount of at most 4 decimals, e.g. 1250.50.`);
    }
    throw err;
  }
}

/** An ISO 4217 code, upper-cased. "$" gets its own hint: it is USD or CAD, never a default. */
function currencyIn(raw: string, where: string): string {
  const code = raw.trim();
  if (code.includes('$')) {
    throw invalid(`Check ${where}: “$” can be USD or CAD. Pick one.`);
  }
  if (!/^[A-Za-z]{3}$/.test(code)) {
    throw invalid(`Check ${where}: a three-letter currency code, e.g. EGP.`);
  }
  return code.toUpperCase();
}

/** 400 unless the currency is enabled on this server (D168). */
async function requireEnabled(client: pg.ClientBase, code: string, where: string): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.currencies WHERE code = $1 AND enabled',
    [code],
  );
  if (!rowCount) throw invalid(`Check ${where}: use a currency that is turned on.`);
}

/** Today in the location's time zone, `YYYY-MM-DD`. */
async function todayIn(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE l.timezone)::date::text AS today
       FROM public.locations l WHERE l.id = $1`,
    [locationId],
  );
  const today = rows[0]?.today;
  if (!today) throw notFound();
  return today;
}

async function checkPurchasedOn(client: pg.ClientBase, locationId: string, on: string) {
  if (on > (await todayIn(client, locationId))) {
    throw invalid('Check body.purchasedOn: it is in the future where this location is.');
  }
}

/** The vendor must be one of the location's account (0018's guard would answer a 404). */
async function checkVendor(client: pg.ClientBase, vendorId: string, locationId: string) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.vendors v
       JOIN public.locations l ON l.owner_account_id = v.owner_account_id
      WHERE v.id = $1 AND l.id = $2`,
    [vendorId, locationId],
  );
  if (!rowCount) throw invalid('Check body.vendorId: a vendor of this location’s account.');
}

type LinkTarget = { id: string; purchaseLineId: string | null };

/** A live thing the caller sees, in the purchase's location; 400 naming the field otherwise. */
async function linkTarget(
  client: pg.ClientBase,
  thingId: string,
  locationId: string,
  where: string,
): Promise<LinkTarget> {
  const { rows } = await client.query<{ id: string; purchase_line_id: string | null }>(
    `SELECT id, purchase_line_id FROM public.things
      WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
    [thingId, locationId],
  );
  const row = rows[0];
  if (!row) throw invalid(`Check ${where}: a thing in this purchase’s location.`);
  return { id: row.id, purchaseLineId: row.purchase_line_id };
}

// ---------------------------------------------------------------------------------------------
// Audit images
// ---------------------------------------------------------------------------------------------

type Image = Record<string, unknown>;

function purchaseImage(p: PurchaseRow): Image {
  return {
    vendor_id: p.vendor_id,
    purchased_on: p.purchased_on,
    currency: p.currency,
    total: amountOut(p.total),
    tax: amountOut(p.tax),
    notes: p.notes,
  };
}

function lineImage(purchaseId: string, l: LineRow): Image {
  return {
    purchase_id: purchaseId,
    description: l.description,
    quantity: amountOut(l.quantity),
    unit_price: amountOut(l.unit_price),
    sort: l.sort,
  };
}

const sameImage = (a: Image, b: Image) => JSON.stringify(a) === JSON.stringify(b);

/** The live things in the purchase's location that came from its lines (for subjects). */
async function linkedThings(
  client: pg.ClientBase,
  purchaseId: string,
  lineIds?: readonly string[],
): Promise<{ id: string; line: string }[]> {
  const { rows } = await client.query<{ id: string; line: string }>(
    `SELECT t.id, t.purchase_line_id AS line
       FROM public.things t JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
      WHERE pl.purchase_id = $1 AND t.location_id = pl.location_id
        AND ($2::uuid[] IS NULL OR pl.id = ANY ($2::uuid[]))
      ORDER BY t.id`,
    [purchaseId, lineIds ?? null],
  );
  return rows;
}

/** Sets (or clears) a thing's purchase line, audited on the thing. */
async function setThingLine(
  ctx: Ctx,
  locationId: string,
  thing: LinkTarget,
  lineId: string | null,
): Promise<void> {
  if (thing.purchaseLineId === lineId) return;
  await ctx.client.query('UPDATE public.things SET purchase_line_id = $2 WHERE id = $1', [
    thing.id,
    lineId,
  ]);
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx.scope),
    action: lineId ? 'thing.purchase_link' : 'thing.purchase_unlink',
    entity: { type: 'thing', id: thing.id },
    before: { purchase_line_id: thing.purchaseLineId },
    after: { purchase_line_id: lineId },
    subjects: [thing.id],
    rootThingId: thing.id,
    requestId: ctx.requestId,
  });
}

/** 409 `in_use` while a thing in another location comes from these lines (all when omitted). */
async function refuseUsedElsewhere(
  client: pg.ClientBase,
  purchaseId: string,
  lineIds: readonly string[] | null,
): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT kept.purchase_lines_used_elsewhere($1, $2::uuid[]) AS n',
    [purchaseId, lineIds],
  );
  if ((rows[0]?.n ?? 0) > 0) throw new AppError('in_use', 409, IN_USE_HINT);
}

/** Clears the same-location links of these lines, then deletes them, each audited. */
async function removeLines(
  ctx: Ctx,
  p: PurchaseRow,
  lines: readonly LineRow[],
  deleteRows: boolean,
): Promise<void> {
  if (lines.length === 0) return;
  const ids = lines.map((l) => l.id);
  const linked = await linkedThings(ctx.client, p.id, ids);
  for (const t of linked) {
    await setThingLine(ctx, p.location_id, { id: t.id, purchaseLineId: t.line }, null);
  }
  if (deleteRows) {
    await ctx.client.query('DELETE FROM public.purchase_lines WHERE id = ANY ($1::uuid[])', [ids]);
  }
  for (const l of lines) {
    await audited(ctx.tx, {
      locationId: p.location_id,
      actor: actor(ctx.scope),
      action: 'purchase_line.delete',
      entity: { type: 'purchase_line', id: l.id },
      before: lineImage(p.id, l),
      after: null,
      subjects: linked.filter((t) => t.line === l.id).map((t) => t.id),
      requestId: ctx.requestId,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/purchases
// ---------------------------------------------------------------------------------------------

export async function createPurchase(ctx: Ctx, body: CreateBody): Promise<PurchaseView> {
  const { client } = ctx;
  const locationId = body.locationId.toLowerCase();
  const { gate } = await editAccess(ctx, locationId);
  const id = body.id ? assertClientId(body.id) : newId();

  const total = body.total !== undefined ? amountIn(body.total, 'body.total') : null;
  const tax = body.tax !== undefined ? amountIn(body.tax, 'body.tax') : null;
  const lines = body.lines.map((l, i) => ({
    id: l.id ? assertClientId(l.id) : newId(),
    description: l.description,
    quantity: l.quantity,
    unitPrice:
      l.unitPrice !== undefined ? amountIn(l.unitPrice, `body.lines[${i}].unitPrice`) : null,
    thingId: l.thingId?.toLowerCase() ?? null,
  }));
  const anyMoney = total !== null || tax !== null || lines.some((l) => l.unitPrice !== null);
  if (anyMoney && !gate.showMoney) throw moneyOff();

  const currency = body.currency !== undefined ? currencyIn(body.currency, 'body.currency') : null;
  if (currency) await requireEnabled(client, currency, 'body.currency');
  if (anyMoney && !currency) {
    throw invalid('Check body.currency: amounts need a currency. Pick one; none is assumed.');
  }
  await checkPurchasedOn(client, locationId, body.purchasedOn);
  if (body.vendorId) await checkVendor(client, body.vendorId.toLowerCase(), locationId);

  if (new Set(lines.map((l) => l.id)).size !== lines.length) {
    throw invalid('Check body.lines: each line needs its own id.');
  }
  const thingIds = lines.flatMap((l) => (l.thingId ? [l.thingId] : []));
  if (new Set(thingIds).size !== thingIds.length) {
    throw invalid('Check body.lines: a thing comes from one line only.');
  }
  const targets = new Map<string, LinkTarget>();
  for (const [i, l] of lines.entries()) {
    if (l.thingId) {
      targets.set(
        l.thingId,
        await linkTarget(client, l.thingId, locationId, `body.lines[${i}].thingId`),
      );
    }
  }

  await client.query(
    `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total, tax,
                                   notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      locationId,
      body.vendorId?.toLowerCase() ?? null,
      body.purchasedOn,
      currency,
      total,
      tax,
      body.notes ?? null,
    ],
  );
  for (const [i, l] of lines.entries()) {
    await client.query(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity,
                                          unit_price, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [l.id, locationId, id, l.description, l.quantity, l.unitPrice, i],
    );
  }

  const after = await purchaseRow(client, id);
  const linked = lines.flatMap((l) => (l.thingId ? [l.thingId] : []));
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx.scope),
    action: 'purchase.create',
    entity: { type: 'purchase', id },
    after: purchaseImage(after),
    subjects: linked,
    requestId: ctx.requestId,
  });
  for (const l of await lineRows(client, id)) {
    await audited(ctx.tx, {
      locationId,
      actor: actor(ctx.scope),
      action: 'purchase_line.create',
      entity: { type: 'purchase_line', id: l.id },
      after: lineImage(id, l),
      subjects: lines.filter((x) => x.id === l.id && x.thingId).map((x) => x.thingId as string),
      requestId: ctx.requestId,
    });
  }
  for (const l of lines) {
    const target = l.thingId ? targets.get(l.thingId) : undefined;
    if (target) await setThingLine(ctx, locationId, target, l.id);
  }
  return purchaseView(client, ctx.files, gate, id);
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/purchases/:id
// ---------------------------------------------------------------------------------------------

export async function getPurchase(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  id: string,
): Promise<PurchaseView> {
  const p = await purchaseRow(client, id);
  const gate = await gateFor(tx, p.location_id, scope);
  return purchaseView(client, files, gate, id);
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/v1/purchases/:id (If-Match)
// ---------------------------------------------------------------------------------------------

type PlannedLine = {
  id: string;
  existing: LineRow | null;
  description: string | undefined;
  quantity: number | undefined;
  /** undefined: unchanged; null: cleared. */
  unitPrice: string | null | undefined;
  thingId: string | null | undefined;
  where: string;
};

export async function updatePurchase(
  ctx: Ctx,
  id: string,
  expected: number,
  body: PatchBody,
): Promise<PurchaseView> {
  const { client } = ctx;
  const seen = await purchaseRow(client, id);
  const locationId = seen.location_id;
  const { gate } = await editAccess(ctx, locationId);
  const p = await purchaseRow(client, id, true);
  const fields = Object.keys(body).filter((k) => body[k as keyof PatchBody] !== undefined);
  const changedBy = await lastChangedBy(client, locationId, { type: 'purchase', id });
  checkVersion(
    { rowVersion: p.row_version },
    expected,
    fields,
    changedBy ? { displayName: changedBy } : null,
  );

  // Money in the request: any amount set or cleared.
  const total =
    body.total === undefined
      ? undefined
      : body.total === null
        ? null
        : amountIn(body.total, 'body.total');
  const tax =
    body.tax === undefined ? undefined : body.tax === null ? null : amountIn(body.tax, 'body.tax');

  const existing = await lineRows(client, id);
  const byId = new Map(existing.map((l) => [l.id, l]));
  let planned: PlannedLine[] | null = null;
  if (body.lines !== undefined) {
    planned = body.lines.map((l, i) => {
      const where = `body.lines[${i}]`;
      const lineId = l.id?.toLowerCase();
      const found = lineId ? (byId.get(lineId) ?? null) : null;
      if (!found && l.description === undefined) {
        throw invalid(`Check ${where}.description: a new line needs one.`);
      }
      return {
        id: found ? found.id : lineId ? assertClientId(lineId) : newId(),
        existing: found,
        description: l.description,
        quantity: l.quantity,
        unitPrice:
          l.unitPrice === undefined
            ? undefined
            : l.unitPrice === null
              ? null
              : amountIn(l.unitPrice, `${where}.unitPrice`),
        thingId: l.thingId === undefined ? undefined : (l.thingId?.toLowerCase() ?? null),
        where,
      };
    });
    if (new Set(planned.map((l) => l.id)).size !== planned.length) {
      throw invalid('Check body.lines: each line needs its own id.');
    }
    const things = planned.flatMap((l) => (l.thingId ? [l.thingId] : []));
    if (new Set(things).size !== things.length) {
      throw invalid('Check body.lines: a thing comes from one line only.');
    }
  }
  let currency = p.currency;
  if (body.currency !== undefined) {
    currency = body.currency === null ? null : currencyIn(body.currency, 'body.currency');
  }
  // Changing the currency counts as writing money (review #31): where the gate hides money it is
  // 409 like an amount, before the "amounts need a currency" check below could answer 400 and so
  // say that hidden amounts exist. Sending the currency it already has changes nothing.
  const writesMoney =
    total !== undefined ||
    tax !== undefined ||
    currency !== p.currency ||
    (planned?.some((l) => l.unitPrice !== undefined) ?? false);
  if (writesMoney && !gate.showMoney) throw moneyOff();
  if (currency && currency !== p.currency) {
    await requireEnabled(client, currency, 'body.currency');
  }
  // After the change, every amount still needs a currency.
  const finalTotal = total === undefined ? p.total : total;
  const finalTax = tax === undefined ? p.tax : tax;
  const finalPrices = planned
    ? planned.map((l) =>
        l.unitPrice === undefined ? (l.existing?.unit_price ?? null) : l.unitPrice,
      )
    : existing.map((l) => l.unit_price);
  if (
    !currency &&
    (finalTotal !== null || finalTax !== null || finalPrices.some((x) => x !== null))
  ) {
    throw invalid('Check body.currency: amounts need a currency. Pick one; none is assumed.');
  }
  if (body.purchasedOn !== undefined) await checkPurchasedOn(client, locationId, body.purchasedOn);
  if (body.vendorId) await checkVendor(client, body.vendorId.toLowerCase(), locationId);

  // Lines the PATCH leaves out go, unless a thing elsewhere still comes from them.
  const removed = planned
    ? existing.filter((l) => !planned.some((x) => x.id === l.id))
    : ([] as LineRow[]);
  if (removed.length > 0) {
    await refuseUsedElsewhere(
      client,
      id,
      removed.map((l) => l.id),
    );
  }
  const targets = new Map<string, LinkTarget>();
  for (const l of planned ?? []) {
    if (l.thingId) {
      targets.set(l.thingId, await linkTarget(client, l.thingId, locationId, `${l.where}.thingId`));
    }
  }

  // The purchase's own columns.
  const set: string[] = [];
  const values: unknown[] = [id];
  const put = (column: string, value: unknown) => {
    values.push(value);
    set.push(`${column} = $${values.length}`);
  };
  if (body.vendorId !== undefined) put('vendor_id', body.vendorId?.toLowerCase() ?? null);
  if (body.purchasedOn !== undefined) put('purchased_on', body.purchasedOn);
  if (body.currency !== undefined) put('currency', currency);
  if (total !== undefined) put('total', total);
  if (tax !== undefined) put('tax', tax);
  if (body.notes !== undefined) put('notes', body.notes);
  if (set.length === 0 && planned) put('updated_at', new Date());
  if (set.length > 0) {
    await client.query(`UPDATE public.purchases SET ${set.join(', ')} WHERE id = $1`, values);
  }

  // The lines: removed, changed, added; then their links.
  await removeLines(ctx, p, removed, true);
  for (const [sort, l] of (planned ?? []).entries()) {
    if (l.existing) {
      const before = lineImage(id, l.existing);
      await client.query(
        `UPDATE public.purchase_lines
            SET description = coalesce($2, description), quantity = coalesce($3, quantity),
                unit_price = CASE WHEN $4 THEN $5::numeric ELSE unit_price END, sort = $6
          WHERE id = $1`,
        [
          l.id,
          l.description ?? null,
          l.quantity ?? null,
          l.unitPrice !== undefined,
          l.unitPrice ?? null,
          sort,
        ],
      );
      const [row] = (await lineRows(client, id)).filter((r) => r.id === l.id);
      const after = lineImage(id, row as LineRow);
      if (!sameImage(before, after)) {
        await audited(ctx.tx, {
          locationId,
          actor: actor(ctx.scope),
          action: 'purchase_line.update',
          entity: { type: 'purchase_line', id: l.id },
          before,
          after,
          subjects: (await linkedThings(client, id, [l.id])).map((t) => t.id),
          requestId: ctx.requestId,
        });
      }
    } else {
      await client.query(
        `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity,
                                            unit_price, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [l.id, locationId, id, l.description, l.quantity ?? 1, l.unitPrice ?? null, sort],
      );
      const [row] = (await lineRows(client, id)).filter((r) => r.id === l.id);
      await audited(ctx.tx, {
        locationId,
        actor: actor(ctx.scope),
        action: 'purchase_line.create',
        entity: { type: 'purchase_line', id: l.id },
        after: lineImage(id, row as LineRow),
        subjects: l.thingId ? [l.thingId] : [],
        requestId: ctx.requestId,
      });
    }
  }
  for (const l of planned ?? []) {
    if (l.thingId === null) {
      const linked = await linkedThings(client, id, [l.id]);
      for (const t of linked) {
        await setThingLine(ctx, locationId, { id: t.id, purchaseLineId: t.line }, null);
      }
    } else if (l.thingId) {
      await setThingLine(ctx, locationId, targets.get(l.thingId) as LinkTarget, l.id);
    }
  }

  const after = await purchaseRow(client, id);
  const beforeImage = purchaseImage(p);
  const afterImage = purchaseImage(after);
  if (!sameImage(beforeImage, afterImage)) {
    await audited(ctx.tx, {
      locationId,
      actor: actor(ctx.scope),
      action: 'purchase.update',
      entity: { type: 'purchase', id },
      before: beforeImage,
      after: afterImage,
      subjects: (await linkedThings(client, id)).map((t) => t.id),
      requestId: ctx.requestId,
    });
  }
  return purchaseView(client, ctx.files, gate, id);
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/purchases/:id
// ---------------------------------------------------------------------------------------------

export async function deletePurchase(ctx: Ctx, id: string): Promise<void> {
  const { client } = ctx;
  const seen = await purchaseRow(client, id);
  const locationId = seen.location_id;
  const { role } = await editAccess(ctx, locationId);
  const p = await purchaseRow(client, id, true);
  await refuseUsedElsewhere(client, id, null);

  // Its receipts go with it (the attachments cascade): someone else's only for those who may
  // delete any attachment (§7.1), as DELETE /attachments/:id would decide.
  const { rows: attachments } = await client.query<{
    id: string;
    file_id: string | null;
    url: string | null;
    role: string;
    sort: number;
    created_by: string;
  }>(
    `SELECT id, file_id, url, role, sort, created_by FROM public.attachments
      WHERE purchase_id = $1 ORDER BY sort, id`,
    [id],
  );
  if (
    attachments.some((a) => a.created_by !== ctx.scope.userId) &&
    !can(role, 'attachments.delete-any')
  ) {
    throw forbidden('Someone else added a receipt to this purchase. Ask an admin to delete it.');
  }

  const lines = await lineRows(client, id);
  await removeLines(ctx, p, lines, false);
  await client.query('DELETE FROM public.purchases WHERE id = $1', [id]);
  for (const a of attachments) {
    await audited(ctx.tx, {
      locationId,
      actor: actor(ctx.scope),
      action: 'attachment.delete',
      entity: { type: 'attachment', id: a.id },
      before: { purchase_id: id, file_id: a.file_id, url: a.url, role: a.role, sort: a.sort },
      after: null,
      requestId: ctx.requestId,
    });
  }
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx.scope),
    action: 'purchase.delete',
    entity: { type: 'purchase', id },
    before: purchaseImage(p),
    after: null,
    requestId: ctx.requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// POST|DELETE /api/v1/purchase-lines/:id/link
// ---------------------------------------------------------------------------------------------

async function lineOf(
  client: pg.ClientBase,
  lineId: string,
): Promise<{ purchaseId: string; locationId: string }> {
  const { rows } = await client.query<{ purchase_id: string; location_id: string }>(
    'SELECT purchase_id, location_id FROM public.purchase_lines WHERE id = $1',
    [lineId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return { purchaseId: row.purchase_id, locationId: row.location_id };
}

/** Links a thing of the line's location to the line; the thing's If-Match when sent. */
export async function linkLine(
  ctx: Ctx,
  lineId: string,
  thingId: string,
  expected: number | null,
): Promise<PurchaseView> {
  const line = await lineOf(ctx.client, lineId);
  const { gate } = await editAccess(ctx, line.locationId);
  const target = await linkTarget(ctx.client, thingId, line.locationId, 'body.thingId');
  if (expected !== null) {
    const { rows } = await ctx.client.query<{ row_version: number }>(
      'SELECT row_version FROM public.things WHERE id = $1 FOR UPDATE',
      [thingId],
    );
    const changedBy = await lastChangedBy(ctx.client, line.locationId, {
      type: 'thing',
      id: thingId,
    });
    checkVersion(
      { rowVersion: rows[0]?.row_version ?? -1 },
      expected,
      ['purchaseLineId'],
      changedBy ? { displayName: changedBy } : null,
    );
  }
  await setThingLine(ctx, line.locationId, target, lineId);
  return purchaseView(ctx.client, ctx.files, gate, line.purchaseId);
}

/** Unlinks one thing from the line (`thingId`), or every thing of its location. */
export async function unlinkLine(ctx: Ctx, lineId: string, thingId?: string): Promise<void> {
  const line = await lineOf(ctx.client, lineId);
  await editAccess(ctx, line.locationId);
  const linked = await linkedThings(ctx.client, line.purchaseId, [lineId]);
  const which = thingId ? linked.filter((t) => t.id === thingId) : linked;
  if (thingId && which.length === 0) throw notFound();
  for (const t of which) {
    await setThingLine(ctx, line.locationId, { id: t.id, purchaseLineId: t.line }, null);
  }
}
