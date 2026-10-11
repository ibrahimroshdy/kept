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

export type TourStop = 'home' | 'capture' | 'inbox' | 'search' | 'more' | 'labels' | 'settings';

/**
 * The full guided tour's instruction copy (one entry per GUIDED_SECTIONS id in
 * components/hints/tour.ts): what to do there, not a feature blurb. Same rule as above: Kept's
 * own translated constants only, never anything a person typed.
 */
export function useGuidedTourCopy(): Record<string, HintCopy> {
  const { t } = useLingui();
  return {
    home: {
      title: t`Home`,
      description: t`What needs you is at the top. Open one of your locations to see its places and things.`,
    },
    capture: {
      title: t`Capture`,
      description: t`Take a photo of one thing, or add it from your gallery instead. It lands in your Inbox.`,
    },
    inbox: {
      title: t`Inbox`,
      description: t`Open the item, check what Kept suggests, and confirm it. Confirming files it into its place.`,
    },
    'location-detail': {
      title: t`Location`,
      description: t`This is where it landed. Open one of its places to see what's inside it.`,
    },
    search: {
      title: t`Search`,
      description: t`Type the thing's name in the box above and open it from the results.`,
    },
    labels: {
      title: t`Labels`,
      description: t`Open "Label everything unprinted" to see its label. Print it only if you want to stick one on now.`,
    },
    vehicles: {
      title: t`Vehicles`,
      description: t`Open a vehicle to see its odometer, what's due next, and its documents.`,
    },
    schedules: {
      title: t`Schedules`,
      description: t`Open a schedule to see what's due next. A new one starts here too.`,
    },
    lending: {
      title: t`Lending`,
      description: t`Open a loan to see what's out, who has it, and what's overdue.`,
    },
    paperwork: {
      title: t`Paperwork`,
      description: t`Open a document to read it. The ones running out are one tap away.`,
    },
    consumables: {
      title: t`Consumables`,
      description: t`Open something low and adjust its stock after you use some.`,
    },
    activity: {
      title: t`Activity`,
      description: t`Every addition, move and edit, newest first. Search it when you want history.`,
    },
    trash: {
      title: t`Trash`,
      description: t`Trashed things wait here for 30 days. Restore one to put it back.`,
    },
    notifications: {
      title: t`Notifications`,
      description: t`Reminders land here. Open one to act on it, or change what you're told about.`,
    },
    settings: {
      title: t`Settings`,
      description: t`Locations, members, AI and backups live here. Look around: nothing changes unless you change it.`,
    },
    finish: {
      title: t`Done`,
      description: t`That's every section. Anything you added along the way, you can keep or discard.`,
    },
  };
}

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
    more: {
      title: t`More`,
      description: t`Your locations and everything else: vehicles, paperwork, settings and help.`,
    },
    labels: {
      title: t`Labels`,
      description: t`Print QR labels for boxes and shelves. Scan one and its place opens.`,
    },
    settings: {
      title: t`Settings`,
      description: t`Locations, members, AI providers and backups live here.`,
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
