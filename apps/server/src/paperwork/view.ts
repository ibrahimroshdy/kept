import { DOCUMENT_KINDS, type DocumentKind } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
  MONEY_ROLES,
} from '../files/views.js';
import { notFound } from '../http/errors.js';
import { gateFor } from '../serialize/gates.js';
import {
  PATH_SEPARATOR,
  placeSubjectJson,
  type SubjectRef,
  SubjectRefSchema,
  thingSubjectJson,
} from '../serialize/subject.js';
import type { FileStorage } from '../storage/blob-store.js';

// The paperwork shapes of the web contract (apps/web/src/api/household/types.ts, "the paperwork
// library and expiring documents (T12)"; plan Phase B "Shared shapes"), and the SQL that builds
// them. Everything is read as the request's user, so the policies decide what exists.

// ---------------------------------------------------------------------------------------------
// SubjectRef: what a record is about (a thing, a place, or the location itself; D39, D155)
// ---------------------------------------------------------------------------------------------

export { PATH_SEPARATOR, type SubjectRef, SubjectRefSchema };

/**
 * SQL: the SubjectRef (jsonb) of a record on `thing`, `place` or neither (the location itself),
 * each a SQL expression. Null when the thing or place is in the trash or not visible, so a caller
 * leaves the record out. A thing's path runs through the places and containers it is in; a
 * place's through the places above it.
 */
export const subjectRefSql = (thing: string, place: string, location: string) => `(
  CASE
    WHEN ${thing} IS NOT NULL THEN (
      SELECT ${thingSubjectJson('st', 'sl.name')}
        FROM public.things st JOIN public.locations sl ON sl.id = st.location_id
       WHERE st.id = ${thing} AND st.deleted_at IS NULL)
    WHEN ${place} IS NOT NULL THEN (
      SELECT ${placeSubjectJson('sp', 'sl.name')}
        FROM public.places sp JOIN public.locations sl ON sl.id = sp.location_id
       WHERE sp.id = ${place} AND sp.deleted_at IS NULL)
    ELSE (
      SELECT jsonb_build_object('type', 'location', 'id', sl.id, 'name', sl.name, 'path', '')
        FROM public.locations sl WHERE sl.id = ${location} AND sl.deleted_at IS NULL)
  END)`;

// ---------------------------------------------------------------------------------------------
// Expiring documents (D39, D155, D172; plan Q5, Q31)
// ---------------------------------------------------------------------------------------------

export const DOCUMENT_STATES = ['ok', 'expiring', 'expired'] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export type ExpiringDocument = {
  id: string;
  locationId: string;
  subject: SubjectRef;
  kind: DocumentKind;
  title: string | null;
  expiresOn: string;
  leadDays: number;
  state: DocumentState;
  supersededById: string | null;
  /** Earlier terms, newest first: renewing keeps the old one (D172). */
  history: Array<{ id: string; expiresOn: string }>;
  documents: AttachmentView[];
  rowVersion: number;
  /** Step 5 (T12, Q5): when it was issued (a renewal's cost counts in its month). */
  issuedOn: string | null;
  /** Step 5 (T12, Q5): what it cost, through the money gate: left out with `moneyHidden`. */
  cost?: string;
  currency?: string;
  moneyHidden?: true;
};

/**
 * SQL: a document's state on its location's own date (L2: the expiry day itself is still
 * covered): expired after it, expiring from `lead_days` before it, ok before that. The agenda
 * (0053) names the same days `overdue`, `expiring` and `upcoming`.
 */
export const documentStateSql = (d: string, today: string) => `CASE
    WHEN ${today} > ${d}.expires_on THEN 'expired'
    WHEN ${today} >= ${d}.expires_on - ${d}.lead_days THEN 'expiring'
    ELSE 'ok' END`;

/** SQL: a location's own date, from its timezone (§7.13: "today" is the location's). */
export const locationTodaySql = (location: string) =>
  `(SELECT (now() AT TIME ZONE tl.timezone)::date FROM public.locations tl WHERE tl.id = ${location})`;

export type DocumentRow = {
  id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  kind: DocumentKind;
  title: string | null;
  expires_on: string;
  lead_days: number;
  superseded_by_id: string | null;
  created_by: string;
  row_version: number;
  issued_on: string | null;
  cost: string | null;
  currency: string | null;
  state: DocumentState;
  subject: SubjectRef | null;
  history: Array<{ id: string; expiresOn: string }>;
};

/**
 * The columns of a DocumentRow for `d` (an alias of public.expiring_documents). `history` walks
 * back through the rows this one superseded, newest first (a chain, so at most one per step).
 */
export const DOCUMENT_COLUMNS = (d = 'd') => `${d}.id, ${d}.location_id, ${d}.thing_id,
       ${d}.place_id, ${d}.kind, ${d}.title, ${d}.expires_on::text AS expires_on, ${d}.lead_days,
       ${d}.superseded_by_id, ${d}.created_by, ${d}.row_version,
       ${d}.issued_on::text AS issued_on, trim_scale(${d}.cost)::text AS cost, ${d}.currency,
       ${documentStateSql(d, locationTodaySql(`${d}.location_id`))} AS state,
       ${subjectRefSql(`${d}.thing_id`, `${d}.place_id`, `${d}.location_id`)} AS subject,
       (WITH RECURSIVE back(id, expires_on, depth) AS (
          SELECT p.id, p.expires_on, 1 FROM public.expiring_documents p
           WHERE p.superseded_by_id = ${d}.id
          UNION ALL
          SELECT p.id, p.expires_on, b.depth + 1 FROM public.expiring_documents p
            JOIN back b ON p.superseded_by_id = b.id
           WHERE b.depth < 100)
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'expiresOn', b.expires_on::text)
                                  ORDER BY b.depth), '[]'::jsonb)
          FROM back b) AS history`;

/** Readers get these; rows whose subject is gone (trashed) are left out by the callers. */
export async function documentViews(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  rows: readonly DocumentRow[],
): Promise<ExpiringDocument[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Money roles (receipts, invoices) only where the caller's gate shows money, as every list.
  const hidden = new Set<string>();
  for (const loc of new Set(rows.map((r) => r.location_id))) {
    if (!(await gateFor(tx, loc, scope)).showMoney) hidden.add(loc);
  }
  const { rows: attached } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT}
      WHERE a.expiring_document_id = ANY ($1::uuid[])
        AND NOT (a.role = ANY ($2::text[]) AND a.location_id = ANY ($3::uuid[]))
      ORDER BY a.sort, a.created_at, a.id`,
    [ids, [...MONEY_ROLES], [...hidden]],
  );
  const views = await attachmentViews(client, files, attached);
  const byDoc = new Map<string, AttachmentView[]>();
  attached.forEach((a, i) => {
    const doc = a.expiring_document_id as string;
    const list = byDoc.get(doc) ?? [];
    list.push(views[i] as AttachmentView);
    byDoc.set(doc, list);
  });
  return rows.flatMap((r) =>
    r.subject
      ? [
          {
            id: r.id,
            locationId: r.location_id,
            subject: r.subject,
            kind: r.kind,
            title: r.title,
            expiresOn: r.expires_on,
            leadDays: r.lead_days,
            state: r.state,
            supersededById: r.superseded_by_id,
            history: r.history,
            documents: byDoc.get(r.id) ?? [],
            rowVersion: r.row_version,
            issuedOn: r.issued_on,
            ...(hidden.has(r.location_id)
              ? { moneyHidden: true as const }
              : r.cost !== null && r.currency !== null
                ? { cost: r.cost, currency: r.currency }
                : {}),
          },
        ]
      : [],
  );
}

/** One document by id, as the caller sees it; 404 when it isn't visible or its subject is gone. */
export async function readDocumentRow(client: pg.ClientBase, id: string): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS('d')} FROM public.expiring_documents d WHERE d.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row?.subject) throw notFound();
  return row;
}

/** Locks a document for a write (after the caller's role was checked: FOR UPDATE follows the
 * update policy, so a viewer's lock would read as a 404) and reads it again. */
export async function lockDocumentRow(client: pg.ClientBase, id: string): Promise<DocumentRow> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.expiring_documents WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rowCount) throw notFound();
  return readDocumentRow(client, id);
}

export async function documentView(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  id: string,
): Promise<ExpiringDocument> {
  const [view] = await documentViews(tx, client, files, scope, [await readDocumentRow(client, id)]);
  if (!view) throw notFound();
  return view;
}

// ---------------------------------------------------------------------------------------------
// Response schemas (the web contract)
// ---------------------------------------------------------------------------------------------

/** An attachment as step 2 returns it; the files route's schema is the strict one. */
export const AttachmentRefSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  sort: z.number(),
  file: z.record(z.string(), z.unknown()).nullable(),
  url: z.string().nullable(),
  subject: z.record(z.string(), z.unknown()),
  createdBy: z.object({ displayName: z.string() }),
  rowVersion: z.number(),
});

export const ExpiringDocumentSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  subject: SubjectRefSchema,
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().nullable(),
  expiresOn: z.string(),
  leadDays: z.number().int(),
  state: z.enum(DOCUMENT_STATES),
  supersededById: z.uuid().nullable(),
  history: z.array(z.object({ id: z.uuid(), expiresOn: z.string() })),
  documents: z.array(AttachmentRefSchema),
  rowVersion: z.number().int(),
  issuedOn: z.string().nullable(),
  cost: z.string().optional(),
  currency: z.string().optional(),
  moneyHidden: z.literal(true).optional(),
});

export const PaperworkRowSchema = z.object({
  attachment: AttachmentRefSchema,
  subject: SubjectRefSchema,
  expiring: z
    .object({
      id: z.uuid(),
      kind: z.enum(DOCUMENT_KINDS),
      expiresOn: z.string(),
      state: z.enum(DOCUMENT_STATES),
    })
    .optional(),
  snippet: z.string().optional(),
});
