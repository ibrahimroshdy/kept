/**
 * The full guided tour (D138): started from Help ("Show me around") and replayable there, it
 * navigates for real through every section — Home, Capture, Inbox, one location's detail,
 * Search, Labels, every More entry that exists for this person, Settings — and finishes on
 * Help, asking Keep or Discard when the run added anything. It never starts on launch.
 *
 * Each section is the destination control to point at, marked `data-tour="<anchor>"` (More
 * rows carry their section's destination anchor so the phone resolves them). The first anchor
 * on screen is used; a section with none (module off, viewer with no Inbox) is skipped.
 * Finishing or closing it records `help.tour_seen`. While it runs no hint shows.
 */

import type { ModuleId } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { createElement, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { captureApi } from '@/api/capture/queries';
import { inventoryApi } from '@/api/inventory/queries';
import { deleteLocation, listLocations } from '@/api/locations';
import { keys, useLocations } from '@/api/queries';
import type { Shown } from './driver-kit';
import { useGuidedTourCopy, useTourCopy } from './hint-copy';
import { pageIsRtl, prefersReducedMotion } from './placement';
import { TourKeepHost } from './tour-keep';
import { type TourDeleter, tourLedger } from './tour-ledger';
import { hintSlot, useMarkHint } from './use-hint';

/**
 * One section of the full guided tour: the route to navigate to and the destination control to
 * point at. Every section is skippable to the next one. `params` stays empty here for the
 * location detail: the engine fills the location id from the person's first location at runtime.
 */
export type TourSection = {
  id: string;
  to: string;
  params?: Record<string, string>;
  anchor: string;
  skippable: true;
};

/** The full walk in spec order; entries gated out for this person skip silently (below). */
export const GUIDED_SECTIONS: readonly TourSection[] = [
  { id: 'home', to: '/', anchor: 'home-locations', skippable: true },
  { id: 'capture', to: '/capture', anchor: 'capture-shutter', skippable: true },
  { id: 'inbox', to: '/inbox', anchor: 'inbox-items', skippable: true },
  { id: 'location-detail', to: '/loc/$id', anchor: 'location-places', skippable: true },
  { id: 'search', to: '/search', anchor: 'search-field', skippable: true },
  { id: 'labels', to: '/labels', anchor: 'labels-print', skippable: true },
  { id: 'vehicles', to: '/vehicles', anchor: 'vehicles', skippable: true },
  { id: 'schedules', to: '/schedules', anchor: 'schedules', skippable: true },
  { id: 'lending', to: '/lending', anchor: 'lending', skippable: true },
  { id: 'paperwork', to: '/paperwork', anchor: 'paperwork', skippable: true },
  { id: 'consumables', to: '/consumables', anchor: 'consumables', skippable: true },
  { id: 'activity', to: '/activity', anchor: 'activity', skippable: true },
  { id: 'trash', to: '/trash', anchor: 'trash', skippable: true },
  { id: 'notifications', to: '/notifications', anchor: 'notifications', skippable: true },
  { id: 'settings', to: '/settings', anchor: 'settings-main', skippable: true },
  { id: 'finish', to: '/help', anchor: 'help-tour', skippable: true },
];

/** What gating needs: the modules on anywhere, and whether anything is writable. */
export type GuidedGating = { modulesOn: Set<ModuleId>; hasInbox: boolean };

/** The module behind a section, mirroring `useNavEntries` (components/app-shell.tsx). */
const SECTION_MODULE: Readonly<Partial<Record<string, ModuleId>>> = {
  labels: 'labels',
  vehicles: 'vehicles',
  schedules: 'schedules',
  lending: 'lending',
  paperwork: 'paperwork',
  consumables: 'consumables',
};

/** Sections whose tour action is a write: taking the photo, confirming the suggestion. */
const WRITE_SECTIONS: ReadonlySet<string> = new Set(['capture', 'inbox']);

/**
 * Whether the section exists for this person: a write section only where something can change
 * (`hasInbox` is exactly that — some location where the role isn't viewer), a module section
 * only while its module is on anywhere. Anything else (core pages, the finish) is always
 * there. The inbox wrapper keeps its anchor for viewers (routes/_app/inbox.tsx), so the
 * inbox skips here and not on anchor absence.
 */
export function isGuidedSectionAvailable(sectionId: string, gating: GuidedGating): boolean {
  if (WRITE_SECTIONS.has(sectionId)) return gating.hasInbox;
  const module = SECTION_MODULE[sectionId];
  return module ? gating.modulesOn.has(module) : true;
}

/** A More entry's key is its section id, except Help, which ends the tour. */
const SECTION_BY_NAV_KEY: Readonly<Record<string, string>> = { help: 'finish' };

/**
 * The guided anchor for a More row (routes/_app/more.tsx): the section's destination anchor, so
 * the phone resolves the section from the row and the destination page after navigating. Keys
 * with no section (the coming-soon entries) give nothing.
 */
export function guidedAnchorForNavKey(navKey: string): string | undefined {
  const id = SECTION_BY_NAV_KEY[navKey] ?? navKey;
  return GUIDED_SECTIONS.find((s) => s.id === id)?.anchor;
}

// ----- the full guided tour's navigate-then-highlight engine -----

/** How long a section waits for its destination anchor before skipping past it. */
export const GUIDED_ANCHOR_WAIT_MS = 3000;

/** A section's destination control: the first `[data-tour]` match that has a box. */
export function findSectionAnchor(anchor: string, root: ParentNode = document): Element | null {
  const all = [...root.querySelectorAll(`[data-tour="${CSS.escape(anchor)}"]`)];
  const shown = all.find((el) => el.getClientRects().length > 0);
  if (shown) return shown;
  // A document without layout (jsdom) has no boxes at all: take the first match.
  return document.body.getClientRects().length === 0 ? (all[0] ?? null) : null;
}

/**
 * The anchor once the route renders it: a MutationObserver plus an animation-frame poll,
 * bounded by `timeout` — never a fixed sleep. A section whose anchor never appears skips,
 * as today.
 */
export function waitForSectionAnchor(
  anchor: string,
  timeout = GUIDED_ANCHOR_WAIT_MS,
): Promise<Element | null> {
  const hit = () => findSectionAnchor(anchor);
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

/** A guided section with its runtime route and copy: the location id filled, or New location. */
export type ResolvedGuidedSection = TourSection & { copyId: string };

/**
 * The location detail points at the person's first location, resolved at tour start (the
 * section list carries no id). Zero locations routes through New location as the micro-action
 * (spec decision 2): creating one there records it in the ledger
 * (routes/_app/locations.new.tsx), deletable on Discard.
 */
export function resolveGuidedSections(
  sections: readonly TourSection[],
  firstLocationId: string | null,
): ResolvedGuidedSection[] {
  return sections.map((s) => {
    if (s.id !== 'location-detail') return { ...s, copyId: s.id };
    if (firstLocationId) return { ...s, params: { id: firstLocationId }, copyId: s.id };
    return {
      id: s.id,
      to: '/locations/new',
      anchor: 'new-location-name',
      skippable: true,
      copyId: 'new-location',
    };
  });
}

/** The pathname a section navigates to, for telling the tour's own moves apart. */
function sectionPath(section: ResolvedGuidedSection): string {
  let path = section.to;
  for (const [key, value] of Object.entries(section.params ?? {}))
    path = path.replace(`$${key}`, encodeURIComponent(value));
  return path;
}

/**
 * Discard through the existing mutations (spec decision 3): Trash-move for things and places,
 * the location delete, the capture batch undo. A printed label exists in the world — nothing
 * deletes it, so its entry reports back as kept and the dialog says so.
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
    case 'label':
      throw new Error('Label batches stay: the tour only previews labels.');
  }
};

type GuidedRun = {
  alive: boolean;
  /** Bumps on every move: stale async continuations stand down. */
  seq: number;
  sections: ResolvedGuidedSection[];
  /** Shown at least once, for progress that counts shown sections. */
  shown: boolean[];
  shownAny: boolean;
  /** Skipped for a missing anchor on an earlier pass: Back/Skip jump over these. */
  skipped: Set<number>;
  highlight: Shown | null;
  /** A programmatic destroy is coming: its onEnd is the engine's own echo, not the person. */
  muteOnEnd: boolean;
  dialog: { root: Root; el: HTMLDivElement } | null;
  dialogOpen: boolean;
  /** The route the tour itself put the person on; anything else aborts the run. */
  expectPath: string | null;
  stopWatching: (() => void) | null;
  stopArrows: (() => void) | null;
  /** The step-button watcher while the popover animates in: dropped on every move. */
  stepObserver: MutationObserver | null;
  stepTimer: number | null;
  returnFocus: HTMLElement | null;
};

/** Drop the step-button watcher: its popover is gone on every move and at teardown. */
function clearStepWatcher(run: GuidedRun): void {
  run.stepObserver?.disconnect();
  run.stepObserver = null;
  if (run.stepTimer !== null) {
    window.clearTimeout(run.stepTimer);
    run.stepTimer = null;
  }
}

/** The nearest section before `i` that wasn't skipped for a missing anchor. */
function backTo(run: GuidedRun, i: number): number {
  let j = i - 1;
  while (j > 0 && run.skipped.has(j)) j -= 1;
  return j;
}

/** The nearest section after `i` that wasn't skipped for a missing anchor. */
function forwardTo(run: GuidedRun, i: number): number {
  let j = i + 1;
  while (j < run.sections.length && run.skipped.has(j)) j += 1;
  return j;
}

/**
 * The step's Back and Skip-section buttons. driver.js only knows Next/Previous/Close, and a
 * single-step highlight shows Done/Close — so the engine adds its own two beside Done: Back
 * where a previous section showed, Skip-section everywhere. They wear only the popover's
 * generic footer-button class: the prev/next classes would also match driver.js's own
 * delegated click handler (`.closest('.driver-popover-prev-btn')`), hijacking the click.
 */
function injectStepButtons(
  run: GuidedRun,
  seq: number,
  {
    back,
    onBack,
    onSkip,
    backLabel,
    skipLabel,
  }: {
    back: boolean;
    onBack: () => void;
    onSkip: () => void;
    backLabel: string;
    skipLabel: string;
  },
): void {
  const fresh = () => run.alive && run.seq === seq;
  const make = (name: 'back' | 'skip', label: string, fn: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'driver-popover-footer-btn';
    button.dataset.tourBtn = name;
    button.textContent = label;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return button;
  };
  const place = () => {
    if (!fresh()) return true;
    const bar = document.querySelector('.driver-popover .driver-popover-navigation-btns');
    if (!bar) return false;
    if (back && !bar.querySelector('[data-tour-btn="back"]'))
      bar.prepend(make('back', backLabel, onBack));
    if (!bar.querySelector('[data-tour-btn="skip"]')) {
      const skip = make('skip', skipLabel, onSkip);
      const next = bar.querySelector('.driver-popover-next-btn, .driver-popover-done-btn');
      if (next) bar.insertBefore(skip, next);
      else bar.append(skip);
    }
    return true;
  };
  // The last step's watcher, if it never placed, dies with this move.
  clearStepWatcher(run);
  if (place()) return;
  // The popover animates in: watch for it briefly, then give up (Done/Close still work).
  // Stashed on the run so a fast Back/Skip/close drops it with the stale popover.
  const mo = new MutationObserver(() => {
    if (!place()) return;
    mo.disconnect();
    if (run.stepObserver !== mo) return;
    run.stepObserver = null;
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

/** `start()` runs the full guided tour; `running` is true until it ends. */
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
    clearStepWatcher(run);
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

  /** Show section `i`: navigate, wait for its anchor, highlight it. Past the end, finish. */
  const step = async (run: GuidedRun, i: number): Promise<'shown' | 'ended'> => {
    const seq = ++run.seq;
    const live = () => run.alive && run.seq === seq;
    if (!run.alive) return 'ended';
    if (i >= run.sections.length) {
      endTour(run);
      return 'ended';
    }
    // Known-unshown from an earlier pass: jump it without another navigate and anchor wait.
    if (run.skipped.has(i)) return step(run, i + 1);
    const section = run.sections[i];
    // Unreachable (callers stay in range), but a skip beats a crash.
    if (!section) return step(run, i + 1);
    destroyHighlight(run);
    run.expectPath = sectionPath(section);
    try {
      await navigate({ to: section.to as never, params: section.params as never });
    } catch {
      if (live()) {
        run.skipped.add(i);
        return step(run, i + 1);
      }
      return 'ended';
    }
    const el = await waitForSectionAnchor(section.anchor);
    if (!live()) return 'ended';
    if (!el) {
      run.skipped.add(i);
      return step(run, i + 1);
    }
    run.shown[i] = true;
    run.shownAny = true;
    // Progress counts shown sections: everything displayed up to and including this one.
    const position = run.shown.slice(0, i + 1).filter(Boolean).length;
    const total = run.sections.length;
    const entry = copy[section.copyId] ?? copy[section.id];
    if (!entry) return step(run, i + 1);
    const isLast = i === run.sections.length - 1;
    const kit = await import('./driver-kit');
    if (!live()) return 'ended';
    destroyHighlight(run);
    run.highlight = kit.runTour({
      steps: [{ element: el, title: entry.title, description: entry.description }],
      rtl: pageIsRtl(),
      reducedMotion: prefersReducedMotion(),
      labels: {
        ...labels,
        // A single step always renders the done label: Next until the last shown section.
        done: isLast ? labels.done : labels.next,
        // Progress counts shown sections, not this one-element step list.
        progress: () => labels.progress(position, total),
      },
      returnFocus: run.returnFocus,
      onEnd: (completed) => {
        run.highlight = null;
        if (run.muteOnEnd || !run.alive) return;
        if (completed) void step(run, i + 1);
        else endTour(run);
      },
    });
    injectStepButtons(run, seq, {
      back: i > 0,
      onBack: () => {
        if (run.alive) void step(run, backTo(run, i));
      },
      onSkip: () => {
        if (run.alive) void step(run, forwardTo(run, i));
      },
      backLabel: t`Back`,
      skipLabel: t`Skip`,
    });
    watchArrows(run, i);
    return 'shown';
  };

  /** Arrows move between shown sections, by reading direction; Escape stays driver's. */ const watchArrows =
    (run: GuidedRun, i: number) => {
      run.stopArrows?.();
      const onKey = (e: KeyboardEvent) => {
        if (!run.alive || run.dialogOpen || !run.highlight) return;
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const forward = (e.key === 'ArrowRight') !== pageIsRtl();
        if (!forward && i === 0) return;
        e.preventDefault();
        void step(run, forward ? forwardTo(run, i) : backTo(run, i));
      };
      window.addEventListener('keydown', onKey);
      run.stopArrows = () => window.removeEventListener('keydown', onKey);
    };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the run helpers close over this render by design; the tour outlives Help's unmount.
  const start = useCallback(
    async (returnFocus?: HTMLElement | null): Promise<boolean> => {
      if (runRef.current) abandon(runRef.current);
      const cached = locationsQuery.data;
      let locations = cached;
      if (!locations) {
        try {
          locations = await qc.fetchQuery({ queryKey: keys.locations, queryFn: listLocations });
        } catch {
          // Offline at start: run what the routes show, with no inbox and no modules.
          locations = [];
        }
      }
      const known = locations ?? [];
      const gating: GuidedGating = {
        modulesOn: new Set(known.flatMap((l) => l.modules)),
        // Something can change somewhere: the inbox, and the capture write, exist for you.
        hasInbox: known.some((l) => l.role !== 'viewer'),
      };
      const sections = resolveGuidedSections(
        GUIDED_SECTIONS.filter((s) => isGuidedSectionAvailable(s.id, gating)),
        known[0]?.id ?? null,
      );
      if (sections.length === 0) return false;
      const run: GuidedRun = {
        alive: true,
        seq: 0,
        sections,
        shown: sections.map(() => false),
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
        returnFocus: returnFocus ?? null,
      };
      runRef.current = run;
      // The person's own moves end the run where it is (spec §Interruptions): only the tour's
      // navigations, recorded in `expectPath` before each one, keep it going.
      run.stopWatching = router.subscribe('onResolved', ({ toLocation }) => {
        if (!run.alive || run.dialogOpen) return;
        if (run.expectPath !== null && toLocation.pathname !== run.expectPath) endTour(run);
      });
      hintSlot.take('tour');
      tourLedger.clear();
      setRunning(true);
      try {
        return (await step(run, 0)) === 'shown' || run.shownAny;
      } catch {
        abandon(run);
        return false;
      }
    },
    [copy, labels, mark, navigate, router, qc, locationsQuery.data, t],
  );
  return { start, running };
}
