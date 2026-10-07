/**
 * The one capture path (plan T25 "Every capture"): what goes into the queue, and how "Undo this
 * batch" takes it back.
 */
import { newId, parseOpPayload } from '@kept/shared';
import { describe, expect, it, vi } from 'vitest';
import { fileClassFor } from '@/offline/queue';
import { MemoryStore } from '@/offline/store';
import { firstPage } from '@/test/store-contract';
import {
  captureKey,
  enqueueCapture,
  enqueueFiles,
  keepShared,
  modeForFile,
  undoBatch,
} from './enqueue';
import { swipeMode } from './mode-strip';
import { defaultTarget, flattenPlaces, placePath, roomsOf } from './target';

const HOME = '01926f00-0000-7000-8000-00000000b002';
const SHELF = '01926f00-0000-7000-8000-0000000c0012';
const BATCH = '01926f00-0000-7000-8000-000000300001';
const jpeg = () => new Blob(['jpeg'], { type: 'image/jpeg' });

describe('enqueueCapture', () => {
  it('queues one create_thing with its files, and the thing shows at once as "ID pending"', async () => {
    const store = new MemoryStore();
    await store.applySnapshot(firstPage());
    const q = await enqueueCapture(store, {
      target: { locationId: HOME, placeId: SHELF, containerId: null },
      batchId: BATCH,
      mode: 'receipt',
      image: { original: jpeg(), display: jpeg(), previewUnavailable: false },
      note: '  Paid cash ',
    });
    const [entry] = await store.pending();
    expect(entry?.idempotencyKey).toBe(captureKey(q.id));
    expect(entry?.clientId).toBe(q.id);
    const payload = entry?.payload as Record<string, unknown>;
    expect(parseOpPayload('create_thing', payload).success).toBe(true);
    expect(payload).toMatchObject({
      id: q.id,
      target: { placeId: SHELF },
      mode: 'receipt',
      batchId: BATCH,
      note: 'Paid cash',
      files: [
        {
          fileId: q.original?.id,
          role: 'receipt',
          displayFileId: q.display?.id,
          sha256: q.original?.sha256,
        },
      ],
    });
    expect(q.original?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const named = await enqueueCapture(store, {
      target: { locationId: HOME, placeId: SHELF, containerId: null },
      batchId: BATCH,
      mode: 'thing',
      image: null,
      name: 'Ladder',
    });
    expect((await store.contentsOf({ placeId: SHELF })).map((t) => [t.id, t.shortCode])).toEqual([
      [named.id, null],
    ]);
  });

  it('"+ photo" names the draft it adds to and waits for it', async () => {
    const store = new MemoryStore();
    const first = await enqueueCapture(store, {
      target: { locationId: HOME, placeId: SHELF, containerId: null },
      batchId: BATCH,
      mode: 'thing',
      image: { original: jpeg(), display: null, previewUnavailable: false },
    });
    await enqueueCapture(store, {
      target: { locationId: HOME, placeId: SHELF, containerId: null },
      batchId: BATCH,
      mode: 'label',
      image: { original: jpeg(), display: jpeg(), previewUnavailable: false },
      attachToThingId: first.id,
      dependsOn: [first.idempotencyKey],
    });
    const [, second] = await store.pending();
    expect(second?.dependsOn).toEqual([first.idempotencyKey]);
    expect(second?.payload).toMatchObject({ attachToThingId: first.id, mode: 'label' });
    expect(await store.contentsOf({ placeId: SHELF })).toHaveLength(1);
  });

  it('keeps a share as one capture per file; a PDF is always a receipt (D140)', async () => {
    const store = new MemoryStore();
    const decode = vi.fn().mockRejectedValue(new Error('no canvas in jsdom'));
    const queued = await keepShared(
      store,
      {
        id: 's1',
        at: '2026-09-27T10:00:00Z',
        title: null,
        text: null,
        files: [
          { name: 'a.jpg', type: 'image/jpeg', blob: jpeg() },
          {
            name: 'b.pdf',
            type: 'application/pdf',
            blob: new Blob(['%PDF'], { type: 'application/pdf' }),
          },
        ],
      },
      'thing',
      { target: { locationId: HOME, placeId: null, containerId: null }, decode },
    );
    expect(queued.map((q) => q.mode)).toEqual(['thing', 'receipt']);
    const pending = await store.pending();
    expect(pending.map((e) => (e.payload as { target: unknown }).target)).toEqual([
      { unplaced: true },
      { unplaced: true },
    ]);
  });
});

describe('enqueueFiles (Gallery, D140)', () => {
  it('queues each file in the mode it was picked in: a receipt stays a receipt, kept as evidence', async () => {
    const store = new MemoryStore();
    const decode = vi.fn().mockRejectedValue(new Error('no canvas in jsdom'));
    const original = jpeg();
    const target = { locationId: HOME, placeId: null, containerId: null };
    const queued = await enqueueFiles(store, [{ blob: original, type: 'image/jpeg' }], {
      target,
      batchId: newId(),
      mode: 'receipt',
      decode,
    });
    expect(queued.map((q) => q.mode)).toEqual(['receipt']);
    // The untouched original goes up (D34), never a shrunk copy.
    expect(queued[0]?.original?.blob).toBe(original);
    const [entry] = await store.pending();
    expect(entry?.payload).toMatchObject({ mode: 'receipt', files: [{ role: 'receipt' }] });
    expect(entry && fileClassFor(entry)).toBe('evidence');
    expect(entry && parseOpPayload('create_thing', entry.payload).success).toBe(true);
  });

  it('a PDF is a receipt in any mode; a photo keeps the chosen mode', () => {
    expect(modeForFile('application/pdf', 'thing')).toBe('receipt');
    expect(modeForFile('image/jpeg', 'receipt')).toBe('receipt');
    expect(modeForFile('image/jpeg', 'thing')).toBe('thing');
    expect(modeForFile('image/heic', 'label')).toBe('label');
  });
});

describe('undoBatch', () => {
  it('takes back what never left the phone, and asks the server for the rest', async () => {
    const store = new MemoryStore();
    const a = await enqueueCapture(store, {
      target: { locationId: HOME, placeId: SHELF, containerId: null },
      batchId: BATCH,
      mode: 'thing',
      image: null,
      name: 'A',
    });
    const server = vi.fn().mockResolvedValue({ trashed: [] });
    expect(await undoBatch(store, BATCH, [a.idempotencyKey], server)).toEqual({
      unqueued: 1,
      sentToServer: 0,
    });
    expect(server).not.toHaveBeenCalled();
    expect(await undoBatch(store, BATCH, ['cap:sent-already'], server)).toEqual({
      unqueued: 0,
      sentToServer: 1,
    });
    expect(server).toHaveBeenCalledWith(BATCH);
  });
});

describe('the place chip and the mode strip', () => {
  it('walks paths and flattens trees, Unplaced first', () => {
    const page = firstPage();
    const places = [
      ...page.changes.places.filter((p) => p.locationId === HOME),
      {
        id: 'u',
        locationId: HOME,
        parentId: null,
        name: '',
        kindKey: 'room',
        icon: null,
        isUnplaced: true,
        sort: 0,
        deleted: false,
      },
      {
        id: 'bin',
        locationId: HOME,
        parentId: SHELF,
        name: 'Bin',
        kindKey: 'zone',
        icon: null,
        isUnplaced: false,
        sort: 0,
        deleted: false,
      },
    ];
    expect(placePath(places, 'bin').map((p) => p.name)).toEqual(['Shelf A', 'Bin']);
    expect(flattenPlaces(places).map((r) => [r.place.id, r.depth])[0]).toEqual(['u', 0]);
    expect(roomsOf(places).map((p) => p.name)).toEqual(['Garage', 'Shelf A']);
  });

  it('defaults to Personal, then remembers the last place per location', () => {
    const page = firstPage();
    const input = {
      locations: page.locations,
      placesOf: (id: string) => page.changes.places.filter((p) => p.locationId === id),
      personalLocationId: HOME,
    };
    expect(defaultTarget(input)).toMatchObject({ locationId: HOME, why: 'default' });
    localStorage.setItem(
      'kept.capture.last',
      JSON.stringify({ locationId: HOME, places: { [HOME]: SHELF } }),
    );
    expect(defaultTarget(input)).toMatchObject({ placeId: SHELF, why: 'last' });
    localStorage.clear();
  });

  it('swipes forward towards the reading start, mirrored in Arabic', () => {
    expect(swipeMode('thing', -80, false)).toBe('receipt');
    expect(swipeMode('thing', 80, true)).toBe('receipt');
    expect(swipeMode('thing', 80, false)).toBe('thing');
    expect(swipeMode('reading', -80, false)).toBe('reading');
  });
});
