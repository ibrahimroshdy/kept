/**
 * Me → Notifications (plan T25; D29, D30, D139, D142, D193; step-4 Q6, Q8, Q23, Q35): the
 * channels (email, this device's push asked for only on Enable, the iPhone rule, "Push needs
 * HTTPS", other devices, webhooks with their secret shown once), the kinds × channels table per
 * location with a viewer's Membership only, the digest and quiet hours, the calendar feed and the
 * AI monthly summary. Every browser push API is a stub: nothing asks a real browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
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
      screen.getByRole('switch', { name: 'Schedules due by Webhook in Home' }),
    ).toBeInTheDocument();
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

describe('what each location tells you', () => {
  it('a kind × channel switch saves only the change, and the row stops reading Default', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    const home = within(await screen.findByRole('region', { name: 'Home' }));
    const row = home.getByRole('rowheader', { name: /Schedules due/ });
    expect(within(row).getByText('Default')).toBeInTheDocument();
    const email = home.getByRole('switch', { name: 'Schedules due by Email in Home' });
    expect(email).toBeChecked();
    await user.click(email);
    await waitFor(() => expect(email).not.toBeChecked());
    expect(mock.state.household.preferences).toEqual([
      { locationId: IDS.home, kind: 'schedule', channel: 'email', enabled: false },
    ]);
    expect(
      within(home.getByRole('rowheader', { name: /Schedules due/ })).queryByText('Default'),
    ).toBeNull();
  });

  it("a viewer's location lists only Membership (Q8)", async () => {
    const state = ownerScenario();
    const garage = state.locations.find((l) => l.id === IDS.garage);
    if (garage) garage.role = 'viewer';
    await renderApp(PATH, { state });
    await channels();
    const card = within(await screen.findByRole('region', { name: 'Garage' }));
    expect(
      card.getAllByRole('rowheader').map((r) => r.textContent?.replace('Default', '')),
    ).toEqual(['Members joining and leaving']);
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

  it('the AI monthly summary is an account-level switch (Q35)', async () => {
    const { user, mock } = await renderApp(PATH);
    await channels();
    const summary = screen.getByRole('switch', { name: 'AI monthly summary by email' });
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
