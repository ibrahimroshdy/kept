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
 * The full guided tour's instruction copy (one entry per GUIDED_SECTIONS id in
 * components/hints/tour.ts): what to do there, not a feature blurb. Same rule as above: Kept's
 * own translated constants only, never anything a person typed.
 */
export function useGuidedTourCopy(): Record<string, HintCopy> {
  const { t } = useLingui();
  return {
    home: {
      title: t`Home`,
      description: t`What needs you is at the top, your locations below it. Next takes you into one.`,
    },
    capture: {
      title: t`Capture`,
      description: t`Take a photo of one thing, or pick one from your gallery, then tap Next. It waits in your Inbox.`,
    },
    inbox: {
      title: t`Inbox`,
      description: t`Your photo waits here. Check what Kept suggests and accept it: accepting files it into its place.`,
    },
    'location-detail': {
      title: t`Location`,
      description: t`A location's places, and how much each holds. Open any of them after the tour.`,
    },
    // An empty household has no location to open: this step stands in for the location detail
    // and its copy is the micro-action. The title reuses the existing "New location" entry.
    'new-location': {
      title: t`New location`,
      description: t`Name it and create it. At the end you keep it, or discard it.`,
    },
    search: {
      title: t`Search`,
      description: t`Type part of a thing's name above. Each result shows where it is.`,
    },
    labels: {
      title: t`Labels`,
      description: t`What has no label yet is listed here. Print a sheet whenever you want to stick some on.`,
    },
    vehicles: {
      title: t`Vehicles`,
      description: t`Each vehicle shows its odometer, what's due next and its documents.`,
    },
    schedules: {
      title: t`Schedules`,
      description: t`What's due, soonest first. New schedules start here too.`,
    },
    lending: {
      title: t`Lending`,
      description: t`What's lent out, who has it, and what's overdue.`,
    },
    paperwork: {
      title: t`Paperwork`,
      description: t`Every document, with the ones running out first.`,
    },
    consumables: {
      title: t`Consumables`,
      description: t`What runs low, with how much is left.`,
    },
    activity: {
      title: t`Activity`,
      description: t`Every addition, move and edit, newest first. Search it when you want history.`,
    },
    trash: {
      title: t`Trash`,
      description: t`Trashed things wait here for 30 days, each with Restore.`,
    },
    notifications: {
      title: t`Notifications`,
      description: t`Reminders land here, newest first. What you're told about is in Settings.`,
    },
    settings: {
      title: t`Settings`,
      description: t`Locations, members, AI and backups live here. Nothing changes unless you change it.`,
    },
    finish: {
      title: t`Done`,
      description: t`That's every section. If the tour added anything, you choose to keep it or discard it.`,
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
