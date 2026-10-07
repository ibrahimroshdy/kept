import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
} from 'better-auth/api';
import { authorizationCodeRequest, getOAuth2Tokens } from 'better-auth/oauth2';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type pg from 'pg';
import type { Env } from '../config/env.js';
import { hashInviteToken, isInviteTokenShape } from '../invites/token.js';
import { PrivateAddressError } from '../net/ssrf.js';
import { AUTH_BASE_PATH } from './auth.js';
import { isUndeliverableEmail } from './emails.js';

// Generic OIDC sign-in (step-6 plan T16; D127, D128, D176, D190, V32; engineering spec §7.14;
// spike S6.7, docs/spikes/2026-09-30-step6-oidc.md, whose cases the tests repeat).
//
// Better Auth's `genericOAuth` does the protocol. Stock, it auto-links a verified email to an
// existing account, signs up anyone, accepts `.invalid` addresses and fetches outside the SSRF
// guard (the spike reproduced each). Kept's rules on top:
// - Configuration comes from the environment, read at boot (plan Q16): KEPT_OIDC_ISSUER and the
//   rest (config/env.ts). Discovery runs at boot through guardedFetch (D128); the provider gets
//   explicit endpoints, never `discoveryUrl`/`tokenUrl`/`userInfoUrl` (each would make Better Auth
//   fetch with the global fetch), and `getToken`/`getUserInfo` go through the same guarded fetch.
//   The id_token's signature, `iss`, `aud` and `exp` are checked with jose against the IdP's JWKS,
//   fetched through the guard too.
// - The account key is the OIDC `sub`, never the email. Linking is explicit only (`/link-social`
//   from a session younger than FRESH_SESSION_SECONDS); an IdP asserting an existing user's email
//   is `account_not_linked` (D176).
// - Better Auth's provisioning gate, `user.validateUserInfo`, refuses an unverified or `.invalid`
//   email on every OAuth sign-in, link and creation, and lets a new user in only with an invite,
//   or for an allowed domain or group (autoprovision, D127). Never Google or Apple.
// - The IdP's tokens are not kept (Kept calls nothing at the IdP after sign-in).
// - Kept's session_mfa gate applies unchanged: an OIDC session of a user with TOTP is pending
//   until TOTP is proven in it (V32). The callback rotates the request's previous session
//   (auth/security.ts SIGN_IN_SESSION_PATHS).
// If discovery fails at boot, OIDC stays off until a restart and Admin → Status says why.

/** Better Auth's provider id; it names the callback path `/callback/oidc`. */
export const OIDC_PROVIDER_ID = 'oidc';

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  /** "Sign in with <name>". */
  name: string;
  /** Lower-cased, exact domains (no subdomain wildcard). */
  autoprovisionDomains: readonly string[];
  autoprovisionGroups: readonly string[];
  /** The claim that carries group names. */
  groupsClaim: string;
  scopes: readonly string[];
};

type OidcEnv = Pick<
  Env,
  | 'KEPT_OIDC_ISSUER'
  | 'KEPT_OIDC_CLIENT_ID'
  | 'KEPT_OIDC_CLIENT_SECRET'
  | 'KEPT_OIDC_NAME'
  | 'KEPT_OIDC_AUTOPROVISION_DOMAINS'
  | 'KEPT_OIDC_AUTOPROVISION_GROUPS'
  | 'KEPT_OIDC_GROUPS_CLAIM'
  | 'KEPT_OIDC_SCOPES'
>;

/** The OIDC configuration the environment holds, or null when KEPT_OIDC_ISSUER is unset.
 * loadEnv() has already refused an issuer without a client id. */
export function oidcConfigOf(env: Partial<OidcEnv>): OidcConfig | null {
  const issuer = env.KEPT_OIDC_ISSUER?.trim();
  const clientId = env.KEPT_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const scopes = (env.KEPT_OIDC_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
  return {
    issuer,
    clientId,
    clientSecret: env.KEPT_OIDC_CLIENT_SECRET || undefined,
    name: env.KEPT_OIDC_NAME?.trim() || 'OIDC',
    autoprovisionDomains: (env.KEPT_OIDC_AUTOPROVISION_DOMAINS ?? []).map((d) =>
      d.trim().toLowerCase().replace(/^@/, ''),
    ),
    autoprovisionGroups: (env.KEPT_OIDC_AUTOPROVISION_GROUPS ?? []).map((g) => g.trim()),
    groupsClaim: env.KEPT_OIDC_GROUPS_CLAIM?.trim() || 'groups',
    scopes: scopes.length > 0 ? scopes : ['openid', 'email', 'profile'],
  };
}

/** The callback URL an admin registers at the IdP. */
export function oidcCallbackUrl(publicUrl: string): string {
  return new URL(`${AUTH_BASE_PATH}/callback/${OIDC_PROVIDER_ID}`, publicUrl).toString();
}

// ---------------------------------------------------------------------------------------------
// Discovery through the SSRF guard (D128)
// ---------------------------------------------------------------------------------------------

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
};

/** Why boot-time discovery failed, as Admin → Status shows it. */
export type OidcDiscoveryReason =
  | 'private_address'
  | 'issuer_mismatch'
  | 'insecure_endpoint'
  | 'http_status'
  | 'incomplete'
  | 'network';

export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    readonly reason: OidcDiscoveryReason,
  ) {
    super(message);
    this.name = 'OidcDiscoveryError';
  }
}

/** OpenID Connect Discovery 1.0 §4: `<issuer>/.well-known/openid-configuration`, whose `issuer`
 * must equal the configured one exactly (§4.3). */
export async function discoverOidc(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof PrivateAddressError) {
      throw new OidcDiscoveryError('the issuer is on a private network', 'private_address');
    }
    throw new OidcDiscoveryError('the issuer could not be reached', 'network');
  }
  if (!res.ok) throw new OidcDiscoveryError(`discovery answered ${res.status}`, 'http_status');
  const doc = (await res.json().catch(() => ({}))) as Partial<OidcDiscovery>;
  if (doc.issuer !== issuer) {
    throw new OidcDiscoveryError('discovery names another issuer', 'issuer_mismatch');
  }
  const https = new URL(issuer).protocol === 'https:';
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const v = doc[key];
    if (typeof v !== 'string' || !URL.canParse(v)) {
      throw new OidcDiscoveryError(`discovery has no ${key}`, 'incomplete');
    }
    // An https issuer may not send the browser or Kept to plain http.
    if (https && new URL(v).protocol !== 'https:') {
      throw new OidcDiscoveryError(`${key} is not https`, 'insecure_endpoint');
    }
  }
  return doc as OidcDiscovery;
}

// ---------------------------------------------------------------------------------------------
// The genericOAuth provider: explicit endpoints, every back-channel call through `fetchImpl`
// ---------------------------------------------------------------------------------------------

type Claims = Record<string, unknown> & { sub?: unknown; email?: unknown };

export function oidcProvider(
  cfg: OidcConfig,
  disc: OidcDiscovery,
  fetchImpl: typeof fetch,
): GenericOAuthConfig {
  const jwks = createRemoteJWKSet(new URL(disc.jwks_uri), {
    [customFetch]: (url, init) => fetchImpl(url, init as RequestInit),
  });
  const algorithms = disc.id_token_signing_alg_values_supported?.filter((a) => a !== 'none');
  return {
    providerId: OIDC_PROVIDER_ID,
    name: cfg.name,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authorizationUrl: disc.authorization_endpoint,
    // No tokenUrl / userInfoUrl / discoveryUrl: each would make Better Auth fetch with the global
    // fetch. Without tokenUrl the IdP's access token can't be refreshed, which Kept never needs.
    scopes: [...cfg.scopes],
    pkce: true,
    // The account key is the OIDC `sub`, never the email (D176).
    accountSubject: ({ profile }) => {
      if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('no sub');
      return profile.sub;
    },
    getToken: async ({ code, redirectURI, codeVerifier }) => {
      const { body, headers } = await authorizationCodeRequest({
        code,
        codeVerifier,
        redirectURI,
        options: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
        tokenEndpoint: disc.token_endpoint,
        authentication: 'post',
      });
      const res = await fetchImpl(disc.token_endpoint, {
        method: 'POST',
        body,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
      return getOAuth2Tokens((await res.json()) as Record<string, unknown>);
    },
    getUserInfo: async (tokens) => {
      if (!tokens.idToken) return null;
      // Signature, iss, aud, exp: Better Auth checks none of it here (the provider has no
      // `idToken` config without its own discovery).
      const { payload } = await jwtVerify(tokens.idToken, jwks, {
        issuer: disc.issuer,
        audience: cfg.clientId,
        ...(algorithms?.length ? { algorithms } : {}),
      });
      let claims = payload as Claims;
      if (typeof claims.email !== 'string' && disc.userinfo_endpoint && tokens.accessToken) {
        const res = await fetchImpl(disc.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const info = (await res.json()) as Claims;
        if (info.sub !== claims.sub) return null; // OIDC Core §5.3.2
        claims = { ...claims, ...info, sub: claims.sub };
      }
      const sub = claims.sub;
      if (typeof sub !== 'string') return null;
      return {
        ...claims,
        // Last, so a claim literally named `emailVerified` can't set it: only a boolean
        // `email_verified: true` counts (a string "true" is not true).
        sub,
        id: sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        emailVerified: claims.email_verified === true,
        name:
          typeof claims.name === 'string'
            ? claims.name
            : typeof claims.preferred_username === 'string'
              ? claims.preferred_username
              : '',
        image: undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Kept's rules: the provisioning gate and the hooks
// ---------------------------------------------------------------------------------------------

export function groupsOf(profile: Record<string, unknown> | undefined, claim: string): string[] {
  const v = profile?.[claim];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

/** D127, D176: a new user from OIDC only for an allowed domain (exact) or group. */
export function autoprovisionAllowed(
  cfg: OidcConfig,
  email: string,
  profile: Record<string, unknown> | undefined,
): 'domain' | 'group' | null {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (cfg.autoprovisionDomains.includes(domain)) return 'domain';
  const groups = groupsOf(profile, cfg.groupsClaim);
  if (groups.some((g) => cfg.autoprovisionGroups.includes(g))) return 'group';
  return null;
}

/** An invite carried in the OAuth state's server-trusted context: its token's hash, and whether
 * it names an address (for the error a mismatch gets). */
export type KeptInvite = { tokenHash: string; emailBound: boolean };

/** The invite side of OIDC sign-up, on Kept's own doors (invites/, migration 0010). */
export type OidcInvites = {
  /** A live invite by its token (kept.invite_preview), or null. */
  find: (token: string) => Promise<KeptInvite | null>;
  /** Holds the invite for `email` (kept.claim_invite), as a password sign-up does; false when it
   * can't be (gone, or for another address). The accept after the first sign-in consumes it. */
  claim: (tokenHash: string, email: string) => Promise<boolean>;
};

/** The invite doors on kept_app, outside any user scope (as accounts/sign-up.ts uses them). */
export function oidcInvites(app: Pick<pg.Pool, 'query'>): OidcInvites {
  return {
    find: async (token) => {
      if (!isInviteTokenShape(token)) return null;
      const tokenHash = hashInviteToken(token);
      const { rows } = await app.query<{ email_bound: boolean }>(
        'SELECT email_bound FROM kept.invite_preview($1)',
        [tokenHash],
      );
      return rows[0] ? { tokenHash, emailBound: rows[0].email_bound } : null;
    },
    claim: async (tokenHash, email) => {
      const { rows } = await app.query<{ ok: boolean }>('SELECT kept.claim_invite($1, $2) AS ok', [
        tokenHash,
        email,
      ]);
      return rows[0]?.ok === true;
    },
  };
}

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;

/** Better Auth's `user.validateUserInfo`: runs before create-user, link-account and (OAuth)
 * sign-in, and fails closed. Anything but OAuth passes untouched (sign-up, managed accounts). */
export function externalIdentityPolicy(
  cfg: OidcConfig | null,
  invites: Pick<OidcInvites, 'claim'>,
): ValidateUserInfo {
  return async ({ user, source }) => {
    if (source.method !== 'oauth') return;
    const email = String(user.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) return { error: 'email_missing' };
    // D176: `.invalid` is managed accounts' reserved domain.
    if (isUndeliverableEmail(email)) return { error: 'email_undeliverable' };
    // D176: only a provider-verified address, checked on sign-in too, not only on link/create.
    if (user.emailVerified !== true) return { error: 'email_unverified' };
    if (source.action !== 'create-user') return;
    // A new user: an invite carried in the server-trusted part of the OAuth state (D127) ...
    const state = await getOAuthState<{ serverContext?: { keptInvite?: KeptInvite } }>();
    const invite = state?.serverContext?.keptInvite;
    if (invite) {
      if (await invites.claim(invite.tokenHash, email)) return;
      return { error: invite.emailBound ? 'invite_email_mismatch' : 'signup_closed' };
    }
    // ... or OIDC autoprovision for an allowed domain or group (D127, D176). Never Google/Apple.
    if (
      cfg &&
      source.oauth?.providerId === OIDC_PROVIDER_ID &&
      autoprovisionAllowed(cfg, email, source.oauth.profile)
    ) {
      return;
    }
    return { error: 'signup_closed', errorDescription: 'Ask for an invite.' };
  };
}

/** The `kept-oidc` plugin: a fresh session to link an IdP account, and an invite carried in
 * the OAuth state's server context. The callback's session rotation is security.ts's. */
export function keptOidc(opts: { findInvite: OidcInvites['find'] }): BetterAuthPlugin {
  return {
    id: 'kept-oidc',
    hooks: {
      before: [
        {
          // D176: linking needs a session created less than `session.freshAge` ago. Not Better
          // Auth's `freshSessionMiddleware` as the handler: a before-hook that returns a value
          // short-circuits the endpoint, and that middleware returns `{session}`, which then
          // became the response body, token included (spike S6.7's first run).
          matcher: (ctx) => ctx.path === '/link-social',
          handler: createAuthMiddleware(async (ctx) => {
            const found = await getSessionFromCtx(ctx);
            if (!found) return; // the endpoint's own session middleware answers 401
            const age = Date.now() - new Date(found.session.createdAt).getTime();
            if (age >= ctx.context.sessionConfig.freshAge * 1000) {
              throw new APIError('FORBIDDEN', {
                message: 'Sign in again, then link the account.',
                code: 'SESSION_NOT_FRESH',
              });
            }
          }),
        },
        {
          // An invite rides the OAuth state's server context, never the client's
          // `additionalData`, which Better Auth documents as untrusted.
          matcher: (ctx) => ctx.path === '/sign-in/social',
          handler: createAuthMiddleware(async (ctx) => {
            const token = (ctx.body as { additionalData?: { inviteToken?: unknown } } | undefined)
              ?.additionalData?.inviteToken;
            if (typeof token !== 'string' || !token) return;
            const invite = await opts.findInvite(token);
            if (invite) await addOAuthServerContext({ keptInvite: invite });
          }),
        },
      ],
    },
  } as BetterAuthPlugin;
}

/** Account linking: never implicit (D176); explicit `/link-social` stays on. A sign-in never
 * writes the IdP's tokens back. Right for any external provider, so Kept sets it always. */
export const ACCOUNT_OPTIONS: NonNullable<BetterAuthOptions['account']> = {
  updateAccountOnSignIn: false,
  accountLinking: {
    enabled: true,
    disableImplicitLinking: true,
    allowDifferentEmails: false,
    trustedProviders: [],
  },
};

/** The IdP's tokens are not kept: Kept never calls the IdP after sign-in. */
export const DROP_IDP_TOKENS = {
  create: {
    before: async (account: Record<string, unknown>) =>
      account.providerId === OIDC_PROVIDER_ID
        ? {
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }
        : undefined,
  },
};

/** What createAuth() takes when OIDC is on (main.ts builds it with bootOidc()). */
export type AuthOidc = {
  config: OidcConfig;
  provider: GenericOAuthConfig;
  invites: OidcInvites;
};

// ---------------------------------------------------------------------------------------------
// Boot (plan Q16): discovery with a short retry; on failure, OIDC is off and the status says why
// ---------------------------------------------------------------------------------------------

/** Admin → Status's OIDC row, and the sign-in page's button (GET /api/v1/setup). */
export type OidcStatus = {
  configured: boolean;
  name: string | null;
  issuer: string | null;
  callbackUrl: string | null;
  /** Why boot-time discovery failed (OIDC is then off until a restart); null when it is on. */
  error: OidcDiscoveryReason | null;
};

const OFF: OidcStatus = {
  configured: false,
  name: null,
  issuer: null,
  callbackUrl: null,
  error: null,
};

let current: OidcStatus = OFF;

/** This process's OIDC status, as boot left it. */
export function oidcStatus(): OidcStatus {
  return current;
}

/** Sets the status (boot; tests). */
export function setOidcStatus(status: OidcStatus | null): void {
  current = status ?? OFF;
}

export type BootOidcDeps = {
  env: Partial<OidcEnv> & Pick<Env, 'KEPT_PUBLIC_URL'>;
  /** kept_app, for the invite doors. */
  app: Pick<pg.Pool, 'query'>;
  /** The guarded fetch (net/ssrf.ts guardedFetch with `ssrf_allow_private`). */
  fetch: typeof fetch;
  /** How long to keep trying discovery (default 60 s), and how long between tries (5 s). */
  retryForMs?: number;
  retryEveryMs?: number;
  log?: { warn: (obj: object, msg: string) => void };
};

/**
 * Discovers the configured IdP and builds the provider for createAuth(). Null when OIDC isn't
 * configured, or when discovery kept failing for `retryForMs`; either way the status says so.
 */
export async function bootOidc(deps: BootOidcDeps): Promise<AuthOidc | null> {
  const cfg = oidcConfigOf(deps.env);
  if (!cfg) {
    setOidcStatus(null);
    return null;
  }
  const status = {
    configured: true,
    name: cfg.name,
    issuer: cfg.issuer,
    callbackUrl: oidcCallbackUrl(deps.env.KEPT_PUBLIC_URL),
  };
  const until = Date.now() + (deps.retryForMs ?? 60_000);
  for (;;) {
    try {
      const disc = await discoverOidc(cfg.issuer, deps.fetch);
      setOidcStatus({ ...status, error: null });
      return {
        config: cfg,
        provider: oidcProvider(cfg, disc, deps.fetch),
        invites: oidcInvites(deps.app),
      };
    } catch (err) {
      const reason = err instanceof OidcDiscoveryError ? err.reason : 'network';
      // A refusal won't change on its own; only an unreachable or failing IdP is worth waiting for.
      const retry = reason === 'network' || reason === 'http_status';
      if (!retry || Date.now() >= until) {
        deps.log?.warn({ reason }, 'OIDC sign-in is off: discovery failed at boot');
        setOidcStatus({ ...status, error: reason });
        return null;
      }
      await new Promise((r) => setTimeout(r, deps.retryEveryMs ?? 5_000));
    }
  }
}
