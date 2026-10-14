import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { typeCapabilities } from '../things/fields.js';

// A service line that uses stock from a consumable (D236, builds D170): the oil filter comes off
// the shelf count. A line names its consumable by `consumable_thing_id` (0128, 0129: a thing of the
// line's own location). The count moves by the **difference** between a record's lines before
// and after a write, through moveStock(), which every path that rewrites lines calls with the
// lines it read before and after: logging a service (and completing a schedule), confirming a
// draft, editing, deleting, and the undo of each. So changing a line's quantity moves the count
// by the change, removing the line or the record puts it back, and an undo puts it where it was.
//
// - A line uses its `consumed_quantity` when set (one "oil change" line that took 4.5 litres),
//   else its quantity, or 1 when it has none (as a priced line's sum counts it).
// - Taking more than is left is 409 `not_enough_stock`, naming the thing and what is left; a
//   consumable may reach 0, never below (D183). Nothing is written then.
// - Taking from a thing in the trash is refused (409 `conflict`: restore it first); giving back to
//   one is not, so deleting an old service still restores the count a restore will show.
// - Each change is audited `thing.stock_use` on the consumable (its history): the quantity before
//   and after, and the service record with what it was for, so the row says "Used in a service of
//   <car>". It is not undoable on its own: the service's own event is, and its undo moves the
//   stock back through here.
// - A draft (an invoice being read, services/drafts.ts) has no lines, so it moves nothing until it
//   is confirmed.
// - A new link needs Consumables on in the location (409 `module_off`), a thing the caller sees
//   there, live (404 otherwise: another location's thing is not found), whose type is consumable
//   (409 `not_consumable`). A link the record already had is kept as it is, whatever happened to
//   the thing since; the module being off later stops no edit (the count stays right).

export type StockCtx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

/** A line as the stock sees it: its consumable, how much it took when that isn't its quantity,
 * and its quantity (null: 1). */
export type StockLine = {
  consumable_thing_id?: string | null;
  consumed_quantity?: string | null;
  quantity: string | null;
};

/** The record whose lines moved the stock: its id and what it was for, for the audit row. */
export type StockRecord = {
  id: string;
  locationId: string;
  thingId: string | null;
  placeId: string | null;
};

/** The largest quantity a thing holds (things/validate.ts Quantity), in thousandths. */
const QUANTITY_MAX_MILLI = 999_999_999_000n;

/** A non-negative decimal string with up to 3 places as thousandths, exactly. */
export function milli(q: string): bigint {
  const [whole = '0', frac = ''] = q.trim().split('.');
  return BigInt((whole || '0') + frac.padEnd(3, '0').slice(0, 3));
}

/** Thousandths as the shortest decimal string ("4", "0.5"). */
export function decimal(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** What the lines take, per consumable, in thousandths. */
export function stockUse(lines: readonly StockLine[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of lines) {
    if (!l.consumable_thing_id) continue;
    const id = l.consumable_thing_id.toLowerCase();
    out.set(id, (out.get(id) ?? 0n) + milli(l.consumed_quantity ?? l.quantity ?? '1'));
  }
  return out;
}

/** 409 `not_enough_stock`: `left` of `name` is all there is. */
function notEnough(thing: { id: string; name: string | null }, left: bigint): AppError {
  const what = thing.name ?? 'this thing';
  return new AppError(
    'not_enough_stock',
    409,
    `Only ${decimal(left)} of ${what} left. Lower the quantity or adjust the stock first.`,
    { thing: { id: thing.id, name: thing.name }, left: decimal(left) },
  );
}

/**
 * The consumables a write's lines newly name, checked before anything is written: Consumables on
 * (409 `module_off`), each a live thing the caller sees in `locationId` (404), of a consumable
 * type (409 `not_consumable`). `linked` are the lines the record has now: a consumable they
 * already name passes as it is.
 */
export async function requireStockThings(
  ctx: StockCtx,
  locationId: string,
  lines: readonly { consumableThingId?: string | undefined }[],
  linked: readonly StockLine[] = [],
): Promise<void> {
  const had = new Set(stockUse(linked).keys());
  const ids = [
    ...new Set(
      lines.flatMap((l) => (l.consumableThingId ? [l.consumableThingId.toLowerCase()] : [])),
    ),
  ].filter((id) => !had.has(id));
  if (ids.length === 0) return;
  if (!(await gateFor(ctx.tx, locationId, ctx.scope)).modules.has('consumables')) {
    throw new AppError('module_off', 409, 'Consumables is off in this location.');
  }
  const { rows } = await ctx.client.query<{ id: string; type_id: string | null }>(
    `SELECT t.id, t.type_id FROM public.things t
      WHERE t.id = ANY ($1::uuid[]) AND t.location_id = $2 AND t.deleted_at IS NULL`,
    [ids, locationId],
  );
  for (const id of ids) {
    const thing = rows.find((r) => r.id === id);
    if (!thing) throw notFound("Check the line's stock: no such consumable in this location.");
    if (!(await typeCapabilities(ctx.client, thing.type_id)).includes('consumable')) {
      throw new AppError(
        'not_consumable',
        409,
        'Only things you run out of can be used from stock.',
        { thingId: id },
      );
    }
  }
}

/**
 * Moves the stock by what `after` takes beyond `before` (both the record's lines, read from the
 * database around the write): each consumable whose use changed is locked, checked and set, and
 * audited `thing.stock_use` on it. Consumables are handled in id order, so two writes never lock
 * them in opposite orders.
 */
export async function moveStock(
  ctx: StockCtx,
  record: StockRecord,
  before: readonly StockLine[],
  after: readonly StockLine[],
): Promise<void> {
  const was = stockUse(before);
  const now = stockUse(after);
  const ids = [...new Set([...was.keys(), ...now.keys()])].sort();
  for (const id of ids) {
    const delta = (now.get(id) ?? 0n) - (was.get(id) ?? 0n);
    if (delta === 0n) continue;
    const { rows } = await ctx.client.query<{
      id: string;
      name: string | null;
      quantity: string;
      trashed: boolean;
    }>(
      `SELECT t.id, t.name, trim_scale(t.quantity)::text AS quantity,
              t.deleted_at IS NOT NULL AS trashed
         FROM public.things t WHERE t.id = $1 FOR UPDATE`,
      [id],
    );
    const thing = rows[0];
    if (!thing) {
      // Gone (purged) or out of sight: nothing to give back to; taking from it is a 404.
      if (delta < 0n) continue;
      throw notFound("Check the line's stock: no such consumable in this location.");
    }
    const have = milli(thing.quantity);
    if (delta > 0n && thing.trashed) {
      throw conflict(`${thing.name ?? 'This thing'} is in the trash. Restore it first.`);
    }
    const left = have - delta;
    if (left < 0n) throw notEnough(thing, have);
    if (left > QUANTITY_MAX_MILLI) throw invalid('The quantity is at most 999999999.');
    await ctx.client.query('UPDATE public.things SET quantity = $2 WHERE id = $1', [
      id,
      decimal(left),
    ]);
    await audited(ctx.tx, {
      locationId: record.locationId,
      actor: actorOf(ctx.scope),
      action: 'thing.stock_use',
      entity: { type: 'thing', id },
      before: { quantity: thing.quantity },
      after: {
        quantity: decimal(left),
        // What the change was for: the history links the row to the service (D236).
        service_record_id: record.id,
        ...(record.thingId
          ? { service_thing_id: record.thingId }
          : { service_place_id: record.placeId }),
      },
      subjects: [id],
      rootThingId: id,
      requestId: ctx.requestId,
    });
  }
}
