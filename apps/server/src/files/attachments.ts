import type { Role } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { lastChangedBy } from '../audit/undo.js';
import type { Pools } from '../db/pools.js';
import { type Tx, withSystem } from '../db/scope.js';
import { checkVersion, pageOf } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import type { Gate } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { lockBlobKeys } from './blob-locks.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentSubject,
  type AttachmentView,
  attachmentViews,
  isMoneyRole,
  LOCATION_OWN_SQL,
  MONEY_ROLES,
  SUBJECT_COLUMNS,
  type SubjectColumn,
} from './views.js';

// Attachments (§7.13; D115, D128, D155, D162, D177): a file or a link on one subject (a thing, a
// place, a purchase, a meter reading, or the location itself). Everything is read and written as
// the request's user, so the policies decide visibility; the role rules are can()'s:
// - adding: `attachments.add` (members and above);
// - changing or removing your own: `attachments.delete-own`; anyone's: `attachments.delete-any`
//   (owners and admins).
// A URL attachment is stored as given and never fetched by the server (D128).
//
// Receipts and invoices are money (files/views.ts MONEY_ROLES; security review #10): where the
// caller's gate hides money they are left out of every list, and adding one, or making one by a
// PATCH of the role, is 409 `module_off`, as any money write there is. The caller passes its
// gates as `gateOf` (serialize/gates.ts gateFor, bound to the request).

/** The caller's gate in a location (gateFor bound to the request's transaction and scope). */
export type GateOf = (locationId: string) => Promise<Gate>;

async function refuseHiddenMoneyRole(gateOf: GateOf, locationId: string, role: string) {
  if (!isMoneyRole(role)) return;
  if (!(await gateOf(locationId)).showMoney) {
    throw new AppError(
      'module_off',
      409,
      'Receipts and invoices show money, which is hidden for you in this location.',
    );
  }
}

export type CreateAttachment = {
  id: string;
  locationId: string;
  fileId?: string | undefined;
  url?: string | undefined;
  subject: AttachmentSubject;
  role: string;
  sort?: number | undefined;
};

type SubjectColumns = { [C in SubjectColumn]: string | null };

export function subjectColumns(subject: AttachmentSubject): SubjectColumns {
  const bag = subject as Record<string, unknown>;
  return Object.fromEntries(
    SUBJECT_COLUMNS.map(([column, key]) => {
      const id = bag[key];
      return [column, typeof id === 'string' ? id.toLowerCase() : null];
    }),
  ) as SubjectColumns;
}

/** Each subject's table (the existence check); things and places must not be in the trash. */
const SUBJECT_TABLES: Readonly<Record<SubjectColumn, string>> = {
  thing_id: 'public.things WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
  place_id: 'public.places WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL',
  purchase_id: 'public.purchases WHERE id = $1 AND location_id = $2',
  meter_reading_id: 'public.meter_readings WHERE id = $1 AND location_id = $2',
  warranty_id: 'public.warranties WHERE id = $1 AND location_id = $2',
  claim_id: 'public.claims WHERE id = $1 AND location_id = $2',
  loan_id: 'public.loans WHERE id = $1 AND location_id = $2',
  incident_id: 'public.incidents WHERE id = $1 AND location_id = $2',
  valuation_id: 'public.valuations WHERE id = $1 AND location_id = $2',
  service_record_id: 'public.service_records WHERE id = $1 AND location_id = $2',
  expiring_document_id: 'public.expiring_documents WHERE id = $1 AND location_id = $2',
  fuel_entry_id: 'public.fuel_entries WHERE id = $1 AND location_id = $2',
};

/** The subject's table and id, for the existence check; null for the location itself. */
function subjectTable(s: SubjectColumns): { sql: string; id: string } | null {
  for (const [column] of SUBJECT_COLUMNS) {
    const id = s[column];
    if (id) return { sql: `SELECT 1 FROM ${SUBJECT_TABLES[column]}`, id };
  }
  return null;
}

/** 404 unless the subject is in `locationId` and the caller can see it. */
async function requireSubject(client: pg.ClientBase, locationId: string, s: SubjectColumns) {
  const table = subjectTable(s);
  if (!table) return;
  const { rowCount } = await client.query(table.sql, [table.id, locationId]);
  if (!rowCount) throw notFound();
}

/** For the audit: the thing an attachment belongs to, so the thing's history shows it (D45). */
const thingSubjects = (r: { thing_id: string | null }) => (r.thing_id ? [r.thing_id] : []);

async function readAttachment(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<AttachmentRow> {
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Members change and remove their own; owners and admins anyone's. */
function requireOwnOrAny(role: Role, row: AttachmentRow, userId: string): void {
  if (row.created_by === userId) {
    requireCan(
      role,
      'attachments.delete-own',
      'Viewers can look at attachments but not change them.',
    );
  } else {
    requireCan(
      role,
      'attachments.delete-any',
      'Only owners and admins can change what someone else attached.',
    );
  }
}

/** An attachment's audit image: role, sort, file or URL, and its one subject column (the others
 * are null, and stay out of the diff). */
const auditImage = (
  r:
    | AttachmentRow
    | (SubjectColumns & { role: string; sort: number; file_id: string | null; url: string | null }),
) => ({
  role: r.role,
  sort: r.sort,
  fileId: r.file_id,
  url: r.url,
  thingId: r.thing_id,
  placeId: r.place_id,
  purchaseId: r.purchase_id,
  meterReadingId: r.meter_reading_id,
  ...Object.fromEntries(
    SUBJECT_COLUMNS.slice(4).flatMap(([column, key]) => (r[column] ? [[key, r[column]]] : [])),
  ),
});

export async function createAttachment(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  gateOf: GateOf,
  userId: string,
  body: CreateAttachment,
  requestId: string,
): Promise<AttachmentView> {
  const locationId = body.locationId.toLowerCase();
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'attachments.add', 'Viewers can look at attachments but not add them.');
  await refuseHiddenMoneyRole(gateOf, locationId, body.role);
  const subject = subjectColumns(body.subject);
  // T10: a loan's files are its condition photos, going out and coming back.
  if (subject.loan_id && body.role !== 'condition_out' && body.role !== 'condition_in') {
    throw invalid('Check body.role: a loan takes condition_out or condition_in photos.');
  }
  await requireSubject(client, locationId, subject);
  const fileId = body.fileId?.toLowerCase() ?? null;
  if (fileId) {
    // The file must be one the caller can see, in this location (D177): someone else's
    // unattached upload, or a file of another location, is the same 404 as none at all.
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.files WHERE id = $1 AND location_id = $2',
      [fileId, locationId],
    );
    if (!rowCount) throw notFound();
  }
  const columns = SUBJECT_COLUMNS.map(([c]) => c);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.attachments (id, location_id, file_id, url, ${columns.join(', ')}, role,
                                     sort, created_by)
     VALUES ($1, $2, $3, $4, ${columns.map((_, i) => `$${i + 5}`).join(', ')},
             $${columns.length + 5}, $${columns.length + 6}, kept.current_user_id())
     RETURNING id`,
    [
      body.id,
      locationId,
      fileId,
      body.url ?? null,
      ...columns.map((c) => subject[c]),
      body.role,
      body.sort ?? 0,
    ],
  );
  const id = (rows[0] as { id: string }).id;
  const row = await readAttachment(client, id);
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: userId },
    action: 'attachment.create',
    entity: { type: 'attachment', id },
    after: auditImage(row),
    subjects: thingSubjects(row),
    rootThingId: row.thing_id,
    requestId,
  });
  const [view] = await attachmentViews(client, files, [row]);
  return view as AttachmentView;
}

export async function updateAttachment(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  gateOf: GateOf,
  userId: string,
  id: string,
  expected: number,
  patch: { role?: string | undefined; sort?: number | undefined },
  requestId: string,
): Promise<AttachmentView> {
  const seen = await readAttachment(client, id);
  const me = await requireMembership(client, seen.location_id);
  requireOwnOrAny(me.role, seen, userId);
  // Then locked (a FOR UPDATE a viewer's policies would answer as a 404, hence the read above)
  // while it is checked and changed: two PATCHes from one version can't both pass the If-Match
  // check and the second overwrite the first (security review #13).
  const before = await readAttachment(client, id, true);
  // A hidden receipt is not the caller's to see, let alone change; nor is a new one theirs to make.
  await refuseHiddenMoneyRole(gateOf, before.location_id, before.role);
  if (patch.role !== undefined) await refuseHiddenMoneyRole(gateOf, before.location_id, patch.role);
  const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (before.row_version !== expected) {
    const by = await lastChangedBy(client, before.location_id, { type: 'attachment', id });
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      fields,
      by ? { displayName: by } : null,
    );
  }
  await client.query(
    `UPDATE public.attachments SET role = coalesce($2, role), sort = coalesce($3, sort)
      WHERE id = $1`,
    [id, patch.role ?? null, patch.sort ?? null],
  );
  const after = await readAttachment(client, id);
  await audited(tx, {
    locationId: after.location_id,
    actor: { type: 'user', id: userId },
    action: 'attachment.update',
    entity: { type: 'attachment', id },
    before: { role: before.role, sort: before.sort },
    after: { role: after.role, sort: after.sort },
    subjects: thingSubjects(after),
    rootThingId: after.thing_id,
    requestId,
  });
  const [view] = await attachmentViews(client, files, [after]);
  return view as AttachmentView;
}

export async function deleteAttachment(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  id: string,
  requestId: string,
): Promise<void> {
  const row = await readAttachment(client, id);
  const me = await requireMembership(client, row.location_id);
  requireOwnOrAny(me.role, row, userId);
  await client.query('DELETE FROM public.attachments WHERE id = $1', [id]);
  await audited(tx, {
    locationId: row.location_id,
    actor: { type: 'user', id: userId },
    action: 'attachment.delete',
    entity: { type: 'attachment', id },
    before: auditImage(row),
    after: null,
    subjects: thingSubjects(row),
    rootThingId: row.thing_id,
    requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Lists: GET /api/v1/{things|places|purchases|locations}/:id/attachments?role&cursor&limit
// ---------------------------------------------------------------------------------------------

export type AttachmentOwner = 'thing' | 'place' | 'purchase' | 'location';

/** `exists` answers the owner's location, as the caller sees it (none: a 404). */
const OWNER_SQL: Record<AttachmentOwner, { exists: string; where: string }> = {
  thing: {
    exists: 'SELECT location_id FROM public.things WHERE id = $1',
    where: 'a.thing_id = $1',
  },
  place: {
    exists: 'SELECT location_id FROM public.places WHERE id = $1',
    where: 'a.place_id = $1',
  },
  purchase: {
    exists: 'SELECT location_id FROM public.purchases WHERE id = $1',
    where: 'a.purchase_id = $1',
  },
  // The location's own attachments: those with no subject (D155).
  location: {
    exists: 'SELECT id AS location_id FROM public.locations WHERE id = $1',
    where: `a.location_id = $1 AND ${LOCATION_OWN_SQL}`,
  },
};

type ListKey = [number, string];

export async function listAttachments(
  client: pg.ClientBase,
  files: FileStorage | null,
  gateOf: GateOf,
  owner: AttachmentOwner,
  id: string,
  opts: { role?: string | undefined; limit: number; after: ListKey | null },
): Promise<{ items: AttachmentView[]; next_cursor: string | null }> {
  const q = OWNER_SQL[owner];
  const { rows: found } = await client.query<{ location_id: string }>(q.exists, [id]);
  const locationId = found[0]?.location_id;
  if (!locationId) throw notFound();
  // Every attachment of one owner is in the owner's location, so one gate filters the page.
  const hidden = (await gateOf(locationId)).showMoney ? [] : [...MONEY_ROLES];
  const after = opts.after;
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT}
      WHERE ${q.where}
        AND ($2::text IS NULL OR a.role = $2)
        AND ($3::int IS NULL OR (a.sort, a.id) > ($3::int, $4::uuid))
        AND a.role <> ALL ($6::text[])
      ORDER BY a.sort, a.id
      LIMIT $5`,
    [id, opts.role ?? null, after?.[0] ?? null, after?.[1] ?? null, opts.limit + 1, hidden],
  );
  const page = pageOf(rows, opts.limit, (r): ListKey => [r.sort, r.id]);
  return { items: await attachmentViews(client, files, page.items), next_cursor: page.next_cursor };
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/files/:id {reason}: "delete original" (D162)
// ---------------------------------------------------------------------------------------------

/** Removes a mistaken upload for good: the file row, with its attachments and derivatives by
 * cascade, audited with the admin's reason. Owners and admins only. Returns the storage keys the
 * rows named, for deleteUnreferencedBlobs() once the transaction has committed. */
export async function deleteOriginal(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  fileId: string,
  reason: string,
  requestId: string,
): Promise<{ storageKeys: string[] }> {
  const { rows } = await client.query<{
    location_id: string;
    class: string;
    mime: string;
    bytes: string;
  }>('SELECT location_id, class, mime, bytes FROM public.files WHERE id = $1', [fileId]);
  const file = rows[0];
  if (!file) throw notFound();
  const me = await requireMembership(client, file.location_id);
  if (me.role !== 'owner' && me.role !== 'admin') {
    throw forbidden('Only owners and admins can delete an original.');
  }
  const { rows: on } = await client.query<{ thing_id: string }>(
    'SELECT DISTINCT thing_id FROM public.attachments WHERE file_id = $1 AND thing_id IS NOT NULL',
    [fileId],
  );
  const { rows: keys } = await client.query<{ key: string }>(
    `SELECT storage_key AS key FROM public.files WHERE id = $1
     UNION SELECT storage_key FROM public.file_derivatives WHERE file_id = $1`,
    [fileId],
  );
  const { rowCount } = await client.query('DELETE FROM public.files WHERE id = $1', [fileId]);
  if (!rowCount) throw notFound();
  await audited(tx, {
    locationId: file.location_id,
    actor: { type: 'user', id: userId },
    action: 'file.delete_original',
    entity: { type: 'file', id: fileId },
    before: { class: file.class, mime: file.mime, bytes: Number(file.bytes), reason: null },
    after: { reason },
    subjects: on.map((r) => r.thing_id),
    requestId,
  });
  return { storageKeys: keys.map((k) => k.key) };
}

/**
 * After "delete original" commits: deletes the blobs of `keys` that no file or derivative row
 * names any more (kept.unreferenced_storage_keys(), migration 0028, on kept_system). A copy made
 * by a cross-account move shares its source's blobs (D161), so those stay while the copy does.
 * Asked after the commit, never inside the transaction: a rollback must not lose a blob a row
 * still names. The check and the deletes happen under the keys' advisory locks (blob-locks.ts),
 * so an upload or a copy about to name one of them waits, then finds it gone and stores it again
 * (security review #16, #18). Also the clean-up of a failed upload. A blob that won't delete is
 * logged by key (its row is gone, so nothing else will find it again); the delete stands.
 */
export async function deleteUnreferencedBlobs(
  pools: Pick<Pools, 'system'>,
  files: FileStorage,
  keys: readonly string[],
  log: { error: (obj: object, msg: string) => void },
): Promise<number> {
  if (keys.length === 0) return 0;
  return withSystem(pools.system, async (_tx, c) => {
    await lockBlobKeys(c, keys);
    const { rows } = await c.query<{ key: string }>(
      'SELECT k AS key FROM kept.unreferenced_storage_keys($1::text[]) AS k',
      [keys],
    );
    let deleted = 0;
    for (const { key } of rows) {
      try {
        await files.blobs.delete(key);
        deleted += 1;
      } catch (err) {
        log.error({ err, key }, 'a blob no row names could not be deleted');
      }
    }
    return deleted;
  });
}
