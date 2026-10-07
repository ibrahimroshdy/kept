import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { placeThing, thingState } from './return.js';
import { loanRecord } from './service.js';
import { type LoanRecord, loanImage } from './view.js';

// Undo for loans (plan T10; D150, D124; Q25). Each handler checks that what the event changed is
// still as the event left it (else 409 `undo_refused` `changed_since`, naming who), puts the
// before-image back, and writes its own audit row.
//
// - loan.update: the due date, notes and person go back.
// - loan.delete: the loan comes back with its id and its condition photos (a file already purged,
//   a day after it lost its last attachment, stays gone). Written by the person undoing (the
//   insert policy, 0051): they made the change, or they are an owner or admin there.
// - loan.return: the loan reopens, the thing goes back where it was when it was returned (and, a
//   borrowed one, back in use); a part that merged back is taken out of the row it joined again.

type Diff = UndoArgs['event']['diff'];
const beforeOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.before ?? null]));
const afterOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.after ?? null]));

async function refuse(args: UndoArgs, id: string, fields: string[]): Promise<never> {
  const who = await lastChangedBy(
    args.client,
    args.event.locationId,
    { type: 'loan', id },
    args.event.at,
  );
  throw undoConflict(fields, who);
}

async function lockedLoan(args: UndoArgs, id: string): Promise<LoanRecord> {
  try {
    const row = await loanRecord(args.client, id, true);
    if (row.location_id !== args.event.locationId) throw conflict();
    return row;
  } catch {
    throw conflict("Can't undo: that loan no longer exists.");
  }
}

/** The loan's current image, as the event stored it (JSON: times as ISO strings). */
const imageOf = (row: LoanRecord): Record<string, unknown> =>
  JSON.parse(JSON.stringify(loanImage(row))) as Record<string, unknown>;

/** loan.update: the due date, notes and person go back. */
async function undoLoanUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'loan' || !id) throw notUndoable();
  const fields = Object.keys(event.diff);
  if (fields.some((f) => !['due_on', 'notes', 'person_id'].includes(f))) throw notUndoable();
  const row = await lockedLoan(args, id);
  const conflicts = changedSince(event.diff, imageOf(row));
  if (conflicts.length > 0) await refuse(args, id, conflicts);
  const back = beforeOf(event.diff);
  await client.query(
    `UPDATE public.loans SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...fields.map((f) => back[f])],
  );
  await args.audit({
    action: 'loan.update',
    entity: { type: 'loan', id },
    before: loanImage(row),
    after: loanImage(await loanRecord(client, id)),
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
  });
}

type Photo = { id: string; file_id: string | null; url: string | null; role: string; sort: number };

/** loan.delete: the loan comes back with its id and photos. */
async function undoLoanDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'loan' || !id) throw notUndoable();
  const b = beforeOf(event.diff);
  const { rowCount: exists } = await client.query('SELECT 1 FROM public.loans WHERE id = $1', [id]);
  if (exists) throw conflict("Can't undo: that loan is back already.");
  const { rowCount: thing } = await client.query('SELECT 1 FROM public.things WHERE id = $1', [
    b.thing_id,
  ]);
  if (!thing) throw conflict("Can't undo: what was lent is gone.");
  await client.query(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               returned_at, return_place_id, previous_place_id,
                               previous_container_id, split_from_thing_id, lead_days, notes,
                               created_by, return_container_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT id FROM public.places WHERE id = $9),
             $10, $11, (SELECT id FROM public.things WHERE id = $12), $13, $14,
             kept.current_user_id(), (SELECT id FROM public.things WHERE id = $15))`,
    [
      id,
      event.locationId,
      b.thing_id,
      b.direction,
      b.person_id,
      b.started_at,
      b.due_on,
      b.returned_at,
      b.return_place_id,
      b.previous_place_id,
      b.previous_container_id,
      b.split_from_thing_id,
      b.lead_days ?? 0,
      b.notes,
      b.return_container_id ?? null,
    ],
  );
  for (const a of (b.attachments as Photo[] | null) ?? []) {
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, url, loan_id, role, sort,
                                       created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7, kept.current_user_id()
        WHERE $3::uuid IS NULL OR EXISTS (SELECT 1 FROM public.files f WHERE f.id = $3)
           OR kept.undo_holds_file($1, $3)
       ON CONFLICT DO NOTHING`,
      [a.id, event.locationId, a.file_id, a.url, id, a.role, a.sort],
    );
  }
  const row = await loanRecord(client, id);
  await args.audit({
    action: 'loan.delete',
    entity: { type: 'loan', id },
    before: null,
    after: loanImage(row),
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
  });
}

/** loan.return: the loan reopens; the thing goes back as it was; a merge is taken apart. */
async function undoLoanReturn(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'loan' || !id) throw notUndoable();
  const row = await lockedLoan(args, id);
  const a = afterOf(event.diff);
  const thing = await thingState(client, row.thing_id);
  if (!thing) throw conflict("Can't undo: what was lent is gone.");
  const current: Record<string, unknown> = {
    ...imageOf(row),
    thing_place_id: thing.place_id,
    thing_container_id: thing.container_id,
    thing_lifecycle: thing.lifecycle,
    thing_ended_on: thing.ended_on,
    thing_deleted_at: thing.deleted_at ? thing.deleted_at.toISOString() : null,
  };
  const into = typeof a.merged_into === 'string' ? await thingState(client, a.merged_into) : null;
  if (into) current.merged_into_quantity = into.quantity;
  if (typeof a.merged_into === 'string') current.merged_into = a.merged_into;
  if (typeof a.merged_batch === 'string') current.merged_batch = thing.trash_batch_id;
  const conflicts = changedSince(event.diff, current);
  if (typeof a.merged_into === 'string' && !into) conflicts.push('merged_into');
  if (conflicts.length > 0) await refuse(args, id, conflicts);
  // The diff holds only what the return changed; the rest is as it is now.
  const b = { ...current, ...beforeOf(event.diff) };

  if (into && typeof b.merged_into_quantity === 'string') {
    // Take the part back out of the row it joined, and out of the trash.
    await client.query('UPDATE public.things SET quantity = $2::numeric WHERE id = $1', [
      into.id,
      b.merged_into_quantity,
    ]);
    await client.query(
      `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL, merged_into_id = NULL
        WHERE id = $1`,
      [row.thing_id],
    );
  }
  if (b.thing_lifecycle !== thing.lifecycle) {
    await client.query('UPDATE public.things SET lifecycle = $2, ended_on = $3 WHERE id = $1', [
      row.thing_id,
      b.thing_lifecycle,
      b.thing_ended_on,
    ]);
  }
  if (b.thing_place_id !== thing.place_id || b.thing_container_id !== thing.container_id) {
    await placeThing(client, row.thing_id, {
      placeId: (b.thing_place_id as string | null) ?? null,
      containerId: (b.thing_container_id as string | null) ?? null,
    });
  }
  await client.query(
    `UPDATE public.loans SET returned_at = NULL, return_place_id = NULL, return_container_id = NULL,
                             notes = $2
      WHERE id = $1`,
    [id, 'notes' in event.diff ? b.notes : row.notes],
  );
  await args.audit({
    action: 'loan.return',
    entity: { type: 'loan', id },
    before: loanImage(row),
    after: loanImage(await loanRecord(client, id)),
    subjects: into ? [row.thing_id, into.id] : [row.thing_id],
    rootThingId: row.thing_id,
  });
}

let registered = false;

/** Registers the handlers (idempotent; lending/routes.ts). */
export function registerLendingUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('loan.update', undoLoanUpdate);
  registerUndo('loan.delete', undoLoanDelete);
  registerUndo('loan.return', undoLoanReturn);
}
