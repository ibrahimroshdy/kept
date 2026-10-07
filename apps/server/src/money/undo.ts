import {
  type AccountUndoArgs,
  changedSince,
  lastChangedBy,
  notUndoable,
  registerAccountUndo,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { docImagesOf, restoreDocuments } from './documents.js';
import { type RateImage, type RateKey, rateAt, rateOut, removeRate, writeRate } from './fx.js';
import { moneyOff } from './input.js';
import { type ValuationRow, valuationImage } from './valuations.js';

// Undo of money's changes (step-4 plan T8, Q25; D124, D150), registered by routes.ts:
// - `valuation.update`: each field the event changed goes back, if it still holds the event's
//   `after` (else 409 `changed_since`, naming who changed it);
// - `valuation.delete`: the row comes back with its id, its thing still here and live, and its
//   documents back on it (documents.ts restoreDocuments());
// - `fx_rate.set`, `fx_rate.delete` (account-level): the rate at the key goes back to what it
//   was (none, or the old rate), if it is still what the event left.
// Money is written back only by someone who sees it there (409 `module_off`, as for an edit).

const VALUATION_FIELDS = ['value', 'currency', 'valued_on', 'source', 'notes'] as const;

async function valuationNow(args: UndoArgs, id: string): Promise<ValuationRow | null> {
  const { rows } = await args.client.query<ValuationRow>(
    `SELECT v.id, v.location_id, v.thing_id, v.value::text AS value, v.currency::text AS currency,
            v.valued_on::text AS valued_on, v.source, v.notes, v.row_version, v.created_by,
            NULL AS display_name
       FROM public.valuations v WHERE v.id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function requireMoney(args: UndoArgs): Promise<void> {
  if (!(await gateFor(args.tx, args.event.locationId, args.scope)).showMoney) throw moneyOff();
}

async function undoValuationUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'valuation' || !id) throw notUndoable();
  const row = await valuationNow(args, id);
  if (!row || row.location_id !== event.locationId) {
    throw conflict("Can't undo: that valuation no longer exists.");
  }
  const fields = Object.keys(event.diff);
  if (fields.some((f) => !(VALUATION_FIELDS as readonly string[]).includes(f))) {
    throw notUndoable();
  }
  const current = valuationImage(row);
  const conflicts = changedSince(event.diff, current);
  if (conflicts.length > 0) {
    const who = await lastChangedBy(client, event.locationId, { type: 'valuation', id }, event.at);
    throw undoConflict(conflicts, who);
  }
  await requireMoney(args);
  await client.query(
    `UPDATE public.valuations SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}
      WHERE id = $1`,
    [id, ...fields.map((f) => event.diff[f]?.before ?? null)],
  );
  const after = (await valuationNow(args, id)) as ValuationRow;
  await args.audit({
    action: 'valuation.update',
    entity: { type: 'valuation', id },
    before: current,
    after: valuationImage(after),
    rootThingId: row.thing_id,
    subjects: [row.thing_id],
  });
}

async function undoValuationDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'valuation' || !id) throw notUndoable();
  const was = (f: string) => event.diff[f]?.before ?? null;
  const thingId = was('thing_id');
  if (typeof thingId !== 'string') throw notUndoable();
  const { rowCount: exists } = await client.query('SELECT 1 FROM public.valuations WHERE id = $1', [
    id,
  ]);
  if (exists) throw conflict("Can't undo: that valuation is back already.");
  const { rowCount: live } = await client.query(
    `SELECT 1 FROM public.things WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL
      FOR SHARE`,
    [thingId, event.locationId],
  );
  if (!live) throw conflict("Can't undo: the thing isn't here any more.");
  await requireMoney(args);
  await client.query(
    `INSERT INTO public.valuations (id, location_id, thing_id, value, currency, valued_on, source,
                                    notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, kept.current_user_id())`,
    [
      id,
      event.locationId,
      thingId,
      was('value'),
      was('currency'),
      was('valued_on'),
      was('source'),
      was('notes'),
    ],
  );
  const docs = await restoreDocuments(
    client,
    event.locationId,
    'valuation_id',
    id,
    docImagesOf(was('documents')),
  );
  const row = (await valuationNow(args, id)) as ValuationRow;
  const image = docImagesOf(was('documents')).filter((d) => docs.includes(d.id));
  await args.audit({
    action: 'valuation.delete',
    entity: { type: 'valuation', id },
    before: null,
    after: { ...valuationImage(row), documents: image },
    rootThingId: thingId,
    subjects: [thingId],
  });
}

// ---------------------------------------------------------------------------------------------
// Exchange rates (account-level)
// ---------------------------------------------------------------------------------------------

function rateImageOf(value: unknown): RateImage | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<RateImage>;
  if (
    typeof v.from_ccy !== 'string' ||
    typeof v.to_ccy !== 'string' ||
    typeof v.valid_from !== 'string' ||
    typeof v.rate !== 'string'
  ) {
    return null;
  }
  return v as RateImage;
}

/** Puts the rate at the event's key back to `target` (null: none), if it is still `expected`. */
async function restoreRate(
  args: AccountUndoArgs,
  expected: RateImage | null,
  target: RateImage | null,
): Promise<void> {
  const image = expected ?? target;
  if (!image) throw notUndoable();
  const key: RateKey = {
    accountId: args.event.ownerAccountId,
    from: image.from_ccy,
    to: image.to_ccy,
    validFrom: image.valid_from,
  };
  const now = await rateAt(args.client, key, true);
  const nowRate = now ? rateOut(now.rate) : null;
  if (nowRate !== (expected?.rate ?? null)) throw undoConflict(['rate'], now?.display_name);
  if (target) await writeRate(args.client, key, target.rate, now);
  else await removeRate(args.client, key);
  await args.audit({
    action: args.event.action,
    entity: { type: 'fx_rate' },
    before: { fx_rate: expected },
    after: { fx_rate: target },
  });
}

async function undoRateSet(args: AccountUndoArgs): Promise<void> {
  const change = args.event.diff.fx_rate;
  if (!change) throw notUndoable();
  const after = rateImageOf(change.after);
  if (!after) throw notUndoable();
  await restoreRate(args, after, rateImageOf(change.before));
}

async function undoRateDelete(args: AccountUndoArgs): Promise<void> {
  const before = rateImageOf(args.event.diff.fx_rate?.before);
  if (!before) throw notUndoable();
  await restoreRate(args, null, before);
}

let registered = false;

/** Registers money's undo handlers (idempotent; routes.ts). */
export function registerMoneyUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('valuation.update', undoValuationUpdate);
  registerUndo('valuation.delete', undoValuationDelete);
  registerAccountUndo('fx_rate.set', undoRateSet);
  registerAccountUndo('fx_rate.delete', undoRateDelete);
}
