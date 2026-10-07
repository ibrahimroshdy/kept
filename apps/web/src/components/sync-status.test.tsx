import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Offline } from '@/offline/open';
import { OfflineContext } from '@/offline/provider';
import type { SyncNotice } from '@/offline/store';
import type { SyncStatus as Status } from '@/offline/sync-engine';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { SyncStatus } from './sync-status';

const base: Status = {
  phase: 'idle',
  problem: null,
  lastSyncAt: null,
  asOf: '2026-09-27T11:02:00.000Z',
  counts: { waiting: 0, uploading: 0, needsAttention: 0 },
  truncated: false,
  persisted: null,
  printPending: 0,
  notices: [],
};

/** A stand-in engine whose status the test sets. */
function withStatus(status: Status, dismissNotice = vi.fn(async (_id: number) => {})) {
  const engine = { getStatus: () => status, subscribe: () => () => {}, dismissNotice };
  return { engine } as unknown as Offline;
}

const drop = (id: number, action: 'trashed' | 'moved' | 'removed', name: string): SyncNotice => ({
  id,
  at: '2026-09-29T10:00:00.000Z',
  kind: 'dropped',
  idempotencyKey: `move:${id}`,
  result: {
    clientId: `c${id}`,
    idempotencyKey: `move:${id}`,
    outcome: 'dropped',
    reason: 'target_trashed',
    notice: { name, by: { displayName: 'Alfred' }, action },
    inboxItemId: `inbox-${id}`,
  },
});

/** The line inside a router, for its Restore link to the inbox. */
async function showRouted(status: Status, dismissNotice = vi.fn(async (_id: number) => {})) {
  const root = createRootRoute({
    component: () => (
      <OfflineContext.Provider value={withStatus(status, dismissNotice)}>
        <SyncStatus />
        <Outlet />
      </OfflineContext.Provider>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  const inbox = createRoute({
    getParentRoute: () => root,
    path: '/inbox',
    component: () => <h1>Inbox</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, inbox]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const out = await renderUI(<RouterProvider router={router} />);
  return { ...out, router, dismissNotice };
}

const show = (status: Status) =>
  renderUI(
    <OfflineContext.Provider value={withStatus(status)}>
      <SyncStatus />
    </OfflineContext.Provider>,
  );

describe('the sync status line', () => {
  it('says nothing when there is nothing to say', async () => {
    await show(base);
    expect(screen.queryByTestId('sync-status')).toBeNull();
  });

  it('offline with changes waiting, which may not be captures (a label claim is one too)', async () => {
    await show({ ...base, problem: 'offline', counts: { ...base.counts, waiting: 12 } });
    expect(screen.getByText('Offline · 12 waiting to sync')).toBeInTheDocument();
    expect(screen.queryByText(/captures? waiting/)).toBeNull();
  });

  it('offline with nothing waiting says how old the copy is (D188)', async () => {
    await show({ ...base, problem: 'offline' });
    expect(screen.getByText(/^Offline · as of last sync, /)).toBeInTheDocument();
  });

  it('a refused queue asks for an update, and a full phone says so (D148)', async () => {
    await show({ ...base, problem: 'client_outdated', counts: { ...base.counts, waiting: 3 } });
    expect(screen.getByText('Update Kept to finish syncing.')).toBeInTheDocument();
  });

  it('a partial copy and a refused persistence request are explained (Q30, V11)', async () => {
    await show({
      ...base,
      truncated: true,
      persisted: false,
      counts: { ...base.counts, waiting: 1 },
    });
    expect(screen.getByText('Only part of your Kept is on this phone.')).toBeInTheDocument();
    expect(screen.getByText(/may clear Kept's offline copy/)).toBeInTheDocument();
  });

  it('spells out a dropped change, with Restore to the inbox and × to dismiss it (D35)', async () => {
    const { user, router, dismissNotice } = await showRouted({
      ...base,
      counts: { ...base.counts, needsAttention: 1 },
      notices: [drop(4, 'trashed', 'Office')],
    });
    expect(await screen.findByTestId('sync-status')).toHaveTextContent(
      "A change couldn't apply: Office was trashed by Alfred. Restore",
    );
    // Named, so not counted again.
    expect(screen.queryByText(/needs? a look/)).toBeNull();
    expectLogicalOnly();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissNotice).toHaveBeenCalledWith(4);
    await user.click(screen.getByRole('link', { name: 'Restore' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
    expect(router.state.location.search).toMatchObject({ 'f.kind': 'sync_drop' });
  });

  it('names at most three; the others, and reviews, are counted', async () => {
    await showRouted({
      ...base,
      counts: { ...base.counts, needsAttention: 6 },
      notices: [
        drop(1, 'trashed', 'Office'),
        drop(2, 'moved', 'Drill'),
        drop(3, 'removed', 'Shelf'),
        drop(5, 'trashed', 'Garage'),
      ],
    });
    const line = await screen.findByTestId('sync-status');
    expect(line).toHaveTextContent('Drill was moved by Alfred.');
    expect(line).toHaveTextContent('Shelf was removed by Alfred.');
    expect(line).not.toHaveTextContent('Garage');
    expect(screen.getByText('3 changes need a look')).toBeInTheDocument();
  });
});
