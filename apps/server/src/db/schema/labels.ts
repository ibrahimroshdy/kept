import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';
import { shortIds } from './things.js';

// Label batches (step-3 plan T7; D44, D97, D137, D175, D185). One print job: which codes, on
// which stock, from which cell. Row-level security, the blank-label cap, blank claims and
// duplicate merges are in the custom migration that follows (0042); see src/db/labels.test.ts
// and src/db/merge-things.test.ts.

export const LABEL_BATCH_KINDS = ['things', 'places', 'blank'] as const;
const batchKind = textEnum('kind', LABEL_BATCH_KINDS);

export const labelBatches = pgTable(
  'label_batches',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    kind: batchKind.col().notNull(),
    /** A `LABEL_STOCKS` key (@kept/shared label-stocks.ts). */
    stock: text('stock').notNull(),
    startCell: integer('start_cell').notNull().default(1),
    codeCount: integer('code_count').notNull(),
    createdBy: uuid('created_by').notNull(),
    /** "Printed OK?" answered yes. */
    printedConfirmedAt: tstz('printed_confirmed_at'),
    ...mutable(),
  },
  (t) => [
    batchKind.check('label_batches'),
    unique('label_batches_location_id_uq').on(t.locationId, t.id),
    check('label_batches_stock_chk', sql`stock ~ '^[a-z0-9_]{1,40}$'`),
    check('label_batches_start_cell_chk', sql`start_cell BETWEEN 1 AND 200`),
    check('label_batches_code_count_chk', sql`code_count BETWEEN 1 AND 1000`),
    index('label_batches_location_idx').on(t.locationId, t.createdAt),
  ],
);

/** The codes of a batch, in print order. Short IDs are never deleted, so neither side cascades
 * from the code. Never updated. */
export const labelBatchCodes = pgTable(
  'label_batch_codes',
  {
    batchId: uuid('batch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    code: char('code', { length: 6 })
      .notNull()
      .references(() => shortIds.code, { onDelete: 'no action' }),
    sort: integer('sort').notNull(),
  },
  (t) => [
    primaryKey({ name: 'label_batch_codes_pk', columns: [t.batchId, t.code] }),
    foreignKey({
      name: 'label_batch_codes_batch_fk',
      columns: [t.locationId, t.batchId],
      foreignColumns: [labelBatches.locationId, labelBatches.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('label_batch_codes_code_idx').on(t.code),
  ],
);
