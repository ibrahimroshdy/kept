/**
 * The offline store the PWA shell uses: the update prompt's upload gate (D148) and the share
 * target's files (D140). It starts as a `MemoryStore`; T24 swaps in the signed-in person's Dexie
 * store with `setPageStore()` when it opens it, and back on sign-out.
 */
import { MemoryStore, type OfflineStore } from '@/offline/store';
import { addUpdateGate, uploadIdle } from './register';

let current: OfflineStore = new MemoryStore();
let removeGate = addUpdateGate(uploadIdle(current));

export function pageStore(): OfflineStore {
  return current;
}

/** Uses `store` from now on, and gates updates on its uploads. */
export function setPageStore(store: OfflineStore): void {
  removeGate();
  current = store;
  removeGate = addUpdateGate(uploadIdle(store));
}
