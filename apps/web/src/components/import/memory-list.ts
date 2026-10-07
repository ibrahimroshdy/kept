/**
 * A list already in memory, paged for ListSurface (the list standard's "Load more"): the archive
 * report's rows and the Homebox types, filtered and searched in the page like the CSV report
 * (report-step.tsx). `key` must change whenever `items` does.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { nextCursor } from '@/api/inventory/queries';
import type { Page } from '@/api/inventory/types';

export function useMemoryPages<T>(key: readonly unknown[], items: readonly T[], pageSize = 100) {
  return useInfiniteQuery({
    queryKey: ['memory-list', ...key],
    queryFn: ({ pageParam }): Page<T> => {
      const start = Number(pageParam ?? 0);
      const end = start + pageSize;
      return {
        items: items.slice(start, end),
        next_cursor: end < items.length ? String(end) : null,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
}
