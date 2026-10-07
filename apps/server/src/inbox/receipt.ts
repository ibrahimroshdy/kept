import { newId, normalize, parseAmount, tsQuery } from '@kept/shared';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { invalid } from '../http/errors.js';
import { unplacedOf } from '../places/view.js';
import { updatePurchase } from '../purchases/service.js';
import { lineRows, type PatchBody, purchaseRow } from '../purchases/view.js';
import { createItem } from '../registries/service.js';
import { gateFor } from '../serialize/gates.js';
import { insertThing } from '../things/service.js';
import { rowsOf, type ThingRow, ThingRowSchema } from '../things/view.js';
import { type ActionResult, type Ctx, openItem, resolveItem } from './service.js';

// Receipts in the inbox (plan T15; D11, D19, D175 "link a receipt to an existing thing"; the J2
// order: the photo came first). The web contract is apps/web/src/api/capture/types.ts:
// InboxCandidates, InboxReceiptBody.
//
// GET  /api/v1/inbox/:id/candidates?line=<index> → {things: (ThingRow & {match?})[]}
//   Things of the item's location a receipt line may be: those whose brand and model the line
//   names first (`match: 'brand_model'`), then by how close their name is (`'name'`). Without
//   `line`, the receipt's lines together; for any other kind of item, its thing's words. The text
//   match goes through kept.search_thing_ids() (0030): `@@` and `%` aren't leakproof, so under
//   the policy they would read every visible thing (§7.2); the door uses the indexes and applies
//   the caller's visibility itself, and the rows are then read by id through the policies.
// POST /api/v1/inbox/:id/receipt (If-Match) → {}
//   Confirms the draft purchase: the vendor (an existing one, or made inline, D11), the date, and
//   per line "New thing" (a draft sharing the purchase, D19, with its own draft item), "Link"
//   (the thing comes from that line: PATCH /purchases' line link) or "Skip" (the line stays,
//   unlinked). Lines the body doesn't name stay as AI read them. Amounts and the currency are
//   written only where the caller's gate shows money; otherwise the purchase keeps what AI read.
//   The purchase becomes `confirmed` (`purchase.confirm`), an open currency question for it is
//   answered with it, and the item resolves `linked` when a line was linked, else `accepted`.

const MATCHES = ['brand_model', 'name'] as const;
type Match = (typeof MATCHES)[number];

export const CandidatesQuery = z.object({
  line: z.coerce.number().int().min(0).max(499).optional(),
});

export const CandidatesSchema = z.object({
  things: z.array(ThingRowSchema.extend({ match: z.enum(MATCHES).optional() })),
});

/** How many things the door may hand back before ranking. */
const DOOR_LIMIT = 500;
/** How many candidates are answered. */
const CANDIDATES = 10;

/** Words worth searching on: three characters or more, with a letter in them. */
function wordsOf(text: string): string[] {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && /\p{L}/u.test(w)))].slice(0, 20);
}

/** GET /api/v1/inbox/:id/candidates. */
export async function candidates(
  ctx: Ctx,
  id: string,
  line: number | undefined,
): Promise<{ things: (ThingRow & { match?: Match })[] }> {
  const { client } = ctx;
  const item = await openItem(client, id, null, { lock: false });
  let text = '';
  if (item.purchase_id) {
    const lines = await lineRows(client, item.purchase_id);
    if (line !== undefined) {
      const one = lines[line];
      if (!one) throw invalid('Check line: the receipt has no such line.');
      text = one.description;
    } else {
      text = lines.map((l) => l.description).join(' ');
    }
  } else if (item.thing_id) {
    const { rows } = await client.query<{ words: string | null }>(
      `SELECT concat_ws(' ', t.name, b.name, t.model) AS words
         FROM public.things t LEFT JOIN public.brands b ON b.id = t.brand_id WHERE t.id = $1`,
      [item.thing_id],
    );
    text = rows[0]?.words ?? '';
  }
  const words = wordsOf(text);
  if (words.length === 0) return { things: [] };
  const tsq = words
    .map((w) => tsQuery(w))
    .filter((q): q is string => !!q)
    .map((q) => `(${q})`)
    .join(' | ');
  const nq = normalize(text);
  const own = [item.thing_id, item.other_thing_id].filter((x): x is string => !!x);
  // The door answers ids; the rows are then read by id (the primary key), never joined to it
  // (a join the planner may answer with a scan of every visible thing).
  const { rows: hits } = await client.query<{ id: string }>(
    `SELECT h AS id
       FROM kept.search_thing_ids(to_tsquery('simple', $1), NULL::tsquery, $2, $3) h
      LIMIT ${DOOR_LIMIT}`,
    [tsq, nq, item.location_id],
  );
  if (hits.length === 0) return { things: [] };
  const { rows } = await client.query<{
    id: string;
    brand: string | null;
    model: string | null;
    sim: number;
  }>(
    `SELECT t.id, kept.normalize(b.name) AS brand, kept.normalize(t.model) AS model,
            similarity(kept.normalize(t.name), $2)::float8 AS sim
       FROM public.things t
       LEFT JOIN public.brands b ON b.id = t.brand_id
      WHERE t.id = ANY ($1::uuid[]) AND t.location_id = $3 AND t.deleted_at IS NULL
        AND t.name IS NOT NULL AND NOT (t.id = ANY ($4::uuid[]))`,
    [hits.map((h) => h.id), nq, item.location_id, own],
  );
  const padded = ` ${nq} `;
  const has = (needle: string | null) => !!needle && padded.includes(` ${needle} `);
  const ranked = rows
    .map((r) => ({
      id: r.id,
      match: (has(r.brand) && has(r.model) ? 'brand_model' : 'name') as Match,
      sim: Number(r.sim),
    }))
    .sort((a, b) =>
      a.match !== b.match
        ? a.match === 'brand_model'
          ? -1
          : 1
        : b.sim - a.sim || (a.id < b.id ? -1 : 1),
    )
    .slice(0, CANDIDATES);
  const byId = new Map(ranked.map((r) => [r.id, r.match]));
  const things = await rowsOf(
    client,
    ctx.files,
    ranked.map((r) => r.id),
  );
  return { things: things.map((t) => ({ ...t, match: byId.get(t.id) as Match })) };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/inbox/:id/receipt
// ---------------------------------------------------------------------------------------------

const Target = z.union([
  z.strictObject({ placeId: z.uuid() }),
  z.strictObject({ containerId: z.uuid() }),
  z.strictObject({ unplaced: z.literal(true) }),
]);

export const ReceiptBody = z.strictObject({
  vendor: z.union([
    z.strictObject({ id: z.uuid() }),
    z.strictObject({ name: z.string().trim().min(1).max(200) }),
  ]),
  purchasedOn: z.iso.date(),
  currency: z.string().trim().min(1).max(8),
  total: z.string().trim().min(1).max(40).optional(),
  tax: z.string().trim().min(1).max(40).optional(),
  lines: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(499),
        description: z.string().trim().min(1).max(300),
        quantity: z.string().trim().min(1).max(20),
        unitPrice: z.string().trim().min(1).max(40).optional(),
        action: z.enum(['new_thing', 'link', 'skip']),
        thingId: z.uuid().optional(),
        target: Target.optional(),
      }),
    )
    .max(500),
});
export type ReceiptBody = z.infer<typeof ReceiptBody>;

/** A line's quantity as typed (any digits parseAmount reads), as a number. */
function quantityIn(raw: string, where: string): number {
  let n: number;
  try {
    n = Number(parseAmount(raw));
  } catch {
    throw invalid(`Check ${where}: a number, e.g. 2.`);
  }
  if (!(n > 0) || n > 999_999_999) throw invalid(`Check ${where}: more than 0.`);
  return Math.round(n * 1000) / 1000;
}

/** POST /api/v1/inbox/:id/receipt. */
export async function confirmReceipt(
  ctx: Ctx,
  id: string,
  expected: number,
  body: ReceiptBody,
): Promise<ActionResult> {
  const { client, tx, scope } = ctx;
  const item = await openItem(client, id, expected);
  if (item.kind !== 'receipt' || !item.purchase_id) {
    throw invalid('This item is not a receipt.');
  }
  const purchaseId = item.purchase_id;
  const locationId = item.location_id;
  const gate = await gateFor(tx, locationId, scope);
  const p = await purchaseRow(client, purchaseId, true);

  const seen = new Set<number>();
  for (const [i, l] of body.lines.entries()) {
    if (seen.has(l.index)) throw invalid(`Check lines[${i}].index: each line once.`);
    seen.add(l.index);
    if (l.action === 'link' && !l.thingId) {
      throw invalid(`Check lines[${i}].thingId: say which thing it links to.`);
    }
  }

  // The vendor: one of the account's, or a new one made inline (D11).
  let vendorId: string;
  if ('id' in body.vendor) {
    vendorId = body.vendor.id.toLowerCase();
  } else {
    const { rows } = await client.query<{ account: string }>(
      'SELECT owner_account_id AS account FROM public.locations WHERE id = $1',
      [locationId],
    );
    const made = await createItem(
      { tx, client, userId: scope.userId, requestId: ctx.requestId, jobs: ctx.jobs },
      'vendors',
      rows[0]?.account as string,
      { name: body.vendor.name },
    );
    vendorId = made.item.id;
  }

  // New things first: each is a draft sharing the purchase, with its own draft item (D19).
  const existing = await lineRows(client, purchaseId);
  const madeFor = new Map<number, string>();
  let unplaced: string | null = null;
  for (const [i, l] of body.lines.entries()) {
    if (l.action !== 'new_thing') continue;
    let where: { placeId: string } | { containerId: string };
    if (l.target && 'placeId' in l.target) where = { placeId: l.target.placeId };
    else if (l.target && 'containerId' in l.target) where = { containerId: l.target.containerId };
    else {
      unplaced ??= await unplacedOf(client, locationId);
      where = { placeId: unplaced };
    }
    const thingId = await insertThing(
      ctx,
      {
        locationId,
        ...where,
        name: l.description,
        quantity: quantityIn(l.quantity, `lines[${i}].quantity`),
      },
      {
        draft: true,
        ...(item.batch_id ? { captureBatchId: item.batch_id } : {}),
        fieldStatus: { name: { state: 'extracted' } },
      },
    );
    await client.query(
      `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, batch_id, created_by, payload)
       VALUES ($1, $2, 'draft', $3, $4, kept.current_user_id(), $5)
       ON CONFLICT DO NOTHING`,
      [newId(), locationId, thingId, item.batch_id, JSON.stringify({ fromPurchaseId: purchaseId })],
    );
    madeFor.set(l.index, thingId);
  }

  // The purchase: vendor, date, lines and links, money where the gate shows it.
  const byIndex = new Map(body.lines.map((l) => [l.index, l]));
  const lastIndex = Math.max(existing.length - 1, ...body.lines.map((l) => l.index));
  const lines: NonNullable<PatchBody['lines']> = [];
  for (let index = 0; index <= lastIndex; index++) {
    const have = existing[index];
    const l = byIndex.get(index);
    if (!l) {
      // A line the body leaves out stays as it is; an index past the end with no line is a gap.
      if (have) lines.push({ id: have.id });
      continue;
    }
    const thingId = l.action === 'link' ? l.thingId?.toLowerCase() : madeFor.get(index);
    lines.push({
      ...(have ? { id: have.id } : {}),
      description: l.description,
      quantity: quantityIn(l.quantity, `lines[${index}].quantity`),
      ...(gate.showMoney && l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
      ...(thingId ? { thingId } : {}),
    });
  }
  const patch: PatchBody = {
    vendorId,
    purchasedOn: body.purchasedOn,
    lines,
    ...(gate.showMoney
      ? {
          currency: body.currency,
          ...(body.total !== undefined ? { total: body.total } : {}),
          ...(body.tax !== undefined ? { tax: body.tax } : {}),
        }
      : {}),
  };
  await updatePurchase(
    { tx, client, scope, requestId: ctx.requestId, files: ctx.files },
    purchaseId,
    p.row_version,
    patch,
  );

  const { rows: states } = await client.query<{ review_state: string }>(
    'SELECT review_state FROM public.purchases WHERE id = $1',
    [purchaseId],
  );
  await client.query(`UPDATE public.purchases SET review_state = 'confirmed' WHERE id = $1`, [
    purchaseId,
  ]);
  const linkedIds = body.lines.flatMap((l) =>
    l.action === 'link' && l.thingId ? [l.thingId.toLowerCase()] : [],
  );
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'purchase.confirm',
    entity: { type: 'purchase', id: purchaseId },
    before: { review_state: states[0]?.review_state ?? 'draft' },
    after: { review_state: 'confirmed' },
    subjects: [...madeFor.values(), ...linkedIds],
    requestId: ctx.requestId,
  });

  // Its currency question is answered with it.
  const { rows: open } = await client.query<{ id: string }>(
    `SELECT id FROM public.inbox_items
      WHERE purchase_id = $1 AND kind = 'currency' AND resolved_at IS NULL FOR UPDATE`,
    [purchaseId],
  );
  for (const c of open) {
    await resolveItem(ctx, { ...item, id: c.id, kind: 'currency' }, 'accepted');
  }
  await resolveItem(ctx, item, linkedIds.length > 0 ? 'linked' : 'accepted');
  return {};
}
