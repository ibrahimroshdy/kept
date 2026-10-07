import { SERVICE_LINE_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, REVIEW_STATES, textEnum } from './common.js';
import { currencies } from './currencies.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Service records (step-4 plan T5, Q1; engineering spec §1.6, §7.13; D26, D29, D113): the core
// tables and their lines, for any thing or place. Completing a schedule links a record to it
// (service_completions, T6). Step 5 adds the vehicle side (invoice extraction into lines, fuel);
// step 7 the consumables. Row-level security and the vendor guard are in the custom migration
// that follows (0051); the reading key is ON DELETE SET NULL (meter_reading_id), there too.

const lineKind = textEnum('kind', SERVICE_LINE_KINDS);
// Step 5 (Q12): an invoice attached for AI makes a draft; drafts count nowhere until confirmed.
const reviewState = textEnum('review_state', REVIEW_STATES);

/** A service done on one thing or one place, with its reading, vendor and total. */
export const serviceRecords = pgTable(
  'service_records',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    servicedOn: date('serviced_on').notNull(),
    meterReadingId: uuid('meter_reading_id'),
    /** The account's vendor registry (D11), guarded in 0051. */
    vendorId: uuid('vendor_id'),
    total: numeric('total', { precision: 16, scale: 4 }),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    notes: text('notes'),
    loggedBy: uuid('logged_by').notNull(),
    /** A draft (an invoice being read by AI, step 5) counts nowhere until it is confirmed. */
    reviewState: reviewState.col().notNull().default('confirmed'),
    ...mutable(),
  },
  (t) => [
    reviewState.check('service_records'),
    unique('service_records_location_id_uq').on(t.locationId, t.id),
    check('service_records_subject_chk', sql`num_nonnulls(thing_id, place_id) = 1`),
    check('service_records_money_chk', sql`(total IS NULL) = (currency IS NULL)`),
    check('service_records_total_chk', sql`total >= 0`),
    check('service_records_notes_chk', sql`char_length(notes) <= 5000`),
    foreignKey({
      name: 'service_records_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'service_records_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('service_records_thing_idx').on(t.thingId, t.servicedOn),
    index('service_records_place_idx').on(t.placeId, t.servicedOn),
    index('service_records_reading_idx').on(t.meterReadingId),
    index('service_records_vendor_idx').on(t.vendorId),
    // Step 5: one owner per reading (Q11), and each person's open drafts.
    uniqueIndex('service_records_reading_uq')
      .on(t.meterReadingId)
      .where(sql`meter_reading_id IS NOT NULL`),
    index('service_records_drafts_idx')
      .on(t.loggedBy, t.createdAt)
      .where(sql`review_state = 'draft'`),
  ],
);

/** A part, labour, fluid or other line of a service record (§1.6). */
export const serviceLines = pgTable(
  'service_lines',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    serviceRecordId: uuid('service_record_id').notNull(),
    kind: lineKind.col().notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }),
    unitCost: numeric('unit_cost', { precision: 16, scale: 4 }),
    sort: integer('sort').notNull().default(0),
    ...mutable(),
  },
  (t) => [
    lineKind.check('service_lines'),
    check('service_lines_description_chk', sql`char_length(description) BETWEEN 1 AND 300`),
    check('service_lines_quantity_chk', sql`quantity > 0`),
    check('service_lines_unit_cost_chk', sql`unit_cost >= 0`),
    foreignKey({
      name: 'service_lines_record_fk',
      columns: [t.locationId, t.serviceRecordId],
      foreignColumns: [serviceRecords.locationId, serviceRecords.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('service_lines_record_idx').on(t.serviceRecordId, t.sort),
  ],
);
