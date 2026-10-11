/**
 * "Show me around" (D138): a short driver.js tour over Home → Capture → Inbox → Search, then
 * More, Labels and Settings, started from Help and replayable there. It never starts on launch.
 *
 * Each stop is the navigation element that leads there, marked `data-tour="<stop>"`: the tab bar
 * on a phone, the sidebar and the top bar from 768 px (components/app-shell.tsx, page.tsx). The
 * first one on screen is used; a stop with none (no Inbox for a viewer everywhere, no Labels
 * tab on a phone, no More entry on desktop) is skipped.
 * Finishing or closing it records `help.tour_seen`. While it runs no hint shows.
 *
 * The full guided tour below (GUIDED_SECTIONS) replaces nav keys with sections: an id, the route
 * to navigate to, and the `data-tour` anchor of the destination control (one per section, added
 * where missing). The navigate-then-highlight engine lands in a later task; until then the
 * short tour above still runs. A section with no anchor on screen skips via the `findStop` rule.
 */

import type { ModuleId } from '@kept/shared';
import { useCallback, useState } from 'react';
import type { Shown } from './driver-kit';
import { type TourStop, useTourCopy } from './hint-copy';
import { pageIsRtl, prefersReducedMotion } from './placement';
import { hintSlot, useMarkHint } from './use-hint';

export const TOUR_STOPS: readonly TourStop[] = [
  'home',
  'capture',
  'inbox',
  'search',
  'more',
  'labels',
  'settings',
];

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

/** What gating needs: the modules on anywhere, and whether the inbox exists for this person. */
export type GuidedGating = { modulesOn: Set<string>; hasInbox: boolean };

/** The module behind a section, mirroring `useNavEntries` (components/app-shell.tsx). */
const SECTION_MODULE: Readonly<Partial<Record<string, ModuleId>>> = {
  labels: 'labels',
  vehicles: 'vehicles',
  schedules: 'schedules',
  lending: 'lending',
  paperwork: 'paperwork',
  consumables: 'consumables',
};

/**
 * Whether the section exists for this person: the inbox only for members and above (a viewer
 * everywhere has none), a module section only while its module is on anywhere. Anything else
 * (core pages, the finish) is always there.
 */
export function isGuidedSectionAvailable(sectionId: string, gating: GuidedGating): boolean {
  if (sectionId === 'inbox') return gating.hasInbox;
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

/** The stop's element on screen: the first `[data-tour]` match that has a box. */
export function findStop(stop: TourStop, root: ParentNode = document): Element | null {
  const all = [...root.querySelectorAll(`[data-tour="${stop}"]`)];
  const shown = all.find((el) => el.getClientRects().length > 0);
  if (shown) return shown;
  // A document without layout (jsdom) has no boxes at all: take the first match.
  return document.body.getClientRects().length === 0 ? (all[0] ?? null) : null;
}

let current: Shown | null = null;

/** `start()` runs the tour; `running` is true until it ends. */
export function useShowMeAround() {
  const copy = useTourCopy();
  const mark = useMarkHint();
  const [running, setRunning] = useState(false);
  const start = useCallback(
    async (returnFocus?: HTMLElement | null): Promise<boolean> => {
      const steps = TOUR_STOPS.flatMap((stop) => {
        const element = findStop(stop);
        return element ? [{ element, ...copy.stops[stop] }] : [];
      });
      if (steps.length === 0) return false;
      current?.destroy();
      hintSlot.take('tour');
      setRunning(true);
      try {
        const kit = await import('./driver-kit');
        current = kit.runTour({
          steps,
          rtl: pageIsRtl(),
          reducedMotion: prefersReducedMotion(),
          labels: copy.labels,
          returnFocus: returnFocus ?? null,
          onEnd: () => {
            current = null;
            hintSlot.release('tour');
            setRunning(false);
            void mark('help.tour_seen', { seen: true });
          },
        });
        return true;
      } catch {
        hintSlot.release('tour');
        setRunning(false);
        return false;
      }
    },
    [copy, mark],
  );
  return { start, running };
}
