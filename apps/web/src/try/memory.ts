/**
 * Try Kept (D246) keeps nothing in the browser: every IndexedDB database the app opens (the
 * offline copy of the household, its capture queue, the thumbnails) is fake-indexeddb, in this
 * tab's memory, so the app works as it does on a phone (Capture's places, search, sync) and a
 * reload or Reset starts again from nothing. Called before anything opens a database: Dexie
 * reads `indexedDB` when it first loads, which is later, with the offline store.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

export function indexedDbInMemory(win: Window = window): void {
  Object.defineProperty(win, 'indexedDB', { configurable: true, value: new IDBFactory() });
  Object.defineProperty(win, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
}
