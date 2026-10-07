/**
 * The vehicle history report sheet (plan T23): the request body it posts (the period, what to
 * include, the language), step 2's progress to Download on the mock, a viewer's costs left out,
 * and offline disabled with the reason.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryPaths } from '@/api/inventory/paths';
import type { ReportRun } from '@/api/inventory/types';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { COROLLA } from '@/api/vehicles/mock/state';
import { vehiclePaths } from '@/api/vehicles/paths';
import { toastQueue } from '@/components/ui/toast';
import { expectLogicalOnly } from '@/test/render';
import { renderThingPart } from '@/test/thing-part';
import { HistoryReportButton } from './history-report-sheet';

vi.setConfig({ testTimeout: 20_000 });

const PDF = 'https://files.kept.test/r/history.pdf?sig=abc';

function seeded(patch?: (s: MockState) => void): MockState {
  const s = ownerScenario();
  ensureVehiclesSeeded(s);
  patch?.(s);
  return s;
}

/** The run as the server reads it back: running once, then done with its links. */
function finishing(mock: { on: (m: string, t: string, h: () => unknown) => void }) {
  let reads = 0;
  mock.on('GET', inventoryPaths.report(':id'), (): ReportRun => {
    reads += 1;
    const base: ReportRun = {
      id: 'run',
      status: 'running',
      scope: { locationId: IDS.garage },
      progress: { done: 3, total: 9 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    return reads === 1
      ? base
      : { ...base, status: 'done', progress: { done: 9, total: 9 }, fileUrl: PDF, viewUrl: PDF };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('the history report sheet', () => {
  it('posts the vehicle, the period and what to include, then follows the run to Download', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { user, mock } = await renderThingPart(<HistoryReportButton />, {
      thingId: COROLLA.thing,
      state: seeded(),
      digits: 'western',
      setup: finishing,
    });
    await user.click(await screen.findByRole('button', { name: 'History report' }));
    const dialog = await screen.findByRole('dialog', { name: 'History report' });
    await user.click(within(dialog).getByRole('radio', { name: 'From and to' }));
    const segments = within(dialog).getAllByRole('spinbutton');
    await user.click(segments[0] as HTMLElement);
    await user.keyboard('01012026');
    await user.click(within(dialog).getByRole('switch', { name: 'Proof photos' }));
    await user.click(within(dialog).getByRole('radio', { name: 'العربية' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', vehiclePaths.reportsVehicleHistory)?.body).toMatchObject({
        thingId: COROLLA.thing,
        from: '2026-01-01',
        include: { costs: true, proofPhotos: false, fuel: true, documents: true },
        locale: 'ar',
      }),
    );
    expect(
      await within(dialog).findByText('Your PDF is ready', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('href', PDF);
  });

  it('lets a viewer make one, says costs need money, and sends none', async () => {
    const { user, mock } = await renderThingPart(<HistoryReportButton />, {
      thingId: COROLLA.thing,
      state: seeded((s) => {
        const g = s.locations.find((l) => l.id === IDS.garage);
        if (g) g.role = 'viewer';
      }),
      digits: 'western',
      setup: finishing,
    });
    await user.click(await screen.findByRole('button', { name: 'History report' }));
    const dialog = await screen.findByRole('dialog', { name: 'History report' });
    expect(within(dialog).getByRole('switch', { name: 'Costs' })).toBeDisabled();
    expect(within(dialog).getByText(/Costs appear only if you can see money/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', vehiclePaths.reportsVehicleHistory)?.body).toMatchObject({
        include: { costs: false },
      }),
    );
  });

  it('offline, the button is off and says why', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await renderThingPart(<HistoryReportButton />, { thingId: COROLLA.thing, state: seeded() });
    expect(await screen.findByRole('button', { name: 'History report' })).toBeDisabled();
    expect(screen.getByText('Needs a connection')).toBeInTheDocument();
  });

  it('lays out right to left in Arabic', async () => {
    const { user } = await renderThingPart(<HistoryReportButton />, {
      thingId: COROLLA.thing,
      state: seeded(),
      locale: 'ar',
    });
    await user.click(await screen.findByRole('button'));
    await screen.findByRole('dialog');
    expectLogicalOnly();
  });
});
