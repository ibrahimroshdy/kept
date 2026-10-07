/** A Dexie store on its own in-memory fake-indexeddb, for tests (plan T24). */
import { newId } from '@kept/shared';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { DexieStore } from '@/offline/dexie-store';

/** Options for a fresh fake-indexeddb; share one between stores to model one phone. */
export const fakeIdb = () => ({ indexedDB: new IDBFactory(), IDBKeyRange });

export const makeDexieStore = (
  userId: string = newId(),
  options: ReturnType<typeof fakeIdb> = fakeIdb(),
) => new DexieStore(userId, '0.1.0', options);
