import { ATTACHMENT_ROLES, type AttachmentRole, type DocumentKind } from '@kept/shared';
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
import { pageOf } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { snippetOf } from '../search/documents.js';
import { Params, termsCte, termsOf } from '../search/query.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  type DocumentState,
  documentStateSql,
  locationTodaySql,
  type SubjectRef,
  subjectRefSql,
} from './view.js';

// The paperwork library (plan T12; D39, D155; screens §5 "Paperwork"): every receipt, invoice,
// manual, warranty document, registration and document across the caller's locations with
// Paperwork on, whatever it hangs on, each named by what it is about (a thing, a place, or the
// location). A file on a warranty, claim, valuation or service record is about that record's
// thing (or place); a purchase's receipt is about the first live thing bought on it (a purchase
// with none yet is left out, as the mock does); a file on an expiring document is about the
// document's subject and carries its expiry. A superseded document's files are left out: the
// library shows the current term (the document's `history` keeps the old ones).
//
// `q` matches a file's text (file_text, through kept.search_file_ids(), as search does), the
// subject's name and an expiring document's title.
//
// Money (security review #10, step-3 Q19): receipts and invoices are left out entirely where the
// caller's gate hides money, as from every attachment list; and a snippet is sent only where the
// gate shows money, as search's documents group does, since any document's text may hold prices.
// Originals stay members-and-above through the signed-URL route (D117).

/** The roles the library lists: paperwork, never photos, proofs or condition photos. */
export const LIBRARY_ROLES = [
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'registration',
  'document',
] as const satisfies readonly AttachmentRole[];

export const PaperworkQuery = z.object({
  q: z.string().trim().max(200).optional(),
  locationId: z.uuid().optional(),
  role: z.enum(ATTACHMENT_ROLES).optional(),
  subjectType: z.enum(['thing', 'place', 'location']).optional(),
  expiry: z.enum(['any', 'expiring', 'expired']).optional(),
});
export type PaperworkQuery = z.infer<typeof PaperworkQuery>;

export type PaperworkRow = {
  attachment: AttachmentView;
  subject: SubjectRef;
  expiring?: { id: string; kind: DocumentKind; expiresOn: string; state: DocumentState };
  snippet?: string;
};

type Hit = {
  id: string;
  location_id: string;
  file_id: string | null;
  created_key: string;
  subject: SubjectRef;
  doc_id: string | null;
  doc_kind: DocumentKind | null;
  doc_expires_on: string | null;
  doc_state: DocumentState | null;
  /** The file's text matched `q` (not only the subject's name). */
  text_hit: boolean;
};

/** SQL: the state of `d`, the attachment's expiring document. */
const docState = documentStateSql('d', locationTodaySql('d.location_id'));

type ListKey = [string, string];
const ListKeySchema = z.tuple([z.string().max(64), z.uuid()]);

/** The caller's visible locations where their gate hides money. */
async function moneyHidden(tx: Tx, client: pg.ClientBase, scope: Scope): Promise<Set<string>> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM kept.visible_location_ids() AS v(id)',
  );
  const hidden = new Set<string>();
  for (const { id } of rows) {
    if (!(await gateFor(tx, id, scope)).showMoney) hidden.add(id);
  }
  return hidden;
}

export async function listPaperwork(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  query: PaperworkQuery,
  page: { limit: number; after: unknown },
): Promise<{ items: PaperworkRow[]; next_cursor: string | null }> {
  let after: ListKey | null = null;
  if (page.after !== null) {
    const parsed = ListKeySchema.safeParse(page.after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    after = parsed.data;
  }
  const hidden = await moneyHidden(tx, client, scope);
  const terms = termsOf(query.q);
  const p = new Params();
  const ctes: string[] = [];
  const where = [
    `a.role = ANY (${p.add([...LIBRARY_ROLES])}::text[])`,
    'a.meter_reading_id IS NULL',
    'a.loan_id IS NULL',
    `kept.module_on(a.location_id, 'paperwork')`,
    `NOT (a.role = ANY (${p.add([...MONEY_ROLES])}::text[])
          AND a.location_id = ANY (${p.add([...hidden])}::uuid[]))`,
    '(a.purchase_id IS NULL OR s.thing_id IS NOT NULL)',
    '(a.expiring_document_id IS NULL OR d.superseded_by_id IS NULL)',
    'j.subject IS NOT NULL',
  ];
  if (query.locationId)
    where.push(`a.location_id = ${p.add(query.locationId.toLowerCase())}::uuid`);
  if (query.role) where.push(`a.role = ${p.add(query.role)}::text`);
  if (query.subjectType) where.push(`j.subject->>'type' = ${p.add(query.subjectType)}::text`);
  if (query.expiry === 'expiring' || query.expiry === 'expired') {
    where.push(`d.id IS NOT NULL AND ${docState} = ${p.add(query.expiry)}::text`);
  }
  if (terms.raw !== '') {
    ctes.push(termsCte(p, terms));
    const loc = query.locationId ? `${p.add(query.locationId.toLowerCase())}::uuid` : 'NULL::uuid';
    ctes.push(`hits AS (
      SELECT kept.search_file_ids((SELECT tsq FROM terms), ${loc}) AS id
      UNION
      SELECT kept.search_file_ids((SELECT ptsq FROM terms), ${loc}))`);
    const doc = `to_tsvector('simple', kept.search_text(concat_ws(' ', j.subject->>'name', d.title)))`;
    where.push(`(a.file_id IN (SELECT id FROM hits)
                 OR (terms.tsq IS NOT NULL AND ${doc} @@ terms.tsq)
                 OR (terms.ptsq IS NOT NULL AND ${doc} @@ terms.ptsq))`);
  }
  if (after) {
    where.push(
      `(a.created_at, a.id) < (${p.add(after[0])}::timestamptz, ${p.add(after[1])}::uuid)`,
    );
  }
  const { rows } = await client.query<Hit>(
    `${ctes.length > 0 ? `WITH ${ctes.join(',\n')}` : ''}
     SELECT a.id, a.location_id, a.file_id, a.created_at::text AS created_key, j.subject,
            d.id AS doc_id, d.kind AS doc_kind, d.expires_on::text AS doc_expires_on,
            CASE WHEN d.id IS NULL THEN NULL ELSE ${docState} END AS doc_state,
            ${terms.raw !== '' ? 'a.file_id IN (SELECT id FROM hits)' : 'false'} AS text_hit
       FROM public.attachments a
       LEFT JOIN public.expiring_documents d ON d.id = a.expiring_document_id
       LEFT JOIN public.warranties w ON w.id = a.warranty_id
       LEFT JOIN public.claims c ON c.id = a.claim_id
       LEFT JOIN public.valuations v ON v.id = a.valuation_id
       LEFT JOIN public.service_records sr ON sr.id = a.service_record_id
      CROSS JOIN LATERAL (
        SELECT coalesce(a.thing_id, d.thing_id, w.thing_id, c.thing_id, v.thing_id, sr.thing_id,
                        (SELECT bt.id FROM public.things bt
                           JOIN public.purchase_lines pl ON pl.id = bt.purchase_line_id
                          WHERE a.purchase_id IS NOT NULL AND pl.purchase_id = a.purchase_id
                            AND bt.deleted_at IS NULL
                          ORDER BY bt.created_at, bt.id LIMIT 1)) AS thing_id,
               coalesce(a.place_id, d.place_id, sr.place_id) AS place_id) s
      CROSS JOIN LATERAL (
        SELECT ${subjectRefSql('s.thing_id', 's.place_id', 'a.location_id')} AS subject) j
      ${terms.raw !== '' ? 'CROSS JOIN terms' : ''}
      WHERE ${where.join('\n AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${p.add(page.limit + 1)}`,
    p.values,
  );
  const paged = pageOf(rows, page.limit, (r): ListKey => [r.created_key, r.id]);
  const hits = paged.items;
  if (hits.length === 0) return { items: [], next_cursor: paged.next_cursor };

  const { rows: attached } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.id = ANY ($1::uuid[])`,
    [hits.map((h) => h.id)],
  );
  const views = await attachmentViews(client, files, attached);
  const viewOf = new Map(views.map((v) => [v.id, v]));

  // Snippets: this page's texts only, and only where the caller's gate shows money.
  const texts = new Map<string, string>();
  if (terms.raw !== '') {
    const wanted = [
      ...new Set(
        hits
          .filter((h) => h.text_hit && h.file_id && !hidden.has(h.location_id))
          .map((h) => h.file_id),
      ),
    ];
    if (wanted.length > 0) {
      const { rows: t } = await client.query<{ file_id: string; text: string }>(
        `SELECT file_id, left(text, 100000) AS text FROM public.file_text
          WHERE file_id = ANY ($1::uuid[])`,
        [wanted],
      );
      for (const r of t) texts.set(r.file_id, r.text);
    }
  }

  const items = hits.flatMap((h): PaperworkRow[] => {
    const attachment = viewOf.get(h.id);
    if (!attachment) return [];
    const row: PaperworkRow = { attachment, subject: h.subject };
    if (h.doc_id && h.doc_kind && h.doc_expires_on && h.doc_state) {
      row.expiring = {
        id: h.doc_id,
        kind: h.doc_kind,
        expiresOn: h.doc_expires_on,
        state: h.doc_state,
      };
    }
    const text = h.text_hit && h.file_id ? texts.get(h.file_id) : undefined;
    if (text) {
      const snippet = snippetOf(text, terms.raw);
      if (snippet) row.snippet = snippet;
    }
    return [row];
  });
  return { items, next_cursor: paged.next_cursor };
}
