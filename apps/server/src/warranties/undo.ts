import type pg from 'pg';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { docImagesOf, restoreDocuments } from '../money/documents.js';
import { moneyOff } from '../money/input.js';
import { gateFor } from '../serialize/gates.js';
import { claimRow } from './claims.js';
import { warrantyRow } from './service.js';
import {
  CLAIM_FIELDS,
  CLAIM_MONEY_FIELDS,
  claimImage,
  type WarrantyRow,
  warrantyImage,
} from './view.js';

// Undo of warranties' and claims' changes (step-4 plan T9, Q18, Q25; D124, D150), registered by
// routes.ts:
// - `warranty.update`, `claim.update`, `claim.status`: each field the event changed goes back, if
//   it still holds the event's `after` (else 409 `changed_since`, naming who). A claim's status
//   goes back through the transition guard's undo path (`app.undo`, 0051), so a resolved claim
//   is in repair again, and the thing with it; a claim's money only by someone who sees money.
// - `warranty.delete`, `claim.delete`: the row comes back with its id (and a warranty's claims
//   point at it again, those still without one), its documents back on it (money/documents.ts),
//   while its thing is still here and live.

const WARRANTY_FIELDS = [
  'kind',
  'provider',
  'starts_on',
  'ends_on',
  'term_months',
  'lifetime',
  'lead_days',
  'claim_contact',
  'registered',
  'registration_deadline',
] as const;

async function refuseChanged(args: UndoArgs, type: string, current: Record<string, unknown>) {
  const conflicts = changedSince(args.event.diff, current);
  if (conflicts.length === 0) return;
  const { event, client } = args;
  const who = await lastChangedBy(
    client,
    event.locationId,
    { type, id: event.entityId as string },
    event.at,
  );
  throw undoConflict(conflicts, who);
}

async function requireMoney(args: UndoArgs): Promise<void> {
  if (!(await gateFor(args.tx, args.event.locationId, args.scope)).showMoney) throw moneyOff();
}

/** 409 unless the thing is live in the event's location (a moved or trashed thing's record is not
 * put back behind it). */
async function requireThingHere(args: UndoArgs, thingId: unknown): Promise<string> {
  if (typeof thingId !== 'string') throw notUndoable();
  const { rowCount } = await args.client.query(
    `SELECT 1 FROM public.things WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL
      FOR SHARE`,
    [thingId, args.event.locationId],
  );
  if (!rowCount) throw conflict("Can't undo: the thing isn't here any more.");
  return thingId;
}

async function writeBack(
  client: pg.ClientBase,
  table: 'warranties' | 'claims',
  id: string,
  fields: readonly string[],
  diff: UndoArgs['event']['diff'],
): Promise<void> {
  if (fields.length === 0) return;
  await client.query(
    `UPDATE public.${table} SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}
      WHERE id = $1`,
    [id, ...fields.map((f) => diff[f]?.before ?? null)],
  );
}

// ---------------------------------------------------------------------------------------------
// Warranties
// ---------------------------------------------------------------------------------------------

async function undoWarrantyUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'warranty' || !id) throw notUndoable();
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.warranties WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (rows[0]?.location_id !== event.locationId) {
    throw conflict("Can't undo: that warranty no longer exists.");
  }
  const fields = Object.keys(event.diff);
  if (fields.some((f) => !(WARRANTY_FIELDS as readonly string[]).includes(f))) throw notUndoable();
  const before = await warrantyRow(client, id);
  await refuseChanged(args, 'warranty', warrantyImage(before));
  await writeBack(client, 'warranties', id, fields, event.diff);
  const after = await warrantyRow(client, id);
  await args.audit({
    action: 'warranty.update',
    entity: { type: 'warranty', id },
    before: warrantyImage(before),
    after: warrantyImage(after),
    subjects: [before.thing_id],
    rootThingId: before.thing_id,
  });
}

async function undoWarrantyDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'warranty' || !id) throw notUndoable();
  const was = (f: string) => event.diff[f]?.before ?? null;
  const thingId = await requireThingHere(args, was('thing_id'));
  const { rowCount } = await client.query('SELECT 1 FROM public.warranties WHERE id = $1', [id]);
  if (rowCount) throw conflict("Can't undo: that warranty is back already.");
  await client.query(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, provider, starts_on, ends_on,
                                    term_months, lifetime, lead_days, claim_contact, registered,
                                    registration_deadline, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, kept.current_user_id())`,
    [
      id,
      event.locationId,
      thingId,
      ...WARRANTY_FIELDS.map(
        (f) => was(f) ?? (f === 'lifetime' || f === 'registered' ? false : null),
      ),
    ],
  );
  const claimIds = Array.isArray(was('claim_ids')) ? (was('claim_ids') as string[]) : [];
  const { rows: relinked } = await client.query<{ id: string }>(
    `UPDATE public.claims SET warranty_id = $1
      WHERE id = ANY ($2::uuid[]) AND thing_id = $3 AND warranty_id IS NULL
      RETURNING id`,
    [id, claimIds, thingId],
  );
  const docs = docImagesOf(was('documents'));
  const back = await restoreDocuments(client, event.locationId, 'warranty_id', id, docs);
  const row: WarrantyRow = await warrantyRow(client, id);
  await args.audit({
    action: 'warranty.delete',
    entity: { type: 'warranty', id },
    before: null,
    after: {
      ...warrantyImage(row),
      documents: docs.filter((d) => back.includes(d.id)),
      claim_ids: relinked.map((r) => r.id).sort(),
    },
    subjects: [thingId],
    rootThingId: thingId,
  });
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

async function undoClaimChange(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'claim' || !id) throw notUndoable();
  const { rows } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.claims WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (rows[0]?.location_id !== event.locationId) {
    throw conflict("Can't undo: that claim no longer exists.");
  }
  const fields = Object.keys(event.diff);
  if (fields.some((f) => !(CLAIM_FIELDS as readonly string[]).includes(f))) throw notUndoable();
  const before = await claimRow(client, id);
  await refuseChanged(args, 'claim', claimImage(before));
  if (fields.some((f) => CLAIM_MONEY_FIELDS.includes(f))) await requireMoney(args);
  // A status goes back past the transition guard only on this path (0051, Q18): for this
  // transaction's statement, then off again.
  const status = fields.includes('status');
  if (status) await client.query(`SELECT set_config('app.undo', 'on', true)`);
  await writeBack(client, 'claims', id, fields, event.diff);
  if (status) await client.query(`SELECT set_config('app.undo', 'off', true)`);
  const after = await claimRow(client, id);
  await args.audit({
    action: event.action,
    entity: { type: 'claim', id },
    before: claimImage(before),
    after: claimImage(after),
    subjects: [before.thing_id],
    rootThingId: before.thing_id,
  });
}

async function undoClaimDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'claim' || !id) throw notUndoable();
  const was = (f: string) => event.diff[f]?.before ?? null;
  const thingId = await requireThingHere(args, was('thing_id'));
  const { rowCount } = await client.query('SELECT 1 FROM public.claims WHERE id = $1', [id]);
  if (rowCount) throw conflict("Can't undo: that claim is back already.");
  if (was('cost') !== null || was('covered_amount') !== null) await requireMoney(args);
  // A warranty, incident or vendor gone since is left out (their keys and guard would refuse the
  // row).
  const keep = async (table: 'warranties' | 'incidents', ref: unknown) => {
    if (typeof ref !== 'string') return null;
    const { rowCount: n } = await client.query(
      `SELECT 1 FROM public.${table} WHERE id = $1 AND location_id = $2`,
      [ref, event.locationId],
    );
    return n ? ref : null;
  };
  const vendorId = was('vendor_id');
  const { rowCount: vendorLive } =
    typeof vendorId === 'string'
      ? await client.query(
          `SELECT 1 FROM public.vendors v JOIN public.locations l
               ON l.owner_account_id = v.owner_account_id
            WHERE v.id = $1 AND l.id = $2`,
          [vendorId, event.locationId],
        )
      : { rowCount: 0 };
  await client.query(
    `INSERT INTO public.claims (id, location_id, thing_id, warranty_id, incident_id, opened_on,
                                reference, vendor_id, status, cost, currency, covered_amount,
                                notes, closed_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, kept.current_user_id())`,
    [
      id,
      event.locationId,
      thingId,
      await keep('warranties', was('warranty_id')),
      await keep('incidents', was('incident_id')),
      was('opened_on'),
      was('reference'),
      vendorLive ? vendorId : null,
      was('status'),
      was('cost'),
      was('currency'),
      was('covered_amount'),
      was('notes'),
      was('closed_on'),
    ],
  );
  const docs = docImagesOf(was('documents'));
  const back = await restoreDocuments(client, event.locationId, 'claim_id', id, docs);
  const row = await claimRow(client, id);
  await args.audit({
    action: 'claim.delete',
    entity: { type: 'claim', id },
    before: null,
    after: { ...claimImage(row), documents: docs.filter((d) => back.includes(d.id)) },
    subjects: [thingId],
    rootThingId: thingId,
  });
}

let registered = false;

/** Registers the warranties' and claims' undo handlers (idempotent; routes.ts). */
export function registerWarrantyUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('warranty.update', undoWarrantyUpdate);
  registerUndo('warranty.delete', undoWarrantyDelete);
  registerUndo('claim.update', undoClaimChange);
  registerUndo('claim.status', undoClaimChange);
  registerUndo('claim.delete', undoClaimDelete);
}
