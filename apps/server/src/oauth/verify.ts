import type { TokenScope } from '@kept/shared';
import { type AuthInfo, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import type pg from 'pg';
import { AUTH_BASE_PATH, type Auth } from '../auth/auth.js';
import { MCP_SCOPES, type McpExtra, type OAuthAccessVerifier } from '../mcp/auth.js';
import { resourceOf } from './plugin.js';

// An OAuth access token at `/mcp` (step-6 plan T12, Q7; spike S6.2 §3, path B). Better Auth signed
// it (a JWT, EdDSA, its own JWKS read in-process: no HTTP call to Kept's own public `/jwks`), for
// this resource (`aud` = `<public URL>/mcp`) and issuer (`<public URL>/api/v1/auth`, which the
// jwt plugin's session JWT doesn't have). Then Kept's grant: kept.token_oauth_for(sub, client)
// gives the `oauth` token row with its scope and locations. No row, or a revoked one, is a 401,
// so revoking in Connections works at once while the JWT itself is still unexpired.
// A DPoP-bound token (a `cnf` claim) is refused: this path doesn't check DPoP proofs.

type JwksSource = { api: { getJwks: () => Promise<unknown> } };

/** Whether this Better Auth instance has the OAuth provider (oauth/plugin.ts) mounted. */
export function hasOAuthProvider(auth: Auth | null | undefined): auth is Auth {
  const api = (auth as unknown as { api?: Record<string, unknown> } | null)?.api;
  return typeof api?.getJwks === 'function' && typeof api.getOAuthServerConfig === 'function';
}

const invalidToken = (why: string) => new OAuthError(OAuthErrorCode.InvalidToken, why);

export function oauthAccessVerifier(opts: {
  auth: Auth;
  pool: pg.Pool;
  publicUrl: string;
}): OAuthAccessVerifier {
  const base = opts.publicUrl.replace(/\/+$/, '');
  const resource = resourceOf(base);
  const issuer = `${base}${AUTH_BASE_PATH}`;
  const jwksCacheKey = {};
  const source = opts.auth as unknown as JwksSource;
  return async (token: string): Promise<AuthInfo> => {
    let claims: Record<string, unknown>;
    try {
      claims = (await verifyJwsAccessToken(token, {
        jwksFetch: async () => (await source.api.getJwks()) as never,
        jwksCacheKey,
        verifyOptions: { issuer, audience: resource },
      })) as Record<string, unknown>;
    } catch {
      throw invalidToken('The access token is not valid here.');
    }
    if (claims.cnf !== undefined) throw invalidToken('Sender-constrained tokens are not accepted.');
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    const client =
      typeof claims.azp === 'string'
        ? claims.azp
        : typeof claims.client_id === 'string'
          ? claims.client_id
          : null;
    const exp = typeof claims.exp === 'number' ? claims.exp : null;
    if (!sub || !client || !exp) throw invalidToken('The access token is incomplete.');
    const { rows } = await opts.pool.query<{ token_id: string; scope: TokenScope; mfa: boolean }>(
      'SELECT token_id, scope, mfa FROM kept.token_oauth_for($1, $2)',
      [sub, client],
    );
    const grant = rows[0];
    if (!grant) throw invalidToken('This app’s access was removed; connect it again.');
    const extra: McpExtra = {
      userId: sub,
      tokenId: grant.token_id,
      mfa: grant.mfa,
      scope: grant.scope,
      kind: 'oauth',
    };
    return {
      token,
      clientId: client,
      scopes: [...MCP_SCOPES[grant.scope]],
      expiresAt: exp,
      resource: new URL(resource),
      extra,
    };
  };
}
