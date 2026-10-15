/**
 * The list helpers of the moving lists (D205, D251). The same rules as the step-4 lists'
 * (components/schedules/list-query.ts), kept here because that module loads on demand and moving
 * is precached: it works offline in the middle of a move.
 */
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Page } from '@/api/inventory/types';
import type { ListState } from '@/lib/url-state';

/** The filter's one value, for the server, when it is exactly one and not "is none of". */
export function oneValue(list: ListState, key: string): string | undefined {
  const values = list.filters[key];
  if (values?.length !== 1 || list.not.includes(key)) return undefined;
  return values[0];
}

/** Whether a row's value passes the filter `key` (any of / none of; no filter passes). */
export function passes(list: ListState, key: string, value: string | null | undefined): boolean {
  const values = list.filters[key];
  if (!values?.length) return true;
  const hit = value != null && values.includes(value);
  return list.not.includes(key) ? !hit : hit;
}

/** The query with its loaded rows filtered and ordered here, as one page ("Load more" stays). */
export function useOrderedQuery<T>(
  query: UseInfiniteQueryResult<InfiniteData<Page<T>>>,
  keep: (item: T) => boolean,
  compare: (a: T, b: T) => number,
): UseInfiniteQueryResult<InfiniteData<Page<T>>> {
  const data = query.data;
  const ordered = useMemo(() => {
    if (!data) return undefined;
    const items = data.pages.flatMap((p) => p.items).filter(keep);
    items.sort(compare);
    const last = data.pages[data.pages.length - 1];
    return {
      pages: [{ items, next_cursor: last?.next_cursor ?? null }],
      pageParams: data.pageParams.slice(0, 1),
    } satisfies InfiniteData<Page<T>>;
  }, [data, keep, compare]);
  return { ...query, data: ordered } as UseInfiniteQueryResult<InfiniteData<Page<T>>>;
}
