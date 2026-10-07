import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict, pgErrorOf } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import { moneyOff } from '../things/validate.js';
import type { HeldAttachment } from './documents.js';
import { imageOf } from './documents.js';
import { readDocumentRow } from './view.js';

// The undo handlers of expiring documents (plan T12, Q25; D124, D150, D172), registered with
// audit/undo.ts:
// - `document.update`: each field still holds what the edit wrote (else 409 changed_since), then
//   goes back.
// - `document.delete`: the row comes back with the same id, the terms it had renewed point at it
//   again, and its files are re-linked. The undo transaction names its event (`app.undo`, 0056),
//   so the row and its attachments come back with who made them, and a file the event held links
//   again even when the person undoing can't see it (kept.undo_holds_file); a file purged since
//   is left out.
// - `document.renew`: the new term goes, while nothing was changed on it or added to it since
//   (its files, a renewal of its own), and the old one is current again.
// Step 5 (T12): an edit's and a delete's issue date and cost come back too; a cost is money, so
// its undo needs the money gate.

const ENTITY = 'expiring_document';

async function refuse(args: UndoArgs, id: string, fields: string[]): Promise<never> {
  const who = await lastChangedBy(
    args.client,
    args.event.locationId,
    { type: ENTITY, id },
    args.event.at,
  );
  throw undoConflict(fields, who);
}

/** Step 5 (T12): putting a cost back is a money write (409 `module_off` where it's hidden). */
async function requireMoney(args: UndoArgs): Promise<void> {
  const touches = Object.values(args.event.diff).some((c) => c.class === 'money');
  if (touches && !(await gateFor(args.tx, args.event.locationId, args.scope)).showMoney) {
    throw moneyOff();
  }
}

async function current(args: UndoArgs, id: string) {
  try {
    return await readDocumentRow(args.client, id);
  } catch {
    throw conflict("Can't undo: that document no longer exists.");
  }
}

async function undoUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== ENTITY || !id) throw notUndoable();
  await requireMoney(args);
  await current(args, id);
  await client.query('SELECT 1 FROM public.expiring_documents WHERE id = $1 FOR UPDATE', [id]);
  const now = await current(args, id);
  const conflicts = changedSince(event.diff, imageOf(now));
  if (conflicts.length > 0) await refuse(args, id, conflicts);
  const back = { ...imageOf(now) } as Record<string, unknown>;
  for (const [field, change] of Object.entries(event.diff)) {
    if (!(field in back) || !('before' in change)) throw notUndoable();
    back[field] = change.before ?? null;
  }
  await client.query(
    `UPDATE public.expiring_documents
        SET kind = $2, title = $3, expires_on = $4, lead_days = $5, issued_on = $6, cost = $7,
            currency = $8
      WHERE id = $1`,
    [
      id,
      back.kind,
      back.title,
      back.expires_on,
      back.lead_days,
      back.issued_on,
      back.cost,
      back.currency,
    ],
  );
  const after = await current(args, id);
  await args.audit({
    action: event.action,
    entity: { type: ENTITY, id },
    before: imageOf(now),
    after: imageOf(after),
    subjects: after.thing_id ? [after.thing_id] : [],
    rootThingId: after.thing_id,
  });
}

type DeletedImage = {
  thing_id: string | null;
  place_id: string | null;
  kind: string;
  title: string | null;
  expires_on: string;
  lead_days: number;
  superseded_by_id: string | null;
  attachments: HeldAttachment[];
  renewed_from: string[];
  issued_on?: string | null;
  cost?: string | null;
  currency?: string | null;
};

async function undoDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== ENTITY || !id) throw notUndoable();
  const img = Object.fromEntries(
    Object.entries(event.diff).map(([k, c]) => [k, c.before ?? null]),
  ) as DeletedImage;
  if (!img.kind || !img.expires_on) throw notUndoable();
  await requireMoney(args);
  const { rowCount } = await client.query('SELECT 1 FROM public.expiring_documents WHERE id = $1', [
    id,
  ]);
  if (rowCount) throw conflict("Can't undo: that document is back already.");
  // The term that renewed it may be gone too; then this one is current.
  let supersededBy = img.superseded_by_id;
  if (supersededBy) {
    const { rowCount: live } = await client.query(
      'SELECT 1 FROM public.expiring_documents WHERE id = $1',
      [supersededBy],
    );
    if (!live) supersededBy = null;
  }
  await client.query('SAVEPOINT document_undo');
  try {
    await client.query(
      `INSERT INTO public.expiring_documents
         (id, location_id, thing_id, place_id, kind, title, expires_on, lead_days,
          superseded_by_id, issued_on, cost, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, kept.current_user_id())`,
      [
        id,
        event.locationId,
        img.thing_id,
        img.place_id,
        img.kind,
        img.title,
        img.expires_on,
        img.lead_days,
        supersededBy,
        img.issued_on ?? null,
        img.cost ?? null,
        img.currency ?? null,
      ],
    );
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT document_undo');
    // Its thing or place was purged (23503), or it is no longer this person's to write (42501).
    if (pgErrorOf(err)) throw conflict("Can't undo: what the document was on is gone.");
    throw err;
  }
  await client.query('RELEASE SAVEPOINT document_undo');
  // The terms it had renewed point at it again, unless one was renewed another way since.
  const renewed = Array.isArray(img.renewed_from) ? img.renewed_from : [];
  if (renewed.length > 0) {
    await client.query(
      `UPDATE public.expiring_documents SET superseded_by_id = $1
        WHERE id = ANY ($2::uuid[]) AND superseded_by_id IS NULL`,
      [id, renewed],
    );
  }
  // Its files, where the person undoing can still see them (see the header).
  const held = Array.isArray(img.attachments) ? img.attachments : [];
  const relinked: string[] = [];
  for (const a of held) {
    if (a.file_id) {
      const { rowCount: seen } = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM public.files WHERE id = $2)
                     OR kept.undo_holds_file($1, $2)`,
        [a.id, a.file_id],
      );
      if (!seen) continue;
    }
    await client.query(
      `INSERT INTO public.attachments
         (id, location_id, file_id, url, expiring_document_id, role, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id())
       ON CONFLICT (id) DO NOTHING`,
      [a.id, event.locationId, a.file_id, a.url, id, a.role, a.sort],
    );
    relinked.push(a.id);
  }
  const after = await current(args, id);
  await args.audit({
    action: event.action,
    entity: { type: ENTITY, id },
    before: null,
    after: { ...imageOf(after), attachments: relinked },
    subjects: after.thing_id ? [after.thing_id] : [],
    rootThingId: after.thing_id,
  });
}

async function undoRenew(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== ENTITY || !id) throw notUndoable();
  const renewedId = event.diff.superseded_by_id?.after;
  if (typeof renewedId !== 'string') throw notUndoable();
  await current(args, id);
  await client.query(
    'SELECT 1 FROM public.expiring_documents WHERE id = ANY ($1::uuid[]) FOR UPDATE',
    [[id, renewedId]],
  );
  const old = await current(args, id);
  if (old.superseded_by_id !== renewedId) await refuse(args, id, ['superseded_by_id']);
  const { rows } = await client.query<{
    row_version: number;
    superseded_by_id: string | null;
    files: number;
  }>(
    `SELECT d.row_version, d.superseded_by_id,
            (SELECT count(*)::int FROM public.attachments a
              WHERE a.expiring_document_id = d.id) AS files
       FROM public.expiring_documents d WHERE d.id = $1`,
    [renewedId],
  );
  const renewed = rows[0];
  if (!renewed) throw conflict("Can't undo: the renewal no longer exists.");
  if (renewed.row_version !== 1 || renewed.superseded_by_id || renewed.files > 0) {
    await refuse(args, renewedId, ['renewed']);
  }
  // The old term's superseded_by_id goes back to null with it (ON DELETE SET NULL).
  await client.query('DELETE FROM public.expiring_documents WHERE id = $1', [renewedId]);
  await args.audit({
    action: event.action,
    entity: { type: ENTITY, id },
    before: { superseded_by_id: renewedId },
    after: { superseded_by_id: null },
    subjects: old.thing_id ? [old.thing_id] : [],
    rootThingId: old.thing_id,
  });
}

let registered = false;

/** Registers the expiring documents' undo handlers (idempotent; paperwork/routes.ts calls it). */
export function registerPaperworkUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('document.update', undoUpdate);
  registerUndo('document.delete', undoDelete);
  registerUndo('document.renew', undoRenew);
}
