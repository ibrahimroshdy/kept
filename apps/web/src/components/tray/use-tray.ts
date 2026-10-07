/**
 * The carrying tray's state (D175, screens §6): the thing ids picked up, in order, kept in the
 * phone's store (`tray: 'thingId, addedAt'` in Dexie), so it survives a reload and works offline.
 * Every change goes through here, so every screen showing "Carrying 3" (the header chip, the
 * scanner, the tray sheet) updates together.
 */
import { useCallback, useEffect, useState } from 'react';
import type { OfflineStore } from '@/offline/store';

const listeners = new Set<() => void>();
const changed = () => {
  for (const fn of listeners) fn();
};

export async function pickUp(store: OfflineStore, ids: readonly string[]): Promise<string[]> {
  const next = [...new Set([...(await store.tray()), ...ids])];
  await store.setTray(next);
  changed();
  return next;
}

export async function putBack(store: OfflineStore, ids?: readonly string[]): Promise<string[]> {
  const drop = ids ? new Set(ids) : null;
  const next = drop ? (await store.tray()).filter((id) => !drop.has(id)) : [];
  await store.setTray(next);
  changed();
  return next;
}

/** The tray's ids (null until read), and the ways to change it. */
export function useTray(store: OfflineStore | null) {
  const [ids, setIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!store) return;
    let live = true;
    // The header reads this on every page: a store that can't answer (a locked database, a
    // test's stand-in) means an empty tray, never a broken page.
    const read = () => {
      if (typeof store.tray !== 'function') return;
      void store
        .tray()
        .then((next) => {
          if (live) setIds(next);
        })
        .catch(() => {});
    };
    read();
    listeners.add(read);
    return () => {
      live = false;
      listeners.delete(read);
    };
  }, [store]);
  const add = useCallback(
    async (more: readonly string[]) => (store ? pickUp(store, more) : []),
    [store],
  );
  const remove = useCallback(
    async (some?: readonly string[]) => (store ? putBack(store, some) : []),
    [store],
  );
  return { ids, add, remove };
}
