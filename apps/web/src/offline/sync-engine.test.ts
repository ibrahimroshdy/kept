/**
 * The sync engine against the T3 mock server (the same fetchers the real T12/T14 routes answer),
 * on a Dexie store over fake-indexeddb. The plan's sync tests: an offline capture that syncs,
 * dependency order, a replay after a network error that doesn't duplicate, a conflict notice,
 * payload-version refusal and upgrade, a full phone, and a 401 that wipes.
 */
import { newId, type QueueItem, type UpgraderTable } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePaths } from '@/api/capture/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, type MockApi, MockReply } from '@/api/mock/server';
import { makeDexieStore } from '@/test/dexie';
import type { DexieStore } from './dexie-store';
import { SyncEngine } from './sync-engine';
import { localBlob, type UploadHttp, uploadEntryFiles } from './uploader';

const LOC = INV_IDS.loc.home;
const OFFICE = INV_IDS.place.office;

let mock: MockApi;
let store: DexieStore;

beforeEach(() => {
  mock = createMockApi(ownerScenario());
  vi.stubGlobal('fetch', mock.fetch);
  store = makeDexieStore();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const engineFor = (
  s: DexieStore = store,
  extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {},
) => new SyncEngine({ store: s, lock: (fn) => fn(), clientVersion: '0.1.0', ...extra });

type Item = Omit<QueueItem, 'clientVersion' | 'payloadVersion'>;

function capture(
  over: { name?: string; files?: unknown[]; mode?: string; dependsOn?: string[] } = {},
): Item {
  const id = newId();
  return {
    clientId: id,
    idempotencyKey: `cap:${id}`,
    op: 'create_thing',
    takenAt: new Date().toISOString(),
    locationId: LOC,
    ...(over.dependsOn ? { dependsOn: over.dependsOn } : {}),
    payload: {
      id,
      target: { placeId: OFFICE },
      mode: over.mode ?? 'thing',
      batchId: newId(),
      files: over.files ?? [],
      ...(over.name ? { name: over.name } : {}),
    },
  };
}

const opsCalls = () =>
  mock.calls.filter((c) => c.method === 'POST' && c.path === capturePaths.syncOps);
const sentKeys = () =>
  opsCalls().flatMap((c) =>
    (c.body as { ops: { idempotencyKey: string }[] }).ops.map((o) => o.idempotencyKey),
  );

describe('the sync engine', () => {
  it('an offline capture waits, then uploads its photo, applies, and swaps "ID pending" for the code', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const engine = engineFor();
    const photo = await localBlob(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), 'original');
    const item = capture({ files: [{ fileId: photo.id, role: 'photo' }] });
    const id = (item.payload as { id: string }).id;
    await engine.enqueue(item, [photo]);
    await engine.run();

    expect(engine.getStatus().problem).toBe('offline');
    expect(engine.getStatus().counts.waiting).toBe(1);
    expect(mock.calls).toEqual([]);
    expect((await store.thing(id))?.shortCode).toBeNull(); // "ID pending" (D112)

    online.mockReturnValue(true);
    await engine.run();

    const order = mock.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`PUT /api/v1/files/${photo.id}`)).toBeLessThan(
      order.indexOf(`POST ${capturePaths.syncOps}`),
    );
    const put = mock.calls.find((c) => c.path === `/api/v1/files/${photo.id}`);
    expect(put?.headers['x-kept-sha256']).toBe(photo.sha256);
    expect((await store.thing(id))?.shortCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(await store.pending()).toEqual([]);
    expect(await store.db.blobs.count()).toBe(0);
    expect(engine.getStatus()).toMatchObject({
      problem: null,
      counts: { waiting: 0, uploading: 0, needsAttention: 0 },
      printPending: 1,
    });
    expect(engine.getStatus().asOf).not.toBeNull();
  });

  it('pulls by watermark: the next run sends the cursor and types hash the last page left', async () => {
    const engine = engineFor();
    await engine.run();
    await engine.run();
    const pulls = mock.calls.filter((c) => c.path === capturePaths.syncSnapshot);
    expect(pulls).toHaveLength(2);
    expect(await store.cursor()).toBe('pass-2');
    expect((await store.locations()).length).toBeGreaterThan(0);
  });

  it('follows pages until complete, and a page’s tombstones and revoked locations apply', async () => {
    const engine = engineFor();
    await engine.run();
    const drill = INV_IDS.thing.drill;
    expect(await store.thing(drill)).toBeDefined();
    let n = 0;
    mock.on('GET', capturePaths.syncSnapshot, ({ query }) => {
      n += 1;
      return {
        asOf: new Date().toISOString(),
        payloadVersion: 1,
        minPayloadVersion: 1,
        locations: [],
        types: { hash: 'same' },
        changes: { places: [], things: [], codes: [], legacyCodes: [] },
        // The drill is in the Garage: a tombstone names the location it left (SnapRemoved).
        removed:
          n === 2 ? [{ locationId: INV_IDS.loc.garage, entityType: 'thing', entityId: drill }] : [],
        revokedLocationIds: [],
        nextCursor: `delta-${n}-after-${query.get('cursor')}`,
        complete: n === 2,
      };
    });
    await engine.run();
    expect(n).toBe(2);
    expect(await store.thing(drill)).toBeUndefined();
    expect(await store.cursor()).toBe('delta-2-after-delta-1-after-pass-1');
  });

  it('a cursor the server refuses (its auth secret changed) drops the copy, keeps the queue, and pulls a full pass at once', async () => {
    const engine = engineFor();
    await engine.run();
    expect(await store.cursor()).toBe('pass-1');
    await store.setTray([INV_IDS.thing.drill]);
    // A thing only this phone still holds: the full pass must not bring it back.
    const drill = await store.db.things.get(INV_IDS.thing.drill);
    if (!drill) throw new Error('fixture');
    await store.db.things.put({
      ...drill,
      id: newId(),
      name: 'Gone meanwhile',
      terms: ['gone', 'meanwhile'],
    });
    await store.db.thumbs.put({
      fileId: newId(),
      bytes: new ArrayBuffer(4),
      type: 'image/jpeg',
      size: 4,
      lastUsedAt: 1,
    });
    const photo = await localBlob(new Blob(['jpeg'], { type: 'image/jpeg' }), 'original');
    const item = capture({ name: 'Queued', files: [{ fileId: photo.id, role: 'photo' }] });
    await store.enqueue(item, [photo]);
    // Held back (an older build's payload the server refused, D148), so it stays through the run.
    const [queued] = await store.pending();
    await store.markUploaded(photo.id);
    await store.setState([queued?.seq ?? -1], 'blocked');

    const real = mock.fetch;
    const cursors: (string | null)[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://kept.test');
      if (url.pathname === capturePaths.syncSnapshot) {
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        if (cursor !== null)
          return Response.json(
            {
              error: 'The sync cursor is not valid; sync again from the start.',
              code: 'validation',
            },
            { status: 400 },
          );
      }
      return real(input, init);
    });
    await engine.run();

    // One refused cursor, then a full pass without one, in the same run.
    expect(cursors).toEqual(['pass-1', null]);
    expect(engine.getStatus().problem).toBe('client_outdated'); // the queue's, not the pull's
    expect(await store.cursor()).toBe('pass-2');
    expect(await store.search('meanwhile', 5)).toEqual([]);
    expect(await store.thing(INV_IDS.thing.drill)).toBeDefined();
    expect(await store.db.thumbs.count()).toBe(0);
    // The queue, its photo and the tray stay.
    expect((await store.pending()).map((e) => e.idempotencyKey)).toEqual([item.idempotencyKey]);
    expect(await store.db.blobs.count()).toBe(1);
    expect(await store.tray()).toEqual([INV_IDS.thing.drill]);
  });

  it('a 400 on the full pass after a reset is a server problem, not another reset', async () => {
    const engine = engineFor();
    await engine.run();
    const cursors: (string | null)[] = [];
    mock.on('GET', capturePaths.syncSnapshot, ({ query }) => {
      cursors.push(query.get('cursor'));
      return new MockReply(400, { error: 'Not valid.', code: 'validation' });
    });
    await engine.run();
    expect(cursors).toEqual(['pass-1', null]);
    expect(engine.getStatus().problem).toBe('server');
    expect(await store.cursor()).toBeNull();
  });

  it('sends in queue order, parents before children, and a parent’s file holds back what follows', async () => {
    const engine = engineFor();
    const areaId = newId();
    const area: Item = {
      clientId: areaId,
      idempotencyKey: `area:${areaId}`,
      op: 'create_area',
      takenAt: new Date().toISOString(),
      locationId: LOC,
      payload: { id: areaId, parentId: null, name: 'Loft', kindKey: 'room' },
    };
    const photo = await localBlob(new Blob(['p']), 'original');
    const first = capture({ files: [{ fileId: photo.id, role: 'photo' }] });
    await engine.enqueue(first, [photo]);
    await engine.enqueue(area, []);
    const child = capture({ dependsOn: [area.idempotencyKey] });
    await engine.enqueue(child, []);

    // The photo's upload fails on the network: nothing after it may overtake it.
    mock.on('PUT', inventoryPaths.file(':id'), () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    await engine.run();
    expect(opsCalls()).toEqual([]);

    mock.on('PUT', inventoryPaths.file(':id'), ({ params, headers }) => ({
      id: params.id,
      sha256: headers['x-kept-sha256'],
    }));
    await engine.run();
    expect(sentKeys()).toEqual([first.idempotencyKey, area.idempotencyKey, child.idempotencyKey]);
    expect(await store.pending()).toEqual([]);
    expect(await store.notices()).toEqual([]);
  });

  it('a parent dropped on the phone drops its child without sending it (parent_dropped)', async () => {
    const engine = engineFor();
    const photo = await localBlob(new Blob(['p']), 'original');
    const parent = capture({ files: [{ fileId: photo.id, role: 'photo' }] });
    await engine.enqueue(parent, [photo]);
    await engine.enqueue(capture({ dependsOn: [parent.idempotencyKey] }), []);
    mock.on(
      'PUT',
      inventoryPaths.file(':id'),
      () => new MockReply(400, { error: 'Not a file Kept takes.', code: 'validation' }),
    );
    await engine.run();
    const [p, c] = await store.entries();
    expect(p?.result).toMatchObject({ outcome: 'dropped', reason: 'invalid' });
    expect(c?.result).toMatchObject({ outcome: 'dropped', reason: 'parent_dropped' });
    expect(opsCalls()).toEqual([]);
    expect((await store.notices()).map((n) => n.kind)).toEqual(['dropped', 'dropped']);
  });

  it('a replay after a network error sends the same idempotency keys and creates nothing twice', async () => {
    const engine = engineFor();
    const item = capture({ name: 'Ladder' });
    const id = (item.payload as { id: string }).id;
    await engine.enqueue(item, []);
    // The server applies the batch, then the connection drops before the answer arrives.
    const real = mock.fetch;
    let dropped = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!dropped && String(input).startsWith(capturePaths.syncOps)) {
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      return res;
    });
    await engine.run();
    expect(engine.getStatus().problem).toBe('offline');
    // It may have been applied: it stays `sent`, can't be taken back, and goes again unchanged.
    expect((await store.pending())[0]?.state).toBe('sent');
    expect(await store.unqueue([item.idempotencyKey])).toEqual([]);

    await engine.run();
    expect(sentKeys()).toEqual([item.idempotencyKey, item.idempotencyKey]);
    expect(mock.state.inventory.things.filter((t) => t.id === id)).toHaveLength(1);
    expect(await store.pending()).toEqual([]);
    expect((await store.thing(id))?.name).toBe('Ladder');
  });

  it('a move into a place trashed meanwhile is dropped with a visible notice (D35)', async () => {
    const engine = engineFor();
    const office = mock.state.inventory.places.find((p) => p.id === OFFICE);
    if (!office) throw new Error('fixture');
    office.deletedAt = new Date().toISOString();
    const moveId = newId();
    await engine.enqueue(
      {
        clientId: moveId,
        idempotencyKey: `move:${moveId}`,
        op: 'move',
        takenAt: new Date().toISOString(),
        locationId: LOC,
        payload: { thingIds: [INV_IDS.thing.drill], to: { placeId: OFFICE } },
      },
      [],
    );
    await engine.run();
    const [notice] = await store.notices();
    expect(notice).toMatchObject({
      kind: 'dropped',
      idempotencyKey: `move:${moveId}`,
      result: { reason: 'target_trashed', notice: { action: 'trashed' } },
    });
    expect(notice?.result?.inboxItemId).toBeTruthy();
    expect(engine.getStatus().counts.needsAttention).toBe(1);
    // The status line spells it out: "…the office was trashed by …".
    expect(engine.getStatus().notices).toEqual([notice]);
    expect(notice?.result?.notice?.name).toBeTruthy();

    await engine.dismissNotice(notice?.id ?? -1);
    expect(await store.notices()).toEqual([]);
    expect(engine.getStatus().counts.needsAttention).toBe(0);
    expect(engine.getStatus().notices).toEqual([]);
  });

  it('client_outdated blocks the batch and keeps the queue; an upgrade on the next start sends it (D148)', async () => {
    const engine = engineFor();
    const old = capture({ name: 'Old capture' });
    const later = capture({ name: 'Later capture' });
    await engine.enqueue(old, []);
    await engine.enqueue(later, []);
    const [first] = await store.pending();
    await store.setPayload(first?.seq ?? -1, first?.payload, 0); // written by an older build

    await engine.run();
    await engine.run();
    expect(engine.getStatus().problem).toBe('client_outdated');
    // The whole batch was refused, nothing applied, nothing dropped, nothing re-sent.
    expect((await store.pending()).map((e) => e.state)).toEqual(['blocked', 'blocked']);
    expect((await store.notices()).map((n) => n.kind)).toEqual(['outdated']); // once, not per run
    expect(sentKeys()).toEqual([old.idempotencyKey, later.idempotencyKey]);
    expect(mock.state.inventory.things.some((t) => t.name === 'Old capture')).toBe(false);

    // The new build knows how to bring v0 up to v1: on start it upgrades, unblocks and sends.
    engine.stop();
    const upgraders: UpgraderTable = { create_thing: { 0: (p) => p } };
    const next = engineFor(store, { upgraders });
    await next.start();
    next.stop();
    expect(await store.pending()).toEqual([]);
    expect(mock.state.inventory.things.some((t) => t.name === 'Old capture')).toBe(true);
    expect(await store.notices()).toEqual([]);
    expect(next.getStatus().problem).toBeNull();
  });

  it('server_outdated (the server was rolled back) blocks too, and the queue stays', async () => {
    const engine = engineFor();
    await engine.enqueue(capture({ name: 'From the future' }), []);
    const [e] = await store.pending();
    await store.setPayload(e?.seq ?? -1, e?.payload, 2);
    await engine.run();
    expect(engine.getStatus().problem).toBe('server_outdated');
    expect((await store.pending()).map((x) => x.state)).toEqual(['blocked']);
  });

  it('the server answering part of a batch leaves the rest queued for the next run', async () => {
    const engine = engineFor();
    const a = capture({ name: 'A' });
    const b = capture({ name: 'B' });
    await engine.enqueue(a, []);
    await engine.enqueue(b, []);
    mock.on('POST', capturePaths.syncOps, () => ({
      results: [{ clientId: a.clientId, idempotencyKey: a.idempotencyKey, outcome: 'applied' }],
    }));
    await engine.run();
    expect(engine.getStatus().problem).toBe('server');
    expect((await store.pending()).map((e) => [e.idempotencyKey, e.state])).toEqual([
      [b.idempotencyKey, 'pending'],
    ]);
  });

  it('uploads an evidence original, then its display to /files/<original>/display', async () => {
    const engine = engineFor();
    const original = await localBlob(new Blob(['full'], { type: 'image/jpeg' }), 'original');
    const display = await localBlob(new Blob(['2048'], { type: 'image/jpeg' }), 'display');
    await engine.enqueue(
      capture({
        mode: 'receipt',
        files: [{ fileId: original.id, role: 'receipt', displayFileId: display.id }],
      }),
      [display, original],
    );
    await engine.run();
    const puts = mock.calls.filter((c) => c.method === 'PUT').map((c) => c.path);
    expect(puts).toEqual([`/api/v1/files/${original.id}`, `/api/v1/files/${original.id}/display`]);
    const up = mock.calls.find((c) => c.path === `/api/v1/files/${original.id}`);
    expect(up?.headers['content-type']).toBe('image/jpeg');
    expect(mock.state.inventory.files[original.id]).toMatchObject({ class: 'evidence' });
  });

  it('uploading a blocked entry’s files keeps it blocked (D148: only a start or a retry unblocks)', async () => {
    const engine = engineFor();
    const photo = await localBlob(new Blob(['jpeg'], { type: 'image/jpeg' }), 'original');
    await engine.enqueue(capture({ files: [{ fileId: photo.id, role: 'photo' }] }), [photo]);
    const [queued] = await store.pending();
    await store.setState([queued?.seq ?? -1], 'blocked');
    const [entry] = await store.pending();
    if (!entry) throw new Error('nothing queued');
    const http: UploadHttp = { putFile: vi.fn(async () => {}), putDisplay: vi.fn(async () => {}) };
    expect(await uploadEntryFiles(store, entry, http)).toBe('uploaded');
    expect(http.putFile).toHaveBeenCalledTimes(1);
    expect((await store.pending()).map((e) => e.state)).toEqual(['blocked']);
    expect((await store.blobsOf(entry.seq)).every((b) => b.uploaded)).toBe(true);
  });

  it('a full phone stops the run with storage_full, keeping the old snapshot', async () => {
    const engine = engineFor();
    await engine.run();
    const before = await store.cursor();
    vi.spyOn(store.db.things, 'bulkPut').mockRejectedValue(
      new DOMException('Quota exceeded', 'QuotaExceededError'),
    );
    await engine.run();
    expect(engine.getStatus().problem).toBe('storage_full');
    expect(await store.cursor()).toBe(before);
  });

  it('a 401 drops the cache but keeps the unsent queue, locked; the same person resumes and it syncs (D210)', async () => {
    const onSignedOut = vi.fn();
    const engine = engineFor(store, { onSignedOut });
    await engine.run();
    await store.setTray([INV_IDS.thing.drill]);
    const photo = await localBlob(new Blob(['jpeg'], { type: 'image/jpeg' }), 'original');
    const item = capture({ name: 'Taken offline', files: [{ fileId: photo.id, role: 'photo' }] });
    await engine.enqueue(item, [photo]);
    mock.state.signedIn = false;
    await engine.run();

    expect(onSignedOut).toHaveBeenCalledOnce();
    // The cache (other people's things, names, places) is gone at once…
    expect(await store.cursor()).toBeNull();
    expect(await store.locations()).toEqual([]);
    expect(await store.search('drill', 5)).toEqual([]);
    expect(await store.tray()).toEqual([]);
    expect(await store.db.thumbs.count()).toBe(0);
    expect(await store.meta('lockedAt')).toBeTypeOf('number');
    // …but the person's own capture and its photo stay.
    expect((await store.pending()).map((e) => e.idempotencyKey)).toEqual([item.idempotencyKey]);
    expect(await store.db.blobs.count()).toBe(1);

    // The same person signs back in: the queue goes, then a full snapshot comes back.
    mock.state.signedIn = true;
    await store.unlock();
    const next = engineFor(store);
    await next.run();
    expect(await store.pending()).toEqual([]);
    expect(await store.db.blobs.count()).toBe(0);
    expect(mock.state.inventory.things.some((t) => t.name === 'Taken offline')).toBe(true);
    expect(mock.state.inventory.files[photo.id]).toBeDefined();
    expect((await store.locations()).length).toBeGreaterThan(0);
    expect(await store.meta('lockedAt')).toBeUndefined();
  });

  it('asks for persistent storage after the first capture and records the answer', async () => {
    const persist = vi.fn(async () => false);
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      storage: { persisted: async () => false, persist },
    });
    const engine = engineFor();
    await engine.enqueue(capture({ name: 'First' }), []);
    await engine.enqueue(capture({ name: 'Second' }), []);
    expect(persist).toHaveBeenCalledOnce();
    expect(await store.meta('persisted')).toBe(false);
    await engine.refresh();
    expect(engine.getStatus().persisted).toBe(false);
  });
});
