import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { cookieHeader, requestHeaders, signUp, type TestAuth, testAuth } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { hashVerificationIdentifier } from './auth.js';
import {
  createManagedUser,
  issueResetCode,
  ManagedAccountError,
  normaliseResetCode,
  RESET_CODE_LENGTH,
  redeemResetCode,
} from './managed.js';
import { FREE_FAILURES } from './sign-in-limiter.js';

// Spike S3 (V14): managed accounts: a synthetic `.invalid` email, username sign-in, no magic
// link, and an admin-issued one-time reset code (D47, D93, D164).

const PASSWORD = 'first password 1';
const NEW_PASSWORD = 'second password 2';

describe('managed accounts', () => {
  let db: TestDb;
  let auth: TestAuth;
  let username: string;

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
    auth = testAuth(db, { rateLimitEnabled: false });
    username = `Kid_${randomUUID().slice(0, 8)}`;
  });

  const signIn = (password: string, name = username) =>
    auth.api.signInUsername({
      body: { username: name, password },
      headers: requestHeaders(),
      returnHeaders: true,
    });

  const sessions = async (userId: string) =>
    (
      await db.pools.auth.query('SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1', [
        userId,
      ])
    ).rows[0].n as number;

  it('Better Auth accepts a synthetic .invalid email and a username', async () => {
    const created = await createManagedUser(auth, {
      username,
      displayName: 'Kid',
      password: PASSWORD,
    });
    expect(created.email).toMatch(/^[0-9a-f-]{36}@managed\.invalid$/);
    expect(created.username).toBe(username.toLowerCase());

    const { rows } = await db.pools.auth.query(
      'SELECT email, username, display_username, name FROM auth."user" WHERE id = $1',
      [created.userId],
    );
    expect(rows).toEqual([
      {
        email: created.email,
        username: username.toLowerCase(),
        display_username: username,
        name: 'Kid',
      },
    ]);
  });

  it('signs in by username and password, case-insensitively', async () => {
    const { userId } = await createManagedUser(auth, {
      username,
      displayName: 'Kid',
      password: PASSWORD,
    });
    const { response } = await signIn(PASSWORD, username.toUpperCase());
    expect(response.user.id).toBe(userId);
  });

  it('usernames are unique per instance', async () => {
    await createManagedUser(auth, { username, displayName: 'One', password: PASSWORD });
    await expect(
      createManagedUser(auth, {
        username: username.toLowerCase(),
        displayName: 'Two',
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ body: { code: 'USERNAME_IS_ALREADY_TAKEN' } });
  });

  it('never mails a magic link to a .invalid address', async () => {
    const { email } = await createManagedUser(auth, {
      username,
      displayName: 'Kid',
      password: PASSWORD,
    });
    await expect(
      auth.api.signInMagicLink({ body: { email }, headers: requestHeaders() }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'EMAIL_UNDELIVERABLE' } });
    expect(auth.mails).toEqual([]);
  });

  it('refuses .invalid addresses from people: sign-up', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: `${randomUUID()}@managed.invalid`, password: PASSWORD, name: 'Mallory' },
        headers: requestHeaders(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'EMAIL_UNDELIVERABLE' } });
  });

  it('refuses .invalid addresses from people: change-email', async () => {
    const person = await signUp(auth, `p-${randomUUID()}@example.com`, PASSWORD);
    await expect(
      auth.api.changeEmail({
        body: { newEmail: `${randomUUID()}@managed.invalid` },
        headers: requestHeaders(person.cookie),
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'EMAIL_UNDELIVERABLE' } });
  });

  it('refuses to issue a reset code for an account that is not managed', async () => {
    const person = await signUp(auth, `p-${randomUUID()}@example.com`, PASSWORD);
    await expect(issueResetCode(auth, person.userId)).rejects.toMatchObject({
      code: 'not_managed',
    });
    await expect(issueResetCode(auth, randomUUID())).rejects.toMatchObject({
      code: 'not_managed',
    });
    // Nothing was stored and nobody was signed out.
    const { rows } = await db.pools.auth.query(
      `SELECT count(*)::int AS n FROM auth.verification WHERE identifier = $1`,
      [await hashVerificationIdentifier(`managed-reset:${person.userId}`)],
    );
    expect(rows[0].n).toBe(0);
    expect(await sessions(person.userId)).toBe(1);
  });

  describe('admin reset code (D164)', () => {
    let userId: string;

    beforeEach(async () => {
      ({ userId } = await createManagedUser(auth, {
        username,
        displayName: 'Kid',
        password: PASSWORD,
      }));
    });

    it('is an 8-character code, stored only as a hash, that signs the account out', async () => {
      await signIn(PASSWORD);
      expect(await sessions(userId)).toBe(1);

      const code = await issueResetCode(auth, userId);
      expect(code).toMatch(new RegExp(`^[0-9A-HJKMNP-TV-Z]{${RESET_CODE_LENGTH}}$`));
      expect(await sessions(userId)).toBe(0);

      const { rows } = await db.pools.auth.query(
        `SELECT value, expires_at - now() AS ttl FROM auth.verification WHERE identifier = $1`,
        [await hashVerificationIdentifier(`managed-reset:${userId}`)],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].value).not.toContain(code);
      expect(rows[0].value).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].ttl.minutes).toBeGreaterThanOrEqual(29);
    });

    it('sets the new password, signs out every session, and works exactly once', async () => {
      const code = await issueResetCode(auth, userId);
      // A session made between issue and redeem (with the old password) is signed out too.
      const between = await signIn(PASSWORD);
      const cookie = cookieHeader(between.headers);

      await expect(
        redeemResetCode(auth, db.pools.auth, {
          username,
          code: code.toLowerCase(),
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.7',
        }),
      ).resolves.toEqual({ userId });

      expect(await auth.api.getSession({ headers: requestHeaders(cookie) })).toBeNull();
      await expect(signIn(PASSWORD)).rejects.toMatchObject({ statusCode: 401 });
      await expect(signIn(NEW_PASSWORD)).resolves.toMatchObject({
        response: { user: { id: userId } },
      });

      await expect(
        redeemResetCode(auth, db.pools.auth, {
          username,
          code,
          newPassword: 'third password 3',
          ip: '203.0.113.7',
        }),
      ).rejects.toMatchObject({ code: 'invalid_code' });
    });

    it('refuses a wrong code, then delays repeated guesses', async () => {
      const code = await issueResetCode(auth, userId);
      const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
      const attempt = (c: string) =>
        redeemResetCode(auth, db.pools.auth, {
          username,
          code: c,
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.8',
        });
      for (let i = 0; i < 5; i++) {
        await expect(attempt(wrong)).rejects.toBeInstanceOf(ManagedAccountError);
      }
      await expect(attempt(code)).rejects.toMatchObject({ code: 'code_delayed' });
      // The right code still works once the delay passes: guesses don't burn it.
      await db.pools.auth.query(
        `UPDATE auth.sign_in_failures SET last_failure_at = now() - interval '10 minutes'`,
      );
      await expect(attempt(code)).resolves.toEqual({ userId });
    });

    it('accepts Crockford look-alikes: O for 0, I and L for 1', async () => {
      expect(normaliseResetCode(' o1il-2k0 ')).toBe('01112K0');
      let code = await issueResetCode(auth, userId);
      // Make sure the code has a 0 or a 1 to mistype.
      for (let i = 0; i < 100 && !/[01]/.test(code); i++) code = await issueResetCode(auth, userId);
      expect(code).toMatch(/[01]/);
      const typed = code.replace(/0/g, 'O').replace(/1/g, 'l').toLowerCase();
      await expect(
        redeemResetCode(auth, db.pools.auth, {
          username,
          code: `${typed.slice(0, 4)}-${typed.slice(4)}`,
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.11',
        }),
      ).resolves.toEqual({ userId });
    });

    it('two redeems racing: exactly one wins', async () => {
      const code = await issueResetCode(auth, userId);
      const results = await Promise.allSettled(
        ['one password 1', 'two password 2'].map((newPassword) =>
          redeemResetCode(auth, db.pools.auth, { username, code, newPassword, ip: '203.0.113.12' }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: 'invalid_code' }) }),
      ]);
    });

    it('30 parallel wrong codes never get more than the free attempts', async () => {
      const code = await issueResetCode(auth, userId);
      const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () =>
          redeemResetCode(auth, db.pools.auth, {
            username,
            code: wrong,
            newPassword: NEW_PASSWORD,
            ip: '203.0.113.13',
          }),
        ),
      );
      const codes = results.map((r) =>
        r.status === 'rejected' ? (r.reason as ManagedAccountError).code : 'ok',
      );
      expect(codes.filter((c) => c === 'invalid_code')).toHaveLength(FREE_FAILURES + 1);
      expect(codes.filter((c) => c === 'code_delayed')).toHaveLength(30 - (FREE_FAILURES + 1));
    });

    it('an unknown username fails exactly like a wrong code', async () => {
      await expect(
        redeemResetCode(auth, db.pools.auth, {
          username: `nobody_${randomUUID().slice(0, 8)}`,
          code: 'ABCD2345',
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.14',
        }),
      ).rejects.toMatchObject({ code: 'invalid_code' });
    });

    it('expires after 30 minutes', async () => {
      const code = await issueResetCode(auth, userId);
      const owner = new pg.Client({ connectionString: db.urls.owner });
      await owner.connect();
      try {
        await owner.query(
          `UPDATE auth.verification SET expires_at = now() - interval '1 second'
            WHERE identifier = $1`,
          [await hashVerificationIdentifier(`managed-reset:${userId}`)],
        );
      } finally {
        await owner.end();
      }
      await expect(
        redeemResetCode(auth, db.pools.auth, {
          username,
          code,
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.9',
        }),
      ).rejects.toMatchObject({ code: 'invalid_code' });
    });

    it('a new code replaces the old one', async () => {
      const first = await issueResetCode(auth, userId);
      const second = await issueResetCode(auth, userId);
      const redeem = (code: string) =>
        redeemResetCode(auth, db.pools.auth, {
          username,
          code,
          newPassword: NEW_PASSWORD,
          ip: '203.0.113.10',
        });
      if (first !== second)
        await expect(redeem(first)).rejects.toMatchObject({ code: 'invalid_code' });
      await expect(redeem(second)).resolves.toEqual({ userId });
    });
  });
});
