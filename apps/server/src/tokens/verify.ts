import { createHmac, hkdfSync } from 'node:crypto';
import {
  CONNECTIONS_ERROR_HINTS,
  parseToken,
  TOKEN_PREFIX,
  type TokenKind,
  type TokenScope,
} from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import type { Scope } from '../db/scope.js';
import { AppError } from '../http/errors.js';
import { tokenAccessOf } from './access.js';
import { hitTokenRate } from './rate.js';

// A personal token on a request (step-6 plan T10; D15, D60, D63, D180; engineering spec §3.2,
// §7.3). `Authorization: Bearer kpt_<lookup>_<secret>`:
//   parseToken → HMAC of the secret → kept.token_verify (by lookup, before any scope exists) →
//   the request's scope {userId, mfa: created_with_mfa, tokenId}.
// withScope() then sets `app.token_id`, and RLS reaches only the token's locations, with nothing
// to write for a read token, re-evaluated on every statement (0070, D180).
//
// A bearer request ignores cookies: its scope is the token's, never the browser session's, so it
// needs no CSRF check (auth/http.ts csrfHook skips it; a page on another site can't set the
// header without a CORS preflight Kept never answers). Only personal tokens are accepted on
// `/api/v1`: an OAuth access token is bound to the MCP resource (`aud` = `<public URL>/mcp`,
// Q7) and is verified at `/mcp` alone (mcp/auth.ts).

export type TokenPrincipal = {
  tokenId: string;
  userId: string;
  scope: TokenScope;
  kind: TokenKind;
  mfa: boolean;
  expiresAt: Date | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** The token a bearer request was made with; null for a session (or no) request. */
    token: TokenPrincipal | null;
  }
}

/** The key a token secret's HMAC is made with: KEPT_AUTH_SECRET's HKDF sibling (plan T4). */
export function tokenHashKey(authSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, 'kept-tokens', 'token-hash', 32));
}

/** The stored HMAC of a token's secret (64 hex characters, `api_tokens.hash`). */
export function hashTokenSecret(key: Buffer, secret: string): string {
  return createHmac('sha256', key).update(secret).digest('hex');
}

/** The bearer value of an Authorization header, or null. */
export function bearerOf(req: Pick<FastifyRequest, 'headers'>): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = value ? /^Bearer\s+(\S+)\s*$/i.exec(value) : null;
  return m?.[1] ?? null;
}

/** Whether the request carries a personal token (whatever its validity). */
export function hasPersonalToken(req: Pick<FastifyRequest, 'headers'>): boolean {
  return bearerOf(req)?.startsWith(TOKEN_PREFIX) ?? false;
}

/**
 * The live token a raw `kpt_…` value names, or null (malformed, unknown, revoked, expired or a
 * wrong secret: all alike). kept.token_verify stamps last_used_at at most once a minute.
 */
export async function verifyPersonalToken(
  pool: pg.Pool,
  key: Buffer,
  raw: string,
): Promise<TokenPrincipal | null> {
  const parts = parseToken(raw);
  if (!parts) return null;
  const { rows } = await pool.query<{
    token_id: string;
    user_id: string;
    scope: TokenScope;
    kind: TokenKind;
    mfa: boolean;
    expires_at: Date | null;
  }>('SELECT * FROM kept.token_verify($1, $2)', [parts.lookup, hashTokenSecret(key, parts.secret)]);
  const row = rows[0];
  if (!row) return null;
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    scope: row.scope,
    kind: row.kind,
    mfa: row.mfa,
    expiresAt: row.expires_at,
  };
}

export const tokenRevoked = () =>
  new AppError('token_revoked', 401, CONNECTIONS_ERROR_HINTS.token_revoked);

export const tokenScope = (hint: string = CONNECTIONS_ERROR_HINTS.token_scope) =>
  new AppError('token_scope', 403, hint);

/** The scope a token request runs in. */
export const scopeOfToken = (t: TokenPrincipal): Scope => ({
  userId: t.userId,
  mfa: t.mfa,
  tokenId: t.tokenId,
});

export type BearerHookOptions = {
  pools: Pick<Pools, 'app'>;
  key: Buffer;
  /** The route's own auth mode ('none' routes, such as `/mcp`, verify for themselves). */
  authMode: (req: FastifyRequest) => 'required' | 'optional' | 'none';
};

/**
 * The onRequest hook, before the session hook: a request with `Authorization: Bearer …` gets its
 * scope from the token, or is refused.
 * - 401 `token_revoked` for a token that doesn't verify (with the hint of §5), `unauthenticated`
 *   for any other bearer value;
 * - 403 `token_scope` on a route its catalogue entry doesn't open to tokens (tokens/access.ts),
 *   or a read token on a write route;
 * - 429 `rate_limited` past the token's reads or writes this minute (§3.2, Q19).
 */
export function bearerHook(opts: BearerHookOptions) {
  return async function resolveBearer(req: FastifyRequest, reply: FastifyReply) {
    if (opts.authMode(req) === 'none') return;
    const raw = bearerOf(req);
    if (raw === null) return;
    if (!raw.startsWith(TOKEN_PREFIX)) throw new AppError('unauthenticated', 401);
    const token = await verifyPersonalToken(opts.pools.app, opts.key, raw);
    if (!token) throw tokenRevoked();
    const access = tokenAccessOf(req.method, req.routeOptions.url ?? '');
    if (access === 'none') {
      throw tokenScope('This route is not open to tokens; do this in Kept.');
    }
    if (access === 'write' && token.scope !== 'write') throw tokenScope();
    const kind = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    await hitTokenRate(opts.pools.app, token.tokenId, kind, reply);
    req.token = token;
    req.scope = scopeOfToken(token);
  };
}
