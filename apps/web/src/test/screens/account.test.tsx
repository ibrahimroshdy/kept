/**
 * Step 1's screens for routes that already existed: changing the sign-in email (D176), restoring
 * a deleted location (D149), a managed account's new one-time code (D164, D197) and instance
 * admins (D164).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANGE_NEW_TOKEN,
  EMAIL_CHANGE_OLD_TOKEN,
  IDS,
  memberScenario,
  ownerScenario,
  signedOutScenario,
} from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { paths } from '@/api/paths';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

describe('Settings → Me → Change email (D176)', () => {
  const open = async () => {
    const r = await renderApp('/settings');
    await r.user.click(await screen.findByRole('button', { name: 'Change email' }));
    return { ...r, dialog: screen.getByRole('dialog', { name: 'Change your email' }) };
  };

  it('asks for the password when the server wants it, then says to check the old inbox', async () => {
    const { user, mock, dialog } = await open();
    const field = within(dialog).getByLabelText('New email address');
    expect(field).toHaveFocus();
    await user.type(field, 'ibrahim@new.example');
    await user.keyboard('{Enter}');
    // First try without a password: 403 reauth_required.
    const password = await within(dialog).findByLabelText('Your password');
    // Not an error yet: they haven't tried with it.
    expect(within(dialog).queryByText('Enter your password.')).not.toBeInTheDocument();
    expect(mock.lastCall('POST', paths.myEmailChange)?.body).toEqual({
      newEmail: 'ibrahim@new.example',
    });
    await user.type(password, 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Send confirmation link' }));
    expect(await within(dialog).findByText(/We sent a link to/)).toHaveTextContent(
      'ibrahim@example.com',
    );
    expect(dialog).toHaveTextContent('ibrahim@new.example');
    expect(mock.lastCall('POST', paths.myEmailChange)?.body).toEqual({
      newEmail: 'ibrahim@new.example',
      password: 'correct horse battery',
    });
  });

  it('skips the password after a fresh sign-in', async () => {
    const state = ownerScenario();
    state.freshSignIn = true;
    const r = await renderApp('/settings', { state });
    await r.user.click(await screen.findByRole('button', { name: 'Change email' }));
    const dialog = screen.getByRole('dialog', { name: 'Change your email' });
    await r.user.type(within(dialog).getByLabelText('New email address'), 'ibrahim@new.example');
    await r.user.click(within(dialog).getByRole('button', { name: 'Send confirmation link' }));
    expect(await within(dialog).findByText(/We sent a link to/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Your password')).not.toBeInTheDocument();
  });

  it('a wrong password says so', async () => {
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText('New email address'), 'ibrahim@new.example');
    await user.keyboard('{Enter}');
    await user.type(await within(dialog).findByLabelText('Your password'), 'nope');
    await user.keyboard('{Enter}');
    expect(await within(dialog).findByText("That password isn't right.")).toBeInTheDocument();
  });

  it('checks the address before sending', async () => {
    const { user, mock, dialog } = await open();
    await user.type(within(dialog).getByLabelText('New email address'), 'ibrahim@example.com');
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText("That's already your email address.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('New email address'));
    await user.type(within(dialog).getByLabelText('New email address'), 'not-an-address');
    await user.keyboard('{Enter}');
    expect(within(dialog).getByText('Enter an email address.')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.myEmailChange)).toBeUndefined();
  });

  it('a managed account has no email to change', async () => {
    const state = ownerScenario();
    state.me.user.managed = true;
    state.me.user.email = null;
    state.me.user.username = 'ibrahim';
    await renderApp('/settings', { state });
    await screen.findByText('Safari on Mac');
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument();
  });
});

describe('/auth/email-change (D176, D181)', () => {
  it('the old address confirms: never on load, then "check your new inbox"', async () => {
    const { user, mock } = await renderApp(`/auth/email-change#token=${EMAIL_CHANGE_OLD_TOKEN}`, {
      state: signedOutScenario(),
    });
    await findHeading('Confirm the email change');
    expect(mock.lastCall('POST', paths.auth.emailChangeConfirm)).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await findHeading('Now check your new inbox')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.emailChangeConfirm)?.body).toEqual({
      token: EMAIL_CHANGE_OLD_TOKEN,
    });
  });

  it('the new address confirms: the email changed', async () => {
    const { user, mock } = await renderApp(`/auth/email-change#token=${EMAIL_CHANGE_NEW_TOKEN}`);
    await findHeading('Confirm the email change');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await findHeading('Your email address changed')).toBeInTheDocument();
    expect(mock.state.me.user.email).toBe('ibrahim@new.example');
    expect(screen.getByRole('link', { name: 'Open Kept' })).toHaveAttribute('href', '/');
  });

  it('a used or expired link says so', async () => {
    const { user } = await renderApp('/auth/email-change#token=stale-token-1', {
      state: signedOutScenario(),
    });
    await findHeading('Confirm the email change');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('This link no longer works')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled());
  });

  it('a link without its token says so', async () => {
    await renderApp('/auth/email-change', { state: signedOutScenario() });
    expect(await findHeading('This link is incomplete')).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    await renderApp(`/auth/email-change#token=${EMAIL_CHANGE_OLD_TOKEN}`, {
      state: signedOutScenario(),
      locale: 'ar',
    });
    expect(await findHeading('تأكيد تغيير البريد الإلكتروني')).toBeInTheDocument();
    expectLogicalOnly();
  });
});

describe('Settings → Locations → Recently deleted (D149)', () => {
  it('lists deleted locations with their purge date, and restores one', async () => {
    const { user, mock } = await renderApp('/settings/locations');
    const section = (await screen.findByRole('heading', { name: 'Recently deleted' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText('Beach flat')).toBeInTheDocument();
    expect(within(section).getByText(/Deleted .* · gone for good on /)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Restore Beach flat' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.locationRestore(IDS.beach))).toBeTruthy(),
    );
    // In the list (and the sidebar's location switcher) again.
    expect((await screen.findAllByRole('link', { name: /Beach flat/ })).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Recently deleted' })).not.toBeInTheDocument(),
    );
  });

  it('is hidden when nothing is deleted', async () => {
    await renderApp('/settings/locations', { state: memberScenario() });
    await screen.findAllByRole('link', { name: /You're a member/ });
    expect(screen.queryByRole('heading', { name: 'Recently deleted' })).not.toBeInTheDocument();
  });

  it('says when a restore fails', async () => {
    const { user } = await renderApp('/settings/locations', {
      setup: (m) =>
        m.on(
          'POST',
          paths.locationRestore(':id'),
          () => new MockReply(404, { error: 'Not found.', code: 'not_found' }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Restore Beach flat' }));
    expect(
      await screen.findByText("This isn't here any more, or you can't see it."),
    ).toBeInTheDocument();
  });
});

describe('Members → a managed account’s new one-time code (D164, D197)', () => {
  const members = `/settings/location/${IDS.home}/members`;

  it('the owner issues one after a confirm; it shows once with copy and expiry', async () => {
    const { user, mock } = await renderApp(members);
    await user.click(await screen.findByRole('button', { name: 'Manage Peter' }));
    const dialog = screen.getByRole('dialog', { name: 'Peter' });
    await user.click(within(dialog).getByRole('button', { name: 'New one-time code' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Give Peter a new one-time code?' });
    expect(confirm).toHaveTextContent('signed out on every device');
    await user.click(within(confirm).getByRole('button', { name: 'New code' }));
    const shown = await screen.findByRole('dialog', { name: 'Give Peter this code' });
    expect(shown).toHaveTextContent('Q4M7K2XP');
    expect(shown).toHaveTextContent('peter');
    expect(shown).toHaveTextContent(/Works once, until /);
    expect(within(shown).getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.managedResetCode('u-peter'))).toBeTruthy();
  });

  it('is not offered for an account with an email', async () => {
    const { user } = await renderApp(members);
    await user.click(await screen.findByRole('button', { name: 'Manage Alfred' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Alfred' })).queryByRole('button', {
        name: 'New one-time code',
      }),
    ).not.toBeInTheDocument();
  });

  it('an admin who did not create the account is not offered it (D197)', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'admin';
    for (const m of state.members[IDS.home]?.members ?? []) m.isYou = m.displayName === 'Bruce';
    state.me.user.displayName = 'Bruce';
    const { user } = await renderApp(members, { state });
    await user.click(await screen.findByRole('button', { name: 'Manage Peter' }));
    expect(
      within(screen.getByRole('dialog', { name: 'Peter' })).queryByRole('button', {
        name: 'New one-time code',
      }),
    ).not.toBeInTheDocument();
  });

  it('explains a refusal from the server (404)', async () => {
    const { user } = await renderApp(members, {
      setup: (m) =>
        m.on(
          'POST',
          paths.managedResetCode(':userId'),
          () => new MockReply(404, { error: 'Not found.', code: 'not_found' }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Manage Peter' }));
    const dialog = screen.getByRole('dialog', { name: 'Peter' });
    await user.click(within(dialog).getByRole('button', { name: 'New one-time code' }));
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Give Peter a new one-time code?' }),
      ).getByRole('button', { name: 'New code' }),
    );
    expect(
      await within(dialog).findByText(
        /Only the owner of Peter’s home location, or whoever created the account/,
      ),
    ).toBeInTheDocument();
  });
});

describe('Instance admin → Admins (D164)', () => {
  it('lists the admins; the last one cannot be removed, and says why', async () => {
    await renderApp('/admin/admins');
    const list = (await screen.findByRole('heading', { name: 'Instance admins' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(list).getByText('Ibrahim (you)')).toBeInTheDocument();
    expect(within(list).queryByText('Bruce')).not.toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Remove Ibrahim as admin' })).toBeDisabled();
    expect(
      screen.getByText("Kept needs at least one instance admin, so the last one can't be removed."),
    ).toBeInTheDocument();
  });

  it('grants admin to someone, by keyboard, after a confirm', async () => {
    const { user, mock } = await renderApp('/admin/admins');
    const person = await screen.findByRole('combobox', { name: 'Person' });
    await user.click(person);
    await user.keyboard('{ArrowDown}');
    // Managed and disabled accounts, and existing admins, are not offered.
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => o?.includes('Bruce'))).toBe(true);
    expect(options.some((o) => o?.includes('Peter'))).toBe(false);
    expect(options.some((o) => o?.includes('Antar'))).toBe(false);
    expect(options.some((o) => o?.includes('Ibrahim'))).toBe(false);
    await user.keyboard('{Enter}');
    expect(person).toHaveValue('Bruce');
    await user.click(screen.getByRole('button', { name: 'Make admin' }));
    const confirm = screen.getByRole('alertdialog', { name: /^Make .* an instance admin\?$/ });
    await user.click(within(confirm).getByRole('button', { name: 'Make admin' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', paths.admin.instanceAdmins)?.body).toEqual({
        userId: 'u-bruce',
      }),
    );
    const list = (await screen.findByRole('heading', { name: 'Instance admins' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(list).findByText('Bruce')).toBeInTheDocument();
  });

  it('revokes another admin after a confirm', async () => {
    const state = ownerScenario();
    const bruce = state.admin.users.find((u) => u.id === 'u-bruce');
    if (bruce) bruce.instanceAdmin = true;
    const { user, mock } = await renderApp('/admin/admins', { state });
    await user.click(await screen.findByRole('button', { name: 'Remove Bruce as admin' }));
    const confirm = screen.getByRole('alertdialog', {
      name: 'Remove Bruce as an instance admin?',
    });
    expect(confirm).toHaveTextContent('They get an email about it.');
    await user.click(within(confirm).getByRole('button', { name: 'Remove as admin' }));
    await waitFor(() =>
      expect(mock.lastCall('DELETE', paths.admin.instanceAdmin('u-bruce'))).toBeTruthy(),
    );
  });

  it('explains the last-admin refusal (409) when the server gives it', async () => {
    const state = ownerScenario();
    const bruce = state.admin.users.find((u) => u.id === 'u-bruce');
    if (bruce) bruce.instanceAdmin = true;
    const { user } = await renderApp('/admin/admins', {
      state,
      setup: (m) =>
        m.on(
          'DELETE',
          paths.admin.instanceAdmin(':userId'),
          () =>
            new MockReply(409, {
              error: 'Kept needs at least one instance admin.',
              code: 'conflict',
            }),
        ),
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Bruce as admin' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove as admin' }),
    );
    expect(await screen.findByText('Kept needs at least one instance admin')).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    await renderApp('/admin/admins', { locale: 'ar' });
    expect(await screen.findByRole('heading', { name: 'مشرفو الخادم' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
