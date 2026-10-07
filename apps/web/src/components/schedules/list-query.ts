/**
 * The step-4 list routes take one value per filter (`locationId`, `state`, …) and sort by due
 * themselves (overdue first). The filter strip allows several values, "is none of", and the
 * Display button's sorts and groupings (D205, D211). So each list sends a filter to the server
 * when it is one plain value, and applies the rest, the sort and the grouping's order, to the
 * rows it has loaded; "Load more" brings the next page in and they're ordered again.
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

/**
 * The query with its loaded rows filtered and ordered here, as one page, keeping the last page's
 * cursor so "Load more" still works. ListSurface reads it like any infinite query.
 */
export function useOrderedQuery<T, P extends Page<T>>(
  query: UseInfiniteQueryResult<InfiniteData<P>>,
  keep: (item: T) => boolean,
  compare: ((a: T, b: T) => number) | null,
): UseInfiniteQueryResult<InfiniteData<Page<T>>> {
  const data = query.data;
  const ordered = useMemo(() => {
    if (!data) return undefined;
    const items = data.pages.flatMap((p) => p.items).filter(keep);
    if (compare) items.sort(compare);
    const last = data.pages[data.pages.length - 1];
    return {
      pages: [{ items, next_cursor: last?.next_cursor ?? null }],
      pageParams: data.pageParams.slice(0, 1),
    } satisfies InfiniteData<Page<T>>;
  }, [data, keep, compare]);
  return { ...query, data: ordered } as UseInfiniteQueryResult<InfiniteData<Page<T>>>;
}
