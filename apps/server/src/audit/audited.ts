import { isDeepStrictEqual } from 'node:util';
import { newId } from '@kept/shared';
import { type SQL, sql } from 'drizzle-orm';
import { type ACTOR_TYPES, auditEventSubjects, auditEvents } from '../db/schema/index.js';
import type { Tx } from '../db/scope.js';
import { queueWebhookFanout } from '../webhooks/fanout.js';
import { CACHE_COLUMNS, classOf, type FieldClass } from './classes.js';

// audited(): the one way a write records itself (engineering spec §7.5, D110, D188).
//
// Called inside the request's withScope() transaction, so the event commits or rolls back with
// the write it describes. kept_app may only INSERT audit rows (migration 0006), so nothing here
// reads back: the id is generated here and `at` is the transaction's own clock, truncated to
// milliseconds, written into the event and each subject row by the same expression (now() is
// fixed for the whole transaction, so the two always agree, which the subjects' composite
// foreign key requires).

export type ActorType = (typeof ACTOR_TYPES)[number];

export type AuditActor = { type: ActorType; id: string | null };

/** One field's change as stored. */
export type StoredChange =
  | { before: unknown; after: unknown; class: 'plain' | 'money' }
  | { changed: true; class: 'secret' };

export type AuditDiff = Record<string, StoredChange>;

export type AuditEventInput = {
  /** The location the event belongs to; null for account-level (or instance-level) events. */
  locationId: string | null;
  /** Filled from the location when omitted. Pass it for account-level events (§7.13). */
  ownerAccountId?: string | null;
  actor: AuditActor;
  /** `<entity>.<verb>`, e.g. `location.update`. */
  action: string;
  entity: { type: string; id?: string | null };
  /** The row before the write (null or omitted for a create) and after it (null for a delete).
   * Top-level keys may be camelCase (Drizzle rows) or snake_case; the diff stores snake_case. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Per-call classes for fields the static map can't know (custom fields). Raise only. */
  fieldClasses?: Record<string, FieldClass>;
  /** Things the event touched, fanned out to audit_event_subjects (D45). */
  subjects?: readonly string[];
  rootThingId?: string | null;
  requestId?: string | null;
  undoOf?: string | null;
  undoableUntil?: Date | null;
};

export type AuditResult = { id: string; diff: AuditDiff };

// The undoable events a transaction wrote, for the `x-kept-audit-event` response header
// (http/write.ts): the id the web's Undo toast sends to POST /api/v1/audit/:eventId/undo. Keyed
// by the transaction's Drizzle handle, which withScope() makes fresh for each transaction, so
// the list is gone with it.
const UNDOABLE = new WeakMap<object, { id: string; entity: string }[]>();

/** The event's undo window, or null: a diff holding a secret-class field is never undoable
 * (screens §8, plan T20), whatever the writer asked for. */
function windowOf(event: AuditEventInput, diff: AuditDiff): Date | null {
  if (!event.undoableUntil) return null;
  return Object.values(diff).some((c) => c.class === 'secret') ? null : event.undoableUntil;
}

function noteUndoable(tx: Tx, id: string, event: AuditEventInput, until: Date | null): void {
  if (!until) return;
  const list = UNDOABLE.get(tx) ?? [];
  list.push({ id, entity: `${event.entity.type}:${event.entity.id ?? ''}` });
  UNDOABLE.set(tx, list);
}

/**
 * The undoable events `tx` has written, one per entity (the first written: a move across
 * locations writes the same change in both, and either undoes it), in write order.
 */
export function undoableEventIds(tx: Tx): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of UNDOABLE.get(tx) ?? []) {
    if (seen.has(e.entity)) continue;
    seen.add(e.entity);
    out.push(e.id);
  }
  return out;
}

/** Columns every mutable row carries; they change on every write and say nothing. Cache
 * columns (§7.9) are recomputed by triggers and never audited either. */
const BOOKKEEPING = new Set([
  'created_at',
  'updated_at',
  'row_version',
  'change_seq',
  ...CACHE_COLUMNS,
]);

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A value as JSON will hold it, so the equality check compares what would be stored. */
function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonValue(v)]),
    );
  }
  return value;
}

function normalise(row: Record<string, unknown> | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row ?? {})) {
    const name = snake(key);
    if (!BOOKKEEPING.has(name)) out.set(name, jsonValue(value));
  }
  return out;
}

/** The field-level diff of two row images: changed top-level fields only, deep-compared. */
export function diffRows(
  entityType: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fieldClasses: Record<string, FieldClass> = {},
): AuditDiff {
  const a = normalise(before);
  const b = normalise(after);
  const diff: AuditDiff = {};
  for (const field of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(field) ?? null;
    const now = b.get(field) ?? null;
    if (isDeepStrictEqual(was, now)) continue;
    const cls = classOf(entityType, field, fieldClasses[field] ?? fieldClasses[snake(field)]);
    diff[field] =
      cls === 'secret'
        ? { changed: true, class: 'secret' }
        : { before: was, after: now, class: cls };
  }
  return diff;
}

const AT: SQL = sql`date_trunc('milliseconds', now())`;

export async function audited(tx: Tx, event: AuditEventInput): Promise<AuditResult> {
  const subjects = [...new Set(event.subjects ?? [])];
  if (subjects.length > 0 && !event.locationId) {
    throw new Error('audited: subjects need a location (audit_event_subjects.location_id)');
  }
  const id = newId();
  const diff = diffRows(event.entity.type, event.before, event.after, event.fieldClasses);

  // §7.13: an event carries its location's owner account. Read under kept_app's own policies:
  // a location it can't see yields NULL here and the insert policy refuses the row anyway.
  const ownerAccountId =
    event.ownerAccountId !== undefined
      ? event.ownerAccountId
      : event.locationId
        ? sql`(SELECT l.owner_account_id FROM public.locations l WHERE l.id = ${event.locationId})`
        : null;

  await tx.insert(auditEvents).values({
    id,
    at: AT as unknown as Date,
    locationId: event.locationId,
    ownerAccountId: ownerAccountId as string | null,
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    entityType: event.entity.type,
    entityId: event.entity.id ?? null,
    rootThingId: event.rootThingId ?? null,
    diff,
    requestId: event.requestId ?? null,
    undoOf: event.undoOf ?? null,
    undoableUntil: windowOf(event, diff),
  });

  if (subjects.length > 0) {
    await tx.insert(auditEventSubjects).values(
      subjects.map((thingId) => ({
        eventId: id,
        eventAt: AT as unknown as Date,
        locationId: event.locationId as string,
        thingId,
      })),
    );
  }
  noteUndoable(tx, id, event, windowOf(event, diff));
  // Step 6 (Q18, T15): a location webhook listening for this event hears of it, on this
  // transaction, so a write that rolls back sends nothing (webhooks/fanout.ts).
  await queueWebhookFanout(tx, [{ id, locationId: event.locationId, action: event.action }]);
  return { id, diff };
}

/** Rows per INSERT in auditedMany() (Postgres takes at most 65,535 parameters a statement). */
const BATCH_ROWS = 2000;

/**
 * audited() for many events of one request at once (a bulk move of 200 things, T15): the same
 * rows, written with one INSERT per table instead of two per event. Returns the results in the
 * order of `events`.
 */
export async function auditedMany(
  tx: Tx,
  events: readonly AuditEventInput[],
): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  const rows: (typeof auditEvents.$inferInsert)[] = [];
  const subjectRows: (typeof auditEventSubjects.$inferInsert)[] = [];
  for (const event of events) {
    const subjects = [...new Set(event.subjects ?? [])];
    if (subjects.length > 0 && !event.locationId) {
      throw new Error('audited: subjects need a location (audit_event_subjects.location_id)');
    }
    const id = newId();
    const diff = diffRows(event.entity.type, event.before, event.after, event.fieldClasses);
    const ownerAccountId =
      event.ownerAccountId !== undefined
        ? event.ownerAccountId
        : event.locationId
          ? sql`(SELECT l.owner_account_id FROM public.locations l WHERE l.id = ${event.locationId})`
          : null;
    rows.push({
      id,
      at: AT as unknown as Date,
      locationId: event.locationId,
      ownerAccountId: ownerAccountId as string | null,
      actorType: event.actor.type,
      actorId: event.actor.id,
      action: event.action,
      entityType: event.entity.type,
      entityId: event.entity.id ?? null,
      rootThingId: event.rootThingId ?? null,
      diff,
      requestId: event.requestId ?? null,
      undoOf: event.undoOf ?? null,
      undoableUntil: windowOf(event, diff),
    });
    for (const thingId of subjects) {
      subjectRows.push({
        eventId: id,
        eventAt: AT as unknown as Date,
        locationId: event.locationId as string,
        thingId,
      });
    }
    results.push({ id, diff });
  }
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    await tx.insert(auditEvents).values(rows.slice(i, i + BATCH_ROWS));
  }
  for (let i = 0; i < subjectRows.length; i += BATCH_ROWS * 2) {
    await tx.insert(auditEventSubjects).values(subjectRows.slice(i, i + BATCH_ROWS * 2));
  }
  events.forEach((event, i) => {
    const r = results[i] as AuditResult;
    noteUndoable(tx, r.id, event, windowOf(event, r.diff));
  });
  await queueWebhookFanout(
    tx,
    events.map((event, i) => ({
      id: (results[i] as AuditResult).id,
      locationId: event.locationId,
      action: event.action,
    })),
  );
  return results;
}
