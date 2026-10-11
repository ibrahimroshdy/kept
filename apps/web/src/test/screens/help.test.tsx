/**
 * Help (plan T31; D138): "Show me around" is a tour over Home → Capture → Inbox → Search →
 * More → Labels → Settings that a
 * keyboard can drive (arrows by reading direction, Escape), replayable and recorded as
 * `help.tour_seen`; the Get-started checklist comes back from here; install and share-into notes
 * per platform (iPhone has no share target, V9); the diagnostics link.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryPaths } from '@/api/inventory/paths';
import { ownerScenario } from '@/api/mock/fixtures';
import { tourLedger } from '@/components/hints/tour-ledger';
import { expectLogicalOnly } from '@/test/render';
import { findHeading, pathOf, renderApp } from '../app';

const key = (k: string) => fireEvent.keyDown(window, { key: k });

afterEach(() => {
  // A tour left open by a failed test must not leak into the next one.
  act(() => key('Escape'));
  for (const el of document.querySelectorAll('.driver-popover, .driver-overlay')) el.remove();
});

describe('Help', () => {
  it('shows the tour, the checklist, install and share-into notes, and diagnostics', async () => {
    await renderApp('/help');
    expect(await findHeading('Help')).toBeInTheDocument();
    expect(screen.getByText('Show me around')).toBeInTheDocument();
    expect(screen.getByText('Get-started checklist')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show steps' })).toBeInTheDocument();
    expect(
      screen.getByText(/iPhone doesn't let web apps appear in the Share sheet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/settings/diagnostics',
    );
    expect(within(screen.getByRole('main')).queryByText('Coming soon')).toBeNull();
  });

  it('"Show me around" walks every section from the keyboard, with skip and Keep/Discard', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.modules = l.modules.filter((m) => m !== 'vehicles');
    const { user, mock, router } = await renderApp('/help', { state });
    await findHeading('Help');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    // The tour navigates for real: Home first, then one section per step.
    const legs: { name: string; progress: string; path: string }[] = [
      { name: 'Home', progress: '1 of 15', path: '/' },
      { name: 'Capture', progress: '2 of 15', path: '/capture' },
      { name: 'Inbox', progress: '3 of 15', path: '/inbox' },
    ];
    for (const leg of legs) {
      const dialog = await screen.findByRole('dialog', { name: leg.name });
      expect(dialog).toHaveTextContent(leg.progress);
      expect(pathOf(router)).toBe(leg.path);
      if (leg.name !== 'Inbox') {
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
    }
    // Back comes back on the arrow; forward returns.
    act(() => key('ArrowLeft'));
    expect(await screen.findByRole('dialog', { name: 'Capture' })).toHaveTextContent('2 of 15');
    act(() => key('ArrowRight'));
    expect(await screen.findByRole('dialog', { name: 'Inbox' })).toHaveTextContent('3 of 15');
    // Skip jumps a whole section: past the inbox to the location.
    await screen.findByRole('dialog', { name: 'Inbox' });
    await user.click(
      within(screen.getByRole('dialog', { name: 'Inbox' })).getByRole('button', { name: 'Skip' }),
    );
    const location = await screen.findByRole('dialog', { name: 'Location' });
    expect(location).toHaveTextContent('4 of 15');
    expect(pathOf(router)).toMatch(/^\/loc\//);
    // Back returns, Next carries on.
    await user.click(within(location).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Inbox' })).toHaveTextContent('3 of 15');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Inbox' })).getByRole('button', { name: 'Next' }),
    );
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Location' })).getByRole('button', {
        name: 'Next',
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Search' })).toHaveTextContent('5 of 15');
    expect(pathOf(router)).toBe('/search');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Search' })).getByRole('button', { name: 'Next' }),
    );
    // Skip jumps the gated-out Vehicles straight to Schedules.
    const labels = await screen.findByRole('dialog', { name: 'Labels' });
    expect(labels).toHaveTextContent('6 of 15');
    expect(pathOf(router)).toBe('/labels');
    await user.click(within(labels).getByRole('button', { name: 'Skip' }));
    const rest: { name: string; progress: string; path: string }[] = [
      { name: 'Schedules', progress: '7 of 15', path: '/schedules' },
      { name: 'Lending', progress: '8 of 15', path: '/lending' },
      { name: 'Paperwork', progress: '9 of 15', path: '/paperwork' },
      { name: 'Consumables', progress: '10 of 15', path: '/consumables' },
      { name: 'Activity', progress: '11 of 15', path: '/activity' },
      { name: 'Trash', progress: '12 of 15', path: '/trash' },
      { name: 'Notifications', progress: '13 of 15', path: '/notifications' },
      { name: 'Settings', progress: '14 of 15', path: '/settings' },
      { name: 'Done', progress: '15 of 15', path: '/help' },
    ];
    for (const leg of rest) {
      const dialog = await screen.findByRole('dialog', { name: leg.name });
      expect(dialog).toHaveTextContent(leg.progress);
      expect(pathOf(router)).toBe(leg.path);
      if (leg.name !== 'Done') {
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      }
    }
    // The run added two things: Done brings Keep/Discard, and Discard is honest offline.
    tourLedger.record('capture', 'c1');
    tourLedger.record('thing', 't1');
    const done = await screen.findByRole('dialog', { name: 'Done' });
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    const keep = await screen.findByRole('dialog', { name: 'Keep what you added?' });
    expect(keep).toHaveTextContent('2 items');
    await user.click(within(keep).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Keep what you added?' })).toBeInTheDocument();
    await user.click(within(keep).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour_seen'))?.body).toEqual({
        seen: true,
      }),
    );
    expectLogicalOnly();
    // Replayable.
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 15');
  }, 60000);

  it('a viewer everywhere skips the write sections with consistent progress', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) => ({ ...l, role: 'viewer' as const }));
    const { user, mock, router } = await renderApp('/help', { state });
    await findHeading('Help');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 14');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Home' })).getByRole('button', { name: 'Next' }),
    );
    // Capture and the inbox are writes a viewer cannot do: the tour lands on the location.
    const location = await screen.findByRole('dialog', { name: 'Location' });
    expect(location).toHaveTextContent('2 of 14');
    expect(pathOf(router)).toMatch(/^\/loc\//);
    act(() => key('Escape'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour_seen'))?.body).toEqual({
        seen: true,
      }),
    );
    expectLogicalOnly();
  }, 60000);

  it('an empty household tours New location and ledgers what it creates', async () => {
    const state = ownerScenario();
    state.locations = [];
    const { user, mock, router } = await renderApp('/help', { state });
    await findHeading('Help');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 8');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Home' })).getByRole('button', { name: 'Next' }),
    );
    const step = await screen.findByRole('dialog', { name: 'New location' });
    expect(step).toHaveTextContent('2 of 8');
    expect(pathOf(router)).toBe('/locations/new');
    // The micro-action: name it and create it; the run tracks the created id.
    const main = () => within(screen.getByRole('main'));
    await user.type(main().getByLabelText('Name'), 'Tour hut');
    await user.click(main().getByRole('button', { name: 'Next' }));
    await user.click(main().getByRole('button', { name: 'Skip' }));
    await user.click(main().getByRole('button', { name: 'Create Tour hut' }));
    // Creating leaves for Home: the tour closes through Keep/Discard for what was added.
    const keep = await screen.findByRole('dialog', { name: 'Keep what you added?' });
    expect(keep).toHaveTextContent('1 item');
    await user.click(within(keep).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour_seen'))?.body).toEqual({
        seen: true,
      }),
    );
    expectLogicalOnly();
  }, 60000);

  it('in Arabic the arrows follow the reading direction, and the steps use its digits', async () => {
    const { user } = await renderApp('/help', { locale: 'ar' });
    await findHeading('المساعدة');
    await user.click(screen.getByRole('button', { name: 'ابدأ' }));
    const home = await screen.findByRole('dialog', { name: 'الرئيسية' });
    expect(home).toHaveTextContent('١ من ١٦');
    // Forward is to the left in Arabic.
    act(() => key('ArrowLeft'));
    expect(await screen.findByRole('dialog', { name: 'التقاط' })).toHaveTextContent('٢ من ١٦');
    act(() => key('ArrowRight'));
    expect(await screen.findByRole('dialog', { name: 'الرئيسية' })).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('brings a hidden Get-started checklist back to Home', async () => {
    const state = ownerScenario();
    state.inventory.checklistDismissed = true;
    state.inventory.hints.push({
      key: 'checklist',
      seenAt: null,
      dismissedAt: new Date().toISOString(),
    });
    const { user, mock } = await renderApp('/help', { state });
    await findHeading('Help');
    expect(await screen.findByText('Hidden from Home.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Bring it back' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('checklist'))?.body).toEqual({
        dismissed: false,
      }),
    );
    expect(await screen.findByText('The checklist is back on Home')).toBeInTheDocument();
    expect(await screen.findByText('On Home until every step is done.')).toBeInTheDocument();
  });
});
