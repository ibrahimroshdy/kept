/**
 * driver.js 1.8.0 (D138; spike V18), wrapped. This module is loaded with `import()` on the first
 * hint or tour (use-hint.ts, tour.ts), so neither the library nor its CSS is in the entry bundle.
 *
 * What the wrapper adds to the library, each from the spike:
 * - **RTL:** driver.js places with physical sides; placement.ts swaps them in Arabic.
 * - **Focus after "Got it":** the beacon is removed, so focus would drop to <body>. It goes back
 *   to the hinted element (or the first control inside it).
 * - **Text:** title, description and button labels are written with `innerHTML` by driver.js,
 *   so everything is escaped, and only Kept's constant copy is ever passed (hint-copy.ts).
 * - **Keyboard in the tour:** driver.js maps ArrowRight to "next" whatever the direction, which
 *   runs against Arabic reading. Its own keys are off; this module handles Escape and the arrows
 *   by reading direction. Tab stays inside the popover and the highlighted element (driver.js).
 * - **Reduced motion:** no pulse, no animated tour.
 */
import { type AllowedButtons, type Driver, type DriveStep, driver } from 'driver.js';
import { type Hints, hints } from 'driver.js/hints';
import 'driver.js/dist/driver.css';
import 'driver.js/dist/hints.css';
import './hints.css';
import {
  DEFAULT_BEACON,
  DEFAULT_POPOVER,
  escapeHtml,
  type LogicalAlign,
  type LogicalSide,
  physicalAlign,
  physicalSide,
} from './placement';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Focus the element, or the first control inside it; false when it has none. */
export function focusInside(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  const target = el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE);
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/** The last element that had focus outside the hint's own beacon and popover. */
function trackFocus(): { last: () => HTMLElement | null; stop: () => void } {
  let last = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onFocus = (e: FocusEvent) => {
    const el = e.target;
    if (el instanceof HTMLElement && !el.closest('.driver-hint, .driver-popover')) last = el;
  };
  document.addEventListener('focusin', onFocus);
  return { last: () => last, stop: () => document.removeEventListener('focusin', onFocus) };
}

export type HintSpec = {
  id: string;
  element: Element;
  title: string;
  description: string;
  /** "Got it". */
  buttonText: string;
  /** Where the popover sits against the beacon (default: below, at the logical end). */
  side?: LogicalSide;
  align?: LogicalAlign;
  rtl: boolean;
  reducedMotion: boolean;
  /** Open the popover at once (it takes focus to "Got it"), not only when the beacon is used. */
  autoOpen?: boolean;
  /** "Got it" was used: the hint is done for good. */
  onDismiss: () => void;
};

export type Shown = { destroy: () => void };

/** One hint: a beacon on the element, and its popover when the beacon is used. */
export function showHint(spec: HintSpec): Shown {
  const { rtl } = spec;
  const focus = trackFocus();
  let h: Hints | null = null;
  h = hints({
    popoverClass: 'kept-hint',
    hints: [
      {
        id: spec.id,
        element: spec.element,
        beacon: {
          side: physicalSide(DEFAULT_BEACON.side, rtl),
          align: physicalAlign(DEFAULT_BEACON.align, rtl),
          animate: !spec.reducedMotion,
          className: 'kept-hint-beacon',
        },
        popover: {
          title: escapeHtml(spec.title),
          description: escapeHtml(spec.description),
          side: physicalSide(spec.side ?? DEFAULT_POPOVER.side, rtl),
          align: physicalAlign(spec.align ?? DEFAULT_POPOVER.align, rtl),
          buttonText: escapeHtml(spec.buttonText),
          popoverClass: 'kept-hint',
        },
        onDismiss: () => {
          spec.onDismiss();
          // The beacon is gone: focus goes back to the element, or to where it was before.
          if (!focusInside(spec.element)) {
            const before = focus.last();
            if (before?.isConnected && before !== document.body) before.focus();
            else if (spec.element instanceof HTMLElement && spec.element.isConnected) {
              // Nothing to return to (a pointer opened it): the hinted element itself.
              if (!spec.element.hasAttribute('tabindex')) spec.element.tabIndex = -1;
              spec.element.focus();
            }
          }
          focus.stop();
        },
      },
    ],
  });
  h.show();
  // driver.js names the beacon with the title through setAttribute: give it the plain words,
  // not the escaped ones the popover's innerHTML needs.
  for (const beacon of document.querySelectorAll('.kept-hint-beacon'))
    beacon.setAttribute('aria-label', spec.title);
  if (spec.autoOpen) h.open(spec.id);
  return {
    destroy: () => {
      focus.stop();
      h?.hide();
      h = null;
    },
  };
}

export type TourStep = { element: Element; title: string; description: string };

export type TourSpec = {
  steps: TourStep[];
  rtl: boolean;
  reducedMotion: boolean;
  labels: {
    next: string;
    previous: string;
    done: string;
    close: string;
    /** "2 of 4", in the reader's digits. */
    progress: (current: number, total: number) => string;
  };
  /** The tour ended: `completed` when "Done" was used on the last step. */
  onEnd: (completed: boolean) => void;
  /** Where focus goes back to when the tour ends (the button that started it). */
  returnFocus?: HTMLElement | null;
};

/** "Show me around" (D138): the steps in order, replayable, never started on its own. */
export function runTour(spec: TourSpec): Shown {
  const { labels, rtl } = spec;
  const total = spec.steps.length;
  let completed = false;
  const steps: DriveStep[] = spec.steps.map((s, i) => ({
    element: s.element,
    popover: {
      title: escapeHtml(s.title),
      description: escapeHtml(s.description),
      side: physicalSide('bottom', rtl),
      align: physicalAlign('start', rtl),
      // Nothing comes before the first stop: no Previous there.
      ...(i === 0 ? { showButtons: ['next', 'close'] as AllowedButtons[] } : {}),
      onPopoverRender: (popover) => {
        popover.closeButton.setAttribute('aria-label', labels.close);
        // textContent, not driver.js's `progressText` (innerHTML, Western digits only).
        popover.progress.textContent = labels.progress(i + 1, total);
      },
    },
  }));

  let d: Driver | null = null;
  let ended = false;
  // driver.js calls onDestroyed only when a step was fully highlighted; every way out ends here.
  const finish = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener('keydown', onKey);
    // driver.js restores focus only to what had it before; a mouse click may have left none.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost && spec.returnFocus?.isConnected) spec.returnFocus.focus();
    spec.onEnd(completed);
  };
  const end = () => {
    const was = d;
    d = null;
    was?.destroy();
    finish();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!d?.isActive()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      end();
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    // Forward is the reading direction: right in English, left in Arabic.
    const forward = (e.key === 'ArrowRight') !== rtl;
    e.preventDefault();
    if (forward) {
      if (d.hasNextStep()) d.moveNext();
    } else if (d.hasPreviousStep()) d.movePrevious();
  };

  d = driver({
    steps,
    animate: !spec.reducedMotion,
    smoothScroll: !spec.reducedMotion,
    allowKeyboardControl: false,
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    nextBtnText: escapeHtml(labels.next),
    prevBtnText: escapeHtml(labels.previous),
    doneBtnText: escapeHtml(labels.done),
    popoverClass: 'kept-tour',
    stagePadding: 6,
    stageRadius: 12,
    onDoneClick: () => {
      completed = true;
      end();
    },
    onCloseClick: end,
    onDestroyed: () => {
      d = null;
      finish();
    },
  });
  window.addEventListener('keydown', onKey);
  d.drive(0);
  return { destroy: end };
}
