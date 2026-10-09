/**
 * The Fuel tab when its trends chart's chunk cannot load (a phone offline before the first load:
 * CI, 2026-10-09, the whole vehicle page crashed with "Something went wrong!"). The tab stays up
 * without its trends; the other lazy charts (components/charts/lazy.tsx) already do this.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { COROLLA } from '@/api/vehicles/mock/state';
import { toastQueue } from '@/components/ui/toast';
import { renderThingPart } from '@/test/thing-part';
import { VehicleFuel } from './fuel-tab';

vi.mock('./fuel-trends', () => {
  throw new Error('chunk failed offline');
});

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of toastQueue.visibleToasts) toastQueue.close(t.key);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('the Fuel tab without its trends chunk', () => {
  it('keeps the summary and the fills, never the route error', async () => {
    const state: MockState = ownerScenario();
    ensureVehiclesSeeded(state);
    const garage = state.locations.find((l) => l.id === IDS.garage);
    if (!garage) throw new Error('fixture');
    renderThingPart(<VehicleFuel />, { thingId: COROLLA.thing, state, digits: 'western' });
    const card = await screen.findByRole('region', { name: 'Fuel' });
    expect(await within(card).findByText('7.3 L/100 km')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Fills and charges' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByText('Something went wrong!')).toBeNull();
  });
});
