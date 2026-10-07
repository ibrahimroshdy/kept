import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  enrolTotp,
  PUBLIC_URL,
  requestHeaders,
  type SignedIn,
  signUp,
  type TestAuth,
  testAuth,
  totp,
} from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { userEmail } from '../../test/tenancy.js';
import { registerSoftPasskey } from '../../test/webauthn.js';
import { AUTH_BASE_PATH } from './auth.js';
import { pendingSessionMayCall, SECOND_FACTOR_PATHS } from './security.js';
import { gateSession, resolveSession } from './session.js';
import { FREE_FAILURES } from './sign-in-limiter.js';

// Spike S2 (V32): two-factor on every sign-in method. Better Auth's twoFactor plugin challenges
// only password sign-in; Kept's gate (auth/security.ts, auth/session.ts) covers the rest.

const PASSWORD = 'correct horse battery';

describe('two-factor on every sign-in method', () => {
  let db: TestDb;
  let auth: TestAuth;
  let user: SignedIn & { email: string; secret: string };

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
    auth = testAuth(db, { rateLimitEnabled: false });
    const email = `u-${randomUUID()}@example.com`;
    const signedIn = await signUp(auth, email, PASSWORD);
    // The address's own owner: verified, so a magic link signs in rather than claiming the
    // account (D197), which would remove the TOTP enrolled here.
    await userEmail(db, signedIn.userId, true);
    const { secret } = await enrolTotp(auth, signedIn, PASSWORD);
    user = { ...signedIn, email, secret };
  });

  async function sessionCount(): Promise<number> {
    const { rows } = await db.pools.auth.query(
      'SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1',
      [user.userId],
    );
    return rows[0].n;
  }

  async function resolve(cookie: string) {
    return (await resolveSession(auth, db.pools.auth, requestHeaders(cookie))).session;
  }

  async function magicLinkSession(email: string): Promise<string> {
    await auth.api.signInMagicLink({ body: { email }, headers: requestHeaders() });
    const token = auth.mails.at(-1)?.token ?? '';
    const { headers } = await auth.api.magicLinkVerify({
      query: { token },
      headers: requestHeaders(),
      returnHeaders: true,
    });
    return cookieHeader(headers);
  }

  it('the enrolling session itself counts as two-factor', async () => {
    const enrolledIn = await signUp(auth, `e-${randomUUID()}@example.com`, PASSWORD);
    const { cookie } = await enrolTotp(auth, enrolledIn, PASSWORD);
    expect(await resolve(cookie)).toMatchObject({ twoFactorEnabled: true, mfa: true });
  });

  it('password: sign-in returns "two-factor required" and creates no session until TOTP', async () => {
    const before = await sessionCount();
    const { headers, response } = await auth.api.signInEmail({
      body: { email: user.email, password: PASSWORD },
      headers: requestHeaders(),
      returnHeaders: true,
    });
    expect(response).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionCount()).toBe(before);
    const challengeCookie = cookieHeader(headers);
    expect(challengeCookie).not.toMatch(/session_token/);

    const verified = await auth.api.verifyTOTP({
      body: { code: totp(user.secret) },
      headers: requestHeaders(challengeCookie),
      returnHeaders: true,
    });
    const cookie = cookieHeader(verified.headers, challengeCookie);
    const session = await resolve(cookie);
    expect(session).toMatchObject({ userId: user.userId, mfa: true, mfaPending: false });
    expect(gateSession(session)).toEqual({ ok: true, scope: { userId: user.userId, mfa: true } });
  });

  it('magic link: Better Auth creates a full session, which Kept holds as pending', async () => {
    const cookie = await magicLinkSession(user.email);
    const session = await resolve(cookie);
    expect(session).toMatchObject({ userId: user.userId, mfa: false, mfaPending: true });
    expect(gateSession(session)).toEqual({ ok: false, status: 403, code: 'mfa_required' });

    // Better Auth's own endpoints refuse it too…
    await expect(auth.api.listSessions({ headers: requestHeaders(cookie) })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'MFA_REQUIRED' },
    });
    // …including the ones that would let it register a new factor and bypass the gate.
    await expect(
      auth.api.generatePasskeyRegistrationOptions({ headers: requestHeaders(cookie) }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // It may still read its own session and finish with a second factor.
    await expect(auth.api.getSession({ headers: requestHeaders(cookie) })).resolves.toMatchObject({
      user: { id: user.userId },
    });
    await auth.api.verifyTOTP({
      body: { code: totp(user.secret) },
      headers: requestHeaders(cookie),
    });
    expect(await resolve(cookie)).toMatchObject({ mfa: true, mfaPending: false });
    await expect(auth.api.listSessions({ headers: requestHeaders(cookie) })).resolves.toEqual(
      expect.any(Array),
    );
  });

  it('magic link: a pending session can sign out', async () => {
    const cookie = await magicLinkSession(user.email);
    await expect(auth.api.signOut({ headers: requestHeaders(cookie) })).resolves.toMatchObject({
      success: true,
    });
    expect(await resolve(cookie)).toBeNull();
  });

  it('magic link: wrong codes inside a pending session are delayed, not unlimited', async () => {
    const cookie = await magicLinkSession(user.email);
    const wrong = totp(user.secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(
        auth.api.verifyTOTP({ body: { code: wrong }, headers: requestHeaders(cookie) }),
      ).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(
      auth.api.verifyTOTP({ body: { code: totp(user.secret) }, headers: requestHeaders(cookie) }),
    ).rejects.toMatchObject({ statusCode: 429, body: { code: 'SIGN_IN_DELAYED' } });
    expect(await resolve(cookie)).toMatchObject({ mfaPending: true });
  });

  it('magic link: 30 parallel wrong codes never get more than the free attempts', async () => {
    const cookie = await magicLinkSession(user.email);
    const wrong = totp(user.secret) === '000000' ? '111111' : '000000';
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        auth.api.verifyTOTP({ body: { code: wrong }, headers: requestHeaders(cookie) }),
      ),
    );
    const statuses = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { statusCode: number }).statusCode : 200,
    );
    // Each attempt is reserved before it is verified, so no more than the free allowance ever
    // reaches the code check; the rest wait (D172).
    expect(statuses.filter((s) => s === 401)).toHaveLength(FREE_FAILURES + 1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30 - (FREE_FAILURES + 1));
    expect(await resolve(cookie)).toMatchObject({ mfaPending: true });
  });

  it('an emailed OTP is not a second factor: the paths are off and a pending session stays pending', async () => {
    expect([...SECOND_FACTOR_PATHS.keys()]).not.toContain('/two-factor/verify-otp');
    expect(pendingSessionMayCall('/two-factor/verify-otp')).toBe(false);
    expect(pendingSessionMayCall('/two-factor/send-otp')).toBe(false);

    const cookie = await magicLinkSession(user.email);
    await expect(
      auth.api.verifyTwoFactorOTP({ body: { code: '123456' }, headers: requestHeaders(cookie) }),
    ).rejects.toMatchObject({ statusCode: 403 });
    for (const path of ['/two-factor/send-otp', '/two-factor/verify-otp']) {
      const res = await auth.handler(
        new Request(`${PUBLIC_URL}${AUTH_BASE_PATH}${path}`, {
          method: 'POST',
          headers: (() => {
            const h = requestHeaders(cookie);
            h.set('content-type', 'application/json');
            return h;
          })(),
          body: JSON.stringify({ code: '123456' }),
        }),
      );
      expect(res.status).toBe(404);
    }
    expect(await resolve(cookie)).toMatchObject({ mfa: false, mfaPending: true });
  });

  it('refuses "trust this device", in the sign-in challenge and in a pending session', async () => {
    // Challenge first: a magic link to an unverified address makes Better Auth drop the
    // password, so the password sign-in has to come before it.
    const challenge = await auth.api.signInEmail({
      body: { email: user.email, password: PASSWORD },
      headers: requestHeaders(),
      returnHeaders: true,
    });
    await expect(
      auth.api.verifyTOTP({
        body: { code: totp(user.secret), trustDevice: true },
        headers: requestHeaders(cookieHeader(challenge.headers)),
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'TRUST_DEVICE_UNSUPPORTED' } });

    const cookie = await magicLinkSession(user.email);
    await expect(
      auth.api.verifyBackupCode({
        body: { code: 'whatever', trustDevice: true },
        headers: requestHeaders(cookie),
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'TRUST_DEVICE_UNSUPPORTED' } });
    expect(await resolve(cookie)).toMatchObject({ mfaPending: true });
  });

  it('change-password with revokeOtherSessions keeps the replacement session satisfied', async () => {
    const challenge = await auth.api.signInEmail({
      body: { email: user.email, password: PASSWORD },
      headers: requestHeaders(),
      returnHeaders: true,
    });
    const challengeCookie = cookieHeader(challenge.headers);
    const verified = await auth.api.verifyTOTP({
      body: { code: totp(user.secret) },
      headers: requestHeaders(challengeCookie),
      returnHeaders: true,
    });
    const cookie = cookieHeader(verified.headers, challengeCookie);
    expect(await resolve(cookie)).toMatchObject({ mfa: true });

    const changed = await auth.api.changePassword({
      body: {
        currentPassword: PASSWORD,
        newPassword: 'a brand new password',
        revokeOtherSessions: true,
      },
      headers: requestHeaders(cookie),
      returnHeaders: true,
    });
    const replacement = cookieHeader(changed.headers, cookie);
    expect(replacement).not.toBe(cookie);
    expect(await resolve(cookie)).toBeNull();
    expect(await resolve(replacement)).toMatchObject({ mfa: true, mfaPending: false });
  });

  it('magic link without two-factor enrolled: not pending, and mfa stays false', async () => {
    const plain = await signUp(auth, `p-${randomUUID()}@example.com`, PASSWORD);
    const { rows } = await db.pools.auth.query('SELECT email FROM auth."user" WHERE id = $1', [
      plain.userId,
    ]);
    const cookie = await magicLinkSession(rows[0].email);
    const session = await resolve(cookie);
    expect(session).toMatchObject({ twoFactorEnabled: false, mfa: false, mfaPending: false });
    // Signed in, but require_2fa locations stay hidden (app.mfa = false, §7.14).
    expect(gateSession(session)).toEqual({ ok: true, scope: { userId: plain.userId, mfa: false } });
  });

  describe('passkey', () => {
    async function passkeySignIn(userVerified: boolean): Promise<string> {
      const key = await registerSoftPasskey(db.pools.auth, user.userId, {
        id: new URL(PUBLIC_URL).hostname,
        origin: PUBLIC_URL,
      });
      const options = await auth.api.generatePasskeyAuthenticationOptions({
        headers: requestHeaders(),
        returnHeaders: true,
      });
      const challengeCookie = cookieHeader(options.headers);
      const { headers } = await auth.api.verifyPasskeyAuthentication({
        body: { response: key.assert({ challenge: options.response.challenge, userVerified }) },
        headers: requestHeaders(challengeCookie),
        returnHeaders: true,
      });
      return cookieHeader(headers, challengeCookie);
    }

    it('with user verification counts as two factors', async () => {
      const session = await resolve(await passkeySignIn(true));
      expect(session).toMatchObject({ userId: user.userId, mfa: true, mfaPending: false });
    });

    it('without user verification is a pending session', async () => {
      const session = await resolve(await passkeySignIn(false));
      expect(session).toMatchObject({ userId: user.userId, mfa: false, mfaPending: true });
      expect(gateSession(session)).toMatchObject({ ok: false, code: 'mfa_required' });
    });
  });

  it('no session is unauthenticated', async () => {
    expect(gateSession(await resolve(''))).toEqual({
      ok: false,
      status: 401,
      code: 'unauthenticated',
    });
  });
});
