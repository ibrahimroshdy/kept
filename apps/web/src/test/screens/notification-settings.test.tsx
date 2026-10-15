/**
 * Me → Notifications (plan T25; D29, D30, D139, D142, D193; step-4 Q6, Q8, Q23, Q35): the
 * channels (email, this device's push asked for only on Enable, the iPhone rule, "Push needs
 * HTTPS", other devices, webhooks with their secret shown once), what reaches you (D239: one
 * table, all locations or one, inherited cells and Reset, paused kinds, a viewer's Membership
 * only, the AI monthly summary in it), the digest and quiet hours and the calendar feed. Every
 * browser push API is a stub: nothing asks a real browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { PUSH_ID_KEY } from '@/pwa/push';
import { findHeading, renderApp } from '../app';

const H = HOUSEHOLD_IDS;
const PATH = '/settings/me/notifications';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const channels = async () => {
  await findHeading('Notifications');
  return screen.findByRole('heading', { name: 'How Kept reaches you' }, { timeout: 3000 });
};

function stubPushBrowser(permission: NotificationPermission = 'default') {
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  vi.stubGlobal('Notification', { permission, requestPermission });
  vi.stubGlobal('PushManager', function PushManager() {});
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.example/send/abc',
      keys: { p256dh: 'BPk', auth: 'au' },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    subscribe: vi.fn(async () => subscription),
    getSubscription: vi.fn(async () => subscription),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  return { requestPermission, pushManager };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // @ts-expect-error jsdom has none of its own
  delete navigator.serviceWorker;
});

describe('channels', () => {
  it('shows the email address, and says when mail is off on the server', async () => {
    await renderApp(PATH, {
      setup: (mock) => {
        mock.state.household.settings.smtpConfigured = false;
      },
    });
    await channels();
    expect(screen.getByText('ibrahim@example.com')).toBeInTheDocument();
    expect(
      screen.getByText("Mail isn't configured on this server, so no email goes out yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a test email' })).toBeNull();
  });

  it('asks for the notification permission only when Enable is tapped (D139)', async () => {
    const { requestPermission, pushManager } = stubPushBrowser();
    const { user, mock } = await renderApp(PATH);
    await channels();
    const enable = await screen.findByRole('button', { name: 'Enable' });
    expect(requestPermission).not.toHaveBeenCalled();
    await user.click(enable);
    expect(await screen.findByText('Notifications are on for this device')).toBeInTheDocument();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    const subs = mock.state.household.channels.find((c) => c.kind === 'webpush')?.subscriptions;
    expect(subs).toHaveLength(2);
    expect(await screen.findByText('Push is on')).toBeInTheDocument();
    expect(localStorage.getItem(PUSH_ID_KEY)).toBe(subs?.[1]?.id);
  });

  it('this device on: Test and Turn off; the other device listed apart', async () => {
    stubPushBrowser('granted');
    localStorage.setItem(PUSH_ID_KEY, H.pushSubscription.phone);
    const { user, mock } = await renderApp(PATH);
    await channels();
    expect(await screen.findByText('Push is on')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove iPhone' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(
        mock.state.household.channels.find((c) => c.kind === 'webpush')?.subscriptions,
      ).toHaveLength(0),
    );
    expect(localStorage.getItem(PUSH_ID_KEY)).toBeNull();
  });

  it('another device: Test and Remove, after a confirm', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(
      await screen.findByRole('button', { name: 'Send a test notification to iPhone' }),
    );
    expect(await screen.findByText('Test sent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove iPhone' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove iPhone' })).toBeNull());
    expect(
      mock.state.household.channels.find((c) => c.kind === 'webpush')?.subscriptions,
    ).toHaveLength(0);
  });

  it('on an iPhone in the browser, says the installed app is needed and offers install', async () => {
    stubPushBrowser();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
    const { user } = await renderApp(PATH);
    await channels();
    expect(
      await screen.findByText(/On iPhone and iPad, notifications work only from the installed app/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'How to install' }));
    expect(
      await screen.findByRole('dialog', { name: 'Install Kept on your phone' }),
    ).toBeInTheDocument();
  });

  it('over plain HTTP: Push needs HTTPS (D193)', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    try {
      await renderApp(PATH);
      await channels();
      expect(await screen.findByText(/^Push needs HTTPS\./)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    } finally {
      // @ts-expect-error jsdom has none of its own
      delete window.isSecureContext;
    }
  });

  it('adds a webhook and shows its secret once', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(await screen.findByRole('button', { name: 'Add a webhook' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add a webhook' }));
    await user.type(sheet.getByRole('textbox', { name: 'Address' }), 'https://hooks.example/kept');
    await user.type(sheet.getByRole('textbox', { name: 'Label' }), 'Home Assistant');
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    expect(await sheet.findByText('whsec_mock_2HX9RB5MT0QD7KQ4MZ')).toBeInTheDocument();
    expect(sheet.getByRole('button', { name: 'Copy the secret' })).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('whsec_mock_2HX9RB5MT0QD7KQ4MZ')).toBeNull();
    expect(screen.getByText('hooks.example')).toBeInTheDocument();
    expect(mock.state.household.channels.filter((c) => c.kind === 'webhook')).toHaveLength(1);
    // A webhook adds its column to the table.
    expect(
      screen.getByRole('switch', { name: 'Schedules due by Webhook in all locations' }),
    ).toBeInTheDocument();
  });

  it('adds an ntfy channel: settings sent once, never shown, and its column (D227)', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(await screen.findByRole('button', { name: 'Add ntfy' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add ntfy' }));
    expect(sheet.getByRole('textbox', { name: 'Server' })).toHaveValue('https://ntfy.sh');
    await user.type(sheet.getByRole('textbox', { name: 'Topic' }), 'kept-home-7f3k');
    await user.type(sheet.getByRole('textbox', { name: 'Access token' }), 'tk_abc');
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.lastCall('POST', '/api/v1/me/channels')?.body).toEqual({
      kind: 'ntfy',
      server: 'https://ntfy.sh',
      topic: 'kept-home-7f3k',
      token: 'tk_abc',
    });
    expect(screen.getByText('ntfy.sh')).toBeInTheDocument();
    expect(screen.queryByText('kept-home-7f3k')).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Schedules due by ntfy in all locations' }),
    ).toBeInTheDocument();
  });

  it('adds a Telegram channel, and says what is wrong with a bad token', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(await screen.findByRole('button', { name: 'Add Telegram' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add Telegram' }));
    await user.type(sheet.getByRole('textbox', { name: 'Bot token' }), 'nope');
    await user.type(sheet.getByRole('textbox', { name: 'Chat ID' }), '42');
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    expect(await sheet.findByText(/isn't valid/)).toBeInTheDocument();
    await user.clear(sheet.getByRole('textbox', { name: 'Bot token' }));
    await user.type(sheet.getByRole('textbox', { name: 'Bot token' }), `123456:${'A'.repeat(35)}`);
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.state.household.channels.filter((c) => c.kind === 'telegram')).toHaveLength(1);
    expect(screen.getByText('api.telegram.org')).toBeInTheDocument();
  });

  it('adds an Apprise channel when the server has Apprise, and hides it when not (D232)', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(await screen.findByRole('button', { name: 'Add Apprise' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add Apprise' }));
    await user.type(
      sheet.getByRole('textbox', { name: 'Apprise URLs' }),
      'discord://id/token mailto://me@example.org',
    );
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.lastCall('POST', '/api/v1/me/channels')?.body).toEqual({
      kind: 'apprise',
      urls: 'discord://id/token mailto://me@example.org',
    });
    expect(screen.getByText('discord, mailto')).toBeInTheDocument();
    expect(screen.queryByText(/discord:\/\/id/)).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Schedules due by Apprise in all locations' }),
    ).toBeInTheDocument();
  });

  it('offers no Apprise when the server has none', async () => {
    await renderApp(PATH, {
      setup: (mock) => {
        mock.state.household.settings.apprise = { available: false };
      },
    });
    await channels();
    expect(screen.queryByRole('button', { name: 'Add Apprise' })).toBeNull();
  });

  it('refuses a webhook address that is not a URL', async () => {
    const { user } = await renderApp(PATH);
    await channels();
    await user.click(await screen.findByRole('button', { name: 'Add a webhook' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Add a webhook' }));
    await user.type(sheet.getByRole('textbox', { name: 'Address' }), 'hooks');
    await user.click(sheet.getByRole('button', { name: 'Add' }));
    expect(
      await sheet.findByText('Enter the full address, starting with https://'),
    ).toBeInTheDocument();
  });
});

/** jsdom has no matchMedia: the queries listed match (the desktop table). */
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

/** Picks a location (or All locations) in the table's Where combobox. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  const where = screen.getByRole('combobox', { name: 'Where' });
  await user.clear(where);
  await user.type(where, name);
  await user.click(await screen.findByRole('option', { name }));
}

describe('what reaches you (D239)', () => {
  it('All locations: a switch stores one choice with no location', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    const email = await screen.findByRole('switch', {
      name: 'Schedules due by Email in all locations',
    });
    expect(email).toBeChecked();
    await user.click(email);
    await waitFor(() => expect(email).not.toBeChecked());
    expect(mock.state.household.preferences).toEqual([
      { locationId: null, kind: 'schedule', channel: 'email', enabled: false },
    ]);
  });

  it('one location inherits, marks what is set there, and resets to all locations', async () => {
    const { user, mock } = await renderApp(PATH, {
      setup: (m) => {
        m.state.household.preferences = [
          { locationId: null, kind: 'schedule', channel: 'email', enabled: false },
        ];
      },
    });
    await channels();
    await screen.findByRole('switch', { name: 'Schedules due by Email in all locations' });
    await pick(user, 'Home');
    const email = await screen.findByRole('switch', { name: 'Schedules due by Email in Home' });
    expect(email).not.toBeChecked();
    const reset = screen.getByRole('button', { name: 'Reset this location to all locations' });
    expect(reset).toBeDisabled();
    await user.click(email);
    const set = await screen.findByRole('switch', {
      name: 'Schedules due by Email in Home, set for this location only',
    });
    expect(set).toBeChecked();
    expect(mock.state.household.preferences).toContainEqual({
      locationId: IDS.home,
      kind: 'schedule',
      channel: 'email',
      enabled: true,
    });
    await user.click(reset);
    await waitFor(() =>
      expect(mock.state.household.preferences).toEqual([
        { locationId: null, kind: 'schedule', channel: 'email', enabled: false },
      ]),
    );
    expect(
      await screen.findByRole('switch', { name: 'Schedules due by Email in Home' }),
    ).not.toBeChecked();
  });

  it('a kind whose module is off there is paused, not hidden (D113)', async () => {
    const { user } = await renderApp(PATH);
    await channels();
    await screen.findByRole('switch', { name: 'Warranties running out by Email in all locations' });
    await pick(user, 'Garage');
    expect(
      await screen.findAllByText('Paused: Receipts and warranties is off here.'),
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole('switch', { name: /^Warranties running out by .* in Garage/ }),
    ).toBeNull();
    // Lending is on in the Garage.
    expect(screen.getByRole('switch', { name: 'Overdue loans by Email in Garage' })).toBeChecked();
  });

  it("a viewer's location offers only Membership (Q8)", async () => {
    const state = ownerScenario();
    const garage = state.locations.find((l) => l.id === IDS.garage);
    if (garage) garage.role = 'viewer';
    const { user } = await renderApp(PATH, { state });
    await channels();
    await screen.findByRole('switch', { name: 'Overdue loans by Email in all locations' });
    await pick(user, 'Garage');
    expect(
      await screen.findByRole('switch', { name: 'Members joining and leaving by Email in Garage' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Viewers hear only about members.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('switch', { name: /^Overdue loans by .* in Garage/ })).toBeNull();
  });

  it('In Kept off silences the kind: its other switches wait (Q10)', async () => {
    const { user } = await renderApp(PATH);
    await channels();
    const inapp = await screen.findByRole('switch', {
      name: 'Low stock by In Kept in all locations',
    });
    await user.click(inapp);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Low stock by Email in all locations' }),
      ).toBeDisabled(),
    );
    expect(screen.getByText('In Kept is off, so nothing is sent.')).toBeInTheDocument();
  });

  it('notices go only to Kept and email; a channel column appears once you have one', async () => {
    await renderApp(PATH);
    await channels();
    await screen.findByRole('switch', { name: 'AI monthly summary by Email in all locations' });
    expect(
      screen.queryByRole('switch', { name: 'AI monthly summary by Push in all locations' }),
    ).toBeNull();
    expect(screen.queryByRole('switch', { name: /by Telegram in/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add more channels' })).toHaveAttribute(
      'href',
      '#channels',
    );
  });

  it('on a desktop, one table grouped by kind; on a phone, labelled switches under each kind', async () => {
    media(['(min-width: 768px)']);
    const { unmount } = await renderApp(PATH);
    await channels();
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(
      expect.arrayContaining(['Due dates', 'Lending', 'Stock', 'People', 'AI', 'In Kept', 'Email']),
    );
    unmount();
    vi.unstubAllGlobals();
    await renderApp(PATH);
    await channels();
    await screen.findByRole('switch', { name: 'Low stock by Push in all locations' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('region', { name: 'Due dates' })).toBeInTheDocument();
  });
});

describe('digest, quiet hours, the calendar feed and the AI summary', () => {
  it('turns quiet hours on and saves both ends', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    expect(screen.getByText(/Africa\/Cairo/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Quiet hours' }));
    await user.click(save);
    await waitFor(() => expect(mock.state.household.settings.quietFrom).toBe('23:00'));
    expect(mock.state.household.settings.quietTo).toBe('07:00');
  });

  it('picks the digest time from a list, never the OS picker', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    await user.click(screen.getByRole('button', { name: /Daily digest/ }));
    await user.click(await screen.findByRole('option', { name: '07:30' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.state.household.settings.digestTime).toBe('07:30'));
  });

  it('creates a calendar link shown once, and revokes one', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    expect(await screen.findByText(/^Last fetched /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create a link' }));
    expect(await screen.findByText(/\/cal\/mock-.*\.ics$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the link' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/\/cal\/mock-/)).toBeNull();
    const links = within(screen.getByRole('list', { name: 'Calendar links' }));
    const [first] = links.getAllByRole('button', { name: /^Revoke the link made/ });
    await user.click(first as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(mock.state.household.calendarFeeds.filter((f) => f.revokedAt)).toHaveLength(1),
    );
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
  });

  it('the AI monthly summary is an account-level switch in the table (Q35)', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    const summary = await screen.findByRole('switch', {
      name: 'AI monthly summary by Email in all locations',
    });
    expect(summary).toBeChecked();
    await user.click(summary);
    await waitFor(() => expect(summary).not.toBeChecked());
    expect(mock.state.household.preferences).toContainEqual({
      locationId: null,
      kind: 'ai_summary',
      channel: 'email',
      enabled: false,
    });
  });

  it('reads right to left in Arabic', async () => {
    await renderApp(PATH, { locale: 'ar' });
    await screen.findAllByRole('switch', {}, { timeout: 3000 });
    expect(document.documentElement.dir).toBe('rtl');
  });
});
