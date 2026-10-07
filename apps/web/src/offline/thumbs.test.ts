import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDexieStore } from '@/test/dexie';
import { ThumbCache } from './thumbs';

// jsdom has no object URLs: count them instead, and put back whatever was there.
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  let n = 0;
  URL.createObjectURL = () => `blob:${++n}`;
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

describe('the thumbnail cache', () => {
  it('fetches once, then serves from the phone', async () => {
    const store = makeDexieStore();
    const fetchBlob = vi.fn(async () => new Blob(['thumb'], { type: 'image/webp' }));
    const cache = new ThumbCache(store.db, fetchBlob);
    expect(await cache.url('f1')).toMatch(/^blob:/);
    expect(await new ThumbCache(store.db, fetchBlob).url('f1')).toMatch(/^blob:/);
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(await store.db.thumbs.count()).toBe(1);
  });

  it('evicts the least recently used past its limit, and revokes their URLs', async () => {
    const store = makeDexieStore();
    let t = 0;
    const cache = new ThumbCache(
      store.db,
      async () => new Blob(['12345']),
      10,
      () => ++t,
    );
    await cache.url('old');
    await cache.url('mid');
    await cache.url('new');
    expect((await store.db.thumbs.toArray()).map((r) => r.fileId).sort()).toEqual(['mid', 'new']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });
});
