/**
 * A vehicle's card read in LABEL mode, in the inbox (plan T22; T10, Q15): the `document`
 * suggestion reads "Licence · expires …", confirmed with `y` (or Confirm) and accepted, which makes
 * the vehicle's expiring document; rejected with `n`, nothing is made.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_IDS } from '@/api/capture/mock/state';
import { capturePaths } from '@/api/capture/paths';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { renderApp } from '@/test/app';

vi.setConfig({ testTimeout: 20_000 });

const offline = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/offline/provider', async (original) => ({
  ...(await original<typeof import('@/offline/provider')>()),
  useOffline: () => (offline.store ? { store: offline.store } : null),
}));

afterEach(() => vi.restoreAllMocks());

const I = CAPTURE_IDS.inbox;

/** The driver's draft, with the card's suggestion in place of its serial. */
function withCard(): MockState {
  const state = ownerScenario();
  ensureVehiclesSeeded(state);
  const item = state.capture.inbox.find((i) => i.id === I.driver);
  if (!item?.suggestions?.[0]) throw new Error('no driver item');
  item.suggestions = [
    {
      ...item.suggestions[0],
      field: 'document',
      value: { kind: 'licence', expiresOn: '2026-11-06' },
    },
  ];
  return state;
}
const card = async (name: string) =>
  within(await screen.findByRole('list', { name: 'Inbox' }, { timeout: 3000 })).findByRole(
    'article',
    { name },
    { timeout: 3000 },
  );

describe("a vehicle's card in the inbox", () => {
  it('reads "Licence · expires …", and y then Accept makes the document', async () => {
    const state = withCard();
    const before = state.household.documents.length;
    const { user, mock } = await renderApp('/inbox?f.kind=draft', { state, digits: 'western' });
    const driver = await card('Bosch impact driver, 18 V');
    const doc = within(driver).getByRole('group', { name: 'Suggested vehicle document' });
    expect(doc.textContent).toMatch(/Licence · expires .*Nov 6, 2026/);
    expect(doc.textContent).not.toMatch(/Set this on the thing's page/);
    await user.keyboard('j');
    await waitFor(() => expect(driver).toHaveAttribute('aria-current', 'true'));
    await user.keyboard('y');
    await user.click(within(driver).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.body).toEqual({
        accept: ['document'],
        reject: [],
      }),
    );
    expect(state.household.documents).toHaveLength(before + 1);
    expect(state.household.documents.at(-1)).toMatchObject({
      kind: 'licence',
      expiresOn: '2026-11-06',
    });
  });

  it('rejected with n, makes nothing', async () => {
    const state = withCard();
    const before = state.household.documents.length;
    const { user, mock } = await renderApp('/inbox?f.kind=draft', { state });
    const driver = await card('Bosch impact driver, 18 V');
    await user.keyboard('j');
    await waitFor(() => expect(driver).toHaveAttribute('aria-current', 'true'));
    await user.keyboard('n');
    await user.click(within(driver).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.body).toEqual({
        accept: [],
        reject: ['document'],
      }),
    );
    expect(state.household.documents).toHaveLength(before);
  });

  it('reads its date in Arabic digits', async () => {
    await renderApp('/inbox?f.kind=draft', { state: withCard(), locale: 'ar' });
    const list = await screen.findByRole('list', { name: /.+/ }, { timeout: 3000 });
    const group = await within(list).findByRole('group', { name: /vehicle document|مستند/ });
    expect(group.textContent).toMatch(/[٠-٩]/);
  });
});
