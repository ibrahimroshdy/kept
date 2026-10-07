/**
 * The lazy door to the offline store (plan T24, T23's bundle budget). Nothing here imports Dexie:
 * the store, the engine and the thumbnail cache arrive with one dynamic import when a signed-in
 * frame first needs them, so the entry chunk stays within the step-2 budget + 15 KB.
 *
 * It also remembers **whose** database is on this device (only the user id, in localStorage), so
 * a 401 that arrives before the store was opened (the session ended while the phone was away)
 * can still clear its cache (D181, D210), and the next sign-in knows whose kept queue it is.
 * Forgotten on sign-out and when an orphan is discarded.
 */
import type { DexieStore } from './dexie-store';
import { type OfflineShell, readShell } from './shell';
import type { SyncEngine } from './sync-engine';
import type { ThumbCache } from './thumbs';

export type Offline = {
  userId: string;
  store: DexieStore;
  engine: SyncEngine;
  thumbs: ThumbCache;
};

const LAST_USER = 'kept.offline.user';

export function lastOfflineUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER);
  } catch {
    return null;
  }
}
function rememberUser(userId: string) {
  try {
    localStorage.setItem(LAST_USER, userId);
  } catch {
    // Private mode, storage off: listing the databases still finds it (wipe.ts, `orphans`).
  }
}
function forgetUser() {
  try {
    localStorage.removeItem(LAST_USER);
  } catch {
    // As above.
  }
}

/** IndexedDB exists here (not in a test's jsdom, nor some locked-down browsers). */
export const offlineSupported = () => typeof indexedDB !== 'undefined';

let current: { userId: string; offline: Promise<Offline> } | null = null;

/** The loaded store and engine for this user, if loaded; never loads. */
export async function currentOffline(): Promise<Offline | null> {
  return current ? current.offline : null;
}

/**
 * Opens (once) the user's store and starts the engine. Another user in the same tab stops the
 * previous engine; their database stays until their own sign-out or 401 (it's theirs).
 */
export function loadOffline(
  userId: string,
  opts: { onSignedOut?: () => void } = {},
): Promise<Offline> {
  if (current?.userId === userId) return current.offline;
  const previous = current;
  const offline = (async (): Promise<Offline> => {
    if (previous) (await previous.offline.catch(() => null))?.engine.stop();
    const [{ createDexieStore }, { SyncEngine }, { ThumbCache }] = await Promise.all([
      import('./dexie-store'),
      import('./sync-engine'),
      import('./thumbs'),
    ]);
    const store = createDexieStore(userId);
    rememberUser(userId);
    // The same person signed back in after a 401: their kept queue goes now (D210).
    await store.unlock();
    const engine = new SyncEngine({
      store,
      onSignedOut: () => {
        void lockOffline().finally(() => opts.onSignedOut?.());
      },
    });
    void engine.start();
    return { userId, store, engine, thumbs: new ThumbCache(store.db) };
  })();
  current = { userId, offline };
  return offline;
}

/**
 * A 401 (D181, D210): the cached inventory goes at once, the person's own unsent queue and its
 * files stay, locked; the database file is never deleted here. The loaded store is cleared in
 * place; one this tab never opened, through the remembered user id, which stays remembered so
 * the next sign-in knows whose queue it is.
 */
export async function lockOffline(): Promise<void> {
  const loaded = current;
  current = null;
  const o = loaded ? await loaded.offline.catch(() => null) : null;
  if (o) {
    o.engine.stop();
    o.thumbs.revokeAll();
    await o.store.wipeCache();
    return;
  }
  const remembered = lastOfflineUser();
  if (remembered && offlineSupported()) await (await import('./wipe')).lockUserDb(remembered);
}

/**
 * An explicit sign-out (after its confirm, D36): all of `userId`'s database goes, queue
 * included. Never another person's: an orphan is discarded only after its own screen (D210).
 */
export async function wipeOffline(userId: string | null): Promise<void> {
  const loaded = current;
  if (lastOfflineUser() === userId) forgetUser();
  const o = loaded ? await loaded.offline.catch(() => null) : null;
  if (o && (userId === null || o.userId === userId)) {
    current = null;
    o.engine.stop();
    o.thumbs.revokeAll();
    await o.store.wipe();
    return;
  }
  if (userId && offlineSupported()) await (await import('./wipe')).deleteUserDb(userId);
}

/**
 * The frame's last-known state on this device, for a cold start offline (shell.ts): the
 * remembered person's, from their own database, or null (nobody remembered, a locked database
 * after a 401, nothing saved yet, no IndexedDB). Never another person's.
 */
export async function lastKnownShell(): Promise<OfflineShell | null> {
  const userId = lastOfflineUser();
  if (!userId || !offlineSupported()) return null;
  try {
    const loaded = current?.userId === userId ? await current.offline.catch(() => null) : null;
    if (loaded) {
      const [shell, locked] = await Promise.all([
        loaded.store.meta('shell'),
        loaded.store.meta('lockedAt'),
      ]);
      return readShell(shell, userId, locked);
    }
    return await (await import('./shell-db')).shellFromDb(userId);
  } catch {
    return null; // IndexedDB refused (a locked-down browser): no offline start.
  }
}

export type { Orphan } from './wipe';

/** Other people's queues left on this phone by a 401 (D210), for the discard screen. */
export async function findOrphans(userId: string): Promise<import('./wipe').Orphan[]> {
  if (!offlineSupported()) return [];
  return (await import('./wipe')).orphans(userId, lastOfflineUser());
}

/** Discards another person's queue, after the screen said what goes with it (D210). */
export async function discardOrphan(userId: string): Promise<void> {
  if (lastOfflineUser() === userId) forgetUser();
  await (await import('./wipe')).deleteUserDb(userId);
}
