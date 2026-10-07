import {
  type DerivedState,
  normalize,
  type SemanticState,
  searchVariants,
  type VendorKind,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { type DerivativeKeys, derivativeKeys } from '../files/views.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { filterOf, lowerIds, type Many } from '../http/list-filters.js';
import { requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { SIGNED_URL_TTL_SECONDS } from '../storage/signed-url.js';
import { type DocumentItem, searchDocuments } from './documents.js';
import {
  derivedStatesOf,
  didYouMean,
  type SearchQuery,
  searchPeople,
  searchPlaces,
  searchThings,
  searchVendors,
  type ThingCursor,
  type ThingFilters,
  type ThingHit,
  termsOf,
} from './query.js';
import { meaningCandidates, rrf, type SemanticInput } from './semantic.js';

// GET /api/v1/search (T20): the groups, paged and shaped as the web contract says
// (apps/web/src/api/inventory/types.ts, SearchResponse). Rows carry no money at all; the money
// filters only narrow things in locations where the caller's gate shows money. The `documents`
// group (T21, search/documents.ts) matches files' text; its snippets need the money gate.
//
// Semantic search (step-6 T14; D200, Q14): with the query's vectors from prepareSemantic() (taken
// before this transaction: no model call runs inside one, D166), the first page of things fuses
// the keyword ranking with the meaning ranking by reciprocal rank fusion (score = Σ 1/(k + rank),
// k = RRF_K). Every keyword row of the page stays; a thing found by meaning alone joins it when it
// outranks the page's weakest keyword row (anywhere, when the keywords have no more), at most
// `limit` of them, marked `matchedBy: 'meaning'`. A thing that matches the words but sits on a
// later keyword page is left to that page, so paging never repeats a row. The filters apply to
// meaning's rows as to the rest; later pages are keyword-only. `semantic` says why a search was
// keyword-only (paused, waiting, off, keyword_only), null when meaning was searched too.

/** Without `kind`, things get their first 20 and every other group its first 5. */
export const FIRST_THINGS = 20;
export const FIRST_OTHERS = 5;
/** With `kind` and no `limit`, a non-thing group answers up to this many ("Show all"). */
export const GROUP_MAX = 200;

export type PathStep = {
  id: string;
  name: string;
  kind: 'place' | 'container';
  isUnplaced: boolean;
  /** The step's primary short ID (D208, T19). */
  shortCode: string | null;
};

export type ThingRow = {
  id: string;
  locationId: string;
  shortCode: string | null;
  name: string | null;
  type: { id: string; icon: string; name: string | null; builtinKey: string | null } | null;
  quantity: number;
  lifecycle: string;
  derivedState: DerivedState[];
  path: PathStep[];
  containerThumbUrl: string | null;
  thumbUrl: string | null;
  lastSeenAt: string | null;
  isContainer: boolean;
  matchedAlias?: string;
  /** Found by meaning alone (T14): "matched by meaning". */
  matchedBy?: 'meaning';
};

export type SearchResult = {
  things: { items: ThingRow[]; next_cursor: string | null };
  places: {
    id: string;
    locationId: string;
    name: string;
    kindKey: string;
    icon: string | null;
    path: PathStep[];
  }[];
  people: { id: string; displayName: string; ownerAccountId: string }[];
  vendors: { id: string; name: string; kind: VendorKind; ownerAccountId: string }[];
  documents: { items: DocumentItem[] };
  didYouMean: string[];
  asOf: string;
  /** Why things were found by keywords only (T14, §7.15); null when meaning was searched too;
   * absent when meaning didn't apply (no query, one short word, a code). */
  semantic?: SemanticState | null;
};

const WORD = /[\p{L}\p{N}]+/gu;

/** Both search forms of every word of `text`. */
function indexOf(text: string): string[] {
  return (normalize(text).match(WORD) ?? []).flatMap((w) => searchVariants(w));
}

/** Every word of `q` prefixes some indexed form of `text`: the JS twin of the tsquery match,
 * used to say which alias a result matched through (screens §8). */
export function wordsMatch(text: string, q: string): boolean {
  const index = indexOf(text);
  const words = normalize(q).match(WORD) ?? [];
  return (
    words.length > 0 &&
    words.every((w) => searchVariants(w).some((v) => index.some((x) => x.startsWith(v))))
  );
}

/** The alias `q` matched when the name itself doesn't match ("matched: display cable"). */
export function matchedAliasOf(
  name: string | null,
  aliases: Record<string, unknown>,
  q: string,
): string | undefined {
  if (!q || wordsMatch(name ?? '', q)) return undefined;
  for (const list of Object.values(aliases ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const alias of list) {
      if (typeof alias === 'string' && wordsMatch(alias, q)) return alias;
    }
  }
  return undefined;
}

/** Derived as every thing list derives them (search/query.ts derivedStatesOf). */
const derivedStateOf = (h: ThingHit): DerivedState[] => derivedStatesOf(h);

const pathOf = (steps: ThingHit['path']): PathStep[] =>
  (steps ?? []).map((s) => ({
    id: s.id,
    name: s.name ?? '',
    kind: s.kind,
    isUnplaced: s.isUnplaced === true,
    shortCode: s.shortCode ?? null,
  }));

/** The derivative storage keys of the thumbnails `fileIds` name (nulls skipped), in one read as
 * the caller, for thumbUrlOf(). */
export function thumbKeysOf(
  client: pg.ClientBase,
  fileIds: readonly (string | null)[],
): Promise<DerivativeKeys> {
  return derivativeKeys(
    client,
    fileIds.filter((id): id is string => id !== null),
  );
}

/** A short-lived signed URL of a file's thumbnail (D157), from the key its derivative row names
 * (files/views.ts derivativeKeys()): a copy made by a cross-account move shares its source's
 * blobs (D161), and a file with no thumbnail (a PDF, a HEIC the server can't decode) has none.
 * Null then, and without storage. */
export async function thumbUrlOf(
  files: FileStorage | null,
  keys: DerivativeKeys,
  fileId: string | null,
): Promise<string | null> {
  const key = fileId ? keys.get(fileId)?.get('thumb') : undefined;
  if (!files || !key) return null;
  return files.blobs.signedUrl(key, {
    expiresIn: SIGNED_URL_TTL_SECONDS,
    disposition: 'inline',
    filename: 'thumb.jpg',
    contentType: 'image/jpeg',
  });
}

async function rowOf(
  files: FileStorage | null,
  keys: DerivativeKeys,
  h: ThingHit,
  q: string,
  byMeaning = false,
): Promise<ThingRow> {
  const alias = byMeaning ? undefined : matchedAliasOf(h.name, h.aliases, q);
  return {
    id: h.id,
    locationId: h.location_id,
    shortCode: h.short_code,
    name: h.name,
    type:
      h.type_id && h.type_icon
        ? {
            id: h.type_id,
            icon: h.type_icon,
            name: h.type_name,
            builtinKey: h.type_builtin_key,
          }
        : null,
    quantity: Number(h.quantity),
    lifecycle: h.lifecycle,
    derivedState: derivedStateOf(h),
    path: pathOf(h.path),
    containerThumbUrl: await thumbUrlOf(files, keys, h.container_thumb_file_id),
    thumbUrl: await thumbUrlOf(files, keys, h.thumb_file_id),
    lastSeenAt: h.last_seen_at ? new Date(h.last_seen_at).toISOString() : null,
    isContainer: h.is_container,
    ...(alias !== undefined ? { matchedAlias: alias } : {}),
    ...(byMeaning ? { matchedBy: 'meaning' as const } : {}),
  };
}

/**
 * The first page fused with meaning (see the header): the keyword page's rows, and the things
 * found by meaning alone that outrank its weakest row, in reciprocal-rank-fusion order.
 */
async function fuseMeaning(
  client: pg.ClientBase,
  filters: ThingFilters,
  semantic: SemanticInput,
  keyword: ThingHit[],
  hasMore: boolean,
  limit: number,
): Promise<{ items: ThingHit[]; meaning: Set<string> }> {
  const candidates = await meaningCandidates(client, semantic);
  if (candidates.length === 0) return { items: keyword, meaning: new Set() };
  const ids = candidates.map((c) => c.id);
  // Candidates that match the words too: ranked here when on this page, else left to theirs.
  const wordy = new Set(
    (await searchThings(client, { ...filters, ids }, { limit: ids.length, after: null })).map(
      (h) => h.id,
    ),
  );
  const onlyMeaning = ids.filter((id) => !wordy.has(id)).slice(0, limit);
  const meaningRows =
    onlyMeaning.length > 0
      ? await searchThings(
          client,
          { ...filters, terms: termsOf(''), ids: onlyMeaning },
          { limit: onlyMeaning.length, after: null },
        )
      : [];
  const semRank = new Map(candidates.map((c) => [c.id, c.rank]));
  const kwRank = new Map(keyword.map((h, i) => [h.id, i + 1]));
  const score = (id: string) => rrf(kwRank.get(id)) + rrf(semRank.get(id));
  const floor =
    hasMore && keyword.length > 0 ? Math.min(...keyword.map((h) => score(h.id))) : -Infinity;
  const extra = meaningRows.filter((h) => score(h.id) > floor);
  const order = (h: ThingHit) => kwRank.get(h.id) ?? (semRank.get(h.id) ?? 0) + keyword.length;
  const items = [...keyword, ...extra].sort(
    (a, b) => score(b.id) - score(a.id) || order(a) - order(b),
  );
  return { items, meaning: new Set(extra.map((h) => h.id)) };
}

const CursorKey = z.object({
  s: z.union([z.number(), z.string().max(400)]),
  id: z.uuid(),
});

function thingCursor(cursor: string | undefined, withQ: boolean): ThingCursor | null {
  if (!cursor) return null;
  const parsed = CursorKey.safeParse(decodeCursor(cursor));
  if (!parsed.success || typeof parsed.data.s !== (withQ ? 'number' : 'string')) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  return parsed.data;
}

/**
 * The locations, among those `query` covers (the visible ones, narrowed by the location filter),
 * where the caller sees money: the money filters apply there and nowhere else. Empty when no
 * money filter was asked for.
 */
async function moneyLocations(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  query: SearchQuery,
  location: Many | undefined,
): Promise<string[]> {
  if (!query.priceMin && !query.priceMax && !query.currency) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM kept.visible_location_ids() AS v(id)
      WHERE cardinality($1::uuid[]) = 0
         OR (CASE WHEN $2::boolean THEN id <> ALL ($1::uuid[]) ELSE id = ANY ($1::uuid[]) END)`,
    [location?.values ?? [], location?.not ?? false],
  );
  const out: string[] = [];
  for (const { id } of rows) {
    const gate = await gateFor(tx, id, scope);
    if (gate.showMoney) out.push(id);
  }
  return out;
}

export async function search(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  query: SearchQuery,
  /** The query's vectors (prepareSemantic(), taken before this transaction); none: keywords. */
  semantic?: SemanticInput | null,
): Promise<SearchResult> {
  // A location the caller can't see is a 404, as /trash and /activity answer it (review #36),
  // not an empty result that reads as "nothing there": any of them, "any of" or "none of".
  const locationIds = lowerIds(query.locationId);
  for (const id of locationIds) await requireMembership(client, id);
  const location = filterOf(locationIds, 'locationId', query.not);
  const terms = termsOf(query.q);
  const kind = query.kind;
  const withQ = terms.raw !== '';
  const wants = (k: NonNullable<SearchQuery['kind']>) => !kind || kind === k;
  const others = kind ? (query.limit ?? GROUP_MAX) : FIRST_OTHERS;

  let things: SearchResult['things'] = { items: [], next_cursor: null };
  if (wants('things')) {
    const limit = query.limit ?? FIRST_THINGS;
    const money = await moneyLocations(tx, client, scope, query, location);
    const filters: ThingFilters = {
      terms,
      location,
      place: filterOf(lowerIds(query.placeId), 'placeId', query.not),
      type: filterOf(lowerIds(query.typeId), 'typeId', query.not),
      tag: filterOf(lowerIds(query.tagId), 'tagId', query.not),
      state: filterOf(query.state, 'state', query.not),
      ...(money.length > 0
        ? {
            money: {
              locations: money,
              min: query.priceMin,
              max: query.priceMax,
              currency: query.currency,
            },
          }
        : {}),
    };
    const hits = await searchThings(client, filters, {
      limit,
      after: thingCursor(query.cursor, withQ),
    });
    const page = hits.slice(0, limit);
    const last = page.at(-1);
    const fused =
      semantic && semantic.groups.length > 0 && withQ && !query.cursor
        ? await fuseMeaning(client, filters, semantic, page, hits.length > limit, limit)
        : { items: page, meaning: new Set<string>() };
    const items = fused.items;
    const keys = files
      ? await thumbKeysOf(
          client,
          items.flatMap((h) => [h.thumb_file_id, h.container_thumb_file_id]),
        )
      : new Map();
    things = {
      items: await Promise.all(
        items.map((h) => rowOf(files, keys, h, terms.raw, fused.meaning.has(h.id))),
      ),
      next_cursor: hits.length > limit && last ? encodeCursor({ s: last.s, id: last.id }) : null,
    };
  }

  const opts = { location, limit: others };
  const places = wants('places') ? await searchPlaces(client, terms, opts) : [];
  const people = wants('people') ? await searchPeople(client, terms, opts) : [];
  const vendors = wants('vendors') ? await searchVendors(client, terms, opts) : [];
  const documents = wants('documents') ? await searchDocuments(tx, client, scope, terms, opts) : [];

  const nothing =
    things.items.length + places.length + people.length + vendors.length + documents.length === 0;
  const suggestions =
    nothing && withQ && !query.cursor ? await didYouMean(client, terms, { location }) : [];

  return {
    things,
    places: places.map((pl) => ({
      id: pl.id,
      locationId: pl.location_id,
      name: pl.name,
      kindKey: pl.kind_key,
      icon: pl.icon,
      path: pathOf(pl.path),
    })),
    people: people.map((x) => ({
      id: x.id,
      displayName: x.display_name,
      ownerAccountId: x.owner_account_id,
    })),
    vendors: vendors.map((x) => ({
      id: x.id,
      name: x.name,
      kind: x.kind,
      ownerAccountId: x.owner_account_id,
    })),
    documents: { items: documents },
    didYouMean: suggestions,
    asOf: new Date().toISOString(),
    ...(semantic && wants('things') ? { semantic: semantic.state } : {}),
  };
}
