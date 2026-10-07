/**
 * Search offline (step-3 DoD: "findable offline"; D17, D42, D112, D188): the Things group answers
 * from the phone's copy, "on this phone · as of last sync", with captures still waiting to sync
 * ("ID pending"), Arabic folding and aliases, and where each thing is. Documents keep "need a
 * connection". The store is the real `MemoryStore` (open.ts is stood in for: jsdom has no
 * IndexedDB); the server is never asked.
 */
import { newId } from '@kept/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@/offline/store';
import type { SyncStatus } from '@/offline/sync-engine';
import { findHeading, renderApp } from '@/test/app';
import { firstPage } from '@/test/store-contract';
import { passesOffline, serverOnlyFilters } from './offline-results';

const HOME = '01926f00-0000-7000-8000-00000000b002';
const SHELF = '01926f00-0000-7000-8000-0000000c0012';

const open = vi.hoisted(() => ({ store: null as unknown }));

vi.mock('@/offline/open', () => {
  const status: SyncStatus = {
    phase: 'idle',
    problem: 'offline',
    lastSyncAt: null,
    asOf: null,
    counts: { waiting: 0, uploading: 0, needsAttention: 0 },
    truncated: false,
    persisted: null,
    printPending: 0,
    notices: [],
  };
  return {
    offlineSupported: () => true,
    currentOffline: async () => null,
    loadOffline: async (userId: string) => ({
      userId,
      store: open.store,
      engine: { getStatus: () => status, subscribe: () => () => {}, stop: () => {} },
      thumbs: { revokeAll: () => {} },
    }),
    findOrphans: async () => [],
    discardOrphan: async () => {},
    wipeOffline: async () => {},
    lockOffline: async () => {},
    lastOfflineUser: () => null,
    lastKnownShell: async () => null,
  };
});

async function phone() {
  const store = Object.assign(new MemoryStore(), { setMeta: async () => {} });
  await store.applySnapshot(firstPage());
  // A capture taken offline, not synced yet: no short ID (D112).
  const id = newId();
  await store.enqueue(
    {
      clientId: id,
      idempotencyKey: `cap:${id}`,
      op: 'create_thing',
      takenAt: '2026-09-29T08:00:00.000Z',
      locationId: HOME,
      payload: {
        id,
        target: { placeId: SHELF },
        mode: 'thing',
        batchId: newId(),
        files: [],
        name: 'Orbital sander',
      },
    },
    [],
  );
  return store;
}

beforeEach(async () => {
  open.store = await phone();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The app at `path`, offline: the server's search can't be reached. */
async function offlineSearch(path: string) {
  const r = await renderApp(path, {
    setup: (m) => {
      const real = m.fetch;
      m.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
        if (url.includes('/search')) throw new TypeError('Failed to fetch');
        return real(input, init);
      };
    },
  });
  await findHeading('Search');
  return r;
}

describe('search offline', () => {
  it('finds a thing on the phone by name, with where it is and how old the copy is', async () => {
    await offlineSearch('/search?q=bosch');
    const list = await screen.findByRole('list', { name: 'Things found' }, { timeout: 3000 });
    const drill = within(list).getByRole('link', { name: /Bosch drill/ });
    expect(drill).toHaveAttribute('href', '/t/7KQ4MZ');
    expect(drill.textContent).toContain('Home › Garage');
    expect(within(drill).getByRole('img', { name: '7KQ4MZ' })).toBeInTheDocument();
    expect(within(drill).getByText('Bosch').tagName).toBe('MARK');
    expect(screen.getByText(/^On this phone · as of last sync, /)).toBeInTheDocument();
    // Documents aren't on the phone.
    expect(screen.getByText('Documents need a connection')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).toBeNull();
  });

  it('finds a capture still waiting to sync, "ID pending" (D112)', async () => {
    await offlineSearch('/search?q=sander');
    const list = await screen.findByRole('list', { name: 'Things found' }, { timeout: 3000 });
    const sander = within(list).getByRole('link', { name: /Orbital sander/ });
    expect(within(sander).getByText('ID pending')).toBeInTheDocument();
    expect(sander.textContent).toContain('Home › Shelf A');
  });

  it('folds Arabic and finds by alias and short ID, like the server (D42)', async () => {
    await offlineSearch('/search?q=كابل');
    const list = await screen.findByRole('list', { name: 'Things found' }, { timeout: 3000 });
    expect(within(list).getByRole('link', { name: /الكابل/ })).toBeInTheDocument();
  });

  it('with nothing on the phone, says so without a did-you-mean', async () => {
    await offlineSearch('/search?q=zzzz');
    expect(await screen.findByText(/^Nothing on this phone matches/)).toHaveTextContent(
      'Nothing on this phone matches ‘zzzz’',
    );
    expect(screen.queryByText('Did you mean')).toBeNull();
  });
});

describe('the filters the phone can apply', () => {
  const drill = { locationId: 'a', typeId: 't1' } as Parameters<
    ReturnType<typeof passesOffline>
  >[0];
  it('location and type, "is" and "is not"', () => {
    expect(passesOffline({ locationId: 'a' })(drill)).toBe(true);
    expect(passesOffline({ locationId: ['b'] })(drill)).toBe(false);
    expect(passesOffline({ locationId: 'a', not: ['locationId'] })(drill)).toBe(false);
    expect(passesOffline({ typeId: 't2', not: ['typeId'] })(drill)).toBe(true);
    expect(passesOffline({ typeId: 't2' })(drill)).toBe(false);
  });
  it('place, tag, state and price are the server’s', () => {
    expect(serverOnlyFilters({ q: 'x', locationId: 'a' })).toBe(false);
    expect(serverOnlyFilters({ placeId: 'p' })).toBe(true);
    expect(serverOnlyFilters({ state: ['draft'] })).toBe(true);
    expect(serverOnlyFilters({ priceMin: '5' })).toBe(true);
  });
});
