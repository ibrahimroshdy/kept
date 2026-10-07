/**
 * The collapsible sidebar (D198): the foot button and ⌘\ / Ctrl+\ fold it to an icon rail, the
 * choice is kept per device, tablets start on the rail, every rail entry keeps its name and shows
 * it in a tooltip, and counts become badges.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { createMockApi } from '@/api/mock/server';
import { isSidebarShortcut, MainShell } from '@/components/app-shell';
import { SIDEBAR_KEY, setSidebarPref } from '@/lib/prefs';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly, renderUI } from '@/test/render';

vi.setConfig({ testTimeout: 15_000 });

const TABLET = ['(min-width: 768px)'];
const DESKTOP = ['(min-width: 768px)', '(min-width: 1024px)'];

/** jsdom has no matchMedia: list the queries that match. */
function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

const stored = () => localStorage.getItem(SIDEBAR_KEY);
const sidebarState = () => document.documentElement.getAttribute('data-sidebar');
const mainNav = () =>
  screen
    .getAllByRole('navigation', { name: 'Main' })
    .find((n) => within(n).queryByText('Activity')) as HTMLElement;

afterEach(() => {
  // prefs.ts keeps the resolved state in memory across renders in one file.
  setSidebarPref('auto');
});

describe('folding the sidebar', () => {
  it('the foot button folds it to the rail and back, and remembers the choice', async () => {
    media(DESKTOP);
    const { user } = await renderApp('/');
    await findHeading('Home');
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse).toHaveAttribute('aria-controls', 'kept-sidebar');
    expect(sidebarState()).toBe('expanded');

    await user.click(collapse);
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(sidebarState()).toBe('collapsed');
    expect(stored()).toBe('collapsed');
    // The rail swaps the lockup for the square mark.
    expect(
      within(document.getElementById('kept-sidebar') as HTMLElement).getByRole('img', {
        name: 'Kept',
      }),
    ).toBeInTheDocument();

    await user.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(stored()).toBe('expanded');
  });

  it('⌘\\ and Ctrl+\\ toggle it, and keep focus on the entry that had it', async () => {
    media(DESKTOP);
    const { user } = await renderApp('/');
    await findHeading('Home');
    const settings = within(mainNav()).getByRole('link', { name: 'Settings' });
    settings.focus();

    await user.keyboard('{Meta>}\\{/Meta}');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    // The rail re-renders its entries inside tooltips; focus comes back to the same one.
    expect(document.activeElement).toHaveAttribute('data-nav', 'settings');

    await user.keyboard('{Control>}\\{/Control}');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute('data-nav', 'settings');
  });

  it('the shortcut does nothing while typing in a field', async () => {
    media(DESKTOP);
    const { user } = await renderApp('/');
    await findHeading('Home');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await user.keyboard('{Control>}\\{/Control}');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(stored()).toBeNull();
    input.remove();
  });

  it('matches ⌘\\ and Ctrl+\\ only, by key or by the physical key', () => {
    const e = {
      key: '\\',
      code: 'Backslash',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(isSidebarShortcut({ ...e, metaKey: true })).toBe(true);
    expect(isSidebarShortcut({ ...e, ctrlKey: true })).toBe(true);
    // An Arabic layout sends another character from the same key.
    expect(isSidebarShortcut({ ...e, key: 'ذ', ctrlKey: true })).toBe(true);
    expect(isSidebarShortcut(e)).toBe(false);
    expect(isSidebarShortcut({ ...e, ctrlKey: true, shiftKey: true })).toBe(false);
  });
});

describe('where it starts', () => {
  it('a stored choice wins', async () => {
    media(DESKTOP);
    localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    await renderApp('/');
    await findHeading('Home');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('tablets (768–1023 px) start on the rail, without storing anything', async () => {
    media(TABLET);
    await renderApp('/');
    await findHeading('Home');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(sidebarState()).toBe('collapsed');
    expect(stored()).toBeNull();
  });

  it('1024 px and up start expanded', async () => {
    media(DESKTOP);
    await renderApp('/');
    await findHeading('Home');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('tablets get the search and Capture icon buttons in the top bar', async () => {
    media(TABLET);
    const { user } = await renderApp('/');
    await findHeading('Home');
    // The icon link is named by aria-label; the phone tab bar and the full button have text.
    const capture = screen.getAllByRole('link', { name: 'Capture' });
    expect(capture.some((l) => l.getAttribute('aria-label') === 'Capture')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeInTheDocument();
  });
});

describe('the rail', () => {
  it('every entry keeps its accessible name, and shows it in a tooltip on keyboard focus', async () => {
    media(TABLET);
    const { user } = await renderApp('/');
    await findHeading('Home');
    // Labels shows once the locations say the module is on somewhere (screens §1), and the
    // Inbox's count once Home's counts arrive (T22).
    await within(mainNav()).findByRole('link', { name: 'Labels' });
    await within(mainNav()).findByRole('link', { name: /^Inbox \d+$/ });
    // And the notifications' unread count (T24).
    await within(mainNav()).findByRole('link', { name: /^Notifications \d+$/ });
    const links = within(mainNav()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Home',
      expect.stringMatching(/^Inbox ?\d+$/),
      'Vehicles',
      'Schedules',
      'Lending',
      'Paperwork',
      // The mock's Home has Consumables on since step 7 (T23's fixture).
      'Consumables',
      'Insights',
      'Labels',
      'Activity',
      'Trash',
      expect.stringMatching(/^Notifications ?\d+$/),
      'Settings',
      'Help',
    ]);
    const locations = screen.getByRole('navigation', { name: 'Locations' });
    expect(await within(locations).findByRole('link', { name: 'Garage' })).toBeInTheDocument();
    // On the footer, the rail's last entry is a full 44 px target (UI review steps 6–8, L17).
    expect(within(locations).getByRole('link', { name: 'New location' })).toHaveClass(
      'h-11',
      'min-h-11',
    );

    // Tab from the start: the square mark, Home, then Inbox.
    await user.tab();
    await user.tab();
    await user.tab();
    const inbox = within(mainNav()).getByRole('link', { name: /^Inbox/ });
    expect(inbox).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Inbox');
    expect(inbox).toHaveAttribute('aria-describedby', tip.id);

    // Vehicles is a page since step 5 (plan T3): a plain link with its name in the tooltip.
    await user.tab();
    const vehicles = within(mainNav()).getByRole('link', { name: 'Vehicles' });
    expect(vehicles).toHaveFocus();
    expect(vehicles).not.toHaveAttribute('aria-disabled');
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/^Vehicles$/));

    // Entries from later steps take focus in the rail so their tooltip can be read: Insights,
    // after Schedules, Lending, Paperwork and Consumables.
    for (let i = 0; i < 5; i++) await user.tab();
    const insights = within(mainNav()).getByRole('link', { name: 'Insights' });
    expect(insights).toHaveFocus();
    expect(insights).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('InsightsComing soon'),
    );
  });

  it('the source code link stays, as an icon with the version in its tooltip (D147)', async () => {
    media(TABLET);
    const { user } = await renderApp('/');
    await findHeading('Home');
    // Let the entries settle first: Labels arrives with the locations (screens §1), the Inbox's
    // count with Home's counts (T22), the notifications' with their own (T24).
    await within(mainNav()).findByRole('link', { name: 'Labels' });
    await within(mainNav()).findByRole('link', { name: /^Inbox \d+$/ });
    await within(mainNav()).findByRole('link', { name: /^Notifications \d+$/ });
    const source = await screen.findByRole('link', { name: 'Source code' });
    // Keyboard focus (React Aria opens tooltips on focus when the last input was a key).
    await user.keyboard('{Shift}');
    act(() => source.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('v0.1.0');
  });

  it('renders mirrored in Arabic with logical CSS only', async () => {
    media(TABLET);
    await renderApp('/', { locale: 'ar' });
    await findHeading('الرئيسية');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    const toggle = screen.getByRole('button', { name: 'توسيع الشريط الجانبي' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expectLogicalOnly(document.getElementById('kept-sidebar') as HTMLElement);
  });
});

describe('counts', () => {
  async function renderShell() {
    const mock = createMockApi(ownerScenario());
    vi.stubGlobal('fetch', mock.fetch);
    const rootRoute = createRootRoute({
      component: () => (
        <MainShell locations={[]} counts={{ inbox: 4, trash: 120 }}>
          <p>page</p>
        </MainShell>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = await renderUI(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await screen.findByText('page');
    return result;
  }

  it('show after the label, then as a badge on the rail icon', async () => {
    media(DESKTOP);
    const { user } = await renderShell();
    expect(within(mainNav()).getByRole('link', { name: 'Inbox 4' })).toBeInTheDocument();
    expect(within(mainNav()).getByRole('link', { name: 'Trash 99+' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const inbox = within(mainNav()).getByRole('link', { name: 'Inbox 4' });
    const badge = within(inbox).getByText('4');
    expect(badge.className).toMatch(/rounded-full/);
    expect(within(inbox).getByText('Inbox')).toHaveClass('sr-only');
  });
});
