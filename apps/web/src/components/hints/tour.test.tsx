/**
 * The guided tour (D138, rebuilt in D242): its copy in English and Arabic, which sections a person
 * gets, where a stopped tour resumes, and the navigate-then-highlight engine against a light route
 * tree: Next, Back, the arrows, passing over a missing anchor, closing and resuming, starting over,
 * Keep/Discard, and taps that reach the page. Every anchor's presence in the real screens is
 * tour-anchors.test.ts's job.
 */

import { type ModuleId, tourProgressKey } from '@kept/shared';
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
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inventoryKeys } from '@/api/inventory/queries';
import type { Hint } from '@/api/inventory/types';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { AppProviders } from '@/app-providers';
import { activateLocale } from '@/i18n/i18n';
import { renderUI } from '@/test/render';
import { useGuidedTourCopy, useTourCopy } from './hint-copy';
import {
  availableSections,
  findSectionAnchor,
  GUIDED_SECTIONS,
  type GuidedGating,
  isGuidedSectionAvailable,
  passedSections,
  resolveGuidedSections,
  stopFor,
  type TourStart,
  tourDeleter,
  tourLocation,
  tourProgress,
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
  it('covers every stop on both layouts, and New location, in en and ar', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const copy = await guidedCopyOf(locale);
      const ids = new Set(['new-location']);
      for (const s of GUIDED_SECTIONS) {
        ids.add(stopFor(s, 'phone').copyId ?? s.id);
        ids.add(stopFor(s, 'wide').copyId ?? s.id);
      }
      for (const id of ids) {
        expect(copy[id]?.title, `${locale} ${id} title`).toBeTruthy();
        expect(copy[id]?.description, `${locale} ${id} description`).toBeTruthy();
      }
    }
  });

  it('keeps every step short: at most 120 characters and three sentences', async () => {
    const copy = await guidedCopyOf('en');
    for (const [id, entry] of Object.entries(copy)) {
      expect(entry.description.length, id).toBeLessThanOrEqual(120);
      const sentences = entry.description.split(/[.!?](?:\s|$)/).filter((x) => x.trim());
      expect(sentences.length, id).toBeLessThanOrEqual(3);
    }
  });
});

describe('the walk', () => {
  it('follows today’s screens, ending on Help', () => {
    expect(GUIDED_SECTIONS.map((s) => s.id)).toEqual([
      'home',
      'capture',
      'inbox',
      'location',
      'search',
      'labels',
      'more',
      'settings',
      'finish',
    ]);
    expect(GUIDED_SECTIONS.at(-1)?.to).toBe('/help');
  });

  it('points a desktop at the sidebar instead of More, without leaving the page', () => {
    const more = GUIDED_SECTIONS.find((s) => s.id === 'more');
    if (!more) throw new Error('no more');
    expect(stopFor(more, 'phone')).toMatchObject({ to: '/more', anchors: ['more-entries'] });
    expect(stopFor(more, 'wide')).toMatchObject({ to: null, anchors: ['nav-entries'] });
  });
});

describe('guided section gating', () => {
  const MODULES: ModuleId[] = ['labels', 'vehicles', 'schedules'];
  const allOn: GuidedGating = { modulesOn: new Set(MODULES), hasInbox: true };

  it('shows everything to a member with Labels on', () => {
    for (const s of GUIDED_SECTIONS) expect(isGuidedSectionAvailable(s.id, allOn)).toBe(true);
  });

  it('skips Capture and the Inbox for a viewer everywhere', () => {
    const viewer: GuidedGating = { modulesOn: new Set(MODULES), hasInbox: false };
    expect(isGuidedSectionAvailable('inbox', viewer)).toBe(false);
    expect(isGuidedSectionAvailable('capture', viewer)).toBe(false);
    for (const id of ['home', 'location', 'search', 'labels', 'more', 'settings', 'finish'])
      expect(isGuidedSectionAvailable(id, viewer)).toBe(true);
  });

  it('skips Labels while the module is off everywhere', () => {
    const off: GuidedGating = { modulesOn: new Set(['vehicles']), hasInbox: true };
    expect(isGuidedSectionAvailable('labels', off)).toBe(false);
    expect(isGuidedSectionAvailable('more', off)).toBe(true);
  });
});

describe('resolveGuidedSections', () => {
  it('fills the location into the location stop', () => {
    const resolved = resolveGuidedSections(GUIDED_SECTIONS, 'home-3f9c2a1b');
    const stop = resolved.find((s) => s.id === 'location');
    expect(stop?.to).toBe('/loc/$id');
    expect(stop?.params).toEqual({ id: 'home-3f9c2a1b' });
    expect(stop?.anchors).toEqual(['location-layout']);
    expect(stop?.copyId).toBe('location');
  });

  it('routes an empty household through New location', () => {
    const resolved = resolveGuidedSections(GUIDED_SECTIONS, null);
    const stop = resolved.find((s) => s.id === 'location');
    expect(stop?.to).toBe('/locations/new');
    expect(stop?.anchors).toEqual(['new-location-name']);
    expect(stop?.copyId).toBe('new-location');
    expect(stop?.params).toBeUndefined();
  });

  it('opens the first shared location before the Personal one', () => {
    const personal = { id: 'p', kind: 'personal' };
    const garage = { id: 'g', kind: 'garage' };
    expect(tourLocation([personal, garage])).toBe(garage);
    expect(tourLocation([personal])).toBe(personal);
    expect(tourLocation([])).toBeNull();
  });
});

describe('where the tour stopped', () => {
  const hint = (id: string, dismissed: boolean): Hint => ({
    key: tourProgressKey(id as never),
    seenAt: '2026-10-15T10:00:00Z',
    dismissedAt: dismissed ? '2026-10-15T10:00:00Z' : null,
  });
  const sections = GUIDED_SECTIONS;

  it('is new with nothing passed, or with only restored keys', () => {
    expect(tourProgress(sections, passedSections([]))).toEqual({ state: 'new' });
    expect(tourProgress(sections, passedSections([hint('home', false)]))).toEqual({
      state: 'new',
    });
  });

  it('stops at the first section not passed', () => {
    const passed = passedSections([hint('home', true), hint('capture', true)]);
    expect(tourProgress(sections, passed)).toEqual({
      state: 'stopped',
      index: 2,
      sectionId: 'inbox',
    });
  });

  it('is finished once Help, the last stop, was passed', () => {
    expect(tourProgress(sections, passedSections([hint('finish', true)]))).toEqual({
      state: 'finished',
    });
  });

  it('counts only the sections this person has', () => {
    const viewer = [{ id: 'l', role: 'viewer', modules: [] }] as unknown as LocationDetail[];
    const mine = availableSections(viewer);
    expect(mine.map((s) => s.id)).toEqual([
      'home',
      'location',
      'search',
      'more',
      'settings',
      'finish',
    ]);
    // Passed Home; Capture isn't theirs: they stopped at the location.
    expect(tourProgress(mine, passedSections([hint('home', true)]))).toMatchObject({
      sectionId: 'location',
      index: 1,
    });
  });
});

describe('section anchors', () => {
  it('finds the first anchor on screen, in order', async () => {
    await renderUI(
      <div>
        <div data-tour="home-locations">locations</div>
        <div data-tour="search-field">
          <input aria-label="search" />
        </div>
      </div>,
    );
    expect(findSectionAnchor('search-field')?.getAttribute('data-tour')).toBe('search-field');
    expect(findSectionAnchor(['home-needs', 'home-locations'])?.textContent).toBe('locations');
    expect(findSectionAnchor('no-such-anchor')).toBeNull();
  });

  it('waits for a late anchor and gives up within its bound', async () => {
    await expect(waitForSectionAnchor('nowhere', 20)).resolves.toBeNull();
    const late = document.createElement('div');
    late.setAttribute('data-tour', 'late-anchor');
    const shown = waitForSectionAnchor(['late-anchor'], 1000);
    document.body.appendChild(late);
    await expect(shown).resolves.toBe(late);
    late.remove();
  });
});

describe('tourDeleter', () => {
  it('deletes through the existing fetchers', async () => {
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
  });
});

// ----- the navigate-then-highlight engine, against a light route tree -----

const ENGINE_TIMEOUT = 30000;

const loc = (id: string, role: 'owner' | 'viewer', modules: ModuleId[], kind = 'home') =>
  ({ id, name: 'Home', kind, role, modules }) as unknown as LocationDetail;

const OWNER_LOCS = [loc('loc-1', 'owner', ['labels'])];
/** The location stop's path: lib/address.ts's readable address for the location. */
const LOC_PATH = /^\/loc\/[^/]+$/;

const probe: {
  start: ((opts?: TourStart) => Promise<boolean>) | null;
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

/** A route body with the stop's anchor, which a button can redraw as a new element. */
function SectionBody({ anchor }: { anchor: string | null }) {
  const [round, setRound] = useState(0);
  if (!anchor) return <div>section body without an anchor</div>;
  return (
    <div>
      <div key={round} data-tour={anchor}>
        section body {round}
      </div>
      <button type="button" onClick={() => setRound((r) => r + 1)}>
        redraw
      </button>
    </div>
  );
}

/** Every phone stop with its first anchor; `overrides` replaces or removes one by section id. */
function tourTree(overrides: Record<string, string | null>) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppProviders locale="en">
        <TourProbe />
        <Outlet />
      </AppProviders>
    ),
  });
  const anchorOf = (id: string, first: string | null) =>
    Object.hasOwn(overrides, id) ? (overrides[id] ?? null) : first;
  const sectionRoutes = GUIDED_SECTIONS.map((s) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: s.to,
      component: () => <SectionBody anchor={anchorOf(s.id, s.anchors[0] ?? null)} />,
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
  hints = [],
  fetchImpl = okFetch,
}: {
  locations?: LocationDetail[];
  anchors?: Record<string, string | null>;
  hints?: Hint[];
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
  qc.setQueryData(inventoryKeys.hints, { hints });
  const router = tourTree(anchors);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router, calls, qc };
}

const pathOf = (router: { state: { location: { pathname: string } } }) =>
  router.state.location.pathname;

/** Start the tour from the probe; resolves true once the first section shows. */
function startTour(from: TourStart['from'] = 'start'): Promise<boolean> {
  if (!probe.start || !probe.el) throw new Error('tour probe missing');
  const start = probe.start;
  const el = probe.el;
  return act(async () => start({ from, returnFocus: el }));
}

const titleOf = (copy: Record<string, { title: string }>, id: string) => copy[id]?.title ?? id;

/** Click Next through every section but the last; resolves the finish step. */
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

const putsTo = (calls: FetchCall[], key: string) =>
  calls.filter((c) => c.method === 'PUT' && c.url.endsWith(`me/hints/${key}`)).map((c) => c.body);

/** The progress keys recorded as passed, in order. */
const passedKeys = (calls: FetchCall[]) =>
  calls
    .filter(
      (c) =>
        c.method === 'PUT' &&
        c.url.includes('me/hints/help.tour.') &&
        (c.body as { dismissed?: boolean }).dismissed === true,
    )
    .map((c) => c.url.split('me/hints/')[1]);

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
  document.body.className = '';
});

describe('useGuidedTour', () => {
  beforeEach(() => tourLedger.clear());

  it(
    'navigates per section, remembers each one passed, and finishes on Help',
    async () => {
      const { user, router, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      expect(await startTour()).toBe(true);
      const total = GUIDED_SECTIONS.length;
      for (const [k, section] of GUIDED_SECTIONS.entries()) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        expect(dialog).toHaveTextContent(`${k + 1} of ${total}`);
        if (section.id === 'location') expect(pathOf(router)).toMatch(LOC_PATH);
        else expect(pathOf(router)).toBe(section.to);
        if (k < total - 1) await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
      const last = await screen.findByRole('dialog', { name: titleOf(copy, 'finish') });
      await user.click(within(last).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(tourLedger.list()).toEqual([]);
      expect(hintSlot.get()).toBeNull();
      // Every section was passed, in order, and the run was seen.
      await waitFor(() =>
        expect(passedKeys(calls)).toEqual(GUIDED_SECTIONS.map((s) => `help.tour.${s.id}`)),
      );
      expect(putsTo(calls, 'help.tour_seen')).toEqual([{ seen: true }]);
      expect(document.activeElement).toBe(probe.el);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'goes back from the button and the arrow, without marking anything passed',
    async () => {
      const { user, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      // Nothing comes before Home: no Back there.
      expect(within(home).queryByRole('button', { name: 'Back' })).toBeNull();
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      const capture = await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      expect(capture).toHaveTextContent('2 of 9');
      await user.click(within(capture).getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 9',
      );
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowRight' });
      });
      await screen.findByRole('dialog', { name: titleOf(copy, 'capture') });
      act(() => {
        fireEvent.keyDown(window, { key: 'ArrowLeft' });
      });
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'home') }),
      ).toBeInTheDocument();
      // Home was passed once (the second time it already was); Back passes nothing.
      expect(passedKeys(calls)).toEqual(['help.tour.home']);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'closes where it is, and resumes there',
    async () => {
      const { user, router, calls, qc } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      for (const id of ['home', 'capture']) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, id) });
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
      const inbox = await screen.findByRole('dialog', { name: titleOf(copy, 'inbox') });
      await user.click(within(inbox).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(passedKeys(calls)).toEqual(['help.tour.home', 'help.tour.capture']);
      // The cache holds it at once, as the server does.
      const hints = qc.getQueryData<{ hints: Hint[] }>(inventoryKeys.hints)?.hints;
      expect(tourProgress(GUIDED_SECTIONS, passedSections(hints))).toMatchObject({
        state: 'stopped',
        sectionId: 'inbox',
      });
      await act(async () => {
        await router.navigate({ to: '/help' });
      });
      await startTour('resume');
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'inbox') })).toHaveTextContent(
        '3 of 9',
      );
      expect(pathOf(router)).toBe('/inbox');
      // Back still reaches what came before.
      await user.click(
        within(screen.getByRole('dialog', { name: titleOf(copy, 'inbox') })).getByRole('button', {
          name: 'Back',
        }),
      );
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'capture') }),
      ).toHaveTextContent('2 of 9');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'starts over from Home, forgetting where the last run stopped',
    async () => {
      const passed = (id: string): Hint => ({
        key: tourProgressKey(id as never),
        seenAt: '2026-10-15T10:00:00Z',
        dismissedAt: '2026-10-15T10:00:00Z',
      });
      const { calls, qc } = await renderTour({ hints: [passed('home'), passed('capture')] });
      const copy = await guidedCopyOf('en');
      await startTour('start');
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 9',
      );
      expect(putsTo(calls, 'help.tour.home')).toEqual([{ dismissed: false }]);
      expect(putsTo(calls, 'help.tour.capture')).toEqual([{ dismissed: false }]);
      const hints = qc.getQueryData<{ hints: Hint[] }>(inventoryKeys.hints)?.hints;
      expect(passedSections(hints).size).toBe(0);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'leaves taps outside the highlight to the page',
    async () => {
      const { user } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      // driver.css blocks every tap under body.driver-active; the tour takes the class off.
      expect(document.body.classList.contains('driver-active')).toBe(false);
      expect(document.body.classList.contains('kept-tour-open')).toBe(true);
      // A control outside the highlight still works, and the tour stays on its step.
      await user.click(screen.getByRole('button', { name: 'redraw' }));
      expect(screen.getByText('section body 1')).toBeInTheDocument();
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'home') }),
      ).toBeInTheDocument();
    },
    ENGINE_TIMEOUT,
  );

  it(
    'points at the control again when the page redraws it',
    async () => {
      const { user } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      const before = document.querySelector('[data-tour="home-needs"]');
      await waitFor(() => expect(before?.classList.contains('driver-active-element')).toBe(true));
      await user.click(screen.getByRole('button', { name: 'redraw' }));
      await waitFor(() => {
        const now = document.querySelector('[data-tour="home-needs"]');
        expect(now).not.toBe(before);
        expect(now?.classList.contains('driver-active-element')).toBe(true);
      });
      expect(await screen.findByRole('dialog', { name: titleOf(copy, 'home') })).toHaveTextContent(
        '1 of 9',
      );
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
      const done = await walkToFinish(user, copy, 9);
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
      expect(putsTo(calls, 'help.tour_seen')).toEqual([{ seen: true }]);
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
      const done = await walkToFinish(user, copy, 9);
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
      expect(putsTo(calls, 'help.tour_seen')).toEqual([{ seen: true }]);
      expect(hintSlot.get()).toBeNull();
      expect(document.body.classList.contains('kept-tour-open')).toBe(false);
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
    'ends where it is when the person goes somewhere else',
    async () => {
      const { router, calls } = await renderTour({});
      const copy = await guidedCopyOf('en');
      await startTour();
      await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      await act(async () => {
        await router.navigate({ to: '/search' });
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(putsTo(calls, 'help.tour_seen')).toEqual([{ seen: true }]);
      // Home wasn't passed: Help resumes there.
      expect(passedKeys(calls)).toEqual([]);
      expect(hintSlot.get()).toBeNull();
    },
    ENGINE_TIMEOUT,
  );

  it(
    'passes over a section whose anchor never appears, and leaves it out of the count',
    async () => {
      const { user, calls } = await renderTour({ anchors: { search: null } });
      const copy = await guidedCopyOf('en');
      await startTour();
      for (const [k, section] of GUIDED_SECTIONS.slice(0, 4).entries()) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        expect(dialog).toHaveTextContent(`${k + 1} of 9`);
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
      // Search has no anchor: the tour moves on to Labels, which reads 5 of 8.
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'labels') }, { timeout: 8000 }),
      ).toHaveTextContent('5 of 8');
      // Passed over counts as passed: a resume doesn't wait on it again.
      expect(passedKeys(calls)).toContain('help.tour.search');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'goes back over a passed-over section without waiting again',
    async () => {
      const { user } = await renderTour({ anchors: { search: null } });
      const copy = await guidedCopyOf('en');
      await startTour();
      for (const section of GUIDED_SECTIONS.slice(0, 4)) {
        const dialog = await screen.findByRole('dialog', { name: titleOf(copy, section.id) });
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
      const labels = await screen.findByRole(
        'dialog',
        { name: titleOf(copy, 'labels') },
        { timeout: 8000 },
      );
      await user.click(within(labels).getByRole('button', { name: 'Back' }));
      // Back jumps the known-empty Search: the location shows without another 3 s wait.
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'location') }, { timeout: 2500 }),
      ).toHaveTextContent('4 of 8');
    },
    ENGINE_TIMEOUT,
  );

  it(
    'leaves Capture and the Inbox out for a viewer everywhere',
    async () => {
      const { user, router } = await renderTour({
        locations: [loc('loc-1', 'viewer', ['labels'])],
      });
      const copy = await guidedCopyOf('en');
      await startTour();
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      expect(home).toHaveTextContent('1 of 7');
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'location') }),
      ).toHaveTextContent('2 of 7');
      expect(pathOf(router)).toMatch(LOC_PATH);
    },
    ENGINE_TIMEOUT,
  );

  it(
    'routes an empty household through New location',
    async () => {
      const { user, router } = await renderTour({ locations: [] });
      const copy = await guidedCopyOf('en');
      await startTour();
      const home = await screen.findByRole('dialog', { name: titleOf(copy, 'home') });
      expect(home).toHaveTextContent('1 of 6');
      await user.click(within(home).getByRole('button', { name: 'Next' }));
      // No inbox, no capture, no labels: the location step is New location.
      expect(
        await screen.findByRole('dialog', { name: titleOf(copy, 'new-location') }),
      ).toHaveTextContent('2 of 6');
      expect(pathOf(router)).toBe('/locations/new');
    },
    ENGINE_TIMEOUT,
  );
});
