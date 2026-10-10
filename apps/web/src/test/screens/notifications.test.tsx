/**
 * The notification centre (plan T24; D39, D57, step-4 Q32; frame "7 · Notification centre ·
 * phone · light"): grouped by kind in the frame's order, each naming the thing or place, its
 * path and the local date; Complete and Snooze open T21's sheets; Mark returned in one tap with
 * Undo; the polite reminder copied, never sent; Mark all read; the filter strip from the URL; the
 * rail's badge and the polled count; and the viewer, offline and Arabic variants.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { ownerScenario } from '@/api/mock/fixtures';
import { needsConnection } from '@/components/notifications/route-error';
import { findHeading, renderApp } from '../app';

const H = HOUSEHOLD_IDS;
const DRILL = '\u2068Bosch drill, 18 V\u2069';
const BOILER = 'Boiler service · \u2068Kitchen\u2069';

const row = (name: string) => screen.findByRole('article', { name }, { timeout: 3000 });
const centre = () => screen.findByRole('list', { name: 'Notifications' }, { timeout: 3000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the notification centre', () => {
  it('groups by kind in the frame’s order, newest first in each', async () => {
    await renderApp('/notifications');
    await findHeading('Notifications');
    const list = await centre();
    const headings = within(list)
      .getAllByRole('presentation')
      .map((el) => el.textContent);
    expect(headings).toEqual([
      'Due and coming up',
      'Lending',
      'Expiring',
      'Members',
      'AI',
      'Downloads',
    ]);
    const names = within(list)
      .getAllByRole('article')
      .map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual([
      BOILER,
      DRILL,
      'Home insurance',
      'Warranty · \u2068Samsung TV, 55″\u2069',
      'Louis joined Home',
      'Talia no longer has access to Garage',
      "AI used 80% of this month's cap",
      'Your monthly AI summary',
      'Your claim pack is ready',
    ]);
    expect(screen.getByText('4 unread')).toBeInTheDocument();
  });

  it('names the place, its path and the local date', async () => {
    await renderApp('/notifications');
    const boiler = within(await row(BOILER));
    expect(boiler.getByRole('link', { name: 'Kitchen' })).toHaveAttribute(
      'href',
      `/p/${INV_IDS.place.kitchen}`,
    );
    // The path it sits on, which starts with the location.
    expect(boiler.getByText('Home')).toBeInTheDocument();
    expect(boiler.getByText(/^Due /)).toBeInTheDocument();
    expect(boiler.getByText(/Unread/)).toBeInTheDocument();
    const drill = within(await row(DRILL));
    expect(drill.getByText('2 days overdue')).toBeInTheDocument();
    expect(drill.getByText(/^Was due back /)).toBeInTheDocument();
  });

  it('a schedule overdue by its meter while its day is ahead says the reading passed it (T29)', async () => {
    const state = ownerScenario();
    const n = state.household.notifications.find((x) => x.reminder?.sourceId === H.schedule.boiler);
    if (!n?.reminder) throw new Error('no boiler reminder');
    n.reminder.kind = 'overdue';
    n.reminder.dueValue = '60000';
    await renderApp('/notifications', { state });
    const boiler = within(await row(BOILER));
    expect(boiler.getByText('Past 60,000')).toBeInTheDocument();
    expect(boiler.queryByText(/^Was due /)).toBeNull();
  });

  it('Complete and Snooze open the schedule’s sheets, and mark it read', async () => {
    const { user, mock } = await renderApp('/notifications');
    const boiler = within(await row(BOILER));
    await user.click(boiler.getByRole('button', { name: `Complete ${BOILER}` }));
    expect(
      await screen.findByRole('dialog', { name: 'Complete Boiler service' }),
    ).toBeInTheDocument();
    const stored = mock.state.household.notifications.find(
      (n) => n.id === H.notification.boilerDue,
    );
    await waitFor(() => expect(stored?.readAt).toBeTruthy());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(await row(BOILER)).getByRole('button', { name: `Snooze ${BOILER}` }));
    expect(
      await screen.findByRole('dialog', { name: 'Snooze Boiler service' }),
    ).toBeInTheDocument();
  });

  it('marks the drill returned in one tap, with Undo, and then reads Done', async () => {
    const { user, mock } = await renderApp('/notifications');
    const drill = within(await row(DRILL));
    await user.click(await drill.findByRole('button', { name: `Mark ${DRILL} returned` }));
    expect(await screen.findByText(`${DRILL} is back`)).toBeInTheDocument();
    const loan = mock.state.household.loans.find((l) => l.id === H.loan.drill);
    await waitFor(() => expect(loan?.returnedAt).toBeTruthy());
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: DRILL })).getByText('Done'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('article', { name: DRILL })).queryByRole('button', {
        name: `Mark ${DRILL} returned`,
      }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(loan?.returnedAt).toBeNull());
  });

  it('copies a polite reminder for a loan out, and never sends it', async () => {
    const { user } = await renderApp('/notifications');
    const writeText = vi.fn(async (_: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const drill = within(await row(DRILL));
    await user.click(await drill.findByRole('button', { name: `Copy a reminder for ${DRILL}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('Hi Murdock');
    expect(
      await screen.findByText('Send it however you like. Kept never sends it.'),
    ).toBeInTheDocument();
  });

  it('Renew opens the document’s sheet', async () => {
    const { user } = await renderApp('/notifications');
    const insurance = within(await row('Home insurance'));
    await user.click(insurance.getByRole('button', { name: 'Renew Home insurance' }));
    expect(await screen.findByRole('dialog', { name: 'Renew Home insurance' })).toBeInTheDocument();
  });

  it('the notices link to where they are dealt with', async () => {
    await renderApp('/notifications');
    const louis = within(await row('Louis joined Home'));
    expect(louis.getByText('Role: Member')).toBeInTheDocument();
    expect(louis.getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/settings\/location\/[^/]+\/members$/),
    );
    const pack = within(screen.getByRole('article', { name: 'Your claim pack is ready' }));
    expect(pack.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `/reports/claim-pack?run=${HOUSEHOLD_IDS.claimPack.home}`,
    );
    const cap = within(screen.getByRole('article', { name: "AI used 80% of this month's cap" }));
    expect(cap.getByRole('link', { name: 'AI usage' }).getAttribute('href')).toContain(
      '/settings/ai/usage?',
    );
  });

  it('Mark all read clears the unread count', async () => {
    const { user, mock } = await renderApp('/notifications');
    await user.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByText('4 unread')).toBeNull());
    expect(mock.state.household.notifications.every((n) => n.readAt)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('filters by kind and by unread from the URL', async () => {
    await renderApp('/notifications?f.kind=lending');
    await row(DRILL);
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('shows only the unread ones with f.unread', async () => {
    await renderApp('/notifications?f.unread=1');
    await row(DRILL);
    expect(screen.getAllByRole('article')).toHaveLength(4);
  });

  it('the header opens its settings', async () => {
    await renderApp('/notifications');
    await findHeading('Notifications');
    expect(screen.getByRole('link', { name: 'Notification settings' })).toHaveAttribute(
      'href',
      '/settings/me/notifications',
    );
  });
});

describe('the counts', () => {
  it('the sidebar shows the unread count beside Notifications (D198)', async () => {
    await renderApp('/');
    await findHeading('Home');
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement;
    expect(await within(nav).findByRole('link', { name: /^Notifications\s+4$/ })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });

  it('the bell reads the count again every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { mock } = await renderApp('/');
    await screen.findAllByRole('link', { name: '4 unread notifications' });
    const stored = mock.state.household.notifications.find(
      (n) => n.id === H.notification.tvWarranty,
    );
    if (stored) stored.readAt = null;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(
      (await screen.findAllByRole('link', { name: '5 unread notifications' })).length,
    ).toBeGreaterThan(0);
  });
});

describe('the variants', () => {
  it('a viewer sees the notices and Open, never an action', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'viewer';
    await renderApp('/notifications', { state });
    const drill = within(await row(DRILL));
    expect(drill.queryByRole('button', { name: /returned/ })).toBeNull();
    expect(drill.getByRole('link', { name: `Open ${DRILL}` })).toBeInTheDocument();
    const boiler = within(screen.getByRole('article', { name: BOILER }));
    expect(boiler.queryByRole('button', { name: /Complete/ })).toBeNull();
  });

  it('offline, the actions wait for a connection', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      await renderApp('/notifications');
      const boiler = within(await row(BOILER));
      expect(boiler.getByRole('button', { name: `Complete ${BOILER}` })).toBeDisabled();
      expect(screen.getByText(/Needs a connection/)).toBeInTheDocument();
    } finally {
      // @ts-expect-error back to the prototype's getter
      delete navigator.onLine;
    }
  });

  it('reads right to left in Arabic', async () => {
    await renderApp('/notifications', { locale: 'ar' });
    await row(DRILL);
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('in Arabic, a Latin subject name keeps its own direction: isolated, so a trailing ″ cannot jump sides', async () => {
    await renderApp('/notifications', { locale: 'ar' });
    // The TV warranty's heading ends in the subject's name; the ⁨…⁩ marks keep the ″ with 55.
    const articles = await screen.findAllByRole('article');
    const tv = articles.find((a) => (a.textContent ?? '').includes('Samsung TV'));
    expect(tv?.getAttribute('aria-label')).toContain('\u2068Samsung TV, 55″\u2069');
  });
});

describe('the route loads on demand', () => {
  it('says Needs a connection when its chunk can’t be fetched', () => {
    const chunk = new TypeError(
      'Failed to fetch dynamically imported module: /assets/household/x.js',
    );
    expect(needsConnection(chunk, true)).toBe(true);
    expect(needsConnection(new Error('boom'), false)).toBe(true);
    expect(needsConnection(new Error('boom'), true)).toBe(false);
  });
});
