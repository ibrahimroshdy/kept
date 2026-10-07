/** Better Auth calls (sign-in, second factor, passkeys). Paths in ./paths.ts. */
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from './client';
import { paths } from './paths';
import type { EmailChangeStage, SignInResult, SignUpBody, TwoFactorEnableResult } from './types';

/** "Email or username" is one field: an @ means an email (managed accounts have none, D47). */
export function signInWithPassword(identifier: string, password: string) {
  const id = identifier.trim();
  return id.includes('@')
    ? api.post<SignInResult>(paths.auth.signInEmail, { email: id, password })
    : api.post<SignInResult>(paths.auth.signInUsername, { username: id, password });
}

/** The generic OIDC provider's fixed id on the server (spike S6.7: the callback is `/callback/oidc`). */
export const OIDC_PROVIDER_ID = 'oidc';

/**
 * Starts "Sign in with <name>" (step 6 T16, D127): the server answers the IdP's URL, which the page
 * then opens. Back from the IdP, Kept lands on `callbackURL`, or on `errorCallbackURL` with
 * `?error=<code>`. An invite's token travels in `additionalData` (the spike's invite path), so a
 * new person invited here can join with the IdP; Kept never links on email alone (D176).
 */
export function startOidcSignIn(opts: {
  callbackURL: string;
  errorCallbackURL: string;
  inviteToken?: string;
}) {
  return api.post<{ url: string; redirect: boolean }>(paths.auth.signInSocial, {
    provider: OIDC_PROVIDER_ID,
    callbackURL: opts.callbackURL,
    errorCallbackURL: opts.errorCallbackURL,
    disableRedirect: true,
    ...(opts.inviteToken ? { additionalData: { inviteToken: opts.inviteToken } } : {}),
  });
}

/** The server mails a link to /auth/confirm#token=… (task 17); the fragment never reaches it. */
export function requestMagicLink(email: string) {
  return api.post<{ status: boolean }>(paths.auth.signInMagicLink, { email: email.trim() });
}

/** POSTs the token from the fragment (D176, D181). Never called on page load. */
export function confirmMagicLink(token: string) {
  return api.post<{ mfaRequired: boolean }>(paths.auth.magicLinkVerify, { token });
}

export function signOut() {
  return api.post<unknown>(paths.auth.signOut);
}

export function verifyTotp(code: string) {
  return api.post<unknown>(paths.auth.twoFactorVerifyTotp, { code: code.replace(/\s+/g, '') });
}

export function verifyBackupCode(code: string) {
  return api.post<unknown>(paths.auth.twoFactorVerifyBackupCode, { code: code.trim() });
}

/** Starts enrolment: the secret and backup codes exist, but 2FA is on only after verifyTotp. */
export function enableTwoFactor(password: string) {
  return api.post<TwoFactorEnableResult>(paths.auth.twoFactorEnable, { password });
}

export function changePassword(currentPassword: string, newPassword: string) {
  return api.post<unknown>(paths.auth.changePassword, {
    currentPassword,
    newPassword,
    revokeOtherSessions: true,
  });
}

/** Thrown when the browser has no WebAuthn or the person cancels the passkey prompt. */
export class PasskeyCancelled extends Error {
  constructor() {
    super('Passkey sign-in was cancelled');
    this.name = 'PasskeyCancelled';
  }
}

/** The passkey ceremony, as Better Auth's own passkey client runs it. */
export async function signInWithPasskey(): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: the options JSON is passed through untouched
  const optionsJSON = await api.get<any>(paths.auth.passkeyAuthenticateOptions);
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch {
    throw new PasskeyCancelled();
  }
  const { clientExtensionResults: _ignored, ...body } = response;
  return api.post<unknown>(paths.auth.passkeyVerifyAuthentication, { response: body });
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** Open sign-up, or sign-up with an invite token. Never says whether the address was taken. */
export function signUp(body: SignUpBody) {
  return api.post<{ next: 'sign-in' }>(paths.auth.signUp, body);
}

/** Sets a managed account's password with the one-time code its admin handed over (D164). */
export function redeemResetCode(username: string, code: string, newPassword: string) {
  return api.post<void>(paths.auth.resetCode, {
    username: username.trim(),
    code: code.replace(/[\s-]/g, '').toUpperCase(),
    newPassword,
  });
}

/** Mails a reset link if the address has an account; the answer is the same either way. */
export function requestPasswordReset(email: string) {
  return api.post<unknown>(paths.auth.requestPasswordReset, { email: email.trim() });
}

/** From `/auth/reset#token=…` (a reset mail or `kept admin reset-password`). Signs out everywhere. */
export function resetPassword(token: string, newPassword: string) {
  return api.post<unknown>(paths.auth.resetPassword, { token, newPassword });
}

/**
 * The link from an email-change mail (`/auth/email-change#token=…`). The first link (to the old
 * address) answers `verify_new` and mails the new one; that one's link answers `done`.
 */
export function confirmEmailChange(token: string) {
  return api.post<EmailChangeStage>(paths.auth.emailChangeConfirm, { token });
}
