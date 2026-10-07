/**
 * The filter strip (D205): fuzzy Arabic-aware matching, the URL → endpoint mapping, the keyboard,
 * "is none of", the desktop popover, and saved views (save, pinned tabs, the default view, Save
 * changes, All) against the mock server.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryPaths } from '@/api/inventory/paths';
import type { SavedView } from '@/api/inventory/types';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { renderApp } from '@/test/app';
import { filterBy, openFilters } from '@/test/filters';
import { expectLogicalOnly } from '@/test/render';
import { fuzzyFilter, fuzzyScore } from './fuzzy';
import { dateBounds, filterParams } from './params';
import { isModified, queryOf, stateOf } from './views-api';

vi.setConfig({ testTimeout: 20_000 });

const feed = () => screen.findByRole('list', { name: 'Activity' }, { timeout: 3000 });
/** The "You changed …" notice: scoped by its words, as the app shell may hold other status
 * regions (sync, offline, plain HTTP). */
const isChanged = (el: HTMLElement) => el.textContent?.startsWith('You changed') ?? false;
const changedNotice = () =>
  waitFor(() => {
    const el = screen.queryAllByRole('status').find(isChanged);
    expect(el).toBeDefined();
    return el as HTMLElement;
  });
const articles = () =>
  within(screen.getByRole('list', { name: 'Activity' }))
    .getAllByRole('article')
    .map((a) => a.textContent ?? '');

function withView(view: Partial<SavedView>, prefs?: MockState['inventory']['savedViewPrefs']) {
  const state = ownerScenario();
  state.inventory.savedViews.push({
    id: 'v-alfred',
    name: 'Alfred’s changes',
    surface: 'activity',
    query: { filters: { actor: ['u-alfred'] } },
    sharedLocationId: null,
    createdBy: { displayName: state.me.user.displayName },
    mine: true,
    rowVersion: 1,
    ...view,
  });
  if (prefs) state.inventory.savedViewPrefs = prefs;
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fuzzy matching (the shared normaliser)', () => {
  it.each([
    ['الكابل', 'كابل HDMI', true], // the article is dropped from the typed word
    ['مكتبه', 'مكتبة المنزل', true], // ة ↔ ه
    ['ابراهيم', 'إبراهيم', true], // alef forms
    ['bru', 'Bruce', true],
    ['brc', 'Bruce', false], // a three-letter word gets no typo allowance
    ['persn', 'Person', true], // one edit in a longer word
    ['kind', 'Person', false],
  ])('%s against %s: %s', (q, text, hit) => {
    expect(fuzzyScore(q, text) !== null).toBe(hit);
  });

  it('ranks a start before a later word before a substring', () => {
    expect(fuzzyFilter(['Tablecloth', 'Big table', 'Stable'], 'tab', (x) => x)).toEqual([
      'Tablecloth',
      'Big table',
      'Stable',
    ]);
  });
});

describe('from the URL to an endpoint', () => {
  const list = {
    q: '',
    filters: { actor: ['a', 'b'], kind: ['thing'], when: ['week'] },
    not: ['kind'],
    savedView: undefined,
    group: undefined,
    sort: undefined,
  };

  it('repeats values and names the "none of" parameters', () => {
    expect(filterParams(list, { actor: 'actorId', kind: 'entityType' })).toEqual({
      actorId: ['a', 'b'],
      entityType: ['thing'],
      not: ['entityType'],
    });
  });

  it('turns a date preset or range into local-midnight bounds', () => {
    const now = new Date(2026, 8, 26, 15, 30);
    expect(dateBounds('today', now)).toEqual({ from: new Date(2026, 8, 26).toISOString() });
    expect(dateBounds('week', now)).toEqual({ from: new Date(2026, 8, 20).toISOString() });
    expect(dateBounds('year', now)).toEqual({ from: new Date(2026, 0, 1).toISOString() });
    expect(dateBounds('2026-09-01..2026-09-10', now)).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });
    expect(dateBounds('nonsense', now)).toEqual({});
  });
});

describe('a saved view keeps the Display button’s state (D211)', () => {
  const list = {
    q: '',
    filters: { type: ['t-cable'] },
    not: [],
    savedView: undefined,
    group: 'type',
    sort: 'lastSeen',
    dir: 'asc' as const,
    layout: 'photos',
  };
  const view: SavedView = {
    id: 'v-photos',
    name: 'Oldest photos',
    surface: 'contents',
    query: queryOf(list, 'contents'),
    sharedLocationId: null,
    createdBy: { displayName: 'Ibrahim' },
    mine: true,
    rowVersion: 1,
  };

  it('saves the sort, its direction, the grouping and the layout', () => {
    expect(view.query).toEqual({
      filters: { type: ['t-cable'] },
      group: 'type',
      sort: 'lastSeen',
      dir: 'asc',
      layout: 'photos',
    });
  });

  it('opening it puts them back in the URL, and a changed direction or layout shows', () => {
    const opened = { ...list, ...stateOf(view, { ...list, group: undefined, sort: undefined }) };
    expect(opened).toMatchObject({ sort: 'lastSeen', dir: 'asc', layout: 'photos', group: 'type' });
    expect(isModified(view, opened)).toBe(false);
    expect(isModified(view, { ...opened, dir: '' })).toBe(true);
    expect(isModified(view, { ...opened, layout: '' })).toBe(true);
    // A view saved before D211 opens with the sort's own order and the default layout.
    const old = stateOf({ ...view, query: { sort: 'name' } }, list);
    expect(old).toMatchObject({ sort: 'name', dir: '', layout: '' });
  });
});

describe('the strip', () => {
  it('`/` focuses the search box, `F` opens the filters, Backspace removes the last chip', async () => {
    const { user, router } = await renderApp(
      '/activity?f.actor=%5B%22u-alfred%22%5D&f.kind=%5B%22thing%22%5D',
    );
    await feed();
    await user.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search activity' })).toHaveFocus();
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('f.kind'));
    expect(router.state.location.search).toMatchObject({ 'f.actor': ['u-alfred'] });
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('f');
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });

  it('arrow keys move between the chips, mirrored right to left', async () => {
    await renderApp('/activity?f.actor=%5B%22u-alfred%22%5D&f.kind=%5B%22thing%22%5D');
    await feed();
    const chips = await screen.findByRole('toolbar', { name: 'Filters in use' });
    const first = within(chips).getByRole('button', { name: 'Person: Alfred' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(within(chips).getByRole('button', { name: 'Remove the Person filter' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(within(chips).getByRole('button', { name: 'Clear all' })).toHaveFocus();
  });

  it('never cuts a chip short, and is logical CSS only in Arabic', async () => {
    await renderApp('/activity?f.actor=%5B%22u-alfred%22%5D', { locale: 'ar' });
    const chip = await screen.findByRole('toolbar', {}, { timeout: 3000 });
    expectLogicalOnly();
    expect(chip.innerHTML).not.toMatch(/truncate|text-ellipsis|line-clamp/);
  });

  it('opens a popover on desktop, anchored to "+ Filter"', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 768px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { user } = await renderApp('/activity');
    await feed();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const popover = await screen.findByRole('dialog', { name: 'Filter by' });
    await user.click(within(popover).getByRole('option', { name: 'Kind' }));
    await user.click(within(popover).getByRole('row', { name: /^Places/ }));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Kind: Places' })).toBeInTheDocument();
  });
});

describe('saved views (D205)', () => {
  it('opens the default view when the list is reached with nothing in its URL', async () => {
    const state = withView({}, { activity: { defaultViewId: 'v-alfred', pinned: ['v-alfred'] } });
    const { router } = await renderApp('/activity', { state });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        'f.actor': ['u-alfred'],
        saved: 'v-alfred',
      }),
    );
    const tabs = await screen.findByRole('group', { name: 'Pinned views' });
    expect(within(tabs).getByRole('button', { name: 'Alfred’s changes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(articles().every((a) => a.includes('Alfred'))).toBe(true));
  });

  it('a link with filters wins over the default view', async () => {
    const state = withView({}, { activity: { defaultViewId: 'v-alfred', pinned: [] } });
    const { router } = await renderApp('/activity?f.kind=%5B%22place%22%5D', { state });
    await feed();
    await new Promise((r) => setTimeout(r, 200));
    expect(router.state.location.search).not.toHaveProperty('f.actor');
  });

  it('changing an opened view offers Save changes, which patches it; All clears', async () => {
    const state = withView({}, { activity: { defaultViewId: null, pinned: ['v-alfred'] } });
    const { user, router, mock } = await renderApp('/activity', { state });
    const tabs = await screen.findByRole('group', { name: 'Pinned views' });
    await user.click(within(tabs).getByRole('button', { name: 'Alfred’s changes' }));
    await filterBy(user, 'Kind', [/^Things/]);
    const changed = await changedNotice();
    expect(changed).toHaveTextContent('You changed Alfred’s changes.');
    await user.click(within(changed).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', inventoryPaths.savedView('v-alfred'))?.body).toEqual({
        query: { filters: { actor: ['u-alfred'], kind: ['thing'] } },
      }),
    );
    await waitFor(() => expect(screen.queryAllByRole('status').filter(isChanged)).toEqual([]));
    await user.click(within(tabs).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('f.actor'));
    expect(router.state.location.search).not.toHaveProperty('saved');
  });

  it('someone else’s shared view can be saved as new, never changed', async () => {
    const state = withView(
      {
        mine: false,
        createdBy: { displayName: 'Alfred' },
        sharedLocationId: state0().locations[1]?.id ?? null,
      },
      { activity: { defaultViewId: null, pinned: ['v-alfred'] } },
    );
    const { user } = await renderApp('/activity', { state });
    const tabs = await screen.findByRole('group', { name: 'Pinned views' });
    await user.click(within(tabs).getByRole('button', { name: 'Alfred’s changes' }));
    await filterBy(user, 'Kind', [/^Things/]);
    const changed = await changedNotice();
    expect(within(changed).queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(within(changed).getByRole('button', { name: 'Save as new' })).toBeInTheDocument();
  });

  it('pins, unpins and sets the default from Views', async () => {
    const state = withView({}, { activity: { defaultViewId: null, pinned: [] } });
    const { user, mock } = await renderApp('/activity', { state });
    await feed();
    expect(screen.queryByRole('group', { name: 'Pinned views' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Views' }));
    const menu = await screen.findByRole('dialog', { name: 'Saved views' });
    await user.click(within(menu).getByRole('button', { name: 'Pin Alfred’s changes' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.savedViewPrefs('activity'))?.body).toEqual({
        pinned: ['v-alfred'],
        defaultViewId: null,
      }),
    );
    await user.click(
      await within(menu).findByRole('button', { name: 'Open Alfred’s changes first here' }),
    );
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.savedViewPrefs('activity'))?.body).toEqual({
        pinned: ['v-alfred'],
        defaultViewId: 'v-alfred',
      }),
    );
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('group', { name: 'Pinned views' })).toBeInTheDocument();
  });

  it('opening the menu from the Filters sheet keeps Save view for a filtered list only', async () => {
    const { user } = await renderApp('/activity');
    await feed();
    await user.click(screen.getByRole('button', { name: 'Views' }));
    const menu = await screen.findByRole('dialog', { name: 'Saved views' });
    expect(within(menu).getByRole('button', { name: 'Save view' })).toBeDisabled();
    await user.keyboard('{Escape}');
    const sheet = await openFilters(user, 'Kind');
    await user.click(within(sheet).getByRole('row', { name: /^Places/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Views' }));
    const again = await screen.findByRole('dialog', { name: 'Saved views' });
    expect(within(again).getByRole('button', { name: 'Save view' })).toBeEnabled();
  });
});

function state0() {
  return ownerScenario();
}
