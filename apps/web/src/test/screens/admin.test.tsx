/** Instance admin: users, sign-up setting, failed jobs, alerts, status. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { setOpsScenario } from '@/api/ops/mock/state';
import { paths } from '@/api/paths';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

describe('Instance admin', () => {
  it('/admin opens Users', async () => {
    const { router } = await renderApp('/admin');
    await screen.findByText('ibrahim@example.com');
    expect(pathOf(router)).toBe('/admin/users');
  });

  it('is for instance admins only', async () => {
    await renderApp('/admin/users', { state: memberScenario() });
    expect(await screen.findByText('For instance admins')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Failed jobs' })).not.toBeInTheDocument();
  });

  it('warns on plain HTTP', async () => {
    await renderApp('/admin/users');
    expect(await screen.findByText('This page is on plain HTTP')).toBeInTheDocument();
  });

  it('Users: badges, no actions on yourself, and disable asks first (D180)', async () => {
    const { user, mock } = await renderApp('/admin/users');
    await screen.findByText('Ibrahim (you)');
    const self = screen.getByText('Ibrahim (you)').closest('li') as HTMLElement;
    expect(within(self).getByText('Instance admin')).toBeInTheDocument();
    expect(screen.getAllByText('Managed account').length).toBe(1);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    const louis = screen.getByText('Louis').closest('li') as HTMLElement;
    await user.click(within(louis).getByRole('button', { name: 'Disable' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Disable Louis?' });
    expect(confirm).toHaveTextContent('They get an email about it.');
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.admin.userAction('u-louis', 'disable'))).toBeTruthy(),
    );
    const ibrahim = screen.getByText('Ibrahim (you)').closest('li') as HTMLElement;
    expect(within(ibrahim).queryByRole('button')).not.toBeInTheDocument();
  });

  it('Users: loading and error', async () => {
    await renderApp('/admin/users', {
      setup: (m) =>
        m.on('GET', paths.admin.users, () => new MockReply(500, { error: 'x', code: 'internal' })),
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it('Sign-up: the toggle saves; an environment value is locked', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const toggle = await screen.findByRole('switch', {
      name: /Anyone with the address can create an account/,
    });
    await user.click(toggle);
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ signupOpen: true }),
    );
    expect(screen.queryByText('Set by the environment')).not.toBeInTheDocument();
  });

  it('Sign-up locked by the environment cannot be switched', async () => {
    const state = ownerScenario();
    state.admin.settings.signupOpen = { value: false, locked: true };
    await renderApp('/admin/settings', { state });
    expect(await screen.findByRole('switch', { name: /Anyone with the address/ })).toBeDisabled();
    expect(screen.getByText('Set by the environment')).toBeInTheDocument();
  });

  it('Barcode lookup: off by default, the switch saves, and the environment locks it', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const toggle = await screen.findByRole('switch', {
      name: /Look up products Kept doesn't know/,
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ barcodeLookup: true }),
    );
    // The scanner's lookup is the same switch.
    expect(mock.state.capture.barcodeLookup).toBe(true);
  });

  it('Barcode lookup and its contact set by the environment are locked', async () => {
    const locked = ownerScenario();
    locked.admin.settings.barcodeLookup = { value: true, locked: true };
    locked.admin.settings.barcodeContact = { value: 'ops@kept.example', locked: true };
    await renderApp('/admin/settings', { state: locked });
    expect(
      await screen.findByRole('switch', { name: /Look up products Kept doesn't know/ }),
    ).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Contact for the lookups' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save contact' })).toBeNull();
  });

  it('Barcode lookup: the contact is an email, saved on its own, and can be cleared', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const contact = await screen.findByRole('textbox', { name: 'Contact for the lookups' });
    await user.type(contact, 'not an email');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(screen.getByText('Enter an email address, or leave it empty.')).toBeInTheDocument();
    await user.clear(contact);
    await user.type(contact, 'bruce@kept.example');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({
        barcodeContact: 'bruce@kept.example',
      }),
    );
    await user.clear(contact);
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ barcodeContact: null }),
    );
  });

  it('Former addresses: add a host name, never a URL or this server, and remove it', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const field = await screen.findByRole('textbox', { name: 'Old host name' });
    await user.type(field, 'https://kept.home.example');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Enter a host name only/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, window.location.hostname);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText("That is this server's own address.")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Kept.Home.Example');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({
        formerHostnames: ['kept.home.example'],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Former addresses' });
    expect(within(list).getByText('kept.home.example')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Remove kept.home.example' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ formerHostnames: [] }),
    );
    expect(
      await screen.findByText('None. Kept answers only at its own address.'),
    ).toBeInTheDocument();
  });

  it('Former addresses: at most ten', async () => {
    const state = ownerScenario();
    state.admin.settings.formerHostnames = Array.from({ length: 10 }, (_, i) => `old${i}.example`);
    await renderApp('/admin/settings', { state });
    expect(await screen.findByRole('textbox', { name: 'Old host name' })).toBeDisabled();
    expect(screen.getByText('At most 10 names. Remove one to add another.')).toBeInTheDocument();
  });

  it('Private addresses: off by default, warned about, and the switch saves', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const toggle = await screen.findByRole('switch', { name: /Allow private addresses/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/machines on its network/)).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() =>
      expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ ssrfAllowPrivate: true }),
    );
    expect(await screen.findByText(/On. An OpenAI-compatible AI provider/)).toBeInTheDocument();
    expect(mock.state.admin.settings.ssrfAllowPrivate).toBe(true);
  });

  it('Failed jobs: never a location (D164), and a job with no message says so', async () => {
    await renderApp('/admin/jobs');
    await screen.findByText('repair-orphans');
    expect(screen.getByText('It left no error message.')).toBeInTheDocument();
    expect(screen.queryByText(/Home ·/)).not.toBeInTheDocument();
  });

  it('Failed jobs: retry and discard; empty when none', async () => {
    const { user, mock } = await renderApp('/admin/jobs');
    await screen.findByText('notify-owner-new-member');
    expect(screen.getByText('SMTP connection refused (127.0.0.1:1025)')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement);
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.admin.failedJobAction('job-1', 'retry'))).toBeTruthy(),
    );
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Discard this job?' })).getByRole('button', {
        name: 'Discard',
      }),
    );
    expect(await screen.findByText('No failed jobs')).toBeInTheDocument();
  });

  it('Alerts: open first, then resolved', async () => {
    await renderApp('/admin/alerts');
    await screen.findByRole('heading', { name: 'Open' });
    expect(screen.getAllByText('Failed jobs are rising').length).toBe(2);
    expect(screen.getByRole('heading', { name: 'Resolved' })).toBeInTheDocument();
    expect(screen.getByText(/raised 3 times/)).toBeInTheDocument();
  });

  it('Alerts: nothing needs you', async () => {
    const state = ownerScenario();
    state.admin.alerts = [];
    await renderApp('/admin/alerts', { state });
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
  });

  it('Status: asks for the recovery kit until it is acknowledged (D193)', async () => {
    await renderApp('/admin/status');
    expect(await screen.findByText('Keep the recovery kit somewhere else')).toBeInTheDocument();
    expect(screen.getByText('Answering')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1 open' })).toHaveAttribute('href', '/admin/alerts');
  });

  it('Status: the recovery kit is acknowledged after a confirm (D193)', async () => {
    // A kit never downloaded (step 8's mock: no backup configured, so nothing stale).
    const state = ownerScenario();
    setOpsScenario(state, 'unconfigured');
    const { user, mock } = await renderApp('/admin/status', { state });
    await screen.findByText('Keep the recovery kit somewhere else');
    await user.click(screen.getByRole('button', { name: "I've kept it somewhere else" }));
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Have you kept the recovery kit?' }),
      ).getByRole('button', { name: "I've kept it" }),
    );
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.admin.recoveryKitAcknowledge)).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.queryByText('Keep the recovery kit somewhere else')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Kept safe')).toBeInTheDocument();
  });

  it('Status: says when mail is not configured', async () => {
    const state = ownerScenario();
    state.admin.status.mail = { configured: false };
    await renderApp('/admin/status', { state });
    expect(await screen.findByText("Mail isn't configured")).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('Alerts: an open alert shows its latest figures', async () => {
    await renderApp('/admin/alerts');
    await screen.findByRole('heading', { name: 'Open' });
    expect(screen.getByText('12 failed in the last hour.')).toBeInTheDocument();
  });

  it('Alerts: reminders not scanned says when the last check finished (D166)', async () => {
    const state = ownerScenario();
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    state.admin.alerts = [
      {
        id: 'al-r',
        kind: 'reminders_not_scanned',
        firstAt: at,
        lastAt: at,
        count: 1,
        resolvedAt: null,
        payload: { lastOkAt: at, lastRunAt: at },
      },
      {
        id: 'al-r0',
        kind: 'reminders_not_scanned',
        firstAt: at,
        lastAt: at,
        count: 1,
        resolvedAt: null,
        payload: { lastOkAt: null, lastRunAt: at },
      },
    ];
    await renderApp('/admin/alerts', { state });
    expect((await screen.findAllByText('Reminders have stopped going out')).length).toBe(2);
    expect(screen.getByText(/^Kept last checked for due reminders /)).toBeInTheDocument();
    expect(screen.getByText(/^No check for due reminders has finished yet/)).toBeInTheDocument();
  });

  it('Status: the reminder scan, and says so when it stopped (D166)', async () => {
    await renderApp('/admin/status');
    expect(await screen.findByText(/^Checked .* · 3 new$/)).toBeInTheDocument();
    expect(screen.queryByText('Reminders have stopped going out')).toBeNull();

    const state = ownerScenario();
    state.admin.status.reminders = {
      lastRunAt: new Date().toISOString(),
      lastOkAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      occurrences: 0,
      durationMs: 300,
    };
    await renderApp('/admin/status', { state });
    expect(await screen.findByText('Reminders have stopped going out')).toBeInTheDocument();
  });

  it('Status: no reminder check yet', async () => {
    const state = ownerScenario();
    state.admin.status.reminders = null;
    await renderApp('/admin/status', { state });
    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByText(/^No check for due reminders has finished yet/)).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    await renderApp('/admin/status', { locale: 'ar' });
    expect(await findHeading('إدارة الخادم')).toBeInTheDocument();
    expect(await screen.findByText('١ مفتوحة')).toBeInTheDocument();
    expectLogicalOnly();
  });
});
