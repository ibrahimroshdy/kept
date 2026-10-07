/**
 * D36 and D210 through the real app frame: sign-out asks before deleting unsynced captures, then
 * wipes; another person's kept queue is counted on a screen, then discarded. The store itself is
 * stood in for (open.ts is mocked): jsdom has no IndexedDB, and wipe.test.ts covers the database.
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@/api/paths';
import { findHeading, pathOf, renderApp } from '@/test/app';
import type { Offline, Orphan } from './open';
import type { OfflineShell } from './shell';
import type { SyncStatus } from './sync-engine';

const open = vi.hoisted(() => ({
  pending: [] as unknown[],
  orphans: [] as Orphan[],
  wipeOffline: vi.fn(async (_userId: string | null) => {}),
  lockOffline: vi.fn(async () => {}),
  discardOrphan: vi.fn(async (_userId: string) => {}),
  loadOffline: vi.fn(),
  setMeta: vi.fn(async (_key: string, _value: unknown) => {}),
  shell: null as OfflineShell | null,
  userId: 'me',
}));

vi.mock('./open', () => {
  const status: SyncStatus = {
    phase: 'idle',
    problem: null,
    lastSyncAt: null,
    asOf: null,
    counts: { waiting: 0, uploading: 0, needsAttention: 0 },
    truncated: false,
    persisted: null,
    printPending: 0,
    notices: [],
  };
  const offline = {
    get userId() {
      return open.userId;
    },
    store: { pending: async () => open.pending, setMeta: open.setMeta },
    engine: { getStatus: () => status, subscribe: () => () => {} },
  } as unknown as Offline;
  open.loadOffline.mockImplementation(async () => offline);
  return {
    offlineSupported: () => true,
    currentOffline: async () => offline,
    loadOffline: open.loadOffline,
    findOrphans: async () => open.orphans,
    discardOrphan: open.discardOrphan,
    wipeOffline: open.wipeOffline,
    lockOffline: open.lockOffline,
    lastOfflineUser: () => null,
    lastKnownShell: async () => open.shell,
  };
});

beforeEach(() => {
  open.pending = [];
  open.orphans = [];
  open.shell = null;
  open.userId = 'me';
  vi.clearAllMocks();
});

describe('sign-out with unsynced captures (D36)', () => {
  it('asks first; staying signed in keeps everything', async () => {
    open.pending = [{}, {}];
    const { user, mock } = await renderApp('/more');
    await findHeading('More');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent("2 captures haven't synced. Signing out deletes them.");
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(open.wipeOffline).not.toHaveBeenCalled();
    expect(mock.lastCall('POST', paths.auth.signOut)).toBeUndefined();
  });

  it('signing out anyway signs out, then wipes this person’s whole database', async () => {
    open.pending = [{}];
    const { user, mock, router } = await renderApp('/more');
    await findHeading('More');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await user.click(await screen.findByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(open.wipeOffline).toHaveBeenCalledOnce());
    expect(open.wipeOffline).toHaveBeenCalledWith(mock.state.me.user.id);
    expect(mock.lastCall('POST', paths.auth.signOut)).toBeDefined();
    await waitFor(() => expect(pathOf(router)).toBe('/signin'));
  });

  it('with nothing unsynced, signs out without asking', async () => {
    const { user } = await renderApp('/more');
    await findHeading('More');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(open.wipeOffline).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('another person’s kept queue on this phone (D210)', () => {
  it('says how many captures and photos go, then discards them and opens mine', async () => {
    open.orphans = [{ userId: 'someone-else', captures: 3, photos: 5, others: 1 }];
    const { user } = await renderApp('/more');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Captures from another account are on this phone');
    expect(dialog).toHaveTextContent('3 captures and 5 photos were taken on this phone');
    expect(dialog).toHaveTextContent('1 other change goes too.');
    expect(open.loadOffline).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete them' }));
    await waitFor(() => expect(open.discardOrphan).toHaveBeenCalledWith('someone-else'));
    await waitFor(() => expect(open.loadOffline).toHaveBeenCalled());
  });

  it('"Sign out instead" leaves them for the person they belong to', async () => {
    open.orphans = [{ userId: 'someone-else', captures: 1, photos: 1, others: 0 }];
    const { user, router } = await renderApp('/more');
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Sign out instead' }));
    await waitFor(() => expect(pathOf(router)).toBe('/signin'));
    expect(open.discardOrphan).not.toHaveBeenCalled();
    expect(open.loadOffline).not.toHaveBeenCalled();
  });

  it('an orphan with nothing unsent goes without a screen', async () => {
    open.orphans = [{ userId: 'cache-only', captures: 0, photos: 0, others: 0 }];
    await renderApp('/more');
    await waitFor(() => expect(open.discardOrphan).toHaveBeenCalledWith('cache-only'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('a 401 (D210)', () => {
  it('locks instead of wiping: the gate clears the cache and keeps the queue', async () => {
    const state = (await import('@/api/mock/fixtures')).ownerScenario();
    state.signedIn = false;
    const { router } = await renderApp('/more', { state });
    await waitFor(() => expect(pathOf(router)).toBe('/signin'));
    expect(open.lockOffline).toHaveBeenCalled();
    expect(open.wipeOffline).not.toHaveBeenCalled();
  });
});

describe('a cold start with no connection (step-3 DoD; D17, D181)', () => {
  /** What the phone saved last time, from the mock server's own answers. */
  async function savedShell(): Promise<OfflineShell> {
    const { ownerScenario } = await import('@/api/mock/fixtures');
    const { createMockApi } = await import('@/api/mock/server');
    const mock = createMockApi(ownerScenario());
    const me = await (await mock.fetch(paths.me)).json();
    const { locations } = await (await mock.fetch(`${paths.locations}?limit=200`)).json();
    return { savedAt: Date.parse('2026-09-29T09:14:00Z'), me: { ...me, email: null }, locations };
  }
  const noNetwork = {
    setup: (m: { fetch: typeof fetch }) => {
      m.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
    },
  };

  it('opens the signed-in app from the phone’s last-known copy', async () => {
    open.shell = await savedShell();
    const { router } = await renderApp('/', noNetwork);
    await findHeading('Home');
    expect(pathOf(router)).toBe('/');
    // The location cards come from the saved copy.
    const first = open.shell.locations[0]?.name as string;
    expect((await screen.findAllByText(first)).length).toBeGreaterThan(0);
    // The whole frame, not an error page: its navigation is there.
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);
  });

  it('with nothing saved (signed out, or locked by a 401) it still says it needs a connection', async () => {
    await renderApp('/', noNetwork);
    expect(await screen.findByText(/^Needs a connection/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('online, it saves the copy the next cold start needs, without the email', async () => {
    const { ownerScenario } = await import('@/api/mock/fixtures');
    open.userId = ownerScenario().me.user.id;
    const { mock } = await renderApp('/more');
    await findHeading('More');
    await waitFor(() => expect(open.setMeta).toHaveBeenCalledWith('shell', expect.anything()));
    const saved = open.setMeta.mock.calls.at(-1)?.[1] as OfflineShell;
    expect(saved.me.user.id).toBe(mock.state.me.user.id);
    expect(saved.me.user.email).toBeNull();
    expect(saved.locations.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain(mock.state.me.user.email ?? '@');
  });
});
