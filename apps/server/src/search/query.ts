import {
  DERIVED_STATES,
  type DerivedState,
  isShortCode,
  normaliseInputCode,
  normalize,
  tsQuery,
  type VendorKind,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { PAGE_MAX } from '../http/conventions.js';
import { type Many, manyOf, matchOf, notOf } from '../http/list-filters.js';
import { legacyCodeOf } from '../imports/csv.js';

// The search SQL (T20; engineering spec §7.9; D42, screens spec §8). Everything here runs on the
// request's kept_app transaction, so row-level security decides what exists: a thing, place,
// person or vendor the caller can't see is never a candidate, and so never a result, a
// did-you-mean or a count.
//
// What matches a thing (`search_tsv`, built by kept.thing_search_doc()): name and aliases,
// model, serial, barcode, brand, type, tags, notes, colour, where it is, whose it is, and scalar
// custom values. Money never enters the document (it is `{amount, currency}` in `custom`, and
// purchase prices live in their own tables), and secret values live in secret_values, so
// neither can ever match.
//
// A query matches when any of these hold:
// - `tsQuery(q)` from @kept/shared (each word `(normalised:* | stripped:*)`, words ANDed), the
//   JS twin the phone uses offline;
// - the same built from Postgres' own parser over kept.normalize(q), so tokens the parser keeps
//   whole (`2.1`, `-12345`, `/ab` in `HDMI 2.1` or `SN-12345/AB`) are matched as the document
//   stored them: the JS twin splits them into words the document never had;
// - a trigram match of the normalised name (pg_trgm's default threshold, 0.3);
// - the normalised serial, exactly;
// - a 6-character Crockford code of the thing (any of its codes), which also ranks first;
// - a legacy or own code of the thing, typed whole (T17a, D146, D208), which ranks first too.
//
// The first four are matched by kept.search_thing_ids() (migration 0030, task 24): under RLS
// neither `@@` nor `%` is leakproof, so a query on kept_app can't use their indexes and reads
// every visible thing; the door runs the match on the indexes and applies the caller's
// visibility itself, and the rows are then read here, through the policies, by id.

export const SEARCH_STATES = [...DERIVED_STATES, 'to_review', 'long_unseen', 'unplaced'] as const;
export type SearchState = (typeof SEARCH_STATES)[number];
export const SEARCH_KINDS = ['things', 'places', 'people', 'vendors', 'documents'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

const Decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'a decimal amount, e.g. 1250.50');

/** The filters of GET /search that take several values and "is none of" (D205). */
export const SEARCH_FILTERS = ['locationId', 'placeId', 'typeId', 'tagId', 'state'] as const;

/** The querystring of GET /search. A saved view keeps the web's list state instead
 * (saved-views.ts, @kept/shared SavedListQuery). */
export const SearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  locationId: manyOf(z.uuid()).optional(),
  placeId: manyOf(z.uuid()).optional(),
  typeId: manyOf(z.uuid()).optional(),
  tagId: manyOf(z.uuid()).optional(),
  state: manyOf(z.enum(SEARCH_STATES)).optional(),
  not: notOf(SEARCH_FILTERS).optional(),
  kind: z.enum(SEARCH_KINDS).optional(),
  /** Money filters (screens §5): ignored, silently, where the caller can't see money. */
  priceMin: Decimal.optional(),
  priceMax: Decimal.optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).optional(),
  cursor: z.string().max(2048).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

// ---------------------------------------------------------------------------------------------

/** Positional parameters for one statement. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The normalised search inputs derived from `q`. */
export type Terms = {
  /** The query as typed (trimmed); '' for none. */
  raw: string;
  /** kept.normalize()'s twin of `raw`. */
  normalized: string;
  /** tsQuery(raw), or null when it has no word. */
  jsTsq: string | null;
  /** A short code the query could be (normalised), or null. */
  code: string | null;
  /** The query as a legacy or own code is stored (`upper(btrim())`, D146, D208), or null. */
  legacy: string | null;
};

export function termsOf(q: string | undefined): Terms {
  const raw = (q ?? '').trim();
  const folded = normaliseInputCode(raw);
  return {
    raw,
    normalized: normalize(raw),
    jsTsq: tsQuery(raw),
    code: isShortCode(folded) ? folded : null,
    legacy: raw && raw.length <= 100 ? legacyCodeOf(raw) : null,
  };
}

/**
 * A CTE `terms(tsq, ptsq, nq, code)`: the JS tsquery, the parser-built one, the normalised text
 * and the short code. The parser-built query quotes every lexeme (doubling quotes and
 * backslashes), so nothing typed can become tsquery syntax.
 */
export function termsCte(p: Params, t: Terms): string {
  const raw = p.add(t.raw);
  return `terms AS (
    SELECT CASE WHEN ${p.add(t.jsTsq)}::text IS NULL THEN NULL
                ELSE to_tsquery('simple', ${p.add(t.jsTsq)}::text) END AS tsq,
           (SELECT string_agg(CASE WHEN s <> l THEN '(' || ql || ' | ' || qs || ')' ELSE ql END,
                              ' & ')::tsquery
              FROM (SELECT l, s,
                           '''' || replace(replace(l, '\\', '\\\\'), '''', '''''') || ''':*' AS ql,
                           '''' || replace(replace(s, '\\', '\\\\'), '''', '''''') || ''':*' AS qs
                      FROM unnest(tsvector_to_array(
                             to_tsvector('simple', kept.normalize(${raw}::text)))) l,
                           LATERAL kept.strip_prefixes(l) s) x) AS ptsq,
           kept.normalize(${raw}::text) AS nq,
           ${p.add(t.code)}::text AS code,
           ${p.add(t.legacy)}::text AS legacy
  )`;
}

/** A document matches the typed words (either tsquery). */
const docMatches = (doc: string) =>
  `((terms.tsq IS NOT NULL AND ${doc} @@ terms.tsq) OR (terms.ptsq IS NOT NULL AND ${doc} @@ terms.ptsq))`;

/** The text score of a document: the better of the two tsqueries. */
const docRank = (doc: string) =>
  `greatest(coalesce(ts_rank_cd(${doc}, terms.tsq), 0), coalesce(ts_rank_cd(${doc}, terms.ptsq), 0))::float8`;

// ---------------------------------------------------------------------------------------------
// Things
// ---------------------------------------------------------------------------------------------

/** The one location a filter is "any of", when there is exactly one: the index doors
 * (kept.search_thing_ids, kept.near_thing_names) take one location, or none. */
export const singleLocation = (f: Many | undefined): string | null =>
  f && !f.not && f.values.length === 1 ? (f.values[0] ?? null) : null;

export type ThingFilters = {
  terms: Terms;
  location?: Many | undefined;
  place?: Many | undefined;
  type?: Many | undefined;
  tag?: Many | undefined;
  state?: Many<SearchState> | undefined;
  /** Only these things (semantic search's candidates, T14): the other filters still apply. */
  ids?: readonly string[];
  /** Applied only in `locations`; absent when the caller sees money in none of them. */
  money?: {
    locations: string[];
    min?: string | undefined;
    max?: string | undefined;
    currency?: string | undefined;
  };
};

/** With a query: `{s: score, id}`, highest first. Without: `{s: lower(name), id}`, A to Z. */
export type ThingCursor = { s: number | string; id: string };

export type ThingHit = {
  id: string;
  location_id: string;
  name: string | null;
  quantity: string;
  lifecycle: string;
  location_uncertain: boolean;
  review_state: string;
  in_repair: boolean;
  loan_direction: 'out' | 'in' | null;
  last_seen_at: Date | null;
  aliases: Record<string, unknown>;
  path: {
    id: string;
    name: string | null;
    kind: 'place' | 'container';
    isUnplaced: boolean;
    shortCode?: string | null;
  }[];
  short_code: string | null;
  type_id: string | null;
  type_icon: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  thumb_file_id: string | null;
  container_thumb_file_id: string | null;
  is_container: boolean;
  /** The sort key the cursor resumes from. */
  s: number | string;
};

/** The first photo of `thing` that has a thumbnail (D195). */
const firstThumb = (thing: string) => `(
  SELECT a.file_id FROM public.attachments a
    JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
   WHERE a.thing_id = ${thing} AND a.role = 'photo'
   ORDER BY a.sort, a.created_at, a.id LIMIT 1)`;

/** A breadcrumb from kept.path_of(), each place step marked when it is the Unplaced area, and
 * each step with its primary short ID (null before one is assigned), so a breadcrumb links by
 * code (D208; step-3 carry-over, T19). */
export const pathSql = (place: string, container: string) => `(
  SELECT coalesce(jsonb_agg(e || jsonb_build_object(
           'isUnplaced',
           coalesce((SELECT pl.is_unplaced FROM public.places pl
                      WHERE e->>'kind' = 'place' AND pl.id = (e->>'id')::uuid), false),
           'shortCode',
           (SELECT s.code FROM public.short_ids s
             WHERE s.is_primary AND s.state = 'assigned'
               AND CASE WHEN e->>'kind' = 'place' THEN s.place_id = (e->>'id')::uuid
                        ELSE s.thing_id = (e->>'id')::uuid END
             LIMIT 1))
         ORDER BY n), '[]'::jsonb)
    FROM jsonb_array_elements(kept.path_of(${place}, ${container})) WITH ORDINALITY AS x(e, n))`;

/** Whether `thing` is a container (ThingRow.isContainer, T25 decision 3): its type has the
 * container capability, or something live is inside it. One rule for every thing row. */
export const isContainerSql = (thing: string, type: string) =>
  `(coalesce('container' = ANY (kept.type_capabilities(${type})), false)
    OR EXISTS (SELECT 1 FROM public.things c
                WHERE c.container_id = ${thing} AND c.deleted_at IS NULL))`;

/** SQL: a claim of thing `t` (a table alias) is in repair (T9; D54: at most one is). */
const IN_REPAIR_SQL = (t: string) =>
  `EXISTS (SELECT 1 FROM public.claims c WHERE c.thing_id = ${t}.id AND c.status = 'in_repair')`;

/** SQL: thing `t` has an open loan in `direction` (one open loan per thing, §7.13). */
const OPEN_LOAN_SQL = (t: string, direction: 'out' | 'in') =>
  `EXISTS (SELECT 1 FROM public.loans o
            WHERE o.thing_id = ${t}.id AND o.returned_at IS NULL AND o.direction = '${direction}')`;

export const STATE_SQL: Record<SearchState, string> = {
  uncertain: 't.location_uncertain',
  draft: `t.review_state = 'draft'`,
  ended: `t.lifecycle <> 'in_use'`,
  // Home's attention rows (T29): readings to review, not seen for the location's
  // long_unseen_months, and things in the Unplaced area.
  to_review: `EXISTS (SELECT 1 FROM public.meters m
                        JOIN public.meter_readings r ON r.meter_id = m.id
                       WHERE m.thing_id = t.id AND r.state = 'needs_review')`,
  long_unseen: `t.lifecycle = 'in_use' AND EXISTS (
                  SELECT 1 FROM public.locations l
                   WHERE l.id = t.location_id
                     AND t.last_seen_at < now() - make_interval(months => l.long_unseen_months))`,
  unplaced: `EXISTS (SELECT 1 FROM public.places pl WHERE pl.id = t.place_id AND pl.is_unplaced)`,
  // T10 (D56, D57, D119): an open loan of the thing, out or in.
  lent: OPEN_LOAN_SQL('t', 'out'),
  borrowed: OPEN_LOAN_SQL('t', 'in'),
  // T9 (D54): a claim of the thing is in repair.
  in_repair: IN_REPAIR_SQL('t'),
};

/**
 * The flags a thing row's derived states are read from (@kept/shared DERIVED_STATES): its own
 * columns, and the step-4 ones householdStateSql() selects. Every thing list (things/view.ts,
 * search, a place's contents) derives them here, so they agree.
 */
export type StateFlags = {
  location_uncertain: boolean;
  review_state: string;
  lifecycle: string;
  /** T9: a claim is in repair (householdStateSql). */
  in_repair?: boolean | null;
  /** T10: the direction of the open loan, if any (householdStateSql). */
  loan_direction?: 'out' | 'in' | null;
};

export function derivedStatesOf(r: StateFlags): DerivedState[] {
  const out: DerivedState[] = [];
  if (r.location_uncertain) out.push('uncertain');
  if (r.review_state === 'draft') out.push('draft');
  if (r.lifecycle !== 'in_use') out.push('ended');
  if (r.loan_direction === 'out') out.push('lent');
  if (r.loan_direction === 'in') out.push('borrowed');
  if (r.in_repair) out.push('in_repair');
  return out;
}

/** SQL: the step-4 state columns of thing `t` (a table alias) that derivedStatesOf() reads. */
export function householdStateSql(t: string): string {
  return `${IN_REPAIR_SQL(t)} AS in_repair,
    (SELECT o.direction FROM public.loans o
      WHERE o.thing_id = ${t}.id AND o.returned_at IS NULL LIMIT 1) AS loan_direction`;
}

/** One page of things, `limit + 1` rows (the extra one says there is more). */
export async function searchThings(
  client: pg.ClientBase,
  f: ThingFilters,
  page: { limit: number; after: ThingCursor | null },
): Promise<ThingHit[]> {
  const p = new Params();
  const withQ = f.terms.raw !== '';
  const ctes = [termsCte(p, f.terms)];
  const where = ['t.deleted_at IS NULL'];

  // Each filter "is any of" its values, or "is none of" them (D205): a thing with no type or no
  // tag is "none of" any (http/list-filters.ts matchOf).
  if (f.location?.values.length) {
    where.push(
      matchOf(`t.location_id = ANY (${p.add(f.location.values)}::uuid[])`, f.location.not),
    );
  }
  if (f.ids) where.push(`t.id = ANY (${p.add([...f.ids])}::uuid[])`);
  if (f.type?.values.length) {
    where.push(matchOf(`t.type_id = ANY (${p.add(f.type.values)}::uuid[])`, f.type.not));
  }
  if (f.tag?.values.length) {
    where.push(
      matchOf(
        `EXISTS (SELECT 1 FROM public.thing_tags g
                  WHERE g.thing_id = t.id AND g.tag_id = ANY (${p.add(f.tag.values)}::uuid[]))`,
        f.tag.not,
      ),
    );
  }
  if (f.state?.values.length) {
    where.push(matchOf(`(${f.state.values.map((s) => STATE_SQL[s]).join(' OR ')})`, f.state.not));
  }
  if (f.place?.values.length) {
    // The whole subtree of each place (or of a container, given its id), and everything inside
    // the containers within it, however deep: in one of them, or in none.
    const roots = p.add(f.place.values);
    ctes.unshift(`RECURSIVE sub(id) AS (
        SELECT pl.id FROM public.places pl WHERE pl.id = ANY (${roots}::uuid[])
        UNION
        SELECT c.id FROM public.places c JOIN sub ON c.parent_id = sub.id
      ),
      inside(id) AS (
        SELECT x.id FROM public.things x
         WHERE x.place_id IN (SELECT id FROM sub) OR x.container_id = ANY (${roots}::uuid[])
        UNION
        SELECT x.id FROM public.things x JOIN inside i ON x.container_id = i.id
      )`);
    where.push(
      f.place.not ? 't.id NOT IN (SELECT id FROM inside)' : 't.id IN (SELECT id FROM inside)',
    );
  }
  if (f.money && f.money.locations.length > 0) {
    const m = f.money;
    const cond: string[] = [];
    if (m.min) cond.push(`tp.unit_price >= ${p.add(m.min)}::numeric`);
    if (m.max) cond.push(`tp.unit_price <= ${p.add(m.max)}::numeric`);
    if (m.currency) cond.push(`tp.currency = ${p.add(m.currency)}::text`);
    if (cond.length > 0) {
      where.push(`(t.location_id <> ALL (${p.add(m.locations)}::uuid[])
                   OR EXISTS (SELECT 1 FROM kept.thing_purchase(t.id) tp
                               WHERE ${cond.join(' AND ')}))`);
    }
  }

  // A short ID, or a legacy or own code of the thing typed whole (D146, D208).
  const codeHit = `(t.id IN (SELECT s.thing_id FROM public.short_ids s
                              WHERE s.code = terms.code AND s.state = 'assigned')
                    OR t.id IN (SELECT g.thing_id FROM public.legacy_codes g
                                 WHERE g.code = terms.legacy))`;
  let score: string;
  if (withQ) {
    // The text match through the index door (see the header), and the code match: one IN, so
    // the planner joins the few ids to things by primary key. The door's arguments are scalar
    // subqueries of `terms`, evaluated once, never per row. The door takes one location: any
    // other location filter narrows the rows above.
    const one = singleLocation(f.location);
    const loc = one ? `${p.add(one)}::uuid` : 'NULL::uuid';
    where.push(`t.id IN (
                  SELECT kept.search_thing_ids((SELECT tsq FROM terms), (SELECT ptsq FROM terms),
                                               (SELECT nq FROM terms), ${loc})
                  UNION ALL
                  SELECT s.thing_id FROM public.short_ids s
                   WHERE s.code = (SELECT code FROM terms) AND s.state = 'assigned'
                  UNION ALL
                  SELECT g.thing_id FROM public.legacy_codes g
                   WHERE g.code = (SELECT legacy FROM terms) AND g.thing_id IS NOT NULL)`);
    score = `(CASE WHEN (terms.code IS NOT NULL OR terms.legacy IS NOT NULL) AND ${codeHit}
                   THEN 100 ELSE 0 END
              + ${docRank('t.search_tsv')}
              + 0.5::float8 * similarity(kept.normalize(coalesce(t.name, '')), terms.nq)::float8)`;
  } else {
    score = `lower(coalesce(t.name, ''))`;
  }

  let after = '';
  if (page.after) {
    const s = p.add(page.after.s);
    const id = p.add(page.after.id);
    after = withQ
      ? `WHERE (m.s < ${s}::float8 OR (m.s = ${s}::float8 AND m.id > ${id}::uuid))`
      : `WHERE (m.s > ${s}::text OR (m.s = ${s}::text AND m.id > ${id}::uuid))`;
  }
  const order = withQ ? 'm.s DESC, m.id' : 'm.s, m.id';
  const text = `WITH ${ctes.join(',\n')},
    matched AS (
      SELECT t.id, ${score} AS s FROM public.things t, terms WHERE ${where.join('\n AND ')}
    ),
    page AS (SELECT m.id, m.s FROM matched m ${after} ORDER BY ${order} LIMIT ${p.add(page.limit + 1)})
    SELECT t.id, t.location_id, t.name, t.quantity::text AS quantity, t.lifecycle,
           t.location_uncertain, t.review_state, t.last_seen_at, t.aliases,
           ${pathSql('t.place_id', 't.container_id')} AS path,
           (SELECT s.code FROM public.short_ids s
             WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1) AS short_code,
           ty.id AS type_id, ty.icon AS type_icon, ty.name AS type_name,
           ty.builtin_key AS type_builtin_key,
           ${firstThumb('t.id')} AS thumb_file_id,
           CASE WHEN t.container_id IS NULL THEN NULL ELSE ${firstThumb('t.container_id')} END
             AS container_thumb_file_id,
           ${isContainerSql('t.id', 't.type_id')} AS is_container,
           ${householdStateSql('t')},
           m.s
      FROM page m
      JOIN public.things t ON t.id = m.id
      LEFT JOIN public.types ty ON ty.id = t.type_id
     ORDER BY ${order}`;
  const { rows } = await client.query<ThingHit>(text, p.values);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Places, people, vendors
// ---------------------------------------------------------------------------------------------

export type PlaceHit = {
  id: string;
  location_id: string;
  name: string;
  kind_key: string;
  icon: string | null;
  path: ThingHit['path'];
};

/** Places whose name matches (never the Unplaced area), best first. */
export async function searchPlaces(
  client: pg.ClientBase,
  terms: Terms,
  opts: { location?: Many | undefined; limit: number },
): Promise<PlaceHit[]> {
  if (terms.raw === '') return [];
  const p = new Params();
  const cte = termsCte(p, terms);
  const doc = `to_tsvector('simple', kept.search_text(pl.name))`;
  const loc = opts.location?.values.length
    ? `AND ${matchOf(`pl.location_id = ANY (${p.add(opts.location.values)}::uuid[])`, opts.location.not)}`
    : '';
  const codeHit = `(pl.id IN (SELECT s.place_id FROM public.short_ids s
                               WHERE s.code = terms.code AND s.state = 'assigned')
                     OR pl.id IN (SELECT g.place_id FROM public.legacy_codes g
                                   WHERE g.code = terms.legacy))`;
  const { rows } = await client.query<PlaceHit>(
    `WITH ${cte}
     SELECT pl.id, pl.location_id, pl.name, pl.kind_key, pl.icon,
            ${pathSql('pl.parent_id', 'NULL::uuid')} AS path
       FROM public.places pl, terms
      WHERE pl.deleted_at IS NULL AND NOT pl.is_unplaced ${loc}
        AND (${docMatches(doc)} OR kept.normalize(pl.name) % terms.nq
             OR ((terms.code IS NOT NULL OR terms.legacy IS NOT NULL) AND ${codeHit}))
      ORDER BY (CASE WHEN (terms.code IS NOT NULL OR terms.legacy IS NOT NULL) AND ${codeHit}
                     THEN 100 ELSE 0 END
                + ${docRank(doc)}
                + 0.5::float8 * similarity(kept.normalize(pl.name), terms.nq)::float8) DESC, pl.id
      LIMIT ${p.add(opts.limit)}`,
    p.values,
  );
  return rows;
}

export type PersonHit = { id: string; display_name: string; owner_account_id: string };
export type VendorHit = { id: string; name: string; kind: VendorKind; owner_account_id: string };

/** People or vendors of the accounts the caller can see (their policies), best first. With a
 * location filter, only those of the filtered locations' owner accounts (or, "none of", of
 * other accounts). */
async function searchRegistry<T>(
  client: pg.ClientBase,
  table: 'people' | 'vendors',
  terms: Terms,
  opts: { location?: Many | undefined; limit: number },
): Promise<T[]> {
  if (terms.raw === '') return [];
  const p = new Params();
  const cte = termsCte(p, terms);
  const name = table === 'people' ? 'r.display_name' : 'r.name';
  const cols =
    table === 'people'
      ? 'r.id, r.display_name, r.owner_account_id'
      : 'r.id, r.name, r.kind, r.owner_account_id';
  const doc = `to_tsvector('simple', kept.search_text(${name}))`;
  const loc = opts.location?.values.length
    ? `AND ${matchOf(
        `r.owner_account_id IN (SELECT l.owner_account_id FROM public.locations l
                                 WHERE l.id = ANY (${p.add(opts.location.values)}::uuid[]))`,
        opts.location.not,
      )}`
    : '';
  const { rows } = await client.query(
    `WITH ${cte}
     SELECT ${cols} FROM public.${table} r, terms
      WHERE (${docMatches(doc)} OR kept.normalize(${name}) % terms.nq) ${loc}
      ORDER BY (${docRank(doc)} + 0.5::float8 * similarity(kept.normalize(${name}), terms.nq)::float8) DESC,
               r.id
      LIMIT ${p.add(opts.limit)}`,
    p.values,
  );
  return rows as T[];
}

export const searchPeople = (
  client: pg.ClientBase,
  terms: Terms,
  opts: { location?: Many | undefined; limit: number },
) => searchRegistry<PersonHit>(client, 'people', terms, opts);

export const searchVendors = (
  client: pg.ClientBase,
  terms: Terms,
  opts: { location?: Many | undefined; limit: number },
) => searchRegistry<VendorHit>(client, 'vendors', terms, opts);

// ---------------------------------------------------------------------------------------------
// Did you mean
// ---------------------------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}]+/gu;

/** The most query words "did you mean" varies, and the longest (security review #32). */
export const NEAR_MAX_WORDS = 6;
export const NEAR_MAX_LETTERS = 32;

/**
 * Words one edit away from each query word, for did-you-mean. Trigrams can't see a swapped pair
 * in a short word (`hmdi` and `hdmi` share one trigram of nine), so this looks for names with a
 * word at edit distance one: deletions and adjacent swaps as literals, and, for words of four
 * letters or more, substitutions and insertions as LIKE patterns (`_` is any one character;
 * words hold only letters and digits, so nothing else in them is a LIKE wildcard).
 */
export function nearWords(q: string): { literals: string[]; patterns: string[] } {
  const literals = new Set<string>();
  const patterns = new Set<string>();
  // Bounded (security review #32): each word of n letters makes ~4n variants that every visible
  // name's words are compared against, so only the first NEAR_MAX_WORDS words of 3 to
  // NEAR_MAX_LETTERS letters count; a longer word is no typo of a name.
  const words = (normalize(q).match(WORD) ?? [])
    .filter((word) => {
      const n = Array.from(word).length;
      return n >= 3 && n <= NEAR_MAX_LETTERS;
    })
    .slice(0, NEAR_MAX_WORDS);
  for (const word of words) {
    const w = Array.from(word);
    for (let i = 0; i < w.length; i++) {
      literals.add([...w.slice(0, i), ...w.slice(i + 1)].join(''));
      if (i + 1 < w.length && w[i] !== w[i + 1]) {
        literals.add([...w.slice(0, i), w[i + 1], w[i], ...w.slice(i + 2)].join(''));
      }
      if (w.length >= 4) {
        patterns.add([...w.slice(0, i), '_', ...w.slice(i + 1)].join(''));
        patterns.add([...w.slice(0, i), '_', ...w.slice(i)].join(''));
      }
    }
    patterns.add(`${word}_`);
    literals.delete(word);
  }
  return { literals: [...literals], patterns: [...patterns] };
}

/**
 * Up to three names close to `q`, for a search that found nothing: things and places whose name
 * has a word one edit from a query word first, then names by trigram similarity at 0.25 (plan
 * T20). Only names the caller can see.
 */
export async function didYouMean(
  client: pg.ClientBase,
  terms: Terms,
  opts: { location?: Many | undefined },
): Promise<string[]> {
  if (terms.raw === '') return [];
  await client.query(`SELECT set_config('pg_trgm.similarity_threshold', '0.25', true)`);
  const p = new Params();
  const nq = p.add(terms.normalized);
  const near = nearWords(terms.raw);
  const lits = p.add(near.literals);
  const pats = p.add(near.patterns);
  // The door takes one location or none: a filter of several (or "none of") asks it once per
  // location the filter leaves, at most MAX_FILTER_VALUES, or every visible one but those.
  const f = opts.location?.values.length ? opts.location : null;
  const locs = f ? p.add(f.values) : null;
  const doorLocations = !f
    ? '(SELECT NULL::uuid) AS l(v)'
    : f.not
      ? `(SELECT v FROM kept.visible_location_ids() AS v
           WHERE v <> ALL (${locs}::uuid[])) AS l(v)`
      : `unnest(${locs}::uuid[]) AS l(v)`;
  const placeLoc = f ? `AND ${matchOf(`pl.location_id = ANY (${locs}::uuid[])`, f.not)}` : '';
  const isNear = (name: string) => `EXISTS (
      SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('simple', kept.normalize(${name})))) w
       WHERE w = ANY (${lits}::text[]) OR w LIKE ANY (${pats}::text[]))`;
  // Things through kept.near_thing_names() (migration 0030, task 24): the same two arms on the
  // indexes, with the near words taken from the names' and aliases' lexemes instead of
  // normalising every visible name; places, a few hundred at most, as they are.
  const { rows } = await client.query<{ name: string }>(
    `WITH cand AS (
       SELECT n.name, n.near, n.sim
         FROM ${doorLocations}
        CROSS JOIN LATERAL kept.near_thing_names(${nq}::text, ${lits}::text[], ${pats}::text[],
                                                 l.v) n
       UNION ALL
       SELECT pl.name, ${isNear('pl.name')},
              similarity(kept.normalize(pl.name), ${nq}::text)
         FROM public.places pl
        WHERE pl.deleted_at IS NULL AND NOT pl.is_unplaced
          ${placeLoc}
          AND (kept.normalize(pl.name) % ${nq}::text OR ${isNear('pl.name')})
     )
     SELECT name FROM (
       SELECT DISTINCT ON (name) name, near, sim FROM cand ORDER BY name, near DESC, sim DESC
     ) best
     ORDER BY near DESC, sim DESC, name
     LIMIT 3`,
    p.values,
  );
  return rows.map((r) => r.name);
}
