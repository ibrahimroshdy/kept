import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fragmentToken, jar, type TestApp, testApp } from '../../test/app.js';
import { enrolTotp, signUp } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { freshIp } from '../../test/people.js';
import { softRegistration } from '../../test/webauthn.js';
import { AUTH_BASE_PATH } from './auth.js';

// Security review I3: a credential change is mailed to the account's owner. A stolen session
// that registers a passkey, switches off two-factor or changes the password can then no longer
// do it unseen.

const PASSWORD = 'correct horse battery';

let db: TestDb;
let t: TestApp;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await testApp(db);
});

function auth(
  path: string,
  opts: { cookie?: string; body?: unknown; method?: 'GET' | 'POST' } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { origin: t.publicUrl };
  if (opts.cookie) headers.cookie = opts.cookie;
  return t.app.inject({
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    url: `${AUTH_BASE_PATH}${path}`,
    headers,
    remoteAddress: freshIp(),
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
}

async function newUser(label: string) {
  const email = `${label}-${randomUUID()}@example.com`;
  const signed = await signUp(t.auth, email, PASSWORD);
  const res = await auth('/sign-in/email', { body: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { ...signed, email, cookie: jar(res) };
}

const noticesFor = (email: string) => t.auth.notices.filter((n) => n.email === email);

describe('security notices (review I3)', () => {
  it('mails the owner when the password is changed, and not when the change is refused', async () => {
    const user = await newUser('pw');
    const refused = await auth('/change-password', {
      cookie: user.cookie,
      body: { currentPassword: 'not the password', newPassword: 'a brand new password' },
    });
    expect(refused.statusCode).toBe(400);
    const changed = await auth('/change-password', {
      cookie: user.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toEqual([{ email: user.email, event: 'password-changed' }]),
    );
  });

  it('mails the owner when the password is reset through a mailed link', async () => {
    const user = await newUser('reset');
    await db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [
      user.userId,
    ]);
    await auth('/request-password-reset', { body: { email: user.email } });
    const url = t.auth.resets.at(-1)?.url ?? '';
    const reset = await auth('/reset-password', {
      body: { token: fragmentToken(url), newPassword: 'another good password' },
    });
    expect(reset.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toEqual([{ email: user.email, event: 'password-changed' }]),
    );
  });

  it('makes a reset on an unverified address claim the account (D197)', async () => {
    // Someone signed up with this address first, and planted a passkey and TOTP on it.
    const user = await newUser('prehijack');
    const { cookie } = await enrolTotp(t.auth, user, PASSWORD);
    const options = await auth('/passkey/generate-register-options', { cookie });
    const { challenge } = options.json() as { challenge: string };
    const origin = new URL(t.publicUrl);
    const planted = await auth('/passkey/verify-registration', {
      cookie: jar(options, cookie),
      body: {
        response: softRegistration(challenge, { id: origin.hostname, origin: origin.origin }),
      },
    });
    expect(planted.statusCode).toBe(200);

    // The address's real owner resets the password, which proves the mailbox.
    await auth('/request-password-reset', { body: { email: user.email } });
    const url = t.auth.resets.at(-1)?.url ?? '';
    const reset = await auth('/reset-password', {
      body: { token: fragmentToken(url), newPassword: 'another good password' },
    });
    expect(reset.statusCode).toBe(200);
    const { rows } = await db.pools.auth.query(
      `SELECT u.email_verified, coalesce(u.two_factor_enabled, false) AS tfa,
              (SELECT count(*)::int FROM auth.passkey p WHERE p.user_id = u.id) AS passkeys,
              (SELECT count(*)::int FROM auth.two_factor f WHERE f.user_id = u.id) AS totp,
              (SELECT count(*)::int FROM auth.session s WHERE s.user_id = u.id) AS sessions
         FROM auth."user" u WHERE u.id = $1`,
      [user.userId],
    );
    expect(rows[0]).toEqual({
      email_verified: true,
      tfa: false,
      passkeys: 0,
      totp: 0,
      sessions: 0,
    });
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toContainEqual({
        email: user.email,
        event: 'unverified-account-reset',
      }),
    );
  });

  it('mails the owner when two-factor is switched off', async () => {
    const user = await newUser('tfa');
    const { cookie } = await enrolTotp(t.auth, user, PASSWORD);
    expect(noticesFor(user.email)).toEqual([]);
    const disabled = await auth('/two-factor/disable', { cookie, body: { password: PASSWORD } });
    expect(disabled.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toEqual([{ email: user.email, event: 'two-factor-disabled' }]),
    );
  });

  it('mails the owner when a passkey is registered', async () => {
    const user = await newUser('passkey');
    const options = await auth('/passkey/generate-register-options', { cookie: user.cookie });
    expect(options.statusCode).toBe(200);
    const { challenge } = options.json() as { challenge: string };
    const origin = new URL(t.publicUrl);
    const verified = await auth('/passkey/verify-registration', {
      cookie: jar(options, user.cookie),
      body: {
        response: softRegistration(challenge, { id: origin.hostname, origin: origin.origin }),
      },
    });
    expect(verified.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toEqual([{ email: user.email, event: 'passkey-added' }]),
    );
  });

  it('never mails a managed account (no real address)', async () => {
    const user = await newUser('managed');
    await db.pools.auth.query(`UPDATE auth."user" SET email = $1 WHERE id = $2`, [
      `${randomUUID()}@managed.invalid`,
      user.userId,
    ]);
    const changed = await auth('/change-password', {
      cookie: user.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.auth.notices).toEqual([]);
  });
});

describe('D197: a first magic-link sign-in claims an unverified account', () => {
  /** What is left on the account that could still get someone in. */
  async function waysIn(userId: string) {
    const { rows } = await db.pools.auth.query(
      `SELECT u.email_verified, coalesce(u.two_factor_enabled, false) AS tfa,
              (SELECT count(*)::int FROM auth.passkey p WHERE p.user_id = u.id) AS passkeys,
              (SELECT count(*)::int FROM auth.two_factor f WHERE f.user_id = u.id) AS totp,
              (SELECT count(*)::int FROM auth.account a
                WHERE a.user_id = u.id AND a.provider_id = 'credential') AS passwords,
              (SELECT array_agg(s.id::text ORDER BY s.id) FROM auth.session s
                WHERE s.user_id = u.id) AS sessions
         FROM auth."user" u WHERE u.id = $1`,
      [userId],
    );
    return rows[0];
  }

  /** Someone signed up with the address first, and planted a passkey and TOTP on it. */
  async function plantedAccount(label: string) {
    const user = await newUser(label);
    const { cookie } = await enrolTotp(t.auth, user, PASSWORD);
    const options = await auth('/passkey/generate-register-options', { cookie });
    const { challenge } = options.json() as { challenge: string };
    const origin = new URL(t.publicUrl);
    const planted = await auth('/passkey/verify-registration', {
      cookie: jar(options, cookie),
      body: {
        response: softRegistration(challenge, { id: origin.hostname, origin: origin.origin }),
      },
    });
    expect(planted.statusCode).toBe(200);
    return { ...user, cookie: jar(planted, jar(options, cookie)) };
  }

  async function magicLink(address: string) {
    await auth('/sign-in/magic-link', { body: { email: address } });
    const token = t.auth.mails.at(-1)?.token ?? '';
    return auth('/magic-link/verify', { body: { token } });
  }

  it('removes the planted passkey, TOTP and sessions, keeps the new session, and says so', async () => {
    const user = await plantedAccount('ml-claim');
    const before = await waysIn(user.userId);
    expect(before).toMatchObject({ email_verified: false, tfa: true, passkeys: 1, totp: 1 });

    const confirmed = await magicLink(user.email);
    expect(confirmed.statusCode).toBe(200);
    // Two-factor went with the claim: the new session is whole, not pending.
    expect(confirmed.json()).toEqual({ mfaRequired: false });
    const after = await waysIn(user.userId);
    expect(after).toMatchObject({
      email_verified: true,
      tfa: false,
      passkeys: 0,
      totp: 0,
      // Better Auth removes the password itself when a link proves an unverified address.
      passwords: 0,
    });
    expect(after.sessions).toHaveLength(1);

    // The owner's new session works; the planter's is gone.
    const owner = jar(confirmed);
    expect((await auth('/get-session', { cookie: owner })).json()).toMatchObject({
      user: { id: user.userId },
    });
    expect((await auth('/get-session', { cookie: user.cookie })).json()).toBeNull();
    await vi.waitFor(() =>
      expect(noticesFor(user.email)).toContainEqual({
        email: user.email,
        event: 'unverified-account-link',
      }),
    );
  });

  it('changes nothing on a verified account: its passkey and TOTP stay, and it is asked for them', async () => {
    const user = await plantedAccount('ml-verified');
    await db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [
      user.userId,
    ]);
    const confirmed = await magicLink(user.email);
    expect(confirmed.json()).toEqual({ mfaRequired: true });
    expect(await waysIn(user.userId)).toMatchObject({ tfa: true, passkeys: 1, totp: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(noticesFor(user.email).map((n) => n.event)).not.toContain('unverified-account-link');
  });

  it('claims nothing when the link is used up or unknown', async () => {
    const user = await plantedAccount('ml-bad');
    const bad = await auth('/magic-link/verify', { body: { token: 'not-a-real-token' } });
    expect(bad.statusCode).toBe(400);
    expect(await waysIn(user.userId)).toMatchObject({
      email_verified: false,
      passkeys: 1,
      totp: 1,
    });
  });
});

describe('D197: with mail configured, enrolment waits for a verified address', () => {
  beforeEach(async () => {
    t = await testApp(db, { mailConfigured: true });
  });

  it('refuses TOTP and passkey enrolment on an unverified address, and allows it once verified', async () => {
    const user = await newUser('gate');
    const totp = await auth('/two-factor/enable', {
      cookie: user.cookie,
      body: { password: PASSWORD },
    });
    expect(totp.statusCode).toBe(403);
    expect(totp.json()).toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    const passkey = await auth('/passkey/generate-register-options', { cookie: user.cookie });
    expect(passkey.statusCode).toBe(403);

    await db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [
      user.userId,
    ]);
    expect(
      (await auth('/two-factor/enable', { cookie: user.cookie, body: { password: PASSWORD } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await auth('/passkey/generate-register-options', { cookie: user.cookie })).statusCode,
    ).toBe(200);
  });

  it('leaves managed accounts alone: their synthetic address can never be verified', async () => {
    const user = await newUser('managed-gate');
    await db.pools.auth.query(`UPDATE auth."user" SET email = $1 WHERE id = $2`, [
      `${randomUUID()}@managed.invalid`,
      user.userId,
    ]);
    expect(
      (await auth('/passkey/generate-register-options', { cookie: user.cookie })).statusCode,
    ).toBe(200);
  });
});
