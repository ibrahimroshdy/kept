import { LEDGER_TASKS, type LedgerTask, tsQuery } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import {
  type AuditEventRow,
  type AuditViewer,
  crossingOf,
  type FieldLabel,
  type RenderedAuditEvent,
  renderAudit,
} from '../audit/render.js';
import type { Scope, Tx } from '../db/scope.js';
import { CALL_COLUMNS, type CallRow, CallSummary, callSummaryOf } from '../extraction/routes.js';
import { decodeCursor, encodeCursor, PAGE_DEFAULT, PAGE_MAX } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { filterOf, lowerIds, manyOf, matchOf, notOf, When } from '../http/list-filters.js';
import { requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import { type Summary, summarise } from './summary.js';

// History and the activity feed (T21; D76, D110, D150, D174, D183; engineering spec §7.2, §7.5).
//
// Every row is a stored audit event, read as the caller on kept_app, so the audit_events policy
// decides what exists: events of the locations they can see, plus (Q15) the account-level
// registry events of accounts they administer. Each goes through renderAudit() with the caller's
// role, money toggle and Money module *in that event's location* (a viewer in one household and
// an owner in another sees each row as that role), and their visible locations for D183. The
// response is the web contract's HistoryEvent: the rendered event (snake_case), the actor's
// display name, and a summary (history/summary.ts).
//
// - A thing's history is every event about it: its own (`entity_id`, which Q14 keeps across a
//   place/container conversion, so the place-era events stay on it), those rooted at it
//   (`root_thing_id`: its attachments, meters, readings) and those that fanned out to it
//   (`audit_event_subjects`: "moved with Box 3", D45).
// - A place's history is the events about the place itself.
// - A move across locations is written in both (T15), so a viewer who sees both would read it
//   twice: the source's copy is left out whenever the destination's is visible too.

/** Account-level events the activity feed shows (Q15): registry changes, which admins of any
 * location of the account may read. The account owner's other account-level rows (sessions,
 * email changes) are theirs, not activity. */
export const REGISTRY_ENTITIES = [
  'type',
  'type_field',
  'place_kind',
  'brand',
  'vendor',
  'person',
  'tag',
] as const;

// ---------------------------------------------------------------------------------------------
// Response shapes (the serialiser keeps exactly these fields)
// ---------------------------------------------------------------------------------------------

const RenderedChangeSchema = z.object({
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  class: z.enum(['plain', 'money', 'secret']),
  changed: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  label: z.string().optional(),
  labelKey: z.string().optional(),
});

export const HistoryEventSchema = z.object({
  id: z.uuid(),
  at: z.string(),
  location_id: z.uuid().nullable(),
  action: z.string(),
  actor: z.object({
    type: z.string(),
    id: z.uuid().nullable(),
    displayName: z.string().nullable(),
  }),
  /** `shortCode`: a thing's or place's primary short ID, for its `/t/`/`/p/` address (D208). */
  entity: z.object({ type: z.string(), id: z.uuid().nullable(), shortCode: z.string().nullable() }),
  root_thing_id: z.uuid().nullable(),
  diff: z.record(z.string(), RenderedChangeSchema).nullable(),
  undo_of: z.uuid().nullable(),
  undoable_until: z.string().nullable(),
  summary: z.string(),
  summaryKey: z.string(),
  summaryParams: z.record(z.string(), z.string()),
  movedInFromElsewhere: z.literal(true).optional(),
  /** A thing's history: an event of a thing merged into it (D36), "merged from <name>" (T15). */
  mergedFrom: z.object({ id: z.uuid(), name: z.string().nullable() }).optional(),
  /** Step 6 (T18; D206, §7.15 "Elsewhere"): an AI call about the thing (`action: 'ai.call'`). */
  aiCall: CallSummary.extend({ task: z.enum(LEDGER_TASKS) }).optional(),
});

export type HistoryEvent = Omit<RenderedAuditEvent, 'actor' | 'entity'> &
  Summary & {
    actor: { type: string; id: string | null; displayName: string | null };
    entity: { type: string; id: string | null; shortCode: string | null };
    mergedFrom?: { id: string; name: string | null };
    aiCall?: z.infer<typeof CallSummary> & { task: LedgerTask };
  };

export const HistoryPageSchema = z.object({
  items: z.array(HistoryEventSchema),
  next_cursor: z.string().nullable(),
});

export type HistoryPage = { items: HistoryEvent[]; next_cursor: string | null };

export const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});
export type HistoryQuery = z.infer<typeof HistoryQuery>;

/** A thing's history (step 6, T18): `changes` its audit events only, `ai` its AI calls only;
 * both by default, newest first in one list. */
export const ThingHistoryQuery = HistoryQuery.extend({
  kind: z.enum(['all', 'changes', 'ai']).default('all'),
});
export type ThingHistoryQuery = z.infer<typeof ThingHistoryQuery>;

/** The activity feed's filters that take several values and "is none of" (D205). */
export const ACTIVITY_FILTERS = ['locationId', 'actorId', 'entityType'] as const;

export const ActivityQuery = HistoryQuery.extend({
  locationId: manyOf(z.uuid()).optional(),
  actorId: manyOf(z.uuid()).optional(),
  entityType: manyOf(z.string().regex(/^[a-z][a-z_]{0,39}$/)).optional(),
  not: notOf(ACTIVITY_FILTERS).optional(),
  /** Inclusive. */
  from: When.optional(),
  /** Exclusive. */
  to: When.optional(),
  /** Words in the name of what the event is about, or of who did it (T27 decision). */
  q: z.string().trim().max(200).optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export const ActorSchema = z.object({ id: z.uuid(), displayName: z.string().nullable() });
export const ActorsSchema = z.object({ items: z.array(ActorSchema) });
export type Actor = z.infer<typeof ActorSchema>;

// ---------------------------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------------------------

type EventRecord = {
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
  diff: unknown;
  request_id: string | null;
  undo_of: string | null;
  undoable_until: Date | null;
  display_name: string | null;
};

const EVENT_COLUMNS = `e.id, e.at, e.location_id, e.owner_account_id, e.actor_type, e.actor_id,
  e.action, e.entity_type, e.entity_id, e.root_thing_id, e.diff, e.request_id, e.undo_of,
  e.undoable_until, up.display_name`;

const ACTOR_JOIN = `LEFT JOIN public.user_profiles up
  ON e.actor_type = 'user' AND up.user_id = e.actor_id`;

/** The source location's copy of a cross-location move, when the destination's copy is also
 * visible (the policy already hides whatever isn't). */
const NOT_A_SECOND_COPY = `NOT (e.action = 'thing.move' AND e.diff ? 'location_id'
  AND e.location_id::text = e.diff->'location_id'->>'before'
  AND (e.diff->'location_id'->>'after') IN (SELECT v::text FROM kept.visible_location_ids() v))`;

type Key = [string, string];

class Where {
  readonly parts: string[] = [];
  readonly values: unknown[] = [];
  add(sql: (next: (value: unknown) => string) => string): void {
    this.parts.push(
      sql((value) => {
        this.values.push(value);
        return `$${this.values.length}`;
      }),
    );
  }
}

function afterKey(cursor: string | undefined): Key | null {
  if (!cursor) return null;
  const key = decodeCursor<unknown>(cursor);
  if (
    !Array.isArray(key) ||
    key.length !== 2 ||
    typeof key[0] !== 'string' ||
    Number.isNaN(Date.parse(key[0])) ||
    typeof key[1] !== 'string' ||
    !z.uuid().safeParse(key[1]).success
  ) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  return [key[0], key[1]];
}

/** One page of events matching `where`, newest first. */
async function eventsPage(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  where: Where,
  page: { limit: number; cursor?: string | undefined },
): Promise<HistoryPage> {
  const after = afterKey(page.cursor);
  if (after) where.add((v) => `(e.at, e.id) < (${v(after[0])}::timestamptz, ${v(after[1])}::uuid)`);
  where.add(() => NOT_A_SECOND_COPY);
  where.values.push(page.limit + 1);
  const { rows } = await client.query<EventRecord>(
    `SELECT ${EVENT_COLUMNS}
       FROM public.audit_events e ${ACTOR_JOIN}
      WHERE ${where.parts.join(' AND ')}
      ORDER BY e.at DESC, e.id DESC
      LIMIT $${where.values.length}`,
    where.values,
  );
  const shown = rows.slice(0, page.limit);
  const items = await renderEvents(tx, client, scope, shown);
  const last = shown.at(-1);
  return {
    items,
    next_cursor:
      rows.length > page.limit && last ? encodeCursor([last.at.toISOString(), last.id]) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const rowOf = (r: EventRecord): AuditEventRow => ({
  id: r.id,
  at: r.at,
  locationId: r.location_id,
  ownerAccountId: r.owner_account_id,
  actorType: r.actor_type as AuditEventRow['actorType'],
  actorId: r.actor_id,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  rootThingId: r.root_thing_id,
  diff: r.diff,
  requestId: r.request_id,
  undoOf: r.undo_of,
  undoableUntil: r.undoable_until,
});

/** Nobody's money, nothing but "changed": what an event is rendered with when the caller's
 * standing in its location can't be read (fail closed). */
const CLOSED: AuditViewer = { role: 'viewer', moneyVisibleToViewers: false, moneyModule: false };

async function visibleLocations(client: pg.ClientBase): Promise<Set<string>> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT v AS id FROM kept.visible_location_ids() v',
  );
  return new Set(rows.map((r) => r.id));
}

/** The caller as a viewer of each location's events. */
async function viewersOf(
  tx: Tx,
  scope: Scope,
  locationIds: Iterable<string>,
  visible: ReadonlySet<string>,
): Promise<Map<string, AuditViewer>> {
  const out = new Map<string, AuditViewer>();
  for (const id of new Set(locationIds)) {
    try {
      const gate = await gateFor(tx, id, scope);
      out.set(id, {
        role: gate.role,
        moneyVisibleToViewers: gate.moneyVisibleToViewers,
        moneyModule: gate.modules.has('money'),
        visibleLocationIds: visible,
      });
    } catch {
      out.set(id, { ...CLOSED, visibleLocationIds: visible });
    }
  }
  return out;
}

const hasCustom = (diff: unknown): boolean =>
  !!diff &&
  typeof diff === 'object' &&
  Object.keys(diff).some((k) => k.startsWith('custom.') || k.startsWith('archived_custom.'));

/** Field labels by thing (its type chain, nearest definition first) and by place (its kind). */
async function labelsOf(
  client: pg.ClientBase,
  thingIds: string[],
  placeIds: string[],
): Promise<Map<string, Map<string, FieldLabel>>> {
  const out = new Map<string, Map<string, FieldLabel>>();
  const put = (owner: string, key: string, label: string | null) => {
    let byKey = out.get(owner);
    if (!byKey) {
      byKey = new Map();
      out.set(owner, byKey);
    }
    if (!byKey.has(key)) byKey.set(key, { label, labelKey: label === null ? key : null });
  };
  if (thingIds.length > 0) {
    const { rows } = await client.query<{ owner: string; key: string; label: string | null }>(
      `SELECT t.id AS owner, f.key, f.label
         FROM public.things t
         CROSS JOIN LATERAL kept.type_chain(t.type_id) ch
         JOIN public.types ty ON ty.id = ch.id
         JOIN public.type_fields f ON f.type_id = ty.id OR f.type_id = ANY (ty.field_groups)
        WHERE t.id = ANY ($1::uuid[]) AND t.type_id IS NOT NULL
        ORDER BY t.id, ch.depth, (f.type_id = ty.id) DESC,
                 array_position(ty.field_groups, f.type_id)`,
      [thingIds],
    );
    for (const r of rows) put(r.owner, r.key, r.label);
  }
  if (placeIds.length > 0) {
    const { rows } = await client.query<{ owner: string; key: string; label: string | null }>(
      `SELECT p.id AS owner, f.key, f.label
         FROM public.places p
         JOIN public.locations l ON l.id = p.location_id
         CROSS JOIN LATERAL (
           SELECT k.id FROM public.place_kinds k
            WHERE k.key = p.kind_key
              AND (k.owner_account_id = l.owner_account_id OR k.owner_account_id IS NULL)
            ORDER BY k.owner_account_id NULLS LAST LIMIT 1) k
         JOIN public.type_fields f ON f.place_kind_id = k.id
        WHERE p.id = ANY ($1::uuid[])`,
      [placeIds],
    );
    for (const r of rows) put(r.owner, r.key, r.label);
  }
  return out;
}

const NAME_SOURCES: Record<string, string> = {
  thing: 'public.things',
  place: 'public.places',
  brand: 'public.brands',
  vendor: 'public.vendors',
  tag: 'public.tags',
};

/** Current names of what the events are about, as the caller may see them. */
async function namesOf(
  client: pg.ClientBase,
  events: readonly EventRecord[],
): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>();
  const want = (type: string, id: string | null) => {
    if (!id || !(type in NAME_SOURCES || type === 'person')) return;
    let ids = wanted.get(type);
    if (!ids) {
      ids = new Set();
      wanted.set(type, ids);
    }
    ids.add(id);
  };
  for (const e of events) {
    if (e.root_thing_id) want('thing', e.root_thing_id);
    want(e.entity_type, e.entity_id);
  }
  const out = new Map<string, string>();
  for (const [type, ids] of wanted) {
    const table = NAME_SOURCES[type];
    const sql = table
      ? `SELECT id, name FROM ${table} WHERE id = ANY ($1::uuid[]) AND name IS NOT NULL`
      : 'SELECT id, display_name AS name FROM public.people WHERE id = ANY ($1::uuid[])';
    const { rows } = await client.query<{ id: string; name: string }>(sql, [[...ids]]);
    for (const r of rows) out.set(`${type}:${r.id}`, r.name);
  }
  return out;
}

/**
 * The primary short IDs of the things and places the events are about, as the caller may see
 * them (short_ids is under the locations' policies), by `<type>:<id>`: the rows link to the short
 * address, not the UUID the page would replace on arrival (D208).
 */
async function shortCodesOf(
  client: pg.ClientBase,
  events: readonly EventRecord[],
): Promise<Map<string, string>> {
  const of = (type: string) => [
    ...new Set(events.flatMap((e) => (e.entity_type === type && e.entity_id ? [e.entity_id] : []))),
  ];
  const things = of('thing');
  const places = of('place');
  if (things.length === 0 && places.length === 0) return new Map();
  const { rows } = await client.query<{ key: string; code: string }>(
    `SELECT CASE WHEN s.thing_id IS NOT NULL THEN 'thing:' || s.thing_id
                 ELSE 'place:' || s.place_id END AS key, s.code
       FROM public.short_ids s
      WHERE (s.thing_id = ANY ($1::uuid[]) OR s.place_id = ANY ($2::uuid[]))
        AND s.is_primary AND s.state = 'assigned'`,
    [things, places],
  );
  return new Map(rows.map((r) => [r.key, r.code]));
}

/** The thing whose fields name an event's custom entries, if it is about one. */
const subjectThing = (e: EventRecord): string | null =>
  e.entity_type === 'thing' ? e.entity_id : e.root_thing_id;

/**
 * The names of the tokens that made `events` (UI review steps 6–8, L3), by token id: the caller's
 * own token by its name ("Claude Desktop"), another member's as "Louis (Claude Desktop)". Through
 * kept.token_actor_names (0105): tokens are their creator's alone under the policies, so the
 * history's actor join finds none; the door names only tokens seen acting in a location the
 * caller sees. A token reading history gets no names (null, which the web reads as "Kept").
 */
async function tokenActorsOf(
  client: pg.ClientBase,
  scope: Scope,
  events: readonly EventRecord[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(events.flatMap((e) => (e.actor_type === 'token' && e.actor_id ? [e.actor_id] : []))),
  ];
  if (ids.length === 0) return new Map();
  const { rows } = await client.query<{
    id: string;
    name: string;
    owner_id: string;
    owner_name: string | null;
  }>('SELECT id, name, owner_id, owner_name FROM kept.token_actor_names($1::uuid[])', [ids]);
  return new Map(
    rows.map((r) => [
      r.id,
      r.owner_id === scope.userId || !r.owner_name ? r.name : `${r.owner_name} (${r.name})`,
    ]),
  );
}

async function renderEvents(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  events: readonly EventRecord[],
): Promise<HistoryEvent[]> {
  if (events.length === 0) return [];
  const visible = await visibleLocations(client);
  const viewers = await viewersOf(
    tx,
    scope,
    events.flatMap((e) => (e.location_id ? [e.location_id] : [])),
    visible,
  );
  const labelled = events.filter((e) => hasCustom(e.diff));
  const labels = await labelsOf(
    client,
    [
      ...new Set(labelled.flatMap((e) => (e.entity_type === 'place' ? [] : [subjectThing(e)]))),
    ].filter((id): id is string => !!id),
    [
      ...new Set(
        labelled.flatMap((e) => (e.entity_type === 'place' && e.entity_id ? [e.entity_id] : [])),
      ),
    ],
  );
  const names = await namesOf(client, events);
  const codes = await shortCodesOf(client, events);
  const tokens = await tokenActorsOf(client, scope, events);

  return events.map((e) => {
    const row = rowOf(e);
    // Account-level registry events carry no money; render them closed all the same.
    const viewer = e.location_id
      ? (viewers.get(e.location_id) ?? { ...CLOSED, visibleLocationIds: visible })
      : { ...CLOSED, visibleLocationIds: visible };
    const owner = e.entity_type === 'place' ? e.entity_id : subjectThing(e);
    const byKey = owner ? labels.get(owner) : undefined;
    const rendered = renderAudit(row, viewer, { labelOf: (key) => byKey?.get(key) });
    const movedOut = crossingOf(row, visible) === 'out';
    const name =
      movedOut || rendered.movedInFromElsewhere
        ? null
        : (names.get(`${e.entity_type}:${e.entity_id}`) ??
          (e.root_thing_id ? names.get(`thing:${e.root_thing_id}`) : undefined) ??
          null);
    return {
      ...rendered,
      actor: {
        ...rendered.actor,
        displayName:
          e.actor_type === 'token' ? (tokens.get(e.actor_id ?? '') ?? null) : e.display_name,
      },
      entity: {
        ...rendered.entity,
        // Gone to a location the reader can't see: no address to offer beyond the id.
        shortCode: movedOut ? null : (codes.get(`${e.entity_type}:${e.entity_id}`) ?? null),
      },
      ...summarise(rendered, { name, movedOut }),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------------------------

/** GET /api/v1/things/:id/history: 404 unless the caller can see the thing (trashed or not). */
export async function thingHistory(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  thingId: string,
  query: HistoryQuery & { kind?: ThingHistoryQuery['kind'] },
): Promise<HistoryPage> {
  const { rows: found } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.things WHERE id = $1',
    [thingId],
  );
  const thing = found[0];
  if (!thing) throw notFound();
  // Things merged into this one (D36, plan Q16), however many times over: their events are its
  // history too, each labelled "merged from <name>" (T15).
  const { rows: merged } = await client.query<{ id: string; name: string | null }>(
    `WITH RECURSIVE m(id) AS (
       SELECT t.id FROM public.things t WHERE t.merged_into_id = $1
       UNION
       SELECT t.id FROM public.things t JOIN m ON t.merged_into_id = m.id)
     SELECT t.id, t.name FROM m JOIN public.things t ON t.id = m.id`,
    [thingId],
  );
  const ids = [thingId, ...merged.map((r) => r.id)];
  const kind = query.kind ?? 'all';
  const changes: HistoryPage =
    kind === 'ai'
      ? { items: [], next_cursor: null }
      : await thingChanges(tx, client, scope, thingId, ids, merged, query);
  if (kind === 'changes') return changes;
  return withAiCalls(tx, client, scope, thing.location_id, ids, changes, query);
}

/** A thing's audit events (and its merged things', labelled). */
async function thingChanges(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  thingId: string,
  ids: string[],
  merged: { id: string; name: string | null }[],
  query: HistoryQuery,
): Promise<HistoryPage> {
  const where = new Where();
  where.add(
    (v) => `e.location_id IS NOT NULL AND (
      (e.entity_type IN ('thing', 'place') AND e.entity_id = ANY (${v(ids)}::uuid[]))
      OR e.root_thing_id = ANY (${v(ids)}::uuid[])
      OR EXISTS (SELECT 1 FROM public.audit_event_subjects s
                  WHERE s.event_id = e.id AND s.event_at = e.at
                    AND s.thing_id = ANY (${v(ids)}::uuid[])))`,
  );
  const page = await eventsPage(tx, client, scope, where, query);
  if (merged.length === 0 || page.items.length === 0) return page;

  // An event about this thing itself (the merge included) carries no label.
  const names = new Map(merged.map((r) => [r.id, r.name]));
  const { rows: subjects } = await client.query<{ event_id: string; thing_id: string }>(
    `SELECT s.event_id, s.thing_id FROM public.audit_event_subjects s
      WHERE s.event_id = ANY ($1::uuid[]) AND s.thing_id = ANY ($2::uuid[])`,
    [page.items.map((e) => e.id), ids],
  );
  const about = new Map<string, string[]>();
  for (const s of subjects) about.set(s.event_id, [...(about.get(s.event_id) ?? []), s.thing_id]);
  for (const e of page.items) {
    const touched = [
      e.entity.type === 'thing' || e.entity.type === 'place' ? e.entity.id : null,
      e.root_thing_id,
      ...(about.get(e.id) ?? []),
    ];
    if (touched.includes(thingId)) continue;
    const from = touched.find((id): id is string => !!id && names.has(id));
    if (from) e.mergedFrom = { id: from, name: names.get(from) ?? null };
  }
  return page;
}

/** One AI ledger row about a thing, as its history shows it. */
type AiCallRecord = CallRow & {
  at_ms: Date;
  task: LedgerTask;
  user_id: string | null;
  location_id: string | null;
  caller_name: string | null;
};

/**
 * Step 6 (T18; D206, §7.15 "Elsewhere"): the thing's AI calls merged into its history, newest
 * first under the same (at, id) cursor. A call is the thing's when the ledger row names it
 * (`thing_id`: an embedding, an assistant step about it) or comes from an extraction of it, its
 * photos or its meters' proof. Read through llm_calls' own policy, so a person sees the calls
 * they made or paid for, and admins and owners their locations' (§7.15); the cost follows the
 * money gate unless the caller paid. Ledger rows never hold a prompt (D206), so none is shown.
 */
async function withAiCalls(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
  ids: string[],
  changes: HistoryPage,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const after = afterKey(query.cursor);
  const limit = query.limit;
  const { rows } = await client.query<AiCallRecord>(
    `SELECT ${CALL_COLUMNS}, date_trunc('milliseconds', c.at) AS at_ms, c.task, c.user_id,
            c.location_id, (SELECT up2.display_name FROM public.user_profiles up2
                             WHERE up2.user_id = c.user_id) AS caller_name
       FROM public.llm_calls c
       LEFT JOIN public.locations l ON l.id = c.location_id
      WHERE (c.thing_id = ANY ($1::uuid[])
             OR c.extraction_id IN (
               SELECT e.id FROM public.extractions e
                WHERE e.thing_id = ANY ($1::uuid[])
                   OR e.attachment_id IN (SELECT a.id FROM public.attachments a
                                           WHERE a.thing_id = ANY ($1::uuid[]))
                   OR e.meter_id IN (SELECT m.id FROM public.meters m
                                      WHERE m.thing_id = ANY ($1::uuid[]))))
        AND ($2::timestamptz IS NULL
             OR (date_trunc('milliseconds', c.at), c.id) < ($2::timestamptz, $3::uuid))
      ORDER BY date_trunc('milliseconds', c.at) DESC, c.id DESC
      LIMIT $4`,
    [ids, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  if (rows.length === 0) return changes;
  const gate = await gateFor(tx, locationId, scope);
  const calls: HistoryEvent[] = [];
  for (const r of rows) {
    const call = callSummaryOf(
      { ...r, location_name: r.location_name ?? '' },
      gate.showMoney,
      scope.userId,
    );
    if (!call || !r.call_id) continue;
    calls.push({
      id: r.call_id,
      at: r.at_ms.toISOString(),
      location_id: r.location_id,
      action: 'ai.call',
      actor: { type: r.user_id ? 'user' : 'system', id: r.user_id, displayName: r.caller_name },
      entity: { type: 'llm_call', id: r.call_id, shortCode: null },
      root_thing_id: ids[0] ?? null,
      diff: null,
      undo_of: null,
      undoable_until: null,
      summary: 'AI call',
      summaryKey: 'ai.call',
      summaryParams: { task: r.task },
      aiCall: { ...call, task: r.task },
    });
  }
  const merged = [...changes.items, ...calls].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1,
  );
  const items = merged.slice(0, limit);
  const more = merged.length > limit || changes.next_cursor !== null || rows.length > limit;
  const last = items.at(-1);
  return { items, next_cursor: more && last ? encodeCursor([last.at, last.id]) : null };
}

/** GET /api/v1/places/:id/history: 404 unless the caller can see the place (trashed or not). */
export async function placeHistory(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  placeId: string,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const { rowCount } = await client.query('SELECT 1 FROM public.places WHERE id = $1', [placeId]);
  if (!rowCount) throw notFound();
  const where = new Where();
  where.add(
    (v) => `e.location_id IS NOT NULL
      AND e.entity_type IN ('place', 'thing') AND e.entity_id = ${v(placeId)}::uuid`,
  );
  return eventsPage(tx, client, scope, where, query);
}

/** GET /api/v1/activity: everything the caller can see, newest first (D174). */
export async function activity(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  query: ActivityQuery,
): Promise<HistoryPage> {
  const where = new Where();
  // Each filter "is any of" its values or "is none of" them (D205, http/list-filters.ts). Every
  // location named either way must be one the caller can see (404, review #36).
  const locationIds = lowerIds(query.locationId);
  for (const id of locationIds) await requireMembership(client, id);
  const location = filterOf(locationIds, 'locationId', query.not);
  if (location && !location.not) {
    where.add((v) => `e.location_id = ANY (${v(location.values)}::uuid[])`);
  } else {
    where.add(
      (v) => `(e.location_id IS NOT NULL
               OR e.entity_type = ANY (${v([...REGISTRY_ENTITIES])}::text[]))`,
    );
    // "None of": the other locations' events, and the account-level registry events, which
    // belong to no location.
    if (location) {
      where.add((v) => matchOf(`e.location_id = ANY (${v(location.values)}::uuid[])`, true));
    }
  }
  const actor = filterOf(lowerIds(query.actorId), 'actorId', query.not);
  if (actor) {
    where.add((v) =>
      matchOf(`e.actor_type = 'user' AND e.actor_id = ANY (${v(actor.values)}::uuid[])`, actor.not),
    );
  }
  const entityType = filterOf(query.entityType, 'entityType', query.not);
  if (entityType) {
    where.add((v) =>
      matchOf(`e.entity_type = ANY (${v(entityType.values)}::text[])`, entityType.not),
    );
  }
  if (query.from) {
    const from = query.from;
    where.add((v) => `e.at >= ${v(from)}::timestamptz`);
  }
  if (query.to) {
    const to = query.to;
    where.add((v) => `e.at < ${v(to)}::timestamptz`);
  }
  if (query.q) {
    const terms = tsQuery(query.q);
    if (terms) {
      // The name of what it is about (the thing, or the place), or of who did it; matched the
      // way search matches names (D42: normalised, prefix per word).
      // The matching things, places and people are resolved once, as id arrays the planner
      // evaluates before the scan (uncorrelated ARRAY subqueries), and the events filtered by id
      // (security review #32): matching names per event made a busy location's feed cost a
      // name normalisation per event and per name.
      where.add((v) => {
        const tq = `to_tsquery('simple', ${v(terms)})`;
        const named = (expr: string) =>
          `to_tsvector('simple', kept.search_text(coalesce(${expr}, ''))) @@ ${tq}`;
        return `(
          coalesce(e.root_thing_id, CASE WHEN e.entity_type = 'thing' THEN e.entity_id END)
            = ANY (ARRAY(SELECT t.id FROM public.things t WHERE ${named('t.name')}))
          OR (e.entity_type = 'place'
              AND e.entity_id = ANY (ARRAY(SELECT p.id FROM public.places p
                                            WHERE ${named('p.name')})))
          OR (e.actor_type = 'user'
              AND e.actor_id = ANY (ARRAY(SELECT u.user_id FROM public.user_profiles u
                                           WHERE ${named('u.display_name')}))))`;
      });
    }
  }
  return eventsPage(tx, client, scope, where, query);
}

/**
 * GET /api/v1/connections/changes (step 6, T10; D58): the events `tokenIds` made, newest first,
 * rendered as any other history row. The caller passes only their own tokens' ids; the audit
 * policy still decides which events exist for them (a location they've left drops out).
 */
export async function tokenActivity(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  tokenIds: readonly string[],
  query: HistoryQuery,
): Promise<HistoryPage> {
  if (tokenIds.length === 0) return { items: [], next_cursor: null };
  const where = new Where();
  where.add((v) => `e.actor_type = 'token' AND e.actor_id = ANY (${v([...tokenIds])}::uuid[])`);
  return eventsPage(tx, client, scope, where, query);
}

/** GET /api/v1/locations/:id/actors: who has changed anything in a location (the activity
 * feed's person filter; T27 decision). A former member whose profile the caller can no longer
 * read is listed with a null name. */
export async function locationActors(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ items: Actor[] }> {
  await requireMembership(client, locationId);
  const { rows } = await client.query<{ id: string; display_name: string | null }>(
    `SELECT a.actor_id AS id, up.display_name
       FROM (SELECT DISTINCT e.actor_id FROM public.audit_events e
              WHERE e.location_id = $1 AND e.actor_type = 'user' AND e.actor_id IS NOT NULL) a
       LEFT JOIN public.user_profiles up ON up.user_id = a.actor_id
      ORDER BY up.display_name NULLS LAST, a.actor_id`,
    [locationId],
  );
  return { items: rows.map((r) => ({ id: r.id, displayName: r.display_name })) };
}
