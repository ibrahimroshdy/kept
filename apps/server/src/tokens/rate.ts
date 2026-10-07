import { TOKEN_RATE, type TokenScope } from '@kept/shared';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { rateLimited } from '../auth/http.js';

// The per-token limiter (engineering spec §3.2; plan Q19): reads 120 a minute and writes 30 a
// minute per token, counted in Postgres by kept.token_rate_hit() so every replica shares the
// window. The same limiter counts the public API's requests and MCP's tool calls (D63), a tool
// call by its tool's scope.

export const RATE_LIMIT: Readonly<Record<TokenScope, number>> = Object.freeze({
  read: TOKEN_RATE.readsPerMinute,
  write: TOKEN_RATE.writesPerMinute,
});

export type RateDecision = { ok: true } | { ok: false; retryAfter: number };

/** Counts one request against the token's window for `kind`. */
export async function tokenRateHit(
  pool: pg.Pool | pg.ClientBase,
  tokenId: string,
  kind: TokenScope,
): Promise<RateDecision> {
  const { rows } = await pool.query<{ ok: boolean; retry_after: number }>(
    'SELECT ok, retry_after FROM kept.token_rate_hit($1, $2, $3)',
    [tokenId, kind, RATE_LIMIT[kind]],
  );
  const row = rows[0];
  if (!row || row.ok) return { ok: true };
  return { ok: false, retryAfter: Math.max(1, row.retry_after) };
}

/** tokenRateHit(), answering 429 with Retry-After when the window is full. */
export async function hitTokenRate(
  pool: pg.Pool,
  tokenId: string,
  kind: TokenScope,
  reply: FastifyReply,
): Promise<void> {
  const decision = await tokenRateHit(pool, tokenId, kind);
  if (!decision.ok) throw rateLimited(reply, decision.retryAfter);
}
