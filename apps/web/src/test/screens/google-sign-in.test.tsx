/**
 * 1.2 on the mock: Google sign-in (D226) on the sign-in page and its failures, and Settings → Me →
 * Sign-in methods (D176): link and unlink the OIDC provider or Google, the fresh-session refusal,
 * the last way in, and a refused link coming back. Admin → Status's Google row.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceMock } from '@/api/connections/mock/instance';
import { ownerScenario, signedOutScenario } from '@/api/mock/fixtures';
import { leave } from '@/lib/leave';
import { renderApp } from '../app';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A scenario with Google configured. */
function withGoogle(state = ownerScenario()) {
  instanceMock(state).google = {
    configured: true,
    callbackUrl: 'http://kept.test/api/v1/auth/callback/google',
  };
  return state;
}

describe('Sign in with Google', () => {
  it('is offered when configured, and opens Google', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
    const { user, mock } = await renderApp('/signin', { state: withGoogle(signedOutScenario()) });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() =>
      expect(to).toHaveBeenCalledWith(expect.stringContaining('accounts.google.com')),
    );
    expect(mock.lastCall('POST', '/api/v1/auth/sign-in/social')?.body).toMatchObject({
      provider: 'google',
      callbackURL: '/',
      errorCallbackURL: '/signin?via=google',
    });
  });

  it('is absent when not configured', async () => {
    await renderApp('/signin', { state: signedOutScenario() });
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull();
  });

  it('names Google when it comes back refused', async () => {
    await renderApp('/signin?via=google&error=email_unverified', {
      state: withGoogle(signedOutScenario()),
    });
    const title = await screen.findByText("Your email isn't confirmed");
    expect(title.closest('[role="status"], [role="alert"], div')?.parentElement).toHaveTextContent(
      /Google hasn't confirmed your email address/,
    );
  });
});

describe('Settings → Me → Sign-in methods', () => {
  it('lists the OIDC provider and Google, and links Google from a fresh session', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
    const { user, mock } = await renderApp('/settings', { state: withGoogle() });
    const section = (await screen.findByRole('heading', { name: 'Sign-in methods' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(section).findAllByText('Not linked')).toHaveLength(2);
    expect(section).toHaveTextContent('Sign in with Home SSO');
    expect(section).toHaveTextContent('Sign in with Google');
    await user.click(within(section).getAllByRole('button', { name: 'Link' })[1] as HTMLElement);
    await waitFor(() =>
      expect(to).toHaveBeenCalledWith(expect.stringContaining('accounts.google.com')),
    );
    expect(mock.lastCall('POST', '/api/v1/auth/link-social')?.body).toMatchObject({
      provider: 'google',
      callbackURL: '/settings',
      errorCallbackURL: '/settings?via=google',
    });
  });

  it('asks to sign in again when the session is older than ten minutes', async () => {
    const state = withGoogle();
    instanceMock(state).staleSession = true;
    const { user } = await renderApp('/settings', { state });
    const section = (await screen.findByRole('heading', { name: 'Sign-in methods' })).closest(
      'section',
    ) as HTMLElement;
    const links = await within(section).findAllByRole('button', { name: 'Link' });
    await user.click(links[1] as HTMLElement);
    expect(await within(section).findByText('Sign in again first')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  const googleMethod = {
    id: 'acc-google',
    providerId: 'google',
    accountId: 'g-ibrahim',
    createdAt: '2026-10-01T09:00:00.000Z',
  };

  it('unlinks Google after a confirm', async () => {
    const state = withGoogle();
    instanceMock(state).methods.push(googleMethod);
    const { user } = await renderApp('/settings', { state });
    const section = (await screen.findByRole('heading', { name: 'Sign-in methods' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(section).findByText('Linked')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(within(section).getAllByText('Not linked')).toHaveLength(2));
    expect(instanceMock(state).methods.map((m) => m.providerId)).toEqual(['credential']);
  });

  it('never unlinks the last way in, and says why', async () => {
    const state = withGoogle();
    instanceMock(state).methods = [googleMethod];
    const { user } = await renderApp('/settings', { state });
    const section = (await screen.findByRole('heading', { name: 'Sign-in methods' })).closest(
      'section',
    ) as HTMLElement;
    await user.click(await within(section).findByRole('button', { name: 'Unlink' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlink' }),
    );
    expect(
      await screen.findByText("That's your only way in. Add a password or another sign-in first."),
    ).toBeInTheDocument();
    expect(instanceMock(state).methods).toHaveLength(1);
  });

  it('is absent when no outside sign-in is configured', async () => {
    const state = ownerScenario();
    instanceMock(state).oidc.configured = false;
    await renderApp('/settings', { state });
    await screen.findByRole('heading', { name: 'Sessions and devices' });
    expect(screen.queryByRole('heading', { name: 'Sign-in methods' })).toBeNull();
  });

  it('puts a refused link in words, naming the provider', async () => {
    await renderApp('/settings?via=google&error=email_does_not_match', { state: withGoogle() });
    const title = await screen.findByText("The email addresses don't match");
    expect(title.closest('div')?.parentElement).toHaveTextContent(
      /The email on your Google account/,
    );
  });
});

describe('Admin → Status, Google', () => {
  it('shows the redirect URI to register with Google', async () => {
    await renderApp('/admin/status', { state: withGoogle() });
    expect(await screen.findByText('Sign-in with Google')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/v1\/auth\/callback\/google$/)).toBeInTheDocument();
  });
});
