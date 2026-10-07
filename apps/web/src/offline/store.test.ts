import { describe, expect, it } from 'vitest';
import { firstPage, storeContract } from '@/test/store-contract';
import { MemoryStore, termsOf } from './store';

storeContract('MemoryStore', () => new MemoryStore('0.1.0'));

describe('MemoryStore helpers (the mock stand-in for the sync engine)', () => {
  const id = '01926f00-0000-7000-8000-00000020001a';
  const op = {
    clientId: id,
    idempotencyKey: `cap:${id}`,
    op: 'create_thing' as const,
    takenAt: '2026-09-27T11:05:00.000Z',
    locationId: '01926f00-0000-7000-8000-00000000b002',
    payload: {
      id,
      target: { placeId: '01926f00-0000-7000-8000-0000000c0012' },
      mode: 'thing',
      batchId: '01926f00-0000-7000-8000-000000100001',
      files: [],
    },
  };

  it('an applied capture swaps "ID pending" for the allocated code and frees its blobs', async () => {
    const s = new MemoryStore();
    await s.applySnapshot(firstPage());
    await s.enqueue(op, [{ id: 'f1', kind: 'original', blob: new Blob(['x']), sha256: 'ab' }]);
    expect((await s.thing(id))?.shortCode).toBeNull();
    s.settle({
      clientId: id,
      idempotencyKey: op.idempotencyKey,
      outcome: 'applied',
      entity: { type: 'thing', id, shortCode: 'K7Q3FM' },
    });
    expect((await s.thing(id))?.shortCode).toBe('K7Q3FM');
    expect(s.pendingBlobs()).toEqual([]);
    expect(await s.pending()).toEqual([]);
    expect(await s.notices()).toEqual([]);
  });

  it('a dropped op needs attention and leaves a notice (D35)', async () => {
    const s = new MemoryStore();
    await s.enqueue(op, []);
    s.settle({
      clientId: id,
      idempotencyKey: op.idempotencyKey,
      outcome: 'dropped',
      reason: 'target_trashed',
      notice: { name: 'Shelf A', by: { displayName: 'Bruce' }, action: 'trashed' },
    });
    expect(await s.counts()).toEqual({ waiting: 0, uploading: 0, needsAttention: 1 });
    expect((await s.notices())[0]).toMatchObject({
      kind: 'dropped',
      idempotencyKey: op.idempotencyKey,
    });
  });

  it('terms are normalised, with Arabic prefixes stripped (D42)', () => {
    expect(
      termsOf({ name: 'الكابل', aliases: { en: ['Display Cable'] }, shortCode: '7KQ4MZ' }),
    ).toEqual(expect.arrayContaining(['الكابل', 'كابل', 'display', 'cable', '7kq4mz']));
  });
});
