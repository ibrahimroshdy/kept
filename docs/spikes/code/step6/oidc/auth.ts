import { createHash } from 'node:crypto';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { admin, magicLink, twoFactor, username } from 'better-auth/plugins';
import { type GenericOAuthConfig, genericOAuth } from 'better-auth/plugins/generic-oauth';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Env } from '../../../../../apps/server/src/config/env.js';
import { betterAuthTables } from '../../../../../apps/server/src/db/schema/auth.js';
import { CLIENT_IP_HEADER } from '../../../../../apps/server/src/auth/client-ip.js';
import { isUndeliverableEmail } from '../../../../../apps/server/src/auth/emails.js';
import {
  claimUnverifiedAccount,
  EMAIL_OTP_PATHS,
  keptSecurity,
  rememberPasskeyVerification,
  type SecurityEvent,
  type SessionLike,
} from '../../../../../apps/server/src/auth/security.js';
// S6.7: the OIDC additions (spike copy; T16 puts them in src/auth/oidc.ts).
import {
  ACCOUNT_OPTIONS,
  DROP_IDP_TOKENS,
  externalIdentityPolicy,
  type KeptInvite,
  keptOidc,
  type OidcConfig,
} from './oidc.js';

/** Better Auth's routes, relative to the public URL (task 17 mounts the handler here). */
export const AUTH_BASE_PATH = '/api/v1/auth';

/** A mailed sign-in or reset link. `url` is the web page that consumes `token` by POST; the
 * token rides in its #fragment, so it never reaches a server log or a mail scanner's GET
 * (D176, D181). */
export type MagicLinkMail = { email: string; url: string; token: string };
export type PasswordResetMail = MagicLinkMail;

/** A credential change on the account, told to its owner (security review I3). */
export type SecurityNoticeMail = { email: string; event: SecurityEvent };

export type AuthMail = {
  sendMagicLink: (mail: MagicLinkMail) => Promise<void>;
  sendPasswordReset: (mail: PasswordResetMail) => Promise<void>;
  sendSecurityNotice: (mail: SecurityNoticeMail) => Promise<void>;
};

export type AuthDeps = {
  /** A pool logged in as kept_auth (KEPT_AUTH_DATABASE_URL); DML on `auth.*` only (§7.1). */
  pool: pg.Pool;
  env: Pick<Env, 'KEPT_AUTH_SECRET' | 'KEPT_PUBLIC_URL'>;
  mail: AuthMail;
  /** Defaults to on. Better Auth enables it only when NODE_ENV=production otherwise. */
  rateLimitEnabled?: boolean;
  /** Runs after a user row is committed (Better Auth's `databaseHooks.user.create.after`):
   * `ensureAccount()` (task 18). `headers` are the creating request's, when there was one.
   * A failure is reported to `onBackgroundError`, never to the sign-up: the per-request check
   * and the repair job finish the account later. */
  onUserCreated?: (
    user: { id: string; email: string },
    headers: Headers | undefined,
  ) => Promise<void>;
  /** D197: set when mail is delivered (KEPT_SMTP_URL). An account whose address isn't verified
   * may then not enrol a passkey or TOTP until it is. */
  enrolmentNeedsVerifiedEmail?: boolean;
  /** Mail is sent without awaiting (so a known and an unknown address answer alike); a send that
   * fails, and a failed onUserCreated, land here. */
  onBackgroundError?: (err: unknown, what: 'mail' | 'user-created') => void;
  /** S6.7: generic OIDC. `provider` is the genericOAuth config (oidc.ts `oidcProvider`, or a
   * stock `discoveryUrl` config for comparison); `config` feeds the autoprovision rule. */
  oidc?: {
    config: OidcConfig | null;
    provider: GenericOAuthConfig;
    findInvite: (token: string) => Promise<KeptInvite | null>;
    seenPaths?: string[];
    rotateOnCallback?: boolean;
    /** false: leave Better Auth's default account-linking behaviour (for the comparison run). */
    keptRules?: boolean;
  };
};

/** Session lifetimes (D181). Over HTTPS: 30 days, sliding (refreshed once a day of use). Over
 * plain HTTP: 12 hours, never renewed. */
export const SESSION_DAYS_HTTPS = 30;
export const SESSION_HOURS_HTTP = 12;

/** How long a magic link works. */
export const MAGIC_LINK_SECONDS = 15 * 60;

/** Every endpoint of Better Auth's admin plugin. Kept keeps the plugin for its server-side ban
 * and session calls; its instance admin is `instance_admins` with Kept's own routes (task 23),
 * so none of these is served over HTTP. Impersonation contradicts D164, and the session list
 * would hand out session tokens (security review M6). */
export const ADMIN_PLUGIN_PATHS = [
  '/admin/set-role',
  '/admin/get-user',
  '/admin/create-user',
  '/admin/update-user',
  '/admin/list-users',
  '/admin/list-user-sessions',
  '/admin/unban-user',
  '/admin/ban-user',
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
  '/admin/set-user-password',
  '/admin/has-permission',
];

/** Better Auth endpoints Kept switches off. See the comment where it is used. */
export const DISABLED_AUTH_PATHS = [
  ...ADMIN_PLUGIN_PATHS,
  ...EMAIL_OTP_PATHS,
  // The magic link is consumed by Kept's POST /api/v1/auth/magic-link/verify (auth/http.ts), never
  // by this GET, which a mail scanner could follow (D176). The server-side call is unaffected.
  '/magic-link/verify',
  // Email changes go through Kept's own two-step flow (auth/email-change.ts): Better Auth's
  // confirms by GET with a replayable token and signs the clicker in.
  '/change-email',
  // Both expose session tokens to the page; the device list is GET /api/v1/me/sessions.
  '/list-sessions',
  '/revoke-session',
  // Public sign-up answers 422 USER_ALREADY_EXISTS for a taken address and writes rows per
  // request. People sign up through Kept's POST /api/v1/auth/sign-up (accounts/sign-up.ts),
  // which is closed unless sign-up is open or an invite comes with it, and answers the same for
  // a taken address as for a free one. The server-side call it makes is unaffected.
  '/sign-up/email',
  // Says which usernames exist (managed accounts' sign-in names, D47).
  '/is-username-available',
];

/** How recent a sign-in must be for Better Auth's sensitive endpoints (e.g. deleting the user):
 * 10 minutes, as Kept's own re-authentication (auth/email-change.ts). */
export const FRESH_SESSION_SECONDS = 600;

/**
 * How verification identifiers are stored (security review M3): SHA-256, base64url, so a read of
 * auth.verification yields no usable reset token. The part up to the first `:` stays readable
 * (`reset-password:<hash>`), so Kept can still find a user's pending resets by kind, e.g. to
 * retire them when the email changes (M2).
 */
export async function hashVerificationIdentifier(identifier: string): Promise<string> {
  const colon = identifier.indexOf(':');
  const prefix = colon >= 0 ? identifier.slice(0, colon + 1) : '';
  return prefix + createHash('sha256').update(identifier).digest('base64url');
}

/** A page of the web app that consumes a mailed token by POST (`/auth/confirm#token=…`). */
export function linkUrl(publicUrl: string, page: string, token: string): string {
  const url = new URL(page, publicUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

/**
 * The Better Auth instance (spikes S1–S3). Runs on its own kept_auth login with its tables in
 * schema `auth`, and issues UUIDv7 ids. Kept's own addition is the kept-security plugin: the
 * two-factor gate and the account + IP sign-in delays (spike S2).
 *
 * `auth.handler` must only ever see requests whose headers came from `authRequestHeaders()`
 * (auth/client-ip.ts): that is where the client address is decided, from the socket and
 * KEPT_TRUSTED_PROXIES, and it is the only IP source Better Auth is told to read.
 */
export function createAuth(deps: AuthDeps) {
  const { pool, env, mail } = deps;
  const publicUrl = new URL(env.KEPT_PUBLIC_URL);
  const https = publicUrl.protocol === 'https:';
  const background = (what: 'mail' | 'user-created', work: () => Promise<void>) => {
    Promise.resolve()
      .then(work)
      .catch((err: unknown) => deps.onBackgroundError?.(err, what));
  };

  const notify = (user: { email: string }, event: SecurityEvent) => {
    if (isUndeliverableEmail(user.email)) return;
    background('mail', () => mail.sendSecurityNotice({ email: user.email, event }));
  };

  // The gate looks sessions up through the finished instance; hooks run only after createAuth
  // returns, so the late binding is safe.
  let lookup: ((headers: Headers) => Promise<SessionLike | null>) | undefined;

  const auth = betterAuth({
    appName: 'Kept',
    baseURL: env.KEPT_PUBLIC_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.KEPT_AUTH_SECRET,
    database: drizzleAdapter(drizzle(pool, { schema: betterAuthTables }), {
      provider: 'pg',
      schema: betterAuthTables,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      // Links go to the web page, token in the fragment; the reset itself is a POST to
      // /reset-password. Managed accounts are reset by an admin code instead (D164).
      sendResetPassword: async ({ user, token }) => {
        if (isUndeliverableEmail(user.email)) return;
        const url = linkUrl(env.KEPT_PUBLIC_URL, '/auth/reset', token);
        background('mail', () => mail.sendPasswordReset({ email: user.email, url, token }));
      },
      revokeSessionsOnPasswordReset: true,
      // D197: a reset on an unverified address claims the account for the mailbox's owner.
      onPasswordReset: async ({ user }) => {
        if (!user.emailVerified && !isUndeliverableEmail(user.email)) {
          await claimUnverifiedAccount(pool, user.id);
          notify(user, 'unverified-account-reset');
          return;
        }
        notify(user, 'password-changed');
      },
    },
    verification: { storeIdentifier: { hash: hashVerificationIdentifier } },
    session: https
      ? {
          expiresIn: SESSION_DAYS_HTTPS * 86_400,
          updateAge: 86_400,
          freshAge: FRESH_SESSION_SECONDS,
        }
      : {
          expiresIn: SESSION_HOURS_HTTP * 3_600,
          disableSessionRefresh: true,
          freshAge: FRESH_SESSION_SECONDS,
        },
    ...(deps.oidc && deps.oidc.keptRules !== false
      ? {
          account: ACCOUNT_OPTIONS,
          user: { validateUserInfo: externalIdentityPolicy(deps.oidc.config) },
        }
      : {}),
    databaseHooks: {
      ...(deps.oidc && deps.oidc.keptRules !== false ? { account: DROP_IDP_TOKENS } : {}),
      user: {
        create: {
          // After the auth transaction commits (Better Auth queues it), so the kept_app
          // transaction sees the user row.
          after: async (user, context) => {
            const created = deps.onUserCreated;
            if (!created) return;
            try {
              await created({ id: user.id, email: user.email }, context?.headers);
            } catch (err) {
              deps.onBackgroundError?.(err, 'user-created');
            }
          },
        },
      },
    },
    advanced: {
      // Secure cookies (and the __Secure- prefix) exactly when the public URL is https (D181).
      useSecureCookies: https,
      database: { generateId: () => uuidv7() },
      // One single-value header that Kept's request conversion always sets from the socket
      // (auth/client-ip.ts). Better Auth's own `trustedProxies` is deliberately not used: it
      // walks X-Forwarded-For without knowing the socket, so a client connecting directly could
      // still pick its address. The proxy walk happens before the header is set.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: {
      enabled: deps.rateLimitEnabled ?? true,
      // Shared by every replica through auth.rate_limit (V32). Keyed on IP + path.
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        // Engineering spec §3.2: sign-in attempts 5/min per IP.
        '/sign-in/*': { window: 60, max: 5 },
      },
    },
    // Kept's instance admin is its own `instance_admins` table; the admin plugin is here only for
    // ban and session revocation; none of its endpoints is served (ADMIN_PLUGIN_PATHS).
    // An emailed OTP is not a second factor in Kept (D176; Phase B review, item 6), so its two
    // endpoints are off rather than merely ignored by the gate. The rest: DISABLED_AUTH_PATHS.
    // disabledPaths applies to HTTP requests through `auth.handler` only, not to `auth.api.*`.
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    plugins: [
      twoFactor({ issuer: 'Kept' }),
      passkey({
        rpName: 'Kept',
        rpID: publicUrl.hostname,
        origin: publicUrl.origin,
        authentication: {
          // Better Auth verifies with requireUserVerification: false; record whether UV
          // happened so a passkey with UV can count as two factors (§7.14).
          afterVerification: ({ ctx, verification }) => {
            rememberPasskeyVerification(ctx.context, verification.authenticationInfo.userVerified);
          },
        },
      }),
      magicLink({
        // Kept has no open sign-up: magic links sign existing accounts in (D127).
        disableSignUp: true,
        expiresIn: MAGIC_LINK_SECONDS,
        // Only a hash of the token is stored, so a read of auth.verification can't sign in.
        storeToken: 'hashed',
        sendMagicLink: async ({ email, token }, ctx) => {
          // Managed accounts' synthetic addresses are never mailed (D47, D93, D176).
          if (isUndeliverableEmail(email)) {
            throw new APIError('BAD_REQUEST', {
              message: 'This account signs in with a username.',
              code: 'EMAIL_UNDELIVERABLE',
            });
          }
          // An address with no account gets nothing, and the same answer: the lookup runs either
          // way and the mail goes out in the background, so neither the body nor the timing
          // says which addresses have accounts.
          const found = await ctx?.context.internalAdapter.findUserByEmail(email);
          if (!found) return;
          // Better Auth's own `url` points at its GET verify endpoint; Kept's page POSTs instead.
          const url = linkUrl(env.KEPT_PUBLIC_URL, '/auth/confirm', token);
          background('mail', () => mail.sendMagicLink({ email, url, token }));
        },
      }),
      username(),
      admin(),
      keptSecurity({
        pool,
        notify,
        enrolmentNeedsVerifiedEmail: deps.enrolmentNeedsVerifiedEmail ?? false,
        getSession: (headers) => {
          if (!lookup) throw new Error('auth instance not initialised');
          return lookup(headers);
        },
      }),
      ...(deps.oidc
        ? [
            genericOAuth({ config: [deps.oidc.provider] }),
            ...(deps.oidc.keptRules !== false
              ? [
                  keptOidc({
                    findInvite: deps.oidc.findInvite,
                    seenPaths: deps.oidc.seenPaths,
                    rotateOnCallback: deps.oidc.rotateOnCallback,
                  }),
                ]
              : []),
          ]
        : []),
    ],
  });

  lookup = async (headers) =>
    (await auth.api.getSession({ headers, query: { disableRefresh: true } })) as SessionLike | null;

  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
