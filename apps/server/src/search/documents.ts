import { type AttachmentRole, normalize, searchVariants } from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { MONEY_ROLES } from '../files/views.js';
import { type Many, matchOf } from '../http/list-filters.js';
import { gateFor } from '../serialize/gates.js';
import { Params, singleLocation, type Terms, termsCte } from './query.js';

// The `documents` group of GET /api/v1/search (plan T21, Q19; D77; engineering spec §1.5, §7.2):
// attachments whose file's text (`file_text`, read from a PDF by files/pdf-text.ts, or a
// receipt's) matches the query.
//
// - The match runs through kept.search_file_ids() (0038): `@@` isn't leakproof, so under the
//   policy file_text's GIN index would never be used; the door runs it on the index and applies
//   the caller's file visibility itself. It is called once for each of the query's two tsqueries
//   (the JS twin's and the parser's, query.ts). The rows are then read here, through the
//   policies, by file id: an attachment the caller can't see is never a result.
// - **Receipts and invoices are money** (files/views.ts MONEY_ROLES; security review #10): in a
//   location where the caller's gate hides money they are not results at all, as they are
//   withheld from every attachment list and the signed-URL route. Matching them would be an
//   oracle for what a receipt says.
// - **The snippet needs the money gate** (plan T21): any document's text may hold prices, so the
//   snippet is sent only where the caller's gate in the attachment's location shows money. Where
//   it doesn't, the item has no `snippet` key and carries `moneyHidden: true`, the marker every
//   money-gated object carries (serialize/gates.ts), so a missing snippet can't read as "no
//   text". The subject's name is all such a caller sees of the match.
// - Secret values are never in `file_text` (they live in secret_values, D116), so no secret rule
//   applies beyond the file's own visibility.
// - Trashed things and places don't answer, as in the other groups.
// - A step-4 record's document (a warranty's card, a claim's or a loan's photos, a valuation's,
//   a service record's invoice, an expiring document's file) is named by what the record is
//   about: its thing, else its place, else (an expiring document of the location itself) the
//   location. An incident's names the incident (`incident`, no name: the web words it).

export type DocumentSubjectKind =
  | 'thing'
  | 'place'
  | 'purchase'
  | 'meter_reading'
  | 'incident'
  | 'location';

/** SQL: the thing a step-4 record's attachment `a` is about (see the header). */
const RECORD_THING = `coalesce(a.thing_id, rw.thing_id, rc.thing_id, ro.thing_id, rv.thing_id,
                               rs.thing_id, rd.thing_id)`;
/** SQL: the place a record's attachment is about, when it's about no thing. */
const RECORD_PLACE = `coalesce(a.place_id, rs.place_id, rd.place_id)`;

export type DocumentItem = {
  attachmentId: string;
  fileId: string;
  locationId: string;
  subject: { kind: DocumentSubjectKind; id: string; name: string | null };
  role: AttachmentRole;
  /** An excerpt around the first match, as the document wrote it. Only where money shows. */
  snippet?: string;
  moneyHidden?: true;
};

/** Characters of context kept before and after the first matching word. */
const BEFORE = 60;
const AFTER = 140;
/** What the snippet looks through: the part of the text the index covers (file_text.tsv). */
const SNIPPET_SOURCE_MAX = 100_000;

const RAW_WORD = /[\p{L}\p{M}\p{N}]+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/** Both search forms of every word of the query, one list per word (the words are ANDed). */
function queryForms(q: string): string[][] {
  return (normalize(q).match(WORD) ?? []).map((w) => searchVariants(w));
}

/** Moves `at` to the nearest whitespace in `dir`, within `limit` characters. */
function toSpace(text: string, at: number, dir: -1 | 1, limit: number): number {
  let i = at;
  for (let n = 0; n < limit && i > 0 && i < text.length; n++, i += dir) {
    if (/\s/.test(text[i] ?? '')) return dir === 1 ? i : i + 1;
  }
  return at;
}

/**
 * An excerpt of `text` around the first word any word of `q` prefixes (the JS twin of the
 * tsquery match, as search/service.ts wordsMatch()), in the document's own spelling and case,
 * whitespace collapsed. Falls back to the opening of the text when no single word matches (the
 * parser's tsquery keeps tokens such as `2.1` whole). No ellipses: the client marks an excerpt.
 */
export function snippetOf(text: string, q: string): string {
  const source = text.slice(0, SNIPPET_SOURCE_MAX);
  const forms = queryForms(q);
  let at = -1;
  let end = -1;
  if (forms.length > 0) {
    for (const m of source.matchAll(RAW_WORD)) {
      const index = (normalize(m[0]).match(WORD) ?? []).flatMap((w) => searchVariants(w));
      const hit = forms.some((vs) => vs.some((v) => index.some((x) => x.startsWith(v))));
      if (hit) {
        at = m.index;
        end = m.index + m[0].length;
        break;
      }
    }
  }
  let start: number;
  let stop: number;
  if (at < 0) {
    start = 0;
    stop = toSpace(source, Math.min(source.length, BEFORE + AFTER), -1, 30);
  } else {
    start = at <= BEFORE ? 0 : toSpace(source, at - BEFORE, 1, 30);
    stop = end + AFTER >= source.length ? source.length : toSpace(source, end + AFTER, -1, 30);
  }
  return source.slice(start, stop).replace(/\s+/g, ' ').trim();
}

/**
 * The caller's visible locations, split by what their gate shows: where money is hidden
 * (receipts and invoices drop out) and where it shows (snippets are sent).
 */
async function moneySplit(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
): Promise<{ shown: string[]; hidden: string[] }> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM kept.visible_location_ids() AS v(id)',
  );
  const out = { shown: [] as string[], hidden: [] as string[] };
  for (const { id } of rows) {
    const gate = await gateFor(tx, id, scope);
    (gate.showMoney ? out.shown : out.hidden).push(id);
  }
  return out;
}

type DocumentHit = {
  attachment_id: string;
  file_id: string;
  location_id: string;
  role: AttachmentRole;
  subject_kind: DocumentSubjectKind;
  subject_id: string;
  subject_name: string | null;
};

/** Attachments whose file's text matches `terms`, best first. */
export async function searchDocuments(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  terms: Terms,
  opts: { location?: Many | undefined; limit: number },
): Promise<DocumentItem[]> {
  if (terms.raw === '') return [];

  // 1. The matching files, through the door, on the index. A separate statement, so the next
  //    one is planned for the ids' actual number (an attachments index probe per id), not for a
  //    set-returning function's guess (a scan of every visible attachment).
  const q = new Params();
  const one = singleLocation(opts.location);
  const loc = one ? `${q.add(one)}::uuid` : 'NULL::uuid';
  const { rows: hits } = await client.query<{ ids: string[] | null }>(
    `WITH ${termsCte(q, terms)}
     SELECT array(SELECT kept.search_file_ids((SELECT tsq FROM terms), ${loc})
                  UNION
                  SELECT kept.search_file_ids((SELECT ptsq FROM terms), ${loc})) AS ids`,
    q.values,
  );
  const ids = hits[0]?.ids ?? [];
  if (ids.length === 0) return [];

  // 2. Their attachments, as the caller sees them (the policies), best first.
  const money = await moneySplit(tx, client, scope);
  const p = new Params();
  const cte = termsCte(p, terms);
  const where = [
    `a.file_id = ANY (${p.add(ids)}::uuid[])`,
    `NOT (a.role = ANY (${p.add([...MONEY_ROLES])}::text[])
          AND a.location_id = ANY (${p.add(money.hidden)}::uuid[]))`,
    '(t.id IS NULL OR t.deleted_at IS NULL)',
    '(pl.id IS NULL OR pl.deleted_at IS NULL)',
    '(a.meter_reading_id IS NULL OR mt.deleted_at IS NULL)',
  ];
  if (opts.location?.values.length) {
    where.push(
      matchOf(`a.location_id = ANY (${p.add(opts.location.values)}::uuid[])`, opts.location.not),
    );
  }
  const { rows } = await client.query<DocumentHit>(
    `WITH ${cte}
     SELECT a.id AS attachment_id, a.file_id, a.location_id, a.role,
            CASE WHEN t.id IS NOT NULL THEN 'thing'
                 WHEN pl.id IS NOT NULL THEN 'place'
                 WHEN a.purchase_id IS NOT NULL THEN 'purchase'
                 WHEN a.meter_reading_id IS NOT NULL THEN 'meter_reading'
                 WHEN a.incident_id IS NOT NULL THEN 'incident'
                 ELSE 'location' END AS subject_kind,
            coalesce(t.id, pl.id, a.purchase_id, a.meter_reading_id, a.incident_id, a.location_id)
              AS subject_id,
            CASE WHEN t.id IS NOT NULL THEN t.name
                 WHEN pl.id IS NOT NULL THEN pl.name
                 WHEN a.purchase_id IS NOT NULL THEN v.name
                 WHEN a.meter_reading_id IS NOT NULL THEN mt.name
                 WHEN a.incident_id IS NOT NULL THEN NULL
                 ELSE l.name END AS subject_name
       FROM public.attachments a
       JOIN public.file_text x ON x.file_id = a.file_id
       CROSS JOIN terms
       LEFT JOIN public.warranties rw ON rw.id = a.warranty_id
       LEFT JOIN public.claims rc ON rc.id = a.claim_id
       LEFT JOIN public.loans ro ON ro.id = a.loan_id
       LEFT JOIN public.valuations rv ON rv.id = a.valuation_id
       LEFT JOIN public.service_records rs ON rs.id = a.service_record_id
       LEFT JOIN public.expiring_documents rd ON rd.id = a.expiring_document_id
       LEFT JOIN public.things t ON t.id = ${RECORD_THING}
       LEFT JOIN public.places pl ON pl.id = ${RECORD_PLACE} AND ${RECORD_THING} IS NULL
       LEFT JOIN public.purchases pu ON pu.id = a.purchase_id
       LEFT JOIN public.vendors v ON v.id = pu.vendor_id
       LEFT JOIN public.meter_readings mr ON mr.id = a.meter_reading_id
       LEFT JOIN public.meters me ON me.id = mr.meter_id
       LEFT JOIN public.things mt ON mt.id = me.thing_id
       LEFT JOIN public.locations l ON l.id = a.location_id
      WHERE ${where.join('\n AND ')}
      ORDER BY greatest(coalesce(ts_rank_cd(x.tsv, terms.tsq), 0),
                        coalesce(ts_rank_cd(x.tsv, terms.ptsq), 0)) DESC, a.id
      LIMIT ${p.add(opts.limit)}`,
    p.values,
  );

  // 3. The text, for this page's snippets only, and only where the caller sees money.
  const wanted = [
    ...new Set(rows.filter((r) => money.shown.includes(r.location_id)).map((r) => r.file_id)),
  ];
  const texts = new Map<string, string>();
  if (wanted.length > 0) {
    const { rows: t } = await client.query<{ file_id: string; text: string }>(
      `SELECT file_id, left(text, ${SNIPPET_SOURCE_MAX}) AS text FROM public.file_text
        WHERE file_id = ANY ($1::uuid[])`,
      [wanted],
    );
    for (const r of t) texts.set(r.file_id, r.text);
  }

  return rows.map((r) => ({
    attachmentId: r.attachment_id,
    fileId: r.file_id,
    locationId: r.location_id,
    subject: { kind: r.subject_kind, id: r.subject_id, name: r.subject_name },
    role: r.role,
    ...(money.shown.includes(r.location_id)
      ? { snippet: snippetOf(texts.get(r.file_id) ?? '', terms.raw) }
      : { moneyHidden: true as const }),
  }));
}
