import { isAPIError } from 'better-auth/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { requestClientIp } from '../auth/client-ip.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import { authHeaders } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, invalid } from '../http/errors.js';
import { type AcceptDeps, inviteInvalid } from '../invites/accept.js';
import { hashInviteToken, isInviteTokenShape } from '../invites/token.js';
import type { Mailer } from '../mail/mailer.js';
import { ensureAccount } from './ensure-account.js';

// Signing up (D33, D127, D190; security review of tasks 17–18 and of tasks 19–21). Better
// Auth's public /sign-up/email is switched off (auth.ts DISABLED_AUTH_PATHS): it answered 422 for
// a taken address. People sign up here, and only
// - while sign-up is open (instance_settings `signup_open`, task 23), or
// - with a live invite. An email invite takes only its own address.
// The answer is 202 `{next: 'sign-in'}` whether the address was free or already had an account,
// with no session: the person signs in next either way, and then accepts the invite.
//
// An invite is *held* for the address (kept.claim_invite(), migration 0010), atomically, before
// any account exists, and is not consumed here. So concurrent sign-ups with one link invite and
// different addresses make one account at most (review I1), and a taken and a free address leave
// the invite looking the same to its preview: held, not used (no oracle for which addresses have
// accounts). The hold lasts ten minutes, for that address alone: the sign-in and accept that
// follow. (This refines D190's "consuming any invite" at account creation: the invite is
// reserved at creation and consumed by the accept right after the first sign-in.)
//
// Both paths hash the password and run ensureAccount() (a new account's rows, or an existing
// one's idempotent check), so the time taken says little; the residual is the new account's
// inserts, a few milliseconds against the hash's tens. A taken address's owner is mailed at most
// once a day. If anything fails once the new auth user exists, it is deleted again and the answer
// is still 202.

export const SIGN_UPS_PER_IP_PER_HOUR = 10;
/** A taken address's owner hears of a sign-up attempt at most this often (review M9). */
export const SIGN_UP_EXISTING_MAIL_SECONDS = 24 * 3600;
/** The instance setting that opens sign-up to anyone (task 23 edits it). */
export const SIGNUP_OPEN_KEY = 'signup_open';

/** Whether sign-up is open to anyone: `instance_settings.signup_open` is JSON `true`. Read as
 * kept_system (system_all on instance_settings, 0006): the caller has no session yet. Closed
 * when unset (carry-over: sign-up is closed by default). */
export async function readSignupOpen(systemPool: pg.Pool): Promise<boolean> {
  const { rows } = await systemPool.query<{ open: boolean }>(
    `SELECT value = 'true'::jsonb AS open FROM public.instance_settings WHERE key = $1`,
    [SIGNUP_OPEN_KEY],
  );
  return rows[0]?.open === true;
}

export const NewAccount = z.object({
  displayName: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});
export type NewAccount = z.infer<typeof NewAccount>;

export const SignUpAnswer = z.object({ next: z.literal('sign-in') });
export const SIGN_UP_ANSWER = { next: 'sign-in' } as const;

export type SignUpDeps = AcceptDeps & {
  mailer: Mailer;
  trustedProxies: readonly string[];
  /** Whether sign-up is open without an invite. Defaults to readSignupOpen(). */
  isSignupOpen?: () => Promise<boolean>;
};

function rateLimited(reply: FastifyReply, retryAfter: number): AppError {
  reply.header('retry-after', String(retryAfter));
  return new AppError('rate_limited', 429, undefined, { retryAfter });
}

/**
 * The whole sign-up, for POST /api/v1/auth/sign-up and an invite accepted without a session.
 * Throws for what doesn't depend on the address (closed, limited, a bad invite or password);
 * otherwise answers the same whether the address was taken.
 */
export async function signUpPerson(
  deps: SignUpDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  account: NewAccount,
  inviteToken: string | null,
): Promise<typeof SIGN_UP_ANSWER> {
  const { auth, pools } = deps;
  const headers = authHeaders(req, deps.trustedProxies);
  const ip = requestClientIp(headers);
  if (!ip) throw invalid('The client address could not be determined.');
  const email = account.email.trim().toLowerCase();
  if (isUndeliverableEmail(email)) throw invalid('That email address cannot receive mail.');

  const limit = await reserveInWindow(
    pools.auth,
    limiterKey('sign-up', ip),
    SIGN_UPS_PER_IP_PER_HOUR,
    3600,
  );
  if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);

  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (account.password.length < minPasswordLength || account.password.length > maxPasswordLength) {
    throw invalid(`Passwords are ${minPasswordLength}–${maxPasswordLength} characters.`);
  }

  if (inviteToken !== null) {
    if (!isInviteTokenShape(inviteToken)) throw inviteInvalid();
    const { rows } = await pools.app.query<{ ok: boolean }>(
      'SELECT kept.claim_invite($1, $2) AS ok',
      [hashInviteToken(inviteToken), email],
    );
    if (!rows[0]?.ok) throw inviteInvalid();
  } else if (!(await (deps.isSignupOpen ?? (() => readSignupOpen(pools.system)))())) {
    throw forbidden('Sign-up is closed. Ask someone who uses Kept for an invite.');
  }

  const taken = async (existingUserId: string | null) => {
    // The same work as a new account's: the password hash, then ensureAccount() (idempotent for
    // an account that exists). Then a word to the address's owner, at most once a day.
    await ctx.password.hash(account.password);
    if (existingUserId) {
      await ensureAccount(pools, existingUserId, { headers, requestId: req.id }).catch(
        (err: unknown) => deps.log.error({ err }, 'ensureAccount for an existing user failed'),
      );
    }
    const mail = await reserveInWindow(
      pools.auth,
      limiterKey('sign-up-existing', email),
      1,
      SIGN_UP_EXISTING_MAIL_SECONDS,
    );
    if (mail.allowed) {
      deps.mailer.send({ kind: 'sign-up-existing', to: email }).catch((err: unknown) => {
        deps.log.error({ err }, 'mail failed');
      });
    }
    return SIGN_UP_ANSWER;
  };
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) return taken(existing.user.id);

  let userId: string;
  try {
    const created = await auth.api.signUpEmail({
      body: { email, password: account.password, name: account.displayName },
      headers,
    });
    userId = created.user.id;
    // Better Auth signs the new user in; Kept doesn't (the answer must not differ from a taken
    // address's), so that session goes at once.
    if (created.token) {
      await pools.auth.query('DELETE FROM auth.session WHERE token = $1', [created.token]);
    }
  } catch (err) {
    if (isAPIError(err)) {
      // A concurrent sign-up for the same address won the race.
      if (String(err.body?.code ?? '').includes('ALREADY_EXISTS')) return taken(null);
      throw invalid(err.body?.message ?? undefined);
    }
    throw err;
  }

  // The account (task 18): profile, owner account and Personal location from the first moment.
  // The user-created hook does the same, idempotently. A failure here leaves no half-made user:
  // it is deleted, and the answer is the same 202 (review I1).
  try {
    await ensureAccount(pools, userId, { headers, requestId: req.id });
  } catch (err) {
    deps.log.error({ err }, 'sign-up failed after the user was created; removing it');
    await ctx.internalAdapter.deleteUser(userId).catch((cleanupErr: unknown) => {
      deps.log.error({ err: cleanupErr }, 'could not remove a half-made user');
    });
  }
  return SIGN_UP_ANSWER;
}

export async function signUpRoutes(app: KeptApp, deps: SignUpDeps): Promise<void> {
  app.post(
    '/api/v1/auth/sign-up',
    {
      config: { auth: 'none' },
      bodyLimit: 4096,
      schema: {
        body: NewAccount.extend({ inviteToken: z.string().max(128).optional() }),
        response: { 202: SignUpAnswer },
      },
    },
    async (req, reply) => {
      const { inviteToken, ...account } = req.body;
      const answer = await signUpPerson(deps, req, reply, account, inviteToken ?? null);
      return reply.code(202).send(answer);
    },
  );
}
