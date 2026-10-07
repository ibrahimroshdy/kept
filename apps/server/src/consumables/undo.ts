import {
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { AppError } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { ruleRecord } from './service.js';

// Undo for "keep at least" (step-7 plan T17; D150). `thing.stock_rule` holds the minimum before
// and after (`min_quantity`; null when there was no rule, or none after a delete). Undoing puts the
// minimum back as it was before: the rule goes when there was none, comes back when it was
// removed, or takes its old minimum. Refused when the minimum changed since (D124), and where
// Consumables is now off (409 `module_off`, as the write would be). An adjust is a `thing.update`
// and is undone by the thing's own handler (things/undo.ts).

async function undoStockRule(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const thingId = event.entityId;
  const change = event.diff.min_quantity;
  if (event.entityType !== 'thing' || !thingId || !change || !('after' in change)) {
    throw notUndoable();
  }
  if (!(await gateFor(args.tx, event.locationId, args.scope)).modules.has('consumables')) {
    throw new AppError('module_off', 409);
  }
  const rule = await ruleRecord(client, thingId, true);
  const now = rule ? Number(rule.min_quantity) : null;
  const after = change.after === null || change.after === undefined ? null : Number(change.after);
  if (now !== after) {
    throw undoConflict(
      ['min_quantity'],
      await lastChangedBy(client, event.locationId, { type: 'thing', id: thingId }, event.at),
    );
  }
  const before =
    change.before === null || change.before === undefined ? null : Number(change.before);
  if (before === null && rule) {
    await client.query('DELETE FROM public.stock_rules WHERE id = $1', [rule.id]);
  } else if (before !== null && rule) {
    await client.query('UPDATE public.stock_rules SET min_quantity = $2 WHERE id = $1', [
      rule.id,
      before,
    ]);
  } else if (before !== null) {
    await client.query(
      `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
       VALUES ($1, $2, $3, kept.current_user_id())`,
      [thingId, event.locationId, before],
    );
  }
  await args.audit({
    action: 'thing.stock_rule',
    entity: { type: 'thing', id: thingId },
    before: { min_quantity: now },
    after: { min_quantity: before },
    rootThingId: thingId,
    subjects: [thingId],
  });
}

let registered = false;

/** Registers the stock rule's undo handler (idempotent; consumables/routes.ts). */
export function registerConsumablesUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('thing.stock_rule', undoStockRule);
}
