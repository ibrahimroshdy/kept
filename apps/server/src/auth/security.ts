import { createHash } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import type pg from 'pg';
import { requestClientIp } from './client-ip.js';
import { isUndeliverableEmail } from './emails.js';
import {
  clearSignInFailures,
  limiterKey,
  MAIL_LINKS_PER_ADDRESS_PER_HOUR,
  MAIL_LINKS_PER_HOUR,
  reserveInWindow,
  reserveSignInAttempt,
} from './sign-in-limiter.js';

// Spike S2 (V32). Better Auth's twoFactor plugin gates only /sign-in/email, /sign-in/username
// and /sign-in/phone-number (its after-hook matcher). Magic link, passkey and social/OIDC
// callbacks create full sessions without a second factor. So Kept keeps its own flag per
// session (auth.session_mfa) and gates on it (D176, §7.14):
// - a session is "satisfied" once a second factor is proven in it: TOTP, a backup code, or a
//   passkey assertion with user verification (UV). Not an emailed OTP: email is the channel a
//   magic link already used, so it would be the same factor twice (Phase B review, item 6);
// - a session whose user has two-factor enabled but isn't satisfied is *pending*, and every
//   Better Auth endpoint except the ones needed to finish or abandon sign-in refuses it with
//   403 MFA_REQUIRED. Kept's own routes apply the same rule (auth/session.ts).
// Because absence of the flag means "not satisfied", a sign-in path Better Auth adds later is
// gated by default rather than trusted by default.

export type SessionLike = {
  session: { id: string; userId: string };
  user: {
    id: string;
    email?: string;
    emailVerified?: boolean | null;
    twoFactorEnabled?: boolean | null;
  };
};
export type SessionLookup = (headers: Headers) => Promise<SessionLike | null>;

/** Credential changes the account's owner is told about by mail (security review I3): a stolen
 * session that adds a passkey, drops two-factor or changes the password is then at least seen. */
export type SecurityEvent =
  | 'passkey-added'
  | 'two-factor-disabled'
  | 'password-changed'
  /** D197: a reset proved the unverified address; every other way in was removed. */
  | 'unverified-account-reset'
  /** D197: a first magic-link sign-in proved the unverified address; every other way in (the
   * password too, which Better Auth itself removes) was removed. */
  | 'unverified-account-link';

/** Better Auth endpoints whose success is a SecurityEvent. A password reset is reported through
 * Better Auth's `onPasswordReset` callback instead (auth.ts): it has no session to read. */
export const SECURITY_NOTICE_PATHS: ReadonlyMap<string, SecurityEvent> = new Map([
  ['/passkey/verify-registration', 'passkey-added'],
  ['/two-factor/disable', 'two-factor-disabled'],
  ['/change-password', 'password-changed'],
]);

/** Second-factor endpoints (relative to basePath) and the method each proves. */
export const SECOND_FACTOR_PATHS: ReadonlyMap<string, 'totp' | 'backup_code'> = new Map([
  ['/two-factor/verify-totp', 'totp'],
  ['/two-factor/verify-backup-code', 'backup_code'],
]);
/** Better Auth's emailed-OTP second factor, switched off in auth.ts (`disabledPaths`). */
export const EMAIL_OTP_PATHS = ['/two-factor/send-otp', '/two-factor/verify-otp'];
export const PASSKEY_VERIFY_PATH = '/passkey/verify-authentication';
const CHANGE_PASSWORD_PATH = '/change-password';
const MAGIC_LINK_VERIFY_PATH = '/magic-link/verify';

/** Enrolling a passkey or TOTP. D197: once mail is delivered, an unverified address may not. */
export const ENROLMENT_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/two-factor/enable',
]);

/** Credential changes: each signs out every other session of the user (D176, task 17). A
 * password reset does the same through Better Auth's `revokeSessionsOnPasswordReset`. */
export const REVOKE_OTHERS_PATHS = new Set([
  CHANGE_PASSWORD_PATH,
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/generate-backup-codes',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
]);

/** An OAuth sign-in's callback as hooks see it (step 6, generic OIDC; spike S6.7). It ends by
 * throwing its redirect, so a successful one reaches after-hooks as a 302 APIError. */
export const OAUTH_CALLBACK_PATH = '/callback/:id';

/** Whether an after-hook's endpoint failed: an APIError, except the OAuth callback's 302, which
 * is how it says it succeeded. */
function failed(path: string | undefined, returned: unknown): boolean {
  if (!isAPIError(returned)) return false;
  return !(
    path === OAUTH_CALLBACK_PATH && (returned as { statusCode?: unknown }).statusCode === 302
  );
}

/** Endpoints that create a session by signing someone in. A session the request already carried
 * is deleted once the new one exists: the token is rotated at every sign-in (task 17). */
export const SIGN_IN_SESSION_PATHS = new Set([
  '/sign-in/email',
  '/sign-in/username',
  '/magic-link/verify',
  PASSKEY_VERIFY_PATH,
  ...SECOND_FACTOR_PATHS.keys(),
  OAUTH_CALLBACK_PATH,
]);

/** Emailed links, limited per account (§3.2): the kind names the limiter bucket. */
const MAIL_LINK_PATHS: ReadonlyMap<string, 'magic-link' | 'password-reset'> = new Map([
  ['/sign-in/magic-link', 'magic-link'],
  ['/request-password-reset', 'password-reset'],
]);

/** What a pending session may still call. Everything else answers 403 MFA_REQUIRED. */
const PENDING_ALLOWED = new Set([
  '/get-session',
  '/sign-out',
  ...SECOND_FACTOR_PATHS.keys(),
  '/magic-link/verify',
  '/passkey/generate-authenticate-options',
  PASSKEY_VERIFY_PATH,
  // Flows that need no session at all: a pending one gains nothing by reaching them.
  '/request-password-reset',
  '/reset-password',
  '/ok',
  '/error',
]);
const PENDING_ALLOWED_PREFIXES = ['/sign-in/'];

export function pendingSessionMayCall(path: string): boolean {
  return PENDING_ALLOWED.has(path) || PENDING_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

const PASSWORD_SIGN_IN_PATHS = new Set(['/sign-in/email', '/sign-in/username']);

export async function isMfaSatisfied(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM auth.session_mfa WHERE session_id = $1', [
    sessionId,
  ]);
  return (rowCount ?? 0) > 0;
}

async function satisfiedMethod(pool: pg.Pool, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ method: string }>(
    'SELECT method FROM auth.session_mfa WHERE session_id = $1',
    [sessionId],
  );
  return rows[0]?.method ?? null;
}

/** Deletes every session of `userId` except `keepSessionId` (session_mfa rows go by cascade). */
async function deleteOtherSessions(
  pool: pg.Pool,
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await pool.query('DELETE FROM auth.session WHERE user_id = $1 AND id <> $2', [
    userId,
    keepSessionId,
  ]);
}

async function markMfaSatisfied(pool: pg.Pool, sessionId: string, method: string): Promise<void> {
  await pool.query(
    `INSERT INTO auth.session_mfa (session_id, method) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET method = excluded.method, satisfied_at = now()`,
    [sessionId, method],
  );
}

// The passkey plugin verifies with requireUserVerification: false and tells us the result only
// through its afterVerification callback, before it creates the session. The callback and the
// after-hook share the per-request AuthContext object, so the flag travels on a WeakMap.
const passkeyUserVerified = new WeakMap<object, boolean>();
export function rememberPasskeyVerification(authContext: object, userVerified: boolean): void {
  passkeyUserVerified.set(authContext, userVerified);
}

// D197's magic-link clause: the before-hook finds whose link it is and whether their address was
// still unverified (Better Auth marks it verified inside the endpoint, so the after-hook can't
// tell any more), and the after-hook claims the account once the new session exists.
const unverifiedMagicLinkUser = new WeakMap<object, string>();

// change-password with revokeOtherSessions deletes every session (and, by cascade, its
// session_mfa row) and issues a new one. The before-hook notes how the old session was
// satisfied, on the same per-request object, and the after-hook carries it to the new one.
const satisfiedBeforePasswordChange = new WeakMap<object, string>();

function tooManyAttempts(retryAfter: number): APIError {
  return new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many attempts. Try again later.', code: 'SIGN_IN_DELAYED', retryAfter },
    { 'X-Retry-After': String(retryAfter) },
  );
}

function clientIpUnknown(): APIError {
  return new APIError('BAD_REQUEST', {
    message: 'The client address could not be determined.',
    code: 'CLIENT_IP_UNKNOWN',
  });
}

/** The account + IP limiter key for a password sign-in; null without a client address. */
function passwordKey(ctx: { body?: unknown; headers?: Headers | undefined }): string | null {
  // Never a shared placeholder: with no address every such request would share one bucket, and
  // anyone could lock everyone out (Phase B review, item 2). The caller refuses instead.
  const ip = requestClientIp(ctx.headers);
  if (!ip) return null;
  const body = (ctx.body ?? {}) as { email?: unknown; username?: unknown };
  return limiterKey('password', String(body.email ?? body.username ?? ''), ip);
}

export type KeptSecurityOptions = {
  pool: pg.Pool;
  getSession: SessionLookup;
  /** Tells the account's owner about a credential change (never awaited by the request). */
  notify?: (user: { id: string; email: string }, event: SecurityEvent) => void;
  /** D197: once mail is delivered (KEPT_SMTP_URL), an account whose address isn't verified may
   * not enrol a passkey or TOTP. An email-bound invite verifies the address when accepted. */
  enrolmentNeedsVerifiedEmail?: boolean;
};

export function keptSecurity(opts: KeptSecurityOptions): BetterAuthPlugin {
  const { pool, getSession } = opts;
  return {
    id: 'kept-security',
    hooks: {
      before: [
        {
          // `.invalid` addresses belong to managed accounts and are never accepted from a person
          // (D93, D176). Only the admin path (`/admin/create-user`, server-side) creates them.
          matcher: (ctx) => ctx.path === '/sign-up/email' || ctx.path === '/change-email',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { email?: unknown; newEmail?: unknown };
            const email = String(body.email ?? body.newEmail ?? '');
            if (isUndeliverableEmail(email)) {
              throw new APIError('BAD_REQUEST', {
                message: 'That email address cannot receive mail.',
                code: 'EMAIL_UNDELIVERABLE',
              });
            }
          }),
        },
        {
          // "Trust this device" would let a later password sign-in skip the challenge and get a
          // session Kept never marked. Kept doesn't offer it (spike S2); refuse it outright.
          matcher: (ctx) => (ctx.path ?? '').startsWith('/two-factor/'),
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { trustDevice?: unknown };
            if (body.trustDevice !== undefined && body.trustDevice !== false) {
              throw new APIError('BAD_REQUEST', {
                message: 'Trusting a device is not supported.',
                code: 'TRUST_DEVICE_UNSUPPORTED',
              });
            }
          }),
        },
        {
          // D197: enrolment waits for a verified address once mail can verify it. The way to
          // verify is a magic-link sign-in (or a password reset), which also claims the account.
          matcher: (ctx) =>
            opts.enrolmentNeedsVerifiedEmail === true && ENROLMENT_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers) return;
            const user = (await getSession(ctx.headers))?.user;
            if (!user || user.emailVerified || isUndeliverableEmail(user.email ?? '')) return;
            throw new APIError('FORBIDDEN', {
              message:
                'Confirm your email address first: sign in with a link sent to it, then try again.',
              code: 'EMAIL_UNVERIFIED',
            });
          }),
        },
        {
          // D197's magic-link clause (before): whose link is this, and is their address still
          // unverified? The token is stored hashed (magicLink storeToken: 'hashed', SHA-256
          // base64url), and findVerificationValue() applies the identifier hashing itself.
          matcher: (ctx) => ctx.path === MAGIC_LINK_VERIFY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const token = (ctx.query as { token?: unknown } | undefined)?.token;
            if (typeof token !== 'string' || !token) return;
            const stored = createHash('sha256').update(token).digest('base64url');
            const found = await ctx.context.internalAdapter.findVerificationValue(stored);
            if (!found) return;
            let email: unknown;
            try {
              email = (JSON.parse(found.value) as { email?: unknown }).email;
            } catch {
              return;
            }
            if (typeof email !== 'string' || isUndeliverableEmail(email)) return;
            const user = (await ctx.context.internalAdapter.findUserByEmail(email))?.user;
            if (user && !user.emailVerified) unverifiedMagicLinkUser.set(ctx.context, user.id);
          }),
        },
        {
          // Password reset and magic links (§3.2): 3 per hour per address from one client IP,
          // and 10 per hour per address in all (security review M4: keyed on the address alone,
          // anyone anywhere could spend someone's three and block their magic-link sign-in).
          // Keyed on the address as typed, whether or not an account has it, so the answer never
          // tells which do.
          matcher: (ctx) => MAIL_LINK_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const kind = MAIL_LINK_PATHS.get(ctx.path ?? '');
            const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '');
            if (!kind || !email) return; // Better Auth's own validation answers
            const ip = requestClientIp(ctx.headers);
            if (!ip) throw clientIpUnknown();
            for (const [key, max] of [
              [limiterKey(kind, email, ip), MAIL_LINKS_PER_HOUR],
              [limiterKey(`${kind}-address`, email), MAIL_LINKS_PER_ADDRESS_PER_HOUR],
            ] as const) {
              const decision = await reserveInWindow(pool, key, max, 3600);
              if (!decision.allowed) {
                throw new APIError(
                  'TOO_MANY_REQUESTS',
                  {
                    message: 'Too many links requested. Try again later.',
                    code: 'RATE_LIMITED',
                    retryAfter: decision.retryAfter,
                  },
                  { 'X-Retry-After': String(decision.retryAfter) },
                );
              }
            }
          }),
        },
        {
          // The 2FA gate for pending sessions.
          matcher: (ctx) => !pendingSessionMayCall(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers) return; // a server-side call with no caller identity
            const found = await getSession(ctx.headers);
            if (!found?.user.twoFactorEnabled) return;
            if (await isMfaSatisfied(pool, found.session.id)) return;
            throw new APIError('FORBIDDEN', {
              message: 'Two-factor verification required',
              code: 'MFA_REQUIRED',
            });
          }),
        },
        {
          // Account + IP delays on password sign-in (D172).
          matcher: (ctx) => PASSWORD_SIGN_IN_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const key = passwordKey(ctx);
            if (!key) throw clientIpUnknown();
            const decision = await reserveSignInAttempt(pool, key);
            if (!decision.allowed) throw tooManyAttempts(decision.retryAfter);
          }),
        },
        {
          // A second factor tried inside an existing (pending) session has no attempt limit in
          // Better Auth; the sign-in challenge flow has its own. Key on the user alone: only the
          // session holder can make these attempts.
          matcher: (ctx) => SECOND_FACTOR_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers) return;
            const found = await getSession(ctx.headers);
            if (!found) return;
            const key = limiterKey('second-factor', found.user.id);
            const decision = await reserveSignInAttempt(pool, key);
            if (!decision.allowed) throw tooManyAttempts(decision.retryAfter);
          }),
        },
        {
          matcher: (ctx) => ctx.path === CHANGE_PASSWORD_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers) return;
            const found = await getSession(ctx.headers);
            if (!found) return;
            const method = await satisfiedMethod(pool, found.session.id);
            if (method) satisfiedBeforePasswordChange.set(ctx.context, method);
          }),
        },
      ],
      after: [
        {
          // D197's magic-link clause (after): the link proved the mailbox of an unverified
          // account. Better Auth has already removed its password and sessions and marked it
          // verified; Kept removes what Better Auth leaves (passkeys, TOTP and backup codes, any
          // session but the new one) and tells the owner.
          matcher: (ctx) => ctx.path === MAGIC_LINK_VERIFY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const userId = unverifiedMagicLinkUser.get(ctx.context);
            unverifiedMagicLinkUser.delete(ctx.context);
            if (!userId || isAPIError(ctx.context.returned)) return;
            const created = ctx.context.newSession;
            if (!created || created.user.id !== userId) return;
            await claimUnverifiedAccount(pool, userId, created.session.id);
            opts.notify?.({ id: userId, email: created.user.email }, 'unverified-account-link');
          }),
        },
        {
          matcher: (ctx) => PASSWORD_SIGN_IN_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            // The before-hook reserved the attempt (it counts as a failure already); only a
            // success changes anything. Every failure counts, not only a wrong password.
            if (isAPIError(ctx.context.returned)) return;
            const key = passwordKey(ctx);
            if (key) await clearSignInFailures(pool, key);
          }),
        },
        {
          matcher: (ctx) => SECOND_FACTOR_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const method = SECOND_FACTOR_PATHS.get(ctx.path ?? '');
            if (!method || isAPIError(ctx.context.returned)) return;
            const existing = ctx.context.session as SessionLike | null | undefined;
            // Sign-in challenge: a new session. Existing-session verify: that session.
            // Enabling TOTP: Better Auth swaps in a new session (newSession).
            const sessionId = ctx.context.newSession?.session.id ?? existing?.session.id;
            if (!sessionId) return;
            await markMfaSatisfied(pool, sessionId, method);
            if (existing) {
              await clearSignInFailures(pool, limiterKey('second-factor', existing.user.id));
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === CHANGE_PASSWORD_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const method = satisfiedBeforePasswordChange.get(ctx.context);
            satisfiedBeforePasswordChange.delete(ctx.context);
            if (!method || isAPIError(ctx.context.returned)) return;
            const created = ctx.context.newSession;
            if (created) await markMfaSatisfied(pool, created.session.id, method);
          }),
        },
        {
          // A password or second-factor change signs out every other session (D176). The
          // session that made the change stays (or its replacement, when Better Auth swapped it).
          matcher: (ctx) => REVOKE_OTHERS_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const current =
              ctx.context.newSession ?? (ctx.context.session as SessionLike | null | undefined);
            if (!current) return;
            await deleteOtherSessions(pool, current.user.id, current.session.id);
          }),
        },
        {
          // I3: the owner hears of every passkey added, two-factor switched off and password
          // changed, so a stolen session that does one of them doesn't do it silently.
          matcher: (ctx) => SECURITY_NOTICE_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const event = SECURITY_NOTICE_PATHS.get(ctx.path ?? '');
            if (!event || !opts.notify || isAPIError(ctx.context.returned)) return;
            const current =
              ctx.context.newSession ?? (ctx.context.session as SessionLike | null | undefined);
            const user = current?.user as { id: string; email?: string | null } | undefined;
            if (user?.email) opts.notify({ id: user.id, email: user.email }, event);
          }),
        },
        {
          // Rotation at sign-in: the session cookie the request came with (anyone's) is retired
          // once a new session exists, so a token that was planted or leaked before sign-in
          // is worthless after it.
          matcher: (ctx) => SIGN_IN_SESSION_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            if (failed(ctx.path, ctx.context.returned)) return;
            const created = ctx.context.newSession;
            if (!created) return;
            // Read from the request's own cookie: a session lookup here would be answered from
            // the request's cache, which already holds the new session.
            const previousToken = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (previousToken && previousToken !== created.session.token) {
              await pool.query('DELETE FROM auth.session WHERE token = $1 AND id <> $2', [
                previousToken,
                created.session.id,
              ]);
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === PASSKEY_VERIFY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const created = ctx.context.newSession;
            if (!created) return;
            // A passkey with user verification counts as two factors (§7.14, D190).
            if (passkeyUserVerified.get(ctx.context) === true) {
              await markMfaSatisfied(pool, created.session.id, 'passkey');
            }
          }),
        },
      ],
    },
  };
}

/**
 * D197 (security review of tasks 19–21, M1): a completed password reset, or a first magic-link
 * sign-in, proves the mailbox. On an account whose address wasn't verified yet, whoever signed
 * up with it before its owner may have planted a passkey or TOTP, so the claim marks the address
 * verified and deletes every passkey, the TOTP secret and backup codes, and every session but
 * `keepSessionId` (the magic link's new one), in one kept_auth transaction. The caller mails the
 * owner.
 */
export async function claimUnverifiedAccount(
  pool: pg.Pool,
  userId: string,
  keepSessionId: string | null = null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE auth."user" SET email_verified = true, two_factor_enabled = false, updated_at = now()
        WHERE id = $1`,
      [userId],
    );
    await client.query('DELETE FROM auth.passkey WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM auth.two_factor WHERE user_id = $1', [userId]);
    await client.query(
      'DELETE FROM auth.session WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
      [userId, keepSessionId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
