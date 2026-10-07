/**
 * Registering the service worker and the update flow (D148; plan T23).
 *
 * A new worker installs in the background and **waits**. The page shows "A new version is
 * ready · Reload" (update-prompt.tsx) only when every update gate says it's safe: nothing is
 * uploading (`uploadIdle(store)`) and no capture session is open (`useHoldUpdates`). Reload
 * sends SKIP_WAITING through @serwist/window, and the page reloads once the new worker controls
 * it. Kept never reloads mid-capture.
 *
 * Registered only in a secure context (HTTPS, or localhost): browsers refuse service workers on
 * plain HTTP, where the app shows the HTTPS banner instead (D31, D193).
 */
import type { Serwist } from '@serwist/window';
import { useEffect, useSyncExternalStore } from 'react';
import type { OfflineStore } from '@/offline/store';
import { isRuntimeCachedChunk } from './sw-routes';

// ----- update gates --------------------------------------------------------------------------

/** Says whether reloading now is safe. Gates are asked every time, never cached. */
export type UpdateGate = () => boolean | Promise<boolean>;

const gates = new Set<UpdateGate>();

/** Adds a gate; returns the function that removes it. */
export function addUpdateGate(gate: UpdateGate): () => void {
  gates.add(gate);
  return () => {
    gates.delete(gate);
  };
}

/** True when every gate allows a reload. A gate that throws counts as "not now". */
export async function updateIsSafe(): Promise<boolean> {
  for (const gate of [...gates]) {
    try {
      if (!(await gate())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The upload gate: nothing of the queue is on its way to the server (D148). */
export function uploadIdle(store: Pick<OfflineStore, 'counts'>): UpdateGate {
  return async () => (await store.counts()).uploading === 0;
}

/**
 * Holds updates while `active` (a capture session is open, T25). The prompt waits and shows once
 * the hold is released.
 */
export function useHoldUpdates(active: boolean): void {
  useEffect(() => (active ? addUpdateGate(() => false) : undefined), [active]);
}

// ----- update state --------------------------------------------------------------------------

/**
 * - `idle`: nothing to do.
 * - `waiting`: a new worker is installed and waiting for the person's Reload.
 * - `stale`: another tab already switched to the new worker; this page is out of date and a
 *   plain reload brings it up to date.
 * - `reloading`: Reload was pressed; the page reloads when the new worker takes control.
 */
export type UpdateState = 'idle' | 'waiting' | 'stale' | 'reloading';

/** The update flow, separate from the browser so it can be tested. */
export class Updates {
  private state: UpdateState = 'idle';
  private listeners = new Set<() => void>();

  constructor(
    private readonly worker: { messageSkipWaiting(): void },
    private readonly reload: () => void = () => window.location.reload(),
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getState = () => this.state;

  private set(state: UpdateState) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  /** A new worker is waiting. */
  onWaiting(): void {
    if (this.state !== 'reloading') this.set('waiting');
  }

  /** A new worker took control of this page. */
  onControlling(isUpdate: boolean): void {
    if (this.state === 'reloading') this.reload();
    else if (isUpdate) this.set('stale');
  }

  /** Reload pressed: re-checks the gates, then hands over to the new worker (or just reloads). */
  async apply(): Promise<boolean> {
    if (!(await updateIsSafe())) return false;
    if (this.state === 'stale') {
      this.reload();
      return true;
    }
    this.set('reloading');
    this.worker.messageSkipWaiting();
    return true;
  }
}

let registered: { updates: Updates } | null = null;
/** Set once registration fails, for the diagnostics page. */
export let registrationError: string | null = null;

/** Where a service worker can run: a secure context with the API present. */
export function serviceWorkerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

/**
 * Registers /sw.js once, after the page has loaded (so the precache doesn't compete with the first
 * render). A no-op where service workers can't run. @serwist/window loads lazily, off the entry
 * chunk.
 */
export function registerServiceWorker(): Updates | null {
  if (registered) return registered.updates;
  if (!serviceWorkerSupported()) return null;
  let worker: Serwist | null = null;
  const updates = new Updates({ messageSkipWaiting: () => worker?.messageSkipWaiting() });
  registered = { updates };
  const start = async () => {
    try {
      const { Serwist } = await import('@serwist/window');
      worker = new Serwist('/sw.js', { scope: '/', type: 'classic' });
      worker.addEventListener('waiting', () => updates.onWaiting());
      worker.addEventListener('controlling', (e) => {
        updates.onControlling(e.isUpdate === true);
        void warmRuntimeCaches();
      });
      // Already controlled (every visit after the first): make sure this visit's chunks are kept.
      if (navigator.serviceWorker.controller) void warmRuntimeCaches();
      await worker.register();
    } catch (err) {
      registrationError = err instanceof Error ? err.message : String(err);
    }
  };
  if (document.readyState === 'complete') void start();
  else window.addEventListener('load', () => void start(), { once: true });
  return updates;
}

/**
 * Fetches again, through the worker, the catalogue and icon chunks this page loaded before the
 * worker controlled it (the first visit), so its CacheFirst routes keep them: the shell then
 * opens offline in the person's language. Already-cached ones are answered from the cache.
 */
export async function warmRuntimeCaches(): Promise<void> {
  const urls = performance
    .getEntriesByType('resource')
    .map((e) => new URL(e.name))
    .filter((u) => u.origin === location.origin && isRuntimeCachedChunk(u.pathname))
    .map((u) => u.href);
  await Promise.all([...new Set(urls)].map((u) => fetch(u).catch(() => undefined)));
}

/** The app's update flow, or null before registration (dev, tests, plain HTTP). */
export function appUpdates(): Updates | null {
  return registered?.updates ?? null;
}

const idle = () => () => undefined;

/** The update state as React state. */
export function useUpdateState(updates: Updates | null): UpdateState {
  return useSyncExternalStore(
    updates?.subscribe ?? idle,
    updates?.getState ?? (() => 'idle' as const),
    () => 'idle' as const,
  );
}
