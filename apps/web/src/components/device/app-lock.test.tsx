/**
 * The app lock through the real app frame (step-8 plan T23; D181, D210): a cold start with the
 * lock on shows only the lock screen until the PIN; five minutes idle locks again; ten wrong PINs
 * remove the device's copy, keep the unsent queue and sign out; This device sets the lock up.
 * IndexedDB is fake-indexeddb (installed globally before Dexie loads); the offline store's door
 * (offline/open.ts) is stood in for, as in offline-screens.test.tsx.
 */
import 'fake-indexeddb/auto';
import { newId } from '@kept/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS } from '@/api/mock/fixtures';
import { paths } from '@/api/paths';
import { deviceDb, readLock, saveLock } from '@/offline/app-lock-db';
import { createLock } from '@/offline/lock';
import { pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const open = vi.hoisted(() => ({ lockOffline: vi.fn(async () => {}) }));
vi.mock('@/offline/open', () => ({
  offlineSupported: () => false,
  currentOffline: async () => null,
  loadOffline: vi.fn(),
  findOrphans: async () => [],
  discardOrphan: vi.fn(),
  wipeOffline: vi.fn(async () => {}),
  lockOffline: open.lockOffline,
  lastOfflineUser: () => null,
  lastKnownShell: async () => null,
}));

const PIN = '482913';
const db = deviceDb(IDS.ibrahim);

async function setLock(failedTries = 0) {
  const { record } = await createLock(PIN, 1000);
  await saveLock(db, { ...record, failedTries });
}

async function typePin(user: { click: (el: Element) => Promise<void> }, pin: string) {
  for (const d of pin) await user.click(await screen.findByRole('button', { name: d }));
}

beforeEach(async () => {
  await Promise.all([db.lock.clear(), db.queue.clear(), db.extras.clear(), db.keptOffline.clear()]);
  open.lockOffline.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the lock screen', () => {
  it('covers the app on a cold start until the PIN', async () => {
    await setLock();
    const { user } = await renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    await typePin(user, PIN);
    expect(
      await screen.findByRole('heading', { name: 'Settings' }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Enter your PIN' })).toBeNull();
  });

  it('locks again after five minutes idle, and hides the app under it', async () => {
    await setLock();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = await renderApp('/settings');
    await screen.findByRole('heading', { name: 'Enter your PIN' });
    await typePin(user, PIN);
    await screen.findByRole('heading', { name: 'Settings' }, { timeout: 5000 });
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1);
    });
    expect(await screen.findByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });

  it('counts a wrong PIN and says how many tries are left', async () => {
    await setLock();
    const { user } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Enter your PIN' });
    await typePin(user, '000000');
    expect(await screen.findByText(/9 tries left/)).toBeVisible();
    expect((await readLock(db))?.failedTries).toBe(1);
  });

  it('after ten wrong PINs removes the copy, keeps the unsent queue, and signs out', async () => {
    await setLock(9);
    const id = newId();
    await db.queue.add({
      clientId: id,
      idempotencyKey: `seen:${id}`,
      op: 'seen',
      takenAt: '2026-10-06T10:00:00.000Z',
      locationId: IDS.home,
      payload: { thingId: newId() },
      state: 'pending',
    } as never);
    await db.keptOffline.put({
      locationId: IDS.home,
      state: 'ready',
      things: 1,
      documents: 0,
      bytes: 0,
      tooLarge: 0,
      updatedAt: Date.now(),
    });
    const { user, router, mock } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Enter your PIN' });
    await typePin(user, '000000');
    await waitFor(() => expect(pathOf(router)).toBe('/signin'), { timeout: 5000 });
    expect(open.lockOffline).toHaveBeenCalled();
    expect(await readLock(db)).toBeNull();
    expect(await db.keptOffline.count()).toBe(0);
    expect(await db.queue.count()).toBe(1);
    expect(mock.calls.some((c) => c.path === paths.auth.signOut)).toBe(true);
  });
});

describe('This device', () => {
  it('turns the lock on with a PIN typed twice', async () => {
    const { user } = await renderApp('/settings/device');
    await user.click(await screen.findByRole('switch', { name: 'Lock Kept on this device' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Choose a PIN of 6 to 12 digits.');
    await typePin(user, PIN);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await typePin(user, PIN);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(async () => expect(await readLock(db)).not.toBeNull(), { timeout: 10_000 });
    expect(await screen.findByText(/locks after 5 minutes away/)).toBeVisible();
    // Keep offline is offered per location now.
    expect(
      await screen.findByRole('switch', { name: 'Keep Home available offline' }),
    ).toBeEnabled();
  }, 20_000);

  it('offers keep offline only with the lock on', async () => {
    await renderApp('/settings/device');
    expect(await screen.findByText(/Turn on the app lock first/)).toBeVisible();
    expect(
      await screen.findByRole('switch', { name: 'Keep Home available offline' }),
    ).toBeDisabled();
  });

  it('is reached from Settings → Me', async () => {
    const { user, router } = await renderApp('/settings');
    const row = (await screen.findByText('This device')).closest('li') as HTMLElement;
    await user.click(row.querySelector('a') as HTMLElement);
    await waitFor(() => expect(pathOf(router)).toBe('/settings/device'));
  });

  it('shows the size from the estimate and the warning before keeping a location', async () => {
    await setLock();
    const { user } = await renderApp('/settings/device');
    await screen.findByRole('heading', { name: 'Enter your PIN' });
    await typePin(user, PIN);
    const toggle = await screen.findByRole(
      'switch',
      { name: 'Keep Home available offline' },
      { timeout: 5000 },
    );
    await waitFor(() => expect(screen.getAllByText(/to download/).length).toBeGreaterThan(0));
    await user.click(toggle);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Whoever unlocks Kept on this phone sees prices and documents',
    );
    expect(dialog).toHaveTextContent(/About .+ to download/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await db.keptOffline.count()).toBe(0);
  });
});

describe('in Arabic', () => {
  it('draws the lock screen with logical CSS only', async () => {
    await setLock();
    await renderApp('/', { locale: 'ar' });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly(heading.closest('[role="dialog"]') as HTMLElement);
  });
});
