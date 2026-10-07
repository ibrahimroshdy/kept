/** Members and roles, Invite, Settings → Me (sessions, two-factor enrolment). */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { firstRunScenario, IDS, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { paths } from '@/api/paths';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const members = `/settings/location/${IDS.home}/members`;
const invite = `/settings/location/${IDS.home}/invite`;

/** The rows render twice (phone list and desktop table, CSS picks one): take the phone copy. */
const phoneRow = (name: string) => screen.getByRole('button', { name: `Manage ${name}` });

describe('Members and roles', () => {
  it('loads', async () => {
    await renderApp(members, {
      setup: (m) => m.hang('GET', paths.locationMembers(':id')),
    });
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('says when it could not load', async () => {
    await renderApp(members, {
      setup: (m) =>
        m.on(
          'GET',
          paths.locationMembers(':id'),
          () => new MockReply(500, { error: 'x', code: 'internal' }),
        ),
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it('groups people by role, marks expiring and managed members, lists pending invites', async () => {
    await renderApp(members);
    expect(await screen.findByRole('heading', { name: 'Admins' })).toBeInTheDocument();
    const groups = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(groups).toEqual(['Owner', 'Admins', 'Members', 'Viewers', 'Pending invites']);
    expect(screen.getAllByText(/^Until /).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Managed account · by Alfred/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/No two-factor yet, so Home is hidden for them/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Member invite')).toBeInTheDocument();
    // The owner's row has no actions.
    expect(screen.queryByRole('button', { name: 'Manage Ibrahim' })).not.toBeInTheDocument();
  });

  it('changes a role and sets an end date from the row sheet', async () => {
    const { user, mock } = await renderApp(members);
    await screen.findByRole('heading', { name: 'Admins' });
    await user.click(phoneRow('Alfred'));
    const dialog = screen.getByRole('dialog', { name: 'Alfred' });
    // The owner may grant admin (D48).
    expect(within(dialog).getByRole('radio', { name: 'Admin' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Viewer' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Until a date' }));
    // With the date field open, query by text: jsdom can't name React Aria's date segments.
    const save = () => within(dialog).getByText('Save').closest('button') as HTMLElement;
    expect(within(dialog).getByText('Choose the last day.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.click(within(dialog).getByText('No end date'));
    await user.click(save());
    await waitFor(() =>
      expect(mock.lastCall('PATCH', paths.locationMember(IDS.home, 'm-alfred'))?.body).toEqual({
        role: 'viewer',
        expiresAt: null,
      }),
    );
    // The server refuses a PATCH without If-Match (§7.7).
    expect(
      mock.lastCall('PATCH', paths.locationMember(IDS.home, 'm-alfred'))?.headers['if-match'],
    ).toBe('3');
  });

  it('removes someone after a confirm', async () => {
    const { user, mock } = await renderApp(members);
    await screen.findByRole('heading', { name: 'Admins' });
    await user.click(phoneRow('Talia'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove Talia from Home?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mock.lastCall('DELETE', paths.locationMember(IDS.home, 'm-talia'))).toBeTruthy(),
    );
  });

  it('an admin can’t manage other admins, and can’t grant admin (D48)', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'admin';
    for (const m of state.members[IDS.home]?.members ?? []) m.isYou = m.displayName === 'Bruce';
    const { user } = await renderApp(members, { state });
    await screen.findByRole('heading', { name: 'Admins' });
    expect(screen.queryByRole('button', { name: 'Manage Bruce' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Only the owner changes admins').length).toBeGreaterThan(0);
    await user.click(phoneRow('Alfred'));
    expect(
      within(screen.getByRole('dialog')).queryByRole('radio', { name: 'Admin' }),
    ).not.toBeInTheDocument();
    // Admins, members and viewers can leave; the owner can't.
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Leave this location')).toBeInTheDocument();
  });

  it('revokes a pending invite', async () => {
    const { user, mock } = await renderApp(members);
    await screen.findByText('Member invite');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Revoke this invite?' })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() =>
      expect(mock.lastCall('DELETE', paths.locationInvite(IDS.home, 'inv-1'))).toBeTruthy(),
    );
    expect(await screen.findByText('No pending invites')).toBeInTheDocument();
  });

  it('adds a managed account and shows the one-time code', async () => {
    const { user, mock } = await renderApp(members);
    await screen.findByRole('heading', { name: 'Admins' });
    await user.click(screen.getByRole('button', { name: 'Add someone without email' }));
    const dialog = screen.getByRole('dialog', { name: 'Add someone without email' });
    await user.type(within(dialog).getByLabelText('Name'), 'Harvey');
    await user.type(within(dialog).getByLabelText('Username'), 'Y');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(
      within(dialog).getByText(
        '3 to 32 characters: lowercase letters, digits, dot, dash or underscore.',
      ),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Username'), 'usuf');
    await user.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('dialog', { name: 'Give Harvey this code' })).toHaveTextContent(
      'K7Q2M9TX',
    );
    expect(mock.lastCall('POST', paths.locationManagedAccounts(IDS.home))?.body).toEqual({
      displayName: 'Harvey',
      username: 'yusuf',
      role: 'member',
    });
  });

  it('renders in Arabic', async () => {
    await renderApp(members, { locale: 'ar' });
    expect(await screen.findByRole('heading', { name: 'المشرفون' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});

describe('Invite (D33, D193)', () => {
  it('creates a link with a QR code beside Copy link', async () => {
    const { user, mock } = await renderApp(invite);
    await findHeading('Invite to Home');
    expect(screen.getByRole('radio', { name: 'Member' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Viewer' }));
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for the invite link' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/invite#K7q2Rm9TxVd4$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.locationInvites(IDS.home))?.body).toEqual({
      role: 'viewer',
      membershipExpiresAt: null,
    });
  });

  it('an end date is required once chosen', async () => {
    const { user } = await renderApp(invite);
    await findHeading('Invite to Home');
    await user.click(screen.getByRole('radio', { name: 'Until a date' }));
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeDisabled();
    expect(screen.getByText('Choose the last day.')).toBeInTheDocument();
  });

  it('an admin whose own access ends can only invite until then (D180)', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) {
      home.role = 'admin';
      home.membershipExpiresAt = '2026-12-31T21:59:59Z';
    }
    await renderApp(invite, { state });
    await findHeading('Invite to Home');
    expect(screen.queryByRole('radio', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'No end date' })).toBeDisabled();
    expect(screen.getByText(/can't be later than your own/)).toBeInTheDocument();
  });

  it('Send by email is disabled with its reason', async () => {
    await renderApp(invite);
    await findHeading('Invite to Home');
    expect(screen.getByText('Needs email set up on this server')).toBeInTheDocument();
  });

  it('says why a link could not be made', async () => {
    const { user } = await renderApp(invite, {
      setup: (m) =>
        m.on(
          'POST',
          paths.locationInvites(':id'),
          () => new MockReply(403, { error: 'x', code: 'forbidden' }),
        ),
    });
    await findHeading('Invite to Home');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
  });
});

describe('Settings → Me', () => {
  it('lists sessions and devices, this one marked', async () => {
    await renderApp('/settings');
    expect(await screen.findByText('Safari on Mac')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    // The current session's pill, in the sessions list (Settings → Me also has a "This device"
    // row since step 8 T23, for the app lock and keep offline).
    const sessions = screen
      .getByRole('heading', { name: 'Sessions and devices' })
      .closest('section') as HTMLElement;
    expect(within(sessions).getByText('This device')).toBeInTheDocument();
  });

  it('signs out another device after a confirm', async () => {
    const { user, mock } = await renderApp('/settings');
    await screen.findByText('Chrome on Windows');
    const buttons = screen.getAllByRole('button', { name: 'Sign out' });
    await user.click(buttons[1] as HTMLElement);
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Sign out Chrome on Windows?' })).getByRole(
        'button',
        {
          name: 'Sign out',
        },
      ),
    );
    await waitFor(() => expect(mock.lastCall('DELETE', paths.mySession('s-3'))).toBeTruthy());
  });

  it('says when the devices could not load', async () => {
    await renderApp('/settings', {
      setup: (m) =>
        m.on('GET', paths.mySessions, () => new MockReply(500, { error: 'x', code: 'internal' })),
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it('two-factor enrolment: password → QR and key → code → backup codes', async () => {
    const { user, mock } = await renderApp('/settings', { state: firstRunScenario() });
    await user.click(await screen.findByRole('link', { name: 'Turn on' }));
    await findHeading('Turn on two-factor');
    await user.type(screen.getByLabelText('Your password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("That password isn't right.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Your password'));
    await user.type(screen.getByLabelText('Your password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    expect(await screen.findByText('Keep your backup codes')).toBeInTheDocument();
    expect(screen.getByText('a1b2c-d3e4f')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.twoFactorVerifyTotp)?.body).toEqual({ code: '123456' });
    await user.click(screen.getByRole('button', { name: "I've saved them" }));
    expect(await findHeading('Settings')).toBeInTheDocument();
  });

  it('two-factor waits for a confirmed address, and says a link removes the password (D197)', async () => {
    const { user, mock } = await renderApp('/settings/two-factor', {
      state: firstRunScenario(),
      setup: (m) =>
        m.on(
          'POST',
          paths.auth.twoFactorEnable,
          () =>
            new MockReply(403, {
              code: 'EMAIL_UNVERIFIED',
              message: 'Confirm your email address first',
            }),
        ),
    });
    await findHeading('Turn on two-factor');
    await user.type(screen.getByLabelText('Your password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Confirm your email address first')).toBeInTheDocument();
    expect(screen.getByText(/also removes this account's password/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.auth.signInMagicLink)?.body).toEqual({
        email: 'ibrahim@example.com',
      }),
    );
  });

  it('switching the digits changes how Arabic counts read', async () => {
    const { user } = await renderApp('/settings', { locale: 'ar' });
    await findHeading('الإعدادات');
    await user.click(screen.getByRole('radio', { name: '0123' }));
    // The catalogue reloads with the new digits first, so the choice is stored a moment later.
    await waitFor(() => expect(localStorage.getItem('kept.digits')).toBe('western'));
    expectLogicalOnly();
  });
});
