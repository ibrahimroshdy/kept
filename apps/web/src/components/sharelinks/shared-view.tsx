/**
 * A shared page's body (1.5, D233; D116): the box or place shared (or the list's name), then the
 * things in it A to Z, each with only its name, photo, type, where it is, quantity, condition and
 * notes. The public page (`/s/<token>`) shows it under the list standard: search, a type and a
 * condition filter, grouping by where or by type, and "Load more", all in the URL. Searching,
 * filtering or grouping loads the rest of the link's pages first (60 at a time, 1,200 at most,
 * D72), so a filter never misses what isn't loaded yet. An admin's "Preview as recipient" shows
 * the same rows as a plain list, so it doesn't take over its page's URL.
 */
import type { Condition } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Page } from '@/api/inventory/types';
import type { SharedPage, SharedStep, SharedThing } from '@/api/sharelinks/types';
import { BoxIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, LoadingRows } from '@/components/page';
import { useConditionLabels } from '@/components/things/labels';
import { useTypeName } from '@/components/things/names';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { firstOf, useListState } from '@/lib/url-state';

/** The URL filter keys the public page's list owns (its route's `listSearch`). */
export const SHARED_FILTERS = ['type', 'condition'] as const;

type Query = UseInfiniteQueryResult<InfiniteData<SharedPage>>;
type Row = SharedThing & { key: string };

function usePathWords() {
  const { t } = useLingui();
  return (path: SharedStep[]) =>
    path.map((s) => (s.isUnplaced ? t`Unplaced` : (s.name ?? t`Untitled`))).join(' › ');
}

/** The heading part: what was shared, how many things, until when. */
export function SharedHeader({ page }: { page: SharedPage }) {
  const f = useFormat();
  const pathWords = usePathWords();
  const typeName = useTypeName();
  const conditions = useConditionLabels();
  const until = f.day(page.expiresAt);
  const box = page.thing;
  const where = box ? pathWords(box.path) : page.place ? pathWords(page.place.path) : '';
  return (
    <div className="grid gap-3">
      {box ? (
        <div className="flex items-start gap-3">
          <Photo thing={box} large />
          <div className="grid min-w-0 gap-1">
            {box.type ? (
              <span className="flex items-center gap-1.5 text-small text-ink-2">
                <TypeIcon icon={box.type.icon} className="size-4 text-ink-3" />
                {typeName(box.type)}
              </span>
            ) : null}
            {where ? <span className="break-words text-small text-ink-2">{where}</span> : null}
            {box.condition ? (
              <span className="text-small text-ink-2">{conditions[box.condition]}</span>
            ) : null}
            {box.description ? (
              <p className="m-0 whitespace-pre-line break-words text-ink">{box.description}</p>
            ) : null}
          </div>
        </div>
      ) : where ? (
        <span className="break-words text-small text-ink-2">{where}</span>
      ) : null}
      <p className="m-0 text-small text-ink-2">
        {plural(page.total, { one: '# thing', other: '# things' })}
        {f.sep}
        <Trans>This link works until {until}.</Trans>
      </p>
      {page.total > page.cap ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>A link shows the first {f.num(page.cap)} of them, A to Z.</Trans>
        </p>
      ) : null}
    </div>
  );
}

function Photo({ thing, large = false }: { thing: SharedThing; large?: boolean }) {
  const size = large ? 'size-24' : 'size-14';
  if (!thing.photo)
    return (
      <span
        aria-hidden="true"
        className={`grid ${size} shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-3`}
      >
        <TypeIcon icon={thing.type?.icon ?? null} className="size-6" />
      </span>
    );
  return (
    <a
      href={thing.photo.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`block ${size} shrink-0 overflow-hidden rounded-[10px] bg-sunken outline-none focus-visible:outline-2 focus-visible:outline-info`}
    >
      <img
        src={(large ? thing.photo.url : thing.photo.thumbUrl) ?? thing.photo.url}
        alt={thing.name ?? ''}
        loading="lazy"
        className="size-full object-cover"
      />
    </a>
  );
}

function SharedRow({ thing }: { thing: SharedThing }) {
  const { t } = useLingui();
  const f = useFormat();
  const typeName = useTypeName();
  const conditions = useConditionLabels();
  const pathWords = usePathWords();
  const quantity = f.num(thing.quantity);
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <Photo thing={thing} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="break-words font-semibold text-ink">{thing.name ?? t`Untitled`}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-ink-2">
          {thing.type ? <span>{typeName(thing.type)}</span> : null}
          {thing.quantity !== 1 ? (
            <span>
              <Trans>Quantity {quantity}</Trans>
            </span>
          ) : null}
          {thing.condition ? <span>{conditions[thing.condition]}</span> : null}
        </span>
        {thing.path.length ? (
          <span className="break-words text-small text-ink-3">{pathWords(thing.path)}</span>
        ) : null}
        {thing.description ? (
          <p className="m-0 whitespace-pre-line break-words text-small text-ink">
            {thing.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const rowsOf = (query: Query): Row[] =>
  (query.data?.pages ?? []).flatMap((pg) =>
    pg.items.map((item, i) => ({ ...item, key: `${pg.page}-${i}` })),
  );

/** The public page's list, under the list standard (see the header). */
export function SharedList({ query }: { query: Query }) {
  const { t } = useLingui();
  const [list] = useListState();
  const typeName = useTypeName();
  const conditions = useConditionLabels();
  const pathWords = usePathWords();
  const all = rowsOf(query);
  const q = list.q.trim().toLocaleLowerCase();
  const type = list.filters.type ?? [];
  const condition = firstOf(list, 'condition') as Condition | undefined;
  const narrowed = !!q || type.length > 0 || !!condition || !!list.group;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  // A search, filter or grouping covers the whole link: load what isn't here yet.
  useEffect(() => {
    if (narrowed && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [narrowed, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const typeOf = (r: Row) => (r.type ? typeName(r.type) : t`No type`);
  const whereOf = (r: Row) => pathWords(r.path) || t`Unplaced`;
  const typeNames = [...new Set(all.map(typeOf))].sort((a, b) => a.localeCompare(b));
  const negated = list.not.includes('type');
  const shown = all
    .filter(
      (r) =>
        !q ||
        (r.name ?? '').toLocaleLowerCase().includes(q) ||
        (r.description ?? '').toLocaleLowerCase().includes(q),
    )
    .filter((r) => !type.length || type.includes(typeOf(r)) !== negated)
    .filter((r) => !condition || r.condition === condition);
  const by = list.group ?? 'none';
  const sorted =
    by === 'none'
      ? shown
      : [...shown].sort(
          (a, b) =>
            (by === 'where' ? whereOf(a).localeCompare(whereOf(b)) : 0) ||
            (by === 'type' ? typeOf(a).localeCompare(typeOf(b)) : 0),
        );
  const paged = {
    ...query,
    data: query.data
      ? {
          pages: [{ items: sorted, next_cursor: hasNextPage && !narrowed ? 'more' : null }],
          pageParams: [undefined],
        }
      : undefined,
    hasNextPage: !!hasNextPage && !narrowed,
  } as unknown as UseInfiniteQueryResult<InfiniteData<Page<Row>>>;

  return (
    <ListSurface<Row>
      label={t`Things`}
      search={{ label: t`Search this list`, placeholder: t`Search by name` }}
      filters={[
        {
          key: 'type',
          label: t`Type`,
          kind: 'multi',
          values: { from: 'static', options: typeNames.map((n) => ({ value: n, label: n })) },
        },
        {
          key: 'condition',
          label: t`Condition`,
          kind: 'single',
          values: {
            from: 'static',
            options: (Object.keys(conditions) as Condition[]).map((c) => ({
              value: c,
              label: conditions[c],
            })),
          },
        },
      ]}
      groups={[
        { value: 'none', label: t`None` },
        { value: 'where', label: t`Where`, short: t`by where` },
        { value: 'type', label: t`Type`, short: t`by type` },
      ]}
      groupOf={(r, g) =>
        g === 'where'
          ? { key: whereOf(r), label: whereOf(r) }
          : g === 'type'
            ? { key: typeOf(r), label: typeOf(r) }
            : null
      }
      query={paged}
      getKey={(r) => r.key}
      renderRow={(r) => <SharedRow thing={r} />}
      empty={
        <EmptyState icon={<BoxIcon />} title={<Trans>Nothing here yet</Trans>}>
          {null}
        </EmptyState>
      }
    />
  );
}

/** The same rows as a plain list with "Load more": an admin's preview. */
export function SharedPlainList({ query }: { query: Query }) {
  const { t } = useLingui();
  const rows = rowsOf(query);
  if (query.isPending) return <LoadingRows rows={3} label={t`Loading`} />;
  if (!rows.length)
    return (
      <EmptyState icon={<BoxIcon />} title={<Trans>Nothing here yet</Trans>}>
        {null}
      </EmptyState>
    );
  return (
    <div className="grid gap-3">
      <ul className="m-0 grid list-none divide-y divide-line rounded-xl border border-line bg-surface p-0">
        {rows.map((r) => (
          <li key={r.key}>
            <SharedRow thing={r} />
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-center"
          isPending={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </div>
  );
}
