/**
 * Search, saved views, trash and history as fetchers and hooks for task 27's screens. The shared
 * fetchers live in api/inventory/queries.ts; the ones it lacks are here, beside the screens that
 * use them, so parallel web tasks never edit the same file. Paths come from paths.ts only.
 */
import {
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/api/client';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { inventoryApi, inventoryKeys as k } from '@/api/inventory/queries';
import type { SearchParams, SearchResponse } from '@/api/inventory/types';
import { keys } from '@/api/queries';
import { filterParams } from '@/components/filters/params';
import { firstOf, type ListState } from '@/lib/url-state';

// ----- search ----------------------------------------------------------------------------------

export { SEARCH_FILTERS } from './search-url';

/**
 * The server's search query for a list state: `q`, each filter's values (several repeat the
 * parameter, D205), `not` for the "is none of" ones, and the price range.
 */
export function searchParamsOf(list: ListState): SearchParams {
  const q = list.q.trim();
  const price = (key: string) => firstOf(list, key);
  const priceMin = price('priceMin');
  const priceMax = price('priceMax');
  const currency = price('currency');
  return {
    ...(q ? { q } : {}),
    ...(filterParams(list, {
      location: 'locationId',
      place: 'placeId',
      type: 'typeId',
      tag: 'tagId',
      state: 'state',
    }) as SearchParams),
    ...(priceMin ? { priceMin } : {}),
    ...(priceMax ? { priceMax } : {}),
    ...(currency ? { currency } : {}),
  };
}

/** Anything to search for: words, or at least one filter. */
export const hasCriteria = (params: SearchParams) =>
  Object.values(params).some(
    (v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );

/**
 * The search page's query: the first page is every group (things 20, the others 5); "Load
 * more" asks for things only (`kind=things&cursor=…`), as the server pages only that group.
 */
export function useSearchPages(params: SearchParams, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...k.search(params), 'pages'],
    queryFn: ({ pageParam }) =>
      inventoryApi.search(pageParam ? { ...params, kind: 'things', cursor: pageParam } : params),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SearchResponse) => last.things.next_cursor ?? undefined,
    enabled,
  });
}

/** One whole group (`kind=places|people|vendors`), for "Show all". */
export function useSearchGroup(params: SearchParams, kind: SearchParams['kind'], enabled: boolean) {
  const full = { ...params, kind };
  return useQuery({
    queryKey: k.search(full),
    queryFn: () => inventoryApi.search(full),
    enabled,
  });
}

/** The ⌘K palette's query (screens §5: debounced 150 ms, things only, 8 of them). */
export function usePaletteSearch(q: string) {
  const params: SearchParams = { q, kind: 'things', limit: 8 };
  return useQuery({
    queryKey: k.search(params),
    queryFn: () => inventoryApi.search(params),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });
}

// ----- trash -----------------------------------------------------------------------------------

export const trashApi = {
  restoreThing: (id: string) => inventoryApi.restoreThing(id),
  restorePlace: (id: string) => inventoryApi.restorePlace(id),
  /** Delete permanently (`things.delete-permanently`, trashed things only). */
  deleteThing: (id: string) => api.del(p.thing(id)),
};

/** After a restore or delete: the trash, and everything that shows places, things or counts. */
export function invalidateAfterTrash(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['trash'] }),
    qc.invalidateQueries({ queryKey: k.places.all }),
    qc.invalidateQueries({ queryKey: k.things.all }),
    qc.invalidateQueries({ queryKey: ['search'] }),
    qc.invalidateQueries({ queryKey: ['activity'] }),
    qc.invalidateQueries({ queryKey: k.home }),
    qc.invalidateQueries({ queryKey: keys.locations }),
  ]);
}

export function useInvalidateAfterTrash() {
  const qc = useQueryClient();
  return () => invalidateAfterTrash(qc);
}
