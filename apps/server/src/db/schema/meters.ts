import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { things } from './things.js';

// Core meters and readings (engineering spec §1.6, §7.13; D26, D52, D112, D113, moved to step 2
// by D185). A meter belongs to one thing, in its location (composite foreign keys, ON UPDATE
// CASCADE: a move carries meters and readings along). A thing with a meter has quantity 1 (D10,
// kept.guard_thing_quantity()). Row-level security is in 0018; see src/db/meters.test.ts.

export const METER_KINDS = ['distance', 'hours', 'custom'] as const;
const meterKind = textEnum('kind', METER_KINDS);
export const READING_SOURCES = [
  'manual',
  'photo',
  'fuel',
  'service',
  'import',
  'home_assistant',
] as const;
const readingSource = textEnum('source', READING_SOURCES);
export const READING_STATES = ['accepted', 'needs_review'] as const;
const readingState = textEnum('state', READING_STATES);
export const METER_EVENT_KINDS = ['replaced'] as const;
const meterEventKind = textEnum('kind', METER_EVENT_KINDS);

export const meters = pgTable(
  'meters',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id').notNull(),
    kind: meterKind.col().notNull(),
    /** Shown, never converted (D113). */
    unit: text('unit').notNull(),
    label: text('label'),
    /** Added to a reading's value: what the meter showed before it was replaced (D52). */
    offset: numeric('offset', { precision: 14, scale: 3 }).notNull().default('0'),
    /** Readings implying more than this per day need review (D26: a car, 1,500 km). */
    maxPerDay: numeric('max_per_day', { precision: 14, scale: 3 }),
    /** The stale-reading nudge, in days after the latest reading (step 5; D52, §3.4, Q19); null
     * for none. The `reading_stale` source of the agenda reads it. */
    nudgeDays: integer('nudge_days').default(30),
    ...mutable(),
  },
  (t) => [
    meterKind.check('meters'),
    unique('meters_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'meters_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('meters_unit_chk', sql`char_length(unit) BETWEEN 1 AND 12`),
    check('meters_label_chk', sql`label IS NULL OR char_length(label) BETWEEN 1 AND 80`),
    check('meters_max_per_day_chk', sql`max_per_day IS NULL OR max_per_day > 0`),
    check('meters_nudge_days_chk', sql`nudge_days IS NULL OR nudge_days BETWEEN 7 AND 365`),
    index('meters_thing_idx').on(t.thingId),
  ],
);

export const meterReadings = pgTable(
  'meter_readings',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    meterId: uuid('meter_id').notNull(),
    value: numeric('value', { precision: 14, scale: 3 }).notNull(),
    takenAt: tstz('taken_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    source: readingSource.col().notNull().default('manual'),
    loggedBy: uuid('logged_by'),
    state: readingState.col().notNull().default('accepted'),
    reviewReason: text('review_reason'),
    note: text('note'),
    ...mutable(),
  },
  (t) => [
    readingSource.check('meter_readings'),
    readingState.check('meter_readings'),
    unique('meter_readings_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'meter_readings_meter_fk',
      columns: [t.locationId, t.meterId],
      foreignColumns: [meters.locationId, meters.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('meter_readings_value_chk', sql`value >= 0`),
    check('meter_readings_note_chk', sql`char_length(note) <= 500`),
    check('meter_readings_review_reason_chk', sql`char_length(review_reason) <= 200`),
    index('meter_readings_meter_taken_idx').on(t.meterId, t.takenAt),
  ],
);

export const meterEvents = pgTable(
  'meter_events',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    meterId: uuid('meter_id').notNull(),
    kind: meterEventKind.col().notNull(),
    at: tstz('at').notNull(),
    /** The offset in force from `at` on. */
    offset: numeric('offset', { precision: 14, scale: 3 }).notNull(),
    ...mutable(),
  },
  (t) => [
    meterEventKind.check('meter_events'),
    foreignKey({
      name: 'meter_events_meter_fk',
      columns: [t.locationId, t.meterId],
      foreignColumns: [meters.locationId, meters.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('meter_events_meter_idx').on(t.meterId, t.at),
  ],
);
