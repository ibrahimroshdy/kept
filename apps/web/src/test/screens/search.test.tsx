/**
 * Search and the ⌘K palette (task 27; D42, D74, D195, screens §5 and §8), against the mock
 * server: Arabic matching, aliases, the container photo, did-you-mean, filters and saved views
 * in the URL, recent searches per person, keyboard operation, RTL, and the viewer variant.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { searchMatches } from '@/api/inventory/mock/search';
import { inventoryPaths } from '@/api/inventory/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import type { MockApi } from '@/api/mock/server';
import { isPaletteShortcut } from '@/components/search/palette-host';
import { readRecent, recentKey, withRecent } from '@/components/search/recent';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { filterBy, openFilters } from '@/test/filters';
import { expectLogicalOnly } from '@/test/render';

const T = INV_IDS.thing;

function asRole(role: 'viewer' | 'member' | 'admin', state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = role;
  return state;
}

/** Every request URL (with its query string) from now on. */
function spyUrls(mock: MockApi): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return mock.fetch(input, init);
  });
  return urls;
}

const things = (name = 'Things found') => screen.findByRole('list', { name }, { timeout: 3000 });
const resultNames = async (list = 'Things found') =>
  within(await things(list))
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');

describe('search', () => {
  it('finds the HDMI cable by hdmi, with its full path, ID chip and location groups (D74)', async () => {
    await renderApp('/search?q=hdmi');
    await findHeading('Search');
    const list = await things();
    const cable = within(list).getByRole('link', { name: /HDMI cable, 2 m/ });
    // Links use the short ID (D208).
    expect(cable).toHaveAttribute('href', '/t/7KQ4MZ');
    expect(cable.textContent).toContain('Home › Office › Desk drawer › Cable box');
    expect(within(cable).getByRole('img', { name: '7KQ4MZ' })).toBeInTheDocument();
    // The matched word is marked.
    expect(within(cable).getByText('HDMI').tagName).toBe('MARK');
    // Things from two locations: each gets its heading ("Home · 1", "بيت العائلة · 1").
    expect([...list.querySelectorAll('[role="presentation"]')].map((h) => h.textContent)).toEqual([
      'Home · 1',
      'بيت العائلة · 1',
    ]);
  });

  it.each([
    ['الكابل', 'كابل HDMI'], // the article is stripped at query time (screens §8)
    ['مكواه', 'مِكْواة البُخار'], // ة ↔ ه and harakat ignored (D42)
    ['٥٥', 'Samsung TV, 55″'], // Eastern Arabic digits (D42)
    ['cable', 'HDMI cable, 2 m'],
  ])('%s finds %s', async (q, name) => {
    await renderApp(`/search?q=${encodeURIComponent(q)}`);
    expect((await resultNames()).some((n) => n.includes(name))).toBe(true);
  });

  it('says which alias matched (screens §8)', async () => {
    await renderApp('/search?q=display');
    const cable = within(await things()).getByRole('link', { name: /HDMI cable, 2 m/ });
    expect(cable.textContent).toContain('matched: display cable');
  });

  it("shows the container's photo beside the path (D195)", async () => {
    const state = ownerScenario();
    const box = state.inventory.things.find((x) => x.id === T.cableBox);
    if (box) box.thumbUrl = '/f/cable-box-thumb';
    await renderApp('/search?q=hdmi', { state });
    const cable = within(await things()).getByRole('link', { name: /HDMI cable, 2 m/ });
    const photo = cable.querySelector('img[data-container-photo]');
    expect(photo).toHaveAttribute('src', '/f/cable-box-thumb');
    expect(photo).toHaveAttribute('alt', '');
  });

  it('with nothing found, says so and offers did-you-mean', async () => {
    const { user, router } = await renderApp('/search?q=hmdi');
    expect(await screen.findByText(/No match for/)).toHaveTextContent('No match for ‘hmdi’');
    await user.click(screen.getByRole('button', { name: 'HDMI cable, 2 m' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: 'HDMI cable, 2 m' }),
    );
    expect(await resultNames()).toEqual([expect.stringContaining('HDMI cable, 2 m')]);
  });

  it('typing searches after a pause and keeps the words in the URL', async () => {
    const { user, router } = await renderApp('/search');
    const box = await screen.findByRole('searchbox', { name: 'Search everything' });
    expect(box).toHaveFocus();
    await user.type(box, 'drill');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'drill' }));
    expect((await resultNames()).some((n) => n.includes('Bosch drill'))).toBe(true);
  });

  it('shows places, people and vendors in their own groups', async () => {
    await renderApp('/search?q=kitchen');
    const places = await screen.findByRole('heading', { name: /Places/ });
    const section = places.closest('section') as HTMLElement;
    expect(within(section).getByRole('link', { name: /Kitchen/ })).toHaveAttribute(
      'href',
      `/p/${INV_IDS.place.kitchen}`,
    );
  });

  /** A PDF manual on the drill and a receipt beside it, both in Home, with their text (T21). */
  function withDocuments(state: MockState = ownerScenario()): MockState {
    const file = (id: string) => ({
      id,
      sha256: id.padEnd(64, '0').slice(0, 64),
      bytes: 1000,
      mime: 'application/pdf',
      class: 'document' as const,
      hasGps: false,
      width: null,
      height: null,
      derivativeState: 'not_applicable' as const,
      thumbUrl: null,
      displayUrl: null,
    });
    const doc = (id: string, role: 'manual' | 'receipt', fileId: string) => ({
      id,
      role,
      sort: 0,
      file: file(fileId),
      url: null,
      subject: { thingId: T.drill },
      createdBy: { displayName: 'Ibrahim' },
      rowVersion: 1,
      locationId: IDS.home,
    });
    state.inventory.attachments.push(
      doc('a-manual', 'manual', 'f-manual'),
      doc('a-receipt', 'receipt', 'f-receipt'),
    );
    state.inventory.fileText = {
      'f-manual':
        'Bosch GSR 18V. Descaling: <b>never</b> use the chuck key when the torque clutch is set.',
      'f-receipt': 'B.TECH Nasr City. 1 x torque driver 2,450.00 EGP',
    };
    return state;
  }

  it('finds documents by their text, each with an excerpt as plain text (T21)', async () => {
    await renderApp('/search?q=torque', { state: withDocuments() });
    const heading = await screen.findByRole('heading', { name: /Documents/ });
    const section = heading.closest('section') as HTMLElement;
    const links = within(section).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([`/t/${T.drill}`, `/t/${T.drill}`]);
    expect(within(section).getByText(/^Manual ·/)).toBeInTheDocument();
    expect(within(section).getByText(/^Receipt ·/)).toBeInTheDocument();
    // The excerpt is text: its markup shows as typed, and only the matched word is marked.
    const snippets = section.querySelectorAll('[data-snippet]');
    expect(snippets).toHaveLength(2);
    expect(snippets[0]?.textContent).toContain('<b>never</b>');
    expect(section.querySelector('b')).toBeNull();
    expect(within(section).getAllByText('torque', { selector: 'mark' }).length).toBeGreaterThan(0);
  });

  it('where money is hidden: no receipt, and no excerpt of the others', async () => {
    await renderApp('/search?q=torque', { state: withDocuments(asRole('viewer')) });
    const heading = await screen.findByRole('heading', { name: /Documents/ });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText(/^Manual ·/)).toBeInTheDocument();
    expect(within(section).queryByText(/^Receipt ·/)).toBeNull();
    expect(section.querySelector('[data-snippet]')).toBeNull();
  });

  it('offline, documents say they need a connection (screens §8)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderApp('/search?q=torque', { state: withDocuments() });
    expect(await screen.findByText('Documents need a connection')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('a filter works by keyboard and lives in the URL (D205)', async () => {
    const { user, router, mock } = await renderApp('/search?q=cable');
    await things();
    const urls = spyUrls(mock);
    const sheet = await openFilters(user);
    // Type to find the field: fuzzy, so a typo still finds State.
    await user.type(within(sheet).getByRole('searchbox', { name: 'Find a filter' }), 'stte');
    await user.click(within(sheet).getByRole('option', { name: 'State' }));
    const values = within(sheet).getByRole('grid', { name: 'State' });
    await user.click(within(values).getByRole('row', { name: /^Ended/ }));
    await user.click(within(values).getByRole('row', { name: /^Draft/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ 'f.state': ['ended', 'draft'] }),
    );
    await waitFor(() =>
      expect(
        urls.some((u) => u.includes('/api/v1/search?') && u.includes('state=ended&state=draft')),
      ).toBe(true),
    );
    // "Only this" keeps one.
    await user.click(within(values).getByRole('button', { name: 'Only this: Draft' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ 'f.state': ['draft'] }),
    );
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    // The chip names its value and can be removed.
    expect(screen.getByRole('button', { name: 'State: Draft' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the State filter' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('f.state'));
  });

  it('a place filter narrows to the subtree', async () => {
    const { user, mock } = await renderApp('/search?q=cable');
    await things();
    const urls = spyUrls(mock);
    await filterBy(user, 'Place', [/^Office/]);
    await waitFor(() =>
      expect(urls.some((u) => u.includes(`placeId=${INV_IDS.place.office}`))).toBe(true),
    );
    // Only the Office subtree is left (the cable and the box it's in), not the rest of Home.
    await waitFor(async () => {
      const names = await resultNames();
      expect(names.some((n) => n.includes('HDMI cable, 2 m'))).toBe(true);
      expect(names.every((n) => n.includes('Office'))).toBe(true);
    });
  });

  it('finds a tag by typing, in Arabic too, through the server (D205)', async () => {
    const { user, mock } = await renderApp('/search?q=cable');
    await things();
    const urls = spyUrls(mock);
    const sheet = await openFilters(user, 'Tag');
    await user.type(within(sheet).getByRole('searchbox', { name: 'Find a tag' }), 'cab');
    await waitFor(() => expect(urls.some((u) => /\/tags\?q=cab/.test(u))).toBe(true));
  });

  it('remembers searches per person on this device, and a recent one searches again', async () => {
    const { user, router } = await renderApp('/search');
    const box = await screen.findByRole('searchbox', { name: 'Search everything' });
    await user.type(box, 'kettle{Enter}');
    await waitFor(() => expect(readRecent(IDS.ibrahim)).toEqual(['kettle']));
    expect(localStorage.getItem(recentKey('u-alfred'))).toBeNull();
    await user.clear(box);
    const recent = await screen.findByRole('group', { name: 'Recent searches' });
    await user.click(within(recent).getByRole('button', { name: 'kettle' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'kettle' }));
  });

  it('recent searches fold spellings that normalise the same', () => {
    expect(withRecent(['الكابل', 'drill'], 'الكابل ')).toEqual(['الكابل', 'drill']);
    expect(withRecent(['HDMI'], 'hdmi')).toEqual(['hdmi']);
    expect(
      withRecent(
        Array.from({ length: 8 }, (_, i) => `q${i}`),
        'new',
      ),
    ).toHaveLength(8);
  });

  it('saves a search, shares it with Home, and opens it again (D183, D205)', async () => {
    const { user, mock, router } = await renderApp('/search?q=cable&f.state=%5B%22ended%22%5D');
    await screen.findByText(/No match for|Things/);
    await user.click(screen.getByRole('button', { name: 'Views' }));
    const menu = await screen.findByRole('dialog', { name: 'Saved views' });
    await user.click(within(menu).getByRole('button', { name: 'Save view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    const name = within(dialog).getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, 'Old cables');
    await user.click(within(dialog).getByRole('radio', { name: /Everyone in Home/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.savedViews)?.body).toEqual({
        name: 'Old cables',
        surface: 'search',
        query: { q: 'cable', filters: { state: ['ended'] } },
        sharedLocationId: IDS.home,
      }),
    );
    // Pinned by default: a tab above the strip, and the URL names the view.
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.savedViewPrefs('search'))?.body).toMatchObject({
        pinned: [expect.any(String)],
      }),
    );
    const tabs = await screen.findByRole('group', { name: 'Pinned views' });
    expect(within(tabs).getByRole('button', { name: 'Old cables' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await router.navigate({ to: '/search' });
    const saved = await screen.findByRole('list', { name: 'Saved searches' });
    expect(within(saved).getByText(/Shared with Home/)).toBeInTheDocument();
    await user.click(within(saved).getByRole('button', { name: /^Old cables/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: 'cable', 'f.state': ['ended'] }),
    );
  });

  it('a viewer saves searches for themselves only', async () => {
    const state = asRole('viewer');
    // Ibrahim is only a viewer in Home and a member of the family home: keep only Home shared.
    state.locations = state.locations.filter((l) => l.id !== INV_IDS.loc.family);
    state.locations = state.locations.filter((l) => l.id !== IDS.garage);
    const { user } = await renderApp('/search?q=cable', { state });
    await user.click(await screen.findByRole('button', { name: 'Views' }));
    const menu = await screen.findByRole('dialog', { name: 'Saved views' });
    await user.click(within(menu).getByRole('button', { name: 'Save view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save view' });
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).queryByText(/Everyone in/)).toBeNull();
  });

  it('renders right to left in Arabic, with logical CSS only', async () => {
    await renderApp('/search?q=كابل', { locale: 'ar' });
    await things('الأشياء التي عُثر عليها');
    expect(document.documentElement.dir).toBe('rtl');
    expect((await resultNames('الأشياء التي عُثر عليها')).some((n) => n.includes('كابل HDMI'))).toBe(
      true,
    );
    expectLogicalOnly();
  });
});

describe("the mock's matching mirrors the server's normalised forms (D42, screens §8)", () => {
  it.each([
    ['مكتبة', 'مكتبه', true], // ة ↔ ه
    ['الكابل', 'كابل', true], // the article, at query time
    ['بالكابلات', 'كابل', true], // ب + ال on the indexed word
    ['وَرَق', 'ورق', true], // harakat
    ['ورق', 'رق', false], // a lone و is never stripped (Q20)
    ['Samsung TV, 55″', '٥٥', true], // Eastern Arabic digits
    ['HDMI cable', 'hd cab', true], // every word, as a prefix
    ['HDMI cable', 'hdmi box', false],
  ])('%s ~ %s → %s', (text, q, hit) => {
    expect(searchMatches(text, q)).toBe(hit);
  });
});

describe('the ⌘K palette', () => {
  it('⌘K and Ctrl+K are the shortcut; plain K is not', () => {
    const k = { key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isPaletteShortcut({ ...k, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...k, ctrlKey: true, key: 'K' })).toBe(true);
    expect(isPaletteShortcut(k)).toBe(false);
    expect(isPaletteShortcut({ ...k, ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it('Ctrl+K opens it; type, arrow down, Enter opens the thing', async () => {
    const { user, router, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const urls = spyUrls(mock);
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    const input = within(dialog).getByRole('combobox', { name: 'Search or jump to' });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, 'hdmi');
    const cable = await within(dialog).findByRole('option', { name: /HDMI cable, 2 m/ });
    await waitFor(() =>
      expect(urls.some((u) => u.includes('kind=things') && u.includes('limit=8'))).toBe(true),
    );
    // The first result is active; ArrowDown moves to the next, ArrowUp back.
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', cable.id));
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).not.toBe(cable.id);
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', cable.id);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(pathOf(router)).toBe('/t/7KQ4MZ'));
    expect(screen.queryByRole('dialog', { name: 'Search or jump to' })).toBeNull();
  });

  it('⌘K from the top bar button too, jumps to a place, and Escape closes it', async () => {
    const { user, router } = await renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Search or jump to/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.type(within(dialog).getByRole('combobox'), 'desk');
    const desk = await within(dialog).findByRole('option', { name: /Desk drawer/ });
    expect(desk.textContent).toContain('Home › Office');
    await user.click(desk);
    await waitFor(() => expect(pathOf(router)).toBe(`/p/${INV_IDS.place.deskDrawer}`));
  });

  it('offers actions, and hands the words to the search page', async () => {
    const { user, router } = await renderApp('/');
    await screen.findByRole('button', { name: /Search or jump to/ }, { timeout: 3000 });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    expect(within(dialog).getByRole('option', { name: /Trash/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: /Ask the assistant/ })).not.toHaveAttribute(
      'aria-disabled',
    );
    await user.type(within(dialog).getByRole('combobox'), 'passport');
    await user.click(await within(dialog).findByRole('option', { name: /Search for “passport”/ }));
    await waitFor(() => expect(pathOf(router)).toBe('/search'));
    expect(router.state.location.search).toMatchObject({ q: 'passport' });
  });

  // Step 6 (T19): "Ask the assistant about …" opens the assistant with the words typed so far in
  // its composer, unsent (D42), on the page it was asked from.
  it('hands the words to the assistant', async () => {
    const { user, router } = await renderApp('/');
    await screen.findByRole('button', { name: /Search or jump to/ }, { timeout: 3000 });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.type(within(dialog).getByRole('combobox'), 'where is the drill');
    await user.click(
      await within(dialog).findByRole('option', {
        name: /Ask the assistant about “where is the drill”/,
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Assistant' }, { timeout: 3000 });
    expect(within(sheet).getByRole('textbox', { name: 'Ask about your things' })).toHaveValue(
      'where is the drill',
    );
    expect(pathOf(router)).toBe('/');
  });

  it('works in Arabic, right to left', async () => {
    const { user } = await renderApp('/', { locale: 'ar' });
    await screen.findAllByRole('navigation', {}, { timeout: 3000 });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'الكابل');
    expect(await within(dialog).findByRole('option', { name: /كابل HDMI/ })).toBeInTheDocument();
    expectLogicalOnly(dialog);
  });
});
