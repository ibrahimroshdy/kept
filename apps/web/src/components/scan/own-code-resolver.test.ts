/**
 * The phone's own-code resolver (D208, plan T17a): an own or CSV code in the snapshot opens its
 * thing offline, typed any way the server would store it (lower case, Eastern digits), after the
 * short IDs; a code that is also a short ID's shape but isn't one on this phone still finds it.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@/offline/store';
import { firstPage } from '@/test/store-contract';
import { resolveScan } from './resolve';

const LOC = '01926f00-0000-7000-8000-00000000b002';
const DRILL = '01926f00-0000-7000-8000-0000000d0005';
const BOX = '01926f00-0000-7000-8000-0000000d0008';

async function store() {
  const s = new MemoryStore();
  const page = firstPage();
  await s.applySnapshot({
    ...page,
    changes: {
      ...page.changes,
      legacyCodes: [
        ...page.changes.legacyCodes,
        {
          locationId: LOC,
          source: 'own',
          sourceCollection: '',
          code: 'GAR-0042',
          thingId: DRILL,
          placeId: null,
        },
        {
          locationId: LOC,
          source: 'own',
          sourceCollection: '',
          code: 'BOLT01',
          thingId: BOX,
          placeId: null,
        },
      ],
    },
  });
  return s;
}

describe('own codes on the phone', () => {
  it('opens a thing by its own code offline, typed in lower case with Eastern digits', async () => {
    const s = await store();
    const r = await resolveScan({ text: ' gar-٠٠٤٢ ' }, { store: s, online: false });
    expect(r).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: DRILL, locationId: LOC },
      code: null,
      legacy: 'GAR-0042',
      from: 'phone',
    });
  });

  it('finds a code shaped like a short ID as typed, not folded (O stays O)', async () => {
    const s = await store();
    const r = await resolveScan({ text: 'bolt01' }, { store: s, online: false });
    expect(r).toMatchObject({ outcome: 'open', target: { kind: 'thing', id: BOX } });
  });

  it('a short ID still wins', async () => {
    const s = await store();
    const r = await resolveScan({ text: '7kq-4mz' }, { store: s, online: false });
    expect(r).toMatchObject({ outcome: 'open', target: { id: DRILL }, code: '7KQ4MZ' });
  });
});
