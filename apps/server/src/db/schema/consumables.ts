import { STOCK_MIN_MAX } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable } from './common.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Consumables (step-7 plan T6; engineering spec §1.6; D14, plan Q19). Row-level security, the
// consumable guard, the grants and the undo's creator are in the custom migration that follows
// (0085); see src/db/consumables.test.ts.

/**
 * "Keep at least N" on one thing whose type is consumable (through its chain,
 * kept.type_capabilities). Low is quantity < min_quantity (@kept/shared isLow). One per thing; its
 * own id, like every undoable row, so an undo re-inserts it under the same id
 * (kept.undo_keep_creator()). `created_by` is not a foreign key: history outlives the user.
 */
export const stockRules = pgTable(
  'stock_rules',
  {
    id: id(),
    thingId: uuid('thing_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    minQuantity: numeric('min_quantity', { precision: 12, scale: 3 }).notNull(),
    /** The location's day the thing last ran low, while it is (0104's triggers keep it, quietly:
     * no row_version or sync change); null while it isn't. The low-stock reminder's key. */
    lowSince: date('low_since'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    unique('stock_rules_thing_uq').on(t.thingId),
    check(
      'stock_rules_min_quantity_chk',
      sql`min_quantity > 0 AND min_quantity <= ${sql.raw(String(STOCK_MIN_MAX))}`,
    ),
    foreignKey({
      name: 'stock_rules_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('stock_rules_location_idx').on(t.locationId),
  ],
);
