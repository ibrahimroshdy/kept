/**
 * Offline thing and place pages (step-3 carry-over, step-4 plan T28; D36, D188, Q34): with the
 * server out of reach, `/t/<code>` and `/p/<id>` answer from the phone's copy, "as of last sync",
 * with the derived states and the loan line, and say the details need a connection. The store is
 * the real `MemoryStore` (open.ts is stood in for: jsdom has no IndexedDB).
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@/offline/store';
import type { SyncStatus } from '@/offline/sync-engine';
import { renderApp } from '@/test/app';
import { firstPage, snapThing } from '@/test/store-contract';

const HOME = '01926f00-0000-7000-8000-00000000b002';
const GARAGE = '01926f00-0000-7000-8000-0000000c0011';
const DRILL = '01926f00-0000-7000-8000-0000000d0005';
const BOX = '01926f00-0000-7000-8000-0000000d0008';
const LAMP = '01926f00-0000-7000-8000-0000000d0099';

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
    currentOffline: async () => (open.store ? { store: open.store } : null),
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

beforeEach(async () => {
  const store = Object.assign(new MemoryStore(), { setMeta: async () => {} });
  const page = firstPage();
  // The drill is lent to Murdock (step-4 Q34), and a lamp sits in Box 3.
  page.changes.things = page.changes.things.map((t) =>
    t.id === DRILL
      ? {
          ...t,
          derived: ['lent'],
          loan: { direction: 'out', personName: 'Murdock', dueOn: '2026-10-17' },
        }
      : t,
  );
  page.changes.things.push(snapThing(LAMP, HOME, 'Desk lamp', { containerId: BOX, placeId: null }));
  await store.applySnapshot(page);
  open.store = store;
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The app at `path`, with every thing and place read failing as if the server were down. */
const offline = (path: string) =>
  renderApp(path, {
    setup: (m) => {
      const real = m.fetch;
      m.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
        if (/\/api\/v1\/(things|places)\//.test(url)) throw new TypeError('Failed to fetch');
        return real(input, init);
      };
    },
  });

describe('a thing page offline', () => {
  it("shows the phone's copy by short ID, with the loan line", async () => {
    await offline('/t/7KQ4MZ');
    expect(
      await screen.findByRole('heading', { name: 'Bosch drill' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^On this phone · as of last sync, /)).toBeInTheDocument();
    expect(screen.getByText('Details need a connection.')).toBeInTheDocument();
    // The person's name is isolated in the line (UI step-4 review L9).
    const loanLine = screen.getByText(
      (_, el) => el?.tagName === 'P' && /^With Murdock · due /.test(el.textContent ?? ''),
    );
    expect(loanLine.querySelector('bdi')).toHaveTextContent('Murdock');
    expect(screen.getByText('Lent out')).toBeInTheDocument();
    // Where it is: the location, then the place.
    expect(
      screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'Home › Garage'),
    ).toBeInTheDocument();
  });

  it("lists a container's contents from the phone", async () => {
    await offline(`/t/${BOX}`);
    await screen.findByRole('heading', { name: 'Box 3' }, { timeout: 3000 });
    const inside = screen.getByRole('list', { name: 'Inside Box 3' });
    expect(within(inside).getByRole('link', { name: /Desk lamp/ })).toBeInTheDocument();
  });

  it("says so when the thing isn't on this phone", async () => {
    await offline('/t/01926f00-0000-7000-8000-0000000d0777');
    expect(await screen.findByText('Not on this phone', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('a place page offline', () => {
  it('lists what the phone knows is there', async () => {
    await offline(`/p/${GARAGE}`);
    expect(
      await screen.findByRole('heading', { name: 'Garage' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    const things = screen.getByRole('list', { name: 'Things in Garage' });
    expect(within(things).getByRole('link', { name: /Bosch drill/ })).toBeInTheDocument();
    expect(within(things).getByRole('link', { name: /Box 3/ })).toBeInTheDocument();
    // The lamp is inside Box 3, not on the Garage's floor.
    expect(within(things).queryByRole('link', { name: /Desk lamp/ })).toBeNull();
  });
});
