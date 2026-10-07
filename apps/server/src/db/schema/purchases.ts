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
  uuid,
} from 'drizzle-orm/pg-core';
import { CREATED_VIA, id, mutable, REVIEW_STATES, textEnum } from './common.js';
import { currencies } from './currencies.js';
import { vendors } from './registries.js';
import { locations } from './tenancy.js';

// Purchases and their lines (engineering spec §1.4, §7.13; D13, D115, D136, D168; plan Q2).
// Money is numeric(16,4) with a currency (a foreign key to currencies), stored as received and
// rounded only at the edges. Things point at a line through things.purchase_line_id (a split
// keeps the same line; a move keeps it too, D115). Row-level security and the guards are in the
// custom migration that follows (0018); see src/db/purchases.test.ts.

const reviewState = textEnum('review_state', REVIEW_STATES);
const createdVia = textEnum('created_via', CREATED_VIA);

export const purchases = pgTable(
  'purchases',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    /** NULL only on a draft (a RECEIPT capture before its date is read or typed; plan Q10). */
    purchasedOn: date('purchased_on'),
    currency: char('currency', { length: 3 }).references(() => currencies.code),
    total: numeric('total', { precision: 16, scale: 4 }),
    tax: numeric('tax', { precision: 16, scale: 4 }),
    notes: text('notes'),
    reviewState: reviewState.col().notNull().default('confirmed'),
    createdVia: createdVia.col().notNull().default('app'),
    createdBy: uuid('created_by'),
    ...mutable(),
  },
  (t) => [
    reviewState.check('purchases'),
    createdVia.check('purchases'),
    unique('purchases_location_id_uq').on(t.locationId, t.id),
    check('purchases_dated_chk', sql`purchased_on IS NOT NULL OR review_state = 'draft'`),
    check('purchases_total_chk', sql`total >= 0`),
    check('purchases_tax_chk', sql`tax >= 0`),
    check('purchases_money_chk', sql`(total IS NULL AND tax IS NULL) OR currency IS NOT NULL`),
    check('purchases_notes_chk', sql`char_length(notes) <= 5000`),
    index('purchases_location_date_idx').on(t.locationId, t.purchasedOn),
    index('purchases_vendor_idx').on(t.vendorId),
  ],
);

export const purchaseLines = pgTable(
  'purchase_lines',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    purchaseId: uuid('purchase_id').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
    /** In the purchase's currency. */
    unitPrice: numeric('unit_price', { precision: 16, scale: 4 }),
    sort: integer('sort').notNull().default(0),
    ...mutable(),
  },
  (t) => [
    unique('purchase_lines_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'purchase_lines_purchase_fk',
      columns: [t.locationId, t.purchaseId],
      foreignColumns: [purchases.locationId, purchases.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('purchase_lines_description_chk', sql`char_length(description) BETWEEN 1 AND 300`),
    check('purchase_lines_quantity_chk', sql`quantity > 0`),
    check('purchase_lines_unit_price_chk', sql`unit_price >= 0`),
    index('purchase_lines_purchase_idx').on(t.purchaseId),
  ],
);
