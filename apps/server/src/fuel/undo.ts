import type pg from 'pg';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
  undoRefused,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { placementOf } from '../meters/service.js';
import { gateFor } from '../serialize/gates.js';
import { moneyOff } from '../things/validate.js';
import {
  entryRecord,
  FUEL_ENTITY,
  type FuelImage,
  type HeldAttachment,
  type HeldReading,
  imageOf,
} from './service.js';

// Undo for fills (step-5 plan T11; D124, D150; Q11, Q14). Each handler checks that what the
// event changed is still as the event left it (else 409 `undo_refused` `changed_since`, naming
// who), puts the before-image back, and writes its own audit row.
//
// - fuel.create: the fill goes, with the reading it made.
// - fuel.update: the fields go back; a reading the edit made goes, and the fill's own reading
//   gets its value and time back.
// - fuel.delete: the reading comes back first, with its id and proof photos, refused when it no
//   longer fits the series (a reading logged since runs past it, D112); then the fill, with its
//   id and receipt (a file already purged, a day after it lost its last attachment, stays gone).
// A re-inserted fill is written as its logger (0065's kept.undo_keep_creator()).

type Diff = UndoArgs['event']['diff'];
const beforeOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.before ?? null]));
const afterOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.after ?? null]));

/** The image fields an undo compares (what the event left); the rest are the event's notes. */
const COMPARED = new Set<string>([
  'thing_id',
  'taken_at',
  'amount',
  'unit',
  'cost',
  'currency',
  'is_full',
  'missed_before',
  'vendor_id',
  'meter_reading_id',
  'reading_value',
  'note',
] satisfies (keyof FuelImage)[]);
const compared = (diff: Diff): Diff =>
  Object.fromEntries(Object.entries(diff).filter(([f]) => COMPARED.has(f)));

async function refuse(args: UndoArgs, id: string, fields: string[]): Promise<never> {
  const who = await lastChangedBy(
    args.client,
    args.event.locationId,
    { type: FUEL_ENTITY, id },
    args.event.at,
  );
  throw undoConflict(fields, who);
}

/** 409 `module_off` when the undo writes money the caller can't see. */
async function requireMoney(args: UndoArgs, diff: Diff): Promise<void> {
  const touches = Object.values(diff).some((c) => c.class === 'money');
  if (touches && !(await gateFor(args.tx, args.event.locationId, args.scope)).showMoney) {
    throw moneyOff();
  }
}

async function lockedEntry(args: UndoArgs, id: string) {
  try {
    const row = await entryRecord(args.client, id, true);
    if (row.location_id !== args.event.locationId) throw conflict();
    return row;
  } catch {
    throw conflict("Can't undo: that fill no longer exists.");
  }
}

/** Deletes a reading the undone write made, unless a service has come to own it since. */
async function dropReading(client: pg.ClientBase, readingId: unknown): Promise<void> {
  if (typeof readingId !== 'string') return;
  await client.query(
    `DELETE FROM public.meter_readings d WHERE d.id = $1
        AND NOT EXISTS (SELECT 1 FROM public.service_records r WHERE r.meter_reading_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM public.fuel_entries f WHERE f.meter_reading_id = d.id)`,
    [readingId],
  );
}

/** fuel.create: the fill and the reading it made go. */
async function undoCreate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== FUEL_ENTITY || !id) throw notUndoable();
  const row = await lockedEntry(args, id);
  const image = imageOf(row) as Record<string, unknown>;
  const conflicts = changedSince(compared(event.diff), image);
  if (conflicts.length > 0) await refuse(args, id, conflicts);
  const after = afterOf(event.diff);
  await client.query('DELETE FROM public.fuel_entries WHERE id = $1', [id]);
  if (after.reading_created === true) await dropReading(client, after.meter_reading_id);
  await args.audit({
    action: event.action,
    entity: { type: FUEL_ENTITY, id },
    before: image,
    after: null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
  });
}

/** fuel.update: the changed fields go back, and the fill's reading with them. */
async function undoUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== FUEL_ENTITY || !id) throw notUndoable();
  await requireMoney(args, event.diff);
  const row = await lockedEntry(args, id);
  const image = imageOf(row) as Record<string, unknown>;
  const diff = compared(event.diff);
  const conflicts = changedSince(diff, image);
  if (conflicts.length > 0) await refuse(args, id, conflicts);
  const back = { ...image, ...beforeOf(diff) } as FuelImage;
  const after = afterOf(event.diff);
  await client.query(
    `UPDATE public.fuel_entries
        SET taken_at = $2, amount = $3, unit = $4, currency = $5, cost = $6, is_full = $7,
            missed_before = $8, vendor_id = $9, meter_reading_id = $10, note = $11
      WHERE id = $1`,
    [
      id,
      back.taken_at,
      back.amount,
      back.unit,
      back.currency,
      back.cost,
      back.is_full,
      back.missed_before,
      back.vendor_id,
      back.meter_reading_id,
      back.note,
    ],
  );
  if (after.reading_created === true) {
    await dropReading(client, after.meter_reading_id);
  } else if (back.meter_reading_id && ('reading_value' in diff || 'taken_at' in diff)) {
    // Its own reading, as it was: the edit placed it, and the undo puts it back.
    await client.query(
      `UPDATE public.meter_readings
          SET value = coalesce($2::numeric, value), taken_at = $3
        WHERE id = $1`,
      [back.meter_reading_id, back.reading_value, back.taken_at],
    );
  }
  const now = imageOf(await entryRecord(client, id));
  await args.audit({
    action: 'fuel.update',
    entity: { type: FUEL_ENTITY, id },
    before: image,
    after: now,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
  });
}

async function restoreAttachments(
  client: pg.ClientBase,
  locationId: string,
  column: 'fuel_entry_id' | 'meter_reading_id',
  subject: string,
  held: readonly HeldAttachment[],
): Promise<void> {
  for (const a of held) {
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, url, ${column}, role, sort,
                                       created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7, kept.current_user_id()
        WHERE $3::uuid IS NULL OR EXISTS (SELECT 1 FROM public.files f WHERE f.id = $3)
       ON CONFLICT DO NOTHING`,
      [a.id, locationId, a.file_id, a.url, subject, a.role, a.sort],
    );
  }
}

/** fuel.delete: the reading, then the fill, back with their ids and files. */
async function undoDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== FUEL_ENTITY || !id) throw notUndoable();
  await requireMoney(args, event.diff);
  const b = beforeOf(event.diff) as unknown as FuelImage & {
    attachments?: HeldAttachment[] | null;
    reading?: HeldReading | null;
  };
  const { rowCount: exists } = await client.query(
    'SELECT 1 FROM public.fuel_entries WHERE id = $1',
    [id],
  );
  if (exists) throw conflict("Can't undo: that fill is back already.");
  const { rowCount: thing } = await client.query(
    'SELECT 1 FROM public.things WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
    [b.thing_id, event.locationId],
  );
  if (!thing) throw conflict("Can't undo: the vehicle is gone.");

  let readingId: string | null = null;
  const r = b.reading;
  if (r) {
    const { rowCount: taken } = await client.query(
      'SELECT 1 FROM public.meter_readings WHERE id = $1',
      [r.id],
    );
    if (taken) throw conflict("Can't undo: that reading is back already.");
    // Placed again against the series as it is now (D112): refused when it runs backwards.
    const placed = await placementOf(client, r.meter_id, r.value, new Date(r.taken_at));
    if (!placed) throw conflict("Can't undo: the vehicle's meter is gone.");
    const reason = placed.placement.reason;
    if (reason === 'lower_than_previous' || reason === 'higher_than_next') {
      throw undoRefused(
        'changed_since',
        "Can't undo: its reading no longer fits the vehicle's readings.",
        { field: 'reading', conflicts: ['reading'], readingReason: reason },
      );
    }
    await client.query(
      `INSERT INTO public.meter_readings
         (id, location_id, meter_id, value, taken_at, source, state, review_reason, note)
       VALUES ($1, $2, $3, $4, $5, 'fuel', $6, $7, $8)`,
      [
        r.id,
        event.locationId,
        r.meter_id,
        r.value,
        r.taken_at,
        reason ? 'needs_review' : r.state,
        reason ?? (r.state === 'needs_review' ? r.review_reason : null),
        r.note,
      ],
    );
    await restoreAttachments(client, event.locationId, 'meter_reading_id', r.id, r.proofs ?? []);
    readingId = r.id;
  }
  await client.query(
    `INSERT INTO public.fuel_entries (id, location_id, thing_id, taken_at, amount, unit, currency,
                                      cost, is_full, missed_before, vendor_id, meter_reading_id,
                                      note, logged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             (SELECT v.id FROM public.vendors v WHERE v.id = $11), $12, $13,
             kept.current_user_id())`,
    [
      id,
      event.locationId,
      b.thing_id,
      b.taken_at,
      b.amount,
      b.unit,
      b.currency,
      b.cost,
      b.is_full,
      b.missed_before,
      b.vendor_id,
      readingId,
      b.note,
    ],
  );
  await restoreAttachments(client, event.locationId, 'fuel_entry_id', id, b.attachments ?? []);
  const now = imageOf(await entryRecord(client, id));
  await args.audit({
    action: 'fuel.delete',
    entity: { type: FUEL_ENTITY, id },
    before: null,
    after: now,
    subjects: [b.thing_id],
    rootThingId: b.thing_id,
  });
}

let registered = false;

/** Registers the handlers (idempotent; fuel/routes.ts). */
export function registerFuelUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('fuel.create', undoCreate);
  registerUndo('fuel.update', undoUpdate);
  registerUndo('fuel.delete', undoDelete);
}
