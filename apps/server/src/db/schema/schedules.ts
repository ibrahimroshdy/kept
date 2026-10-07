import { DOCUMENT_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { currencies } from './currencies.js';
import { meters } from './meters.js';
import { places } from './places.js';
import { serviceRecords } from './services.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Schedules, their completions and expiring documents (step-4 plan T6; engineering spec §1.6,
// §7.13; D26, D29, D39, D52, D146, D155, D162, D172; plan Q2, Q27, Q28, Q31). Row-level
// security, the anchor's recomputation, module state in SQL, kept.schedule_next() and the agenda
// view are in the custom migration that follows (0053); see src/db/schedules.test.ts and
// src/db/agenda.test.ts.

const documentKind = textEnum('kind', DOCUMENT_KINDS);

/**
 * Something to do on a thing or a place: every N months and/or every N units of the thing's
 * meter, whichever comes first, or once on a date (D146). The anchor is where the interval counts
 * from: the latest completing service's date and reading, else `base_on`/`base_value`, what the
 * schedule was made with (a last-done date, or its creation day). The anchor is kept by
 * kept.recompute_schedule_anchor() (D162), never written by a request: no column grant. A snooze
 * replaces the due point until the next completion; skipping moves it one interval on (Q28).
 */
export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    name: text('name').notNull(),
    everyMonths: integer('every_months'),
    everyUnits: numeric('every_units', { precision: 14, scale: 3 }),
    meterId: uuid('meter_id'),
    /** A one-off date, when there is no interval (D146). */
    dueOn: date('due_on'),
    leadDays: integer('lead_days').notNull().default(14),
    /** Units before a unit due point; null is 10% of `every_units` (§3.4, Q9). */
    leadUnits: numeric('lead_units', { precision: 14, scale: 3 }),
    /** What the schedule was made with (or later told): a last-done date and reading, else its
     * creation day. Filled from `anchor_on`/`anchor_value` on insert when not given (0053). */
    baseOn: date('base_on').notNull(),
    baseValue: numeric('base_value', { precision: 14, scale: 3 }),
    anchorOn: date('anchor_on').notNull(),
    anchorValue: numeric('anchor_value', { precision: 14, scale: 3 }),
    snoozedUntil: date('snoozed_until'),
    snoozedUntilValue: numeric('snoozed_until_value', { precision: 14, scale: 3 }),
    skipNext: boolean('skip_next').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    unique('schedules_location_id_uq').on(t.locationId, t.id),
    check('schedules_name_chk', sql`char_length(name) BETWEEN 1 AND 120`),
    check('schedules_every_months_chk', sql`every_months BETWEEN 1 AND 600`),
    check('schedules_every_units_chk', sql`every_units > 0`),
    check('schedules_lead_days_chk', sql`lead_days BETWEEN 0 AND 365`),
    check('schedules_lead_units_chk', sql`lead_units >= 0`),
    check('schedules_subject_chk', sql`num_nonnulls(thing_id, place_id) = 1`),
    // screens §7: an interval in months or units, or a date.
    check('schedules_rule_chk', sql`num_nonnulls(every_months, every_units, due_on) >= 1`),
    check('schedules_meter_chk', sql`(every_units IS NULL) = (meter_id IS NULL)`),
    check('schedules_meter_thing_chk', sql`meter_id IS NULL OR thing_id IS NOT NULL`),
    check(
      'schedules_one_off_chk',
      sql`due_on IS NULL OR (every_months IS NULL AND every_units IS NULL)`,
    ),
    foreignKey({
      name: 'schedules_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'schedules_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'schedules_meter_fk',
      columns: [t.locationId, t.meterId],
      foreignColumns: [meters.locationId, meters.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('schedules_thing_idx').on(t.thingId),
    index('schedules_place_idx').on(t.placeId),
    index('schedules_location_idx').on(t.locationId).where(sql`active`),
  ],
);

/** A service record completing a schedule (D29, D113): its date and reading become the anchor. */
export const serviceCompletions = pgTable(
  'service_completions',
  {
    locationId: uuid('location_id').notNull(),
    serviceRecordId: uuid('service_record_id').notNull(),
    scheduleId: uuid('schedule_id').notNull(),
    /** When the record completed the schedule (logged confirmed, or confirmed from a draft): what
     * closes a reminder opened before it (reminders/scan.ts COMPLETED_SINCE). */
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'service_completions_pk', columns: [t.serviceRecordId, t.scheduleId] }),
    foreignKey({
      name: 'service_completions_record_fk',
      columns: [t.locationId, t.serviceRecordId],
      foreignColumns: [serviceRecords.locationId, serviceRecords.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'service_completions_schedule_fk',
      columns: [t.locationId, t.scheduleId],
      foreignColumns: [schedules.locationId, schedules.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('service_completions_schedule_idx').on(t.scheduleId),
  ],
);

/**
 * A document that expires, on a thing, a place or (both null) the location itself (D155): a
 * registration, an insurance policy, a lease. Renewing it adds the new one and points the old one
 * at it (`superseded_by_id`, ON DELETE SET NULL (col) in 0053), so the old one is kept (D172).
 * `title` names it, and is required for `other` (Q31).
 */
export const expiringDocuments = pgTable(
  'expiring_documents',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    kind: documentKind.col().notNull(),
    title: text('title'),
    expiresOn: date('expires_on').notNull(),
    leadDays: integer('lead_days').notNull().default(30),
    supersededById: uuid('superseded_by_id'),
    /** Step 5 (Q5): when it was issued or renewed; its cost counts in that month ("Fees &
     * insurance"). */
    issuedOn: date('issued_on'),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    cost: numeric('cost', { precision: 16, scale: 4 }),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    documentKind.check('expiring_documents'),
    check(
      'expiring_documents_cost_chk',
      sql`(cost IS NULL) = (currency IS NULL) AND (cost IS NULL OR cost >= 0)`,
    ),
    check('expiring_documents_issued_chk', sql`issued_on IS NULL OR issued_on <= expires_on`),
    unique('expiring_documents_location_id_uq').on(t.locationId, t.id),
    check('expiring_documents_title_chk', sql`char_length(title) BETWEEN 1 AND 120`),
    check('expiring_documents_lead_days_chk', sql`lead_days BETWEEN 0 AND 365`),
    check('expiring_documents_subject_chk', sql`num_nonnulls(thing_id, place_id) <= 1`),
    check('expiring_documents_other_chk', sql`kind <> 'other' OR title IS NOT NULL`),
    check('expiring_documents_superseded_chk', sql`superseded_by_id IS DISTINCT FROM id`),
    foreignKey({
      name: 'expiring_documents_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'expiring_documents_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('expiring_documents_expires_idx').on(t.expiresOn).where(sql`superseded_by_id IS NULL`),
    index('expiring_documents_location_idx').on(t.locationId),
    index('expiring_documents_thing_idx').on(t.thingId),
    index('expiring_documents_place_idx').on(t.placeId),
  ],
);
