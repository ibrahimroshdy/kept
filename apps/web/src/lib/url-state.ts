/**
 * List state in the URL (the list standard, lessons L88): the search text `q`, one `f.<name>`
 * per filter, `not` (the filters that are "is none of", D205), `saved` (the saved view it
 * was opened from, D205), `group`, `sort` and `dir` (the sort turned around, D211), and `view`
 * (the layout, where the route declares one, D211). Every list is linkable, and Back restores it.
 *
 * A route declares it with `validateSearch: listSearch(['type', 'tag'])`; the list and its query
 * both read it with `useListState()`. TanStack Router JSON-parses search values (`?q=123` arrives
 * as the number 123, `?f.tag=["a","b"]` as an array), so every field is coerced here and a
 * malformed value is dropped rather than thrown.
 *
 * `zod/mini`, not `zod`: route `validateSearch` functions are not code-split, so this module is
 * in the entry chunk, where full zod cost ~20 KB gzip against the 25 KB budget (D80).
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import * as z from 'zod/mini';

export type ListState = {
  q: string;
  /** Selected values per filter name (`f.type=…`). */
  filters: Record<string, string[]>;
  /** Filter names whose values are excluded ("is none of") rather than wanted (`not=…`). */
  not: string[];
  /** The saved view this state was opened from (`saved=<id>`), to tell when it's been changed. */
  savedView: string | undefined;
  group: string | undefined;
  sort: string | undefined;
  /** The sort turned around (`dir=asc|desc`, D211); absent, the sort's own order. `''` clears
   * it when setting. */
  dir?: SortDir | '' | undefined;
  /** The layout (`view=photos`, D211), on a route that declares `view`. */
  layout?: string | undefined;
};

export type SortDir = 'asc' | 'desc';

export const FILTER_PREFIX = 'f.';

const text = z.pipe(
  z.transform((v: unknown) =>
    typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : typeof v === 'string'
        ? v
        : undefined,
  ),
  z.optional(z.string()),
);
const values = z.pipe(
  z.transform((v: unknown) =>
    v === undefined || v === null
      ? undefined
      : (Array.isArray(v) ? v : [v])
          .filter((x) => (typeof x === 'string' && x !== '') || typeof x === 'number')
          .map(String),
  ),
  z.optional(z.array(z.string())),
);

/**
 * The zod schema for a route's `validateSearch`: the list keys, each filter's `f.<name>`, and
 * any `extra` keys the route owns (a tab, an open sheet).
 */
export function listSearch(
  filterNames: readonly string[] = [],
  extra: Record<string, z.ZodMiniType> = {},
) {
  const shape: Record<string, z.ZodMiniType> = {
    q: text,
    group: text,
    sort: text,
    dir: text,
    not: values,
    saved: text,
    ...extra,
  };
  for (const name of filterNames) shape[`${FILTER_PREFIX}${name}`] = values;
  return z.catch(z.object(shape), {}) as unknown as z.ZodMiniType<
    { q?: string; group?: string; sort?: string } & Record<string, unknown>
  >;
}

/** The ListState held in a (validated or raw) search object. */
export function toListState(search: Record<string, unknown>): ListState {
  const filters: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(search)) {
    if (!key.startsWith(FILTER_PREFIX)) continue;
    const parsed = values.safeParse(raw);
    if (parsed.success && parsed.data?.length)
      filters[key.slice(FILTER_PREFIX.length)] = parsed.data;
  }
  const str = (v: unknown) => text.safeParse(v).data || undefined;
  const not = (values.safeParse(search.not).data ?? []).filter((n) => filters[n]);
  return {
    q: str(search.q) ?? '',
    filters,
    not,
    savedView: str(search.saved),
    group: str(search.group),
    sort: str(search.sort),
    dir: search.dir === 'asc' || search.dir === 'desc' ? search.dir : undefined,
    layout: str(search.view),
  };
}

/** Search params for a ListState; empty values are left out so URLs stay short. */
export function fromListState(state: Partial<ListState>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (state.q !== undefined) out.q = state.q || undefined;
  if (state.group !== undefined) out.group = state.group || undefined;
  if (state.sort !== undefined) out.sort = state.sort || undefined;
  if (state.dir !== undefined) out.dir = state.dir || undefined;
  if (state.layout !== undefined) out.view = state.layout || undefined;
  if (state.savedView !== undefined) out.saved = state.savedView || undefined;
  if (state.not !== undefined) out.not = state.not.length ? state.not : undefined;
  for (const [name, list] of Object.entries(state.filters ?? {}))
    out[`${FILTER_PREFIX}${name}`] = list.length ? list : undefined;
  return out;
}

/** The first selected value of a filter, for routes that take one (`typeId`, `tagId`). */
export const firstOf = (state: ListState, name: string): string | undefined =>
  state.filters[name]?.[0];

export type SetListState = (next: Partial<ListState>, opts?: { replace?: boolean }) => void;

/** Whether a filter is "is none of" (`not`). */
export const isNot = (state: ListState, name: string): boolean => state.not.includes(name);

/**
 * Read and write the current route's list state. `set` merges: pass only what changed. Typing
 * replaces the history entry; filter, group and sort changes push one, so Back undoes them.
 */
export function useListState(): [ListState, SetListState] {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const state = useMemo(() => toListState(search), [search]);
  const set = useCallback<SetListState>(
    (next, opts) => {
      const patch = fromListState({
        ...next,
        ...(next.filters ? { filters: next.filters } : {}),
      });
      void navigate({
        to: '.',
        search: ((prev: Record<string, unknown>) => {
          const merged: Record<string, unknown> = { ...prev, ...patch };
          for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
          return merged;
        }) as never,
        replace: opts?.replace ?? false,
      });
    },
    [navigate],
  );
  return [state, set];
}
