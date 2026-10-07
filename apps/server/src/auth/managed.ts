import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type pg from 'pg';
import { normaliseCrockford, randomCrockford } from '../crypto/crockford.js';
import type { Auth } from './auth.js';
import { MANAGED_EMAIL_DOMAIN, managedEmail } from './emails.js';
import { clearSignInFailures, limiterKey, reserveSignInAttempt } from './sign-in-limiter.js';

// Spike S3 (V14): managed accounts (D47, D114, D164). A managed account has a username and a
// password and no real email: Better Auth requires one, so it gets `<uuid>@managed.invalid`,
// which is never shown or mailed. The admin never learns the password: a reset hands the admin a
// one-time code for the person, who sets their own new password with it (D164).

export const RESET_CODE_LENGTH = 8;
export const RESET_CODE_TTL_SECONDS = 30 * 60;
/** Stands in for the user when the username is unknown, so both paths do the same work. */
const NO_USER_ID = '00000000-0000-7000-8000-000000000000';

const resetIdentifier = (userId: string) => `managed-reset:${userId}`;

/** A managed account is one whose email is Kept's synthetic address (D47, D93). */
export function isManagedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${MANAGED_EMAIL_DOMAIN}`);
}

export type ManagedAccountErrorCode =
  | 'invalid_code'
  | 'code_delayed'
  | 'invalid_password'
  | 'not_managed';

export class ManagedAccountError extends Error {
  readonly code: ManagedAccountErrorCode;
  readonly retryAfter: number | undefined;

  constructor(code: ManagedAccountErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ManagedAccountError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Creates the Better Auth user for a managed account. Task 21 adds the profile and membership. */
export async function createManagedUser(
  auth: Auth,
  input: { username: string; displayName: string; password: string },
): Promise<{ userId: string; email: string; username: string }> {
  const email = managedEmail();
  // A server-side call with no headers: the admin plugin's createUser then needs no admin
  // session. Kept checks who may create managed accounts itself (task 21). The username plugin's
  // create hook validates and lower-cases the username and rejects duplicates.
  const { user } = await auth.api.createUser({
    body: {
      email,
      password: input.password,
      name: input.displayName,
      data: { username: input.username, displayUsername: input.username },
    },
  });
  const created = user as typeof user & { username?: string | null };
  return { userId: user.id, email, username: created.username ?? input.username };
}

/**
 * What the person typed, as the code was issued: case, spaces and hyphens ignored, and
 * Crockford's look-alikes read as the digits they stand for (I and L as 1, O as 0).
 */
export function normaliseResetCode(code: string): string {
  return normaliseCrockford(code);
}

function hashCode(secret: string, userId: string, code: string): string {
  return createHmac('sha256', secret)
    .update(`${userId}\0${normaliseResetCode(code)}`)
    .digest('hex');
}

function sameHash(storedHex: string, givenHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const given = Buffer.from(givenHex, 'hex');
  return stored.length === given.length && timingSafeEqual(stored, given);
}

/**
 * Issues a one-time reset code for a managed account (D164) and signs out its sessions. Only the
 * HMAC of the code is stored (in Better Auth's verification table, keyed by user), so a database
 * leak doesn't reveal it; issuing a new code replaces the old one. Refuses any account that is
 * not managed: a person with an email resets through their email, and nobody may take over
 * their account with a code (Phase B review, item 5). Who may call this is D197's rule
 * (kept.managed_reset_location(), migration 0010). `revokeSessions: false` leaves signing out to
 * the caller, which then does it once its transaction has committed (security review M3).
 */
export async function issueResetCode(
  auth: Auth,
  userId: string,
  opts: { revokeSessions?: boolean } = {},
): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user || !isManagedEmail(user.email)) {
    throw new ManagedAccountError('not_managed', 'Only managed accounts have reset codes.');
  }
  const code = randomCrockford(RESET_CODE_LENGTH);
  const identifier = resetIdentifier(userId);
  await ctx.internalAdapter.deleteVerificationByIdentifier(identifier);
  await ctx.internalAdapter.createVerificationValue({
    identifier,
    value: hashCode(ctx.secret, userId, code),
    expiresAt: new Date(Date.now() + RESET_CODE_TTL_SECONDS * 1000),
  });
  if (opts.revokeSessions ?? true) await ctx.internalAdapter.deleteUserSessions(userId);
  return code;
}

/** Signs a user out everywhere (after a reset code is issued, once its audit event commits). */
export async function revokeUserSessions(auth: Auth, userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

/**
 * Redeems a reset code: sets the new password and signs out every session. Works exactly once.
 * Every attempt is reserved against the same account + IP limiter as sign-in before the code is
 * checked (D172), so parallel guesses get no more tries than serial ones. `ip` is the client
 * address as resolved by auth/client-ip.ts.
 */
export async function redeemResetCode(
  auth: Auth,
  authPool: pg.Pool,
  input: { username: string; code: string; newPassword: string; ip: string },
): Promise<{ userId: string }> {
  if (!isIP(input.ip)) throw new Error('redeemResetCode needs the resolved client IP');
  const ctx = await auth.$context;

  // A bad password is the person's typo, not a guess: answer it before spending an attempt.
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (
    input.newPassword.length < minPasswordLength ||
    input.newPassword.length > maxPasswordLength
  ) {
    throw new ManagedAccountError(
      'invalid_password',
      `Passwords are ${minPasswordLength}–${maxPasswordLength} characters.`,
    );
  }

  const key = limiterKey('reset-code', input.username, input.ip);
  const decision = await reserveSignInAttempt(authPool, key);
  if (!decision.allowed) {
    throw new ManagedAccountError('code_delayed', 'Too many attempts.', decision.retryAfter);
  }
  // The attempt is already counted; a failure just says so.
  const invalid = new ManagedAccountError('invalid_code', 'That code is not valid.');

  const user = await ctx.adapter.findOne<{ id: string; email: string }>({
    model: 'user',
    where: [{ field: 'username', value: input.username.trim().toLowerCase() }],
  });
  // An unknown username does the same work as a wrong code (an HMAC and a lookup), so the
  // response time doesn't say whether the username exists.
  const userId = user && isManagedEmail(user.email) ? user.id : NO_USER_ID;
  const given = hashCode(ctx.secret, userId, input.code);
  const identifier = resetIdentifier(userId);

  // Check before consuming, so a wrong guess doesn't burn the real code…
  const stored = await ctx.internalAdapter.findVerificationValue(identifier);
  if (userId === NO_USER_ID || !stored || stored.expiresAt.getTime() <= Date.now()) throw invalid;
  if (!sameHash(stored.value, given)) throw invalid;

  // …then consume, and compare again against the row actually consumed: a new code issued in
  // between replaces the row, and the old code must not redeem it. (That new code is spent by
  // the race; the admin issues another.) A racing second redeem gets null here.
  const consumed = await ctx.internalAdapter.consumeVerificationValue(identifier);
  if (!consumed || !sameHash(consumed.value, given)) throw invalid;

  const hash = await ctx.password.hash(input.newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      providerId: 'credential',
      accountId: userId,
      userId,
      password: hash,
    });
  }
  await ctx.internalAdapter.deleteUserSessions(userId);
  await clearSignInFailures(authPool, key);
  return { userId };
}
