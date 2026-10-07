import { randomUUID } from 'node:crypto';
import {
  isShortCode,
  normaliseInputCode,
  normalize,
  RRF_K,
  SEMANTIC_LIMIT,
  type SemanticState,
} from '@kept/shared';
import type pg from 'pg';
import { FOREVER } from '../ai/breaker.js';
import { embedValues } from '../ai/call.js';
import type { Resolved } from '../ai/ports.js';
import type { AiDeps } from '../ai/routes.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import {
  embeddingsSource,
  modelKeyOf,
  requestedDims,
  vectorLiteral,
} from '../embeddings/provider.js';

// Semantic search's query side (D200, D206, D207; step-6 plan T14, Q13, Q14; §7.15).
//
// Two halves, because a model call never runs inside a transaction (D166):
// 1. prepareSemantic(), **before** the search's transaction: for the locations searched, the
//    `embeddings` provider each resolves to (the location's cascade, as the person), grouped by
//    payer and model; the query embedded **once per group** (`embed_query`, one ledger row each,
//    D206's table). Never a chat call (D200). A cap, a provider's wait or embeddings being off
//    answer a `state` instead, and search runs on keywords (§7.15: "Semantic search paused ·
//    keyword results"). Locations with no embeddings model anywhere in their cascade are
//    keyword-only (Groq has none).
// 2. meaningCandidates(), inside search() (search/service.ts): `kept.semantic_thing_ids` per group
//    (the only way to a semantic match, §7.2), nearest first, cut at SEMANTIC_MAX_DISTANCE, then
//    fused with the keyword ranking by reciprocal rank fusion (rrf(), k = RRF_K, Q14).
//
// The query isn't embedded when keywords win anyway: one short word, a short code, or a string
// shaped like a serial or a model number.

/** One query vector per payer and model, with the locations it searches. */
export type SemanticGroup = { modelKey: string; locationIds: string[]; vector: number[] };

/** What prepareSemantic() hands search(). `state` is null when meaning was searched. */
export type SemanticInput = { groups: SemanticGroup[]; state: SemanticState | null };

export type SemanticDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  ai: AiDeps | null | undefined;
  log?: { warn?: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

/** Prepares meaning for one query as `scope`, over `locationIds` (all visible when null). */
export type SemanticPrep = (
  scope: Scope,
  q: string | undefined,
  filter?: { locationIds: readonly string[]; not?: boolean } | null,
) => Promise<SemanticInput | null>;

/**
 * Cosine distance past which a vector match isn't a match (an exact scan always answers its 50
 * nearest, related or not). **Inferred, not measured:** text-embedding-3-small and
 * gemini-embedding-001 put unrelated short texts at about 0.75–0.9 and related ones under 0.6;
 * T17's `eval:search` on a real key is what settles it (docs/evals).
 */
export const SEMANTIC_MAX_DISTANCE = 0.65;

/** A query shorter than this (one word) is left to keywords. */
const SHORT_WORD = 4;
const WORD = /[\p{L}\p{N}]+/gu;
/** A code, serial or model number: letters and digits run together, at least one digit. */
const CODE_SHAPED = /^(?=.*\d)[\p{L}\p{N}][\p{L}\p{N}./_-]{3,}$/u;

/** Whether `q` is worth a query embedding (plan T14: not one short word, a code or a serial). */
export function wantsMeaning(q: string | undefined): boolean {
  const raw = (q ?? '').trim();
  if (!raw) return false;
  if (isShortCode(normaliseInputCode(raw))) return false;
  if (!/\s/.test(raw) && CODE_SHAPED.test(raw)) return false;
  const words = normalize(raw).match(WORD) ?? [];
  if (words.length === 0) return false;
  if (words.length === 1) {
    const [w] = words as [string];
    if ([...w].length < SHORT_WORD) return false;
    if (CODE_SHAPED.test(raw.replace(/\s+/g, ''))) return false;
  }
  return true;
}

/** The locations searched: the visible ones, narrowed by the location filter. */
async function searchedLocations(
  deps: SemanticDeps,
  scope: Scope,
  filter: { locationIds: readonly string[]; not?: boolean } | null | undefined,
): Promise<string[]> {
  return withScope(deps.pools.app, scope, async (_tx, client) => {
    const ids = filter?.locationIds.map((id) => id.toLowerCase()) ?? [];
    const { rows } = await client.query<{ id: string }>(
      `SELECT v.id FROM kept.visible_location_ids() AS v(id)
        WHERE cardinality($1::uuid[]) = 0
           OR (CASE WHEN $2::boolean THEN v.id <> ALL ($1::uuid[]) ELSE v.id = ANY ($1::uuid[]) END)
        ORDER BY v.id`,
      [ids, filter?.not ?? false],
    );
    return rows.map((r) => r.id);
  });
}

const payerKey = (r: Resolved) =>
  [r.provider.id, modelKeyOf(r), r.payer.scope, r.payer.accountId, r.payer.userId].join('|');

/** Part 1: the query's vectors, before the search's transaction. Null: meaning doesn't apply. */
export async function prepareSemantic(
  deps: SemanticDeps,
  scope: Scope,
  q: string | undefined,
  filter?: { locationIds: readonly string[]; not?: boolean } | null,
): Promise<SemanticInput | null> {
  if (!wantsMeaning(q)) return null;
  const text = (q ?? '').trim();
  if ((await embeddingsSource(deps.pools)) !== 'provider') {
    return { groups: [], state: { state: 'off' } };
  }
  if (!deps.ai) return { groups: [], state: { state: 'keyword_only' } };
  const locations = await searchedLocations(deps, scope, filter);
  if (locations.length === 0) return null;

  const rt = await deps.ai.runtime(scope);
  const byPayer = new Map<string, { resolved: Resolved; locationIds: string[] }>();
  for (const locationId of locations) {
    let resolved: Resolved | null = null;
    try {
      resolved = await rt.keys.resolve({ locationId, userId: scope.userId, task: 'embeddings' });
    } catch {
      // A location the principal can't resolve a provider in (a token's narrower reach): keywords.
      resolved = null;
    }
    if (!resolved) continue;
    const key = payerKey(resolved);
    const g = byPayer.get(key);
    if (g) g.locationIds.push(locationId);
    else byPayer.set(key, { resolved, locationIds: [locationId] });
  }
  if (byPayer.size === 0) return { groups: [], state: { state: 'keyword_only' } };

  const groups: SemanticGroup[] = [];
  let paused: SemanticState | null = null;
  let waiting: SemanticState | null = null;
  for (const { resolved, locationIds } of byPayer.values()) {
    const requestId = `query:${randomUUID()}`;
    const dims = requestedDims(resolved);
    const result = await embedValues(rt, {
      resolved,
      task: 'embed_query',
      locationId: locationIds[0] ?? null,
      userId: scope.userId,
      links: {},
      values: [text],
      ...(dims ? { dimensions: dims } : {}),
      requestId,
      attempt: 1,
      jobId: requestId,
    });
    if (result.status === 'ok') {
      const vector = result.vectors[0];
      if (vector && vector.length > 0) {
        groups.push({ modelKey: modelKeyOf(resolved), locationIds, vector });
      }
    } else if (result.status === 'paused') {
      const until =
        result.until.getTime() < FOREVER.getTime() ? result.until.toISOString() : undefined;
      const s: SemanticState = {
        state: result.kind === 'cap' ? 'paused' : 'waiting',
        ...(until ? { until } : {}),
      };
      if (result.kind === 'cap') paused ??= s;
      else waiting ??= s;
    } else {
      deps.log?.error(
        { errorCode: result.errorCode, outcome: result.outcome },
        'query embedding failed; keyword results',
      );
    }
  }
  return { groups, state: groups.length > 0 ? null : (paused ?? waiting ?? null) };
}

/** prepareSemantic() bound to its deps: what the tools (T9) and the search route take. */
export function semanticPrep(deps: SemanticDeps): SemanticPrep {
  return (scope, q, filter) => prepareSemantic(deps, scope, q, filter);
}

/** A thing found by meaning: its best rank across the groups (1 = nearest). */
export type MeaningHit = { id: string; rank: number; distance: number };

/** Part 2, on the search's transaction: the nearest things per group within the distance cut,
 * each with its best rank, nearest first. */
export async function meaningCandidates(
  client: pg.ClientBase,
  input: SemanticInput,
  maxDistance = SEMANTIC_MAX_DISTANCE,
): Promise<MeaningHit[]> {
  const best = new Map<string, MeaningHit>();
  for (const g of input.groups) {
    const one = g.locationIds.length === 1 ? (g.locationIds[0] ?? null) : null;
    const { rows } = await client.query<{ thing_id: string; distance: number }>(
      'SELECT thing_id, distance FROM kept.semantic_thing_ids($1, $2::vector, $3, $4)',
      [g.modelKey, vectorLiteral(g.vector), one, SEMANTIC_LIMIT],
    );
    let rank = 0;
    for (const r of rows) {
      const distance = Number(r.distance);
      if (!Number.isFinite(distance) || distance > maxDistance) continue;
      rank += 1;
      const had = best.get(r.thing_id);
      if (!had || rank < had.rank) best.set(r.thing_id, { id: r.thing_id, rank, distance });
    }
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank || a.distance - b.distance);
}

/** Reciprocal rank fusion's share of one ranking (Q14): 1 / (k + rank). */
export const rrf = (rank: number | undefined): number =>
  rank === undefined ? 0 : 1 / (RRF_K + rank);
