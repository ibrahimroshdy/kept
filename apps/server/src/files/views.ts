import type { AttachmentRole, FileClass } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { FileStorage } from '../storage/blob-store.js';
import { SIGNED_URL_TTL_SECONDS } from '../storage/signed-url.js';

// The file and attachment shapes of the web contract (apps/web/src/api/inventory/types.ts,
// "files and attachments (task 17)"). Rows are read as the request's user, so whatever reaches a
// view already passed files' and attachments' policies (§7.2, D177). URLs are short-lived and
// signed (Q16): `/f/<token>` on local storage, presigned on S3.

export type { FileClass };

/** Attachment roles that carry money: a receipt or an invoice shows what was paid. They leave the
 * server only where the caller's gate shows money (serialize/gates.ts; security review #10). */
export const MONEY_ROLES: readonly AttachmentRole[] = ['receipt', 'invoice'];
export const isMoneyRole = (role: string): boolean =>
  (MONEY_ROLES as readonly string[]).includes(role);
export type DerivativeState = 'ready' | 'unavailable' | 'not_applicable';
export type FileVariant = 'original' | 'display' | 'thumb' | 'share';

export type FileView = {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
  class: FileClass;
  hasGps: boolean;
  width: number | null;
  height: number | null;
  derivativeState: DerivativeState;
  thumbUrl: string | null;
  displayUrl: string | null;
  /** On a per-location dedupe hit (D177): the file the bytes already were. */
  deduplicatedFrom?: string;
};

/**
 * What an attachment hangs on: one of these columns, or none (the location itself, D155). Step 4
 * adds a warranty's, claim's, loan's, incident's, valuation's, service record's and expiring
 * document's (migrations 0050, 0052; §7.13). Every list, view and write reads this one table, so
 * an attachment on a step-4 record is never mistaken for one on the location.
 */
export const SUBJECT_COLUMNS = [
  ['thing_id', 'thingId'],
  ['place_id', 'placeId'],
  ['purchase_id', 'purchaseId'],
  ['meter_reading_id', 'meterReadingId'],
  ['warranty_id', 'warrantyId'],
  ['claim_id', 'claimId'],
  ['loan_id', 'loanId'],
  ['incident_id', 'incidentId'],
  ['valuation_id', 'valuationId'],
  ['service_record_id', 'serviceRecordId'],
  ['expiring_document_id', 'expiringDocumentId'],
  // Step 5 (T11): a fill's pump receipt.
  ['fuel_entry_id', 'fuelEntryId'],
] as const;
export type SubjectColumn = (typeof SUBJECT_COLUMNS)[number][0];
export type SubjectKey = (typeof SUBJECT_COLUMNS)[number][1];

export type AttachmentSubject =
  | { [K in SubjectKey]: { [P in K]: string } }[SubjectKey]
  | { location: true };

/** The response schema of an attachment's `subject`, for every route that returns attachments. */
export const AttachmentSubjectSchema = z.union([
  ...SUBJECT_COLUMNS.map(([, key]) => z.strictObject({ [key]: z.uuid() })),
  z.strictObject({ location: z.literal(true) }),
]) as unknown as z.ZodType<AttachmentSubject>;

export type AttachmentView = {
  id: string;
  role: AttachmentRole;
  sort: number;
  file: FileView | null;
  url: string | null;
  subject: AttachmentSubject;
  createdBy: { displayName: string };
  /** For PATCH's If-Match (D156). Not in the web contract's type yet; additive. */
  rowVersion: number;
};

export type FileRow = {
  id: string;
  location_id: string;
  storage_key: string;
  sha256: string;
  bytes: string | number;
  mime: string;
  class: FileClass;
  has_gps: boolean;
  width: number | null;
  height: number | null;
  derivative_state: DerivativeState;
  created_by: string;
};

export const FILE_COLUMNS = `f.id, f.location_id, f.storage_key, f.sha256, f.bytes, f.mime, f.class,
  f.has_gps, f.width, f.height, f.derivative_state, f.created_by`;

/** Derivative storage keys by file, then variant. Keys come from the rows, never from the id: a
 * copy made by a cross-account move shares its source's blobs (D161). */
export type DerivativeKeys = Map<string, Map<string, string>>;

export async function derivativeKeys(
  client: pg.ClientBase,
  fileIds: readonly string[],
): Promise<DerivativeKeys> {
  const out: DerivativeKeys = new Map();
  if (fileIds.length === 0) return out;
  const { rows } = await client.query<{ file_id: string; variant: string; storage_key: string }>(
    `SELECT file_id, variant, storage_key FROM public.file_derivatives WHERE file_id = ANY ($1::uuid[])`,
    [[...new Set(fileIds)]],
  );
  for (const r of rows) {
    let m = out.get(r.file_id);
    if (!m) {
      m = new Map();
      out.set(r.file_id, m);
    }
    m.set(r.variant, r.storage_key);
  }
  return out;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** The name a download is saved as: made from the id, never from anything a user typed. */
export function downloadName(fileId: string, mime: string, variant: FileVariant): string {
  return variant === 'original'
    ? `${fileId}.${EXTENSIONS[mime] ?? 'bin'}`
    : `${fileId}-${variant}.jpg`;
}

export type SignedFileUrl = { url: string; expiresAt: string };

/** A signed URL for one rendition. Originals are `attachment` (D157: not a re-encoded image);
 * derivatives, re-encoded JPEGs, are `inline`. */
export async function signFile(
  files: FileStorage,
  key: string,
  fileId: string,
  mime: string,
  variant: FileVariant,
): Promise<SignedFileUrl> {
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS) * 1000);
  const url = await files.blobs.signedUrl(key, {
    expiresIn: SIGNED_URL_TTL_SECONDS,
    disposition: variant === 'original' ? 'attachment' : 'inline',
    filename: downloadName(fileId, mime, variant),
    contentType: variant === 'original' ? mime : 'image/jpeg',
  });
  return { url, expiresAt: expiresAt.toISOString() };
}

export async function fileViewOf(
  files: FileStorage | null,
  row: FileRow,
  keys: DerivativeKeys,
): Promise<FileView> {
  const mine = keys.get(row.id);
  const derived = async (variant: 'thumb' | 'display') => {
    const key = mine?.get(variant);
    if (!files || !key || row.derivative_state !== 'ready') return null;
    return (await signFile(files, key, row.id, row.mime, variant)).url;
  };
  return {
    id: row.id,
    sha256: row.sha256,
    bytes: Number(row.bytes),
    mime: row.mime,
    class: row.class,
    hasGps: row.has_gps,
    width: row.width,
    height: row.height,
    derivativeState: row.derivative_state,
    thumbUrl: await derived('thumb'),
    displayUrl: await derived('display'),
  };
}

export type AttachmentRow = { [C in SubjectColumn]: string | null } & {
  id: string;
  location_id: string;
  file_id: string | null;
  url: string | null;
  role: AttachmentRole;
  sort: number;
  created_by: string;
  row_version: number;
  display_name: string | null;
};

export const ATTACHMENT_SELECT = `SELECT a.id, a.location_id, a.file_id, a.url,
       ${SUBJECT_COLUMNS.map(([c]) => `a.${c}`).join(', ')},
       a.role, a.sort, a.created_by, a.row_version, up.display_name
  FROM public.attachments a
  LEFT JOIN public.user_profiles up ON up.user_id = a.created_by`;

/** SQL: the attachment `a` has no subject, so it is the location's own (D155). */
export const LOCATION_OWN_SQL = SUBJECT_COLUMNS.map(([c]) => `a.${c} IS NULL`).join(' AND ');

export function subjectOf(r: AttachmentRow): AttachmentSubject {
  for (const [column, key] of SUBJECT_COLUMNS) {
    const id = r[column];
    if (id) return { [key]: id } as AttachmentSubject;
  }
  return { location: true };
}

/** Views of attachment rows, with their files read in one go (as the caller: a file row the
 * caller can't see comes back as `file: null`). */
export async function attachmentViews(
  client: pg.ClientBase,
  files: FileStorage | null,
  rows: readonly AttachmentRow[],
): Promise<AttachmentView[]> {
  const fileIds = [...new Set(rows.flatMap((r) => (r.file_id ? [r.file_id] : [])))];
  const byId = new Map<string, FileRow>();
  if (fileIds.length > 0) {
    const { rows: fileRows } = await client.query<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM public.files f WHERE f.id = ANY ($1::uuid[])`,
      [fileIds],
    );
    for (const f of fileRows) byId.set(f.id, f);
  }
  const keys = await derivativeKeys(client, [...byId.keys()]);
  return Promise.all(
    rows.map(async (r) => {
      const file = r.file_id ? byId.get(r.file_id) : undefined;
      return {
        id: r.id,
        role: r.role,
        sort: r.sort,
        file: file ? await fileViewOf(files, file, keys) : null,
        url: r.url,
        subject: subjectOf(r),
        createdBy: { displayName: r.display_name ?? '' },
        rowVersion: r.row_version,
      };
    }),
  );
}
