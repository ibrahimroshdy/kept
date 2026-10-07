/**
 * A filter's values as React Query state (D205): the options its popover lists for what was
 * typed, and the names of the values already chosen (a chip's "Alfred, Bruce").
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { fuzzyFilter } from './fuzzy';
import type { FilterDef, FilterOption } from './types';

const STALE_MS = 60_000;
const SERVER_DEBOUNCE_MS = 200;

/** `value` after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return out;
}

const textOf = (o: FilterOption) => `${o.label} ${o.description ?? ''}`;

/** The options `def` offers for `q`, best match first. */
export function useFilterOptions(
  def: FilterDef,
  q: string,
): { options: FilterOption[]; isPending: boolean; isError: boolean } {
  const values = def.values;
  const serverQ = useDebounced(q.trim(), SERVER_DEBOUNCE_MS);
  const loaded = useQuery({
    queryKey: values?.from === 'load' ? values.queryKey : ['filters', 'none'],
    queryFn: () => (values?.from === 'load' ? values.load() : Promise.resolve([])),
    enabled: values?.from === 'load',
    staleTime: STALE_MS,
  });
  const searched = useQuery({
    queryKey: values?.from === 'server' ? [...values.queryKey, 'q', serverQ] : ['filters', 'none'],
    queryFn: () => (values?.from === 'server' ? values.search(serverQ) : Promise.resolve([])),
    enabled: values?.from === 'server',
    staleTime: STALE_MS,
    placeholderData: (prev) => prev,
  });
  const options = useMemo(() => {
    if (!values) return [];
    if (values.from === 'static') return fuzzyFilter(values.options, q, textOf);
    if (values.from === 'load') return fuzzyFilter(loaded.data ?? [], q, textOf);
    // The server matched already; narrow what it answered to what's typed now, as the next
    // answer is on its way.
    return fuzzyFilter(searched.data ?? [], q, textOf);
  }, [values, q, loaded.data, searched.data]);
  const query = values?.from === 'load' ? loaded : values?.from === 'server' ? searched : null;
  return {
    options,
    isPending: query ? query.isPending : false,
    isError: query ? query.isError : false,
  };
}

/** The options for `chosen` values, in their order; a value it can't name is left out. */
export function useValueLabels(def: FilterDef, chosen: string[]): FilterOption[] {
  const values = def.values;
  const loaded = useQuery({
    queryKey: values?.from === 'load' ? values.queryKey : ['filters', 'none'],
    queryFn: () => (values?.from === 'load' ? values.load() : Promise.resolve([])),
    enabled: values?.from === 'load' && chosen.length > 0,
    staleTime: STALE_MS,
  });
  const sorted = [...chosen].sort();
  const resolved = useQuery({
    queryKey:
      values?.from === 'server' ? [...values.queryKey, 'resolve', sorted] : ['filters', 'none'],
    queryFn: () =>
      values?.from === 'server' ? values.resolve(sorted) : Promise.resolve([] as FilterOption[]),
    enabled: values?.from === 'server' && chosen.length > 0,
    staleTime: STALE_MS,
  });
  const pool =
    values?.from === 'static'
      ? values.options
      : values?.from === 'load'
        ? (loaded.data ?? [])
        : values?.from === 'server'
          ? (resolved.data ?? [])
          : [];
  const byValue = new Map(pool.map((o) => [o.value, o]));
  return chosen.flatMap((v) => {
    const o = byValue.get(v);
    return o ? [o] : [];
  });
}
