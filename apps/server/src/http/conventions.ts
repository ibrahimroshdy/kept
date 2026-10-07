import { createHash } from 'node:crypto';
import { withinWindow } from '@kept/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { idempotencyKeys } from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import { AppError, invalid } from './errors.js';

// API conventions (engineering spec §7.7; D156, D178).

// ---------------------------------------------------------------------------------------------
// Optimistic concurrency: If-Match: <row_version>
// ---------------------------------------------------------------------------------------------

/** Accepts `3`, `"3"` and `W/"3"`: clients and proxies quote ETag-style values. */
const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;

/** The row version the client started from. A write without one is refused with 428. */
export function requireIfMatch(req: Pick<FastifyRequest, 'headers'>): number {
  const raw = req.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw new AppError(
      'precondition_failed',
      428,
      'Send If-Match with the row_version you started from.',
    );
  }
  const match = IF_MATCH.exec(value.trim());
  if (!match) throw invalid('If-Match must be the row_version, a whole number.');
  return Number(match[1]);
}

/** Who made the change a stale write collided with, for the 412 body (the web contract, T26). */
export type ChangedBy = { displayName: string };

/**
 * Throws 412 when the row moved on since the client read it (D156). `fields` are the fields the
 * client tried to change, returned as `conflicts`; the values are not: the client re-reads the
 * row through the normal serialiser, which applies money and secret gating. `changedBy`, when the
 * route knows it (the latest audit event's actor), is returned as `changedBy: {displayName}`.
 */
export function checkVersion(
  row: { rowVersion: number },
  expected: number,
  fields: readonly string[] = [],
  changedBy?: ChangedBy | null,
): void {
  if (row.rowVersion === expected) return;
  throw new AppError('precondition_failed', 412, 'Reload to see the latest version.', {
    conflicts: [...fields],
    row_version: row.rowVersion,
    ...(changedBy ? { changedBy: { displayName: changedBy.displayName } } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Cursor pagination: 20 per page by default, 200 at most
// ---------------------------------------------------------------------------------------------

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 200;

/** Merge into a route's querystring schema. */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});

export type PageRequest<K = unknown> = { limit: number; after: K | null };

/** An opaque cursor: base64url JSON `{k: lastKey}`. */
export function encodeCursor(lastKey: unknown): string {
  return Buffer.from(JSON.stringify({ k: lastKey })).toString('base64url');
}

export function decodeCursor<K = unknown>(cursor: string): K {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && 'k' in parsed) return parsed.k as K;
  } catch {}
  throw invalid('The cursor is not valid; start again from the first page.');
}

/** The page a request asks for. Takes raw or already-parsed query values. */
export function paginate<K = unknown>(query: {
  limit?: unknown;
  cursor?: unknown;
}): PageRequest<K> {
  const parsed = paginationQuery.safeParse(query);
  if (!parsed.success) throw invalid(`limit is 1 to ${PAGE_MAX}.`);
  return {
    limit: parsed.data.limit,
    after: parsed.data.cursor ? decodeCursor<K>(parsed.data.cursor) : null,
  };
}

/**
 * One page from rows fetched with `LIMIT limit + 1`: the extra row only says there is more.
 * `keyOf` is the sort key of a row, which the next request's `after` resumes from.
 */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => unknown,
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Client-supplied ids
// ---------------------------------------------------------------------------------------------

/** A client-generated id must be a UUIDv7 within ± 7 days of now (§7.7, D17). */
export function assertClientId(id: string, now: number = Date.now()): string {
  if (!withinWindow(id, now)) {
    throw new AppError(
      'id_out_of_window',
      400,
      'Generate ids as UUIDv7 on a device whose clock is within 7 days of the server.',
    );
  }
  return id.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------------------------

export type StoredResponse = {
  status: number;
  body: unknown;
  /** The `x-kept-audit-event` value the write answered (http/write.ts), replayed with it. */
  auditEvent?: string;
};

/** A stable hash of what a request asks for; a repeat must match it. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), path, body ?? null]))
    .digest('hex');
}

const KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * Runs `fn` once per (user, key). The key row is written first, in the caller's transaction:
 * a concurrent repeat waits on it and then sees the committed response; if this transaction
 * rolls back, the key goes with it and a retry runs afresh. A repeat returns the stored response
 * (`replayed: true`); a repeat with a different request hash is 409 `idempotency_mismatch`.
 */
export async function withIdempotency(
  tx: Tx,
  userId: string,
  key: string,
  requestHash: string,
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!KEY.test(key)) throw invalid('Idempotency-Key is 1 to 255 visible ASCII characters.');
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ userId, key, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
  if (inserted.length === 0) {
    const [existing] = await tx
      .select({ requestHash: idempotencyKeys.requestHash, response: idempotencyKeys.response })
      .from(idempotencyKeys)
      .where(where);
    if (!existing) throw new Error('idempotency key vanished after a conflict');
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        'idempotency_mismatch',
        409,
        'Use a new Idempotency-Key for a new request.',
      );
    }
    return { ...(existing.response as StoredResponse), replayed: true };
  }

  const response = await fn();
  await tx
    .update(idempotencyKeys)
    .set({ response: sql`${JSON.stringify(response)}::jsonb` })
    .where(where);
  return { ...response, replayed: false };
}
