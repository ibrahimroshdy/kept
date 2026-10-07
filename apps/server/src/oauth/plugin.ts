import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { OAUTH_SCOPES } from '@kept/shared';
import { jwt } from 'better-auth/plugins/jwt';

// Kept as an OAuth 2.1 authorization server for MCP connectors (step-6 plan T12; D93, D125, V15;
// spike S6.2): Better Auth's `jwt()`, `mcp()` (which *is* its OAuth provider, bound to the
// `/mcp` resource) and `cimd()` (Client ID Metadata Documents, the MCP 2026-07-28 profile).
//
// - On only with an https public URL (D63, D125: a connector needs one); http is allowed on a
//   loopback host for local development and tests, as the mcp plugin itself allows.
// - Dynamic Client Registration stays off (Q8; the MCP spec marks it deprecated). A client that
//   connects only with DCR is the maintainer's decision (V15).
// - Access tokens are JWTs for `<public URL>/mcp`, an hour long (Q7). Kept's grant row
//   (api_tokens, kind 'oauth') holds the scope and locations, checked on every call, so revoking
//   in Connections works at once (oauth/verify.ts).
// - The jwt plugin's own session JWT is switched off: no `set-auth-jwt` header, and its `/token`
//   endpoint is in auth.ts's DISABLED_AUTH_PATHS (S6.2 §6).

export const OAUTH_ACCESS_TOKEN_SECONDS = 3600;

export type OAuthServerOptions = {
  /** KEPT_PUBLIC_URL. */
  publicUrl: string;
  /** How client metadata is fetched (oauth/cimd-fetch.ts); tests pass an in-memory one. */
  fetchClientMetadataResource: ClientMetadataResourceFetch;
  /** Tests only: which client id URLs may be fetched at all. */
  isMetadataDocumentUrlAllowed?: (url: string) => boolean;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether connectors can be offered at this public URL (D125). */
export function oauthAvailable(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return url.protocol === 'https:' || LOOPBACK.has(url.hostname);
}

/** Whether connectors are on in production: an https public URL only. */
export function oauthOnInProduction(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === 'https:';
}

export const resourceOf = (publicUrl: string) => `${publicUrl.replace(/\/+$/, '')}/mcp`;

export function oauthPlugins(opts: OAuthServerOptions) {
  return [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      loginPage: '/signin',
      consentPage: '/oauth/consent',
      resource: resourceOf(opts.publicUrl),
      scopes: [OAUTH_SCOPES.read, OAUTH_SCOPES.write],
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_SECONDS,
    }),
    cimd({
      fetchClientMetadataResource: opts.fetchClientMetadataResource,
      metadataProfile: 'mcp-2026-07-28',
      ...(opts.isMetadataDocumentUrlAllowed
        ? { isMetadataDocumentUrlAllowed: opts.isMetadataDocumentUrlAllowed }
        : {}),
    }),
  ];
}

/** Admin → Status's connectors row (T22, D125): the MCP URL, and whether OAuth connectors can be
 * offered (an https public URL) or only personal tokens work. */
export function connectorsStatus(publicUrl: string): {
  mcpUrl: string;
  oauth: 'available' | 'needs_https';
} {
  return {
    mcpUrl: resourceOf(publicUrl),
    oauth: oauthOnInProduction(publicUrl) ? 'available' : 'needs_https',
  };
}
