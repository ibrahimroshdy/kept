/**
 * Step 7's frame (plan T3): Consumables in the navigation while the module is on in any location,
 * Export beside Import in Settings, and the step-7 routes answering (stubs until Phase C builds
 * them), the old Homebox label paths included.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '../app';

const nav = () => screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement;

describe('the step-7 navigation', () => {
  it('links Consumables only while the module is on somewhere', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'consumables');
      if (l.effectiveModules)
        l.effectiveModules = l.effectiveModules.filter((m) => m !== 'consumables');
    }
    await renderApp('/', { state });
    await findHeading('Home');
    const main = within(nav());
    expect(await main.findByRole('link', { name: 'Schedules' })).toBeInTheDocument();
    expect(main.queryByRole('link', { name: 'Consumables' })).toBeNull();
  });

  it('shows Consumables where a location turns it on (Home, in the fixtures)', async () => {
    await renderApp('/');
    await findHeading('Home');
    expect(await within(nav()).findByRole('link', { name: 'Consumables' })).toHaveAttribute(
      'href',
      '/consumables',
    );
  });

  it('puts Export beside Import in Settings', async () => {
    await renderApp('/settings/import');
    expect(await screen.findByRole('link', { name: 'Export' })).toHaveAttribute(
      'href',
      '/settings/export',
    );
  });
});

describe('the step-7 routes', () => {
  it.each([
    ['/settings/export', 'Export'],
    ['/consumables', 'Consumables'],
    ['/a/000-001', 'Old Homebox label'],
    ['/item/0192f0a0-0000-7000-8000-000000000001', 'Old Homebox label'],
    ['/location/0192f0a0-0000-7000-8000-000000000002', 'Old Homebox label'],
  ])('%s answers', async (path, title) => {
    await renderApp(path);
    expect(await findHeading(title)).toBeInTheDocument();
  });
});
