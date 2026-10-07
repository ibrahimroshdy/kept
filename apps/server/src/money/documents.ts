import { can, type Role } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Tx } from '../db/scope.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
  MONEY_ROLES,
} from '../files/views.js';
import { forbidden } from '../http/errors.js';
import type { FileStorage } from '../storage/blob-store.js';

// The documents of a step-4 record (T8, T9): a valuation's appraisal, a warranty's card, a claim's
// paperwork. They are ordinary attachments on the record's own subject column (§7.13), read and
// written through POST /api/v1/attachments; the record's view lists them, and deleting the record
// deletes them (the foreign key cascades), each audited, as a purchase's receipts are
// (purchases/service.ts). The delete's audit event keeps their images, so its undo can put them
// back (plan Q25).

export type DocColumn = 'valuation_id' | 'warranty_id' | 'claim_id';

/**
 * The documents of each record in `ids`, in attachment order, keyed by record id. Receipts and
 * invoices (files/views.ts MONEY_ROLES) are left out unless `showMoney` (security review #10).
 */
export async function documentsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  column: DocColumn,
  ids: readonly string[],
  showMoney: boolean,
): Promise<Map<string, AttachmentView[]>> {
  const out = new Map<string, AttachmentView[]>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<AttachmentRow & { doc_owner: string }>(
    `SELECT d.*, o.${column} AS doc_owner
       FROM (${ATTACHMENT_SELECT}
              WHERE a.${column} = ANY ($1::uuid[]) AND a.role <> ALL ($2::text[])) d
       JOIN public.attachments o ON o.id = d.id
      ORDER BY d.sort, d.id`,
    [ids, showMoney ? [] : [...MONEY_ROLES]],
  );
  const views = await attachmentViews(client, files, rows);
  rows.forEach((r, i) => {
    const list = out.get(r.doc_owner) ?? [];
    list.push(views[i] as AttachmentView);
    out.set(r.doc_owner, list);
  });
  return out;
}

/** What a delete's audit event keeps of each document, to put it back on undo. */
export type DocImage = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

type DocRow = DocImage & { created_by: string };

async function docRows(client: pg.ClientBase, column: DocColumn, id: string): Promise<DocRow[]> {
  const { rows } = await client.query<DocRow>(
    `SELECT id, file_id, url, role, sort, created_by FROM public.attachments
      WHERE ${column} = $1 ORDER BY sort, id`,
    [id],
  );
  return rows;
}

/**
 * Before a record is deleted: its documents, refusing (403) when someone else added one and the
 * caller may not delete what others attached (§7.1 `attachments.delete-any`), as DELETE
 * /attachments/:id would.
 */
export async function documentsToDelete(
  client: pg.ClientBase,
  role: Role,
  userId: string,
  column: DocColumn,
  id: string,
): Promise<DocImage[]> {
  const rows = await docRows(client, column, id);
  if (rows.some((r) => r.created_by !== userId) && !can(role, 'attachments.delete-any')) {
    throw forbidden('Someone else added a document here. Ask an owner or admin to delete it.');
  }
  return rows.map(({ created_by: _c, ...image }) => image);
}

/** After the record's delete (the rows went by cascade): one `attachment.delete` each. */
export async function auditDeletedDocuments(
  tx: Tx,
  event: {
    locationId: string;
    userId: string;
    column: DocColumn;
    recordId: string;
    thingId: string | null;
    requestId: string;
  },
  docs: readonly DocImage[],
): Promise<void> {
  for (const d of docs) {
    await audited(tx, {
      locationId: event.locationId,
      actor: { type: 'user', id: event.userId },
      action: 'attachment.delete',
      entity: { type: 'attachment', id: d.id },
      before: {
        [event.column]: event.recordId,
        file_id: d.file_id,
        url: d.url,
        role: d.role,
        sort: d.sort,
      },
      after: null,
      subjects: event.thingId ? [event.thingId] : [],
      rootThingId: event.thingId,
      requestId: event.requestId,
    });
  }
}

/**
 * Undo of a record's delete: its documents back on it, with their ids. A file the person undoing
 * can't see (a file is readable only through an attachment, or by its uploader, D177) is linked
 * again when the undone event held it (kept.undo_holds_file, migration 0056), as paperwork,
 * lending and incidents do; a file that is gone (purged) is left out, so the record still comes
 * back. Returns the ids put back.
 */
export async function restoreDocuments(
  client: pg.ClientBase,
  locationId: string,
  column: DocColumn,
  recordId: string,
  docs: readonly DocImage[],
): Promise<string[]> {
  const back: string[] = [];
  for (const d of docs) {
    if (d.file_id) {
      const { rowCount } = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM public.files WHERE id = $1 AND location_id = $2)
                     OR kept.undo_holds_file($3, $1)`,
        [d.file_id, locationId, d.id],
      );
      if (!rowCount) continue;
    }
    const { rowCount } = await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, url, ${column}, role, sort,
                                       created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id())
       ON CONFLICT (id) DO NOTHING`,
      [d.id, locationId, d.file_id, d.url, recordId, d.role, d.sort],
    );
    if (rowCount) back.push(d.id);
  }
  return back;
}

/** The documents' images out of a stored diff field (`documents.before`), or none. */
export function docImagesOf(value: unknown): DocImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (d): d is DocImage =>
      !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string',
  );
}
