import { BUILTIN_PLACE_KINDS, CAPABILITIES, FIELD_KINDS, VENDOR_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
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
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { ownerAccounts } from './tenancy.js';

// Account registries (engineering spec §1.3, §7.9, §7.13; D11, D76, D92, D123, D154, D160,
// D177, D192). Each row belongs to an owner account, or (types, type fields, place kinds) to
// nobody: a built-in, seeded by `kept migrate` (src/db/seed-reference.ts). Row-level security,
// guards, the normalised-name uniques and the trigram indexes are in the custom migration that
// follows this one (0014); see src/db/registries.test.ts.

const KEY = sql`'^[a-z][a-z0-9_]{0,39}$'`;
const ICON = sql`'^(lucide|tabler|kept):[a-z0-9-]+$'`;
const COLOUR = sql`'^#[0-9A-Fa-f]{6}$'`;
const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Sub-place kinds (D33, D160): floor, room, zone, closet built in; accounts add their own. */
export const placeKinds = pgTable(
  'place_kinds',
  {
    id: id(),
    /** NULL for a built-in. */
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    /** NULL for a built-in: the name is translated from `key`. */
    name: text('name'),
    icon: text('icon').notNull(),
    archivedAt: tstz('archived_at'),
    ...mutable(),
  },
  (t) => [
    unique('place_kinds_owner_key_uq').on(t.ownerAccountId, t.key).nullsNotDistinct(),
    unique('place_kinds_owner_id_uq').on(t.ownerAccountId, t.id),
    check('place_kinds_key_chk', sql`key ~ ${KEY}`),
    check('place_kinds_icon_chk', sql`icon ~ ${ICON}`),
    check('place_kinds_name_chk', sql`name IS NULL OR char_length(name) BETWEEN 1 AND 80`),
    // An account's own kind is named; its customised copy of a built-in (same key, T11) may
    // stay unnamed, so it still translates.
    check(
      'place_kinds_named_chk',
      sql`owner_account_id IS NULL OR name IS NOT NULL OR key IN (${list(BUILTIN_PLACE_KINDS)})`,
    ),
  ],
);

/**
 * The type tree (D92, D154, D192). A built-in has `builtin_key` and no owner; a custom type has
 * an owner and a name, or is a customised copy of a built-in (`copied_from_id`, name NULL until
 * renamed). A field group (Q4) is a type with `is_field_group`, referenced from other types'
 * `field_groups`; it has no parent and is nobody's parent. `default_meter` is `{kind, unit}`,
 * JSON `null` to cancel an inherited one, or SQL NULL to inherit.
 */
export const types = pgTable(
  'types',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    builtinKey: text('builtin_key'),
    copiedFromId: uuid('copied_from_id'),
    parentId: uuid('parent_id'),
    name: text('name'),
    /** Built-ins: their English and Arabic names, so search finds them (§7.9). */
    searchNames: text('search_names'),
    icon: text('icon').notNull(),
    colour: text('colour'),
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    defaultMeter: jsonb('default_meter'),
    isFieldGroup: boolean('is_field_group').notNull().default(false),
    fieldGroups: uuid('field_groups').array().notNull().default(sql`'{}'::uuid[]`),
    defaultWarrantyMonths: integer('default_warranty_months'),
    archivedAt: tstz('archived_at'),
    ...mutable(),
  },
  (t) => [
    unique('types_owner_id_uq').on(t.ownerAccountId, t.id),
    uniqueIndex('types_builtin_key_uq').on(t.builtinKey).where(sql`owner_account_id IS NULL`),
    index('types_parent_idx').on(t.parentId),
    index('types_copied_from_idx').on(t.copiedFromId),
    foreignKey({
      name: 'types_parent_fk',
      columns: [t.parentId],
      foreignColumns: [t.id],
    }).onDelete('no action'),
    foreignKey({
      name: 'types_copied_from_fk',
      columns: [t.copiedFromId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    check('types_builtin_chk', sql`(owner_account_id IS NULL) = (builtin_key IS NOT NULL)`),
    check('types_builtin_key_chk', sql`builtin_key IS NULL OR builtin_key ~ ${KEY}`),
    check(
      'types_named_chk',
      sql`name IS NOT NULL OR builtin_key IS NOT NULL OR copied_from_id IS NOT NULL`,
    ),
    check('types_name_chk', sql`name IS NULL OR char_length(name) BETWEEN 1 AND 80`),
    check('types_icon_chk', sql`icon ~ ${ICON}`),
    check('types_colour_chk', sql`colour IS NULL OR colour ~ ${COLOUR}`),
    check('types_capabilities_chk', sql`capabilities <@ ARRAY[${list(CAPABILITIES)}]::text[]`),
    check(
      'types_default_meter_chk',
      sql`default_meter IS NULL OR jsonb_typeof(default_meter) IN ('object', 'null')`,
    ),
    check(
      'types_field_group_chk',
      sql`NOT is_field_group OR (parent_id IS NULL AND cardinality(field_groups) = 0)`,
    ),
    check('types_not_own_parent_chk', sql`parent_id IS NULL OR parent_id <> id`),
    check(
      'types_default_warranty_chk',
      sql`default_warranty_months IS NULL OR default_warranty_months >= 0`,
    ),
  ],
);

const fieldKind = textEnum('kind', FIELD_KINDS);

/**
 * Fields of a type or a place kind (§7.13, D92, D116, D160). `owner_account_id` is the owner of
 * the type or kind (NULL for a built-in's), which the composite foreign keys hold to when set,
 * and kept.guard_type_field() when not (MATCH SIMPLE skips a NULL owner). A key is defined once
 * along a type's whole chain and its groups (kept.check_type_keys()). "Secret" is a flag on a
 * text field (Q3), set at creation only.
 */
export const typeFields = pgTable(
  'type_fields',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    typeId: uuid('type_id').references((): AnyPgColumn => types.id, { onDelete: 'cascade' }),
    placeKindId: uuid('place_kind_id').references((): AnyPgColumn => placeKinds.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    /** NULL for a built-in's field: translated from the key. */
    label: text('label'),
    kind: fieldKind.col().notNull(),
    unit: text('unit'),
    options: jsonb('options'),
    repeatable: boolean('repeatable').notNull().default(false),
    required: boolean('required').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    secret: boolean('secret').notNull().default(false),
    archivedAt: tstz('archived_at'),
    ...mutable(),
  },
  (t) => [
    fieldKind.check('type_fields'),
    foreignKey({
      name: 'type_fields_type_account_fk',
      columns: [t.ownerAccountId, t.typeId],
      foreignColumns: [types.ownerAccountId, types.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'type_fields_place_kind_account_fk',
      columns: [t.ownerAccountId, t.placeKindId],
      foreignColumns: [placeKinds.ownerAccountId, placeKinds.id],
    }).onDelete('cascade'),
    uniqueIndex('type_fields_type_key_uq').on(t.typeId, t.key).where(sql`type_id IS NOT NULL`),
    uniqueIndex('type_fields_place_kind_key_uq')
      .on(t.placeKindId, t.key)
      .where(sql`place_kind_id IS NOT NULL`),
    index('type_fields_owner_idx').on(t.ownerAccountId),
    check('type_fields_one_owner_chk', sql`num_nonnulls(type_id, place_kind_id) = 1`),
    check('type_fields_key_chk', sql`key ~ ${KEY}`),
    check('type_fields_secret_text_chk', sql`NOT secret OR kind = 'text'`),
    check('type_fields_label_chk', sql`label IS NULL OR char_length(label) BETWEEN 1 AND 80`),
    check('type_fields_unit_chk', sql`unit IS NULL OR char_length(unit) BETWEEN 1 AND 12`),
    check('type_fields_options_chk', sql`options IS NULL OR jsonb_typeof(options) = 'array'`),
  ],
);

/** Brands (D55, D76). Names are unique per account after kept.normalize() (0014). */
export const brands = pgTable(
  'brands',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    website: text('website'),
    supportPhone: text('support_phone'),
    claimUrl: text('claim_url'),
    defaultWarrantyMonths: integer('default_warranty_months'),
    ...mutable(),
  },
  (t) => [
    unique('brands_owner_id_uq').on(t.ownerAccountId, t.id),
    check('brands_name_chk', sql`char_length(name) BETWEEN 1 AND 120`),
    check('brands_website_chk', sql`website IS NULL OR char_length(website) <= 2000`),
    check('brands_claim_url_chk', sql`claim_url IS NULL OR char_length(claim_url) <= 2000`),
    check(
      'brands_support_phone_chk',
      sql`support_phone IS NULL OR char_length(support_phone) <= 40`,
    ),
    check(
      'brands_default_warranty_chk',
      sql`default_warranty_months IS NULL OR default_warranty_months >= 0`,
    ),
  ],
);

/** Raw bytes (Drizzle has no `bytea` builder here). */
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * A brand's logo (§1.3; D157, D172: uploads only; step-4 T9, Q33), one per brand, kept by its
 * account: a brand is the account's, not a location's, so a `files` row (location-owned, readable
 * only through an attachment, D177) can't hold it. It is the PNG Kept rendered (at most 256 px a
 * side), never the upload: an SVG's bytes are not kept, so none is ever served back. Read by
 * whoever sees the account's brands; set and removed by its admins (0058).
 */
export const brandLogos = pgTable(
  'brand_logos',
  {
    brandId: uuid('brand_id').primaryKey(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    png: bytea('png').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sha256: text('sha256').notNull(),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    foreignKey({
      name: 'brand_logos_brand_fk',
      columns: [t.ownerAccountId, t.brandId],
      foreignColumns: [brands.ownerAccountId, brands.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('brand_logos_png_chk', sql`octet_length(png) BETWEEN 8 AND 262144`),
    check('brand_logos_size_chk', sql`width BETWEEN 1 AND 256 AND height BETWEEN 1 AND 256`),
    check('brand_logos_sha256_chk', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    index('brand_logos_owner_idx').on(t.ownerAccountId),
  ],
);

const vendorKind = textEnum('kind', VENDOR_KINDS);

/** Vendors (D11): created inline by members, managed by admins. */
export const vendors = pgTable(
  'vendors',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: vendorKind.col().notNull().default('other'),
    address: text('address'),
    phone: text('phone'),
    website: text('website'),
    ...mutable(),
  },
  (t) => [
    vendorKind.check('vendors'),
    unique('vendors_owner_id_uq').on(t.ownerAccountId, t.id),
    check('vendors_name_chk', sql`char_length(name) BETWEEN 1 AND 120`),
    check('vendors_address_chk', sql`address IS NULL OR char_length(address) <= 500`),
    check('vendors_phone_chk', sql`phone IS NULL OR char_length(phone) <= 40`),
    check('vendors_website_chk', sql`website IS NULL OR char_length(website) <= 2000`),
  ],
);

/** People (D11, D177). `member_user_id` links a person to a Kept user; it is a reference, not
 * the row's scope. Contact details live apart, in person_contacts. */
export const people = pgTable(
  'people',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    memberUserId: uuid('member_user_id').references(() => user.id, { onDelete: 'set null' }),
    ...mutable(),
  },
  (t) => [
    unique('people_owner_id_uq').on(t.ownerAccountId, t.id),
    check('people_display_name_chk', sql`char_length(display_name) BETWEEN 1 AND 120`),
  ],
);

/** A person's contact details (D177): readable only through kept.person_contact_visible(). */
export const personContacts = pgTable(
  'person_contacts',
  {
    personId: uuid('person_id').primaryKey(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    phone: text('phone'),
    email: text('email'),
    notes: text('notes'),
    ...mutable(),
  },
  (t) => [
    foreignKey({
      name: 'person_contacts_person_fk',
      columns: [t.ownerAccountId, t.personId],
      foreignColumns: [people.ownerAccountId, people.id],
    }).onDelete('cascade'),
    check('person_contacts_phone_chk', sql`phone IS NULL OR char_length(phone) <= 40`),
    check('person_contacts_email_chk', sql`email IS NULL OR char_length(email) <= 320`),
    check('person_contacts_notes_chk', sql`notes IS NULL OR char_length(notes) <= 5000`),
  ],
);

/** Tags (D76). Names are unique per account after kept.normalize() (0014). */
export const tags = pgTable(
  'tags',
  {
    id: id(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => ownerAccounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    colour: text('colour'),
    ...mutable(),
  },
  (t) => [
    unique('tags_owner_id_uq').on(t.ownerAccountId, t.id),
    check('tags_name_chk', sql`char_length(name) BETWEEN 1 AND 60`),
    check('tags_colour_chk', sql`colour IS NULL OR colour ~ ${COLOUR}`),
  ],
);
