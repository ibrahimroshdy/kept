import { newId } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { undoFields } from '../things/undo.js';

// In-app undo's step-3 handlers (T20; D150, D124; plan Q23), registered with audit/undo.ts.
//
// What step 3 undoes, and where each handler lives:
// - thing.update, thing.retype, thing.lifecycle, thing.move, thing.trash: things/undo.ts;
// - place.update, place.move, place.trash: places/undo.ts;
// - thing.capture, capture.batch_undo: capture/batch-undo.ts (T13);
// - inbox.bulk: inbox/bulk.ts (T15);
// - box.check: boxcheck/service.ts (T17);
// - thing.extract, purchase.extract: here (the AI's applied fields, T10's apply.ts);
// - thing.create, place.create, reading.create: here, for step 6's tools (T9, D58, D124), which
//   write their creates undoable; a create from the app's own screens is written without a
//   window and never reaches these.
// Secret-class diffs are never undoable (audited() writes them without a window, and the route
// refuses them), and registry events (account-level) never reach the route. There is no redo.

/** A thing's image column → its `field_status` key (extraction/apply.ts COLUMN, inverted). */
const STATUS_KEY: Readonly<Record<string, string>> = {
  name: 'name',
  brand_id: 'brand',
  model: 'model',
  colour: 'colour',
  type_id: 'type',
  aliases: 'aliases',
};

type FieldState = { state?: string; extraction_id?: string };

/**
 * `thing.extract` (T10): the event carries the thing's image diff, as `thing.update` does, so
 * the fields go back through undoFields() (the changed-since check, the money gate, the audit
 * row). Then the fields it reverted stop being "Filled in by AI": their `field_status` entry
 * goes, and the attempt's `applied` is cleared, so a later attempt doesn't revert them again.
 */
async function undoThingExtract(args: UndoArgs): Promise<void> {
  // Step 5 (T10): the default meter a type AI set brought is in the event beside the image; the
  // fields go back without it, then the meter goes while it has no readings.
  const { meter_created: made, ...diff } = args.event.diff;
  await undoFields({ ...args, event: { ...args.event, diff } });
  const meter = made?.after as { id?: unknown } | null | undefined;
  if (meter && typeof meter.id === 'string') await dropUnreadMeter(args, meter.id);
  const thingId = args.event.entityId as string;
  const keys = Object.keys(args.event.diff)
    .map((f) => STATUS_KEY[f])
    .filter((k): k is string => !!k);
  if (keys.length === 0) return;
  const { rows } = await args.client.query<{ field_status: Record<string, FieldState> | null }>(
    'SELECT field_status FROM public.things WHERE id = $1',
    [thingId],
  );
  const status = { ...(rows[0]?.field_status ?? {}) };
  const attempts = new Set<string>();
  let changed = false;
  for (const key of keys) {
    const st = status[key];
    if (st?.state !== 'extracted') continue;
    if (st.extraction_id) attempts.add(st.extraction_id);
    delete status[key];
    changed = true;
  }
  if (!changed) return;
  await args.client.query('UPDATE public.things SET field_status = $2 WHERE id = $1', [
    thingId,
    JSON.stringify(status),
  ]);
  if (attempts.size > 0) {
    await args.client.query(
      `UPDATE public.extractions SET applied = '{}'::jsonb
        WHERE id = ANY ($1::uuid[]) AND thing_id = $2`,
      [[...attempts], thingId],
    );
  }
}

/** A meter that has no readings, removed (its `meter.delete` audited on its own row). */
async function dropUnreadMeter(args: UndoArgs, meterId: string): Promise<void> {
  const { rows } = await args.client.query<{ thing_id: string; kind: string; unit: string }>(
    `DELETE FROM public.meters m WHERE m.id = $1
        AND NOT EXISTS (SELECT 1 FROM public.meter_readings r WHERE r.meter_id = m.id)
      RETURNING m.thing_id, m.kind, m.unit`,
    [meterId],
  );
  const gone = rows[0];
  if (!gone) return;
  await audited(args.tx, {
    locationId: args.event.locationId,
    actor: actorOf(args.scope),
    action: 'meter.delete',
    entity: { type: 'meter', id: meterId },
    before: { thing_id: gone.thing_id, kind: gone.kind, unit: gone.unit },
    after: null,
    rootThingId: gone.thing_id,
    requestId: args.requestId,
  });
}

type PurchaseImage = {
  purchased_on: string | null;
  currency: string | null;
  total: string | null;
  tax: string | null;
  review_state: string;
  line_ids: string[];
};

const PURCHASE_FIELDS = ['purchased_on', 'currency', 'total', 'tax'] as const;
const MONEY = new Set<string>(['total', 'tax']);

/**
 * `purchase.extract` (T10, a RECEIPT on a draft purchase): the date, currency, total and tax it
 * filled go back to what they were, and the lines it added are removed. Refused when the
 * purchase was confirmed since (`review_state`), when a field no longer holds what AI wrote, or
 * when a line it added is gone or a thing was linked to it since (`line_ids`). Total and tax are
 * money: undone only by someone who sees money there (409 `module_off`), as for an edit.
 */
async function undoPurchaseExtract(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'purchase' || !id) throw notUndoable();
  const { rows } = await client.query<Omit<PurchaseImage, 'line_ids'> & { location_id: string }>(
    `SELECT location_id, purchased_on::text AS purchased_on, currency, total::text AS total,
            tax::text AS tax, review_state
       FROM public.purchases WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row || row.location_id !== event.locationId) {
    throw conflict("Can't undo: that purchase no longer exists.");
  }
  const { location_id: _loc, ...p } = row;
  const diff = event.diff;
  for (const field of Object.keys(diff)) {
    if (field !== 'line_ids' && !(PURCHASE_FIELDS as readonly string[]).includes(field)) {
      throw notUndoable();
    }
  }
  const refuse = async (fields: string[]) => {
    const who = await lastChangedBy(client, event.locationId, { type: 'purchase', id }, event.at);
    throw undoConflict(fields, who);
  };
  if (p.review_state !== 'draft') await refuse(['review_state']);

  const added = Array.isArray(diff.line_ids?.after) ? (diff.line_ids.after as string[]) : [];
  const { rows: lines } = await client.query<{ id: string; linked: boolean }>(
    `SELECT pl.id, EXISTS (SELECT 1 FROM public.things t WHERE t.purchase_line_id = pl.id) AS linked
       FROM public.purchase_lines pl WHERE pl.id = ANY ($1::uuid[]) AND pl.purchase_id = $2`,
    [added, id],
  );
  const current: Record<string, unknown> = { ...p, line_ids: diff.line_ids?.after ?? [] };
  const conflicts = changedSince(
    Object.fromEntries(Object.entries(diff).filter(([f]) => f !== 'line_ids')),
    current,
  );
  if (lines.length !== added.length || lines.some((l) => l.linked)) conflicts.push('line_ids');
  if (conflicts.length > 0) await refuse(conflicts);

  const touchesMoney = Object.keys(diff).some((f) => MONEY.has(f)) || added.length > 0;
  if (touchesMoney && !(await gateFor(args.tx, event.locationId, args.scope)).showMoney) {
    throw new AppError('module_off', 409, 'Money is hidden for you in this location.');
  }

  const back = PURCHASE_FIELDS.filter((f) => f in diff);
  if (back.length > 0) {
    await client.query(
      `UPDATE public.purchases SET ${back.map((f, i) => `${f} = $${i + 2}`).join(', ')}
        WHERE id = $1`,
      [id, ...back.map((f) => diff[f]?.before ?? null)],
    );
  }
  if (added.length > 0) {
    await client.query(
      'DELETE FROM public.purchase_lines WHERE id = ANY ($1::uuid[]) AND purchase_id = $2',
      [added, id],
    );
  }
  await client.query(
    `UPDATE public.extractions SET applied = '{}'::jsonb
      WHERE purchase_id = $1 AND status <> 'superseded' AND applied <> '{}'::jsonb`,
    [id],
  );
  const { rows: now } = await client.query<Omit<PurchaseImage, 'line_ids'>>(
    `SELECT purchased_on::text AS purchased_on, currency, total::text AS total,
            tax::text AS tax, review_state
       FROM public.purchases WHERE id = $1`,
    [id],
  );
  await args.audit({
    action: 'purchase.extract',
    entity: { type: 'purchase', id },
    before: { ...p, line_ids: added },
    after: { ...(now[0] ?? {}), line_ids: [] },
  });
}

// ---------------------------------------------------------------------------------------------
// Creates by a tool (step 6, T9): undone by putting what they made in the trash (a reading, which
// has no trash, is removed), unless anything was written about it since or it holds something.
// ---------------------------------------------------------------------------------------------

/** 409 `changed_since` when any event about the entity came after `event`. */
async function refuseIfChanged(
  client: pg.ClientBase,
  args: UndoArgs,
  entity: { type: string; id: string },
): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.audit_events e
      WHERE e.location_id = $1 AND e.entity_type = $2 AND e.entity_id = $3 AND e.at > $4`,
    [args.event.locationId, entity.type, entity.id, args.event.at],
  );
  if ((rows[0]?.n ?? 0) > 0) {
    throw undoConflict(
      [entity.type],
      await lastChangedBy(client, args.event.locationId, entity, args.event.at),
    );
  }
}

/** `thing.create`: the thing goes to the trash. */
async function undoThingCreate(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const id = event.entityId;
  if (event.entityType !== 'thing' || !id) throw notUndoable();
  const { rows } = await client.query<{ deleted_at: Date | null; holds: boolean }>(
    `SELECT t.deleted_at,
            EXISTS (SELECT 1 FROM public.things c
                     WHERE c.container_id = t.id AND c.deleted_at IS NULL) AS holds
       FROM public.things t WHERE t.id = $1 FOR UPDATE OF t`,
    [id],
  );
  const now = rows[0];
  if (!now) throw notFound();
  if (now.deleted_at) throw undoConflict(['deleted_at']);
  if (now.holds) throw undoConflict(['contents']);
  await refuseIfChanged(client, args, { type: 'thing', id });
  const trashBatchId = newId();
  const { rows: stamped } = await client.query<{ deleted_at: Date }>(
    `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1
     RETURNING deleted_at`,
    [id, trashBatchId],
  );
  await args.audit({
    action: 'thing.trash',
    entity: { type: 'thing', id },
    before: { deleted_at: null, trash_batch_id: null },
    after: { deleted_at: stamped[0]?.deleted_at ?? new Date(), trash_batch_id: trashBatchId },
    rootThingId: id,
    subjects: [id],
  });
}

/** `place.create`: the place goes to the trash, if it is still empty. */
async function undoPlaceCreate(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const id = event.entityId;
  if (event.entityType !== 'place' || !id) throw notUndoable();
  const { rows } = await client.query<{ deleted_at: Date | null; holds: boolean }>(
    `SELECT p.deleted_at,
            (EXISTS (SELECT 1 FROM public.things t WHERE t.place_id = p.id AND t.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM public.places c
                         WHERE c.parent_id = p.id AND c.deleted_at IS NULL)) AS holds
       FROM public.places p WHERE p.id = $1 FOR UPDATE OF p`,
    [id],
  );
  const now = rows[0];
  if (!now) throw notFound();
  if (now.deleted_at) throw undoConflict(['deleted_at']);
  if (now.holds) throw undoConflict(['contents']);
  await refuseIfChanged(client, args, { type: 'place', id });
  const trashBatchId = newId();
  const { rows: stamped } = await client.query<{ deleted_at: Date }>(
    `UPDATE public.places SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1
     RETURNING deleted_at`,
    [id, trashBatchId],
  );
  await args.audit({
    action: 'place.trash',
    entity: { type: 'place', id },
    before: { deleted_at: null, trash_batch_id: null },
    after: { deleted_at: stamped[0]?.deleted_at ?? new Date(), trash_batch_id: trashBatchId },
  });
}

/** `reading.create`: the reading is removed (readings have no trash), unless it was edited,
 * kept from review or used by a fill or service since. */
async function undoReadingCreate(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const id = event.entityId;
  if (event.entityType !== 'meter_reading' || !id) throw notUndoable();
  const { rows } = await client.query<Record<string, unknown>>(
    'SELECT * FROM public.meter_readings WHERE id = $1 FOR UPDATE',
    [id],
  );
  const before = rows[0];
  if (!before) throw undoConflict(['meter_reading']);
  await refuseIfChanged(client, args, { type: 'meter_reading', id });
  await client.query('DELETE FROM public.meter_readings WHERE id = $1', [id]);
  const { meter_id, value, taken_at, state } = before;
  await args.audit({
    action: 'reading.delete',
    entity: { type: 'meter_reading', id },
    before: { meter_id, value, taken_at, state },
    after: null,
    ...(event.rootThingId ? { rootThingId: event.rootThingId } : {}),
  });
}

let registered = false;

/** Registers the step-3 handlers no area's routes register (idempotent; undo/routes.ts). */
export function registerStep3Undo(): void {
  if (registered) return;
  registered = true;
  registerUndo('thing.extract', undoThingExtract);
  registerUndo('purchase.extract', undoPurchaseExtract);
  registerUndo('thing.create', undoThingCreate);
  registerUndo('place.create', undoPlaceCreate);
  registerUndo('reading.create', undoReadingCreate);
}
