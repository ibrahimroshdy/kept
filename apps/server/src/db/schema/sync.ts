import { OP_KINDS, OUTCOMES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { changeXid, id, mutable, textEnum, tstz } from './common.js';
import { places } from './places.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Sync foundations (step-3 plan T4; engineering spec §1.10, §2.3, §7.4, §7.13; D40, D112, D146,
// D148, D175). Row-level security, the watermark and tombstone triggers, the cover cache and the
// grants are in the custom migration that follows (0036); see src/db/sync-tables.test.ts and
// src/db/sync-watermark.test.ts.

/** `own`: a code the household chose, typed, numbered or imported (T17a, D208). `kept`: a thing's
 * or place's short ID from a Kept export whose code was already taken on this server, so its
 * printed label still resolves (step-7 plan Q9, 0082). */
export const LEGACY_CODE_SOURCES = ['homebox', 'csv', 'own', 'kept'] as const;

const opKind = textEnum('op', OP_KINDS);
const outcome = textEnum('outcome', OUTCOMES);
const legacySource = textEnum('source', LEGACY_CODE_SOURCES);

/**
 * The per-user ledger of applied queue ops (§2.3): a replay with the same idempotency key gets
 * the recorded answer, a different body a mismatch. Append-only (no row_version), pruned after
 * 30 days by kept.prune_stale_rows() (§3.3). A person's own rows only, even within a location.
 */
export const syncOps = pgTable(
  'sync_ops',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    clientId: uuid('client_id').notNull(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    op: opKind.col().notNull(),
    payloadVersion: integer('payload_version').notNull(),
    clientVersion: text('client_version').notNull(),
    takenAt: tstz('taken_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    requestHash: text('request_hash').notNull(),
    outcome: outcome.col().notNull(),
    reason: text('reason'),
    result: jsonb('result').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ name: 'sync_ops_pk', columns: [t.userId, t.idempotencyKey] }),
    opKind.check('sync_ops'),
    outcome.check('sync_ops'),
    check('sync_ops_key_chk', sql`idempotency_key ~ '^[A-Za-z0-9_.:-]{8,200}$'`),
    check('sync_ops_payload_version_chk', sql`payload_version > 0`),
    check('sync_ops_client_version_chk', sql`char_length(client_version) BETWEEN 1 AND 40`),
    check('sync_ops_request_hash_chk', sql`request_hash ~ '^[0-9a-f]{64}$'`),
    check('sync_ops_reason_chk', sql`char_length(reason) <= 60`),
    check('sync_ops_result_chk', sql`jsonb_typeof(result) = 'object'`),
    index('sync_ops_received_idx').on(t.receivedAt),
  ],
);

/**
 * Codes printed by another system, so an old label still finds its thing or place (§1.10,
 * §7.13, D146): Homebox asset ids and entity UUIDs (step 7), CSV "old code" columns (T18), and
 * the household's own codes (`own`, T17a, D208: several per thing or place, one per location).
 * Stored normalised (`upper(btrim())`), unique per location, source and collection; a code
 * written by Kept is also refused when the location has it under another source. Synced to
 * phones like short IDs (the scanner resolves them offline).
 */
export const legacyCodes = pgTable(
  'legacy_codes',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    source: legacySource.col().notNull(),
    sourceCollection: text('source_collection').notNull().default(''),
    code: text('code').notNull(),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    ...mutable(),
    changeXid: changeXid(),
  },
  (t) => [
    primaryKey({
      name: 'legacy_codes_pk',
      columns: [t.locationId, t.source, t.sourceCollection, t.code],
    }),
    legacySource.check('legacy_codes'),
    check('legacy_codes_collection_chk', sql`char_length(source_collection) <= 100`),
    check(
      'legacy_codes_code_chk',
      sql`char_length(code) BETWEEN 1 AND 100 AND code = upper(btrim(code))`,
    ),
    check('legacy_codes_target_chk', sql`num_nonnulls(thing_id, place_id) = 1`),
    foreignKey({
      name: 'legacy_codes_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'legacy_codes_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('legacy_codes_code_idx').on(t.source, t.code),
    // A code typed or scanned is looked up whatever its source (scan, search, T17a's checks).
    index('legacy_codes_any_code_idx').on(t.code),
    index('legacy_codes_thing_idx').on(t.thingId),
    index('legacy_codes_place_idx').on(t.placeId),
    index('legacy_codes_sync_idx').on(t.locationId, t.changeXid),
  ],
);

/**
 * A location's own-code options (T17a, D208; engineering spec §1.10). Owners and admins set them
 * (`location.settings`); every member reads them, to number a code or see the rule's message.
 * - **Numbering** (off by default): a new confirmed thing gets `<prefix><counter>`, the counter
 *   zero-padded to `pad` digits (`GAR-` + 4 → `GAR-0001`). The counter is in
 *   `own_code_counters`, one row per location and prefix.
 * - **Format rule** (optional): a pattern every own code must match whole, a plain-words message
 *   for a code that doesn't, and an example that does. The pattern is a JavaScript regular
 *   expression, checked by the server on save and on import (codes/format-rule.ts), never in SQL.
 *   Changing it never rewrites a code; codes that no longer match are only listed.
 * No row means both are off.
 */
export const ownCodeSettings = pgTable(
  'own_code_settings',
  {
    locationId: uuid('location_id')
      .primaryKey()
      .references(() => locations.id, { onDelete: 'cascade' }),
    numbering: boolean('numbering').notNull().default(false),
    prefix: text('prefix').notNull().default(''),
    pad: smallint('pad').notNull().default(4),
    rulePattern: text('rule_pattern'),
    ruleMessage: text('rule_message'),
    ruleExample: text('rule_example'),
    ...mutable(),
  },
  () => [
    check(
      'own_code_settings_prefix_chk',
      sql`char_length(prefix) <= 20 AND prefix = upper(btrim(prefix))`,
    ),
    check('own_code_settings_pad_chk', sql`pad BETWEEN 1 AND 8`),
    check(
      'own_code_settings_rule_chk',
      sql`num_nonnulls(rule_pattern, rule_message, rule_example) IN (0, 3)
          AND char_length(rule_pattern) BETWEEN 1 AND 200
          AND char_length(rule_message) BETWEEN 1 AND 200
          AND char_length(rule_example) BETWEEN 1 AND 100`,
    ),
  ],
);

/**
 * The numbering's counters (T17a, D208): the last number taken, per location and prefix. Taken
 * only through `kept.next_own_code()`, which increments it under the row's lock in the caller's
 * transaction: numbers are consecutive across parallel creates, and a number is never taken
 * twice, even after its code is deleted. A prefix changed back continues where it stopped.
 */
export const ownCodeCounters = pgTable(
  'own_code_counters',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    lastNumber: bigint('last_number', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'own_code_counters_pk', columns: [t.locationId, t.prefix] }),
    check('own_code_counters_number_chk', sql`last_number >= 0`),
  ],
);

/**
 * A box check (D40, D175): someone went through a container's direct contents and counted what
 * was there. Append-only; its undo is an audit-based reversal of what it changed (T20).
 */
export const boxChecks = pgTable(
  'box_checks',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    containerId: uuid('container_id').notNull(),
    checkedBy: uuid('checked_by').notNull(),
    checkedAt: tstz('checked_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('box_checks_location_id_uq').on(t.locationId, t.id),
    foreignKey({
      name: 'box_checks_container_fk',
      columns: [t.locationId, t.containerId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('box_checks_container_idx').on(t.containerId, t.checkedAt),
  ],
);

/** One counted line of a box check (§7.13: quantities, not found/missing arrays; D175). A
 * nested box is one line (plan Q25). Append-only. */
export const boxCheckLines = pgTable(
  'box_check_lines',
  {
    boxCheckId: uuid('box_check_id').notNull(),
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id').notNull(),
    expectedQty: numeric('expected_qty', { precision: 12, scale: 3 }).notNull(),
    foundQty: numeric('found_qty', { precision: 12, scale: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'box_check_lines_pk', columns: [t.boxCheckId, t.thingId] }),
    check('box_check_lines_expected_chk', sql`expected_qty >= 0`),
    check('box_check_lines_found_chk', sql`found_qty >= 0`),
    foreignKey({
      name: 'box_check_lines_check_fk',
      columns: [t.locationId, t.boxCheckId],
      foreignColumns: [boxChecks.locationId, boxChecks.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'box_check_lines_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    index('box_check_lines_thing_idx').on(t.thingId),
  ],
);
