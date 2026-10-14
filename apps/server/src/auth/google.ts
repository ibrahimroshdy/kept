import type { Env } from '../config/env.js';
import { AUTH_BASE_PATH } from './auth.js';

// Google sign-in (1.2, D226; D50, D127, D176). Better Auth's own Google provider does the
// protocol: PKCE, the code exchanged at Google's fixed token endpoint, the id token verified
// against Google's keys. Kept's rules are the ones generic OIDC already has (auth/oidc.ts):
// - The account key is Google's `sub`, never the email. Linking is explicit only, from a session
//   younger than FRESH_SESSION_SECONDS (`/link-social`, and unlinking too); an existing user's
//   address coming back from Google is `account_not_linked`.
// - `user.validateUserInfo` (externalIdentityPolicy) refuses an unverified or `.invalid` email,
//   and lets a new user in only with an invite: Google never autoprovisions (D127).
// - Google's tokens are not kept, and Kept's session_mfa gate applies to the callback's session.
// Configured by KEPT_GOOGLE_CLIENT_ID and KEPT_GOOGLE_CLIENT_SECRET, read at boot; Google's
// endpoints are fixed, so there is no discovery and nothing user-supplied to guard (D128).

/** Better Auth's provider id; it names the callback path `/callback/google`. */
export const GOOGLE_PROVIDER_ID = 'google';

export type GoogleConfig = { clientId: string; clientSecret: string };

/** Google's client, or null when it isn't configured (loadEnv() refused half of one). */
export function googleConfigOf(
  env: Partial<Pick<Env, 'KEPT_GOOGLE_CLIENT_ID' | 'KEPT_GOOGLE_CLIENT_SECRET'>>,
): GoogleConfig | null {
  const clientId = env.KEPT_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.KEPT_GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The redirect URI to register with Google: Kept's callback for the provider. */
export function googleCallbackUrl(publicUrl: string): string {
  return new URL(`${AUTH_BASE_PATH}/callback/${GOOGLE_PROVIDER_ID}`, publicUrl).toString();
}

/** Admin → Status's Google row, and the sign-in page's button (GET /api/v1/setup). */
export type GoogleStatus = { configured: boolean; callbackUrl: string | null };

let current: GoogleStatus = { configured: false, callbackUrl: null };

/** This process's Google status, as boot left it. */
export function googleStatus(): GoogleStatus {
  return current;
}

/** Sets the status (boot; tests). */
export function setGoogleStatus(cfg: GoogleConfig | null, publicUrl: string): void {
  current = cfg
    ? { configured: true, callbackUrl: googleCallbackUrl(publicUrl) }
    : { configured: false, callbackUrl: null };
}
