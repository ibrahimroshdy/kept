/**
 * Getting Kept onto the phone (D139; plan T23).
 *
 * - Android and desktop Chrome fire `beforeinstallprompt`: it is kept here, and the install sheet
 *   (components/home/install-sheet.tsx) offers "Install Kept", which shows the browser's prompt.
 * - iPhone and iPad have no prompt: the sheet shows Share → Add to Home Screen.
 * - Opened in standalone display mode, the checklist's "Install on your phone" ticks itself
 *   (components/home/checklist.tsx posts the `installed_standalone` hint).
 */
import { useSyncExternalStore } from 'react';
import { describeUserAgent } from '@/lib/user-agent';

/** Chrome's `BeforeInstallPromptEvent` (not in the DOM typings). */
type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};

/** Starts listening; call once at boot, before the browser fires the event. */
export function captureInstallPrompt(target: Window = window): void {
  target.addEventListener('beforeinstallprompt', (e) => {
    // Keep the browser's own mini-infobar away; Kept offers install from its checklist.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** Whether the browser's own install prompt is available now. */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Shows the browser's install prompt; true when the person accepted. It can be shown once. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  notify();
  await e.prompt();
  const choice = await e.userChoice;
  return choice.outcome === 'accepted';
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Whether the browser's install prompt is available, as React state. */
export function useCanPromptInstall(): boolean {
  return useSyncExternalStore(subscribe, canPromptInstall, () => false);
}

/** iPhone and iPad: no install prompt and no share target (V9), so Kept explains instead. */
export function isAppleMobile(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints) {
  const { os } = describeUserAgent(ua);
  // iPadOS asks for desktop sites and reports a Mac; its touch points give it away.
  return os === 'iPhone' || os === 'iPad' || (os === 'Mac' && touchPoints > 1);
}
