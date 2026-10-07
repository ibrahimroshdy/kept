import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { changeXid, id, mutable, tstz } from './common.js';
import { locations } from './tenancy.js';

/** The place tree (§1.3, §7.14; D45, D118, D160). Step 2 adds icon, sort, the place-kind
 * fields in `custom`, `trash_batch_id` (what was trashed together, D162) and `created_by`.
 *
 * Parent consistency (§7.13): places expose UNIQUE (location_id, id) and a child's parent is a
 * composite foreign key on (location_id, parent_id), so a parent is always in the same
 * location and a cross-location move carries `location_id` down (ON UPDATE CASCADE). Loops
 * and trashing or re-parenting the Unplaced area are refused by triggers. */
export const places = pgTable(
  'places',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    kindKey: text('kind_key').notNull().default('room'),
    isUnplaced: boolean('is_unplaced').notNull().default(false),
    /** `lucide:<name>` / `tabler:<name>` / `kept:<name>`; NULL shows the kind's icon. */
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    /** Values of the place kind's fields (D160), by key. Secret fields never land here. */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
    deletedAt: tstz('deleted_at'),
    /** Places and things trashed in one action share it, so they are restored together (D162). */
    trashBatchId: uuid('trash_batch_id'),
    /** Who created it (not a foreign key: history outlives the user). */
    createdBy: uuid('created_by'),
    ...mutable(),
    changeXid: changeXid(),
  },
  (t) => [
    unique('places_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'places_parent_fk',
      columns: [t.locationId, t.parentId],
      foreignColumns: [t.locationId, t.id],
    })
      .onUpdate('cascade')
      // NO ACTION, not RESTRICT (plan Q12): the same guarantee at statement end, and a purged
      // location's cascade can delete a parent and its children in one statement.
      .onDelete('no action'),
    // One Unplaced area per location (D118).
    uniqueIndex('places_one_unplaced_uq').on(t.locationId).where(sql`is_unplaced`),
    // The Unplaced area is top level.
    check('places_unplaced_top_level_chk', sql`NOT is_unplaced OR parent_id IS NULL`),
    check('places_not_own_parent_chk', sql`parent_id IS NULL OR parent_id <> id`),
    check('places_custom_chk', sql`jsonb_typeof(custom) = 'object'`),
    check('places_icon_chk', sql`icon IS NULL OR icon ~ '^(lucide|tabler|kept):[a-z0-9-]+$'`),
    index('places_parent_idx').on(t.locationId, t.parentId),
    // The purge walks trashed places oldest first, across locations (kept.purge_trash()).
    index('places_trash_purge_idx').on(t.deletedAt, t.id).where(sql`deleted_at IS NOT NULL`),
    // The snapshot's per-location read from a watermark (step-3 plan Q1).
    index('places_sync_idx').on(t.locationId, t.changeXid),
  ],
);
