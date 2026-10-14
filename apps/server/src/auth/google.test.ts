import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookieHeader, PUBLIC_URL, requestHeaders, signUp, testAuth } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { AUTH_BASE_PATH, type AuthDeps } from './auth.js';
import { GOOGLE_PROVIDER_ID, googleCallbackUrl, googleConfigOf } from './google.js';
import { oidcInvites } from './oidc.js';
import { resolveSession } from './session.js';

// Google sign-in (1.2, D226): Better Auth's Google provider under Kept's outside-identity rules
// (auth/oidc.ts). Google itself can't be reached from a test, so its token endpoint is stubbed:
// the browser's hop to Google is skipped, and Kept's callback is called the way Google would
// redirect to it, with the `state` Kept issued. What Google answers is an id token with the
// claims each case needs (Better Auth reads them from the token Google's endpoint returned).

const CLIENT_ID = '1234.apps.googleusercontent.com';

let db: TestDb;
let auth: ReturnType<typeof testAuth>;

beforeAll(async () => {
  db = await testDb();
});

beforeEach(async () => {
  await db.reset();
  auth = testAuth(db, {
    google: {
      clientId: CLIENT_ID,
      clientSecret: 'google-secret',
      invites: oidcInvites(db.pools.app),
    },
    rateLimitEnabled: false,
  } as Partial<AuthDeps>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Google's token endpoint, answering with an id token for `claims`; anything else is refused. */
function google(claims: Record<string, unknown>) {
  const idToken = `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.sig`;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

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

type Flow = { status: number; error: string | null; cookie: string; started: URL | null };

/** `/sign-in/social` (or `/link-social` with a session) for Google, then Google's redirect back. */
async function flow(
  claims: Record<string, unknown>,
  opts: { cookie?: string; link?: boolean } = {},
): Promise<Flow> {
  google(claims);
  const start = await call('POST', opts.link ? '/link-social' : '/sign-in/social', opts.cookie, {
    provider: GOOGLE_PROVIDER_ID,
    callbackURL: '/done',
    errorCallbackURL: '/err',
  });
  const started = (await start.res.json().catch(() => null)) as {
    url?: string;
    code?: string;
  } | null;
  if (!start.res.ok || !started?.url) {
    return {
      status: start.res.status,
      error: started?.code ?? null,
      cookie: start.cookie,
      started: null,
    };
  }
  const at = new URL(started.url);
  const state = at.searchParams.get('state') ?? '';
  const back = `${googleCallbackUrl(PUBLIC_URL)}?code=google-code&state=${encodeURIComponent(state)}`;
  const cb = await call('GET', back, start.cookie);
  const location = cb.res.headers.get('location');
  const error = location ? new URL(location, PUBLIC_URL).searchParams.get('error') : null;
  return { status: cb.res.status, error, cookie: cb.cookie, started: at };
}

const googleAccounts = (userId?: string) =>
  db.pools.auth
    .query<{ user_id: string; account_id: string; access_token: string | null }>(
      `SELECT user_id, account_id, access_token FROM auth.account
        WHERE provider_id = 'google' ${userId ? 'AND user_id = $1' : ''}`,
      userId ? [userId] : [],
    )
    .then((r) => r.rows);
const verify = (userId: string) =>
  db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [userId]);
const stale = (userId: string) =>
  db.pools.auth.query(
    `UPDATE auth.session SET created_at = now() - interval '11 minutes' WHERE user_id = $1`,
    [userId],
  );

describe('Google sign-in (D226)', () => {
  it('reads its client from the environment, both halves or nothing', () => {
    expect(
      googleConfigOf({ KEPT_GOOGLE_CLIENT_ID: CLIENT_ID, KEPT_GOOGLE_CLIENT_SECRET: 's' }),
    ).toEqual({ clientId: CLIENT_ID, clientSecret: 's' });
    expect(googleConfigOf({ KEPT_GOOGLE_CLIENT_ID: CLIENT_ID })).toBeNull();
    expect(googleCallbackUrl('https://kept.example')).toBe(
      'https://kept.example/api/v1/auth/callback/google',
    );
  });

  it('starts at Google with PKCE, Kept’s callback, and an account chooser', async () => {
    const start = await call('POST', '/sign-in/social', '', {
      provider: GOOGLE_PROVIDER_ID,
      callbackURL: '/done',
    });
    const { url } = (await start.res.json()) as { url: string };
    const at = new URL(url);
    expect(at.origin + at.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(at.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(at.searchParams.get('redirect_uri')).toBe(googleCallbackUrl(PUBLIC_URL));
    expect(at.searchParams.get('code_challenge_method')).toBe('S256');
    expect(at.searchParams.get('prompt')).toBe('select_account');
  });

  it('lets nobody new in without an invite: Google never autoprovisions', async () => {
    const res = await flow({ sub: 'g-new', email: 'new@gmail.example', email_verified: true });
    expect(res.error).toBe('signup_closed');
    expect(await googleAccounts()).toEqual([]);
  });

  it('refuses an address Google hasn’t verified, and a .invalid one', async () => {
    expect(
      (await flow({ sub: 'g-1', email: 'someone@gmail.example', email_verified: false })).error,
    ).toBe('email_unverified');
    expect(
      (await flow({ sub: 'g-2', email: 'kid@managed.invalid', email_verified: true })).error,
    ).toBe('email_undeliverable');
  });

  it('never links on email; links from a fresh session, keeps no Google token, then signs in', async () => {
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    const unlinked = await flow({
      sub: 'g-bruce',
      email: 'bruce@example.net',
      email_verified: true,
    });
    expect(unlinked.error).toBe('account_not_linked');

    const linked = await flow(
      { sub: 'g-bruce', email: 'bruce@example.net', email_verified: true },
      { cookie: bruce.cookie, link: true },
    );
    expect(linked.error).toBeNull();
    expect(await googleAccounts(bruce.userId)).toEqual([
      { user_id: bruce.userId, account_id: 'g-bruce', access_token: null },
    ]);

    const signedIn = await flow({
      sub: 'g-bruce',
      email: 'bruce@example.net',
      email_verified: true,
    });
    expect(signedIn.error).toBeNull();
    expect(
      (await resolveSession(auth, db.pools.auth, requestHeaders(signedIn.cookie))).session?.userId,
    ).toBe(bruce.userId);
  });

  it('links and unlinks only from a session younger than ten minutes', async () => {
    const bruce = await signUp(auth, 'bruce@example.net');
    await verify(bruce.userId);
    await flow(
      { sub: 'g-bruce', email: 'bruce@example.net', email_verified: true },
      { cookie: bruce.cookie, link: true },
    );
    const rowId = (
      await db.pools.auth.query<{ id: string }>(
        `SELECT id FROM auth.account WHERE provider_id = 'google' AND user_id = $1`,
        [bruce.userId],
      )
    ).rows[0]?.id;
    await stale(bruce.userId);
    const late = await flow(
      { sub: 'g-bruce-2', email: 'bruce@example.net', email_verified: true },
      { cookie: bruce.cookie, link: true },
    );
    expect(late).toMatchObject({ status: 403, error: 'SESSION_NOT_FRESH' });

    // Better Auth's `accountId` here is its own row id, not Google's subject.
    const unlink = await call('POST', '/unlink-account', bruce.cookie, { accountId: rowId });
    expect(unlink.res.status).toBe(403);
    expect(((await unlink.res.json()) as { code: string }).code).toBe('SESSION_NOT_FRESH');
    expect(await googleAccounts(bruce.userId)).toHaveLength(1);

    await db.pools.auth.query(`UPDATE auth.session SET created_at = now() WHERE user_id = $1`, [
      bruce.userId,
    ]);
    const fresh = await call('POST', '/unlink-account', bruce.cookie, { accountId: rowId });
    expect(fresh.res.status, await fresh.res.clone().text()).toBe(200);
    expect(await googleAccounts(bruce.userId)).toEqual([]);
  });
});
