import { OAUTH_SCOPES, TOKEN_PREFIX, type TokenScope } from '@kept/shared';
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type pg from 'pg';
import { verifyPersonalToken } from '../tokens/verify.js';
import type { ToolPrincipal } from '../tools/types.js';

// Who is calling `/mcp` (step-6 plan T11, T12; D63, D180). One verifier for both kinds of bearer:
// - a personal token (`kpt_…`, T10): kept.token_verify, as on `/api/v1`;
// - an OAuth access token (T12): a JWT Better Auth signed for this resource, whose grant row
//   (kept.token_oauth_for) gives the scope and locations, read on every call so revoking it in
//   Connections works at once (Q7).
// Either becomes the SDK's AuthInfo, whose `extra` carries Kept's principal for the factory.
// `expiresAt` is always set (the SDK's bearer helper refuses a token without one): a personal
// token without an expiry gets five minutes from this request.

export const MCP_SCOPES = Object.freeze({
  read: [OAUTH_SCOPES.read],
  write: [OAUTH_SCOPES.read, OAUTH_SCOPES.write],
}) satisfies Record<TokenScope, readonly string[]>;

const NO_EXPIRY_WINDOW_S = 300;

/** What Kept puts in `AuthInfo.extra`. */
export type McpExtra = {
  userId: string;
  tokenId: string;
  mfa: boolean;
  scope: TokenScope;
  kind: 'personal' | 'oauth';
};

/** Verifies an OAuth access token (T12); null when OAuth is off or the token isn't one. */
export type OAuthAccessVerifier = (token: string) => Promise<AuthInfo>;

export type McpVerifierOptions = {
  pool: pg.Pool;
  key: Buffer;
  /** `<public URL>/mcp`, the resource every token here is for. */
  resource: URL;
  oauth?: OAuthAccessVerifier | null;
  now?: () => number;
};

const invalidToken = (why: string) => new OAuthError(OAuthErrorCode.InvalidToken, why);

export function mcpVerifier(opts: McpVerifierOptions): OAuthTokenVerifier {
  const now = opts.now ?? Date.now;
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.startsWith(TOKEN_PREFIX)) {
        const t = await verifyPersonalToken(opts.pool, opts.key, token);
        if (!t) throw invalidToken('The token was revoked or has expired.');
        const nowS = Math.floor(now() / 1000);
        const expiresAt = t.expiresAt
          ? Math.floor(t.expiresAt.getTime() / 1000)
          : nowS + NO_EXPIRY_WINDOW_S;
        const extra: McpExtra = {
          userId: t.userId,
          tokenId: t.tokenId,
          mfa: t.mfa,
          scope: t.scope,
          kind: 'personal',
        };
        return {
          token,
          clientId: t.tokenId,
          scopes: [...MCP_SCOPES[t.scope]],
          expiresAt,
          resource: opts.resource,
          extra,
        };
      }
      if (opts.oauth) return opts.oauth(token);
      throw invalidToken('Use a personal token from Settings → Connections.');
    },
  };
}

/** Kept's principal for a verified AuthInfo; null when it isn't one of ours. */
export function principalOf(authInfo: AuthInfo | undefined): ToolPrincipal | null {
  const e = authInfo?.extra as Partial<McpExtra> | undefined;
  if (!e?.userId || !e.tokenId || typeof e.mfa !== 'boolean') return null;
  if (e.scope !== 'read' && e.scope !== 'write') return null;
  return { userId: e.userId, tokenId: e.tokenId, mfa: e.mfa, scope: e.scope };
}
