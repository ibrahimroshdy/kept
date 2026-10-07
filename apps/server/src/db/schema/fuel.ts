import { FUEL_UNITS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, tstz } from './common.js';
import { currencies } from './currencies.js';
import { vendors } from './registries.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Fuel and charging (step-5 plan T6; engineering spec §1.6, §7.13; D28, D170; plan Q3, Q6, Q7,
// Q11, Q14). A fill or a charge of one thing, in litres, kWh or US gallons, stored as entered
// (D76): its cost, whether it filled up, whether a fill-up was missed before it (no consumption
// across the gap), the station (the account's vendor, D11), and its odometer, a meter_readings row
// (source 'fuel') the fill owns (one owner per reading, Q11). Row-level security, the vendor and
// reading guards and the reading key (ON DELETE SET NULL (meter_reading_id), which drizzle can't
// declare) are in the custom migration that follows (0065).

// The units aren't a textEnum: `L` and `kWh` are as printed at the pump (D76), not snake case.
const units = sql.raw(FUEL_UNITS.map((u) => `'${u}'`).join(', '));

export const fuelEntries = pgTable(
  'fuel_entries',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    thingId: uuid('thing_id').notNull(),
    takenAt: tstz('taken_at').notNull(),
    amount: numeric('amount', { precision: 10, scale: 3 }).notNull(),
    unit: text('unit', { enum: FUEL_UNITS }).notNull(),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    cost: numeric('cost', { precision: 16, scale: 4 }),
    /** §1.6 calls it `full`; FULL is a reserved word. A charge's "full" is the usual full (Q6). */
    isFull: boolean('is_full').notNull().default(true),
    /** D170: a fill-up was missed before this one, so no consumption across the gap. */
    missedBefore: boolean('missed_before').notNull().default(false),
    /** The station (D11), the location's account's; guarded in 0065. */
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    /** Its odometer (source 'fuel'), made with it and changed through it (Q11). */
    meterReadingId: uuid('meter_reading_id'),
    note: text('note'),
    loggedBy: uuid('logged_by').notNull(),
    ...mutable(),
  },
  (t) => [
    unique('fuel_entries_location_id_uq').on(t.locationId, t.id),
    check('fuel_entries_amount_chk', sql`amount > 0`),
    check('fuel_entries_unit_chk', sql`unit IN (${units})`),
    check('fuel_entries_cost_chk', sql`cost >= 0`),
    // §7.13: a cost and its currency are null together.
    check('fuel_entries_money_chk', sql`(cost IS NULL) = (currency IS NULL)`),
    check('fuel_entries_note_chk', sql`char_length(note) <= 500`),
    foreignKey({
      name: 'fuel_entries_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('fuel_entries_thing_idx').on(t.thingId, t.takenAt),
    index('fuel_entries_vendor_idx').on(t.vendorId),
    uniqueIndex('fuel_entries_reading_uq')
      .on(t.meterReadingId)
      .where(sql`meter_reading_id IS NOT NULL`),
  ],
);
