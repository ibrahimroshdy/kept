/**
 * Insights (1.x, D234): spending per year with this year apart, value per place, the vehicles'
 * monthly costs and a table per vehicle, warranty coverage; a viewer who can't see money gets
 * counts and is told which location's amounts are left out; the location chip narrows it, and a
 * location without Money says so.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_INSIGHT_IDS } from '@/api/insights/mock';
import { insightsPaths } from '@/api/insights/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const Y = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).slice(0, 4));
const section = (name: string) =>
  screen.getByRole('heading', { name }).closest('section') as HTMLElement;

describe('Insights', () => {
  it('adds up spending, value, vehicle costs and warranties per currency', async () => {
    const { mock, user } = await renderApp('/insights', { digits: 'western' });
    await findHeading('Insights');
    await screen.findByRole('heading', { name: 'Spending on things' });

    const spending = section('Spending on things');
    // The full years add up in EGP; this year is apart, "so far".
    expect(within(spending).getByText(`Total, ${Y - 3}–${Y - 1}`)).toBeInTheDocument();
    expect(within(spending).getByText(/92,550/)).toBeInTheDocument();
    expect(within(spending).getAllByText(`${Y} so far`)[0]).toBeInTheDocument();
    expect(within(spending).getByText('not compared with full years')).toBeInTheDocument();
    expect(
      within(spending).getByText("1 purchase has no amount and isn't in the totals."),
    ).toBeInTheDocument();
    // USD is a currency of its own, never added to EGP.
    await user.click(within(spending).getByRole('radio', { name: 'USD' }));
    expect(within(spending).getAllByText(/420/).length).toBeGreaterThan(0);
    expect(within(spending).queryByText(/92,550/)).toBeNull();

    const value = section('Value by place');
    const kitchen = within(value).getByRole('link', { name: 'Kitchen' });
    expect(kitchen).toHaveAttribute('href', `/p/${MOCK_INSIGHT_IDS.kitchen}`);
    expect(within(value).getByText('Valued: 36 of 136 things')).toBeInTheDocument();
    expect(within(value).getByText('Unplaced')).toBeInTheDocument();

    const vehicles = section('Vehicle costs');
    expect(within(vehicles).getAllByText('Running cost per month, EGP')[0]).toBeInTheDocument();
    const corolla = within(vehicles).getByRole('link', { name: 'Toyota Corolla' });
    expect(corolla).toHaveAttribute('href', '/t/CAR7TY?tab=costs');
    expect(within(vehicles).getByRole('columnheader', { name: `${Y} so far` })).toBeInTheDocument();

    const warranties = section('Warranty coverage');
    expect(within(warranties).getByText('Covered now: 40 of 214 things')).toBeInTheDocument();
    expect(within(warranties).getByRole('link', { name: 'Galaxy S23' })).toHaveAttribute(
      'href',
      '/t/PH0N3S',
    );
    expect(within(warranties).getByRole('link', { name: 'See all on Expiring' })).toHaveAttribute(
      'href',
      expect.stringContaining('/expiring?f.source='),
    );
    expect(within(warranties).getByText(`Repairs resolved, ${Y - 1}: 1`)).toBeInTheDocument();

    expect(mock.lastCall('GET', insightsPaths.insights)).toBeTruthy();
    expect(screen.queryByText(/money is hidden/)).toBeNull();
    expect(MOCK_INSIGHT_IDS.kitchen).toBeTruthy();
    expectLogicalOnly();
  });

  it('gives a viewer counts, and says whose amounts are left out (D13)', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'viewer';
    await renderApp('/insights', { state, digits: 'western' });
    await screen.findByRole('heading', { name: 'Spending on things' });
    expect(
      screen.getAllByText('Amounts leave out Home: money is hidden from you there.').length,
    ).toBeGreaterThan(0);
    const spending = section('Spending on things');
    expect(within(spending).queryByRole('radio', { name: 'USD' })).toBeNull();
    const vehicles = section('Vehicle costs');
    expect(within(vehicles).getAllByText('Fills: 24, services: 3').length).toBe(2);
    expect(within(vehicles).queryByText('Running cost per month, EGP')).toBeNull();
    expect(within(section('Value by place')).getByText('136 things')).toBeInTheDocument();
    expect(screen.queryByText(/122,800/)).toBeNull();
  });

  it('narrows to a location with the chip, and says when Money is off there', async () => {
    await renderApp(`/insights?f.location=${IDS.garage}`);
    expect(await screen.findByText('Money is off here')).toBeInTheDocument();
    // The chip names the location picked (D174).
    expect(screen.getAllByRole('button', { name: /Garage/ }).length).toBeGreaterThan(0);
  });

  it('is in the navigation where Money is on', async () => {
    await renderApp('/');
    await findHeading('Home');
    const links = await screen.findAllByRole('link', { name: 'Insights' });
    expect(links[0]).toHaveAttribute('href', '/insights');
    expect(links[0]).not.toHaveAttribute('aria-disabled');
  });
});
