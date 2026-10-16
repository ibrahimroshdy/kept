/**
 * "Print inventory" (D201, task 32), against the mock server: the filter sheet on the location
 * page and on Settings → Account, the request it posts, the run's progress, the download once it
 * is done, a failure with Try again, the hourly limit, a viewer, and offline. 1.10.5 (#141): the
 * email-only options locked, with their reason, where mail can't go out.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { reportSchedulesOf } from '@/api/inventory/mock/reports';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { ReportRun } from '@/api/inventory/types';
import { IDS, type MockState, memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/kit';
import { MAIL_SETUP_DOCS } from '@/components/setup-code-help';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => vi.restoreAllMocks());

const RUN = '01926f00-0000-7000-8000-00000000e201';
const PDF = 'https://files.kept.test/r/report.pdf?sig=abc';

const run = (patch: Partial<ReportRun>): ReportRun => ({
  id: RUN,
  status: 'running',
  scope: { locationId: IDS.home },
  progress: { done: 0, total: 4 },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...patch,
});

function asViewer(state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = 'viewer';
  return state;
}

async function openSheet(user: Awaited<ReturnType<typeof renderApp>>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Print inventory' }));
  return screen.findByRole('dialog', { name: 'Print inventory' });
}

describe('Print inventory (D201)', () => {
  it('posts the location, the chosen places and the switches, then downloads the PDF', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { user, mock } = await renderApp(`/loc/${IDS.home}`, {
      setup: (m) => {
        m.on(
          'POST',
          p.reportsInventory,
          () => new MockReply(202, { id: RUN, status: 'queued', expiresAt: run({}).expiresAt }),
        );
        let reads = 0;
        m.on('GET', p.report(':id'), () => {
          reads += 1;
          return reads === 1
            ? run({ progress: { done: 2, total: 4 } })
            : run({ status: 'done', progress: { done: 4, total: 4 }, fileUrl: PDF, bytes: 9000 });
        });
      },
    });
    await findHeading('Home');
    const dialog = await openSheet(user);
    // Everything, until something is chosen.
    const places = within(dialog).getByRole('button', { name: /Places/ });
    expect(places).toHaveTextContent('All');
    await user.click(places);
    await user.click(await within(dialog).findByRole('row', { name: /Living room/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(within(dialog).getByRole('button', { name: /Places/ })).toHaveTextContent('Living room');
    await user.click(within(dialog).getByRole('switch', { name: 'QR codes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.reportsInventory)?.body).toEqual({
        scope: { locationId: IDS.home },
        filters: {
          placeIds: [INV_IDS.place.livingRoom],
          includeEnded: false,
          includeTrashed: false,
        },
        include: { qr: true },
      }),
    );
    // The run's progress, then the download: started once by itself, and a link to press.
    expect(
      await within(dialog).findByRole('progressbar', { name: 'Making the PDF' }),
    ).toHaveAttribute('aria-valuetext', '2 of 4');
    expect(
      await within(dialog).findByText('Your PDF is ready', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('href', PDF);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).href).toBe(PDF);
  });

  it('says why a run failed, and Try again makes a new one', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`, {
      setup: (m) =>
        m.on('GET', p.report(':id'), () =>
          run({ status: 'failed', error: 'too_many_things', progress: { done: 0, total: 0 } }),
        ),
    });
    await findHeading('Home');
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    expect(await within(dialog).findByText("Couldn't make the PDF")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/A report holds at most 2,000 things\. Choose some places/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === 'POST' && c.path === p.reportsInventory),
      ).toHaveLength(2),
    );
  });

  it('says so past the hourly limit', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`, {
      setup: (m) =>
        m.on(
          'POST',
          p.reportsInventory,
          () =>
            new MockReply(429, {
              error: 'At most 5 reports an hour. Try again later.',
              code: 'rate_limited',
              retryAfter: 600,
            }),
        ),
    });
    await findHeading('Home');
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    expect(
      await within(dialog).findByText('Kept makes at most five reports an hour. Try again later.'),
    ).toBeInTheDocument();
  });

  it('is there for a viewer too (the server leaves money out)', async () => {
    await renderApp(`/loc/${IDS.home}`, { state: asViewer() });
    await findHeading('Home');
    expect(await screen.findByRole('button', { name: 'Print inventory' })).toBeEnabled();
  });

  it('Settings → Account makes a report of the whole account', async () => {
    const { user, mock } = await renderApp('/settings/account/types');
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole('switch', { name: 'Include ended things' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.reportsInventory)?.body).toEqual({
        scope: { accountId: INV_IDS.account.ibrahim },
        filters: { includeEnded: true, includeTrashed: false },
        include: { qr: false },
      }),
    );
    // The mock's run moves on each time it's read.
    expect(await within(dialog).findByRole('progressbar')).toBeInTheDocument();
  });

  it('offline, the button is disabled and says why', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const button = await screen.findByRole('button', { name: 'Print inventory' });
    expect(button).toBeDisabled();
    // The reason sits beside the button (the page's other sections say it too, T23).
    expect(
      within(button.parentElement as HTMLElement).getByText('Needs a connection'),
    ).toBeInTheDocument();
  });

  it('in Arabic, the sheet keeps to logical CSS', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`, { locale: 'ar' });
    await user.click(await screen.findByRole('button', { name: 'اطبع الجرد' }));
    await screen.findByRole('dialog', { name: 'اطبع الجرد' });
    expectLogicalOnly();
  });
});

describe('Emailed and scheduled reports (D228)', () => {
  it('emails the PDF too, and keeps a monthly schedule of the location', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole('switch', { name: 'Email it to me' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Every month' }));
    expect(within(dialog).getByText(/Stop it in Settings/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.reportSchedules)?.body).toEqual({
        locationId: IDS.home,
        kind: 'inventory',
        cadence: 'monthly',
      }),
    );
    expect(mock.lastCall('POST', p.reportsInventory)?.body).toMatchObject({ email: true });
    expect(
      await within(dialog).findByText("It's also on its way to your email."),
    ).toBeInTheDocument();
  });

  it('lists a schedule in Settings → Me → Notifications, and stops it after a confirm', async () => {
    const state = ownerScenario();
    reportSchedulesOf(state).push({
      id: '01926f00-0000-7000-8000-00000000e301',
      locationId: IDS.home,
      locationName: 'Home',
      kind: 'inventory',
      cadence: 'weekly',
      lastRunOn: '2026-10-12',
      lastError: 'rate_limited',
    });
    const { user, mock } = await renderApp('/settings/me/notifications', { state });
    const section = (await screen.findByRole('heading', { name: 'Scheduled reports' })).closest(
      'section',
    ) as HTMLElement;
    expect(section).toHaveTextContent('Inventory of Home');
    expect(section).toHaveTextContent('Every Monday');
    expect(section).toHaveTextContent("Skipped: you'd made five reports that hour.");
    await user.click(within(section).getByRole('button', { name: 'Stop' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Scheduled reports' })).toBeNull(),
    );
    expect(
      mock.lastCall('DELETE', p.reportSchedule('01926f00-0000-7000-8000-00000000e301')),
    ).toBeDefined();
  });
});

describe("Email-only options lock when mail can't go out (#141)", () => {
  const mailOff = (state: MockState) => {
    state.household.settings.smtpConfigured = false;
    return state;
  };
  const LINE = "Email isn't set up on this server.";

  it('with mail set up, nothing is locked', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const dialog = await openSheet(user);
    expect(within(dialog).getByRole('switch', { name: 'Email it to me' })).toBeEnabled();
    expect(within(dialog).getByRole('radio', { name: 'Every week' })).toBeEnabled();
    expect(within(dialog).queryByText(LINE)).toBeNull();
  });

  it('without mail, an owner sees both locked, why, and Set up email', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`, { state: mailOff(ownerScenario()) });
    await findHeading('Home');
    const dialog = await openSheet(user);
    const email = within(dialog).getByRole('switch', { name: 'Email it to me' });
    await waitFor(() => expect(email).toBeDisabled());
    expect(email).toHaveAccessibleDescription(`${LINE} Set up email`);
    for (const name of ['Never', 'Every week', 'Every month'])
      expect(within(dialog).getByRole('radio', { name })).toBeDisabled();
    expect(
      within(dialog).getByRole('radiogroup', { name: 'Send it again' }),
    ).toHaveAccessibleDescription(`${LINE} Set up email`);
    expect(within(dialog).getByRole('link', { name: 'Set up email' })).toHaveAttribute(
      'href',
      MAIL_SETUP_DOCS,
    );
    expect(within(dialog).queryByText('Ask the owner to set up email.')).toBeNull();
    // The PDF itself still works, without email.
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() => expect(mock.lastCall('POST', p.reportsInventory)).toBeDefined());
    expect(mock.lastCall('POST', p.reportsInventory)?.body).not.toHaveProperty('email');
    expect(mock.lastCall('PUT', p.reportSchedules)).toBeUndefined();
  });

  it('a member is told to ask the owner, with no link', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`, { state: mailOff(memberScenario()) });
    await findHeading('Home');
    const dialog = await openSheet(user);
    expect(await within(dialog).findByText('Ask the owner to set up email.')).toBeInTheDocument();
    expect(within(dialog).getByText(LINE)).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Set up email' })).toBeNull();
    expect(within(dialog).getByRole('switch', { name: 'Email it to me' })).toBeDisabled();
  });

  it('an account with no email address gets the same lock', async () => {
    const state = ownerScenario();
    state.me.user.email = null;
    const { user } = await renderApp(`/loc/${IDS.home}`, { state });
    await findHeading('Home');
    const dialog = await openSheet(user);
    const email = within(dialog).getByRole('switch', { name: 'Email it to me' });
    expect(email).toBeDisabled();
    expect(email).toHaveAccessibleDescription('Add an email address to your account.');
    expect(within(dialog).queryByText(LINE)).toBeNull();
  });

  it("says the server's refusal in a sentence", async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`, {
      setup: (m) =>
        m.on(
          'POST',
          p.reportsInventory,
          () => new MockReply(409, { error: LINE, code: 'mail_not_configured' }),
        ),
    });
    await findHeading('Home');
    const dialog = await openSheet(user);
    await user.click(within(dialog).getByRole('switch', { name: 'Email it to me' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make the PDF' }));
    expect(await within(dialog).findByText(LINE)).toBeInTheDocument();
  });

  it('in Arabic, the locked sheet keeps to logical CSS', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`, {
      locale: 'ar',
      state: mailOff(ownerScenario()),
    });
    await user.click(await screen.findByRole('button', { name: 'اطبع الجرد' }));
    const dialog = await screen.findByRole('dialog', { name: 'اطبع الجرد' });
    await waitFor(() => expect(within(dialog).getAllByRole('switch').at(-1)).toBeDisabled());
    expectLogicalOnly();
  });
});
