import { CONDITIONS, LIFECYCLES, LINK_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CREATED_VIA, changeXid, id, mutable, REVIEW_STATES, textEnum, tstz } from './common.js';
import { currencies } from './currencies.js';
import { places } from './places.js';
import { purchaseLines } from './purchases.js';
import { brands, people, tags, types } from './registries.js';
import { locations } from './tenancy.js';

export { CREATED_VIA, REVIEW_STATES } from './common.js';

// Things, short IDs, links and tag assignments (engineering spec §1.3, amended by §7.9 and
// §7.13; D10, D45, D76, D112, D119, D120, D158, D160, D183). Row-level security, the guards,
// the search and path caches and the expression indexes are in the custom migration that follows
// (0016); see src/db/things.test.ts.

/** Postgres full-text vector; written only by kept.thing_cache(). */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const lifecycle = textEnum('lifecycle', LIFECYCLES);
const condition = textEnum('condition', CONDITIONS);
const reviewState = textEnum('review_state', REVIEW_STATES);
const createdVia = textEnum('created_via', CREATED_VIA);

/**
 * A thing sits in exactly one place or one container (another thing), always in its own
 * location (composite foreign keys, ON UPDATE CASCADE: a cross-location move carries its
 * contents). Cache columns (§7.9, D183): `place_path` and `search_tsv` bump nothing,
 * `last_seen_at` bumps change_seq only (kept.touch_row('place_path,search_tsv','last_seen_at')).
 * Money (`ended_price`) never enters `search_tsv` or `place_path`.
 */
export const things = pgTable(
  'things',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id'),
    containerId: uuid('container_id'),
    typeId: uuid('type_id').references(() => types.id, { onDelete: 'no action' }),
    /** NULL only for a draft (review_state 'draft'). */
    name: text('name'),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    model: text('model'),
    serial: text('serial'),
    barcode: text('barcode'),
    colour: text('colour'),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
    condition: condition.col(),
    notes: text('notes'),
    /** `{lang: [alias, …]}`, e.g. `{"ar": ["شاحن"]}`. */
    aliases: jsonb('aliases').notNull().default(sql`'{}'::jsonb`),
    belongsToPersonId: uuid('belongs_to_person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    /** The purchase line it came from; kept across moves (D115), cleared if the line goes. */
    purchaseLineId: uuid('purchase_line_id'),
    manualUrl: text('manual_url'),
    expiresOn: date('expires_on'),
    expiryLeadDays: integer('expiry_lead_days'),
    lifecycle: lifecycle.col().notNull().default('in_use'),
    endedOn: date('ended_on'),
    endedPrice: numeric('ended_price', { precision: 16, scale: 4 }),
    endedCurrency: char('ended_currency', { length: 3 }).references(() => currencies.code),
    endedTo: text('ended_to'),
    endedNotes: text('ended_notes'),
    acquiredFrom: text('acquired_from'),
    provenanceNotes: text('provenance_notes'),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    locationUncertain: boolean('location_uncertain').notNull().default(false),
    /** The type's field values by key (never secret ones, never money outside `{amount, currency}`). */
    custom: jsonb('custom').notNull().default(sql`'{}'::jsonb`),
    /** Values of fields the type no longer has (a type change or an archived field, D92). */
    archivedCustom: jsonb('archived_custom').notNull().default(sql`'{}'::jsonb`),
    fieldStatus: jsonb('field_status').notNull().default(sql`'{}'::jsonb`),
    reviewState: reviewState.col().notNull().default('confirmed'),
    createdVia: createdVia.col().notNull().default('app'),
    /** Who created it (plan Q22); not a foreign key: history outlives the user. */
    createdBy: uuid('created_by'),
    splitFromId: uuid('split_from_id').references((): AnyPgColumn => things.id, {
      onDelete: 'set null',
    }),
    /** Cache: "Room › Shelf › Box" (kept.thing_cache()). */
    placePath: text('place_path'),
    /** Cache: the search document (kept.thing_cache()). */
    searchTsv: tsvector('search_tsv'),
    deletedAt: tstz('deleted_at'),
    trashBatchId: uuid('trash_batch_id'),
    /** The capture session it came from (step 3, T13): the inbox groups by it and batch undo
     * trashes it. Set at insert only. */
    captureBatchId: uuid('capture_batch_id'),
    /** The survivor this thing was merged into (D36, plan Q16); set only by kept.merge_things(),
     * alongside `deleted_at`. */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => things.id, {
      onDelete: 'set null',
    }),
    /** Cache: the first `photo` attachment's file (D195), kept by kept.refresh_thing_cover().
     * Bumps change_seq (the snapshot sees a new photo), never row_version. Its composite foreign
     * key to files is ON DELETE SET NULL (cover_file_id), which Drizzle can't declare: 0036. */
    coverFileId: uuid('cover_file_id'),
    /** Cache: bumped by kept.touch_thing_meters() when one of its meters is added or changes
     * kind, unit or label, so the snapshot resends the thing with its meters (READING offline).
     * Bumps change_seq, never row_version, as cover_file_id does: 0047. */
    meterVersion: integer('meter_version').notNull().default(0),
    /** Cache: bumped by kept.touch_thing_state() when a loan or claim of it starts, ends or
     * changes whom it is with, so the snapshot resends the thing with its derived states (lent,
     * borrowed, in repair). Bumps change_seq, never row_version, as meter_version does: 0051. */
    stateVersion: integer('state_version').notNull().default(0),
    ...mutable(),
    changeXid: changeXid(),
  },
  (t) => [
    lifecycle.check('things'),
    condition.check('things'),
    reviewState.check('things'),
    createdVia.check('things'),
    unique('things_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'things_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('no action'),
    foreignKey({
      name: 'things_container_fk',
      columns: [t.locationId, t.containerId],
      foreignColumns: [t.locationId, t.id],
    })
      .onUpdate('cascade')
      .onDelete('no action'),
    // Plain, not composite: a moved thing keeps its line in the old location (D115); it is read
    // there through kept.thing_purchase().
    foreignKey({
      name: 'things_purchase_line_fk',
      columns: [t.purchaseLineId],
      foreignColumns: [purchaseLines.id],
    }).onDelete('set null'),
    index('things_purchase_line_idx').on(t.purchaseLineId),
    check('things_one_parent_chk', sql`num_nonnulls(place_id, container_id) = 1`),
    check('things_not_own_container_chk', sql`container_id IS NULL OR container_id <> id`),
    check('things_named_chk', sql`name IS NOT NULL OR review_state = 'draft'`),
    check('things_name_chk', sql`name IS NULL OR char_length(name) BETWEEN 1 AND 200`),
    check('things_model_chk', sql`char_length(model) <= 120`),
    check('things_serial_chk', sql`char_length(serial) <= 100`),
    check('things_barcode_chk', sql`char_length(barcode) <= 64`),
    check('things_colour_chk', sql`char_length(colour) <= 60`),
    check('things_notes_chk', sql`char_length(notes) <= 5000`),
    check('things_manual_url_chk', sql`char_length(manual_url) <= 2000`),
    check('things_ended_to_chk', sql`char_length(ended_to) <= 200`),
    check('things_ended_notes_chk', sql`char_length(ended_notes) <= 5000`),
    check('things_acquired_from_chk', sql`char_length(acquired_from) <= 200`),
    check('things_provenance_notes_chk', sql`char_length(provenance_notes) <= 5000`),
    check('things_quantity_chk', sql`quantity >= 0`),
    check('things_expiry_lead_chk', sql`expiry_lead_days BETWEEN 0 AND 3650`),
    check('things_ended_price_chk', sql`ended_price >= 0`),
    check('things_ended_money_chk', sql`(ended_price IS NULL) = (ended_currency IS NULL)`),
    check(
      'things_in_use_chk',
      sql`lifecycle <> 'in_use' OR (ended_on IS NULL AND ended_price IS NULL AND ended_to IS NULL)`,
    ),
    check('things_aliases_chk', sql`jsonb_typeof(aliases) = 'object'`),
    check('things_custom_chk', sql`jsonb_typeof(custom) = 'object'`),
    check('things_archived_custom_chk', sql`jsonb_typeof(archived_custom) = 'object'`),
    check('things_field_status_chk', sql`jsonb_typeof(field_status) = 'object'`),
    index('things_place_idx').on(t.placeId),
    index('things_container_idx').on(t.containerId),
    index('things_type_idx').on(t.typeId),
    index('things_brand_idx').on(t.brandId),
    index('things_person_idx').on(t.belongsToPersonId),
    index('things_barcode_idx').on(t.locationId, t.barcode),
    index('things_last_seen_idx')
      .on(t.locationId, t.lastSeenAt)
      .where(sql`lifecycle = 'in_use' AND deleted_at IS NULL`),
    index('things_uncertain_idx').on(t.locationId).where(sql`location_uncertain`),
    index('things_draft_idx').on(t.locationId).where(sql`review_state = 'draft'`),
    index('things_expires_idx').on(t.expiresOn).where(sql`expires_on IS NOT NULL`),
    index('things_trash_idx').on(t.locationId, t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    // The purge walks the whole trash oldest first, across locations (kept.purge_trash()).
    index('things_trash_purge_idx').on(t.deletedAt, t.id).where(sql`deleted_at IS NOT NULL`),
    index('things_created_by_idx').on(t.createdBy).where(sql`deleted_at IS NULL`),
    index('things_capture_batch_idx')
      .on(t.createdBy, t.captureBatchId)
      .where(sql`deleted_at IS NULL`),
    // A survivor's history reads the things merged into it (T15).
    index('things_merged_into_idx').on(t.mergedIntoId).where(sql`merged_into_id IS NOT NULL`),
    index('things_sync_idx').on(t.locationId, t.changeXid),
  ],
);

export const SHORT_ID_STATES = ['blank', 'assigned', 'retired'] as const;
const shortIdState = textEnum('state', SHORT_ID_STATES);

/**
 * Permanent short IDs (D45, D112, D120, §7.13): six Crockford base32 characters, unique across
 * the instance and never deleted or reissued. A code whose thing or place is purged becomes a
 * `retired` tombstone that keeps its `location_id` (no foreign key to locations: it outlives a
 * purged location). The (location_id, thing_id|place_id) foreign keys are `ON DELETE SET NULL
 * (col)`, which Drizzle can't declare: they are in 0016.
 */
export const shortIds = pgTable(
  'short_ids',
  {
    code: char('code', { length: 6 }).primaryKey(),
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    state: shortIdState.col().notNull().default('assigned'),
    isPrimary: boolean('is_primary').notNull().default(true),
    printedAt: tstz('printed_at'),
    claimedAt: tstz('claimed_at'),
    claimedBy: uuid('claimed_by'),
    ...mutable(),
    changeXid: changeXid(),
  },
  (t) => [
    shortIdState.check('short_ids'),
    check('short_ids_code_chk', sql`code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'`),
    check(
      'short_ids_target_chk',
      sql`CASE state WHEN 'blank' THEN num_nonnulls(thing_id, place_id) = 0
                     WHEN 'assigned' THEN num_nonnulls(thing_id, place_id) = 1
                     ELSE num_nonnulls(thing_id, place_id) <= 1 END`,
    ),
    uniqueIndex('short_ids_primary_thing_uq')
      .on(t.thingId)
      .where(sql`is_primary AND state = 'assigned'`),
    uniqueIndex('short_ids_primary_place_uq')
      .on(t.placeId)
      .where(sql`is_primary AND state = 'assigned'`),
    index('short_ids_thing_idx').on(t.thingId),
    index('short_ids_place_idx').on(t.placeId),
    index('short_ids_location_idx').on(t.locationId),
    index('short_ids_sync_idx').on(t.locationId, t.changeXid),
  ],
);

const linkKind = textEnum('kind', LINK_KINDS);

/** Links between two things of one location (D76). Never edited: removed and made again. */
export const thingLinks = pgTable(
  'thing_links',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    fromThingId: uuid('from_thing_id').notNull(),
    toThingId: uuid('to_thing_id').notNull(),
    kind: linkKind.col().notNull(),
    createdBy: uuid('created_by'),
    ...mutable(),
  },
  (t) => [
    linkKind.check('thing_links'),
    foreignKey({
      name: 'thing_links_from_fk',
      columns: [t.locationId, t.fromThingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'thing_links_to_fk',
      columns: [t.locationId, t.toThingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    unique('thing_links_uq').on(t.fromThingId, t.toThingId, t.kind),
    check('thing_links_not_self_chk', sql`from_thing_id <> to_thing_id`),
    index('thing_links_to_idx').on(t.toThingId),
  ],
);

/** A thing's tags (D76). Inserted and deleted, never edited; `change_seq` for sync (§7.4). */
export const thingTags = pgTable(
  'thing_tags',
  {
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id').notNull(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }),
  },
  (t) => [
    primaryKey({ name: 'thing_tags_pk', columns: [t.thingId, t.tagId] }),
    foreignKey({
      name: 'thing_tags_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('thing_tags_tag_idx').on(t.tagId),
  ],
);
