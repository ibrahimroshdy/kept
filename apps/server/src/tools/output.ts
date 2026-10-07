import type { PlaceRef, ThingRef } from '@kept/mcp';
import { BUILTIN_TYPES, type DerivedState } from '@kept/shared';
import type pg from 'pg';
import { invalid } from '../http/errors.js';

// What every tool answers with (packages/mcp output.ts, D179): Kept's own words (ids, codes,
// enums, dates) beside `untrusted`, which holds only what people wrote. These builders turn the
// shapes the routes' operations return (ThingRow, PlaceRow, ThingView) into the tools' refs, so
// a name never leaves this file outside an `untrusted` key.

/** A thing row as the operations return it (search, lists, contents: camelCase ThingRow). */
export type RowLike = {
  id: string;
  locationId: string;
  shortCode: string | null;
  name: string | null;
  quantity: number;
  lifecycle: string;
  derivedState: DerivedState[];
  path: { name: string; kind: 'place' | 'container'; isUnplaced: boolean }[];
  lastSeenAt: string | null;
};

/** Names a path step for the model: Unplaced is Kept's own word, the rest are people's. */
const stepName = (s: RowLike['path'][number]) => (s.isUnplaced ? 'Unplaced' : s.name);

/** The location's name, then the places and containers down to the thing's own. */
export function pathOf(locationName: string | undefined, steps: RowLike['path']): string[] {
  return [...(locationName !== undefined ? [locationName] : []), ...steps.map(stepName)];
}

export function thingRefOf(row: RowLike, locationName: string | undefined): ThingRef {
  return {
    id: row.id,
    short_code: row.shortCode,
    location_id: row.locationId,
    untrusted: { name: row.name ?? '', path: pathOf(locationName, row.path) },
  };
}

export type Loan = {
  direction: 'out' | 'in';
  due_on: string | null;
  untrusted: { person: string };
};

/** The summary every thing list answers (TOOL_DEFS' thingSummary). */
export function thingSummaryOf(
  row: RowLike,
  locationName: string | undefined,
  loans: ReadonlyMap<string, Loan>,
) {
  const loan = loans.get(row.id);
  return {
    ...thingRefOf(row, locationName),
    quantity: row.quantity,
    lifecycle: row.lifecycle as 'in_use',
    states: row.derivedState,
    last_seen_at: row.lastSeenAt,
    ...(loan ? { loan } : {}),
  };
}

/** The open loans of `thingIds` ("with Murdock", D57): the person's name only, never a contact
 * detail (Q34). Read as the caller, so a loan they can't see isn't there. */
export async function openLoansOf(
  client: pg.ClientBase,
  thingIds: readonly string[],
): Promise<Map<string, Loan>> {
  const out = new Map<string, Loan>();
  if (thingIds.length === 0) return out;
  const { rows } = await client.query<{
    thing_id: string;
    direction: 'out' | 'in';
    due_on: string | null;
    name: string | null;
  }>(
    `SELECT o.thing_id, o.direction, o.due_on::text AS due_on, pe.display_name AS name
       FROM public.loans o LEFT JOIN public.people pe ON pe.id = o.person_id
      WHERE o.thing_id = ANY ($1::uuid[]) AND o.returned_at IS NULL`,
    [[...thingIds]],
  );
  for (const r of rows) {
    out.set(r.thing_id, {
      direction: r.direction,
      due_on: r.due_on,
      untrusted: { person: r.name ?? '' },
    });
  }
  return out;
}

/** The names of the locations the caller can see, by id. */
export async function locationNames(client: pg.ClientBase): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT l.id, l.name FROM public.locations l
      WHERE l.id IN (SELECT v.id FROM kept.visible_location_ids() AS v(id))`,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A place as the tools cite it: its path from the location down to it, itself included. */
export async function placeRefOf(client: pg.ClientBase, placeId: string): Promise<PlaceRef> {
  const { rows } = await client.query<{
    id: string;
    location_id: string;
    kind_key: string;
    short_code: string | null;
    path: string[];
  }>(
    `WITH RECURSIVE up(id, parent_id, name, is_unplaced, depth) AS (
       SELECT p.id, p.parent_id, p.name, p.is_unplaced, 0 FROM public.places p WHERE p.id = $1
       UNION ALL
       SELECT q.id, q.parent_id, q.name, q.is_unplaced, up.depth + 1
         FROM public.places q JOIN up ON q.id = up.parent_id)
     SELECT p.id, p.location_id, p.kind_key,
            (SELECT s.code FROM public.short_ids s
              WHERE s.place_id = p.id AND s.is_primary AND s.state = 'assigned' LIMIT 1)
              AS short_code,
            ARRAY[l.name] || ARRAY(SELECT CASE WHEN up.is_unplaced THEN 'Unplaced' ELSE up.name END
                                     FROM up ORDER BY up.depth DESC) AS path
       FROM public.places p JOIN public.locations l ON l.id = p.location_id
      WHERE p.id = $1`,
    [placeId],
  );
  const r = rows[0];
  if (!r) throw new Error(`place ${placeId} vanished inside its own transaction`);
  return {
    id: r.id,
    short_code: r.short_code,
    location_id: r.location_id,
    kind: r.kind_key,
    untrusted: { name: r.path.at(-1) ?? '', path: r.path },
  };
}

/** A built-in type's English name (the model reads English, D63); an account's type its own. */
export function typeNameOf(
  type: { name: string | null; builtinKey: string | null } | null,
): string | null {
  if (!type) return null;
  if (type.name) return type.name;
  return BUILTIN_TYPES.find((t) => t.key === type.builtinKey)?.names.en ?? null;
}

// ---------------------------------------------------------------------------------------------
// Links. Internal paths of the web app (routes/_app/t.$id.tsx, p.$id.tsx, D179: only internal
// links), prefixed with the public URL where the caller is outside the app (MCP).
// ---------------------------------------------------------------------------------------------

export const thingPath = (ref: { id: string; short_code: string | null }) =>
  `/t/${ref.short_code ?? ref.id}`;
export const placePath = (ref: { id: string; short_code: string | null }) =>
  `/p/${ref.short_code ?? ref.id}`;

// ---------------------------------------------------------------------------------------------
// Cursors. A tool's cursor wraps the operation's own keyset cursor and how many of that page
// were already answered: fit() may shorten a page to stay under 8 KB, and the next call resumes
// inside the same operation page. Opaque to the model.
// ---------------------------------------------------------------------------------------------

export type ToolCursor = { c: string | null; o: number };

export function encodeToolCursor(cursor: ToolCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeToolCursor(raw: string | undefined): ToolCursor {
  if (!raw) return { c: null, o: 0 };
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      v &&
      typeof v === 'object' &&
      (typeof (v as ToolCursor).c === 'string' || (v as ToolCursor).c === null) &&
      Number.isInteger((v as ToolCursor).o) &&
      (v as ToolCursor).o >= 0
    ) {
      return { c: (v as ToolCursor).c, o: (v as ToolCursor).o };
    }
  } catch {}
  throw invalid('The cursor is not valid; start again without one.');
}
