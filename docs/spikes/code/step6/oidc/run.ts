/**
 * Spike S6.7 runner: generic OIDC against a local mock provider. Throwaway; never imported by apps/.
 *
 * Needs:
 * - the dev database container on localhost:5452 (kept-dev-db-1). A scratch database
 *   `kept_spike6_oidc` is created as kept_owner, migrated, and dropped at the end;
 * - the mock provider (ghcr.io/navikt/mock-oauth2-server:6.0.4, digest in the spike doc):
 *     DOCKER_CONFIG=/tmp/kept-docker-config docker run -d --name kept-spike6-oidc \
 *       -p 127.0.0.1:18790:8080 ghcr.io/navikt/mock-oauth2-server:6.0.4@sha256:47374fe0…
 * - KEPT_SPIKE_MIGRATIONS: a folder holding `git archive HEAD apps/server/migrations` (so another
 *   agent's uncommitted migration is never applied).
 * - node_modules here (deleted after the run; recreate it): symlinks, never an install, so this
 *   code loads the same module instances as the apps/server files it imports:
 *     better-auth drizzle-orm pg uuid undici tsx typescript @types @better-auth/passkey
 *       -> ../../../../../apps/server/node_modules/<name>
 *     jose -> <repo>/node_modules/.pnpm/jose@6.2.12/node_modules/jose   (better-auth's own copy)
 *     @better-auth/core -> better-auth 1.7.6's @better-auth/core in <repo>/node_modules/.pnpm
 *
 * Run (from this folder): PATH=/opt/homebrew/opt/node@24/bin:$PATH KEPT_SPIKE_MIGRATIONS=<dir> \
 *        node node_modules/tsx/dist/cli.mjs run.ts
 *
 * The client secret and the auth secret are generated here, in-process; nothing is written but
 * results-2026-09-30.jsonl (no cookies, tokens or secrets).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { getAuthTables } from '@better-auth/core/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fetch as undiciFetch } from 'undici';
import { createManagedUser } from '../../../../../apps/server/src/auth/managed.js';
import { gateSession, resolveSession } from '../../../../../apps/server/src/auth/session.js';
import { guardedFetch, PrivateAddressError } from '../../../../../apps/server/src/net/ssrf.js';
import {
  cookieHeader,
  enrolTotp,
  requestHeaders,
  signUp,
} from '../../../../../apps/server/test/auth.js';
import { totp } from '../../../../../apps/server/test/auth.js';
import { AUTH_BASE_PATH, createAuth } from './auth.js';
import {
  discoverOidc,
  type KeptInvite,
  OIDC_PROVIDER_ID,
  oidcProvider,
  readOidcEnv,
} from './oidc.js';

const PUBLIC_URL = 'http://localhost:5173'; // what test/auth.ts's requestHeaders sends as Origin
const DB_PORT = 5452;
const DB = 'kept_spike6_oidc';
const ISSUER = 'http://127.0.0.1:18790/kept';
const MIGRATIONS = process.env.KEPT_SPIKE_MIGRATIONS;
if (!MIGRATIONS) throw new Error('set KEPT_SPIKE_MIGRATIONS');

const superUrl = `postgres://postgres:postgres@localhost:${DB_PORT}/postgres`;
const roleUrl = (role: string) => `postgres://kept_${role}:kept_${role}@localhost:${DB_PORT}/${DB}`;

type Result = { check: string; case: string; pass: boolean; evidence: unknown };
const results: Result[] = [];
function record(check: string, name: string, pass: boolean, evidence: unknown) {
  results.push({ check, case: name, pass, evidence });
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  [${check}] ${name}  ${JSON.stringify(evidence)}\n`,
  );
}

// --- the fetch tripwire: anything that uses the global fetch during a run is recorded and fails
const realFetch = globalThis.fetch;
const unguarded: string[] = [];
function tripwire(on: boolean) {
  globalThis.fetch = on
    ? ((async (input: string | URL | Request) => {
        const u = input instanceof Request ? input.url : String(input);
        unguarded.push(u);
        throw new Error(`unguarded fetch: ${u}`);
      }) as typeof fetch)
    : realFetch;
}

// --- every fetch Kept's OIDC code makes, through the SSRF guard
const guarded: string[] = [];
function recording(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    guarded.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    return inner(input, init);
  }) as typeof fetch;
}

// --- a browser, cut down: cookies for Kept, a form post at the mock's login page
type Auth = ReturnType<typeof createAuth>;
async function call(
  auth: Auth,
  method: 'GET' | 'POST',
  pathOrUrl: string,
  opts: { cookie?: string; body?: unknown } = {},
) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${PUBLIC_URL}${AUTH_BASE_PATH}${pathOrUrl}`;
  const headers = requestHeaders(opts.cookie ?? '');
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  const res = await auth.handler(
    new Request(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  return { res, cookie: cookieHeader(res.headers, opts.cookie ?? '') };
}

type Flow = {
  status: number;
  location: string | null;
  error: string | null;
  cookie: string;
  start?: unknown;
};

/** Starts `/sign-in/social` (or `/link-social` with a session cookie), logs in at the mock as
 * `sub` with `claims`, and follows the redirect back into Kept's callback. */
async function oidcFlow(
  auth: Auth,
  sub: string,
  claims: Record<string, unknown>,
  opts: {
    cookie?: string;
    link?: boolean;
    additionalData?: Record<string, unknown>;
    body?: object;
  } = {},
): Promise<Flow> {
  const start = await call(auth, 'POST', opts.link ? '/link-social' : '/sign-in/social', {
    cookie: opts.cookie,
    body: {
      provider: OIDC_PROVIDER_ID,
      callbackURL: '/done',
      errorCallbackURL: '/err',
      ...(opts.additionalData ? { additionalData: opts.additionalData } : {}),
      ...opts.body,
    },
  });
  const started = (await start.res.json().catch(() => null)) as { url?: string } | null;
  if (!start.res.ok || !started?.url) {
    return {
      status: start.res.status,
      location: null,
      error: null,
      cookie: start.cookie,
      start: started,
    };
  }
  const authorize = new URL(started.url);
  const login = await undiciFetch(authorize, {
    method: 'POST',
    body: new URLSearchParams({ username: sub, claims: JSON.stringify(claims) }),
    redirect: 'manual',
  });
  const back = login.headers.get('location');
  if (!back) throw new Error(`mock answered ${login.status} with no redirect`);
  const cb = await call(auth, 'GET', back, { cookie: start.cookie });
  const location = cb.res.headers.get('location');
  const error = location ? new URL(location, PUBLIC_URL).searchParams.get('error') : null;
  return {
    status: cb.res.status,
    location,
    error,
    cookie: cb.cookie,
    start: {
      scope: authorize.searchParams.get('scope'),
      nonce: authorize.searchParams.has('nonce'),
      pkce: authorize.searchParams.get('code_challenge_method'),
    },
  };
}

async function main() {
  const admin = new pg.Client({ connectionString: superUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB} OWNER kept_owner`);
  const owner = new pg.Client({ connectionString: roleUrl('owner') });
  await owner.connect();
  await migrate(drizzle(owner), {
    migrationsFolder: MIGRATIONS as string,
    migrationsTable: 'migrations',
    migrationsSchema: 'kept_meta',
  });
  await owner.end();
  const authPool = new pg.Pool({ connectionString: roleUrl('auth'), max: 4 });
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ) => (await authPool.query<T>(sql, args)).rows;
  const userByEmail = async (email: string) =>
    (
      await q<{ id: string; email_verified: boolean }>(
        'SELECT id, email_verified FROM auth."user" WHERE email = $1',
        [email],
      )
    )[0] ?? null;
  const oidcAccounts = async (userId?: string) =>
    q<{
      user_id: string;
      account_id: string;
      access_token: string | null;
      refresh_token: string | null;
      id_token: string | null;
    }>(
      `SELECT user_id, account_id, access_token, refresh_token, id_token FROM auth.account
        WHERE provider_id = $1 ${userId ? 'AND user_id = $2' : ''}`,
      userId ? [OIDC_PROVIDER_ID, userId] : [OIDC_PROVIDER_ID],
    );
  const verify = (userId: string) =>
    q('UPDATE auth."user" SET email_verified = true WHERE id = $1', [userId]);

  const created: string[] = [];
  const seenPaths: string[] = [];
  const invites = new Map<string, KeptInvite>([
    ['invite-murdock', { id: 'inv-1', email: 'murdock@example.com' }],
  ]);
  const clientSecret = randomBytes(24).toString('base64url');
  const env = {
    KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
    KEPT_PUBLIC_URL: PUBLIC_URL,
  };
  const mail = {
    sendMagicLink: async () => {},
    sendPasswordReset: async () => {},
    sendSecurityNotice: async () => {},
  };

  try {
    // =========================================================================================
    // Check 6 first: discovery through the SSRF guard (D128)
    // =========================================================================================
    const cfg = readOidcEnv({
      KEPT_OIDC_ISSUER: ISSUER,
      KEPT_OIDC_CLIENT_ID: 'kept-spike',
      KEPT_OIDC_CLIENT_SECRET: clientSecret,
      KEPT_OIDC_NAME: 'Spike IdP',
      KEPT_OIDC_AUTOPROVISION_DOMAINS: 'example.org',
      KEPT_OIDC_AUTOPROVISION_GROUPS: 'kept-family',
    });
    if (!cfg) throw new Error('no config');

    tripwire(true);
    try {
      await discoverOidc(cfg.issuer, guardedFetch({ allowPrivate: false }));
      record('6', 'loopback issuer, allowPrivate false', false, 'discovery succeeded');
    } catch (e) {
      record('6', 'loopback issuer, allowPrivate false', e instanceof PrivateAddressError, {
        error: (e as Error).name,
        code: (e as { code?: string }).code,
      });
    }
    try {
      // A name that resolves to loopback: refused at connect time (the guard's `resolve` stub
      // stands in for DNS, so no real lookup is made).
      await discoverOidc(
        'http://idp.kept.test:18790/kept',
        guardedFetch({
          allowPrivate: false,
          resolve: (_h, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
        }),
      );
      record(
        '6',
        'hostname resolving to 127.0.0.1, allowPrivate false',
        false,
        'discovery succeeded',
      );
    } catch (e) {
      record(
        '6',
        'hostname resolving to 127.0.0.1, allowPrivate false',
        e instanceof PrivateAddressError,
        {
          error: (e as Error).name,
        },
      );
    }
    // The self-host switch (instance_settings.ssrf_allow_private): the only way to reach a
    // provider on this laptop's loopback.
    const fetchImpl = recording(guardedFetch({ allowPrivate: true }));
    const discovery = await discoverOidc(cfg.issuer, fetchImpl);
    record(
      '6',
      'discovery with allowPrivate true, through guardedFetch',
      guarded.length === 1 && unguarded.length === 0,
      {
        guarded: [...guarded],
        unguarded: [...unguarded],
        issuer: discovery.issuer,
      },
    );
    try {
      await discoverOidc(`${ISSUER}/`, fetchImpl);
      record('6', 'issuer mismatch refused (trailing slash)', false, 'accepted');
    } catch (e) {
      record(
        '6',
        'issuer mismatch refused (trailing slash)',
        (e as { reason?: string }).reason === 'issuer_mismatch',
        { reason: (e as { reason?: string }).reason },
      );
    }

    // Stock genericOAuth with `discoveryUrl`, for comparison: what does it fetch with?
    unguarded.length = 0;
    const stockTripped = createAuth({
      pool: authPool,
      env,
      mail,
      rateLimitEnabled: false,
      oidc: {
        config: cfg,
        keptRules: false,
        findInvite: async () => null,
        provider: {
          providerId: OIDC_PROVIDER_ID,
          clientId: cfg.clientId,
          clientSecret,
          discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
          scopes: ['openid', 'email', 'profile'],
        },
      },
    });
    const stockCtx = await stockTripped.$context;
    record(
      '6',
      'stock genericOAuth discoveryUrl uses the global fetch (unguarded)',
      unguarded.length > 0,
      {
        unguardedFetches: [...unguarded],
        providerRegistered: stockCtx.socialProviders.some((p) => p.id === OIDC_PROVIDER_ID),
      },
    );
    unguarded.length = 0;

    // =========================================================================================
    // Kept's instance: explicit endpoints, every back-channel call through guardedFetch
    // =========================================================================================
    const auth = createAuth({
      pool: authPool,
      env,
      mail,
      rateLimitEnabled: false,
      onUserCreated: async (u) => {
        created.push(u.email);
      },
      oidc: {
        config: cfg,
        provider: oidcProvider(cfg, discovery, fetchImpl),
        findInvite: async (token) => invites.get(token) ?? null,
        seenPaths,
        rotateOnCallback: true,
      },
    });
    await auth.$context;

    // Cast: Bruce (password, verified), Ibrahim (password, verified, TOTP), Louis (stale session)
    const bruce = await signUp(auth as never, 'bruce@example.com');
    await verify(bruce.userId);
    const ibrahim = await signUp(auth as never, 'ibrahim@example.com');
    await verify(ibrahim.userId);
    const louis = await signUp(auth as never, 'louis@example.com');
    await verify(louis.userId);
    const V = (email: string, extra: Record<string, unknown> = {}) => ({
      email,
      email_verified: true,
      ...extra,
    });

    // ---------------- Check 1: no auto-link on email (D176, D127) ----------------
    guarded.length = 0;
    let f = await oidcFlow(auth, 'idp-bruce', V('bruce@example.com'));
    record(
      '1',
      'IdP asserts an existing verified email, not linked: refused',
      f.error === 'account_not_linked' && (await oidcAccounts()).length === 0,
      {
        error: f.error,
        location: f.location,
        authorizeRequest: f.start,
        oidcAccounts: (await oidcAccounts()).length,
      },
    );
    record(
      '6',
      'a full sign-in: back-channel calls all went through guardedFetch',
      unguarded.length === 0 && guarded.length >= 2,
      {
        guarded: [...guarded],
        unguarded: [...unguarded],
      },
    );

    // Explicit link from Bruce's fresh session
    f = await oidcFlow(auth, 'idp-bruce', V('bruce@example.com'), {
      cookie: bruce.cookie,
      link: true,
    });
    const bruceAcc = await oidcAccounts(bruce.userId);
    record(
      '1',
      'explicit /link-social from a fresh session links',
      f.location?.endsWith('/done') === true && bruceAcc.length === 1,
      {
        location: f.location,
        status: f.status,
        start: f.start,
        accounts: bruceAcc.map((a) => ({
          account_id: a.account_id,
          access_token: a.access_token,
          refresh_token: a.refresh_token,
          id_token: a.id_token,
        })),
      },
    );
    record(
      'extra',
      'IdP tokens are not stored on the linked account',
      bruceAcc.every((a) => !a.access_token && !a.refresh_token && !a.id_token),
      {},
    );

    // Now OIDC sign-in reaches Bruce, by sub
    f = await oidcFlow(auth, 'idp-bruce', V('bruce@example.com'));
    const bruceSession = (await resolveSession(auth as never, authPool, requestHeaders(f.cookie)))
      .session;
    record('1', 'linked sub signs in to that account', bruceSession?.userId === bruce.userId, {
      location: f.location,
      userId: bruceSession?.userId === bruce.userId,
    });

    // Another sub claiming Bruce's email: still refused, even though Bruce has an OIDC link
    f = await oidcFlow(auth, 'idp-mallory', V('bruce@example.com'));
    record('1', 'a different sub with the same email: refused', f.error === 'account_not_linked', {
      error: f.error,
    });

    // Stale session can't link
    await q(`UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [
      louis.userId,
    ]);
    f = await oidcFlow(auth, 'idp-louis', V('louis@example.com'), {
      cookie: louis.cookie,
      link: true,
    });
    record(
      '1',
      'link from a session older than freshAge (600 s): refused',
      f.status === 403 && (await oidcAccounts(louis.userId)).length === 0,
      {
        status: f.status,
        body: f.start,
      },
    );

    // Link with a different email at the IdP: refused (allowDifferentEmails false)
    const alfred = await signUp(auth as never, 'alfred@example.com');
    await verify(alfred.userId);
    f = await oidcFlow(auth, 'idp-alfred', V('alfred.other@example.com'), {
      cookie: alfred.cookie,
      link: true,
    });
    record(
      '1',
      'link where the IdP email differs from the account: refused',
      f.error === 'email_does_not_match' && (await oidcAccounts(alfred.userId)).length === 0,
      { error: f.error },
    );

    // A client id_token posted straight to /sign-in/social: not supported for this provider
    const idt = await call(auth, 'POST', '/sign-in/social', {
      body: { provider: OIDC_PROVIDER_ID, callbackURL: '/done', idToken: { token: 'x.y.z' } },
    });
    const idtBody = await idt.res.json().catch(() => null);
    record('1', 'id_token sign-in (no redirect) refused', idt.res.status >= 400, {
      status: idt.res.status,
      body: idtBody,
    });

    // ---------------- Check 2: email_verified must be true ----------------
    for (const [name, claims] of [
      ['email_verified false', { email: 'new1@example.org', email_verified: false }],
      ['email_verified missing', { email: 'new2@example.org' }],
      ['email_verified "true" (a string)', { email: 'new3@example.org', email_verified: 'true' }],
      [
        'email_verified false + a claim literally named emailVerified: true',
        { email: 'new4@example.org', email_verified: false, emailVerified: true },
      ],
    ] as const) {
      f = await oidcFlow(auth, `idp-${name.length}`, claims);
      const u = await userByEmail(claims.email);
      record('2', name, f.error === 'email_unverified' && !u, { error: f.error, userCreated: !!u });
    }
    // An already linked account whose IdP now reports the email unverified
    f = await oidcFlow(auth, 'idp-bruce', { email: 'bruce@example.com', email_verified: false });
    record(
      '2',
      'linked account, IdP now says unverified: sign-in refused',
      f.error === 'email_unverified',
      { error: f.error },
    );

    // ---------------- Check 3: `.invalid` refused ----------------
    for (const email of ['someone@managed.invalid', 'SOMEONE@Example.INVALID']) {
      f = await oidcFlow(auth, `idp-${email}`, V(email, { groups: ['kept-family'] }));
      record(
        '3',
        `${email} (verified, allowed group)`,
        f.error === 'email_undeliverable' && !(await userByEmail(email.toLowerCase())),
        { error: f.error },
      );
    }

    // ---------------- Check 4: the session_mfa gate (V32) ----------------
    const enrolled = await enrolTotp(auth as never, ibrahim);
    f = await oidcFlow(auth, 'idp-ibrahim', V('ibrahim@example.com'), {
      cookie: enrolled.cookie,
      link: true,
    });
    record(
      '4',
      'Ibrahim (TOTP on) links OIDC from his satisfied session',
      f.location?.endsWith('/done') === true,
      { location: f.location },
    );
    f = await oidcFlow(auth, 'idp-ibrahim', V('ibrahim@example.com'));
    const pending = (await resolveSession(auth as never, authPool, requestHeaders(f.cookie)))
      .session;
    const gate = gateSession(pending);
    const baCall = await call(auth, 'GET', '/list-accounts', { cookie: f.cookie });
    const baBody = await baCall.res.json().catch(() => null);
    record(
      '4',
      'OIDC session of a TOTP user is pending: Kept 403 mfa_required, Better Auth 403 MFA_REQUIRED',
      pending?.mfaPending === true && !gate.ok && baCall.res.status === 403,
      {
        resolved: pending && {
          twoFactorEnabled: pending.twoFactorEnabled,
          mfa: pending.mfa,
          mfaPending: pending.mfaPending,
        },
        gate,
        betterAuth: { status: baCall.res.status, code: (baBody as { code?: string } | null)?.code },
      },
    );
    const v = await call(auth, 'POST', '/two-factor/verify-totp', {
      cookie: f.cookie,
      body: { code: totp(enrolled.secret) },
    });
    const after = (await resolveSession(auth as never, authPool, requestHeaders(v.cookie))).session;
    record(
      '4',
      'TOTP in that session satisfies it',
      v.res.status === 200 && after?.mfa === true && gateSession(after).ok,
      {
        status: v.res.status,
        after: after && { mfa: after.mfa, mfaPending: after.mfaPending },
      },
    );
    const bruceGate = gateSession(
      (
        await resolveSession(
          auth as never,
          authPool,
          requestHeaders((await oidcFlow(auth, 'idp-bruce', V('bruce@example.com'))).cookie),
        )
      ).session,
    );
    record(
      '4',
      'OIDC session of a user without 2FA: allowed, app.mfa false',
      bruceGate.ok && !bruceGate.scope.mfa,
      { gate: bruceGate },
    );

    // Rotation at sign-in (security.ts SIGN_IN_SESSION_PATHS): does an OIDC callback retire the
    // session cookie the browser already had?
    const before = await call(auth, 'GET', '/get-session', { cookie: bruce.cookie });
    const hadOld = ((await before.res.json()) as { session?: { id: string } } | null)?.session?.id;
    const rotated = await oidcFlow(auth, 'idp-bruce', V('bruce@example.com'), {
      cookie: bruce.cookie,
    });
    const stillThere = hadOld
      ? (await q('SELECT 1 FROM auth.session WHERE id = $1', [hadOld])).length > 0
      : null;
    record(
      'extra',
      'with the rotation hook on /callback/:id, the previous session is retired',
      stillThere === false && rotated.location?.endsWith('/done') === true,
      {
        oldSessionStillExists: stillThere,
        newSignIn: rotated.location,
        callbackPathAsHooksSeeIt: [
          ...new Set(seenPaths.filter((p) => p.startsWith('/callback') || p.startsWith('after'))),
        ].slice(-3),
      },
    );

    // ---------------- Check 5: autoprovision only for an allowed domain or group ----------------
    const cases: [string, string, Record<string, unknown>, boolean][] = [
      ['allowed domain example.org', 'talia@example.org', V('talia@example.org'), true],
      ['allowed domain, upper case', 'Peter@EXAMPLE.ORG', V('Peter@EXAMPLE.ORG'), true],
      ['other domain, no group', 'someone@example.com', V('someone@example.com'), false],
      ['lookalike domain evil-example.org', 'x@evil-example.org', V('x@evil-example.org'), false],
      [
        'lookalike domain example.org.evil.net',
        'x@example.org.evil.net',
        V('x@example.org.evil.net'),
        false,
      ],
      [
        'subdomain sub.example.org (exact match only)',
        'x@sub.example.org',
        V('x@sub.example.org'),
        false,
      ],
      [
        'allowed group kept-family',
        'guest@example.com',
        V('guest@example.com', { groups: ['staff', 'kept-family'] }),
        true,
      ],
      [
        'group as a single string',
        'guest2@example.com',
        V('guest2@example.com', { groups: 'kept-family' }),
        true,
      ],
      ['other group', 'guest3@example.com', V('guest3@example.com', { groups: ['staff'] }), false],
      [
        'group claim under another name',
        'guest4@example.com',
        V('guest4@example.com', { roles: ['kept-family'] }),
        false,
      ],
    ];
    for (const [name, email, claims, allow] of cases) {
      const before = created.length;
      f = await oidcFlow(auth, `idp-${email}`, claims);
      const u = await userByEmail(email.toLowerCase());
      const ok = allow
        ? f.location?.endsWith('/done') === true &&
          !!u &&
          u.email_verified &&
          created.length === before + 1
        : f.error === 'signup_closed' && !u && created.length === before;
      record('5', `${name}: ${allow ? 'created' : 'refused'}`, ok, {
        error: f.error,
        userCreated: !!u,
        onUserCreated: created.length - before,
      });
    }
    // Invites (D127: "existing or invited accounts")
    f = await oidcFlow(auth, 'idp-murdock', V('murdock@example.com'), {
      additionalData: { inviteToken: 'invite-murdock' },
    });
    record(
      '5',
      'invite (server context), other domain: created',
      f.location?.endsWith('/done') === true && !!(await userByEmail('murdock@example.com')),
      { error: f.error, location: f.location },
    );
    f = await oidcFlow(auth, 'idp-murdock2', V('murdock2@example.com'), {
      additionalData: { inviteToken: 'invite-murdock' },
    });
    record(
      '5',
      'email-bound invite, different verified email: refused',
      f.error === 'invite_email_mismatch',
      { error: f.error },
    );
    f = await oidcFlow(auth, 'idp-forged', V('forged@example.com'), {
      additionalData: { inviteToken: 'nope' },
    });
    record('5', 'unknown invite token: refused', f.error === 'signup_closed', { error: f.error });
    f = await oidcFlow(auth, 'idp-forged2', V('forged2@example.com'), {
      additionalData: {
        keptInvite: { id: 'x', email: null },
        serverContext: { keptInvite: { id: 'x', email: null } },
      },
    });
    record(
      '5',
      'client-forged invite in additionalData: refused',
      f.error === 'signup_closed' && !(await userByEmail('forged2@example.com')),
      { error: f.error },
    );

    // validateUserInfo runs for every createUser: managed accounts (admin plugin, .invalid) and
    // email sign-up must still work with it on.
    try {
      const managed = await createManagedUser(auth as never, {
        username: 'peter',
        displayName: 'Peter',
        password: 'correct horse battery',
      });
      record(
        'extra',
        'managed account (.invalid, admin createUser) still created with the policy on',
        managed.email.endsWith('.invalid'),
        { email: managed.email.replace(/^[^@]+/, '<uuid>') },
      );
    } catch (e) {
      record(
        'extra',
        'managed account (.invalid, admin createUser) still created with the policy on',
        false,
        { error: String(e) },
      );
    }

    record('6', 'no unguarded fetch during all Kept flows', unguarded.length === 0, {
      unguarded: [...unguarded],
      guardedCalls: guarded.length,
    });

    // =========================================================================================
    // Stock genericOAuth with Better Auth's defaults, for comparison (global fetch allowed)
    // =========================================================================================
    tripwire(false);
    const stock = createAuth({
      pool: authPool,
      env,
      mail,
      rateLimitEnabled: false,
      oidc: {
        config: cfg,
        keptRules: false,
        findInvite: async () => null,
        provider: {
          providerId: OIDC_PROVIDER_ID,
          clientId: cfg.clientId,
          clientSecret,
          discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
          scopes: ['openid', 'email', 'profile'],
        },
      },
    });
    await stock.$context;
    const louisBefore = (await oidcAccounts(louis.userId)).length;
    f = await oidcFlow(stock, 'idp-attacker', V('louis@example.com'));
    const louisAfter = await oidcAccounts(louis.userId);
    const stockSession = (await resolveSession(stock as never, authPool, requestHeaders(f.cookie)))
      .session;
    record(
      'stock',
      "Better Auth defaults: an IdP asserting Louis's verified email is auto-linked and signed in as Louis",
      louisAfter.length === louisBefore + 1 && stockSession?.userId === louis.userId,
      {
        location: f.location,
        linkedSubs: louisAfter.map((a) => a.account_id),
        tokensStored: louisAfter.some((a) => !!a.access_token || !!a.id_token),
      },
    );
    // Current security.ts: no rotation on the OAuth callback
    const again = await stock.api.signInEmail({
      body: { email: 'bruce@example.com', password: 'correct horse battery' },
      headers: requestHeaders(),
      returnHeaders: true,
    });
    const bruceCookie = cookieHeader(again.headers);
    const bruce2 = await call(stock, 'GET', '/get-session', { cookie: bruceCookie });
    const bruceOld = ((await bruce2.res.json()) as { session?: { id: string } } | null)?.session
      ?.id;
    const r2 = await oidcFlow(stock, 'idp-bruce', V('bruce@example.com'), { cookie: bruceCookie });
    const kept = bruceOld
      ? (await q('SELECT 1 FROM auth.session WHERE id = $1', [bruceOld])).length > 0
      : null;
    record(
      'stock',
      'without the hook (security.ts today), an OIDC sign-in leaves the previous session alive',
      kept === true && r2.location?.endsWith('/done') === true,
      { oldSessionStillExists: kept },
    );
    const talia = await signUp(stock as never, 'talia2@example.com');
    await verify(talia.userId);
    f = await oidcFlow(stock, 'idp-attacker2', {
      email: 'talia2@example.com',
      email_verified: false,
      emailVerified: true,
    });
    record(
      'stock',
      'Better Auth defaults: email_verified false + claim emailVerified: true is treated as verified (linked)',
      (await oidcAccounts(talia.userId)).length === 1,
      { location: f.location, error: f.error },
    );
    f = await oidcFlow(stock, 'idp-new', V('stranger@example.net'));
    record(
      'stock',
      'Better Auth defaults: any new verified email is signed up (no autoprovision rule)',
      !!(await userByEmail('stranger@example.net')),
      { location: f.location },
    );
    f = await oidcFlow(stock, 'idp-inv', V('x@managed.invalid'));
    record(
      'stock',
      'Better Auth defaults: a .invalid email is accepted',
      !!(await userByEmail('x@managed.invalid')),
      { location: f.location, error: f.error },
    );

    // =========================================================================================
    // Tables: does genericOAuth add any?
    // =========================================================================================
    const base = { database: { type: 'postgres' } } as never;
    const withPlugin = {
      ...(base as object),
      plugins: [
        (await import('better-auth/plugins/generic-oauth')).genericOAuth({
          config: [
            {
              providerId: 'x',
              clientId: 'x',
              authorizationUrl: 'https://x/a',
              tokenUrl: 'https://x/t',
            },
          ],
        }),
      ],
    } as never;
    const t0 = getAuthTables(base);
    const t1 = getAuthTables(withPlugin);
    const shape = (t: ReturnType<typeof getAuthTables>) =>
      Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Object.keys(v.fields).sort()]));
    record(
      'tables',
      'getAuthTables with vs without genericOAuth',
      JSON.stringify(shape(t0)) === JSON.stringify(shape(t1)),
      {
        models: Object.keys(t1),
        account: shape(t1).account,
      },
    );
  } finally {
    tripwire(false);
    await authPool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    const left = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    process.stdout.write(`scratch database dropped: ${left.rowCount === 0}\n`);
    await admin.end();
    writeFileSync(
      new URL('./results-2026-09-30.jsonl', import.meta.url),
      `${results.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} pass\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(2);
});
