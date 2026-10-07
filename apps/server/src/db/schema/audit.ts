import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { textEnum, tstz } from './common.js';

// The audit log (§1.10, §7.5, §7.13). Append-only: no row_version, no updates from kept_app.

export const ACTOR_TYPES = ['user', 'token', 'system', 'import'] as const;
const actorType = textEnum('actor_type', ACTOR_TYPES);

/** Partitioned by RANGE (`at`), monthly (§7.13). Drizzle can't declare partitioning: the
 * generated CREATE TABLE was edited to add `PARTITION BY RANGE ("at")`, and the partitions
 * themselves are made in the tenancy triggers migration. Hence the primary key includes `at`.
 *
 * Scope (§1.1, §7.13): `location_id` for location events; `owner_account_id` alone for
 * account-level events. No foreign keys to locations: history outlives what it describes until
 * retention removes it. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    // Millisecond precision: `at` is half of the key, and a JS Date (which a caller reads it
    // back into, then uses in audit_event_subjects) holds milliseconds, not microseconds.
    at: tstz('at').notNull().default(sql`date_trunc('milliseconds', now())`),
    locationId: uuid('location_id'),
    ownerAccountId: uuid('owner_account_id'),
    actorType: actorType.col().notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    rootThingId: uuid('root_thing_id'),
    diff: jsonb('diff'),
    requestId: text('request_id'),
    undoOf: uuid('undo_of'),
    undoableUntil: tstz('undoable_until'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.at] }),
    actorType.check('audit_events'),
    // audit_event_subjects' foreign key: a subject is always in its event's location.
    unique('audit_events_id_at_location_uq').on(t.id, t.at, t.locationId),
    index('audit_events_entity_idx').on(t.locationId, t.entityType, t.entityId, t.at.desc()),
    index('audit_events_location_at_idx').on(t.locationId, t.at.desc()),
    index('audit_events_actor_idx').on(t.actorType, t.actorId, t.at),
    // A thing's history reads the events rooted at it (its attachments, meters, readings), newest
    // first. Most events have no root thing, hence partial. Declared on the partitioned parent:
    // Postgres builds it on every partition and on each one created later.
    index('audit_events_root_thing_idx')
      .on(t.rootThingId, t.at.desc())
      .where(sql`root_thing_id IS NOT NULL`),
    // Account-level events (no location), read by account through the kept_app SELECT policy.
    index('audit_events_account_at_idx')
      .on(t.ownerAccountId, t.at.desc())
      .where(sql`location_id IS NULL`),
  ],
);

/** Fans an event out to every thing it touched ("moved with Box 3", D45). Carries its event's
 * `location_id` (L15: child tables carry their scope, so RLS never needs a join); the composite
 * foreign key keeps the two in agreement. */
export const auditEventSubjects = pgTable(
  'audit_event_subjects',
  {
    eventId: uuid('event_id').notNull(),
    eventAt: tstz('event_at').notNull(),
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.eventAt, t.thingId] }),
    foreignKey({
      name: 'audit_event_subjects_event_fk',
      columns: [t.eventId, t.eventAt, t.locationId],
      foreignColumns: [auditEvents.id, auditEvents.at, auditEvents.locationId],
    }).onDelete('cascade'),
    index('audit_event_subjects_thing_idx').on(t.thingId),
  ],
);
