/**
 * What goes, and when (D36, D181, D210). Loaded lazily with Dexie (open.ts picks the case).
 *
 * - **A 401** (the session ended): the cached inventory goes at once (the snapshot, thumbnails,
 *   the tray, notices, shares, and answered ops, since all of it may show other people's
 *   things), but **the person's own unanswered ops and their files stay**, locked. The database
 *   file itself is never deleted on this path. Nothing opens it until someone signs in:
 *   - the same person: the store opens as before and the engine sends the queue;
 *   - someone else: `orphans()` finds it, the frame says how many captures and photos it holds,
 *     then `deleteUserDb()` discards it.
 *   What "keep this location available offline" holds goes with the cache; the app lock stays.
 * - **An explicit sign-out** (after its confirm), and a discarded orphan: the whole database.
 */
import Dexie, { type DexieOptions } from 'dexie';
import { dbName, KeptDb, type MetaKey } from './db';
import { UNANSWERED } from './store';

/** Meta the kept queue still needs after a 401: whether persistence was granted (V11). */
const META_KEPT: readonly MetaKey[] = ['persisted'];

/** The 401 path on an open database: the cache goes, the unanswered queue and its files stay. */
export async function clearCache(db: KeptDb): Promise<void> {
  const cacheTables = [
    db.locations,
    db.places,
    db.things,
    db.codes,
    db.legacyCodes,
    db.types,
    db.thumbs,
    db.tray,
    db.notices,
    db.shared,
    // Step 8: what "keep this location available offline" holds goes too (D181). The app lock
    // stays: it is the person's own, and their next sign-in on this phone keeps it.
    db.extras,
    db.extraDocs,
    db.keptOffline,
  ];
  await db.transaction('rw', [...cacheTables, db.meta, db.queue, db.blobs], async () => {
    for (const t of cacheTables) await t.clear();
    await db.meta.filter((m) => !META_KEPT.includes(m.key)).delete();
    await db.meta.put({ key: 'lockedAt', value: Date.now() });
    // An answered op carries the server's words ("the drill was trashed by Alfred"): cache too.
    const answered = await db.queue.filter((e) => !UNANSWERED.has(e.state)).toArray();
    for (const e of answered) {
      if (e.seq === undefined) continue;
      await db.blobs.where('queueSeq').equals(e.seq).delete();
      await db.queue.delete(e.seq);
    }
  });
}

/** The 401 path for a database this tab never opened (found by the remembered user id). */
export async function lockUserDb(userId: string, options?: DexieOptions): Promise<void> {
  const db = new KeptDb(userId, options);
  try {
    await clearCache(db);
  } finally {
    db.close();
  }
}

/** The whole database: an explicit sign-out, or a discarded orphan. */
export async function deleteUserDb(userId: string, options?: DexieOptions): Promise<void> {
  if (options?.indexedDB) {
    await new KeptDb(userId, options).delete();
    return;
  }
  await Dexie.delete(dbName(userId));
}

/** Another person's queue left on this phone by a 401 (D210): what a discard would lose. */
export type Orphan = {
  userId: string;
  /** Unanswered `create_thing` ops. */
  captures: number;
  /** Their photos and files still on the phone (originals; a display is the same photo). */
  photos: number;
  /** Other unanswered ops: moves, readings, seen, box checks. */
  others: number;
};

type Factory = { databases?: () => Promise<{ name?: string }[]> };

/**
 * Every Kept database on this device that isn't `userId`'s, with what it still holds. Found by
 * listing the databases (`indexedDB.databases()`), plus the remembered user id for a browser
 * that can't list them.
 */
export async function orphans(
  userId: string,
  remembered: string | null,
  options?: DexieOptions,
): Promise<Orphan[]> {
  const factory = (options?.indexedDB ?? (globalThis.indexedDB as unknown)) as Factory;
  const ids = new Set<string>();
  try {
    for (const d of (await factory.databases?.()) ?? [])
      if (d.name?.startsWith('kept-')) ids.add(d.name.slice('kept-'.length));
  } catch {
    // Can't list: the remembered id is all there is.
  }
  if (remembered) ids.add(remembered);
  ids.delete(userId);
  const out: Orphan[] = [];
  for (const id of ids) {
    const db = new KeptDb(id, options);
    try {
      const open = (await db.queue.toArray()).filter((e) => UNANSWERED.has(e.state));
      const seqs = new Set(open.map((e) => e.seq));
      const photos = await db.blobs
        .filter((b) => b.kind === 'original' && seqs.has(b.queueSeq))
        .count();
      const captures = open.filter((e) => e.op === 'create_thing').length;
      out.push({ userId: id, captures, photos, others: open.length - captures });
    } finally {
      db.close();
    }
  }
  return out;
}
