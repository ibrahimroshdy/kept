import type pg from 'pg';
import type { Auth } from './auth.js';
import { isMfaSatisfied } from './security.js';

/**
 * A signed-in session as Kept's own routes see it (spike S2).
 * - `mfa`: a second factor was proven in this session (TOTP, a backup code, or a passkey with
 *   user verification; never an emailed OTP). It becomes `app.mfa` in `withScope()`, and `require_2fa` locations stay
 *   hidden while it is false (§7.14, D190), including for users who never enrolled.
 * - `mfaPending`: the user has two-factor enabled but this session hasn't proven it; such a
 *   session is refused everywhere except finishing or abandoning sign-in (D176).
 */
export type ResolvedSession = {
  userId: string;
  sessionId: string;
  twoFactorEnabled: boolean;
  mfa: boolean;
  mfaPending: boolean;
};

export type SessionResolution = {
  session: ResolvedSession | null;
  /** Set-Cookie and cache headers from a sliding refresh; forward them on the reply. */
  responseHeaders: Headers | null;
};

/** Resolves the caller's session from request headers (cookie). `authPool` is kept_auth. */
export async function resolveSession(
  auth: Auth,
  authPool: pg.Pool,
  headers: Headers,
): Promise<SessionResolution> {
  const { headers: responseHeaders, response } = await auth.api.getSession({
    headers,
    returnHeaders: true,
  });
  if (!response) return { session: null, responseHeaders };
  const twoFactorEnabled = response.user.twoFactorEnabled === true;
  const mfa = await isMfaSatisfied(authPool, response.session.id);
  return {
    session: {
      userId: response.user.id,
      sessionId: response.session.id,
      twoFactorEnabled,
      mfa,
      mfaPending: twoFactorEnabled && !mfa,
    },
    responseHeaders,
  };
}

export type Scope = { userId: string; mfa: boolean };

export type GateDecision =
  | { ok: true; scope: Scope }
  | { ok: false; status: 401; code: 'unauthenticated' }
  | { ok: false; status: 403; code: 'mfa_required' };

/** The decision a protected Kept route makes (task 17 turns it into a preHandler). */
export function gateSession(session: ResolvedSession | null): GateDecision {
  if (!session) return { ok: false, status: 401, code: 'unauthenticated' };
  if (session.mfaPending) return { ok: false, status: 403, code: 'mfa_required' };
  return { ok: true, scope: { userId: session.userId, mfa: session.mfa } };
}
