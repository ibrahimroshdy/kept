/**
 * Saved views for every list (D205): fetchers, and the step between a list's URL state and the
 * query a view keeps. A view stores the list state itself (SavedListQuery), limited to the
 * filters its list offers (SURFACE_FILTER_KEYS), so opening one puts it straight back in the URL.
 */
import {
  type ListSurface,
  MONEY_FILTER_KEYS,
  type SavedListQuery,
  SURFACE_FILTER_KEYS,
} from '@kept/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, ifMatch } from '@/api/client';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { inventoryKeys as k } from '@/api/inventory/queries';
import type {
  CreateSavedViewBody,
  SavedView,
  SavedViewPrefs,
  UpdateSavedViewBody,
} from '@/api/inventory/types';
import type { ListState } from '@/lib/url-state';

export const savedViewApi = {
  create: (body: CreateSavedViewBody) => api.post<SavedView>(p.savedViews, body),
  update: (id: string, body: UpdateSavedViewBody, rowVersion: number) =>
    api.patch<SavedView>(p.savedView(id), body, ifMatch(rowVersion)),
  remove: (id: string) => api.del(p.savedView(id)),
  prefs: (surface: ListSurface, body: SavedViewPrefs) =>
    api.put<SavedViewPrefs>(p.savedViewPrefs(surface), body),
};

export function useInvalidateViews() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: k.savedViews });
}

/** The query a view of `surface` keeps for `list`: its words, the filters that list offers,
 * which of them are "is none of", and the Display button's grouping, order and layout (D211). */
export function queryOf(list: ListState, surface: ListSurface): SavedListQuery {
  const allowed = SURFACE_FILTER_KEYS[surface];
  const filters: Record<string, string[]> = {};
  for (const key of allowed) {
    const values = list.filters[key];
    if (values?.length) filters[key] = [...values];
  }
  const money = MONEY_FILTER_KEYS as readonly string[];
  const not = list.not.filter((key) => filters[key] && !money.includes(key));
  const q = list.q.trim();
  return {
    ...(q ? { q } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(not.length ? { not } : {}),
    ...(list.group ? { group: list.group } : {}),
    ...(list.sort ? { sort: list.sort } : {}),
    ...(list.dir ? { dir: list.dir } : {}),
    ...(list.layout ? { layout: list.layout } : {}),
  };
}

/** Anything to save: words or a filter. */
export const hasQuery = (query: SavedListQuery): boolean =>
  !!query.q || Object.keys(query.filters ?? {}).length > 0;

/** The list state that opens `view`: every filter the list offers is set, so none lingers. */
export function stateOf(view: SavedView, current: ListState): Partial<ListState> {
  const filters: Record<string, string[]> = {};
  for (const key of [...SURFACE_FILTER_KEYS[view.surface], ...Object.keys(current.filters)])
    filters[key] = [];
  for (const [key, values] of Object.entries(view.query.filters ?? {})) filters[key] = values;
  return {
    q: view.query.q ?? '',
    filters,
    not: view.query.not ?? [],
    group: view.query.group ?? '',
    sort: view.query.sort ?? '',
    dir: view.query.dir ?? '',
    layout: view.query.layout ?? '',
    savedView: view.id,
  };
}

/** The list state with no view and nothing narrowed (the "All" tab). */
export function clearedState(current: ListState): Partial<ListState> {
  return {
    q: '',
    filters: Object.fromEntries(Object.keys(current.filters).map((key) => [key, []])),
    not: [],
    savedView: '',
  };
}

/** A query in one canonical form: values sorted, so the same filters compare equal. */
function canonical(query: SavedListQuery): string {
  const filters = Object.fromEntries(
    Object.entries(query.filters ?? {})
      .filter(([, v]) => v.length)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => [key, [...v].sort()]),
  );
  return JSON.stringify({
    q: query.q?.trim() ?? '',
    filters,
    not: [...(query.not ?? [])].sort(),
    group: query.group ?? '',
    sort: query.sort ?? '',
    dir: query.dir ?? '',
    layout: query.layout ?? '',
  });
}

/** The list no longer shows what `view` saved (a filter, the words, grouping, order or layout
 * changed). */
export function isModified(view: SavedView, list: ListState): boolean {
  return canonical(queryOf(list, view.surface)) !== canonical(view.query);
}
