/**
 * The guided tour (D138, rebuilt in D242): started from Help ("Show me around"), never on launch.
 * It walks today's screens in nine stops: Home's Needs you, Capture, the Inbox, a location's
 * List/Grid/Map switch, Search, Labels, everything else (More on a phone, the sidebar on a
 * desktop), Settings → Notifications, and Help.
 *
 * - Each section names the route it opens and the `data-tour="<anchor>"` it points at, per layout
 *   where they differ. The first anchor on screen wins; a section whose anchor never shows (a
 *   module that is off, an empty page) is passed over, and drops out of the count.
 * - **Never in the way:** taps outside the highlighted element reach the page (driver-kit.ts).
 *   Going somewhere the tour didn't take you ends it, where you are.
 * - **Resumable:** moving past a section records `help.tour.<section>` on the server (dismissed,
 *   @kept/shared `tourProgressKey`), so Help resumes at the first section not passed, on any
 *   device; Start over restores those keys first. Finishing or closing records `help.tour_seen`.
 * - While it runs no hint shows; what it added is listed for Keep or Discard at the end
 *   (tour-ledger.ts, tour-keep.tsx).
 */

import { type ModuleId, type TourSectionId, tourProgressKey } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { createElement, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { captureApi } from '@/api/capture/queries';
import { inventoryApi, inventoryKeys } from '@/api/inventory/queries';
import type { Hint, HintsResponse } from '@/api/inventory/types';
import { deleteLocation, listLocations } from '@/api/locations';
import { keys, useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { locationAddress } from '@/lib/address';
import { WIDE } from '@/lib/media';
import type { Shown } from './driver-kit';
import { useGuidedTourCopy, useTourCopy } from './hint-copy';
import { type LogicalSide, pageIsRtl, prefersReducedMotion } from './placement';
import { TourKeepHost } from './tour-keep';
import { type TourDeleter, tourLedger } from './tour-ledger';
import { hintSlot, useMarkHint } from './use-hint';

/** The two shells: the phone's tab bar, or the sidebar from 768 px (lib/media.ts WIDE). */
export type TourLayout = 'phone' | 'wide';

/**
 * Where a section stands and what it points at. `to: null` stays on the page the tour is on.
 * `side` places the popover beside the target on a desktop; on a phone the popover is a sheet
 * docked at the bottom, above the tab bar, or at the top with `dock: 'top'` (hints.css).
 */
export type TourStop = {
  to: string | null;
  anchors: readonly string[];
  side?: LogicalSide;
  dock?: 'top' | 'bottom';
  /** The copy entry when it isn't the section's own. */
  copyId?: string;
};

/** One section of the tour: its stop (always a route), and the desktop's own where it differs. */
export type TourSection = TourStop & {
  id: TourSectionId;
  to: string;
  params?: Record<string, string>;
  wide?: TourStop;
};

/**
 * The walk, in order. Every anchor here must exist in its route's source (a unit test reads them:
 * tour-anchors.test.ts), so a moved element fails CI instead of the tour.
 */
export const GUIDED_SECTIONS: readonly TourSection[] = [
  { id: 'home', to: '/', anchors: ['home-needs', 'home-locations'] },
  // Capture is a full screen with its controls at the bottom: the sheet docks at the top.
  { id: 'capture', to: '/capture', anchors: ['capture-shutter'], dock: 'top' },
  { id: 'inbox', to: '/inbox', anchors: ['inbox-whose'] },
  { id: 'location', to: '/loc/$id', anchors: ['location-layout'] },
  { id: 'search', to: '/search', anchors: ['search-field'] },
  { id: 'labels', to: '/labels', anchors: ['labels-print'] },
  {
    id: 'more',
    to: '/more',
    anchors: ['more-entries'],
    // A desktop has no More: the same entries are the sidebar, beside whatever page is open.
    wide: { to: null, anchors: ['nav-entries'], side: 'end', copyId: 'more-wide' },
  },
  { id: 'settings', to: '/settings', anchors: ['settings-notifications'] },
  { id: 'finish', to: '/help', anchors: ['help-tour'] },
];

/** The stop a section makes on `layout`. */
export function stopFor(section: TourSection, layout: TourLayout): TourStop {
  return layout === 'wide' && section.wide ? section.wide : section;
}

/** The layout on screen now (jsdom has no matchMedia: the phone's). */
export function currentLayout(): TourLayout {
  try {
    return window.matchMedia(WIDE).matches ? 'wide' : 'phone';
  } catch {
    return 'phone';
  }
}

/** What gating needs: the modules on anywhere, and whether anything is writable. */
export type GuidedGating = { modulesOn: Set<ModuleId>; hasInbox: boolean };

/** Sections whose screen is a write: taking a photo, reviewing what it found. */
const WRITE_SECTIONS: ReadonlySet<string> = new Set(['capture', 'inbox']);

/**
 * Whether the section exists for this person: Capture and the Inbox only where something can
 * change (`hasInbox`: some location where the role isn't viewer, as the shell's useHasInbox),
 * Labels only while the module is on anywhere. Everything else is always there.
 */
export function isGuidedSectionAvailable(sectionId: string, gating: GuidedGating): boolean {
  if (WRITE_SECTIONS.has(sectionId)) return gating.hasInbox;
  if (sectionId === 'labels') return gating.modulesOn.has('labels');
  return true;
}

// ----- progress, remembered on the server -----

/** The sections moved past, from `GET /me/hints` (dismissed and not restored). */
export function passedSections(hints: readonly Hint[] | undefined): Set<string> {
  const passed = new Set<string>();
  for (const s of GUIDED_SECTIONS) {
    const h = hints?.find((x) => x.key === tourProgressKey(s.id));
    if (h?.dismissedAt) passed.add(s.id);
  }
  return passed;
}

/** Where the tour stands: never started, stopped part-way (at `sectionId`), or finished. */
export type TourProgress =
  | { state: 'new' }
  | { state: 'stopped'; index: number; sectionId: string }
  | { state: 'finished' };

/**
 * The tour's state for these sections: finished once the last was passed, stopped at the first
 * section not passed once any was, otherwise new.
 */
export function tourProgress(
  sections: readonly { id: string }[],
  passed: ReadonlySet<string>,
): TourProgress {
  const last = sections[sections.length - 1];
  if (!last || !sections.some((s) => passed.has(s.id))) return { state: 'new' };
  if (passed.has(last.id)) return { state: 'finished' };
  const index = sections.findIndex((s) => !passed.has(s.id));
  return { state: 'stopped', index, sectionId: sections[index]?.id ?? last.id };
}

/** The gating for `locations` (the shell's own rules: useNavEntries, useHasInbox). */
export function gatingOf(locations: readonly LocationDetail[]): GuidedGating {
  return {
    modulesOn: new Set(locations.flatMap((l) => l.modules)),
    hasInbox: locations.some((l) => l.role !== 'viewer'),
  };
}

/** The sections this person has, in order. */
export function availableSections(locations: readonly LocationDetail[]): TourSection[] {
  const gating = gatingOf(locations);
  return GUIDED_SECTIONS.filter((s) => isGuidedSectionAvailable(s.id, gating));
}

// ----- the navigate-then-highlight engine -----

/** How long a section waits for its anchor before passing over it. */
export const GUIDED_ANCHOR_WAIT_MS = 3000;

/** A section's target: the first `[data-tour]` match, in `anchors` order, that has a box. */
export function findSectionAnchor(
  anchors: string | readonly string[],
  root: ParentNode = document,
): Element | null {
  const list = typeof anchors === 'string' ? [anchors] : anchors;
  // A document without layout (jsdom) has no boxes at all: take the first match.
  const layout = document.body.getClientRects().length > 0;
  for (const anchor of list) {
    const all = [...root.querySelectorAll(`[data-tour="${CSS.escape(anchor)}"]`)];
    const shown = layout ? all.find(hasBox) : all[0];
    if (shown) return shown;
  }
  return null;
}

/** Laid out with an area: an empty wrapper (0 px tall) is nothing to point at. */
function hasBox(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return el.getClientRects().length > 0 && r.width > 0 && r.height > 0;
}

/**
 * The anchor once the route renders it: a MutationObserver plus an animation-frame poll,
 * bounded by `timeout`, never a fixed sleep.
 */
export function waitForSectionAnchor(
  anchors: string | readonly string[],
  timeout = GUIDED_ANCHOR_WAIT_MS,
): Promise<Element | null> {
  const hit = () => findSectionAnchor(anchors);
  const now = hit();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (el: Element | null) => {
      if (done) return;
      done = true;
      mo.disconnect();
      resolve(el);
    };
    const mo = new MutationObserver(() => {
      const el = hit();
      if (el) finish(el);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const tick = () => {
      if (done) return;
      const el = hit();
      if (el) finish(el);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.setTimeout(() => finish(hit()), timeout);
  });
}

/** A section with its location filled in, or New location for a household with none. */
export type ResolvedGuidedSection = TourSection & { copyId: string };

/**
 * The location stop opens the person's first shared location (the sidebar's order), else their
 * Personal one. With none at all it opens New location instead (spec decision 2): one created
 * there is recorded in the ledger (routes/_app/locations.new.tsx), deletable on Discard.
 */
export function resolveGuidedSections(
  sections: readonly TourSection[],
  locationAddressOrNull: string | null,
): ResolvedGuidedSection[] {
  return sections.map((s) => {
    if (s.id !== 'location') return { ...s, copyId: s.copyId ?? s.id };
    if (locationAddressOrNull) return { ...s, params: { id: locationAddressOrNull }, copyId: s.id };
    return {
      id: s.id,
      to: '/locations/new',
      anchors: ['new-location-name'],
      copyId: 'new-location',
    };
  });
}

/** The location the tour opens: the first one that isn't Personal, else the first. */
export function tourLocation<L extends { kind: string }>(locations: readonly L[]): L | null {
  return locations.find((l) => l.kind !== 'personal') ?? locations[0] ?? null;
}

/** The pathname a stop navigates to, for telling the tour's own moves apart. */
function stopPath(stop: TourStop, params: Record<string, string> | undefined): string | null {
  if (stop.to === null) return null;
  let path = stop.to;
  for (const [key, value] of Object.entries(params ?? {}))
    path = path.replace(`$${key}`, encodeURIComponent(value));
  return path;
}

/**
 * Discard through the existing mutations (spec decision 3): Trash-move for things and places,
 * the location delete, the capture batch undo (the batch's synced drafts go to the trash).
 */
export const tourDeleter: TourDeleter = async (kind, id) => {
  switch (kind) {
    case 'thing':
      await inventoryApi.trashThing(id);
      return;
    case 'place':
      await inventoryApi.trashPlace(id);
      return;
    case 'location':
      await deleteLocation(id);
      return;
    case 'capture':
      await captureApi.undoBatch(id);
      return;
  }
};

type GuidedRun = {
  alive: boolean;
  /** Bumps on every move: stale async continuations stand down. */
  seq: number;
  sections: ResolvedGuidedSection[];
  shownAny: boolean;
  /** Passed over for a missing anchor: Back and Next jump these, and they leave the count. */
  skipped: Set<number>;
  highlight: Shown | null;
  /** A programmatic destroy is coming: its onEnd is the engine's own echo, not the person. */
  muteOnEnd: boolean;
  dialog: { root: Root; el: HTMLDivElement } | null;
  dialogOpen: boolean;
  /** The route the tour itself put the person on; anything else ends the run. */
  expectPath: string | null;
  stopWatching: (() => void) | null;
  stopArrows: (() => void) | null;
  /** The step's Back watcher and the target watcher: dropped on every move. */
  stepObserver: MutationObserver | null;
  stepTimer: number | null;
  targetObserver: MutationObserver | null;
  returnFocus: HTMLElement | null;
};

/** Drop the per-step watchers: their popover and target are gone on every move. */
function clearStepWatchers(run: GuidedRun): void {
  run.stepObserver?.disconnect();
  run.stepObserver = null;
  if (run.stepTimer !== null) {
    window.clearTimeout(run.stepTimer);
    run.stepTimer = null;
  }
  run.targetObserver?.disconnect();
  run.targetObserver = null;
}

/** The nearest section before `i` that wasn't passed over for a missing anchor. */
function backTo(run: GuidedRun, i: number): number {
  let j = i - 1;
  while (j > 0 && run.skipped.has(j)) j -= 1;
  return j;
}

/** The nearest section after `i` that wasn't passed over for a missing anchor. */
function forwardTo(run: GuidedRun, i: number): number {
  let j = i + 1;
  while (j < run.sections.length && run.skipped.has(j)) j += 1;
  return j;
}

/**
 * The step's Back button. driver.js only knows Next/Previous/Close, and a single-step highlight
 * shows only its done button and Close, so the engine adds Back beside it once there is a section
 * to go back to. It wears only the popover's generic footer-button class: the prev/next classes
 * would also match driver.js's own delegated click handler, hijacking the click.
 */
function injectBackButton(run: GuidedRun, seq: number, label: string, onBack: () => void): void {
  const fresh = () => run.alive && run.seq === seq;
  const place = () => {
    if (!fresh()) return true;
    const bar = document.querySelector('.driver-popover .driver-popover-navigation-btns');
    if (!bar) return false;
    if (bar.querySelector('[data-tour-btn="back"]')) return true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'driver-popover-footer-btn';
    button.dataset.tourBtn = 'back';
    button.textContent = label;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      onBack();
    });
    bar.prepend(button);
    return true;
  };
  if (place()) return;
  // The popover animates in: watch for it briefly, then give up (Next and Close still work).
  const mo = new MutationObserver(() => {
    if (!place()) return;
    mo.disconnect();
    if (run.stepObserver === mo) run.stepObserver = null;
    if (run.stepTimer !== null) {
      window.clearTimeout(run.stepTimer);
      run.stepTimer = null;
    }
  });
  run.stepObserver = mo;
  mo.observe(document.body, { childList: true, subtree: true });
  run.stepTimer = window.setTimeout(() => {
    run.stepTimer = null;
    mo.disconnect();
    if (run.stepObserver === mo) run.stepObserver = null;
  }, 1500);
}

/** How the tour starts: from the top, or at the first section not yet passed. */
export type TourStart = { from?: 'start' | 'resume'; returnFocus?: HTMLElement | null };

/** `start()` runs the tour; `running` is true until it ends. */
export function useGuidedTour() {
  const copy = useGuidedTourCopy();
  const labels = useTourCopy().labels;
  const mark = useMarkHint();
  const navigate = useNavigate();
  const router = useRouter();
  const qc = useQueryClient();
  const locationsQuery = useLocations();
  const { t } = useLingui();
  const [running, setRunning] = useState(false);
  const runRef = useRef<GuidedRun | null>(null);

  const destroyHighlight = (run: GuidedRun) => {
    clearStepWatchers(run);
    if (!run.highlight) return;
    run.muteOnEnd = true;
    try {
      run.highlight.destroy();
    } finally {
      run.muteOnEnd = false;
      run.highlight = null;
    }
  };

  const unmountKeepDialog = (run: GuidedRun) => {
    run.dialog?.root.unmount();
    run.dialog?.el.remove();
    run.dialog = null;
    run.dialogOpen = false;
  };

  /** Silent teardown: nothing ever showed, so nothing is recorded. */
  const abandon = (run: GuidedRun) => {
    run.alive = false;
    destroyHighlight(run);
    unmountKeepDialog(run);
    run.stopWatching?.();
    run.stopWatching = null;
    run.stopArrows?.();
    run.stopArrows = null;
    hintSlot.release('tour');
    tourLedger.clear();
    if (runRef.current === run) {
      runRef.current = null;
      setRunning(false);
    }
  };

  /** The run is over: mark it seen, put everything back, hand focus home. */
  const finalize = (run: GuidedRun) => {
    abandon(run);
    void mark('help.tour_seen', { seen: true });
    const back = run.returnFocus;
    if (back?.isConnected) back.focus();
  };

  /** Past the last step, closed early, or walked away: Keep/Discard when the run added
   * something, otherwise straight to done. */
  const endTour = (run: GuidedRun) => {
    if (!run.alive) return;
    if (!run.shownAny) {
      abandon(run);
      return;
    }
    run.alive = false;
    destroyHighlight(run);
    // INVARIANT: the dialog shows exactly this tick's list, and nothing mutates the ledger
    // between here and its Keep/Discard — display set and delete set cannot diverge.
    const ids = tourLedger.list();
    if (ids.length === 0) {
      finalize(run);
      return;
    }
    run.dialogOpen = true;
    const el = document.createElement('div');
    el.setAttribute('data-guided-keep-host', '');
    document.body.appendChild(el);
    const root = createRoot(el);
    run.dialog = { root, el };
    root.render(
      createElement(TourKeepHost, {
        ids,
        onDiscard: tourDeleter,
        onKeep: () => finalize(run),
      }),
    );
  };

  /** Section `i` was moved past: remembered so Help resumes after it. */
  const markPassed = (run: GuidedRun, i: number) => {
    const section = run.sections[i];
    if (!section) return;
    const key = tourProgressKey(section.id);
    const hints = qc.getQueryData<HintsResponse>(inventoryKeys.hints)?.hints;
    if (hints?.find((h) => h.key === key)?.dismissedAt) return;
    void mark(key, { dismissed: true });
  };

  /** Move on from section `i`: it counts as passed, then the next section shows. */
  const forward = (run: GuidedRun, i: number) => {
    markPassed(run, i);
    void step(run, forwardTo(run, i));
  };

  /**
   * Show section `i`: navigate (unless `stay`), wait for its anchor, highlight it. Past the end,
   * finish. `stay` re-points at the same section after its target was re-rendered.
   */
  const step = async (run: GuidedRun, i: number, stay = false): Promise<'shown' | 'ended'> => {
    const seq = ++run.seq;
    const live = () => run.alive && run.seq === seq;
    if (!run.alive) return 'ended';
    if (i >= run.sections.length) {
      endTour(run);
      return 'ended';
    }
    // Known to have nothing to show: jump it without another navigate and anchor wait.
    if (run.skipped.has(i)) return step(run, i + 1);
    const section = run.sections[i];
    // Unreachable (callers stay in range), but a skip beats a crash.
    if (!section) return step(run, i + 1);
    const stop = stopFor(section, currentLayout());
    destroyHighlight(run);
    if (!stay) {
      const path = stopPath(stop, section.params);
      run.expectPath = path ?? router.state.location.pathname;
      if (path !== null) {
        try {
          await navigate({ to: stop.to as never, params: section.params as never });
        } catch {
          if (live()) {
            run.skipped.add(i);
            return step(run, i + 1);
          }
          return 'ended';
        }
      }
    }
    const el = await waitForSectionAnchor(stop.anchors);
    if (!live()) return 'ended';
    if (!el) {
      run.skipped.add(i);
      markPassed(run, i);
      return step(run, i + 1);
    }
    run.shownAny = true;
    // "n of m" counts the sections that can show: one passed over for a missing anchor leaves
    // the total, so the last one reads "m of m", and a resumed run counts from where it stands.
    const before = [...run.skipped].filter((k) => k < i).length;
    const position = i + 1 - before;
    const total = run.sections.length - run.skipped.size;
    const entry = copy[stop.copyId ?? section.copyId] ?? copy[section.id];
    if (!entry) return step(run, i + 1);
    const isLast = forwardTo(run, i) >= run.sections.length;
    const kit = await import('./driver-kit');
    if (!live()) return 'ended';
    destroyHighlight(run);
    const rtl = pageIsRtl();
    run.highlight = kit.runTour({
      steps: [{ element: el, title: entry.title, description: entry.description }],
      rtl,
      reducedMotion: prefersReducedMotion(),
      side: stop.side ?? 'bottom',
      dock: stop.dock ?? 'bottom',
      labels: {
        ...labels,
        // A single step always renders the done label: Next until the last section.
        done: isLast ? labels.done : labels.next,
        // Progress counts the run's sections, not this one-element step list.
        progress: () => labels.progress(position, total),
      },
      returnFocus: run.returnFocus,
      onEnd: (completed) => {
        run.highlight = null;
        if (run.muteOnEnd || !run.alive) return;
        if (completed) forward(run, i);
        else endTour(run);
      },
    });
    if (i > 0)
      injectBackButton(run, seq, t`Back`, () => {
        if (run.alive) void step(run, backTo(run, i));
      });
    watchArrows(run, i);
    watchTarget(run, seq, i, el);
    return 'shown';
  };

  /**
   * The highlighted control can be re-rendered under the tour (the location's switch moves when
   * Map is chosen): point at the new one rather than at nothing.
   */
  const watchTarget = (run: GuidedRun, seq: number, i: number, el: Element) => {
    const mo = new MutationObserver(() => {
      if (el.isConnected || !run.alive || run.seq !== seq) return;
      mo.disconnect();
      if (run.targetObserver === mo) run.targetObserver = null;
      void step(run, i, true);
    });
    run.targetObserver = mo;
    mo.observe(document.body, { childList: true, subtree: true });
  };

  /** Arrows move between sections, by reading direction; Escape stays driver-kit's. */
  const watchArrows = (run: GuidedRun, i: number) => {
    run.stopArrows?.();
    const onKey = (e: KeyboardEvent) => {
      if (!run.alive || run.dialogOpen || !run.highlight) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      // An arrow in a field moves the caret, not the tour.
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]'))
        return;
      const ahead = (e.key === 'ArrowRight') !== pageIsRtl();
      if (!ahead && i === 0) return;
      e.preventDefault();
      if (ahead) forward(run, i);
      else void step(run, backTo(run, i));
    };
    window.addEventListener('keydown', onKey);
    run.stopArrows = () => window.removeEventListener('keydown', onKey);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the run helpers close over this render by design; the tour outlives Help's unmount.
  const start = useCallback(
    async ({ from = 'start', returnFocus }: TourStart = {}): Promise<boolean> => {
      if (runRef.current) abandon(runRef.current);
      let locations = locationsQuery.data;
      if (!locations) {
        try {
          locations = await qc.fetchQuery({ queryKey: keys.locations, queryFn: listLocations });
        } catch {
          // Offline at start: run what the routes show, with no inbox and no modules.
          locations = [];
        }
      }
      const known = locations ?? [];
      // The location's readable address (D224): the page would replace an id with it, and a
      // navigation the tour didn't make ends the tour.
      const place = tourLocation(known);
      const sections = resolveGuidedSections(
        availableSections(known),
        place ? locationAddress({ id: place.id, name: place.name, kind: place.kind }) : null,
      );
      if (sections.length === 0) return false;
      const passed = passedSections(
        qc.getQueryData<HintsResponse>(inventoryKeys.hints)?.hints ?? undefined,
      );
      let first = 0;
      if (from === 'resume') {
        const progress = tourProgress(sections, passed);
        if (progress.state === 'stopped') first = progress.index;
      } else {
        // Starting over forgets where the last run stopped, on every device.
        for (const id of passed)
          void mark(tourProgressKey(id as TourSectionId), { dismissed: false });
      }
      const run: GuidedRun = {
        alive: true,
        seq: 0,
        sections,
        shownAny: false,
        skipped: new Set<number>(),
        highlight: null,
        muteOnEnd: false,
        dialog: null,
        dialogOpen: false,
        expectPath: router.state.location.pathname,
        stopWatching: null,
        stopArrows: null,
        stepObserver: null,
        stepTimer: null,
        targetObserver: null,
        returnFocus: returnFocus ?? null,
      };
      runRef.current = run;
      // The person's own moves end the run where it is (spec §Interruptions): only the tour's
      // navigations, recorded in `expectPath` before each one, keep it going. A change of search
      // (List to Map) stays on the page and keeps it.
      run.stopWatching = router.subscribe('onResolved', ({ toLocation }) => {
        if (!run.alive || run.dialogOpen) return;
        if (run.expectPath !== null && toLocation.pathname !== run.expectPath) endTour(run);
      });
      hintSlot.take('tour');
      tourLedger.clear();
      setRunning(true);
      try {
        return (await step(run, first)) === 'shown' || run.shownAny;
      } catch {
        abandon(run);
        return false;
      }
    },
    [copy, labels, mark, navigate, router, qc, locationsQuery.data, t],
  );
  return { start, running };
}
