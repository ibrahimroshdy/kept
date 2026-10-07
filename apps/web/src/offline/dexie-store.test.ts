/**
 * The Dexie store on fake-indexeddb: the T3 contract suite, plus what only a real database
 * shows (atomic pages, bytes round-tripping, quota handling, the 10,000-thing sanity check).
 */
import { newId, type SnapThing } from '@kept/shared';
import Dexie from 'dexie';
import { describe, expect, it, vi } from 'vitest';
import { fakeIdb, makeDexieStore } from '@/test/dexie';
import { firstPage, storeContract } from '@/test/store-contract';
import { dbName, V1_STORES } from './db';
import { StorageFullError } from './persist';

storeContract('DexieStore (fake-indexeddb)', () => makeDexieStore());

const LOC = '01926f00-0000-7000-8000-00000000b002';
const FAMILY = '01926f00-0000-7000-8000-00000000b005';
const GARAGE = '01926f00-0000-7000-8000-0000000c0011';
const DRILL = '01926f00-0000-7000-8000-0000000d0005';
const CABLE = '01926f00-0000-7000-8000-0000000d0030';

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('DexieStore', () => {
  it('v2 starts the copy over, since its things had no meters, and keeps the queue', async () => {
    const idb = fakeIdb();
    const userId = newId();
    // A phone that synced under v1: a thing with no `meters`, a cursor, and a capture waiting.
    const v1 = new Dexie(dbName(userId), idb);
    v1.version(1).stores(V1_STORES);
    await v1.table('things').put({ id: DRILL, locationId: LOC, name: 'Bosch drill', terms: [] });
    await v1.table('meta').bulkPut([
      { key: 'cursor', value: 'old-cursor' },
      { key: 'lastSyncAt', value: 1 },
    ]);
    await v1.table('queue').add({
      clientVersion: '0.1.0',
      payloadVersion: 1,
      clientId: 'c1',
      idempotencyKey: 'move:c1',
      op: 'move',
      takenAt: '2026-09-27T11:06:00.000Z',
      locationId: LOC,
      payload: { thingIds: [DRILL], to: { placeId: GARAGE } },
      state: 'pending',
    });
    v1.close();

    const s = makeDexieStore(userId, idb);
    expect(await s.cursor()).toBeNull();
    expect(await s.thing(DRILL)).toBeUndefined();
    expect(await s.db.queue.count()).toBe(1);
    expect(await s.meta('lastSyncAt')).toBe(1);
    await s.applySnapshot(firstPage());
    expect((await s.thing(DRILL))?.name).toBe('Bosch drill');
  });

  it('v3 rebuilds the terms in place with each thing’s legacy codes, keeping the copy', async () => {
    const idb = fakeIdb();
    const userId = newId();
    // A phone that synced under v2: the drill's terms have no codes, its Homebox code is kept.
    const v2 = new Dexie(dbName(userId), idb);
    v2.version(2).stores(V1_STORES);
    await v2.table('things').put({
      ...firstPage().changes.things[0],
      terms: ['bosch', 'drill', '7kq4mz'],
    });
    await v2.table('legacyCodes').put({
      locationId: LOC,
      source: 'homebox',
      sourceCollection: 'main',
      code: '000-001',
      thingId: DRILL,
      placeId: null,
      key: `${LOC}:homebox:main:000-001`,
    });
    await v2.table('meta').put({ key: 'cursor', value: 'v2-cursor' });
    v2.close();

    const s = makeDexieStore(userId, idb);
    expect(await s.cursor()).toBe('v2-cursor');
    expect((await s.search('000-001', 10)).map((t) => t.id)).toEqual([DRILL]);
    expect((await s.search('bosch', 10)).map((t) => t.id)).toEqual([DRILL]);
  });

  it('finds الكابل offline by its bare form كابل and by its Arabic alias', async () => {
    const s = makeDexieStore();
    await s.applySnapshot(firstPage());
    expect((await s.search('كابل', 10)).map((t) => t.id)).toEqual([CABLE]);
    expect((await s.search('وصلة', 10)).map((t) => t.id)).toEqual([CABLE]);
    expect((await s.search('bosch dri', 10)).map((t) => t.id)).toEqual([DRILL]);
  });

  it('a removed tombstone deletes the row; revokedLocationIds removes that location’s rows', async () => {
    const s = makeDexieStore();
    await s.applySnapshot(firstPage());
    await s.applySnapshot(
      firstPage({
        changes: { places: [], things: [], codes: [], legacyCodes: [] },
        removed: [
          { locationId: LOC, entityType: 'thing', entityId: DRILL },
          { locationId: LOC, entityType: 'code', entityId: '7KQ4MZ' },
          { locationId: LOC, entityType: 'legacy_code', entityId: `${LOC}:homebox:main:000-001` },
        ],
        revokedLocationIds: [FAMILY],
        nextCursor: 'cursor-2',
      }),
    );
    expect(await s.thing(DRILL)).toBeUndefined();
    expect(await s.byCode('7KQ4MZ')).toBeUndefined();
    expect(await s.byLegacy('homebox', '000-001')).toEqual([]);
    expect(await s.thing(CABLE)).toBeUndefined();
    expect(await s.placesOf(FAMILY)).toEqual([]);
    expect(await s.db.things.where('locationId').equals(FAMILY).count()).toBe(0);
    expect(await s.search('كابل', 10)).toEqual([]);
  });

  it('a page is all or nothing: a failed page leaves the rows and the cursor as they were', async () => {
    const s = makeDexieStore();
    await s.applySnapshot(firstPage());
    const spy = vi.spyOn(s.db.codes, 'bulkPut').mockRejectedValueOnce(new Error('disk'));
    const drill = (await s.thing(DRILL)) as SnapThing;
    await expect(
      s.applySnapshot(
        firstPage({
          changes: {
            places: [],
            things: [{ ...drill, name: 'Renamed drill' }],
            codes: [],
            legacyCodes: [],
          },
          nextCursor: 'cursor-2',
        }),
      ),
    ).rejects.toThrow('disk');
    spy.mockRestore();
    expect((await s.thing(DRILL))?.name).toBe('Bosch drill');
    expect(await s.cursor()).toBe('cursor-1');
  });

  it('keeps queued files as bytes and gives them back as Blobs with their type', async () => {
    const s = makeDexieStore();
    const id = newId();
    await s.enqueue(
      {
        clientId: id,
        idempotencyKey: `cap:${id}`,
        op: 'create_thing',
        takenAt: '2026-09-27T11:05:00.000Z',
        locationId: LOC,
        payload: { id, target: { placeId: GARAGE }, mode: 'thing', batchId: newId(), files: [] },
      },
      [
        {
          id: 'f1',
          kind: 'original',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
          sha256: 'ab',
        },
      ],
    );
    const [entry] = await s.pending();
    const [blob] = await s.blobsOf(entry?.seq ?? -1);
    expect(blob?.blob.type).toBe('image/jpeg');
    expect(await blob?.blob.text()).toBe('jpeg');
    expect(blob?.uploaded).toBe(false);
  });

  it('when the phone is full, frees the thumbnail cache and retries the capture once', async () => {
    const s = makeDexieStore();
    await s.db.thumbs.put({
      fileId: 't1',
      bytes: new ArrayBuffer(8),
      type: 'image/jpeg',
      size: 8,
      lastUsedAt: 1,
    });
    const add = vi.spyOn(s.db.queue, 'add').mockRejectedValueOnce(quota());
    const id = newId();
    await s.enqueue(
      {
        clientId: id,
        idempotencyKey: `cap:${id}`,
        op: 'mark_seen',
        takenAt: '2026-09-27T11:05:00.000Z',
        locationId: LOC,
        payload: { thingId: DRILL },
      },
      [],
    );
    add.mockRestore();
    expect(await s.db.thumbs.count()).toBe(0);
    expect(await s.pending()).toHaveLength(1);
  });

  it('when even that does not fit, says so with StorageFullError and queues nothing', async () => {
    const s = makeDexieStore();
    const add = vi.spyOn(s.db.queue, 'add').mockRejectedValue(quota());
    const id = newId();
    await expect(
      s.enqueue(
        {
          clientId: id,
          idempotencyKey: `cap:${id}`,
          op: 'mark_seen',
          takenAt: '2026-09-27T11:05:00.000Z',
          locationId: LOC,
          payload: { thingId: DRILL },
        },
        [],
      ),
    ).rejects.toBeInstanceOf(StorageFullError);
    add.mockRestore();
    expect(await s.pending()).toEqual([]);
  });

  // Retried: most of this is fake-indexeddb's own cost (~0.9 s of structured clones and index
  // upkeep alone), which a loaded machine can push past the bound once. A slow store fails 3 times.
  it('applies a 10,000-thing snapshot page in under 1.5 s, 3 s on a CI runner (a jsdom sanity check, not the phone)', {
    retry: 2,
  }, async () => {
    const s = makeDexieStore();
    const base = firstPage();
    const things: SnapThing[] = Array.from({ length: 10_000 }, (_, i) => ({
      id: `01926f00-0000-7000-8000-${String(i).padStart(12, '0')}`,
      locationId: LOC,
      shortCode: null,
      name: `Thing number ${i}`,
      typeId: '',
      placeId: GARAGE,
      containerId: null,
      quantity: '1',
      aliases: { en: [`alias ${i}`] },
      lifecycle: 'in_use',
      reviewState: 'confirmed',
      locationUncertain: false,
      lastSeenAt: null,
      coverFileId: null,
      isContainer: false,
      deleted: false,
    }));
    // Warm the JIT on a small page first: the phone's first sync isn't its first line of code.
    await makeDexieStore().applySnapshot({
      ...base,
      changes: { ...base.changes, things: things.slice(0, 500) },
    });
    // CPU time, not wall time: the full suite shares the machine with other runs (load 30+ has
    // been seen), and a starved worker waiting for a core is not a slow store.
    const cpu = process.cpuUsage();
    await s.applySnapshot({ ...base, changes: { ...base.changes, things } });
    const used = process.cpuUsage(cpu);
    const ms = (used.user + used.system) / 1000;
    expect(await s.db.things.count()).toBe(10_000);
    // A hosted CI runner's cores are slower than a laptop's: 1.7–2.0 s of CPU on GitHub's 2-vCPU
    // runner (the first public ci run, 2026-10-07), so the bound there is twice the laptop's.
    expect(ms).toBeLessThan(process.env.CI ? 3_000 : 1_500);
  });
});
