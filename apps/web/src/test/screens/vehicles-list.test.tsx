/**
 * The Vehicles list (step-5 plan T17; screens §1, §8; D52, D188, D205): the in-use vehicles of
 * every location with the module on, each with its odometer and how old the reading is, what's
 * due next and its documents; the sold motorbike only under State: Sold; the stale and unknown
 * readings; Arabic digits and direction; the keyboard; offline.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { findHeading, renderApp } from '../app';

const seeded = () => {
  const state = ownerScenario();
  ensureVehiclesSeeded(state);
  return state;
};
const list = async (name = 'Vehicles') => screen.findByRole('list', { name });
const row = (name: string) =>
  screen.getAllByRole('article').find((a) => a.getAttribute('aria-label') === name) as HTMLElement;

let restoreOnline: (() => void) | null = null;
afterEach(() => {
  restoreOnline?.();
  restoreOnline = null;
});

describe('the Vehicles list', () => {
  it('lists the vehicles in use with their reading, what is due and their documents', async () => {
    await renderApp('/vehicles', { state: seeded(), digits: 'western' });
    await findHeading('Vehicles');
    const rows = within(await list()).getAllByRole('article');
    const names = rows.map((r) => r.getAttribute('aria-label'));
    expect(names).toContain('Toyota Corolla');
    expect(names).toContain('هيونداي إلنترا');
    expect(names).toContain('مولد الكهرباء');
    // The sold motorbike waits for State: Sold (Q24).
    expect(names).not.toContain('Honda CB500');

    const corolla = row('Toyota Corolla');
    expect(within(corolla).getByRole('link', { name: 'Toyota Corolla' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/t\//),
    );
    expect(corolla).toHaveTextContent(/km/);
    expect(corolla).toHaveTextContent(/Oil & filter/);
    expect(corolla).toHaveTextContent(/Licence due in \d+ days/);
    expect(corolla).toHaveTextContent(/L\/100 km/);
  });

  it('marks a stale reading and an unknown one (D52, D188)', async () => {
    await renderApp('/vehicles', { state: seeded(), digits: 'western' });
    await list();
    expect(within(row('هيونداي إلنترا')).getByText('Reading is 34 days old')).toBeInTheDocument();
    expect(within(row('مولد الكهرباء')).getByText('Unknown: reading needed')).toBeInTheDocument();
    // No estimated date once the reading is too old to estimate from.
    expect(row('مولد الكهرباء')).not.toHaveTextContent(/estimated ~/);
  });

  it('shows the sold motorbike under State: Sold', async () => {
    await renderApp('/vehicles?f.state=sold', { state: seeded() });
    const rows = within(await list()).getAllByRole('article');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Honda CB500']);
    expect(within(rows[0] as HTMLElement).getByText('Sold')).toBeInTheDocument();
  });

  it('reads right to left in Arabic, with Eastern digits', async () => {
    await renderApp('/vehicles', { state: seeded(), locale: 'ar', digits: 'eastern' });
    const rows = within(await list('السيارات')).getAllByRole('article');
    expect(document.documentElement.dir).toBe('rtl');
    const corolla = rows.find((r) => r.getAttribute('aria-label') === 'Toyota Corolla');
    expect(corolla?.textContent).toMatch(/[٠-٩]/);
    expect(corolla?.textContent).not.toMatch(/\d{2},\d{3}/);
  });

  it('goes row to row by keyboard', async () => {
    const { user } = await renderApp('/vehicles', { state: seeded() });
    await list();
    const link = within(row('Toyota Corolla')).getByRole('link', { name: 'Toyota Corolla' });
    link.focus();
    expect(link).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Toyota Corolla' })).toBeInTheDocument();
  });

  it('says it needs a connection offline', async () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    restoreOnline = () => {
      if (original) Object.defineProperty(navigator, 'onLine', original);
      else Reflect.deleteProperty(navigator, 'onLine');
    };
    await renderApp('/vehicles', { state: seeded() });
    expect(await screen.findByText('Needs a connection')).toBeInTheDocument();
  });

  it('says so when Vehicles is off everywhere', async () => {
    const state = seeded();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'vehicles' && m !== 'fuel');
      l.effectiveModules = l.modules;
    }
    await renderApp('/vehicles', { state });
    expect(await screen.findByText('Vehicles is off in your locations')).toBeInTheDocument();
  });
});
