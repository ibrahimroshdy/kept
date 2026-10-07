/** Entry pages: first-run setup, sign in, the second factor, magic-link confirm. */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAGIC_TOKEN, ownerScenario, setupScenario, signedOutScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { paths } from '@/api/paths';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

describe('first-run setup', () => {
  it('checks the code format before going on', async () => {
    const { user } = await renderApp('/setup', { state: setupScenario() });
    await findHeading('Enter the setup code');
    await user.type(screen.getByLabelText('Setup code'), 'K7Q');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('The code is 6 letters and digits, like K7Q-2M9.')).toBeInTheDocument();
  });

  it('code → account → options → Home, sending the canonical code', async () => {
    const { user, mock, router } = await renderApp('/setup', { state: setupScenario() });
    await findHeading('Enter the setup code');
    await user.type(screen.getByLabelText('Setup code'), 'k7q-2m9');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await findHeading('Create the first account');
    await user.type(screen.getByLabelText('Your name'), 'Ibrahim');
    await user.type(screen.getByLabelText('Email'), 'ibrahim@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await findHeading('How should this Kept work?');
    expect(mock.lastCall('POST', paths.setup)?.body).toEqual({
      code: 'K7Q2M9',
      email: 'ibrahim@example.com',
      password: 'correct horse battery',
      displayName: 'Ibrahim',
    });
    expect(mock.lastCall('POST', paths.auth.signInEmail)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await findHeading('Welcome, Ibrahim')).toBeInTheDocument();
    expect(mock.lastCall('PUT', paths.admin.settings)?.body).toEqual({ signupOpen: false });
    expect(pathOf(router)).toBe('/');
  });

  it('a wrong code goes back to step 1 with the reason', async () => {
    const { user } = await renderApp('/setup', { state: setupScenario() });
    await findHeading('Enter the setup code');
    await user.type(screen.getByLabelText('Setup code'), 'AAAAAA');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await findHeading('Create the first account');
    await user.type(screen.getByLabelText('Your name'), 'Ibrahim');
    await user.type(screen.getByLabelText('Email'), 'ibrahim@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await findHeading('Enter the setup code')).toBeInTheDocument();
    expect(
      screen.getByText("That setup code isn't right. Check the server's logs."),
    ).toBeInTheDocument();
  });

  it('validates the account fields', async () => {
    const { user } = await renderApp('/setup', { state: setupScenario() });
    await findHeading('Enter the setup code');
    await user.type(screen.getByLabelText('Setup code'), 'K7Q2M9');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await findHeading('Create the first account');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Enter an email address, like name@example.com.')).toBeInTheDocument();
    expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
  });

  it('an instance that is already set up goes to Home', async () => {
    const { router } = await renderApp('/setup', { state: ownerScenario() });
    await findHeading('Home');
    expect(pathOf(router)).toBe('/');
  });

  it('renders in Arabic with Eastern step numbers', async () => {
    await renderApp('/setup', { state: setupScenario(), locale: 'ar' });
    expect(await findHeading('أدخل رمز الإعداد')).toBeInTheDocument();
    expect(screen.getAllByText('الخطوة ١ من ٣').length).toBeGreaterThan(0);
    expectLogicalOnly();
  });
});

describe('sign in', () => {
  it('asks for both fields', async () => {
    const { user } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email or username.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });

  it('says a wrong password plainly, without saying which part was wrong', async () => {
    const { user } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    await user.type(screen.getByLabelText('Email or username'), 'ibrahim@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText("That email or username and password don't match."),
    ).toBeInTheDocument();
  });

  it('a username signs in through the username route (managed accounts)', async () => {
    const state = signedOutScenario();
    state.me.user.twoFactorEnabled = false;
    const { user, mock } = await renderApp('/signin', { state });
    await findHeading('Sign in to Kept');
    await user.type(screen.getByLabelText('Email or username'), 'peter');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await findHeading('Home')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.signInUsername)?.body).toEqual({
      username: 'peter',
      password: 'correct horse battery',
    });
  });

  it('continues to the challenge when two-factor is on, then to where it was going', async () => {
    const { user, router } = await renderApp('/signin?next=%2Fsettings', {
      state: signedOutScenario(),
    });
    await findHeading('Sign in to Kept');
    await user.type(screen.getByLabelText('Email or username'), 'ibrahim@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await findHeading("Confirm it's you");
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await findHeading('Settings');
    expect(pathOf(router)).toBe('/settings');
  });

  it('sends a magic link and says to check email', async () => {
    const { user, mock } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(screen.getByText('Enter your email address to get a sign-in link.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email or username'), 'ibrahim@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await findHeading('Check your email')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.signInMagicLink)?.body).toEqual({
      email: 'ibrahim@example.com',
    });
  });

  it('shows how long to wait when rate limited', async () => {
    const { user } = await renderApp('/signin', {
      state: signedOutScenario(),
      setup: (m) =>
        m.on(
          'POST',
          paths.auth.signInEmail,
          () =>
            new MockReply(429, { code: 'SIGN_IN_DELAYED', message: 'Too many', retryAfter: 30 }),
        ),
    });
    await findHeading('Sign in to Kept');
    await user.type(screen.getByLabelText('Email or username'), 'ibrahim@example.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Too many attempts. Wait a minute and try again.'),
    ).toBeInTheDocument();
  });

  it('a fresh server sends sign-in to setup', async () => {
    const { router } = await renderApp('/signin', { state: setupScenario() });
    await findHeading('Enter the setup code');
    expect(pathOf(router)).toBe('/setup');
  });
});

describe('the second factor', () => {
  const pending = () => {
    const s = signedOutScenario();
    s.signedIn = true;
    s.mfaPending = true;
    return s;
  };

  it('refuses a wrong code', async () => {
    const { user } = await renderApp('/signin/two-factor', { state: pending() });
    await findHeading("Confirm it's you");
    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText("That code didn't match. Try the newest one your app shows."),
    ).toBeInTheDocument();
  });

  it('takes a backup code instead', async () => {
    const { user, mock } = await renderApp('/signin/two-factor', { state: pending() });
    await findHeading("Confirm it's you");
    await user.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    await user.type(screen.getByLabelText('Backup code'), 'a1b2c-d3e4f');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await findHeading('Home')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.twoFactorVerifyBackupCode)?.body).toEqual({
      code: 'a1b2c-d3e4f',
    });
  });

  it('only accepts 6 digits for an authenticator code', async () => {
    const { user } = await renderApp('/signin/two-factor', { state: pending() });
    await findHeading("Confirm it's you");
    await user.type(screen.getByLabelText('6-digit code'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter the 6 digits.')).toBeInTheDocument();
  });
});

describe('magic-link confirm', () => {
  it('never spends the token on load; the button POSTs it', async () => {
    const state = signedOutScenario();
    state.me.user.twoFactorEnabled = false;
    const { user, mock } = await renderApp(`/auth/confirm#token=${MAGIC_TOKEN}`, { state });
    await findHeading('Sign in to Kept');
    expect(mock.lastCall('POST', paths.auth.magicLinkVerify)).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await findHeading('Home')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.magicLinkVerify)?.body).toEqual({ token: MAGIC_TOKEN });
  });

  it('goes to the challenge when the account has two-factor', async () => {
    const { user } = await renderApp(`/auth/confirm#token=${MAGIC_TOKEN}`, {
      state: signedOutScenario(),
    });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await findHeading("Confirm it's you")).toBeInTheDocument();
  });

  it('says when a link has expired', async () => {
    const { user } = await renderApp('/auth/confirm#token=stale-token-1', {
      state: signedOutScenario(),
    });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('This link no longer works')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled());
  });

  it('a link without its token says so', async () => {
    await renderApp('/auth/confirm', { state: signedOutScenario() });
    expect(await findHeading('This link is incomplete')).toBeInTheDocument();
  });
});

describe('password reset', () => {
  it('"Forgot your password?" needs an email, then says to check it', async () => {
    const { user, mock } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    expect(
      screen.getByText('Enter your email address to reset your password.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email or username'), 'ibrahim@example.com');
    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    expect(await findHeading('Check your email')).toBeInTheDocument();
    expect(screen.getByText(/a link to set a new password is on its way/)).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.requestPasswordReset)?.body).toEqual({
      email: 'ibrahim@example.com',
    });
  });

  it('the reset link never spends its token on load; setting a password does', async () => {
    const state = signedOutScenario();
    const { user, mock } = await renderApp(`/auth/reset#token=${MAGIC_TOKEN}`, { state });
    await findHeading('Choose a new password');
    expect(mock.lastCall('POST', paths.auth.resetPassword)).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New password'), 'blue whale lamp');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await findHeading('Password changed')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.resetPassword)?.body).toEqual({
      token: MAGIC_TOKEN,
      newPassword: 'blue whale lamp',
    });
    expect(state.password).toBe('blue whale lamp');
  });

  it('says when a reset link has expired', async () => {
    const { user } = await renderApp('/auth/reset#token=stale-token-1', {
      state: signedOutScenario(),
    });
    await findHeading('Choose a new password');
    await user.type(screen.getByLabelText('New password'), 'blue whale lamp');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('This link no longer works')).toBeInTheDocument();
  });

  it('a reset link without its token says so', async () => {
    await renderApp('/auth/reset', { state: signedOutScenario() });
    expect(await findHeading('This link is incomplete')).toBeInTheDocument();
  });
});

describe('one-time code (managed accounts, D164)', () => {
  it('sets the password with the code, then signs in', async () => {
    const { user, mock } = await renderApp('/signin', { state: signedOutScenario() });
    await findHeading('Sign in to Kept');
    await user.click(screen.getByRole('link', { name: 'I have a one-time code' }));
    await findHeading('Sign in with a one-time code');
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(screen.getByText('The code is 8 characters.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'peter');
    await user.type(screen.getByLabelText('One-time code'), 'k7q2-m9tx');
    await user.type(screen.getByLabelText('New password'), 'blue whale lamp');
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(await findHeading('Home')).toBeInTheDocument();
    expect(mock.lastCall('POST', paths.auth.resetCode)?.body).toEqual({
      username: 'peter',
      code: 'K7Q2M9TX',
      newPassword: 'blue whale lamp',
    });
  });

  it('a wrong or expired code says so', async () => {
    const { user } = await renderApp('/signin/code', { state: signedOutScenario() });
    await findHeading('Sign in with a one-time code');
    await user.type(screen.getByLabelText('Username'), 'peter');
    await user.type(screen.getByLabelText('One-time code'), 'AAAAAAAA');
    await user.type(screen.getByLabelText('New password'), 'blue whale lamp');
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(await screen.findByText(/don't match, or the code has expired/)).toBeInTheDocument();
  });
});
