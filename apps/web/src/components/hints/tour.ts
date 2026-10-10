/**
 * "Show me around" (D138): a short driver.js tour over Home → Capture → Inbox → Search, then
 * More, Labels and Settings, started from Help and replayable there. It never starts on launch.
 *
 * Each stop is the navigation element that leads there, marked `data-tour="<stop>"`: the tab bar
 * on a phone, the sidebar and the top bar from 768 px (components/app-shell.tsx, page.tsx). The
 * first one on screen is used; a stop with none (no Inbox for a viewer everywhere, no Labels
 * tab on a phone, no More entry on desktop) is skipped.
 * Finishing or closing it records `help.tour_seen`. While it runs no hint shows.
 */
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
