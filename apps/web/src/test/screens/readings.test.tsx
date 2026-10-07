/**
 * Log a reading, everywhere (plan T19): the sheet's online outcomes (fits, a jump confirmed with
 * "It's right", backwards refused and then recorded after "Meter replaced"), offline into the
 * phone's queue with its photo, Home's quick log, the first reading after creating a car, RTL and
 * Arabic digits, and the viewer, who has no Log a reading anywhere.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { MemoryStore } from '@/offline/store';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';
import { firstPage, snapThing } from '@/test/store-contract';

const offline = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/offline/provider', async (original) => ({
  ...(await original<typeof import('@/offline/provider')>()),
  useOffline: () => (offline.store ? { store: offline.store } : null),
}));

afterEach(() => {
  offline.store = null;
  vi.restoreAllMocks();
  // React Query's online manager heard the offline test's event: tell it the network is back.
  window.dispatchEvent(new Event('online'));
});

const I = INV_IDS;

async function openSheet() {
  const r = await renderApp(`/t/${I.thing.car}`);
  await findHeading('Toyota Corolla');
  await r.user.click(screen.getByRole('button', { name: 'Log a reading' }));
  const sheet = within(await screen.findByRole('dialog', { name: 'Log a reading' }));
  return { ...r, sheet };
}

describe('Log a reading, online', () => {
  it('a reading that fits says so, then saves with Undo', async () => {
    const { user, mock, sheet } = await openSheet();
    await user.type(sheet.getByRole('textbox', { name: 'Reading (km)' }), '52500');
    expect(sheet.getByText(/^Fits: 160 km since 52,340 km on/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Save reading' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.meterReadings(I.meter.carOdometer))?.body).toMatchObject({
        value: '52500',
      }),
    );
    expect(await screen.findByText('Reading logged')).toBeInTheDocument();
  });

  it("a jump over the daily limit asks first; It's right sends confirmJump", async () => {
    const { user, mock, sheet } = await openSheet();
    await user.type(sheet.getByRole('textbox', { name: 'Reading (km)' }), '70000');
    expect(sheet.getByText(/over the limit of 1,500 km a day\. Is it right\?/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: "It's right" }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.meterReadings(I.meter.carOdometer))?.body).toMatchObject({
        value: '70000',
        confirmJump: true,
      }),
    );
  });

  it('backwards is refused with the neighbour; Meter replaced records the offset and saves', async () => {
    const { user, mock, sheet } = await openSheet();
    await user.type(sheet.getByRole('textbox', { name: 'Reading (km)' }), '120');
    expect(sheet.getByText(/Readings can't go down/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Save reading' }));
    expect(
      await sheet.findByText(/Lower than the reading before it \(52,340 km\)/),
    ).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Meter replaced' }));
    expect(sheet.getByRole('textbox', { name: 'The old meter had reached (km)' })).toHaveValue(
      '52340',
    );
    await user.click(sheet.getByRole('button', { name: 'Record and save the reading' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.meterReplaced(I.meter.carOdometer))?.body).toMatchObject({
        offset: '52340',
      }),
    );
    expect(await screen.findByText('Reading logged')).toBeInTheDocument();
  });

  it('takes Eastern Arabic digits, and mirrors in Arabic', async () => {
    const r = await renderApp(`/t/${I.thing.car}`, { locale: 'ar' });
    await r.user.click(await screen.findByRole('button', { name: 'سجّل قراءة' }));
    const dialog = await screen.findByRole('dialog');
    await r.user.type(within(dialog).getAllByRole('textbox')[0] as HTMLElement, '٥٢٥٠٠');
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
    await r.user.click(within(dialog).getByRole('button', { name: 'احفظ القراءة' }));
    await waitFor(() =>
      expect(r.mock.lastCall('POST', p.meterReadings(I.meter.carOdometer))?.body).toMatchObject({
        value: '52500',
      }),
    );
  });
});

describe('Log a reading, offline', () => {
  it('queues one log_reading with its photo, no create_thing, and the card shows it waiting', async () => {
    const store = new MemoryStore();
    offline.store = store;
    const { user, sheet } = await openSheet();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await user.type(sheet.getByRole('textbox', { name: 'Reading (km)' }), '52600');
    const photo = new File(['jpeg'], 'odo.jpg', { type: 'image/jpeg' });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]');
    if (!input) throw new Error('no file input');
    await user.upload(input, photo);
    expect(await sheet.findByText('Kept as proof')).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Save reading' }));
    expect(await screen.findByText('Saved on this phone')).toBeInTheDocument();
    const pending = await store.pending();
    expect(pending.map((e) => e.op)).toEqual(['log_reading']);
    const [entry] = pending;
    expect(entry?.idempotencyKey).toBe(`read:${entry?.clientId}`);
    expect(entry?.payload).toMatchObject({ meterId: I.meter.carOdometer, value: '52600' });
    expect((entry?.payload as { proofFileId?: string } | undefined)?.proofFileId).toBeTruthy();
    expect(await screen.findByText('waiting to sync')).toBeInTheDocument();
  });
});

describe('the other doors', () => {
  it("Home's quick log picks the metered thing from the phone's copy, then logs", async () => {
    const store = new MemoryStore();
    const page = firstPage();
    await store.applySnapshot({
      ...page,
      changes: {
        ...page.changes,
        things: [
          ...page.changes.things,
          snapThing(I.thing.car, I.loc.garage, 'Toyota Corolla', {
            meters: [
              {
                id: I.meter.carOdometer,
                kind: 'distance',
                unit: 'km',
                label: null,
                latest: { value: '52340', takenAt: new Date().toISOString() },
              },
            ],
          }),
        ],
      },
    });
    offline.store = store;
    const state = ownerScenario();
    ensureVehiclesSeeded(state);
    const { user, mock } = await renderApp('/', { state });
    await user.click(
      await screen.findByRole('button', { name: 'Log a reading' }, { timeout: 10_000 }),
    );
    const pick = within(await screen.findByRole('dialog', { name: 'What did you read?' }));
    await user.click(await pick.findByRole('button', { name: /Toyota Corolla/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Log a reading' }));
    await user.type(sheet.getByRole('textbox', { name: 'Reading (km)' }), '52400');
    await user.click(sheet.getByRole('button', { name: 'Save reading' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.meterReadings(I.meter.carOdometer))?.body).toMatchObject({
        value: '52400',
      }),
    );
  });

  it('creating a car continues to its first reading, which can be skipped or logged', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.garage}`);
    await findHeading('Garage');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.click(within(palette).getByRole('option', { name: /Add a thing/ }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add a thing' }));
    await user.type(sheet.getByRole('textbox', { name: 'Name' }), 'Hyundai Elantra');
    await user.type(sheet.getByRole('combobox', { name: 'Type' }), 'Car');
    await user.click((await screen.findAllByRole('option', { name: /^Car/ }))[0] as HTMLElement);
    await user.type(sheet.getByRole('combobox', { name: 'Where it is' }), 'Shelves');
    await user.click((await screen.findAllByRole('option', { name: /Shelves/ }))[0] as HTMLElement);
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    const first = within(await screen.findByRole('dialog', { name: 'Add the first reading' }));
    await user.type(first.getByRole('textbox', { name: 'Reading (km)' }), '٣٤٠٠٠');
    await user.click(first.getByRole('button', { name: 'Save reading' }));
    await waitFor(() =>
      expect(
        mock.calls.find((c) => c.method === 'POST' && /\/meters\/[^/]+\/readings$/.test(c.path))
          ?.body,
      ).toMatchObject({ value: '34000' }),
    );
  });

  it('a viewer has no Log a reading on the thing or on Home', async () => {
    const state = ownerScenario();
    ensureVehiclesSeeded(state);
    for (const l of state.locations) l.role = 'viewer';
    await renderApp(`/t/${I.thing.car}`, { state });
    expect(await screen.findByText("You're a viewer here", {}, { timeout: 10_000 })).toBeVisible();
    expect(
      (await screen.findAllByText('Odometer', {}, { timeout: 10_000 })).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Log a reading' })).toBeNull();
  });
});
