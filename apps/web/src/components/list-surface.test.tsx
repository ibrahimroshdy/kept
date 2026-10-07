import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import type { Page } from '@/api/inventory/types';
import { listSearch, useListState } from '@/lib/url-state';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { type FilterDef, ListSurface } from './list-surface';

type Item = { id: string; name: string; kind: 'tool' | 'cable' | 'box' };
const ITEMS: Item[] = Array.from({ length: 7 }, (_, i) => ({
  id: `i${i}`,
  name: ['Drill', 'HDMI cable', 'Box 3', 'Saw', 'USB cable', 'Box 5', 'Hammer'][i] as string,
  kind: (['tool', 'cable', 'box', 'tool', 'cable', 'box', 'tool'] as const)[i] as Item['kind'],
}));
const PAGE = 3;

function fetchPage(q: string, kind: string | undefined, cursor: number, desc = false): Page<Item> {
  const kinds = kind?.split(',');
  const all = ITEMS.filter(
    (x) =>
      (!q || x.name.toLowerCase().includes(q.toLowerCase())) && (!kinds || kinds.includes(x.kind)),
  );
  if (desc) all.reverse();
  const items = all.slice(cursor, cursor + PAGE);
  return { items, next_cursor: cursor + PAGE < all.length ? String(cursor + PAGE) : null };
}

const FILTERS: FilterDef[] = [
  {
    key: 'kind',
    label: 'Kind',
    kind: 'multi',
    hideZero: true,
    values: {
      from: 'static',
      options: [
        { value: 'tool', label: 'Tools', count: 3 },
        { value: 'cable', label: 'Cables', count: 2 },
        { value: 'lent', label: 'Lent', count: 0 },
      ],
    },
  },
];

function TestList() {
  const [list] = useListState();
  const kind = list.filters.kind?.join(',');
  // The fixture's own order is "A to Z"; `dir=desc` turns it around.
  const desc = list.dir === 'desc';
  const query = useInfiniteQuery({
    queryKey: ['items', list.q, kind, desc],
    queryFn: async ({ pageParam }) => fetchPage(list.q, kind, Number(pageParam ?? 0), desc),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  return (
    <ListSurface
      label="Things"
      query={query}
      filters={FILTERS}
      groups={[
        { value: 'none', label: 'None' },
        { value: 'kind', label: 'Kind', short: 'by kind' },
      ]}
      sorts={[
        { value: 'name', label: 'Name' },
        { value: 'added', label: 'Added', kind: 'date' },
      ]}
      layouts={[
        { value: 'list', label: 'List' },
        { value: 'photos', label: 'Photos', short: 'photos' },
      ]}
      getKey={(x) => x.id}
      groupOf={(x) => ({ key: x.kind, label: x.kind })}
      renderRow={(x) => (
        // The test router has its own routes, not the app's registered tree.
        <Link to={'/other' as never} className="block p-3">
          {x.name}
        </Link>
      )}
      empty={<p>Nothing here yet</p>}
    />
  );
}

async function renderList(path = '/list', locale: 'en' | 'ar' = 'en') {
  const root = createRootRoute({ component: Outlet });
  const listRoute = createRoute({
    getParentRoute: () => root,
    path: '/list',
    validateSearch: listSearch(['kind'], { view: z.optional(z.string()) }),
    component: TestList,
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    component: () => <h1>Other</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([listRoute, other]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = await renderUI(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
    { locale },
  );
  await screen.findByRole('list', { name: 'Things' });
  return { ...out, router };
}

const names = () =>
  within(screen.getByRole('list', { name: 'Things' }))
    .getAllByRole('link')
    .map((a) => a.textContent);
const display = () => screen.getByRole('button', { name: /^Display options/ });
const search = (router: { state: { location: { search: unknown } } }) =>
  router.state.location.search as Record<string, unknown>;

/** Filters (the phone's sheet, as jsdom has no media queries) → Kind → `value`, then Done. */
async function pick(user: Awaited<ReturnType<typeof renderList>>['user'], value: RegExp) {
  await user.click(screen.getByRole('button', { name: /^Filters/ }));
  const sheet = await screen.findByRole('dialog', { name: 'Filters' });
  await user.click(within(sheet).getByRole('option', { name: 'Kind' }));
  await user.click(within(sheet).getByRole('row', { name: value }));
  await user.click(within(sheet).getByRole('button', { name: 'Done' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ListSurface (the list standard, L88)', () => {
  it('typing updates the URL, and the list follows', async () => {
    const { user, router } = await renderList();
    await user.type(screen.getByRole('searchbox', { name: 'Search Things' }), 'cable');
    await waitFor(() => expect(search(router).q).toBe('cable'));
    await waitFor(() => expect(names()).toEqual(['HDMI cable', 'USB cable']));
  });

  it('Back restores the list: search, filter and all', async () => {
    const { user, router } = await renderList();
    await pick(user, /Cables/);
    await waitFor(() => expect(search(router)['f.kind']).toEqual(['cable']));
    await user.type(screen.getByRole('searchbox'), 'usb');
    await waitFor(() => expect(names()).toEqual(['USB cable']));
    await user.click(screen.getByRole('link', { name: 'USB cable' }));
    await screen.findByRole('heading', { name: 'Other' });
    act(() => router.history.back());
    await waitFor(() => expect(names()).toEqual(['USB cable']));
    expect(screen.getByRole('searchbox')).toHaveValue('usb');
    expect(screen.getByRole('button', { name: 'Kind: Cables' })).toBeInTheDocument();
  });

  it('reads its state from a linked URL', async () => {
    await renderList('/list?q=box');
    expect(names()).toEqual(['Box 3', 'Box 5']);
    expect(screen.getByRole('searchbox')).toHaveValue('box');
  });

  it('hides a zero-count value when the definition says so (D191)', async () => {
    const { user } = await renderList();
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await user.click(within(sheet).getByRole('option', { name: 'Kind' }));
    const rows = within(within(sheet).getByRole('grid', { name: 'Kind' })).getAllByRole('row');
    expect(rows.map((r) => r.textContent?.replace(/Only this.*/, ''))).toEqual([
      'Tools3',
      'Cables2',
    ]);
  });

  it('Load more follows the cursor and focuses the first new row', async () => {
    const { user } = await renderList();
    expect(names()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(names()).toHaveLength(6));
    expect(document.activeElement).toHaveTextContent('Saw');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(names()).toHaveLength(7));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('works from the keyboard: search, filters and chips', async () => {
    const { user, router } = await renderList();
    await user.tab();
    expect(screen.getByRole('searchbox')).toHaveFocus();
    await user.keyboard('saw');
    await waitFor(() => expect(names()).toEqual(['Saw']));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(search(router).q).toBeUndefined());
    await user.tab();
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await waitFor(() => expect(within(sheet).getByRole('option', { name: 'Kind' })).toHaveFocus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(within(sheet).getByRole('row', { name: /Tools/ })).toHaveFocus());
    await user.keyboard(' ');
    await waitFor(() => expect(search(router)['f.kind']).toEqual(['tool']));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(names()).toEqual(['Drill', 'Saw', 'Hammer']));
    // Backspace in the empty search box removes the last chip.
    screen.getByRole('searchbox').focus();
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(search(router)['f.kind']).toBeUndefined());
  });

  it('groups under headings, from the Display menu (D211)', async () => {
    const { user, router } = await renderList();
    await user.click(display());
    const sheet = await screen.findByRole('dialog', { name: 'Display' });
    await user.click(within(sheet).getByRole('menuitemradio', { name: 'Kind' }));
    await waitFor(() => expect(search(router).group).toBe('kind'));
    expect(screen.getAllByText('tool').length).toBeGreaterThan(0);
    expect(within(sheet).getByRole('menuitemradio', { name: 'Kind' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(display()).toHaveTextContent('Name · by kind');
    expect(display()).toHaveAccessibleName('Display options: sorted by Name, A to Z, by kind');
    // Back to the default writes nothing.
    await user.click(display());
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Display' })).getByRole('menuitemradio', {
        name: 'None',
      }),
    );
    await waitFor(() => expect(search(router).group).toBeUndefined());
  });

  it('the Display menu: Sort, its direction, Group and Layout, with no row of their own', async () => {
    const { user, router } = await renderList();
    expect(screen.queryByText('Group by')).toBeNull();
    expect(screen.queryByText('Sort by')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    // It sits in the strip's own row.
    expect(
      within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', {
        name: /^Display options/,
      }),
    ).toBe(display());
    expect(display()).toHaveTextContent(/^Name$/);

    await user.click(display());
    let sheet = await screen.findByRole('dialog', { name: 'Display' });
    let menu = within(sheet).getByRole('menu', { name: 'Display options' });
    expect(within(menu).getByText('Sort')).toBeInTheDocument();
    expect(within(menu).getByText('Group')).toBeInTheDocument();
    expect(within(menu).getByText('Layout')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Words go A to Z / Z to A.
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Z to A' }));
    await waitFor(() => expect(search(router).dir).toBe('desc'));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(names()).toEqual(['Hammer', 'Box 5', 'USB cable']));
    expect(display()).toHaveAccessibleName('Display options: sorted by Name, Z to A');
    await user.click(display());
    sheet = await screen.findByRole('dialog', { name: 'Display' });
    menu = within(sheet).getByRole('menu', { name: 'Display options' });
    // Dates go Newest first / Oldest first, and a new kind of sort starts at its own default.
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Added' }));
    await waitFor(() => expect(search(router)).toMatchObject({ sort: 'added' }));
    expect(search(router).dir).toBeUndefined();
    expect(within(menu).queryByRole('menuitemradio', { name: 'A to Z' })).toBeNull();
    expect(within(menu).getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Oldest first' }));
    await waitFor(() => expect(search(router).dir).toBe('asc'));
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Photos' }));
    await waitFor(() => expect(search(router).view).toBe('photos'));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(display()).toHaveTextContent('Added · photos');
    expect(display()).toHaveAccessibleName(
      'Display options: sorted by Added, Oldest first, photos',
    );
  });

  it('reads sort, dir, group and view from a linked URL', async () => {
    await renderList('/list?sort=added&dir=asc&group=kind&view=photos');
    expect(display()).toHaveTextContent('Added · by kind · photos');
    expect(display()).toHaveAccessibleName(
      'Display options: sorted by Added, Oldest first, by kind, photos',
    );
    // On a narrow phone only the sort's name stays; nothing is cut short with an ellipsis.
    expect(display().innerHTML).not.toMatch(/truncate|text-ellipsis|line-clamp/);
    expect(display().querySelector('.min-\\[420px\\]\\:inline')).toHaveTextContent(
      '· by kind · photos',
    );
  });

  it('the Display menu is a popover menu from 768 px, and Escape returns focus', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 768px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { user, router } = await renderList();
    await user.click(display());
    // The menu is named by its button.
    const menu = await screen.findByRole('menu', { name: /^Display options/ });
    expect(screen.queryByRole('dialog', { name: 'Display' })).toBeNull();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Z to A' }));
    await waitFor(() => expect(search(router).dir).toBe('desc'));
    // It stays open for the next choice; Escape closes it.
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(display()).toHaveFocus());
  });

  it('the Display menu from the keyboard: Enter opens, arrows move, Escape returns focus', async () => {
    const { user, router } = await renderList();
    display().focus();
    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog', { name: 'Display' });
    await waitFor(() =>
      expect(within(sheet).getByRole('menuitemradio', { name: 'Name' })).toHaveFocus(),
    );
    await user.keyboard('{ArrowDown}');
    expect(within(sheet).getByRole('menuitemradio', { name: 'Added' })).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(search(router).sort).toBe('added'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Display' })).toBeNull());
    await waitFor(() => expect(display()).toHaveFocus());
  });

  it('shows the empty state when nothing is narrowed, "nothing matches" when it is', async () => {
    const { user } = await renderList();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('renders right to left with logical CSS only', async () => {
    await renderList('/list', 'ar');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(names()).toHaveLength(3);
    expectLogicalOnly();
  });

  it('a malformed URL value is ignored, never thrown', async () => {
    // `q=3` arrives as the number 3; `f.kind` as an object.
    await renderList('/list?f.kind=%7B%22x%22%3A1%7D&q=3');
    expect(screen.getByRole('searchbox')).toHaveValue('3');
    expect(names()).toEqual(['Box 3']);
  });
});
