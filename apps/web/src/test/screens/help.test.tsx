/**
 * Help (plan T31; D138, D242): "Show me around" walks Home → Capture → Inbox → a location →
 * Search → Labels → More → Settings → Help, a keyboard can drive it (arrows by reading
 * direction, Escape), it is replayable, and where it stopped is remembered on the server
 * (`help.tour.<section>`) so Help resumes there; finishing or closing records `help.tour_seen`; the Get-started checklist comes back from here; install and share-into notes
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

  it('"Show me around" walks today\'s screens, with Back, the arrows and Keep/Discard', async () => {
    const { user, mock, router } = await renderApp('/help');
    await findHeading('Help');
    expect(
      screen.getByText(/A short walk from Home to Help\. Close it any time/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));

    // The tour navigates for real, one stop per screen.
    const legs: { name: string; progress: string; path: string | RegExp }[] = [
      { name: 'Home', progress: '1 of 9', path: '/' },
      { name: 'Capture', progress: '2 of 9', path: '/capture' },
      { name: 'Inbox', progress: '3 of 9', path: '/inbox' },
      { name: 'Location', progress: '4 of 9', path: /^\/loc\// },
      { name: 'Search', progress: '5 of 9', path: '/search' },
      { name: 'Labels', progress: '6 of 9', path: '/labels' },
      { name: 'More', progress: '7 of 9', path: '/more' },
      { name: 'Notifications', progress: '8 of 9', path: '/settings' },
      { name: "That's the tour", progress: '9 of 9', path: '/help' },
    ];
    for (const [k, leg] of legs.entries()) {
      const dialog = await screen.findByRole('dialog', { name: leg.name });
      expect(dialog).toHaveTextContent(leg.progress);
      if (typeof leg.path === 'string') expect(pathOf(router)).toBe(leg.path);
      else expect(pathOf(router)).toMatch(leg.path);
      if (leg.name === 'Location') {
        // The location stop points at its List / Grid / Map switch.
        expect(
          document.querySelector('[data-tour="location-layout"].driver-active-element'),
        ).not.toBeNull();
        // Back comes back on the button and the arrow; forward returns.
        await user.click(within(dialog).getByRole('button', { name: 'Back' }));
        expect(await screen.findByRole('dialog', { name: 'Inbox' })).toHaveTextContent('3 of 9');
        act(() => key('ArrowRight'));
        await screen.findByRole('dialog', { name: 'Location' });
        act(() => key('ArrowLeft'));
        await screen.findByRole('dialog', { name: 'Inbox' });
        act(() => key('ArrowRight'));
        await user.click(
          within(await screen.findByRole('dialog', { name: 'Location' })).getByRole('button', {
            name: 'Next',
          }),
        );
        continue;
      }
      if (k < legs.length - 1)
        await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    }
    // The run added two things: Done brings Keep/Discard, and Discard is honest offline.
    tourLedger.record('capture', 'c1');
    tourLedger.record('thing', 't1');
    const done = await screen.findByRole('dialog', { name: "That's the tour" });
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
    // Every stop was remembered as passed, so Help knows it was seen through.
    expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour.finish'))?.body).toEqual({
      dismissed: true,
    });
    expect(await screen.findByText('Seen it all. Replay it any time.')).toBeInTheDocument();
    expectLogicalOnly();
    // Replayable: Start begins at Home again and forgets the last run.
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 9');
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour.finish'))?.body).toEqual({
        dismissed: false,
      }),
    );
  }, 60000);

  it('resumes where the tour stopped, on any device, or starts over', async () => {
    const state = ownerScenario();
    const at = new Date().toISOString();
    for (const id of ['home', 'capture'])
      state.inventory.hints.push({ key: `help.tour.${id}`, seenAt: at, dismissedAt: at });
    const { user, mock, router } = await renderApp('/help', { state });
    await findHeading('Help');
    expect(await screen.findByText('Stopped at Inbox.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    const inbox = await screen.findByRole('dialog', { name: 'Inbox' });
    expect(inbox).toHaveTextContent('3 of 9');
    expect(pathOf(router)).toBe('/inbox');
    await user.click(within(inbox).getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: 'Location' });
    expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour.inbox'))?.body).toEqual({
      dismissed: true,
    });
    // Closing keeps the place: Help offers the location next.
    act(() => key('Escape'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      await router.navigate({ to: '/help' });
    });
    expect(await screen.findByText('Stopped at Location.')).toBeInTheDocument();
    // Start over goes back to Home and restores every key it had passed.
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 9');
    for (const id of ['home', 'capture', 'inbox'])
      expect(mock.lastCall('PUT', inventoryPaths.hint(`help.tour.${id}`))?.body).toEqual({
        dismissed: false,
      });
  }, 60000);

  it('a viewer everywhere skips Capture and the Inbox with consistent progress', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) => ({ ...l, role: 'viewer' as const }));
    const { user, mock, router } = await renderApp('/help', { state });
    await findHeading('Help');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 7');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Home' })).getByRole('button', { name: 'Next' }),
    );
    // Capture and the inbox are writes a viewer cannot do: the tour lands on the location.
    const location = await screen.findByRole('dialog', { name: 'Location' });
    expect(location).toHaveTextContent('2 of 7');
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
    expect(await screen.findByRole('dialog', { name: 'Home' })).toHaveTextContent('1 of 6');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Home' })).getByRole('button', { name: 'Next' }),
    );
    const step = await screen.findByRole('dialog', { name: 'New location' });
    expect(step).toHaveTextContent('2 of 6');
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
    expect(home).toHaveTextContent('١ من ٩');
    // Forward is to the left in Arabic.
    act(() => key('ArrowLeft'));
    expect(await screen.findByRole('dialog', { name: 'التقاط' })).toHaveTextContent('٢ من ٩');
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
