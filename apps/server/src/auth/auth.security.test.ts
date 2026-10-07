import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { fragmentToken, jar, setCookies, type TestApp, testApp } from '../../test/app.js';
import { enrolTotp, signUp, totp } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { asOwner, userEmail } from '../../test/tenancy.js';
import { ensureAccount } from '../accounts/ensure-account.js';
import { AUTH_BASE_PATH, SESSION_DAYS_HTTPS, SESSION_HOURS_HTTP } from './auth.js';

// Task 17: the auth-flow security suite, through the Fastify app the way a browser reaches it
// (app.inject), with Better Auth mounted at /api/v1/auth/* and Kept's session gate in front of
// every /api/v1 route.

const PASSWORD = 'correct horse battery';
const HTTPS_URL = 'https://kept.example.test';

let db: TestDb;
let t: TestApp;

function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

const email = (label: string) => `${label}-${randomUUID()}@example.com`;

type Call = {
  method?: 'GET' | 'POST' | 'DELETE';
  cookie?: string;
  body?: unknown;
  ip?: string;
  app?: TestApp;
};

function call(url: string, opts: Call = {}): Promise<LightMyRequestResponse> {
  const target = opts.app ?? t;
  const headers: Record<string, string> = { origin: target.publicUrl };
  if (opts.cookie) headers.cookie = opts.cookie;
  return target.app.inject({
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    url,
    headers,
    remoteAddress: opts.ip ?? uniqueIp(),
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
}

const auth = (path: string, opts: Call = {}) => call(`${AUTH_BASE_PATH}${path}`, opts);

async function signIn(address: string, opts: Call = {}): Promise<string> {
  const res = await auth('/sign-in/email', {
    ...opts,
    body: { email: address, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return jar(res, opts.cookie);
}

async function newUser(label: string, app: TestApp = t) {
  const address = email(label);
  const { userId } = await signUp(app.auth, address, PASSWORD);
  return { userId, email: address };
}

async function sessionRows(userId: string): Promise<{ id: string; expires_at: Date }[]> {
  const { rows } = await db.pools.auth.query(
    'SELECT id, expires_at FROM auth.session WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return rows;
}

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await testApp(db);
});

describe('the Better Auth mount', () => {
  it('signs in through /api/v1/auth, sets the cookie, and never puts a session token in a body', async () => {
    const user = await newUser('mount');
    const res = await auth('/sign-in/email', { body: { email: user.email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe(user.userId);
    expect(body).not.toHaveProperty('token');
    const cookie = jar(res);
    expect(cookie).toMatch(/session_token=/);

    const session = await auth('/get-session', { cookie });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.id).toBe(user.userId);
    expect(session.json().session).not.toHaveProperty('token');
  });

  it('keeps the switched-off endpoints off: token-bearing session lists, Better Auth email change', async () => {
    const user = await newUser('off');
    const cookie = await signIn(user.email);
    expect((await auth('/list-sessions', { cookie })).statusCode).toBe(404);
    expect(
      (await auth('/change-email', { cookie, body: { newEmail: email('x') } })).statusCode,
    ).toBe(404);
  });

  it('applies the per-IP sign-in limit (5/min, shared through the database)', async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await auth('/sign-in/email', {
        ip,
        body: { email: email(`nobody${i}`), password: 'wrong password' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('answers an unknown email and a wrong password alike, in the same timing class', async () => {
    const user = await newUser('enum');
    const attempt = async (address: string) => {
      const started = performance.now();
      const res = await auth('/sign-in/email', {
        body: { email: address, password: 'wrong password' },
      });
      return { ms: performance.now() - started, status: res.statusCode, body: res.json() };
    };
    const unknown = [];
    const wrong = [];
    // Alternate, three each: the account limiter allows four free failures per account and IP.
    for (let i = 0; i < 3; i++) {
      unknown.push(await attempt(email('ghost')));
      wrong.push(await attempt(user.email));
    }
    for (const r of [...unknown, ...wrong]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(wrong[0]?.body);
    }
    // Both paths hash a password (Better Auth hashes a dummy for an unknown user), so neither is
    // an order of magnitude faster than the other.
    const median = (xs: { ms: number }[]) => xs.map((x) => x.ms).sort((a, b) => a - b)[1] ?? 0;
    const ratio = median(unknown) / median(wrong);
    expect(ratio).toBeGreaterThan(1 / 3);
    expect(ratio).toBeLessThan(3);
  });
});

describe('magic links (D176)', () => {
  it('mails a link to the web page with the token in the fragment; a GET never signs in or consumes it', async () => {
    const user = await newUser('ml');
    const sent = await auth('/sign-in/magic-link', { body: { email: user.email } });
    expect(sent.statusCode).toBe(200);
    const mail = t.auth.mails.at(-1);
    expect(mail?.url).toMatch(/^http:\/\/localhost:5173\/auth\/confirm#token=/);
    const token = fragmentToken(mail?.url ?? '');
    expect(token).toBe(mail?.token);

    // What a mail scanner (or a click on Better Auth's own URL shape) would do.
    const scanned = await auth(`/magic-link/verify?token=${token}`);
    expect(scanned.statusCode).toBe(404);
    expect(setCookies(scanned)).toEqual([]);

    // The page's POST still works: the GET consumed nothing.
    const confirmed = await auth('/magic-link/verify', { body: { token } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ mfaRequired: false });
    const cookie = jar(confirmed);
    expect((await call('/api/v1/me/sessions', { cookie })).statusCode).toBe(200);

    // Single use.
    const again = await auth('/magic-link/verify', { body: { token } });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: 'token_invalid' });
  });

  it('says the session still needs a second factor when the user enrolled one', async () => {
    const user = await newUser('ml2fa');
    await userEmail(db, user.userId, true); // verified: the link signs in, it doesn't claim (D197)
    const cookie = await signIn(user.email);
    await enrolTotp(t.auth, { userId: user.userId, cookie }, PASSWORD);
    await auth('/sign-in/magic-link', { body: { email: user.email } });
    const token = t.auth.mails.at(-1)?.token ?? '';
    const confirmed = await auth('/magic-link/verify', { body: { token } });
    expect(confirmed.json()).toEqual({ mfaRequired: true });
    const pending = jar(confirmed);
    const res = await call('/api/v1/me/sessions', { cookie: pending });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'mfa_required' });
  });

  it('answers an address with no account exactly like one with an account, and mails nothing', async () => {
    const user = await newUser('known');
    const known = await auth('/sign-in/magic-link', { body: { email: user.email } });
    const before = t.auth.mails.length;
    const unknown = await auth('/sign-in/magic-link', { body: { email: email('nobody') } });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(t.auth.mails.length).toBe(before);
  });

  it('allows 3 links per hour per address from one IP, 10 per address in all (review M4)', async () => {
    const user = await newUser('ml3');
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await auth('/sign-in/magic-link', { ip, body: { email: user.email } })).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Someone elsewhere can't spend the owner's allowance: other IPs still get links...
    const elsewhere: number[] = [];
    for (let i = 0; i < 8; i++) {
      elsewhere.push(
        (
          await auth('/sign-in/magic-link', {
            ip: `203.0.113.${i + 1}`,
            body: { email: user.email },
          })
        ).statusCode,
      );
    }
    // ...up to the per-address ceiling of 10 (3 used above, then 7 more).
    expect(elsewhere).toEqual([200, 200, 200, 200, 200, 200, 200, 429]);
    const other = await newUser('ml3-other');
    expect(
      (await auth('/sign-in/magic-link', { ip, body: { email: other.email } })).statusCode,
    ).toBe(200);
  });

  it('password reset: a fragment link, a POST, every session signed out, and 3 per hour', async () => {
    const user = await newUser('reset');
    const cookie = await signIn(user.email);
    const requested = await auth('/request-password-reset', { body: { email: user.email } });
    expect(requested.statusCode).toBe(200);
    const mail = t.auth.resets.at(-1);
    expect(mail?.url).toMatch(/\/auth\/reset#token=/);
    const reset = await auth('/reset-password', {
      body: { token: fragmentToken(mail?.url ?? ''), newPassword: 'another good password' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await call('/api/v1/me/sessions', { cookie })).statusCode).toBe(401);

    for (let i = 0; i < 2; i++) {
      await auth('/request-password-reset', { ip: '203.0.113.77', body: { email: user.email } });
    }
    await auth('/request-password-reset', { ip: '203.0.113.77', body: { email: user.email } });
    const fourth = await auth('/request-password-reset', {
      ip: '203.0.113.77',
      body: { email: user.email },
    });
    expect(fourth.statusCode).toBe(429);
  });
});

describe('sessions (D181)', () => {
  it('over plain HTTP: no Secure flag, 12 hours, never renewed', async () => {
    const user = await newUser('http');
    const res = await auth('/sign-in/email', { body: { email: user.email, password: PASSWORD } });
    const line = setCookies(res).find((c) => c.includes('session_token=')) ?? '';
    expect(line).not.toMatch(/;\s*Secure/i);
    expect(line).not.toMatch(/__Secure-/);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(new RegExp(`Max-Age=${SESSION_HOURS_HTTP * 3600}`));

    // Even a session near its end is not extended.
    await db.pools.auth.query(
      "UPDATE auth.session SET expires_at = now() + interval '1 hour' WHERE user_id = $1",
      [user.userId],
    );
    const later = await call('/api/v1/me/sessions', { cookie: jar(res) });
    expect(later.statusCode).toBe(200);
    expect(setCookies(later)).toEqual([]);
    for (const after of await sessionRows(user.userId)) {
      expect(after.expires_at.getTime()).toBeLessThan(Date.now() + 2 * 3_600_000);
    }
  });

  it('over HTTPS: Secure, __Secure- prefixed, 30 days, sliding (a Kept route forwards the renewal)', async () => {
    const secure = await testApp(db, { publicUrl: HTTPS_URL });
    const user = await newUser('https', secure);
    const res = await auth('/sign-in/email', {
      app: secure,
      body: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const line = setCookies(res).find((c) => c.includes('session_token=')) ?? '';
    expect(line).toMatch(/^__Secure-/);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(new RegExp(`Max-Age=${SESSION_DAYS_HTTPS * 86400}`));

    // A session used two days after its last renewal is renewed, and the new cookie reaches the
    // browser through whatever Kept route it called.
    await db.pools.auth.query(
      "UPDATE auth.session SET expires_at = now() + interval '28 days' WHERE user_id = $1",
      [user.userId],
    );
    const later = await call('/api/v1/me/sessions', { app: secure, cookie: jar(res) });
    expect(later.statusCode).toBe(200);
    expect(setCookies(later).some((c) => c.includes('session_token='))).toBe(true);
    const latest = Math.max(...(await sessionRows(user.userId)).map((r) => r.expires_at.getTime()));
    expect(latest).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await secure.app.close();
  });

  it('rotates the token at sign-in: the session the browser came with is retired', async () => {
    const user = await newUser('rotate');
    const first = await signIn(user.email);
    const old = (await sessionRows(user.userId)).at(-1);
    const second = await signIn(user.email, { cookie: first });
    expect(second).not.toBe(first);
    const rows = await sessionRows(user.userId);
    expect(rows.map((r) => r.id)).not.toContain(old?.id);
    expect((await call('/api/v1/me/sessions', { cookie: first })).statusCode).toBe(401);
    expect((await call('/api/v1/me/sessions', { cookie: second })).statusCode).toBe(200);
  });

  it('a password change signs out every other session', async () => {
    const user = await newUser('pw');
    const a = await signIn(user.email);
    const b = await signIn(user.email);
    const changed = await auth('/change-password', {
      cookie: a,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).not.toHaveProperty('token');
    expect((await call('/api/v1/me/sessions', { cookie: b })).statusCode).toBe(401);
    expect((await call('/api/v1/me/sessions', { cookie: jar(changed, a) })).statusCode).toBe(200);
  });

  it('a two-factor change signs out every other session', async () => {
    const user = await newUser('tfa');
    const a = await signIn(user.email);
    const b = await signIn(user.email);
    const enabled = await auth('/two-factor/enable', { cookie: a, body: { password: PASSWORD } });
    expect(enabled.statusCode).toBe(200);
    expect((await call('/api/v1/me/sessions', { cookie: b })).statusCode).toBe(401);
    expect((await call('/api/v1/me/sessions', { cookie: jar(enabled, a) })).statusCode).toBe(200);
  });
});

describe('the session gate on Kept routes', () => {
  it('401 without a session, 403 mfa_required while the second factor is pending', async () => {
    expect((await call('/api/v1/me/sessions')).json()).toMatchObject({ code: 'unauthenticated' });
    expect(
      (await call('/api/v1/me/sessions', { cookie: 'better-auth.session_token=junk' })).statusCode,
    ).toBe(401);

    const user = await newUser('gate');
    await userEmail(db, user.userId, true); // verified: the link signs in, it doesn't claim (D197)
    const cookie = await signIn(user.email);
    const { secret } = await enrolTotp(t.auth, { userId: user.userId, cookie }, PASSWORD);
    // A password sign-in with two-factor on: challenge, then a verified session.
    const challenged = await auth('/sign-in/email', {
      body: { email: user.email, password: PASSWORD },
    });
    expect(challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const verified = await auth('/two-factor/verify-totp', {
      cookie: jar(challenged),
      body: { code: totp(secret) },
    });
    expect(verified.statusCode).toBe(200);
    expect(
      (await call('/api/v1/me/sessions', { cookie: jar(verified, jar(challenged)) })).statusCode,
    ).toBe(200);

    // A magic-link session is pending until a second factor is proven in it.
    await auth('/sign-in/magic-link', { body: { email: user.email } });
    const confirmed = await auth('/magic-link/verify', {
      body: { token: t.auth.mails.at(-1)?.token },
    });
    const pending = jar(confirmed);
    expect((await call('/api/v1/me/sessions', { cookie: pending })).json()).toMatchObject({
      code: 'mfa_required',
    });
  });

  it('routes choose: optional sees no scope for a pending session, allowMfaPending lets it through', async () => {
    const probe = await testApp(db, {
      routes: (app) => {
        app.get('/api/v1/test/optional', { config: { auth: 'optional' } }, async (req) => ({
          scope: req.scope,
        }));
        app.get('/api/v1/test/pending', { config: { allowMfaPending: true } }, async (req) => ({
          scope: req.scope,
          pending: req.authSession?.mfaPending ?? null,
        }));
        app.get('/test/outside', async (req) => ({ scope: req.scope }));
        app.get('/test/public', { config: { auth: 'none' } }, async (req) => ({
          scope: req.scope,
        }));
      },
    });
    const user = await newUser('probe', probe);
    await userEmail(db, user.userId, true); // verified: the link signs in, it doesn't claim (D197)
    const cookie = await signIn(user.email, { app: probe });
    await enrolTotp(probe.auth, { userId: user.userId, cookie }, PASSWORD);
    await auth('/sign-in/magic-link', { app: probe, body: { email: user.email } });
    const confirmed = await auth('/magic-link/verify', {
      app: probe,
      body: { token: probe.auth.mails.at(-1)?.token },
    });
    const pending = jar(confirmed);

    expect((await call('/api/v1/test/optional', { app: probe })).json()).toEqual({ scope: null });
    expect((await call('/api/v1/test/optional', { app: probe, cookie: pending })).json()).toEqual({
      scope: null,
    });
    expect((await call('/api/v1/test/pending', { app: probe, cookie: pending })).json()).toEqual({
      scope: null,
      pending: true,
    });
    expect((await call('/api/v1/test/pending', { app: probe })).statusCode).toBe(401);
    // Every route requires a session unless it says otherwise, in /api/v1 or not (review M1)...
    expect((await call('/test/outside', { app: probe })).statusCode).toBe(401);
    expect((await call('/test/outside', { app: probe, cookie: pending })).json()).toMatchObject({
      code: 'mfa_required',
    });
    // ...and a route marked public looks nothing up.
    expect((await call('/test/public', { app: probe, cookie: pending })).json()).toEqual({
      scope: null,
    });
    // An unknown path is a plain 404, not a 401.
    expect((await call('/test/nowhere', { app: probe })).statusCode).toBe(404);
    await probe.app.close();
  });

  it('forwards the session to handlers as req.scope', async () => {
    const probe = await testApp(db, {
      routes: (app) => {
        app.get('/api/v1/test/scope', async (req) => ({ scope: req.scope }));
      },
    });
    const user = await newUser('scope', probe);
    const cookie = await signIn(user.email, { app: probe });
    expect((await call('/api/v1/test/scope', { app: probe, cookie })).json()).toEqual({
      scope: { userId: user.userId, mfa: false },
    });
    await probe.app.close();
  });
});

/** The user's account-level audit events (no location), oldest first, read as kept_owner. */
const accountAudit = (userId: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; entity_id: string | null }>(
      `SELECT e.action, e.entity_id FROM public.audit_events e
         JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
        WHERE oa.user_id = $1 AND e.location_id IS NULL ORDER BY e.at, e.id`,
      [userId],
    );
    return rows;
  });

describe('devices: GET /api/v1/me/sessions, DELETE /api/v1/me/sessions/:id', () => {
  // catalogue: DELETE /api/v1/me/sessions/:id
  it('lists live sessions with the current one marked, and revokes another', async () => {
    const user = await newUser('devices');
    // Account-level events attach to the owner account that ensureAccount() makes on the first
    // signed-in request; this harness has no onScope, so make it here.
    await ensureAccount(db.pools, user.userId);
    const a = await signIn(user.email);
    const b = await signIn(user.email);
    const listed = await call('/api/v1/me/sessions', { cookie: a });
    expect(listed.statusCode).toBe(200);
    const sessions = listed.json().sessions as { id: string; current: boolean }[];
    // Sign-up signed in too: three sessions.
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        userAgent: 'lightMyRequest',
        ipAddress: expect.stringMatching(/^198\.51\./),
        createdAt: expect.any(String),
        lastActiveAt: expect.any(String),
        secondFactor: false,
      }),
    );
    expect(JSON.stringify(listed.json())).not.toMatch(/token/i);

    const [, bRow] = await sessionRows(user.userId).then((rows) => rows.slice(1));
    expect(sessions.find((s) => s.id === bRow?.id)?.current).toBe(false);
    const revoked = await call(`/api/v1/me/sessions/${bRow?.id}`, { method: 'DELETE', cookie: a });
    expect(revoked.statusCode).toBe(204);
    expect((await call('/api/v1/me/sessions', { cookie: b })).statusCode).toBe(401);
    expect((await call('/api/v1/me/sessions', { cookie: a })).json().sessions).toHaveLength(2);
    expect(await accountAudit(user.userId)).toContainEqual({
      action: 'session.revoke',
      entity_id: bRow?.id,
    });
  });

  it("404s on another user's session, and leaves it alone", async () => {
    const mine = await newUser('mine');
    const theirs = await newUser('theirs');
    const cookie = await signIn(mine.email);
    const theirCookie = await signIn(theirs.email);
    const [row] = await sessionRows(theirs.userId);
    const res = await call(`/api/v1/me/sessions/${row?.id}`, { method: 'DELETE', cookie });
    expect(res.statusCode).toBe(404);
    expect((await call('/api/v1/me/sessions', { cookie: theirCookie })).statusCode).toBe(200);
  });
});

describe('email change (D176): the old address confirms, then the new one verifies', () => {
  // catalogue: POST /api/v1/auth/email-change/confirm
  it('needs the password, mails the old address, then the new, then switches and signs out the rest', async () => {
    const user = await newUser('change');
    // Account-level events attach to the owner account that ensureAccount() makes on the first
    // signed-in request; this harness has no onScope, so make it here.
    await ensureAccount(db.pools, user.userId);
    const a = await signIn(user.email);
    const b = await signIn(user.email);
    const target = email('new');

    const noPassword = await call('/api/v1/me/email-change', {
      cookie: a,
      body: { newEmail: target },
    });
    expect(noPassword.statusCode).toBe(403);
    expect(noPassword.json()).toMatchObject({ code: 'reauth_required' });
    const wrong = await call('/api/v1/me/email-change', {
      cookie: a,
      body: { newEmail: target, password: 'not it at all' },
    });
    expect(wrong.json()).toMatchObject({ code: 'reauth_required' });

    const started = await call('/api/v1/me/email-change', {
      cookie: a,
      body: { newEmail: target, password: PASSWORD },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ stage: 'confirm_old' });
    const toOld = t.mail.at(-1);
    expect(toOld).toMatchObject({ kind: 'email-change-confirm', to: user.email, newEmail: target });
    const oldToken = fragmentToken((toOld as { url: string }).url);
    expect((toOld as { url: string }).url).toMatch(/\/auth\/email-change#token=/);

    // Nothing has changed yet.
    const { rows: before } = await db.pools.auth.query(
      'SELECT email FROM auth."user" WHERE id = $1',
      [user.userId],
    );
    expect(before[0].email).toBe(user.email);

    const confirmed = await auth('/email-change/confirm', { body: { token: oldToken } });
    expect(confirmed.json()).toEqual({ stage: 'verify_new' });
    const toNew = t.mail.at(-1);
    expect(toNew).toMatchObject({ kind: 'email-change-verify', to: target });
    expect(
      (await auth('/email-change/confirm', { body: { token: oldToken } })).json(),
    ).toMatchObject({
      code: 'token_invalid',
    });

    const done = await auth('/email-change/confirm', {
      cookie: a,
      body: { token: fragmentToken((toNew as { url: string }).url) },
    });
    expect(done.json()).toEqual({ stage: 'done' });
    const { rows } = await db.pools.auth.query(
      'SELECT email, email_verified FROM auth."user" WHERE id = $1',
      [user.userId],
    );
    expect(rows[0]).toEqual({ email: target, email_verified: true });
    expect(t.mail.at(-1)).toEqual({ kind: 'email-changed', to: user.email, newEmail: target });
    expect(await accountAudit(user.userId)).toContainEqual({
      action: 'account.email_change',
      entity_id: user.userId,
    });
    // The confirming device stays signed in; the other one is out.
    expect((await call('/api/v1/me/sessions', { cookie: a })).statusCode).toBe(200);
    expect((await call('/api/v1/me/sessions', { cookie: b })).statusCode).toBe(401);
    // And the new address signs in.
    await signIn(target);
  });

  it('handles an address another account has like any other, and never mails it', async () => {
    const user = await newUser('taken');
    const holder = await newUser('holder');
    const cookie = await signIn(user.email);
    const started = await call('/api/v1/me/email-change', {
      cookie,
      body: { newEmail: holder.email, password: PASSWORD },
    });
    expect(started.statusCode).toBe(202);
    const oldToken = fragmentToken((t.mail.at(-1) as { url: string }).url);
    const confirmed = await auth('/email-change/confirm', { body: { token: oldToken } });
    expect(confirmed.json()).toEqual({ stage: 'verify_new' });
    expect(t.mail.filter((m) => m.to === holder.email)).toEqual([]);
  });

  it('without a password, accepts only a fresh sign-in as re-authentication', async () => {
    const user = await newUser('nopw');
    await db.pools.auth.query(
      "UPDATE auth.account SET password = NULL WHERE user_id = $1 AND provider_id = 'credential'",
      [user.userId],
    );
    await auth('/sign-in/magic-link', { body: { email: user.email } });
    const confirmed = await auth('/magic-link/verify', {
      body: { token: t.auth.mails.at(-1)?.token },
    });
    const cookie = jar(confirmed);
    const fresh = await call('/api/v1/me/email-change', { cookie, body: { newEmail: email('n') } });
    expect(fresh.statusCode).toBe(202);

    await db.pools.auth.query(
      "UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE user_id = $1",
      [user.userId],
    );
    const stale = await call('/api/v1/me/email-change', { cookie, body: { newEmail: email('n') } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: 'reauth_required' });
  });

  it('refuses a .invalid address and the current one', async () => {
    const user = await newUser('bad');
    const cookie = await signIn(user.email);
    for (const newEmail of ['someone@managed.invalid', user.email]) {
      const res = await call('/api/v1/me/email-change', {
        cookie,
        body: { newEmail, password: PASSWORD },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('allows 3 requests per hour per account', async () => {
    const user = await newUser('many');
    const cookie = await signIn(user.email);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await call('/api/v1/me/email-change', {
        cookie,
        body: { newEmail: email('n'), password: PASSWORD },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});

describe('security review follow-ups (M2, M3, M5–M8)', () => {
  /** Runs an email change to its end; `confirmCookie` is the device that confirms the new one. */
  async function changeEmail(cookie: string, confirmCookie?: string) {
    const target = email('moved');
    const started = await call('/api/v1/me/email-change', {
      cookie,
      body: { newEmail: target, password: PASSWORD },
    });
    expect(started.json()).toEqual({ stage: 'confirm_old' });
    const oldToken = fragmentToken((t.mail.at(-1) as { url: string }).url);
    await auth('/email-change/confirm', { body: { token: oldToken } });
    const newToken = fragmentToken((t.mail.at(-1) as { url: string }).url);
    const done = await auth('/email-change/confirm', {
      ...(confirmCookie ? { cookie: confirmCookie } : {}),
      body: { token: newToken },
    });
    expect(done.json()).toEqual({ stage: 'done' });
    return target;
  }

  it('M2: a reset link mailed to the old address dies with the email change', async () => {
    const user = await newUser('m2');
    const cookie = await signIn(user.email);
    await auth('/request-password-reset', { body: { email: user.email } });
    const resetToken = fragmentToken(t.auth.resets.at(-1)?.url ?? '');
    await changeEmail(cookie);
    const reset = await auth('/reset-password', {
      body: { token: resetToken, newPassword: 'taken over at last' },
    });
    expect(reset.statusCode).toBe(400);
  });

  it('M3: reset tokens are stored only as hashes, under a readable kind prefix', async () => {
    const user = await newUser('m3');
    await auth('/request-password-reset', { body: { email: user.email } });
    const token = fragmentToken(t.auth.resets.at(-1)?.url ?? '');
    const { rows } = await db.pools.auth.query<{ identifier: string }>(
      'SELECT identifier FROM auth.verification WHERE value = $1',
      [user.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toMatch(/^reset-password:[A-Za-z0-9_-]{43}$/);
    expect(rows[0]?.identifier).not.toContain(token);
  });

  it('M5: token redemptions are limited per IP', async () => {
    const ip = uniqueIp();
    const statuses = new Set<number>();
    for (let i = 0; i < 31; i++) {
      statuses.add(
        (await auth('/magic-link/verify', { ip, body: { token: `nope-${i}` } })).statusCode,
      );
    }
    expect([...statuses].sort()).toEqual([400, 429]);
    const confirm = await auth('/email-change/confirm', { ip, body: { token: 'nope' } });
    expect(confirm.statusCode).toBe(429);
    expect(confirm.headers['retry-after']).toBeDefined();
    // Another address is unaffected.
    expect((await auth('/magic-link/verify', { body: { token: 'nope' } })).statusCode).toBe(400);
  });

  it('M6: tokens are stripped at any depth, and the admin plugin serves nothing', async () => {
    const { withoutTokens } = await import('./http.js');
    expect(
      withoutTokens({ token: 'a', session: { token: 'b', id: 1 }, list: [{ token: 'c', x: 2 }] }),
    ).toEqual({ session: { id: 1 }, list: [{ x: 2 }] });
    const user = await newUser('m6');
    const cookie = await signIn(user.email);
    for (const path of ['/admin/list-user-sessions', '/admin/list-users', '/admin/ban-user']) {
      const res = await auth(path, { cookie, body: { userId: user.userId } });
      expect(res.statusCode, path).toBe(404);
    }
  });

  it('M7: a session still waiting for its second factor does not survive the change it confirms', async () => {
    const user = await newUser('m7');
    // Verified, so the magic link below doesn't treat the password as an unproven claim on the
    // address (Better Auth then drops it and signs everything out).
    await db.pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE id = $1', [
      user.userId,
    ]);
    const cookie = await signIn(user.email);
    const { secret } = await enrolTotp(t.auth, { userId: user.userId, cookie }, PASSWORD);
    // A magic-link session: pending until a second factor is proven in it.
    await auth('/sign-in/magic-link', { body: { email: user.email } });
    const confirmed = await auth('/magic-link/verify', {
      body: { token: t.auth.mails.at(-1)?.token },
    });
    const pending = jar(confirmed);
    // A full session on another device starts the change.
    const challenged = await auth('/sign-in/email', {
      body: { email: user.email, password: PASSWORD },
    });
    const verified = await auth('/two-factor/verify-totp', {
      cookie: jar(challenged),
      body: { code: totp(secret) },
    });
    const full = jar(verified, jar(challenged));
    // The pending device confirms the new address: it is signed out with every other session.
    await changeEmail(full, pending);
    expect(await sessionRows(user.userId)).toEqual([]);
  });

  it('M8: anonymous routes refuse bodies over 16 KiB', async () => {
    const big = { token: 'x'.repeat(20_000) };
    expect((await auth('/magic-link/verify', { body: big })).statusCode).toBe(413);
    expect((await auth('/email-change/confirm', { body: big })).statusCode).toBe(413);
    expect(
      (await auth('/sign-in/email', { body: { email: 'a@b.c', password: big.token } })).statusCode,
    ).toBe(413);
  });
});
