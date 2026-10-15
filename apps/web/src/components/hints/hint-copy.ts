/**
 * The words of every first-use hint and of the full guided tour (D138), in one place. driver.js
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

/**
 * The guided tour's copy (D242): one entry per GUIDED_SECTIONS stop in components/hints/tour.ts,
 * saying what the highlighted control does, in the words on the screen. Same rule as above:
 * Kept's own translated constants only, never anything a person typed.
 */
export function useGuidedTourCopy(): Record<string, HintCopy> {
  const { t } = useLingui();
  return {
    home: {
      title: t`Home`,
      description: t`What needs you, counted. Tap a tile for its list. Your locations are below.`,
    },
    capture: {
      title: t`Capture`,
      description: t`Take a photo, or pick one with Gallery. It waits in your Inbox. At the end you keep it or discard it.`,
    },
    inbox: {
      title: t`Inbox`,
      description: t`Photos wait here until you confirm what Kept read from them. Switch between yours and everyone's.`,
    },
    location: {
      title: t`Location`,
      description: t`List, Grid or Map. Map shows the location floor by floor, with what's in each room.`,
    },
    // An empty household has no location to open: this step stands in for the location and
    // its copy is the micro-action. The title reuses the existing "New location" entry.
    'new-location': {
      title: t`New location`,
      description: t`Name it and create it. At the end you keep it, or discard it.`,
    },
    search: {
      title: t`Search`,
      description: t`Type part of a name, a brand, a serial or a short ID. Each result says where it is.`,
    },
    labels: {
      title: t`Labels`,
      description: t`Print labels for what has none yet. Scan one later and Kept opens what it's on.`,
    },
    more: {
      title: t`More`,
      description: t`Every section that isn't on the tab bar: the modules you use, Activity, Trash, Settings and Help.`,
    },
    'more-wide': {
      title: t`Everything else`,
      description: t`Every section, one click away. A module shows here once it's on in one of your locations.`,
    },
    settings: {
      title: t`Notifications`,
      description: t`Choose what reaches you, and how: in Kept, by email, push or a channel. Once for every location, or per location.`,
    },
    finish: {
      title: t`That's the tour`,
      description: t`Replay it from here any time. Close it early and it picks up where you stopped.`,
    },
  };
}

/** The tour popover's own buttons and progress, shared by the guided engine. */
export function useTourCopy() {
  const { t } = useLingui();
  const f = useFormat();
  return {
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
