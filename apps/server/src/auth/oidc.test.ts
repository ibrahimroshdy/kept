import { fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cookieHeader,
  enrolTotp,
  PUBLIC_URL,
  requestHeaders,
  signUp,
  testAuth,
} from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type FakeIssuer, startFakeIssuer } from '../../test/oidc-issuer.js';
import { ownerTx, seedTenant } from '../../test/tenancy.js';
import { newInviteToken } from '../invites/token.js';
import { guardedFetch } from '../net/ssrf.js';
import { AUTH_BASE_PATH, type AuthDeps } from './auth.js';
import { createManagedUser } from './managed.js';
import {
  type AuthOidc,
  bootOidc,
  discoverOidc,
  OIDC_PROVIDER_ID,
  oidcCallbackUrl,
  oidcConfigOf,
  oidcStatus,
  setOidcStatus,
} from './oidc.js';
import { resolveSession } from './session.js';

// Generic OIDC sign-in (step-6 plan T16; D127, D128, D176, V32), repeating spike S6.7's cases
// against an in-process fake provider on 127.0.0.1 (test/oidc-issuer.ts): sign-in reaches only an
// explicitly linked account (never on email), linking needs a fresh session and the same email,
// only provider-verified and deliverable emails pass, new users come only by invite or an allowed
// domain or group, the TOTP gate applies, the callback rotates the session, the IdP's tokens
// aren't kept, and every call to the IdP goes through the SSRF guard.

vi.setConfig({ testTimeout: 60_000 });

let db: TestDb;
let idp: FakeIssuer;
let oidc: AuthOidc;
let auth: ReturnType<typeof testAuth>;
/** Every fetch Kept's OIDC code makes (through guardedFetch). */
const guarded: string[] = [];

const recording = (inner: typeof fetch): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    guarded.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    return inner(input, init);
  }) as typeof fetch;

const env = (more: Record<string, unknown> = {}) => ({
  KEPT_PUBLIC_URL: PUBLIC_URL,
  KEPT_OIDC_ISSUER: idp.issuer,
  KEPT_OIDC_CLIENT_ID: idp.clientId,
  KEPT_OIDC_CLIENT_SECRET: idp.clientSecret,
  KEPT_OIDC_NAME: 'Home SSO',
  KEPT_OIDC_AUTOPROVISION_DOMAINS: ['example.org'],
  KEPT_OIDC_AUTOPROVISION_GROUPS: ['kept-family'],
  KEPT_OIDC_GROUPS_CLAIM: 'groups',
  KEPT_OIDC_SCOPES: 'openid email profile',
  ...more,
});

async function call(method: 'GET' | 'POST', pathOrUrl: string, cookie = '', body?: unknown) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${PUBLIC_URL}${AUTH_BASE_PATH}${pathOrUrl}`;
  const headers = requestHeaders(cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await auth.handler(
    new Request(url, { method, headers, body: body === undefined ? null : JSON.stringify(body) }),
  );
  return { res, cookie: cookieHeader(res.headers, cookie) };
}

type Flow = { status: number; error: string | null; location: string | null; cookie: string };

/** `/sign-in/social` (or `/link-social` with a session), the IdP's login as `sub` with
 * `claims`, and the redirect back into Kept's callback. */
async function flow(
  sub: string,
  claims: Record<string, unknown>,
  opts: { cookie?: string; link?: boolean; additionalData?: Record<string, unknown> } = {},
): Promise<Flow> {
  const start = await call('POST', opts.link ? '/link-social' : '/sign-in/social', opts.cookie, {
    provider: OIDC_PROVIDER_ID,
    callbackURL: '/done',
    errorCallbackURL: '/err',
    ...(opts.additionalData ? { additionalData: opts.additionalData } : {}),
  });
  const started = (await start.res.json().catch(() => null)) as {
    url?: string;
    code?: string;
  } | null;
  if (!start.res.ok || !started?.url) {
    return {
      status: start.res.status,
      error: started?.code ?? null,
      location: null,
      cookie: start.cookie,
    };
  }
  idp.login(sub, claims);
  // The browser's hop to the IdP (undici's own fetch: the global one may be a tripwire).
  const authorize = await undiciFetch(started.url, { redirect: 'manual' });
  const back = authorize.headers.get('location');
  if (!back) throw new Error(`the IdP answered ${authorize.status} without a redirect`);
  const cb = await call('GET', back, start.cookie);
  const location = cb.res.headers.get('location');
  const error = location ? new URL(location, PUBLIC_URL).searchParams.get('error') : null;
  return { status: cb.res.status, error, location, cookie: cb.cookie };
}

const authRows = <T>(sql: string, args: unknown[] = []) =>
  db.pools.auth.query(sql, args).then((r) => r.rows as T[]);
const oidcAccounts = (userId?: string) =>
  authRows<{
    user_id: string;
    account_id: string;
    access_token: string | null;
    id_token: string | null;
  }>(
    `SELECT user_id, account_id, access_token, id_token FROM auth.account
      WHERE provider_id = 'oidc' ${userId ? 'AND user_id = $1' : ''}`,
    userId ? [userId] : [],
  );
const userByEmail = async (email: string) =>
  (
    await authRows<{ id: string }>('SELECT id FROM auth."user" WHERE lower(email) = lower($1)', [
      email,
    ])
  )[0] ?? null;
const verify = (userId: string) =>
  db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [userId]);
const sessionUser = async (cookie: string) =>
  (await resolveSession(auth, db.pools.auth, requestHeaders(cookie))).session;

beforeAll(async () => {
  db = await testDb();
  idp = await startFakeIssuer();
});

afterAll(async () => {
  setOidcStatus(null);
  await idp.close();
});

beforeEach(async () => {
  await db.reset();
  guarded.length = 0;
  idp.advertise(idp.issuer);
  const booted = await bootOidc({
    env: env() as Parameters<typeof bootOidc>[0]['env'],
    app: db.pools.app,
    fetch: recording(guardedFetch({ allowPrivate: true })),
    retryForMs: 0,
  });
  if (!booted) throw new Error('OIDC did not boot');
  oidc = booted;
  auth = testAuth(db, { oidc, rateLimitEnabled: false } as Partial<AuthDeps>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discovery and boot (D128, plan Q16)', () => {
  it('runs through the SSRF guard: a loopback issuer is refused unless private addresses are allowed', async () => {
    await expect(
      discoverOidc(idp.issuer, guardedFetch({ allowPrivate: false })),
    ).rejects.toMatchObject({
      reason: 'private_address',
    });
    expect(guarded).toEqual(['GET /kept/.well-known/openid-configuration']);
    expect(oidcStatus()).toEqual({
      configured: true,
      name: 'Home SSO',
      issuer: idp.issuer,
      callbackUrl: `${PUBLIC_URL}/api/v1/auth/callback/oidc`,
      error: null,
    });
    expect(oidcCallbackUrl('https://kept.example.org')).toBe(
      'https://kept.example.org/api/v1/auth/callback/oidc',
    );
  });

  it('refuses an issuer that discovery names differently, and stays off with the reason', async () => {
    idp.advertise(`${idp.issuer}/`);
    const booted = await bootOidc({
      env: env() as Parameters<typeof bootOidc>[0]['env'],
      app: db.pools.app,
      fetch: guardedFetch({ allowPrivate: true }),
      retryForMs: 0,
    });
    expect(booted).toBeNull();
    expect(oidcStatus()).toMatchObject({ configured: true, error: 'issuer_mismatch' });
  });

  it('is off without an issuer', async () => {
    expect(oidcConfigOf({ KEPT_OIDC_CLIENT_ID: 'x' })).toBeNull();
    const booted = await bootOidc({
      env: { KEPT_PUBLIC_URL: PUBLIC_URL },
      app: db.pools.app,
      fetch: guardedFetch({ allowPrivate: true }),
    });
    expect(booted).toBeNull();
    expect(oidcStatus()).toMatchObject({ configured: false, error: null });
  });
});

describe('sign-in and linking (D176)', () => {
  it('never links on email: an existing verified email under a new sub is account_not_linked', async () => {
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    const res = await flow('idp-attacker', { email: 'bruce@example.net', email_verified: true });
    expect(res.error).toBe('account_not_linked');
    expect(await oidcAccounts()).toEqual([]);
  });

  it('links explicitly from a fresh session; that sub then signs in, another sub with the email does not', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('the global fetch was used');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    const linked = await flow(
      'idp-bruce',
      { email: 'bruce@example.net', email_verified: true },
      {
        cookie: bruce.cookie,
        link: true,
      },
    );
    expect(linked.error).toBeNull();
    const [account] = await oidcAccounts(bruce.userId);
    expect(account).toMatchObject({ account_id: 'idp-bruce', access_token: null, id_token: null });

    const signedIn = await flow('idp-bruce', { email: 'bruce@example.net', email_verified: true });
    expect(signedIn.error).toBeNull();
    expect((await sessionUser(signedIn.cookie))?.userId).toBe(bruce.userId);
    // Every call to the IdP went through the guard: the token exchange and the JWKS.
    expect(guarded).toEqual(expect.arrayContaining(['POST /kept/token', 'GET /kept/jwks']));

    const other = await flow('idp-other', { email: 'bruce@example.net', email_verified: true });
    expect(other.error).toBe('account_not_linked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a link from a session older than ten minutes, and one whose IdP email differs', async () => {
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    const different = await flow(
      'idp-bruce',
      { email: 'someone@example.net', email_verified: true },
      {
        cookie: bruce.cookie,
        link: true,
      },
    );
    expect(different.error).toBe('email_does_not_match');
    await db.pools.auth.query(
      `UPDATE auth.session SET created_at = now() - interval '11 minutes' WHERE user_id = $1`,
      [bruce.userId],
    );
    const stale = await flow(
      'idp-bruce',
      { email: 'bruce@example.net', email_verified: true },
      {
        cookie: bruce.cookie,
        link: true,
      },
    );
    expect(stale).toMatchObject({ status: 403, error: 'SESSION_NOT_FRESH' });
    expect(await oidcAccounts()).toEqual([]);
  });

  it('rotates the previous session at the callback, and keeps the TOTP gate (V32)', async () => {
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    await flow(
      'idp-bruce',
      { email: 'bruce@example.net', email_verified: true },
      {
        cookie: bruce.cookie,
        link: true,
      },
    );
    const before = await sessionUser(bruce.cookie);
    expect(before).not.toBeNull();
    const again = await flow(
      'idp-bruce',
      { email: 'bruce@example.net', email_verified: true },
      {
        cookie: bruce.cookie,
      },
    );
    expect((await sessionUser(again.cookie))?.userId).toBe(bruce.userId);
    expect(await sessionUser(bruce.cookie)).toBeNull();

    const ibrahim = await signUp(auth, 'ibrahim@example.net');
    await verify(ibrahim.userId);
    const { cookie } = await enrolTotp(auth, ibrahim);
    await flow(
      'idp-ibrahim',
      { email: 'ibrahim@example.net', email_verified: true },
      {
        cookie,
        link: true,
      },
    );
    const viaIdp = await flow('idp-ibrahim', {
      email: 'ibrahim@example.net',
      email_verified: true,
    });
    expect(await sessionUser(viaIdp.cookie)).toMatchObject({
      userId: ibrahim.userId,
      twoFactorEnabled: true,
      mfa: false,
      mfaPending: true,
    });
    expect((await sessionUser(again.cookie))?.mfa).toBe(false);
  });
});

describe('the provisioning gate (D127, D176)', () => {
  it('refuses an email the IdP hasn’t verified, however the claim is dressed', async () => {
    for (const claims of [
      { email: 'talia@example.org', email_verified: false },
      { email: 'talia@example.org' },
      { email: 'talia@example.org', email_verified: 'true' },
      { email: 'talia@example.org', email_verified: false, emailVerified: true },
    ]) {
      expect((await flow('idp-talia', claims)).error).toBe('email_unverified');
    }
    expect(await userByEmail('talia@example.org')).toBeNull();
  });

  it('refuses a .invalid address even from an allowed group', async () => {
    const res = await flow('idp-x', {
      email: 'SOMEONE@Example.INVALID',
      email_verified: true,
      groups: ['kept-family'],
    });
    expect(res.error).toBe('email_undeliverable');
  });

  it('autoprovisions an exact allowed domain or group, and nobody else', async () => {
    expect(
      (await flow('idp-talia', { email: 'talia@example.org', email_verified: true })).error,
    ).toBeNull();
    expect(await userByEmail('talia@example.org')).not.toBeNull();
    expect(
      (await flow('idp-peter', { email: 'Peter@EXAMPLE.ORG', email_verified: true })).error,
    ).toBeNull();
    for (const email of [
      'x@example.com',
      'x@evil-example.org',
      'x@example.org.evil.net',
      'x@sub.example.org',
    ]) {
      expect((await flow(`idp-${email}`, { email, email_verified: true })).error).toBe(
        'signup_closed',
      );
      expect(await userByEmail(email)).toBeNull();
    }
    expect(
      (
        await flow('idp-louis', {
          email: 'louis@example.net',
          email_verified: true,
          groups: 'kept-family',
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await flow('idp-g', {
          email: 'g@example.net',
          email_verified: true,
          roles: ['kept-family'],
        })
      ).error,
    ).toBe('signup_closed');
  });

  it('lets an invited person in, holds the invite for their address, and ignores a forged one', async () => {
    const ibrahim = await seedTenant(db, 'oidc-ibrahim', { name: 'Home' });
    const { token, hash } = newInviteToken();
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.invites (location_id, role, email, token_hash, expires_at, created_by)
         VALUES ($1, 'member', 'murdock@example.net', $2, now() + interval '7 days', $3)`,
        [ibrahim.locationId, hash, ibrahim.userId],
      ),
    );
    const mismatch = await flow(
      'idp-m2',
      { email: 'matt@example.net', email_verified: true },
      {
        additionalData: { inviteToken: token },
      },
    );
    expect(mismatch.error).toBe('invite_email_mismatch');
    const forged = await flow(
      'idp-f',
      { email: 'f@example.net', email_verified: true },
      {
        additionalData: {
          keptInvite: { tokenHash: hash, emailBound: false },
          serverContext: { keptInvite: { tokenHash: hash } },
        },
      },
    );
    expect(forged.error).toBe('signup_closed');
    const ok = await flow(
      'idp-murdock',
      { email: 'murdock@example.net', email_verified: true },
      {
        additionalData: { inviteToken: token },
      },
    );
    expect(ok.error).toBeNull();
    expect(await userByEmail('murdock@example.net')).not.toBeNull();
    const [invite] = await ownerTx(
      db,
      async (c) =>
        (await c.query('SELECT claimed_email FROM public.invites WHERE token_hash = $1', [hash]))
          .rows,
    );
    expect(invite).toEqual({ claimed_email: 'murdock@example.net' });
  });

  it('leaves managed accounts and password sign-up alone', async () => {
    const managed = await createManagedUser(auth, {
      username: 'peter',
      displayName: 'Peter',
      password: 'correct horse battery',
    });
    expect(managed.email).toMatch(/@managed\.invalid$/);
    expect((await signUp(auth, 'louis@example.net')).userId).toBeTruthy();
  });
});
