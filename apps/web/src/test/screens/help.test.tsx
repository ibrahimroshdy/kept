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
import { expectLogicalOnly } from '@/test/render';
import { findHeading, renderApp } from '../app';

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

  it('"Show me around" runs Home → Capture → Inbox → Search → More → Labels → Settings from the keyboard', async () => {
    const { user, mock } = await renderApp('/help');
    await findHeading('Help');
    const start = screen.getByRole('button', { name: 'Start' });
    await user.click(start);

    const tour = await screen.findByRole('dialog', { name: 'Home' });
    expect(tour).toHaveTextContent('1 of 7');
    // The highlighted stop is the navigation entry itself.
    expect(document.querySelector('.driver-active-element')?.getAttribute('data-tour')).toBe(
      'home',
    );

    act(() => key('ArrowRight'));
    expect(await screen.findByRole('dialog', { name: 'Capture' })).toHaveTextContent('2 of 7');
    act(() => key('ArrowLeft'));
    expect(await screen.findByRole('dialog', { name: 'Home' })).toBeInTheDocument();
    // Back from the first stop stays there.
    act(() => key('ArrowLeft'));
    expect(screen.getByRole('dialog', { name: 'Home' })).toBeInTheDocument();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Capture' })).getByRole('button', {
        name: 'Next',
      }),
    );
    await screen.findByRole('dialog', { name: 'Inbox' });
    act(() => key('ArrowRight'));
    expect(await screen.findByRole('dialog', { name: 'Search' })).toHaveTextContent('4 of 7');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Search' })).getByRole('button', {
        name: 'Next',
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'More' })).toHaveTextContent('5 of 7');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'More' })).getByRole('button', {
        name: 'Next',
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Labels' })).toHaveTextContent('6 of 7');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Labels' })).getByRole('button', {
        name: 'Next',
      }),
    );
    const last = await screen.findByRole('dialog', { name: 'Settings' });
    expect(last).toHaveTextContent('7 of 7');
    expect(within(last).getByRole('button', { name: 'Close' })).toBeInTheDocument();

    act(() => key('Escape'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus is back where the tour started.
    await waitFor(() => expect(document.activeElement).toBe(start));
    await waitFor(() =>
      expect(mock.lastCall('PUT', inventoryPaths.hint('help.tour_seen'))?.body).toEqual({
        seen: true,
      }),
    );
    // Replayable.
    await user.click(start);
    expect(await screen.findByRole('dialog', { name: 'Home' })).toBeInTheDocument();
  });

  it('in Arabic the arrows follow the reading direction, and the steps use its digits', async () => {
    const { user } = await renderApp('/help', { locale: 'ar' });
    await findHeading('المساعدة');
    await user.click(screen.getByRole('button', { name: 'ابدأ' }));
    const home = await screen.findByRole('dialog', { name: 'الرئيسية' });
    expect(home).toHaveTextContent('١ من ٧');
    // Forward is to the left in Arabic.
    act(() => key('ArrowLeft'));
    expect(await screen.findByRole('dialog', { name: 'التقاط' })).toHaveTextContent('٢ من ٧');
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
