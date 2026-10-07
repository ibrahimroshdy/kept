/**
 * D210 on one phone (one fake IndexedDB shared by two people): a 401 clears the cache and keeps
 * the person's own unsent queue; another person's sign-in finds it, counts it, and discards it.
 */
import { newId, type QueueItem } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { fakeIdb, makeDexieStore } from '@/test/dexie';
import { firstPage } from '@/test/store-contract';
import type { DexieStore } from './dexie-store';
import { deleteUserDb, lockUserDb, orphans } from './wipe';

const LOC = '01926f00-0000-7000-8000-00000000b002';
const SHELF = '01926f00-0000-7000-8000-0000000c0012';
const DRILL = '01926f00-0000-7000-8000-0000000d0005';

type Item = Omit<QueueItem, 'clientVersion' | 'payloadVersion'>;
const capture = (fileId?: string): Item => {
  const id = newId();
  return {
    clientId: id,
    idempotencyKey: `cap:${id}`,
    op: 'create_thing',
    takenAt: '2026-09-27T11:05:00.000Z',
    locationId: LOC,
    payload: {
      id,
      target: { placeId: SHELF },
      mode: 'thing',
      batchId: newId(),
      files: fileId ? [{ fileId, role: 'photo' }] : [],
    },
  };
};
const move = (): Item => {
  const id = newId();
  return {
    clientId: id,
    idempotencyKey: `move:${id}`,
    op: 'move',
    takenAt: '2026-09-27T11:06:00.000Z',
    locationId: LOC,
    payload: { thingIds: [DRILL], to: { placeId: SHELF } },
  };
};

async function filled(store: DexieStore) {
  await store.applySnapshot(firstPage());
  const photo = { id: newId(), kind: 'original' as const, blob: new Blob(['jpeg']), sha256: 'ab' };
  const kept = capture(photo.id);
  await store.enqueue(kept, [photo]);
  await store.enqueue(move(), []);
  const answered = capture();
  await store.enqueue(answered, []);
  await store.settle({
    clientId: answered.clientId,
    idempotencyKey: answered.idempotencyKey,
    outcome: 'dropped',
    reason: 'target_trashed',
    notice: { name: 'Bosch drill', by: { displayName: 'Alfred' }, action: 'trashed' },
  });
  await store.setTray([DRILL]);
  await store.putShared({
    id: 's1',
    at: '2026-09-27T11:07:00.000Z',
    title: null,
    text: null,
    files: [],
  });
  await store.db.thumbs.put({
    fileId: 't',
    bytes: new ArrayBuffer(4),
    type: 'image/jpeg',
    size: 4,
    lastUsedAt: 1,
  });
  return { kept };
}

describe('a 401 and the next sign-in (D210)', () => {
  it('a 401 on a store this tab never opened clears the cache and keeps the unsent queue', async () => {
    const idb = fakeIdb();
    const a = newId();
    const store = makeDexieStore(a, idb);
    const { kept } = await filled(store);
    store.db.close();

    await lockUserDb(a, idb);

    const again = makeDexieStore(a, idb);
    expect(await again.locations()).toEqual([]);
    expect(await again.cursor()).toBeNull();
    expect(await again.byCode('7KQ4MZ')).toBeUndefined();
    expect(await again.tray()).toEqual([]);
    expect(await again.notices()).toEqual([]);
    expect(await again.shared('s1')).toBeUndefined();
    expect(await again.db.thumbs.count()).toBe(0);
    // The answered (dropped) op carried someone else's words: it goes with the cache.
    expect((await again.pending()).map((e) => e.op)).toEqual(['create_thing', 'move']);
    expect((await again.pending())[0]?.idempotencyKey).toBe(kept.idempotencyKey);
    expect(await again.db.blobs.count()).toBe(1);
    // The file itself is never deleted on this path.
    const names = (await idb.indexedDB.databases()).map((d) => d.name);
    expect(names).toContain(`kept-${a}`);
  });

  it('another person signing in finds the kept queue, counts it, and discards it', async () => {
    const idb = fakeIdb();
    const a = newId();
    const b = newId();
    const storeA = makeDexieStore(a, idb);
    await filled(storeA);
    await storeA.wipeCache();
    storeA.db.close();
    const storeB = makeDexieStore(b, idb);
    await storeB.applySnapshot(firstPage());
    storeB.db.close();

    expect(await orphans(b, null, idb)).toEqual([{ userId: a, captures: 1, photos: 1, others: 1 }]);
    // The person the queue belongs to has no orphan: it's theirs, and it resumes.
    expect(await orphans(a, null, idb)).toEqual([{ userId: b, captures: 0, photos: 0, others: 0 }]);

    await deleteUserDb(a, idb);
    const names = (await idb.indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain(`kept-${a}`);
    expect(names).toContain(`kept-${b}`);
    expect(await orphans(b, null, idb)).toEqual([]);
  });

  it('finds an orphan by the remembered id where the browser cannot list databases', async () => {
    const idb = fakeIdb();
    const a = newId();
    const store = makeDexieStore(a, idb);
    await store.enqueue(capture(), []);
    store.db.close();
    const noList = {
      ...idb,
      indexedDB: Object.assign(Object.create(idb.indexedDB), { databases: undefined }),
    };
    expect(await orphans(newId(), a, noList)).toEqual([
      { userId: a, captures: 1, photos: 0, others: 0 },
    ]);
  });
});
