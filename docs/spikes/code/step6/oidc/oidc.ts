/**
 * Spike S6.7: generic OIDC on Better Auth 1.7.6's `genericOAuth`, with Kept's rules (D127, D128,
 * D176, V32). This file is the shape T16's `apps/server/src/auth/oidc.ts` would take; it is spike
 * code and is never imported by `apps/`.
 *
 * What it adds on top of `genericOAuth`:
 * - Discovery, the JWKS, the token exchange and (if needed) userinfo all go through one `fetch`
 *   that the caller passes in: Kept's `guardedFetch` (net/ssrf.ts). `genericOAuth`'s own
 *   `discoveryUrl` path fetches with `betterFetch` (the global `fetch`) and its JWKS with jose's
 *   default fetch, neither of which can be given a custom fetch, so Kept does not use it.
 * - `validateUserInfo` (Better Auth's provisioning gate) refuses an unverified or `.invalid`
 *   email for every external provider, and allows a new user only for an invite or an allowed
 *   domain or group (autoprovision, D127).
 * - A before-hook makes `/link-social` require a fresh session (D176), and one on
 *   `/sign-in/social` carries a checked invite in the OAuth state's server context.
 * - IdP tokens are not kept in `auth.account` (Kept never calls the IdP after sign-in).
 */
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api';
import { authorizationCodeRequest, getOAuth2Tokens } from 'better-auth/oauth2';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { isUndeliverableEmail } from '../../../../../apps/server/src/auth/emails.js';

/** Better Auth's provider id; it names the callback path `/callback/oidc`. */
export const OIDC_PROVIDER_ID = 'oidc';

// ---------------------------------------------------------------------------------------------
// Configuration (Q16): environment variables, read at boot.
// ---------------------------------------------------------------------------------------------

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

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads the KEPT_OIDC_* variables. Returns null when OIDC is not configured (no issuer). */
export function readOidcEnv(env: Record<string, string | undefined>): OidcConfig | null {
  const issuer = env.KEPT_OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const clientId = env.KEPT_OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('KEPT_OIDC_CLIENT_ID is required with KEPT_OIDC_ISSUER');
  const scopes = list(env.KEPT_OIDC_SCOPES?.replaceAll(' ', ','));
  return {
    issuer,
    clientId,
    clientSecret: env.KEPT_OIDC_CLIENT_SECRET || undefined,
    name: env.KEPT_OIDC_NAME?.trim() || 'OIDC',
    autoprovisionDomains: list(env.KEPT_OIDC_AUTOPROVISION_DOMAINS).map((d) =>
      d.toLowerCase().replace(/^@/, ''),
    ),
    autoprovisionGroups: list(env.KEPT_OIDC_AUTOPROVISION_GROUPS),
    groupsClaim: env.KEPT_OIDC_GROUPS_CLAIM?.trim() || 'groups',
    scopes: scopes.length ? scopes : ['openid', 'email', 'profile'],
  };
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

export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    readonly reason: string,
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
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new OidcDiscoveryError(`discovery answered ${res.status}`, 'http_status');
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (doc.issuer !== issuer) {
    throw new OidcDiscoveryError(
      `discovery names issuer ${String(doc.issuer)}, not ${issuer}`,
      'issuer_mismatch',
    );
  }
  const https = new URL(issuer).protocol === 'https:';
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const v = doc[key];
    if (typeof v !== 'string')
      throw new OidcDiscoveryError(`discovery has no ${key}`, 'incomplete');
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
    // fetch. Without tokenUrl, refreshing the IdP's access token is impossible, which Kept never
    // needs (it calls nothing at the IdP after sign-in).
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
      const res = await fetchImpl(disc.token_endpoint, { method: 'POST', body, headers });
      if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
      return getOAuth2Tokens((await res.json()) as Record<string, unknown>);
    },
    getUserInfo: async (tokens) => {
      if (!tokens.idToken) return null;
      // Signature, iss, aud, exp: Better Auth checks nothing here, because the provider has no
      // `idToken` config without its own discovery.
      const { payload } = await jwtVerify(tokens.idToken, jwks, {
        issuer: disc.issuer,
        audience: cfg.clientId,
        ...(algorithms?.length ? { algorithms } : {}),
      });
      let claims = payload as Claims;
      if (typeof claims.email !== 'string' && disc.userinfo_endpoint && tokens.accessToken) {
        const res = await fetchImpl(disc.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
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
        // `email_verified: true` counts (a string "false" is not true).
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

export type KeptInvite = { id: string; email: string | null };

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;

/** Better Auth's `user.validateUserInfo`: runs before create-user, link-account and (OAuth)
 * sign-in, and fails closed. */
export function externalIdentityPolicy(cfg: OidcConfig | null): ValidateUserInfo {
  return async ({ user, source }) => {
    if (source.method !== 'oauth') return;
    const email = String(user.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) return { error: 'email_missing' };
    // D176: `.invalid` is managed accounts' reserved domain.
    if (isUndeliverableEmail(email)) return { error: 'email_undeliverable' };
    // D176: only a provider-verified address. Checked on sign-in too, not only on link/create.
    if (user.emailVerified !== true) return { error: 'email_unverified' };
    if (source.action !== 'create-user') return;
    // A new user: an invite carried in the server-trusted part of the OAuth state (D127) ...
    const state = await getOAuthState<{ serverContext?: { keptInvite?: KeptInvite } }>();
    const invite = state?.serverContext?.keptInvite;
    if (invite) {
      if (invite.email && invite.email.toLowerCase() !== email) {
        return { error: 'invite_email_mismatch' };
      }
      return;
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

export type KeptOidcHooksOptions = {
  /** Looks an invite up by its token (T16: through a kept_app definer function). */
  findInvite: (token: string) => Promise<KeptInvite | null>;
  /** Spike only: retire the request's previous session after an OIDC sign-in. */
  rotateOnCallback?: boolean;
  /** Spike only: records `ctx.path` as hooks see it. */
  seenPaths?: string[];
};

export function keptOidc(opts: KeptOidcHooksOptions): BetterAuthPlugin {
  return {
    id: 'kept-oidc',
    hooks: {
      before: [
        {
          matcher: () => opts.seenPaths !== undefined,
          handler: createAuthMiddleware(async (ctx) => {
            opts.seenPaths?.push(ctx.path ?? '');
          }),
        },
        {
          // D176: linking an external identity needs a fresh session: one created less than
          // `session.freshAge` (FRESH_SESSION_SECONDS, 600 s) ago. Not Better Auth's
          // `freshSessionMiddleware` as the handler: a before-hook that returns a value
          // short-circuits the endpoint, and that middleware returns `{ session }`, so the
          // session (token included) became the response body (seen in this spike's first run).
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
      after: [
        {
          // Rotation at sign-in, as security.ts does for SIGN_IN_SESSION_PATHS: the OAuth
          // callback (`/callback/:id` as hooks see it) isn't in that set. T16 adds it there;
          // this copy of the hook proves the path and `newSession` work for it.
          matcher: (ctx) => opts.rotateOnCallback === true && ctx.path === '/callback/:id',
          handler: createAuthMiddleware(async (ctx) => {
            // The callback ends by throwing its redirect, so a *successful* sign-in arrives here as
            // an APIError with status FOUND (302). security.ts's `isAPIError(returned)` guard
            // would skip it; a 302 must count as success on this path.
            const r = ctx.context.returned as { statusCode?: unknown } | undefined;
            opts.seenPaths?.push(
              `after ${ctx.path} apiError=${isAPIError(r)} statusCode=${String(r?.statusCode)} newSession=${!!ctx.context.newSession}`,
            );
            if (isAPIError(r) && r.statusCode !== 302) return;
            const created = ctx.context.newSession;
            if (!created) return; // a link callback makes no session
            const previousToken = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (previousToken && previousToken !== created.session.token) {
              const old = await ctx.context.internalAdapter.findSession(previousToken);
              if (old) await ctx.context.internalAdapter.deleteSession(previousToken);
            }
          }),
        },
      ],
    },
  } as BetterAuthPlugin;
}

/** Account linking: never implicit (D176). Explicit `/link-social` stays on. */
export const ACCOUNT_OPTIONS: NonNullable<BetterAuthOptions['account']> = {
  updateAccountOnSignIn: false,
  accountLinking: {
    enabled: true,
    disableImplicitLinking: true,
    allowDifferentEmails: false,
    trustedProviders: [],
  },
};

/** IdP tokens are not kept: Kept never calls the IdP after sign-in. With
 * `account.updateAccountOnSignIn: false`, a sign-in doesn't write them back either. */
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
