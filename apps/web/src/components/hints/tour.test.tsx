/**
 * The full guided tour (D138): every section in GUIDED_SECTIONS has instruction copy, in
 * English and in Arabic, so a longer tour never points at a speechless step. The tour
 * popover's own buttons keep their labels in both languages too.
 */

import type { ModuleId } from '@kept/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { AppProviders } from '@/app-providers';
import { activateLocale } from '@/i18n/i18n';
import { renderUI } from '@/test/render';
import { useGuidedTourCopy, useTourCopy } from './hint-copy';
import {
  findSectionAnchor,
  GUIDED_SECTIONS,
  type GuidedGating,
  guidedAnchorForNavKey,
  isGuidedSectionAvailable,
  resolveGuidedSections,
  tourDeleter,
  useGuidedTour,
  waitForSectionAnchor,
} from './tour';
import { tourLedger } from './tour-ledger';
import { hintSlot } from './use-hint';

function LabelsProbe({ onCopy }: { onCopy: (c: ReturnType<typeof useTourCopy>) => void }) {
  onCopy(useTourCopy());
  return null;
}

function GuidedProbe({ onCopy }: { onCopy: (c: ReturnType<typeof useGuidedTourCopy>) => void }) {
  onCopy(useGuidedTourCopy());
  return null;
}

async function guidedCopyOf(locale: 'en' | 'ar') {
  const seen: { current: ReturnType<typeof useGuidedTourCopy> | null } = { current: null };
  await renderUI(<GuidedProbe onCopy={(c) => (seen.current = c)} />, { locale });
  if (!seen.current) throw new Error('no copy');
  return seen.current;
}

describe('the tour popover labels', () => {
  for (const locale of ['en', 'ar'] as const) {
    it(`names its buttons in ${locale}`, async () => {
      const seen: { current: ReturnType<typeof useTourCopy> | null } = { current: null };
      await renderUI(<LabelsProbe onCopy={(c) => (seen.current = c)} />, { locale });
      expect(seen.current?.labels.next, 'next').toBeTruthy();
      expect(seen.current?.labels.done, 'done').toBeTruthy();
      expect(seen.current?.labels.close, 'close').toBeTruthy();
    });
  }
});

describe('the guided tour copy', () => {
  it('covers every guided section in en and ar', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const copy = await guidedCopyOf(locale);
      for (const s of GUIDED_SECTIONS) {
        const entry = copy[s.id];
        expect(entry?.title, `${s.id} title`).toBeTruthy();
        expect(entry?.description, `${s.id} description`).toBeTruthy();
      }
    }
  });

  it('covers the empty-household New-location step in en and ar', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const copy = await guidedCopyOf(locale);
      expect(copy['new-location']?.title, 'new-location title').toBeTruthy();
      expect(copy['new-location']?.description, 'new-location description').toBeTruthy();
    }
  });
});

describe('guided section gating', () => {
  const MODULES: ModuleId[] = [
    'labels',
    'vehicles',
    'schedules',
    'lending',
    'paperwork',
    'consumables',
  ];
  const allOn: GuidedGating = { modulesOn: new Set(MODULES), hasInbox: true };

  it('shows everything to a member with every module on', () => {
    for (const s of GUIDED_SECTIONS) expect(isGuidedSectionAvailable(s.id, allOn)).toBe(true);
  });

  it('skips the inbox and the capture write for a viewer everywhere', () => {
    const viewer: GuidedGating = { modulesOn: new Set(MODULES), hasInbox: false };
    expect(isGuidedSectionAvailable('inbox', viewer)).toBe(false);
    expect(isGuidedSectionAvailable('capture', viewer)).toBe(false);
    // Reading stays: the location, search, and the module pages are point-only for a viewer.
    for (const id of ['home', 'location-detail', 'search', 'labels', 'finish']) {
      expect(isGuidedSectionAvailable(id, viewer)).toBe(true);
    }
  });

  it('skips a module section while its module is off anywhere', () => {
    const off: GuidedGating = {
      modulesOn: new Set(MODULES.filter((m) => m !== 'vehicles')),
      hasInbox: true,
    };
    expect(isGuidedSectionAvailable('vehicles', off)).toBe(false);
    expect(isGuidedSectionAvailable('schedules', off)).toBe(true);
  });
});

describe('guidedAnchorForNavKey', () => {
  it('ends Help at the tour anchor and leaves coming-soon keys empty', () => {
    expect(guidedAnchorForNavKey('help')).toBe('help-tour');
    expect(guidedAnchorForNavKey('vehicles')).toBe('vehicles');
    expect(guidedAnchorForNavKey('insights')).toBeUndefined();
    expect(guidedAnchorForNavKey('no-such-key')).toBeUndefined();
  });
});

describe('resolveGuidedSections', () => {
  it('fills the first location id into the location detail', () => {
    const resolved = resolveGuidedSections(GUIDED_SECTIONS, 'loc-1');
    const detail = resolved.find((s) => s.id === 'location-detail');
    expect(detail?.to).toBe('/loc/$id');
    expect(detail?.params).toEqual({ id: 'loc-1' });
    expect(detail?.copyId).toBe('location-detail');
  });

  it('routes an empty household through New location', () => {
    const resolved = resolveGuidedSections(GUIDED_SECTIONS, null);
    const detail = resolved.find((s) => s.id === 'location-detail');
    expect(detail?.to).toBe('/locations/new');
    expect(detail?.anchor).toBe('new-location-name');
    expect(detail?.copyId).toBe('new-location');
    expect(detail?.params).toBeUndefined();
  });
});

describe('section anchors', () => {
  it('finds the guided anchor on screen', async () => {
    await renderUI(
      <div data-tour="search-field">
        <input aria-label="search" />
      </div>,
    );
    expect(findSectionAnchor('search-field')?.getAttribute('data-tour')).toBe('search-field');
    expect(findSectionAnchor('no-such-anchor')).toBeNull();
  });

  it('waits for a late anchor and gives up within its bound', async () => {
    await expect(waitForSectionAnchor('search-field', 20)).resolves.toBeNull();
    const late = document.createElement('div');
    late.setAttribute('data-tour', 'late-anchor');
    const shown = waitForSectionAnchor('late-anchor', 1000);
    document.body.appendChild(late);
    await expect(shown).resolves.toBe(late);
    late.remove();
  });
});

describe('tourDeleter', () => {
  it('deletes through the existing fetchers and refuses label batches', async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ method: init?.method ?? 'GET', url: String(url) });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    );
    await tourDeleter('thing', 't1');
    await tourDeleter('place', 'p1');
    await tourDeleter('location', 'l1');
    await tourDeleter('capture', 'c1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringMatching(/^POST .*\/things\/t1\/trash$/),
      expect.stringMatching(/^POST .*\/places\/p1\/trash$/),
      expect.stringMatching(/^DELETE .*\/locations\/l1$/),
      expect.stringMatching(/^POST .*\/captures\/batches\/c1\/undo$/),
    ]);
    // A printed label exists in the world: nothing deletes it.
    await expect(tourDeleter('label', 'b1')).rejects.toThrow();
  });
});

// ----- the navigate-then-highlight engine, against a light route tree -----

const ENGINE_TIMEOUT = 30000;

const loc = (id: string, role: 'owner' | 'viewer', modules: ModuleId[]) =>
  ({ id, role, modules }) as unknown as LocationDetail;

const ALL_MODULES: ModuleId[] = [
  'labels',
  'vehicles',
  'schedules',
  'lending',
  'paperwork',
  'consumables',
];
const OWNER_LOCS = [loc('loc-1', 'owner', ALL_MODULES)];

const probe: {
  start: ((returnFocus?: HTMLElement | null) => Promise<boolean>) | null;
  el: HTMLButtonElement | null;
} = { start: null, el: null };

function TourProbe() {
  const tour = useGuidedTour();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    probe.start = tour.start;
    probe.el = ref.current;
  });
  return (
    <button ref={ref} type="button">
      launchpad
    </button>
  );
}

function SectionBody({ anchor }: { anchor: string | null }) {
  return anchor ? (
    <div data-tour={anchor}>section body</div>
  ) : (
    <div>section body without an anchor</div>
  );
}

/** Every guided route with its destination anchor; `anchors` overrides or removes one. */
function tourTree(overrides: Record<string, string | null>) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppProviders locale="en">
        <TourProbe />
        <Outlet />
      </AppProviders>
    ),
  });
  const sectionRoutes = GUIDED_SECTIONS.map((s) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: s.to,
      component: () => (
        <SectionBody
          anchor={Object.hasOwn(overrides, s.id) ? (overrides[s.id] ?? null) : s.anchor}
        />
      ),
    }),
  );
  const newLocationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/locations/new',
    component: () => <SectionBody anchor="new-location-name" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([...sectionRoutes, newLocationRoute]),
    history: createMemoryHistory({ initialEntries: ['/help'] }),
  });
}

type FetchCall = { method: string; url: string; body: unknown };

const okFetch = async (): Promise<Response> =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

function recordingFetch(calls: FetchCall[], impl: () => Promise<Response> = okFetch) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method: init?.method ?? 'GET', url: String(url), body });
    return impl();
  };
}

async function renderTour({
  locations = OWNER_LOCS,
  anchors = {},
  fetchImpl = okFetch,
}: {
  locations?: LocationDetail[];
  anchors?: Record<string, string | null>;
  fetchImpl?: () => Promise<Response>;
} = {}) {
  await activateLocale('en');
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', recordingFetch(calls, fetchImpl));
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  qc.setQueryData(keys.locations, locations);
  const router = tourTree(anchors);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router, calls };
}

const pathOf = (router: { state: { location: { pathname: string } } }) =>
  router.state.location.pathname;

/** Start the tour from the probe; resolves true once the first section shows. */
function startTour(): Promise<boolean> {
  if (!probe.start || !probe.el) throw new Error('tour probe missing');
  const start = probe.start;
  const el = probe.el;
  return act(async () => start(el));
}

const titleOf = (copy: Record<string, { title: string }>, id: string) => copy[id]?.title ?? id;

const expectedPath = (id: string, to: string, locId: string) =>
  id === 'location-detail' ? `/loc/${locId}` : to;

/** Click Next through every section but the last; resolves the finish dialog. */
async function walkToFinish(
  user: ReturnType<typeof userEvent.setup>,
  copy: Record<string, { title: string }>,
  total: number,
) {
  for (const [k, section] of GUIDED_SECTIONS.slice(0, total - 1).entries()) {
    const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
    expect(dialog).toHaveTextContent(`${k + 1} of ${total}`);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  }
  return screen.findByRole('dialog', { name: titleOf(copy, 'finish') });
}

const hintSeen = (calls: FetchCall[]) =>
  calls.find((c) => c.method === 'PUT' && c.url.includes('me/hints/help.tour_seen'))?.body;

afterEach(() => {
  vi.unstubAllGlobals();
  tourLedger.clear();
  hintSlot.release('tour');
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
  });
  for (const el of document.querySelectorAll(
    '.driver-popover, .driver-overlay, [data-guided-keep-host]',
  ))
    el.remove();
});

describe('useGuidedTour', () => {
  beforeEach(() => tourLedger.clear());

  it(
    'navigates per section, skips a section, finishes with Keep/Discard',
    async () => {
      const { user, router, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      expect(await startTour()).toBe(true);
      for (const [k, section] of GUIDED_SECTIONS.entries()) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        expect(dialog).toHaveTextContent(`${k + 1} of ${GUIDED_SECTIONS.length}`);
        expect(pathOf(router)).toBe(expectedPath(section.id, section.to, 'loc-1'));
        if (k < GUIDED_SECTIONS.length - 1) {
          await user.click(within(dialog).getByRole('button', { name: 'Next' }));
        }
      }
      // The last step offers Done only: the run added nothing, so no Keep/Discard.
      const last = await screen.findByRole('dialog', { name: titleOf(copy, 'finish') });
      await user.click(within(last).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // The run recorded nothing: pre-existing data is never ledgered.
      expect(tourLedger.list()).toEqual([]);
      expect(hintSlot.get()).toBeNull();
      expect(hintSeen(calls)).toEqual({ seen: true });
      expect(document.activeElement).toBe(probe.el);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'goes back from the button and the arrow',
    async () => {
      const { user } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      const capture = await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      expect(capture).toHaveTextContent('2 of 16');
      await user.click(within(capture).getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 16',
      );
      await user.click(
        within(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).getByRole(
          'button',
          { name: 'Next' },
        ),
      );
      await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
      });
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'home') }),
      ).toBeInTheDocument();
    },
    ENGINE_TIMEOUT,
  );

  it(
    'skips over a module-gated section with consistent progress',
    async () => {
      const { user } = await renderTour({
        locations: [
          loc('loc-1', 'owner', ['labels', 'schedules', 'lending', 'paperwork', 'consumables']),
        ],
      });
      const copy = await guidedCopyOf('en');
      await startTour();
      // Home through Labels: six shown of fifteen.
      for (const [k, section] of GUIDED_SECTIONS.slice(0, 6).entries()) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        expect(dialog).toHaveTextContent(`${k + 1} of 15`);
        // Skip on Labels jumps the gated-out Vehicles straight to Schedules.
        await user.click(
          within(dialog).getByRole('button', { name: section.id === 'labels' ? 'Skip' : 'Next' }),
        );
      }
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'schedules') }),
      ).toHaveTextContent('7 of 15');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'asks Keep/Discard at the finish only when the run added something',
    async () => {
      const { user, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      tourLedger.record('capture', 'c1');
      tourLedger.record('thing', 't1');
      const done = await walkToFinish(user, copy, 16);
      await user.click(within(done).getByRole('button', { name: 'Done' }));
      const keep = await screen.findByRole('dialog', { name: 'Keep what you added?' });
      expect(keep).toHaveTextContent('2 items');
      await user.click(within(keep).getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // Newest first, through the existing fetchers, and nothing else.
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
        expect.stringMatching(/\/things\/t1\/trash$/),
        expect.stringMatching(/\/captures\/batches\/c1\/undo$/),
      ]);
      expect(tourLedger.list()).toEqual([]);
      expect(hintSlot.get()).toBeNull();
      expect(hintSeen(calls)).toEqual({ seen: true });
    },
    ENGINE_TIMEOUT,
  );

  it(
    'keeps the dialog open when Discard fails, and Keep still finishes',
    async () => {
      const { user } = await renderTour({
        fetchImpl: async (): Promise<Response> => {
          throw new Error('offline');
        },
      });
      const copy = await guidedCopyOf('en');
      await startTour();
      tourLedger.record('thing', 't1');
      const done = await walkToFinish(user, copy, 16);
      await user.click(within(done).getByRole('button', { name: 'Done' }));
      const keep = await screen.findByRole('dialog', { name: 'Keep what you added?' });
      await user.click(within(keep).getByRole('button', { name: 'Discard' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Keep what you added?' })).toBeInTheDocument();
      await user.click(within(keep).getByRole('button', { name: 'Keep' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(hintSlot.get()).toBeNull();
      expect(tourLedger.list()).toEqual([]);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'closes quietly with an empty ledger',
    async () => {
      const { user, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.queryByRole('dialog', { name: 'Keep what you added?' })).toBeNull();
      expect(hintSeen(calls)).toEqual({ seen: true });
      expect(hintSlot.get()).toBeNull();
      expect(document.activeElement).toBe(probe.el);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'offers Keep/Discard on an early close when the run added something',
    async () => {
      const { user } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      tourLedger.record('thing', 't1');
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      const keep = await screen.findByRole('dialog', { name: 'Keep what you added?' });
      expect(keep).toHaveTextContent('1 item');
      await user.click(within(keep).getByRole('button', { name: 'Keep' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(hintSlot.get()).toBeNull();
    },
    ENGINE_TIMEOUT,
  );

  it(
    'aborts cleanly when the person navigates on their own',
    async () => {
      const { router, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await act(async () => {
        await router.navigate({ to: '/search' });
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(hintSeen(calls)).toEqual({ seen: true });
      expect(hintSlot.get()).toBeNull();
    },
    ENGINE_TIMEOUT,
  );

  it(
    'skips a section whose anchor never appears',
    async () => {
      const { user } = await renderTour({ anchors: { schedules: null } });
      const copy = await guidedCopyOf('en');
      await startTour();
      for (const [k, section] of GUIDED_SECTIONS.slice(0, 6).entries()) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        expect(dialog).toHaveTextContent(`${k + 1} of 16`);
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
      // Schedules has no anchor: the tour moves past it to Lending, still counting shown steps.
      const vehicles = await screen.findByRole('dialog', { name: titleOf(copy, 'vehicles') });
      expect(vehicles).toHaveTextContent('7 of 16');
      await user.click(within(vehicles).getByRole('button', { name: 'Next' }));
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'lending') }, { timeout: 8000 }),
      ).toHaveTextContent('8 of 16');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'skips the write sections for a viewer everywhere, with consistent progress',
    async () => {
      const { user, router } = await renderTour({
        locations: [loc('loc-1', 'viewer', ALL_MODULES)],
      });
      const copy = await guidedCopyOf('en');
      await startTour();
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 14',
      );
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      // Capture and the inbox are writes a viewer cannot do: the tour lands on the location.
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'location-detail') }),
      ).toHaveTextContent('2 of 14');
      expect(pathOf(router)).toBe('/loc/loc-1');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'routes an empty household through New location',
    async () => {
      const { user, router } = await renderTour({ locations: [] });
      const copy = await guidedCopyOf('en');
      await startTour();
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 8',
      );
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      // No inbox, no capture, no modules: the location step is New location.
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'new-location') }),
      ).toHaveTextContent('2 of 8');
      expect(pathOf(router)).toBe('/locations/new');
    },
    ENGINE_TIMEOUT,
  );
});
