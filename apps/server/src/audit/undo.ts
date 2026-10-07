import { isDeepStrictEqual } from 'node:util';
import { can, type Role } from '@kept/shared';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { scopedWrite } from '../http/write.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import type { FileStorage } from '../storage/blob-store.js';
import { actorOf } from './actor.js';
import { type AuditEventInput, type AuditResult, audited } from './audited.js';

// Undo (D58, D124, D150; engineering spec §7.5; T27 decision): POST /api/v1/audit/:eventId/undo
// reverses one audited change, while its `undoable_until` (at most 7 days) hasn't passed.
//
// The route is generic; what "reverse" means is per action, in a registry: an area registers a
// handler for each action it writes as undoable (things/undo.ts registers `thing.update`,
// `thing.retype`, `thing.lifecycle`, `thing.move` and `thing.trash`; places register
// `place.update`, `place.move` and `place.trash`; step 3's list is in undo/registry.ts). An action
// with no handler is 409, as is an event whose window has passed or that was already undone.
//
// The route checks, before any handler runs:
// - the event is visible to the caller (the audit_events policy), else 404;
// - it is a location event, and the caller is a member there, else 404;
// - it was the caller's own change, or the caller is an owner or admin there, else 403 (an undo
//   rewrites someone else's work only with the authority to overrule them);
// - it is still undoable and not undone yet, else 409.
// The handler then checks that what the event changed is still as the event left it (D124:
// "Can't undo: Alfred changed the location since"), refusing with `undoConflict()`, applies the
// reverse, and writes the undo's own audit row through `args.audit()`, which fills in the actor,
// the request id and `undo_of` (kept.guard_audit_event() checks it names an undoable event of the
// same location). Everything runs in one transaction with the route's read of the event, which is
// locked against a racing second undo by `pg_advisory_xact_lock`.

// Every refusal is 409 `undo_refused` (T20; the web's UndoRefusedDetails) with a `reason`:
// - `not_undoable`: no handler for the action, an event written without a window (an undo
//   itself: there is no redo), or a diff holding a secret-class field (screens §8);
// - `expired`: its 7 days have passed;
// - `already_undone`: an undo of it exists;
// - `changed_since`: the handler found something changed since, with `field` (the first),
//   `conflicts` (all of them) and `changedBy: {displayName}` when known. A handler's plain 409
//   `conflict` ("it is in the trash now") is reported as `changed_since` too.
// A money write-back by someone who can't see money stays 409 `module_off`.

/** An event as a handler sees it (snake_case diff as stored, before renderAudit()). */
export type UndoableEvent = {
  id: string;
  at: Date;
  locationId: string;
  ownerAccountId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  rootThingId: string | null;
  diff: Record<string, { before?: unknown; after?: unknown; class?: string; changed?: true }>;
  undoableUntil: Date;
};

export type UndoDeps = {
  jobs: JobQueue | null;
  files: FileStorage | null;
  log: FastifyBaseLogger;
};

export type UndoArgs = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  event: UndoableEvent;
  /** The caller's role in the event's location. */
  role: Role;
  requestId: string;
  deps: UndoDeps;
  /** Writes the undo's audit row: actor, request id and `undo_of` are filled in. Call it once,
   * for the event's own location; a handler that also touches another location writes that
   * location's row with `audited()` directly (no `undo_of`: it points within one location). */
  audit: (
    event: Omit<AuditEventInput, 'actor' | 'requestId' | 'undoOf' | 'locationId'>,
  ) => Promise<AuditResult>;
};

export type UndoHandler = (args: UndoArgs) => Promise<void>;

/**
 * An account-level event (no location, §7.13): a change to an account's own records, such as an
 * exchange rate (step 4, T8). Undone by the account's owners and admins only: nobody else can
 * write such a change in the first place.
 */
export type AccountUndoableEvent = Omit<UndoableEvent, 'locationId' | 'ownerAccountId'> & {
  locationId: null;
  ownerAccountId: string;
};

export type AccountUndoArgs = Omit<UndoArgs, 'event' | 'role' | 'audit'> & {
  event: AccountUndoableEvent;
  /** Writes the undo's account-level audit row: actor, request id, account and `undo_of` are
   * filled in. Call it once. */
  audit: (
    event: Omit<
      AuditEventInput,
      'actor' | 'requestId' | 'undoOf' | 'locationId' | 'ownerAccountId' | 'subjects'
    >,
  ) => Promise<AuditResult>;
};

export type AccountUndoHandler = (args: AccountUndoArgs) => Promise<void>;

const HANDLERS = new Map<string, UndoHandler>();
const ACCOUNT_HANDLERS = new Map<string, AccountUndoHandler>();

/** Registers the handler for an account-level `action` (e.g. `fx_rate.set`). One per action. */
export function registerAccountUndo(action: string, handler: AccountUndoHandler): void {
  if (ACCOUNT_HANDLERS.has(action) && ACCOUNT_HANDLERS.get(action) !== handler) {
    throw new Error(`account undo handler for ${action} is already registered`);
  }
  ACCOUNT_HANDLERS.set(action, handler);
}

/** Registers the handler for `action` (e.g. `place.update`). One handler per action. */
export function registerUndo(action: string, handler: UndoHandler): void {
  if (HANDLERS.has(action) && HANDLERS.get(action) !== handler) {
    throw new Error(`undo handler for ${action} is already registered`);
  }
  HANDLERS.set(action, handler);
}

/** The actions with a handler (for tests and the docs). */
export function undoableActions(): string[] {
  return [...HANDLERS.keys()].sort();
}

/** How long a change stays undoable: 7 days (D150), less a margin for the clock between this
 * process and Postgres, whose now() kept.guard_audit_event() compares against. */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

/** `undoableUntil` for an audited() call that should be undoable. */
export const undoableUntil = (now: number = Date.now()): Date => new Date(now + UNDO_WINDOW_MS);

export type UndoRefusal = 'changed_since' | 'already_undone' | 'expired' | 'not_undoable';

/** 409 `undo_refused` with its `reason` (see the header) and any extra fields. */
export function undoRefused(
  reason: UndoRefusal,
  hint: string,
  extra: Record<string, unknown> = {},
): AppError {
  return new AppError('undo_refused', 409, hint, { reason, ...extra });
}

/** The refusal for an event that can't be undone at all (a handler's "not this one"). */
export const notUndoable = (hint = "This change can't be undone."): AppError =>
  undoRefused('not_undoable', hint);

/**
 * The refusal when something changed since the event (D124): 409 `undo_refused`
 * `changed_since`, naming the fields and, when known, who changed them:
 * `{reason, field, conflicts, changedBy: {displayName}}`.
 */
export function undoConflict(fields: readonly string[], changedBy?: string | null): AppError {
  const who = changedBy ? `${changedBy} changed` : 'Someone changed';
  const what = fields.length > 0 ? fields.join(', ') : 'it';
  return undoRefused('changed_since', `Can't undo: ${who} ${what} since.`, {
    ...(fields[0] ? { field: fields[0] } : {}),
    conflicts: [...fields],
    ...(changedBy ? { changedBy: { displayName: changedBy } } : {}),
  });
}

/** A handler's plain 409 `conflict` as the route answers it: `changed_since`, hint kept. */
function asRefusal(err: unknown): unknown {
  if (!(err instanceof AppError) || err.code !== 'conflict' || err.status !== 409) return err;
  const conflicts = Array.isArray(err.extra?.conflicts) ? (err.extra.conflicts as string[]) : [];
  return undoRefused('changed_since', err.hint ?? "Can't undo: it changed since.", {
    ...(err.extra ?? {}),
    ...(conflicts[0] ? { field: conflicts[0] } : {}),
    conflicts,
  });
}

/** Whether a stored diff holds a secret-class field: never undoable (screens §8). */
export const holdsSecret = (diff: UndoableEvent['diff'] | null | undefined): boolean =>
  Object.values(diff ?? {}).some((c) => c.class === 'secret');

/** The display name of whoever wrote the latest event about an entity after `since` (the one
 * that got in the way of an undo, or of an If-Match). Null when unknown. */
export async function lastChangedBy(
  client: pg.ClientBase,
  locationId: string,
  entity: { type: string; id: string },
  since?: Date,
): Promise<string | null> {
  const { rows } = await client.query<{ display_name: string | null }>(
    `SELECT up.display_name
       FROM public.audit_events e
       LEFT JOIN public.user_profiles up ON up.user_id = e.actor_id AND e.actor_type = 'user'
      WHERE e.location_id = $1 AND e.entity_type = $2 AND e.entity_id = $3
        AND ($4::timestamptz IS NULL OR e.at > $4::timestamptz)
      ORDER BY e.at DESC, e.id DESC LIMIT 1`,
    [locationId, entity.type, entity.id, since ?? null],
  );
  return rows[0]?.display_name ?? null;
}

/** Fields of `diff` whose `after` no longer matches `current` (deep, as JSON). */
export function changedSince(
  diff: UndoableEvent['diff'],
  current: Readonly<Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const [field, change] of Object.entries(diff)) {
    if (!('after' in change)) {
      out.push(field);
      continue;
    }
    const now = current[field] ?? null;
    if (!isDeepStrictEqual(json(now), json(change.after ?? null))) out.push(field);
  }
  return out;
}

const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

type EventRow = {
  id: string;
  at: Date;
  location_id: string | null;
  owner_account_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  root_thing_id: string | null;
  diff: UndoableEvent['diff'] | null;
  undoable_until: Date | null;
};

const Params = z.object({ eventId: z.uuid() });
const UndoResult = z.object({ undoOf: z.uuid(), eventId: z.uuid() });

/**
 * Whether the caller made the event: as themself, or (step 6, D58) through one of their own
 * tokens, which "Recent changes by connections" offers them to undo. A token's own request
 * counts only that token's events.
 */
async function madeByCaller(
  client: pg.PoolClient,
  scope: Scope,
  e: Pick<EventRow, 'actor_type' | 'actor_id'>,
): Promise<boolean> {
  if (!e.actor_id) return false;
  if (e.actor_type === 'user') return !scope.tokenId && e.actor_id === scope.userId;
  if (e.actor_type !== 'token') return false;
  if (scope.tokenId) return e.actor_id === scope.tokenId.toLowerCase();
  // api_tokens' policy shows a user their own tokens only.
  const { rowCount } = await client.query('SELECT 1 FROM public.api_tokens WHERE id = $1', [
    e.actor_id,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Runs one undo in the caller's transaction; returns the new event's id. */
export async function undoEvent(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  eventId: string,
  requestId: string,
  deps: UndoDeps,
): Promise<{ undoOf: string; eventId: string }> {
  // One undo of an event at a time: a second waits here, then sees the first's undo row.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kept.undo:${eventId}`]);
  const { rows } = await client.query<EventRow>(
    `SELECT id, at, location_id, owner_account_id, actor_type, actor_id, action, entity_type,
            entity_id, root_thing_id, diff, undoable_until
       FROM public.audit_events WHERE id = $1`,
    [eventId],
  );
  const e = rows[0];
  if (!e) throw notFound();
  if (!e.location_id) return undoAccountEvent(tx, client, scope, e, requestId, deps);
  const { role } = await requireMembership(client, e.location_id);
  const mine = await madeByCaller(client, scope, e);
  // A connection undoes only what it did itself (step-6 plan T10), whatever its creator's role.
  if (scope.tokenId && !mine) {
    throw forbidden('A connection can undo only its own changes.');
  }
  if (!mine && role !== 'owner' && role !== 'admin') {
    throw forbidden('Only the person who made a change, or an owner or admin, can undo it.');
  }
  if (!can(role, 'things.edit')) throw forbidden();
  const handler = HANDLERS.get(e.action);
  if (!handler || !e.undoable_until || holdsSecret(e.diff)) throw notUndoable();
  if (e.undoable_until.getTime() <= Date.now()) {
    throw undoRefused('expired', 'Too late to undo this: changes can be undone for 7 days.');
  }
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.audit_events WHERE undo_of = $1 AND location_id = $2',
    [e.id, e.location_id],
  );
  if (rowCount) throw undoRefused('already_undone', 'This change was already undone.');

  const event: UndoableEvent = {
    id: e.id,
    at: e.at,
    locationId: e.location_id,
    ownerAccountId: e.owner_account_id,
    actorType: e.actor_type,
    actorId: e.actor_id,
    action: e.action,
    entityType: e.entity_type,
    entityId: e.entity_id,
    rootThingId: e.root_thing_id,
    diff: e.diff ?? {},
    undoableUntil: e.undoable_until,
  };
  let written: AuditResult | null = null;
  // The database knows this transaction undoes `event` (0056): a row the handler re-inserts keeps
  // who made it (kept.undo_keep_creator), and a file the event held links again even when the
  // person undoing can't see it (kept.undo_holds_file). Transaction-local; cleared after.
  await client.query(`SELECT set_config('app.undo', $1, true)`, [event.id]);
  const run = handler({
    tx,
    client,
    scope,
    event,
    role,
    requestId,
    deps,
    audit: async (input) => {
      if (written) throw new Error('undo: args.audit() called twice');
      written = await audited(tx, {
        ...input,
        locationId: event.locationId,
        actor: actorOf(scope),
        requestId,
        undoOf: event.id,
      });
      return written;
    },
  });
  await run.catch((err: unknown) => {
    throw asRefusal(err);
  });
  await client.query(`SELECT set_config('app.undo', '', true)`);
  const done = written as AuditResult | null;
  if (!done) throw new Error(`undo handler for ${e.action} wrote no audit row`);
  return { undoOf: e.id, eventId: done.id };
}

/**
 * An account-level event's undo (step 4, T8: exchange rates). Only actions registered with
 * registerAccountUndo() have one; any other account-level event (a registry's) stays a 404 here,
 * as before. The caller must be an owner or admin of the account; the checks after that are the
 * location path's.
 */
async function undoAccountEvent(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  e: EventRow,
  requestId: string,
  deps: UndoDeps,
): Promise<{ undoOf: string; eventId: string }> {
  const handler = ACCOUNT_HANDLERS.get(e.action);
  const accountId = e.owner_account_id;
  // Account-level changes are never a connection's (D180).
  if (!handler || !accountId || scope.tokenId) throw notFound();
  const { rows: admin } = await client.query<{ ok: boolean }>(
    'SELECT $1::uuid IN (SELECT kept.admin_account_ids()) AS ok',
    [accountId],
  );
  if (!admin[0]?.ok) throw forbidden('Only owners and admins can undo changes to the account.');
  if (!e.undoable_until || holdsSecret(e.diff)) throw notUndoable();
  if (e.undoable_until.getTime() <= Date.now()) {
    throw undoRefused('expired', 'Too late to undo this: changes can be undone for 7 days.');
  }
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.audit_events
      WHERE undo_of = $1 AND location_id IS NULL AND owner_account_id = $2`,
    [e.id, accountId],
  );
  if (rowCount) throw undoRefused('already_undone', 'This change was already undone.');

  const event: AccountUndoableEvent = {
    id: e.id,
    at: e.at,
    locationId: null,
    ownerAccountId: accountId,
    actorType: e.actor_type,
    actorId: e.actor_id,
    action: e.action,
    entityType: e.entity_type,
    entityId: e.entity_id,
    rootThingId: e.root_thing_id,
    diff: e.diff ?? {},
    undoableUntil: e.undoable_until,
  };
  let written: AuditResult | null = null;
  await handler({
    tx,
    client,
    scope,
    event,
    requestId,
    deps,
    audit: async (input) => {
      if (written) throw new Error('undo: args.audit() called twice');
      written = await audited(tx, {
        ...input,
        locationId: null,
        ownerAccountId: accountId,
        actor: actorOf(scope),
        requestId,
        undoOf: event.id,
      });
      return written;
    },
  }).catch((err: unknown) => {
    throw asRefusal(err);
  });
  const done = written as AuditResult | null;
  if (!done) throw new Error(`undo handler for ${e.action} wrote no audit row`);
  return { undoOf: e.id, eventId: done.id };
}

/** Registers POST /api/v1/audit/:eventId/undo (called from things/routes.ts: the route registry
 * has no module of its own for it, and history/ is T21's). */
export async function undoRoutes(
  app: KeptApp,
  deps: UndoDeps & { pools: Pick<Pools, 'app'> },
): Promise<void> {
  app.post(
    '/api/v1/audit/:eventId/undo',
    { schema: { params: Params, response: { 200: UndoResult } } },
    (req, reply) =>
      scopedWrite(deps.pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await undoEvent(tx, client, scope, req.params.eventId.toLowerCase(), req.id, deps),
      })),
  );
}
