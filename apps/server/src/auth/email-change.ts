import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { auditAccountEvent } from '../accounts/account-audit.js';
import type { Pools } from '../db/pools.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, invalid } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { AUTH_BASE_PATH, type Auth, linkUrl } from './auth.js';
import { isUndeliverableEmail } from './emails.js';
import { ANONYMOUS_BODY_LIMIT, authHeaders, requireScope, reserveTokenAttempt } from './http.js';
import { requireReauthentication } from './reauth.js';
import { limiterKey, MAIL_LINKS_PER_HOUR, reserveInWindow } from './sign-in-limiter.js';

// Changing the sign-in email (D176, task 17). Better Auth's /change-email is switched off: it
// confirms by GET with a stateless, replayable token, and its last step signs in whoever clicks.
// Kept's flow, two steps across two mailboxes:
//   1. POST /api/v1/me/email-change {newEmail, password?}: re-authentication (the password, or
//      a session signed in within the last 10 minutes when the account has none), then a link to
//      the *old* address.
//   2. POST /api/v1/auth/email-change/confirm {token} with that link's token: a link to the *new*
//      address.
//   3. The same route with the new address's token: the email changes, is marked verified, every
//      other session is signed out, and the old address is told.
// Tokens: 32 random bytes, stored only as a SHA-256 hash in Better Auth's verification table,
// consumed atomically (single use), valid for an hour, carried in a #fragment and posted by the
// web page (D181). An address that belongs to another account is handled exactly like a free one
// up to the last step, which then fails as an invalid link, so nobody learns which addresses
// have accounts.

export const EMAIL_CHANGE_TTL_SECONDS = 3600;
/** How recent a sign-in counts as re-authentication for an account with no password (reauth.ts). */
export { FRESH_SIGN_IN_SECONDS } from './reauth.js';

type Pending = { userId: string; fromEmail: string; newEmail: string; stage: 'old' | 'new' };

const identifier = (token: string) =>
  `email-change:${createHash('sha256').update(token).digest('base64url')}`;

const Stage = z.object({ stage: z.enum(['confirm_old', 'verify_new', 'done']) });

export type EmailChangeOptions = {
  auth: Auth;
  pools: Pick<Pools, 'app' | 'auth'>;
  mailer: Mailer;
  publicUrl: string;
  trustedProxies: readonly string[];
  /** A mail that could not be sent (the request itself still succeeds). */
  onMailError?: (err: unknown) => void;
};

export async function emailChangeRoutes(app: KeptApp, opts: EmailChangeOptions): Promise<void> {
  const { auth, pools, mailer, publicUrl, trustedProxies } = opts;

  const send = (mail: Parameters<Mailer['send']>[0]) => {
    mailer.send(mail).catch((err: unknown) => opts.onMailError?.(err));
  };

  async function issue(pending: Pending): Promise<string> {
    const ctx = await auth.$context;
    const token = randomBytes(32).toString('base64url');
    await ctx.internalAdapter.createVerificationValue({
      identifier: identifier(token),
      value: JSON.stringify(pending),
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000),
    });
    return token;
  }

  app.post(
    '/api/v1/me/email-change',
    {
      schema: {
        body: z.object({ newEmail: z.email().max(254), password: z.string().max(128).optional() }),
        response: { 202: Stage },
      },
    },
    async (req, reply) => {
      const scope = requireScope(req);
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.findUserById(scope.userId);
      if (!user) throw forbidden();
      if (isUndeliverableEmail(user.email)) {
        throw forbidden('This account signs in with a username and has no email address.');
      }
      const fromEmail = user.email.toLowerCase();
      const newEmail = req.body.newEmail.trim().toLowerCase();
      if (isUndeliverableEmail(newEmail)) invalidEmail();
      if (newEmail === fromEmail) throw invalid('That is already your email address.');

      // Re-authentication (D176).
      await requireReauthentication(req, reply, {
        auth,
        pools,
        trustedProxies,
        password: req.body.password,
        hints: { stale: 'Sign in again, then change your email.' },
      });

      const limit = await reserveInWindow(
        pools.auth,
        limiterKey('email-change', scope.userId),
        MAIL_LINKS_PER_HOUR,
        3600,
      );
      if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);

      const token = await issue({ userId: scope.userId, fromEmail, newEmail, stage: 'old' });
      send({
        kind: 'email-change-confirm',
        to: user.email,
        url: linkUrl(publicUrl, '/auth/email-change', token),
        newEmail,
      });
      return reply.code(202).send({ stage: 'confirm_old' as const });
    },
  );

  app.post(
    `${AUTH_BASE_PATH}/email-change/confirm`,
    {
      // The token is the permission; a session (possibly on another device) is only used to
      // keep the confirming device signed in at the last step.
      config: { auth: 'optional' },
      bodyLimit: ANONYMOUS_BODY_LIMIT,
      schema: {
        body: z.object({ token: z.string().min(1).max(512) }),
        response: { 200: Stage },
      },
    },
    async (req, reply) => {
      await reserveTokenAttempt(pools.auth, authHeaders(req, trustedProxies), reply);
      const ctx = await auth.$context;
      const consumed = await ctx.internalAdapter.consumeVerificationValue(
        identifier(req.body.token),
      );
      if (!consumed) throw new AppError('token_invalid', 400);
      const pending = JSON.parse(consumed.value) as Pending;
      const user = await ctx.internalAdapter.findUserById(pending.userId);
      // The account moved on (another change finished first): this link is stale.
      if (!user || user.email.toLowerCase() !== pending.fromEmail) {
        throw new AppError('token_invalid', 400);
      }

      if (pending.stage === 'old') {
        const token = await issue({ ...pending, stage: 'new' });
        // An address another account already has gets no mail, and the answer is the same.
        if (!(await ctx.internalAdapter.findUserByEmail(pending.newEmail))) {
          send({
            kind: 'email-change-verify',
            to: pending.newEmail,
            url: linkUrl(publicUrl, '/auth/email-change', token),
          });
        }
        return { stage: 'verify_new' as const };
      }

      let changed: number | null;
      try {
        ({ rowCount: changed } = await pools.auth.query(
          `UPDATE auth."user" SET email = $1, email_verified = true, updated_at = now()
            WHERE id = $2 AND lower(email) = $3`,
          [pending.newEmail, pending.userId, pending.fromEmail],
        ));
      } catch (err) {
        // Taken meanwhile (auth.user.email is unique).
        if ((err as { code?: string }).code === '23505') throw new AppError('token_invalid', 400);
        throw err;
      }
      if (!changed) throw new AppError('token_invalid', 400);

      // Every other session is signed out (D176). The confirming device keeps its session if it
      // is this user's and has proven its second factor (security review M7: a pending one
      // would otherwise outlive the change it shouldn't have been able to watch).
      const session = req.authSession;
      const keep =
        session?.userId === pending.userId && !session.mfaPending ? session.sessionId : null;
      await pools.auth.query(
        'DELETE FROM auth.session WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)',
        [pending.userId, keep],
      );
      // A reset link mailed to the old address must not outlive the move (security review M2).
      // Identifiers keep their kind prefix when hashed (auth.ts hashVerificationIdentifier).
      await pools.auth.query(
        `DELETE FROM auth.verification WHERE identifier LIKE 'reset-password:%' AND value = $1`,
        [pending.userId],
      );
      send({ kind: 'email-changed', to: pending.fromEmail, newEmail: pending.newEmail });
      await auditAccountEvent(pools.app, pending.userId, {
        action: 'account.email_change',
        entity: { type: 'user', id: pending.userId },
        before: { email: pending.fromEmail },
        after: { email: pending.newEmail },
        requestId: req.id,
      });
      return { stage: 'done' as const };
    },
  );
}

/** 429 with the wait in the body and in Retry-After (what the web client reads). */
function rateLimited(reply: FastifyReply, retryAfter: number): AppError {
  reply.header('retry-after', String(retryAfter));
  return new AppError('rate_limited', 429, undefined, { retryAfter });
}

function invalidEmail(): never {
  throw invalid('That email address cannot receive mail.');
}
