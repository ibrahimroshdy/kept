import { EMBEDDINGS_SOURCES, PRESETS, ROLES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { changeXid, id, mutable, textEnum, tstz } from './common.js';
import { currencies } from './currencies.js';

// Identity and tenancy (engineering spec §1.2, amended by §7.13 and §7.14). Row-level security
// for every table here is in the RLS migration; see db/rls.test.ts.

export const UNITS = ['metric', 'imperial'] as const;
export const THEMES = ['system', 'light', 'dark'] as const;
export const DIGITS = ['western', 'eastern'] as const;

const units = textEnum('units', UNITS);
const theme = textEnum('theme', THEMES);
const digits = textEnum('digits', DIGITS);

/** One per Better Auth user (D47, D122). The user's position is never stored (D153). */
export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    locale: text('locale').notNull().default('en'),
    units: units.col().notNull().default('metric'),
    theme: theme.col().notNull().default('system'),
    digits: digits.col().notNull().default('western'),
    suggestLocation: boolean('suggest_location').notNull().default(false),
    digestTime: time('digest_time'),
    quietFrom: time('quiet_from'),
    quietTo: time('quiet_to'),
    managed: boolean('managed').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    /** A managed account's home location (D197): where it was created. Its owner, and its
     * creator while still an owner or admin there, may reset the account. Set once, by
     * kept.add_managed_member() on the first add. */
    createdInLocationId: uuid('created_in_location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    ...mutable(),
  },
  () => [units.check('user_profiles'), theme.check('user_profiles'), digits.check('user_profiles')],
);

/** One per user (D114). `billable` (owns a non-personal location) is derived, never stored.
 * Deleting the auth user cascades here, and is then refused while the account still owns a
 * location (locations.owner_account_id is RESTRICT). */
export const ownerAccounts = pgTable('owner_accounts', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const LOCATION_KINDS = [
  'personal',
  'home',
  'apartment',
  'garage',
  'storage_unit',
  'office',
  'vacation_home',
  'custom',
] as const;

const locationKind = textEnum('kind', LOCATION_KINDS);
const preset = textEnum('preset', PRESETS);

export const locations = pgTable(
  'locations',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'restrict' }),
    kind: locationKind.col().notNull(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    address: jsonb('address'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    suggestRadiusM: integer('suggest_radius_m').notNull().default(150),
    preset: preset.col().notNull().default('household'),
    moneyVisibleToViewers: boolean('money_visible_to_viewers').notNull().default(false),
    require2fa: boolean('require_2fa').notNull().default(false),
    longUnseenMonths: integer('long_unseen_months').notNull().default(12),
    successorUserId: uuid('successor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    deletedAt: tstz('deleted_at'),
    purgeAfter: tstz('purge_after'),
    ...mutable(),
  },
  (t) => [
    locationKind.check('locations'),
    preset.check('locations'),
    // One Personal location per account (§1.2).
    uniqueIndex('locations_one_personal_uq').on(t.ownerAccountId).where(sql`kind = 'personal'`),
    // For composite foreign keys that must agree on the owner account (§7.13).
    unique('locations_id_owner_account_uq').on(t.id, t.ownerAccountId),
    index('locations_owner_account_idx').on(t.ownerAccountId),
    check('locations_latitude_chk', sql`latitude BETWEEN -90 AND 90`),
    check('locations_longitude_chk', sql`longitude BETWEEN -180 AND 180`),
    check('locations_suggest_radius_chk', sql`suggest_radius_m > 0`),
    check('locations_long_unseen_chk', sql`long_unseen_months > 0`),
    check('locations_purge_needs_delete_chk', sql`purge_after IS NULL OR deleted_at IS NOT NULL`),
  ],
);

/** Modules switched on per location (D61, D113). `module` ids come from the registry in
 * @kept/shared (task 16), so a new module is not a migration. */
export const locationModules = pgTable(
  'location_modules',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    enabled: boolean('enabled').notNull(),
    enabledAt: tstz('enabled_at'),
    ...mutable(),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.module] }),
    check('location_modules_module_chk', sql`module ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

/** Users can hide a module for themselves, never enable one the location has off. */
export const userHiddenModules = pgTable(
  'user_hidden_modules',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.locationId, t.module] }),
    check('user_hidden_modules_module_chk', sql`module ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

const role = textEnum('role', ROLES);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: role.col().notNull(),
    expiresAt: tstz('expires_at'),
    invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
    ...mutable(),
  },
  (t) => [
    role.check('memberships'),
    unique('memberships_location_user_uq').on(t.locationId, t.userId),
    // One owner per location (§1.2); the deferred trigger kept.check_location_owner() makes
    // it exactly one, and the owner account's user.
    uniqueIndex('memberships_one_owner_uq').on(t.locationId).where(sql`role = 'owner'`),
    // An owner membership never expires.
    check('memberships_owner_no_expiry_chk', sql`role <> 'owner' OR expires_at IS NULL`),
    index('memberships_user_idx').on(t.userId),
  ],
);

// An invite never grants ownership.
const inviteRole = textEnum('role', ['admin', 'member', 'viewer'] as const);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    role: inviteRole.col().notNull(),
    membershipExpiresAt: tstz('membership_expires_at'),
    email: text('email'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedBy: uuid('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: tstz('accepted_at'),
    /** Held for a sign-up in progress (kept.claim_invite(), security review I1): for ten
     * minutes only this address may sign up with, or accept, the invite. */
    claimedAt: tstz('claimed_at'),
    claimedEmail: text('claimed_email'),
    ...mutable(),
  },
  (t) => [inviteRole.check('invites'), index('invites_location_idx').on(t.locationId)],
);

export const instanceSettings = pgTable(
  'instance_settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    ...mutable(),
  },
  () => [
    // Step 6 (T7): the keys the database reads or the boot check compares. The embeddings source
    // (D207; mirrors KEPT_EMBEDDINGS at boot, the admin page's switch writes it); a thread's
    // lifetime in days (D23, Q17; kept.assistant_expiry()); and the OIDC and SMTP configuration
    // hashes D180's change notices compare (Q16, Q24). Any other key is the app's.
    check(
      'instance_settings_values_chk',
      sql`CASE key
            WHEN 'embeddings_source' THEN jsonb_typeof(value) = 'string'
              AND value #>> '{}' IN (${sql.raw(EMBEDDINGS_SOURCES.map((v) => `'${v}'`).join(', '))})
            WHEN 'assistant_thread_days' THEN jsonb_typeof(value) = 'number'
              AND (value #>> '{}')::numeric BETWEEN 7 AND 365
            WHEN 'oidc_config_hash' THEN jsonb_typeof(value) = 'string'
              AND value #>> '{}' ~ '^[0-9a-f]{64}$'
            WHEN 'smtp_config_hash' THEN jsonb_typeof(value) = 'string'
              AND value #>> '{}' ~ '^[0-9a-f]{64}$'
            ELSE true END`,
    ),
  ],
);

/** Instance admins (§7.13, D190): `kept.is_instance_admin()` reads this for `app.user_id`. */
export const instanceAdmins = pgTable('instance_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by').references(() => user.id, { onDelete: 'set null' }),
  grantedAt: tstz('granted_at').notNull().defaultNow(),
});

/** Scoped per user (§7.13); a replay with a different `request_hash` is a mismatch (§7.7).
 * Append-only: no row_version. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Purges, merges, moves out and lost access, so deletions reach phones (§7.4, D156). */
export const syncTombstones = pgTable(
  'sync_tombstones',
  {
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** The text key of a removed code (`code`: the short ID) or legacy code (`legacy_code`:
     * `legacyCodeKey()`), which a uuid can't hold (T17a, D208). Its `entity_id` is then
     * `md5(entity_key)::uuid`, so the primary key still says one row per key. */
    entityKey: text('entity_key'),
    ...mutable(),
    changeXid: changeXid(),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.entityType, t.entityId] }),
    check(
      'sync_tombstones_key_chk',
      sql`(entity_type IN ('code', 'legacy_code')) = (entity_key IS NOT NULL)
          AND (entity_key IS NULL
               OR (char_length(entity_key) <= 400 AND entity_id = md5(entity_key)::uuid))`,
    ),
    index('sync_tombstones_change_seq_idx').on(t.locationId, t.changeSeq),
    index('sync_tombstones_sync_idx').on(t.locationId, t.changeXid),
  ],
);
