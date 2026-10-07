import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import { AppError, forbidden, invalid } from '../http/errors.js';
import type { Auth } from './auth.js';
import { requestClientIp } from './client-ip.js';
import { authHeaders, requireScope } from './http.js';
import { clearSignInFailures, limiterKey, reserveSignInAttempt } from './sign-in-limiter.js';

// Re-authentication for a sensitive action (D176): changing the sign-in email (email-change.ts)
// and downloading the recovery kit (admin/recovery-kit-routes.ts, D182). An account with a
// password types it again; one without (passkey or magic link only) needs a session signed in
// within FRESH_SIGN_IN_SECONDS, which a passkey sign-in gives.
//
// The 403 `reauth_required` carries `reauth`: `password` (send the password) or `sign_in` (this
// account has none: sign in again), so a screen can offer the right one. Wrong passwords count
// against the same account + IP limiter as sign-in (D172), and a right one clears it.

/** How recent a sign-in counts as re-authentication for an account with no password. */
export const FRESH_SIGN_IN_SECONDS = 10 * 60;

export type ReauthMethod = 'password' | 'sign_in';

export type ReauthOptions = {
  auth: Auth;
  pools: Pick<Pools, 'auth'>;
  trustedProxies: readonly string[];
  /** The password the request carries, if any. */
  password: string | undefined;
  /** What each refusal says (the action's own words). */
  hints?: { missing?: string; wrong?: string; stale?: string };
};

async function sessionAgeSeconds(pool: pg.Pool, sessionId: string): Promise<number | null> {
  const { rows } = await pool.query<{ age: number }>(
    'SELECT extract(epoch FROM now() - created_at)::float8 AS age FROM auth.session WHERE id = $1',
    [sessionId],
  );
  return rows[0]?.age ?? null;
}

const refuse = (reauth: ReauthMethod, hint: string) =>
  new AppError('reauth_required', 403, hint, { reauth });

/** 429 with the wait in the body and in Retry-After (what the web client reads). */
function rateLimited(reply: FastifyReply, retryAfter: number): AppError {
  reply.header('retry-after', String(retryAfter));
  return new AppError('rate_limited', 429, undefined, { retryAfter });
}

/**
 * Throws 403 `reauth_required` unless the signed-in person has just proven it is them. Returns
 * the account's user row (its email) for the caller's own use.
 */
export async function requireReauthentication(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: ReauthOptions,
): Promise<{ email: string }> {
  const scope = requireScope(req);
  const ctx = await opts.auth.$context;
  const user = await ctx.internalAdapter.findUserById(scope.userId);
  if (!user) throw forbidden();
  const accounts = await ctx.internalAdapter.findAccounts(scope.userId);
  const credential = accounts.find((a) => a.providerId === 'credential' && a.password);
  if (credential?.password) {
    if (!opts.password) throw refuse('password', opts.hints?.missing ?? 'Enter your password.');
    const ip = requestClientIp(authHeaders(req, opts.trustedProxies));
    if (!ip) throw invalid('The client address could not be determined.');
    const key = limiterKey('password', user.email.toLowerCase(), ip);
    const decision = await reserveSignInAttempt(opts.pools.auth, key);
    if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);
    const ok = await ctx.password.verify({ hash: credential.password, password: opts.password });
    if (!ok) throw refuse('password', opts.hints?.wrong ?? 'That password is not right.');
    await clearSignInFailures(opts.pools.auth, key);
    return { email: user.email };
  }
  const age = req.authSession
    ? await sessionAgeSeconds(opts.pools.auth, req.authSession.sessionId)
    : null;
  if (age === null || age > FRESH_SIGN_IN_SECONDS) {
    throw refuse('sign_in', opts.hints?.stale ?? 'Sign in again, then try again.');
  }
  return { email: user.email };
}
