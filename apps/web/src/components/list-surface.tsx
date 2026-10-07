/**
 * The list standard (L88): every list gets search, filters, grouping and cursor pagination, all
 * held in the URL (lib/url-state.ts), so any list can be linked and Back restores it. Search and
 * filters are the filter strip (D205, components/filters/strip.tsx), with saved views when the
 * list names its `surface`. Sorting (and its direction), grouping and a layout are the strip's
 * Display button (D211, components/filters/display.tsx), never a row of their own.
 *
 *   const [list] = useListState();
 *   const f = useFilterRegistry();
 *   const query = useThings({ q: list.q, ...filterParams(list, { type: 'typeId' }) });
 *   <ListSurface label={t`Things`} query={query} filters={[f.type()]} surface="things"
 *                sorts={[{ value: 'name', label: t`Name` },
 *                        { value: 'updated', label: t`Changed`, kind: 'date' }]}
 *                groups={[…]} getKey={(t) => t.id} renderRow={(t) => <ThingRowView thing={t} />}
 *                empty={<EmptyState title={t`Nothing here yet`} />} />
 *
 * "Load more" follows `next_cursor`, then moves focus to the first new row, so a keyboard or
 * screen-reader user carries on where the list grew.
 */
import type { ListSurface as Surface } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef } from 'react';
import type { Page } from '@/api/inventory/types';
import {
  DisplayButton,
  type DisplayGroup,
  type DisplayLayout,
  type DisplaySort,
} from '@/components/filters/display';
import { FilterStrip } from '@/components/filters/strip';
import type { FilterDef } from '@/components/filters/types';
import { ErrorState, LoadingRows } from '@/components/page';
import { Button } from '@/components/ui/button';
import { type ListState, useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

export type { FilterDef, FilterOption } from '@/components/filters/types';

/** A grouping in the Display menu (D211); `short` is the button's words for it ("by type"). */
export type GroupDef = DisplayGroup;
/** A sort in the Display menu (D211); `kind: 'date'` makes its direction Newest/Oldest first. */
export type SortDef = DisplaySort;
/** A layout in the Display menu (D211), held in the URL's `view`; the first is the default. */
export type LayoutDef = DisplayLayout;

export type ListSurfaceProps<T> = {
  /** The list's accessible name. */
  label: string;
  /** The search box; `false` for a list too short to need one. */
  search?: { placeholder?: string; label?: string; end?: ReactNode; fullRow?: boolean } | false;
  filters?: FilterDef[];
  /** The list's saved views (D205): `activity`, `trash`, `things`, `contents`, … */
  surface?: Surface;
  groups?: GroupDef[];
  sorts?: SortDef[];
  /** Layouts (D211: a container's list or photos); the route must declare `view`. */
  layouts?: LayoutDef[];
  query: UseInfiniteQueryResult<InfiniteData<Page<T>>>;
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  /** Section headings when grouped: consecutive rows with the same key share one. */
  groupOf?: (item: T, group: string) => { key: string; label: ReactNode } | null;
  /**
   * The grouping when the URL names none. A list whose grouping is fixed (the inbox, by capture
   * batch) passes it without `groups`, so there is no choice to show.
   */
  defaultGroup?: string;
  /**
   * Rows as tiles in a grid (a Display layout such as Paperwork's Grid, D211): two a row on a
   * phone, more from `md`, each tile its own card. A tiled list has no grouping.
   */
  tiles?: boolean;
  /** Shown when there are no rows and nothing is searched or filtered. */
  empty: ReactNode;
  /** Shown when a search or filter matched nothing (default: a plain sentence). */
  noMatch?: ReactNode;
  className?: string;
};

export function ListSurface<T>({
  label,
  search = {},
  filters = [],
  surface,
  groups,
  sorts,
  layouts,
  query,
  getKey,
  renderRow,
  groupOf,
  defaultGroup,
  tiles = false,
  empty,
  noMatch,
  className,
}: ListSurfaceProps<T>) {
  const { t } = useLingui();
  const [list, setList] = useListState();
  const items = query.data?.pages.flatMap((pg) => pg.items) ?? [];
  const narrowed = list.q !== '' || Object.keys(list.filters).length > 0;

  // Focus the first new row after "Load more".
  const listRef = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || items.length <= from) return;
    focusFrom.current = null;
    listRef.current?.querySelectorAll<HTMLElement>('[data-list-row]')[from]?.focus();
  }, [items.length]);

  let lastGroup: string | null = null;
  return (
    <div className={cn('grid min-w-0 content-start gap-3', className)}>
      {search !== false || filters.length || surface || groups || sorts || layouts ? (
        <FilterStrip
          filters={filters}
          {...(surface ? { surface } : {})}
          display={
            groups?.length || sorts?.length || layouts?.length ? (
              <DisplayButton
                options={{
                  ...(groups ? { groups } : {}),
                  ...(sorts ? { sorts } : {}),
                  ...(layouts ? { layouts } : {}),
                  ...(defaultGroup ? { defaultGroup } : {}),
                }}
                list={list}
                setList={setList}
              />
            ) : null
          }
          search={
            search === false
              ? false
              : {
                  label: search.label ?? t`Search ${label}`,
                  placeholder: search.placeholder ?? t`Search`,
                  ...(search.end ? { end: search.end } : {}),
                  ...(search.fullRow ? { fullRow: true } : {}),
                }
          }
        />
      ) : null}

      {query.isPending ? (
        <LoadingRows label={t`Loading ${label}`} />
      ) : query.isError && items.length === 0 ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        narrowed ? (
          (noMatch ?? (
            <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-ink-2">
              <Trans>Nothing matches. Try fewer words or clear a filter.</Trans>
            </p>
          ))
        ) : (
          empty
        )
      ) : (
        <ul
          ref={listRef}
          aria-label={label}
          className={
            tiles
              ? 'm-0 grid list-none grid-cols-2 gap-2 p-0 md:grid-cols-3 xl:grid-cols-4'
              : 'm-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0'
          }
        >
          {items.map((item) => {
            const by = list.group || defaultGroup || groups?.[0]?.value;
            const group = groupOf && by && by !== 'none' ? groupOf(item, by) : null;
            const heading = group && group.key !== lastGroup ? group : null;
            if (group) lastGroup = group.key;
            return (
              <li
                key={getKey(item)}
                data-list-row=""
                tabIndex={-1}
                className={cn(
                  'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
                  tiles
                    ? 'grid min-w-0 content-start gap-2 rounded-[10px]'
                    : 'border-line not-first:border-t',
                )}
              >
                {heading ? (
                  <div
                    className={cn('eyebrow bg-sunken px-3.5 py-2', tiles && 'rounded-lg')}
                    role="presentation"
                  >
                    {heading.label}
                  </div>
                ) : null}
                {renderRow(item)}
              </li>
            );
          })}
        </ul>
      )}

      {query.hasNextPage ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          isPending={query.isFetchingNextPage}
          onPress={() => {
            focusFrom.current = items.length;
            void query.fetchNextPage();
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </div>
  );
}

export type { ListState };
