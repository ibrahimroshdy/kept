/**
 * Search (screens §5 Search, frames 04 · 1 and 04 · 10; D42, D74, D195): one box over every
 * location you belong to, in English or Arabic, with filters, recent searches and saved views.
 * Everything is URL state (`?q=`, `f.<filter>` and `not`), so any search can be linked and Back
 * restores it. The box and the filters are the filter strip (D205): location, place, type, tag,
 * state and, for readers who can see money, price; each "is any of" or "is none of", with saved
 * views.
 *
 * Matching is the server's (normalised Arabic, prefixes, aliases, short IDs, typos through
 * did-you-mean); this page only shows what came back. Recent searches stay on this device, per
 * person (components/search/recent.ts).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useMe } from '@/api/queries';
import { useCanSeeMoney, useFilterRegistry } from '@/components/filters/registry';
import { FilterStrip } from '@/components/filters/strip';
import type { FilterDef } from '@/components/filters/types';
import { stateOf } from '@/components/filters/views-api';
import { ClockIcon, SearchIcon } from '@/components/icons';
import { EmptyState, Page, Section } from '@/components/page';
import { hasCriteria, searchParamsOf } from '@/components/search/api';
import { useRecentSearches } from '@/components/search/recent';
import { SearchResults } from '@/components/search/results';
import { SavedViews } from '@/components/search/saved-views';
import { searchSearch } from '@/components/search/search-url';
import { isNot, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/search')({
  validateSearch: searchSearch,
  component: SearchPage,
});

function SearchPage() {
  const { t } = useLingui();
  const [list, setList] = useListState();
  const me = useMe();
  const f = useFilterRegistry();
  const { recent, remember, clear } = useRecentSearches(me.data?.user.id);
  const params = searchParamsOf(list);
  const searching = hasCriteria(params);
  const remember_ = () => {
    if (list.q.trim()) remember(list.q);
  };
  const priceSet = !!(list.filters.priceMin?.length || list.filters.priceMax?.length);
  const showPrice = useCanSeeMoney() || priceSet;
  const locations = list.filters.location ?? [];
  const filters: FilterDef[] = [
    // A place belongs to one location: choosing locations drops the places.
    { ...f.location(), clears: ['place'] },
    f.place(isNot(list, 'location') ? [] : locations),
    f.type(),
    f.tag(),
    f.state(['uncertain', 'draft', 'ended', 'to_review', 'long_unseen', 'unplaced']),
    ...(showPrice ? [f.price()] : []),
  ];

  return (
    <Page title={t`Search`} fill>
      <FilterStrip
        filters={filters}
        surface="search"
        search={{
          label: t`Search everything`,
          placeholder: t`Name, brand, serial or ID`,
          large: true,
          autoFocus: true,
          onCommit: (q) => remember(q),
        }}
      />

      {!list.q && recent.length ? (
        // biome-ignore lint/a11y/useSemanticElements: a row of shortcut buttons
        <div
          role="group"
          aria-label={t`Recent searches`}
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="eyebrow me-1">
            <Trans>Recent</Trans>
          </span>
          {recent.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setList({ q: r })}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-3.5"
            >
              <ClockIcon aria-hidden="true" />
              <bdi>{r}</bdi>
            </button>
          ))}
          <button
            type="button"
            onClick={clear}
            className="min-h-9 rounded-md px-2 text-[13px] text-ink-3 underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
          >
            <Trans>Clear recent searches</Trans>
          </button>
        </div>
      ) : null}

      {searching ? (
        <SearchResults params={params} onOpen={remember_} onSuggest={(q) => setList({ q })} />
      ) : (
        <>
          <SavedViews onOpen={(view) => setList(stateOf(view, list))} />
          <Section title={<Trans>Tips</Trans>}>
            <EmptyState icon={<SearchIcon />} title={<Trans>Find anything you've kept</Trans>}>
              <Trans>
                Search by name, a name it's also called, its brand, model or serial, or the
                6-character ID on its label, in English or Arabic. Filters narrow it to a place, a
                type or a tag.
              </Trans>
            </EmptyState>
          </Section>
        </>
      )}
    </Page>
  );
}
