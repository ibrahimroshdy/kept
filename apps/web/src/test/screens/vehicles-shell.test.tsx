/**
 * Step 5's frame (plan T3; screens §1): Vehicles in the navigation while the module is on in any
 * location, its route answering (a stub until T17 builds the list), and the list pulling to
 * refresh (D212).
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { pullsOn } from '@/components/pull-to-refresh';
import { findHeading, renderApp } from '../app';

const nav = () => screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement;

describe('the step-5 navigation', () => {
  it('links Vehicles while the module is on somewhere, and the route answers', async () => {
    const { user } = await renderApp('/');
    await findHeading('Home');
    const link = await within(nav()).findByRole('link', { name: 'Vehicles' });
    expect(link).toHaveAttribute('href', '/vehicles');
    expect(link).not.toHaveAttribute('aria-disabled');
    await user.click(link);
    expect(await findHeading('Vehicles')).toBeInTheDocument();
  });

  it('hides Vehicles when the module is off everywhere', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'vehicles' && m !== 'fuel');
      l.effectiveModules = l.modules;
    }
    await renderApp('/', { state });
    await findHeading('Home');
    const main = within(nav());
    expect(await main.findByRole('link', { name: 'Schedules' })).toBeInTheDocument();
    expect(main.queryByRole('link', { name: 'Vehicles' })).toBeNull();
  });

  it('the vehicles list pulls to refresh (D212)', () => {
    expect(pullsOn('/vehicles')).toBe(true);
    expect(pullsOn('/vehicles/')).toBe(true);
  });
});
