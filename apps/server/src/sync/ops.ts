import {
  type DropReason,
  newId,
  type OpKind,
  OUTCOMES,
  PAYLOAD_VERSION,
  type QueueItem,
  type SyncOpResult,
  type SyncOpsRequest,
  SyncOpsRequestSchema,
  type SyncOpsResponse,
} from '@kept/shared';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { requireScope } from '../auth/http.js';
import type { Pools } from '../db/pools.js';
import { type Scope, ScopeError, withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { pgErrorOf, toErrorReply } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import type { JobQueue } from '../jobs/queue.js';
import type { FileStorage } from '../storage/blob-store.js';
import type { Dropped, Handler, HandlerResult, OpCtx } from './handlers/common.js';
import { HANDLERS, registerSyncReplayers } from './handlers/index.js';
import {
  batchRefusal,
  inOpsWindow,
  LEDGER_KEY,
  madeIds,
  PAYLOAD_WINDOW,
  type PayloadWindow,
  parsedPayload,
  requestHash,
} from './payload.js';

// POST /api/v1/sync/ops (plan T14; engineering spec §2.3, §7.4; D17, D35, D36, D112, D148, D156,
// D210; Q2, Q3): the phone's queued offline changes, applied in the order they arrive.
//
// Body `{clientVersion, ops: QueueItem[1..50]}` (packages/shared SyncOpsRequestSchema, strict: the
// phone sends exactly the wire fields); answer `{results: SyncOpResult[]}`, one per op, in order.
//
// 1. Versions (D148, Q3), for the whole batch before anything is applied: an op below the oldest
//    payload version this server upgrades is 409 `client_outdated` {minPayloadVersion}; one above
//    its own is 409 `server_outdated`. The phone keeps its queue either way.
// 2. Then each op, in order, in its own scoped transaction (§7.4), as the caller:
//    a. the ledger (`sync_ops`, 0035): the same key with the same `request_hash` answers the
//       stored result (a replay creates nothing, audits nothing); the same key with another body
//       is `dropped` / `idempotency_mismatch`. The key is locked for the transaction, so two
//       sends of one op racing each other apply it once;
//    b. `client_id`, and every id the payload makes rows with, within the ops-only window (Q2:
//       90 days back, 1 ahead), else `invalid`; `taken_at` clamped to the receipt (D112);
//    c. `dependsOn`: a parent dropped in this batch, or earlier (the ledger), drops it as
//       `parent_dropped`;
//    d. the payload, upgraded (`upgradePayload`) then validated with its schema, else `invalid`;
//    e. the location: one the caller writes; a viewer's op is `not_permitted`. One they can't
//       see is `location_revoked` when they were a member of it (D210: removed, left or expired;
//       kept.was_member_of(), 0055, answers only that boolean about the caller, so an op queued
//       before the phone's first sync into it is told too), else `not_permitted`, the same as a
//       random id: an op can't be used to learn that a location exists;
//    f. the handler (sync/handlers/), under a savepoint. A domain refusal the service throws is a
//       drop: 404 `target_missing`, 403 `not_permitted`, any other 4xx `invalid`. A drop writes
//       nothing of the op, and, when it is `target_trashed` or `target_missing` in a location
//       the caller still writes, opens an inbox `sync_drop` item carrying the op, so it can be
//       restored (T15) and is seen on every device (D35: never silent);
//    g. the ledger row, with the answer, in the same transaction.
// 3. Queue ops skip `row_version` (§7.4): the latest change wins, visibly (D35), except readings
//    and label claims, which the server orders itself (D112).
// 4. Anything else a handler throws (a bug, a lost connection, a serialization failure) stops the
//    batch there: that op's transaction rolls back, and the answer (200) holds the results before
//    it. The phone sends the rest again with the same keys (T24 marks them pending and backs off).
//
// Audit: each op's service writes its own events, as the caller (`thing.capture`, `thing.move`,
// `label.claim`, …); a replay writes none. The ledger itself is the record of what arrived.

const Uuid = z.uuid();

const SyncOpResultSchema = z.object({
  clientId: z.string(),
  idempotencyKey: z.string(),
  outcome: z.enum(OUTCOMES),
  reason: z.string().optional(),
  entity: z
    .object({ type: z.string(), id: Uuid, shortCode: z.string().nullable().optional() })
    .optional(),
  notice: z
    .object({
      name: z.string(),
      by: z.object({ displayName: z.string() }),
      action: z.enum(['trashed', 'moved', 'removed']),
    })
    .optional(),
  inboxItemId: Uuid.optional(),
});

const SyncOpsResponseSchema = z.object({ results: z.array(SyncOpResultSchema) });

export type OpsDeps = {
  pools: Pick<Pools, 'app'>;
  jobs: JobQueue | null;
  files: FileStorage | null;
  log: FastifyBaseLogger;
};

export type OpsOptions = {
  window?: PayloadWindow;
  now?: () => number;
  /** Tests: stand-ins for some kinds' handlers (a handler that fails like a bug would). */
  handlers?: Partial<{ [K in OpKind]: Handler<K> }>;
};

/** Drops that open an inbox `sync_drop` item: the world changed under the op. */
const INBOX_DROPS = new Set<DropReason>(['target_trashed', 'target_missing']);

/** A thrown error that is a domain refusal, as the drop it means; null for anything else. */
function refusalOf(err: unknown): DropReason | null {
  if (err instanceof ScopeError) return null;
  const pg = pgErrorOf(err);
  // Serialization failures and deadlocks are worth another try, not a drop.
  if (pg && (pg.code === '40001' || pg.code === '40P01')) return null;
  const { status } = toErrorReply(err);
  if (status >= 500 || status === 401 || status === 429) return null;
  if (status === 404) return 'target_missing';
  if (status === 403) return 'not_permitted';
  return 'invalid';
}

type Ledger = { request_hash: string; outcome: string; result: SyncOpResult };

async function ledgerRow(client: pg.ClientBase, key: string): Promise<Ledger | null> {
  const { rows } = await client.query<Ledger>(
    `SELECT request_hash, outcome, result FROM public.sync_ops
      WHERE user_id = kept.current_user_id() AND idempotency_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/** Whether any of `keys` was dropped in an earlier batch. */
async function droppedBefore(client: pg.ClientBase, keys: readonly string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.sync_ops
      WHERE user_id = kept.current_user_id() AND idempotency_key = ANY ($1::text[])
        AND outcome = 'dropped' LIMIT 1`,
    [[...keys]],
  );
  return (rowCount ?? 0) > 0;
}

/** The caller's role in the location, or why their op can't go there (step e). */
async function access(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ role: string } | { drop: DropReason }> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT m.role FROM public.memberships m
      WHERE m.location_id = $1 AND m.user_id = kept.current_user_id()
        AND m.location_id IN (SELECT kept.visible_location_ids())`,
    [locationId],
  );
  const role = rows[0]?.role;
  if (role) return role === 'viewer' ? { drop: 'not_permitted' } : { role };
  // A former member: their removal, leaving or expiry is on record (kept.was_member_of, whether
  // or not an op of theirs ever reached it; step-3 carry-over, T19), or their own ledger holds
  // the location, which it does only while it was visible to them (the insert policy).
  const { rows: was } = await client.query<{ was: boolean }>(
    `SELECT kept.was_member_of($1) OR EXISTS (
       SELECT 1 FROM public.sync_ops
        WHERE user_id = kept.current_user_id() AND location_id = $1) AS was`,
    [locationId],
  );
  return { drop: was[0]?.was ? 'location_revoked' : 'not_permitted' };
}

async function isVisible(client: pg.ClientBase, locationId: string): Promise<boolean> {
  const { rows } = await client.query<{ v: boolean }>(
    'SELECT $1::uuid IN (SELECT kept.visible_location_ids()) AS v',
    [locationId],
  );
  return rows[0]?.v === true;
}

/** The inbox `sync_drop` item of a drop (T15's payload): the op, so Restore can run it again. */
async function openDropItem(
  client: pg.ClientBase,
  locationId: string,
  item: QueueItem,
  payload: unknown,
  drop: Dropped,
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO public.inbox_items (id, location_id, kind, created_by, payload)
     VALUES ($1, $2, 'sync_drop', kept.current_user_id(), $3)`,
    [
      id,
      locationId,
      JSON.stringify({
        op: { op: item.op, payload },
        reason: drop.reason,
        ...(drop.subject ? { entity: drop.subject } : {}),
        ...(drop.by ? { by: { displayName: drop.by } } : {}),
      }),
    ],
  );
  return id;
}

/** One op, in its own transaction (steps a–g). Throws only for what stops the batch. */
async function applyOne(
  deps: OpsDeps,
  scope: Scope,
  requestId: string,
  item: QueueItem,
  droppedHere: ReadonlySet<string>,
  opts: Required<OpsOptions>,
): Promise<SyncOpResult> {
  const base = { clientId: item.clientId, idempotencyKey: item.idempotencyKey };
  const drop = (reason: DropReason): SyncOpResult => ({ ...base, outcome: 'dropped', reason });
  // A key the ledger can't hold is answered, never recorded (there is nothing to replay).
  if (!LEDGER_KEY.test(item.idempotencyKey)) return drop('invalid');
  const hash = requestHash(item);
  const now = opts.now();

  return withScope(deps.pools.app, scope, async (tx, client) => {
    // a. Once per key: a concurrent send of the same op waits here, then replays.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `kept.sync_ops:${scope.userId}:${item.idempotencyKey}`,
    ]);
    const prior = await ledgerRow(client, item.idempotencyKey);
    if (prior) return prior.request_hash === hash ? prior.result : drop('idempotency_mismatch');

    const locationId = item.locationId.toLowerCase();
    const takenAt = new Date(Math.min(Date.parse(item.takenAt), now));

    const record = async (result: SyncOpResult): Promise<SyncOpResult> => {
      await client.query(
        `INSERT INTO public.sync_ops (user_id, idempotency_key, client_id, location_id, op,
                                      payload_version, client_version, taken_at, request_hash,
                                      outcome, reason, result)
         VALUES (kept.current_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          item.idempotencyKey,
          item.clientId.toLowerCase(),
          (await isVisible(client, locationId)) ? locationId : null,
          item.op,
          // What it was applied as: every op of an accepted batch is brought up to this build's.
          PAYLOAD_VERSION,
          item.clientVersion,
          takenAt,
          hash,
          result.outcome,
          result.reason ?? null,
          JSON.stringify(result),
        ],
      );
      return result;
    };

    // b. The ids.
    if (!inOpsWindow(item.clientId, now)) return record(drop('invalid'));
    // c. The parents.
    const parents = item.dependsOn ?? [];
    if (parents.some((k) => droppedHere.has(k)) || (await droppedBefore(client, parents))) {
      return record(drop('parent_dropped'));
    }
    // d. The payload.
    const payload = parsedPayload(item.op, item.payloadVersion, item.payload, opts.window);
    if (!payload) return record(drop('invalid'));
    if (!madeIds(item.op, payload).every((id) => inOpsWindow(id, now))) {
      return record(drop('invalid'));
    }
    // e. The location.
    const where = await access(client, locationId);
    if ('drop' in where) return record(drop(where.drop));

    // f. The change.
    const ctx: OpCtx = { tx, client, scope, requestId, jobs: deps.jobs, files: deps.files };
    let out: HandlerResult;
    await client.query('SAVEPOINT kept_sync_op');
    try {
      const handler = (opts.handlers[item.op] ?? HANDLERS[item.op]) as Handler<'move'>;
      out = await handler(ctx, { locationId, takenAt, payload: payload as never });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT kept_sync_op');
      const reason = refusalOf(err);
      if (!reason) throw err;
      out = { outcome: 'dropped', reason };
    }
    if (out.outcome === 'dropped') {
      // Nothing of a dropped op stays (a handler drops before it writes; this makes sure).
      await client.query('ROLLBACK TO SAVEPOINT kept_sync_op');
      const result: SyncOpResult = {
        ...drop(out.reason),
        ...(out.notice ? { notice: out.notice } : {}),
      };
      if (INBOX_DROPS.has(out.reason)) {
        result.inboxItemId = await openDropItem(client, locationId, item, payload, out);
      }
      return record(result);
    }
    await client.query('RELEASE SAVEPOINT kept_sync_op');
    return record({
      ...base,
      outcome: out.outcome,
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.entity ? { entity: out.entity } : {}),
      ...(out.notice ? { notice: out.notice } : {}),
      ...(out.inboxItemId ? { inboxItemId: out.inboxItemId } : {}),
    });
  });
}

/**
 * The batch, after its version check (which throws the 409). Stops at the first op that fails
 * for a reason that isn't a domain outcome, and answers what came before it.
 */
export async function applyOps(
  deps: OpsDeps,
  scope: Scope,
  requestId: string,
  body: SyncOpsRequest,
  options: OpsOptions = {},
): Promise<SyncOpsResponse> {
  const opts: Required<OpsOptions> = {
    window: options.window ?? PAYLOAD_WINDOW,
    now: options.now ?? Date.now,
    handlers: options.handlers ?? {},
  };
  const refused = batchRefusal(body.ops, opts.window);
  if (refused) throw refused;
  const results: SyncOpResult[] = [];
  const droppedHere = new Set<string>();
  for (const item of body.ops) {
    let result: SyncOpResult;
    try {
      result = await applyOne(deps, scope, requestId, item, droppedHere, opts);
    } catch (err) {
      deps.log.error(
        { err, op: item.op, answered: results.length, of: body.ops.length },
        'sync op failed; the rest of the batch waits on the phone',
      );
      break;
    }
    // A mismatch says nothing of the op the key first carried; its children follow that one.
    if (result.outcome === 'dropped' && result.reason !== 'idempotency_mismatch') {
      droppedHere.add(item.idempotencyKey);
    }
    results.push(result);
  }
  return { results };
}

export async function syncOpsRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  registerSyncReplayers();
  app.post(
    '/api/v1/sync/ops',
    { schema: { body: SyncOpsRequestSchema, response: { 200: SyncOpsResponseSchema } } },
    (req) =>
      applyOps(
        { pools: deps.pools, jobs: deps.jobs, files: deps.files, log: req.log },
        requireScope(req),
        req.id,
        req.body,
      ),
  );
}
