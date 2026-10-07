import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { undoableEventIds } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { hashRequest, type StoredResponse, withIdempotency } from './conventions.js';

// One way for a route to write (engineering spec §7.7; D94, D156): a scoped kept_app transaction
// for the signed-in user, with the request's Idempotency-Key honoured inside it. Whatever `fn`
// does (the write, its audit event, a job sent with sendInTx) commits or rolls back together, and
// the stored response with it: a retry after a rollback runs afresh.

export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Set on a response that was replayed from an earlier request with the same key. */
export const REPLAYED_HEADER = 'idempotent-replayed';
/**
 * Set on a write that recorded an undoable change (audited() with `undoableUntil`): the id of
 * that audit event, for the Undo toast's POST /api/v1/audit/:eventId/undo. A write that changed
 * several things undoably (a bulk move) lists one id per thing, comma-separated in write order.
 * Absent when nothing undoable was written; replayed with an Idempotency-Key replay.
 */
export const AUDIT_EVENT_HEADER = 'x-kept-audit-event';

export type WriteResult<B> = {
  status: number;
  body: B;
  /** Runs after the transaction commits (and never on a replay), for work that needs another
   * login or its own transaction. Its failure is logged, not answered: the write stands. */
  afterCommit?: () => Promise<void>;
};

export type WriteOptions = {
  /** What the idempotency row keeps of the body. A response that carries a one-time secret (an
   * invite link, a reset code) must not be stored in the clear, so its replay says the request
   * was done without repeating the secret. */
  redact?: (body: unknown) => unknown;
};

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ? value.trim() : undefined;
}

type Outcome<B> = {
  status: number;
  body: B;
  replayed: boolean;
  auditEvent?: string | undefined;
  afterCommit?: () => Promise<void>;
};

/** The header value for the undoable events `tx` wrote, or undefined for none. */
function auditEventOf(tx: Tx): string | undefined {
  const ids = undoableEventIds(tx);
  return ids.length > 0 ? ids.join(', ') : undefined;
}

/** Runs `fn` as the request's user in one transaction, once per Idempotency-Key. Sets the reply's
 * status and returns the body for Fastify to serialise. */
export async function scopedWrite<B>(
  pools: Pick<Pools, 'app'>,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (tx: Tx, client: pg.PoolClient, scope: Scope) => Promise<WriteResult<B>>,
  opts: WriteOptions = {},
): Promise<B> {
  const scope = requireScope(req);
  const key = headerValue(req, IDEMPOTENCY_HEADER);
  const result = await withScope(pools.app, scope, async (tx, client): Promise<Outcome<B>> => {
    if (!key) {
      const done = await fn(tx, client, scope);
      return { ...done, replayed: false, auditEvent: auditEventOf(tx) };
    }
    let fresh: WriteResult<B> | undefined;
    const stored = await withIdempotency(
      tx,
      scope.userId,
      key,
      hashRequest(req.method, req.url, req.body),
      async (): Promise<StoredResponse> => {
        fresh = await fn(tx, client, scope);
        const body = opts.redact ? opts.redact(fresh.body) : fresh.body;
        const auditEvent = auditEventOf(tx);
        return { status: fresh.status, body, ...(auditEvent ? { auditEvent } : {}) };
      },
    );
    if (stored.replayed || !fresh) {
      return {
        status: stored.status,
        body: stored.body as B,
        replayed: true,
        auditEvent: stored.auditEvent,
      };
    }
    return { ...fresh, replayed: false, auditEvent: stored.auditEvent };
  });
  if (result.auditEvent) reply.header(AUDIT_EVENT_HEADER, result.auditEvent);
  if (result.replayed) reply.header(REPLAYED_HEADER, 'true');
  else if (result.afterCommit) {
    await result.afterCommit().catch((err: unknown) => {
      req.log.error({ err }, 'post-commit work failed');
    });
  }
  if (result.status === 204) {
    reply.code(204).send();
    return undefined as B;
  }
  reply.code(result.status);
  return result.body;
}

/** A read as the request's user. */
export function scopedRead<T>(
  pools: Pick<Pools, 'app'>,
  req: FastifyRequest,
  fn: (tx: Tx, client: pg.PoolClient, scope: Scope) => Promise<T>,
): Promise<T> {
  const scope = requireScope(req);
  return withScope(pools.app, scope, (tx, client) => fn(tx, client, scope));
}
