/**
 * The words of every first-use hint and of "Show me around" (D138), in one place. driver.js
 * writes them with `innerHTML` (spike V18), so they are Kept's own translated constants only:
 * no name, place or anything a person typed ever goes into a hint. A caller names the hint by
 * its key; it can't pass text.
 */
import { useLingui } from '@lingui/react/macro';
import { useFormat } from '@/lib/format';

/** The one-time hints (@kept/shared HINT_KEYS less the ones that aren't shown as hints). */
export type FirstUseHint =
  | 'capture.mode_strip'
  | 'inbox.suggested'
  | 'labels.first_print'
  | 'scan.first_open';

export type HintCopy = { title: string; description: string };

export function useHintCopy(): Record<FirstUseHint, HintCopy> & { gotIt: string } {
  const { t } = useLingui();
  return {
    gotIt: t`Got it`,
    'capture.mode_strip': {
      title: t`Pick what you're capturing`,
      description: t`Thing, receipt, label or reading. Switch any time; the camera stays open.`,
    },
    'inbox.suggested': {
      title: t`Suggested values wait for you`,
      description: t`AI wasn't sure of these. Confirm or reject each one: nothing is saved until you accept.`,
    },
    'labels.first_print': {
      title: t`Now stick one on and scan it`,
      description: t`Tap Scan on Home and point the camera at a label: what it belongs to opens, with what's inside. A label keeps its code for good, so a lost one reprints the same.`,
    },
    'scan.first_open': {
      title: t`Point at a Kept label`,
      description: t`What it belongs to opens, with what's inside. A worn label, or no camera? Type the code instead.`,
    },
  };
}

export type TourStop = 'home' | 'capture' | 'inbox' | 'search';

export function useTourCopy() {
  const { t } = useLingui();
  const f = useFormat();
  const stops: Record<TourStop, HintCopy> = {
    home: {
      title: t`Home`,
      description: t`What needs you comes first, then your locations and what's in them.`,
    },
    capture: {
      title: t`Capture`,
      description: t`Photograph things, receipts, labels and meter readings, one after another. It works without a connection too.`,
    },
    inbox: {
      title: t`Inbox`,
      description: t`Captures that need a decision wait here: a name to check, a receipt to link, a possible duplicate.`,
    },
    search: {
      title: t`Search`,
      description: t`Find anything by its name, its place, or what else it's called. On a phone it also works offline.`,
    },
  };
  return {
    stops,
    labels: {
      next: t`Next`,
      previous: t`Previous`,
      done: t`Done`,
      close: t`Close`,
      progress: (current: number, all: number) => {
        const done = f.num(current);
        const total = f.num(all);
        return t`${done} of ${total}`;
      },
    },
  };
}
