/**
 * The app lock's row and the keep-offline tables, for the lock (components/device/app-lock.tsx)
 * and This device (step-8 plan T23; D159, D181, D210). Loaded lazily (it brings Dexie); the chunk
 * is precached, so a cold start offline can still ask for the PIN.
 *
 * One database connection per person, kept for the tab: the same `kept-<userId>` database the
 * offline store opens (offline/db.ts v4), never another person's.
 */
import type { DexieOptions } from 'dexie';
import { KeptDb } from './db';
import type { LockRecord } from './lock';
import { clearCache } from './wipe';

let open: { userId: string; db: KeptDb } | null = null;

/** The person's database; `options` (a fake IndexedDB) for tests. */
export function deviceDb(userId: string, options?: DexieOptions): KeptDb {
  if (open?.userId === userId && !options) return open.db;
  const db = new KeptDb(userId, options);
  if (!options) {
    open?.db.close();
    open = { userId, db };
  }
  return db;
}

export async function readLock(db: KeptDb): Promise<LockRecord | null> {
  return (await db.lock.get('device'))?.record ?? null;
}

export async function saveLock(db: KeptDb, record: LockRecord): Promise<void> {
  await db.lock.put({ key: 'device', record });
}

/** The lock goes off: the lock and everything kept offline go (keep offline needs the lock). */
export async function removeLock(db: KeptDb): Promise<void> {
  await db.transaction('rw', db.lock, db.extras, db.extraDocs, db.keptOffline, async () => {
    await db.lock.clear();
    await db.extras.clear();
    await db.extraDocs.clear();
    await db.keptOffline.clear();
  });
}

/**
 * Ten wrong PINs (D181, D210): this device's copy goes as on a 401 (the snapshot, thumbnails,
 * what was kept offline), the person's own unsent captures stay, locked until they sign in again;
 * the lock goes too, since the next sign-in proves who it is.
 */
export async function wipeAfterTooManyTries(db: KeptDb): Promise<void> {
  await clearCache(db);
  await db.lock.clear();
}
