import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, mutable, tstz } from './common.js';
import { places } from './places.js';
import { typeFields } from './registries.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Secret field values and who may reveal them (engineering spec §1.3, §7.3, §7.13; D83, D116,
// D177). Values are envelope-encrypted by the server (crypto/envelope.ts) and versioned: a new
// value supersedes the current one, and history stays. Never indexed, never in `custom`, the
// search document, the audit diff or the offline snapshot. Row-level security and the definers
// are in 0020; see src/db/secrets.test.ts.

export const secretValues = pgTable(
  'secret_values',
  {
    id: id(),
    locationId: uuid('location_id').notNull(),
    thingId: uuid('thing_id'),
    placeId: uuid('place_id'),
    typeFieldId: uuid('type_field_id')
      .notNull()
      .references(() => typeFields.id, { onDelete: 'no action' }),
    fieldKey: text('field_key').notNull(),
    /** The envelope (crypto/envelope.ts), under `key_version` of KEPT_SECRET_KEY. NULL once
     * erased: clearing a field (kept.clear_secret, 0030) erases every version of it, keeping the
     * rows as history of when it was set and by whom. */
    ciphertext: jsonb('ciphertext'),
    keyVersion: integer('key_version').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    supersededAt: tstz('superseded_at'),
  },
  (t) => [
    check('secret_values_one_subject_chk', sql`num_nonnulls(thing_id, place_id) = 1`),
    check('secret_values_key_version_chk', sql`key_version > 0`),
    check(
      'secret_values_ciphertext_chk',
      sql`ciphertext IS NULL OR jsonb_typeof(ciphertext) = 'object'`,
    ),
    foreignKey({
      name: 'secret_values_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'secret_values_place_fk',
      columns: [t.locationId, t.placeId],
      foreignColumns: [places.locationId, places.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // One current value per (subject, field).
    uniqueIndex('secret_values_thing_current_uq')
      .on(t.thingId, t.fieldKey)
      .where(sql`superseded_at IS NULL AND thing_id IS NOT NULL`),
    uniqueIndex('secret_values_place_current_uq')
      .on(t.placeId, t.fieldKey)
      .where(sql`superseded_at IS NULL AND place_id IS NOT NULL`),
    index('secret_values_type_field_idx').on(t.typeFieldId),
    index('secret_values_key_version_idx').on(t.keyVersion),
  ],
);

export const REVEAL_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

/** Per location, who may reveal a secret field and whether the assistant may use it (D177).
 * Written by the location's owner only. No row: owners and admins reveal, the AI never. */
export const secretFieldPolicies = pgTable(
  'secret_field_policies',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    typeFieldId: uuid('type_field_id')
      .notNull()
      .references(() => typeFields.id, { onDelete: 'cascade' }),
    revealRoles: text('reveal_roles')
      .array()
      .notNull()
      .default(sql`ARRAY['owner', 'admin']::text[]`),
    revealUserIds: uuid('reveal_user_ids').array().notNull().default(sql`'{}'::uuid[]`),
    aiAllowed: boolean('ai_allowed').notNull().default(false),
    ...mutable(),
  },
  (t) => [
    primaryKey({ name: 'secret_field_policies_pk', columns: [t.locationId, t.typeFieldId] }),
    check(
      'secret_field_policies_roles_chk',
      sql`reveal_roles <@ ARRAY['owner', 'admin', 'member', 'viewer']::text[]`,
    ),
  ],
);
