/**
 * The sidebar's Locations list follows the location you are in (builds D224): its own page marks
 * the row as the current page; a place, a thing (any tab), a container, the location's settings and
 * a condition report mark it as the current location. Pages across locations mark none.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { seedConditionReport } from '@/api/condition/mock';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { locationAddress } from '@/lib/address';
import { findHeading, renderApp } from '@/test/app';

vi.setConfig({ testTimeout: 15_000 });

const DESKTOP = ['(min-width: 768px)', '(min-width: 1024px)'];

/** jsdom has no matchMedia: list the queries that match. */
function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

const locationsNav = () => screen.getByRole('navigation', { name: 'Locations' });
const row = (name: string) => within(locationsNav()).getByRole('link', { name });
const mainNav = () =>
  screen
    .getAllByRole('navigation', { name: 'Main' })
    .find((n) => within(n).queryByText('Activity')) as HTMLElement;

/** The Locations rows shown as chosen, with the state each one announces. */
const marked = () =>
  within(locationsNav())
    .getAllByRole('link')
    .filter((a) => a.hasAttribute('data-inside') || a.getAttribute('data-status') === 'active')
    .map((a) => `${a.textContent?.trim()}:${a.getAttribute('aria-current')}`);

/** Waits until exactly this row is chosen, announcing `current`. */
const expectChosen = (name: string, current: 'page' | 'location') =>
  waitFor(() => expect(marked()).toEqual([`${name}:${current}`]));

const garageAddress = locationAddress({ id: IDS.garage, name: 'Garage', kind: 'garage' });

describe('the location you are in', () => {
  it('on the location’s page, in every layout, its row is the current page', async () => {
    media(DESKTOP);
    await renderApp(`/loc/${IDS.garage}`);
    await findHeading('Garage');
    await expectChosen('Garage', 'page');
    expect(row('Garage')).toHaveAttribute('href', `/loc/${garageAddress}`);
  });

  it('the photo layout of the location’s page keeps it', async () => {
    media(DESKTOP);
    await renderApp(`/loc/${garageAddress}?view=photos`);
    await findHeading('Garage');
    await expectChosen('Garage', 'page');
  });

  it('on a place’s page, the place’s location is the current location', async () => {
    media(DESKTOP);
    await renderApp(`/p/${INV_IDS.place.toolWall}`);
    await findHeading('Tool wall');
    await expectChosen('Garage', 'location');
  });

  it('on a thing’s page, by its short ID, without asking the server again', async () => {
    media(DESKTOP);
    const { mock } = await renderApp('/t/2HX9RB');
    await findHeading(/Bosch drill/);
    await expectChosen('Garage', 'location');
    // The page's own read of the thing, once: the sidebar reads what the page loaded.
    const path = `/api/v1/things/${INV_IDS.thing.drill}`;
    expect(mock.calls.filter((c) => c.method === 'GET' && c.path === path)).toHaveLength(1);
  });

  it('on a thing’s tab (a vehicle’s Services)', async () => {
    media(DESKTOP);
    await renderApp('/t/CAR7TY?tab=services');
    await findHeading('Toyota Corolla');
    await expectChosen('Garage', 'location');
  });

  it('on a container, in another location', async () => {
    media(DESKTOP);
    await renderApp('/t/B0X3QF');
    await findHeading('Cable box');
    await expectChosen('Home', 'location');
  });

  it('on the location’s settings, while Settings stays the current main entry', async () => {
    media(DESKTOP);
    await renderApp(`/settings/location/${IDS.garage}/general`);
    await findHeading('General');
    await expectChosen('Garage', 'location');
    expect(within(mainNav()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('on a condition report, its location', async () => {
    media(DESKTOP);
    const state = ownerScenario();
    const id = '01926f00-0000-7000-8000-0000000cr101';
    seedConditionReport(state, {
      id,
      locationId: IDS.home,
      kind: 'move_in',
      heldOn: '2026-10-01',
      notes: null,
      createdBy: { displayName: 'Ibrahim' },
      createdAt: '2026-10-01T09:00:00Z',
      finishedAt: null,
      finishedBy: null,
      rowVersion: 1,
      rooms: [],
    });
    await renderApp(`/condition-reports/${id}`, { state });
    await findHeading(/^Move-in/);
    await expectChosen('Home', 'location');
  });

  it('leaving for a page across locations clears it; Home and Search mark none', async () => {
    media(DESKTOP);
    const { router } = await renderApp('/t/2HX9RB');
    await findHeading(/Bosch drill/);
    await expectChosen('Garage', 'location');

    await router.navigate({ to: '/' });
    await findHeading('Home');
    await waitFor(() => expect(marked()).toEqual([]));
    expect(within(mainNav()).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await router.navigate({ to: '/search' });
    await findHeading('Search');
    expect(marked()).toEqual([]);
  });

  it('Settings › Me marks no location', async () => {
    media(DESKTOP);
    await renderApp('/settings/me/notifications');
    await findHeading(/Notifications/);
    expect(marked()).toEqual([]);
  });
});
