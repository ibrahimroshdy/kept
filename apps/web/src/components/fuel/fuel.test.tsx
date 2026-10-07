/**
 * Fuel and charging (plan T21): the summary with the board's Corolla numbers, imperial units as
 * mpg, `whyNone` in words for each reason, Log fuel full and partial (the request body, the
 * Idempotency-Key, a backwards odometer refused with the neighbour), the list's filter in the URL,
 * the viewer (litres and consumption, no money, no Log fuel), Fuel off, offline, and Arabic.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { acceptedReadings, COROLLA } from '@/api/vehicles/mock/state';
import { vehiclePaths } from '@/api/vehicles/paths';
import type { CreateFuelBody, FuelSummary } from '@/api/vehicles/types';
import { toastQueue } from '@/components/ui/toast';
import { expectLogicalOnly } from '@/test/render';
import { renderThingPart } from '@/test/thing-part';
import { VehicleFuel } from './fuel-tab';

vi.setConfig({ testTimeout: 20_000 });

function seeded(patch?: (s: MockState) => void): MockState {
  const s = ownerScenario();
  ensureVehiclesSeeded(s);
  patch?.(s);
  return s;
}
const garage = (s: MockState) => {
  const g = s.locations.find((l) => l.id === IDS.garage);
  if (!g) throw new Error('fixture');
  return g;
};
const render = (
  state = seeded(),
  opts: Omit<Parameters<typeof renderThingPart>[1], 'thingId' | 'state'> = {},
) =>
  renderThingPart(<VehicleFuel />, { thingId: COROLLA.thing, state, digits: 'western', ...opts });

afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('the Fuel tab', () => {
  it("shows the board's figures: 7.3 L/100 km over the last 5 full fills, cost per km and a month", async () => {
    await render();
    const card = await screen.findByRole('region', { name: 'Fuel' });
    expect(await within(card).findByText('7.3 L/100 km')).toBeInTheDocument();
    expect(within(card).getByText('the last 5 full fills')).toBeInTheDocument();
    expect(within(card).getByText('fuel only')).toBeInTheDocument();
    expect(within(card).getByText(/EGP.*\/km/)).toBeInTheDocument();
    expect(within(card).getByText(/^≈ EGP/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Log fuel' })).toBeEnabled();
  });

  it('reads consumption in mpg for a reader on imperial units, the fills as stored', async () => {
    await render(
      seeded((s) => {
        // A copy: the fixtures share one profile object between scenarios.
        s.me.profile = { ...s.me.profile, units: 'imperial' };
      }),
    );
    const card = await screen.findByRole('region', { name: 'Fuel' });
    expect(await within(card).findByText(/^\d+\.\d mpg$/)).toBeInTheDocument();
    expect(within(card).queryByText(/L\/100 km/)).toBeNull();
    // The fills keep their litres.
    const list = await screen.findByRole('list', { name: 'Fills and charges' });
    expect(within(list).getAllByText(/ L$/).length).toBeGreaterThan(0);
  });

  it.each([
    ['too_few_full_fills', 'Consumption needs two full fills with odometer readings.'],
    ['missed_fill', /A missed fill-up breaks the count/],
    ['mixed_units', /two full fills in the same unit/],
    ['no_readings', /needs the odometer on the fills/],
  ] as const)('says why there is no consumption: %s', async (why, words) => {
    const summary: FuelSummary = {
      byUnit: [{ unit: 'L', consumption: null, whyNone: why, trend: [] }],
    };
    await render(seeded(), {
      setup: (mock) => mock.on('GET', vehiclePaths.thingFuelSummary(':id'), () => summary),
    });
    const card = await screen.findByRole('region', { name: 'Fuel' });
    expect(await within(card).findByText(words)).toBeInTheDocument();
  });

  it('logs a full fill with its cost, station and odometer, once, with an Idempotency-Key', async () => {
    const { user, mock } = await render();
    await user.click(await screen.findByRole('button', { name: 'Log fuel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log fuel' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount, Litres' }), '40');
    await user.type(within(dialog).getByRole('textbox', { name: 'Cost' }), '960');
    await user.type(within(dialog).getByRole('textbox', { name: 'Odometer, km' }), '52700');
    await user.type(within(dialog).getByRole('combobox', { name: 'Station' }), 'Corniche Station');
    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = mock.lastCall('POST', vehiclePaths.thingFuel(COROLLA.thing));
    const body = call?.body as CreateFuelBody;
    expect(body).toMatchObject({
      amount: '40',
      unit: 'L',
      isFull: true,
      cost: '960',
      currency: 'EGP',
      vendor: { name: 'Corniche Station' },
      reading: { value: '52700' },
    });
    expect(body.missedBefore).toBeUndefined();
    expect(call?.headers['idempotency-key']).toBe(body.id);
    expect(await screen.findByText('Fuel logged')).toBeInTheDocument();
  });

  it('logs a partial fill after a missed fill-up', async () => {
    const { user, mock } = await render();
    await user.click(await screen.findByRole('button', { name: 'Log fuel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log fuel' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount, Litres' }), '15.5');
    await user.click(within(dialog).getByRole('radio', { name: 'Partial' }));
    await user.click(
      within(dialog).getByRole('switch', { name: 'I missed a fill-up before this one' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const body = mock.lastCall('POST', vehiclePaths.thingFuel(COROLLA.thing))?.body;
    expect(body).toMatchObject({ amount: '15.5', isFull: false, missedBefore: true });
  });

  it('refuses an odometer lower than the reading before it, with the neighbour, nothing saved', async () => {
    const state = seeded();
    // The neighbour is the latest reading taken by now: the fills are on fixed dates and Home's
    // fixture readings are days ago, so which one it is depends on today's date.
    const now = new Date().toISOString();
    const before = acceptedReadings(state, COROLLA.meter)
      .filter((r) => r.takenAt <= now)
      .at(-1);
    const named = Number(before?.value).toLocaleString('en');
    const { user } = await render(state);
    await user.click(await screen.findByRole('button', { name: 'Log fuel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log fuel' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount, Litres' }), '30');
    await user.type(within(dialog).getByRole('textbox', { name: 'Odometer, km' }), '40000');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(`Lower than the reading before it (${named} km)`, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('filters the fills by the URL: partial only', async () => {
    await render(seeded(), { search: '?f.full=0' });
    const list = await screen.findByRole('list', { name: 'Fills and charges' });
    await waitFor(() => expect(within(list).getAllByText('Partial')).toHaveLength(1));
    expect(within(list).queryByText('Full')).toBeNull();
  });

  it('shows a viewer the litres and consumption, never the money, and no Log fuel', async () => {
    await render(seeded((s) => (garage(s).role = 'viewer')));
    const card = await screen.findByRole('region', { name: 'Fuel' });
    await waitFor(() => expect(card.textContent).toMatch(/Hidden in this location/));
    expect(await within(card).findByText('7.3 L/100 km')).toBeInTheDocument();
    expect(within(card).queryByText(/EGP/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log fuel' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Fills and charges' });
    expect(within(list).queryByText(/EGP/)).toBeNull();
  });

  it('says Fuel & charging is off in this location, with Turn on for an owner', async () => {
    await render(
      seeded((s) => {
        const g = garage(s);
        g.modules = g.modules.filter((m) => m !== 'fuel');
        if (g.effectiveModules) g.effectiveModules = g.effectiveModules.filter((m) => m !== 'fuel');
      }),
    );
    expect(await screen.findByText(/Off in this location/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log fuel' })).toBeNull();
  });

  it('offline, Log fuel is off and says why', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await render();
    expect(await screen.findByRole('button', { name: 'Log fuel' })).toBeDisabled();
    expect(screen.getByText('Needs a connection: it has money.')).toBeInTheDocument();
  });

  it('reads right to left in Arabic, with the charts drawn left to right by geometry', async () => {
    await render(seeded(), { locale: 'ar', digits: 'eastern' });
    const list = await screen.findByRole('list', { name: /.+/ });
    expect(list).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelectorAll('svg[role="group"]').length).toBeGreaterThan(0),
    );
    for (const svg of document.querySelectorAll<SVGElement>('svg[role="group"]'))
      expect(svg.style.direction).toBe('ltr');
    expect(document.body.textContent).toMatch(/[٠-٩]/);
    expectLogicalOnly();
  });
});
