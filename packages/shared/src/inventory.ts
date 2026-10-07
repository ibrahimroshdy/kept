/**
 * Domain value lists for the core inventory (engineering spec §1 and §7.13, D183: text + CHECK,
 * never Postgres enums). The database CHECKs, the zod schemas and the web pickers all read these,
 * so a value is added in one place.
 */

/** The stored lifecycle (D119, D158, §7.13). Lent, borrowed and in repair are derived, not stored. */
export const LIFECYCLES = [
  'in_use',
  'sold',
  'given_away',
  'lost',
  'disposed',
  'stolen',
  'destroyed',
  'returned_to_owner',
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** Every lifecycle that ends a thing's active life: all but `in_use`. */
export const ENDED = LIFECYCLES.filter(
  (l): l is Exclude<Lifecycle, 'in_use'> => l !== 'in_use',
) as readonly Exclude<Lifecycle, 'in_use'>[];

/** A thing's condition (Q10: not enumerated in the specs; localised in the UI). */
export const CONDITIONS = ['new', 'good', 'fair', 'poor', 'broken'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** `thing_links.kind` (D76). */
export const LINK_KINDS = [
  'accessory_of',
  'spare_part_for',
  'consumable_for',
  'bundled_with',
  'replaces',
  'related',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** `attachments.role` (§1.5, plus `document` for anything else a thing carries). */
export const ATTACHMENT_ROLES = [
  'photo',
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'proof',
  'condition_out',
  'condition_in',
  'registration',
  'document',
] as const;
export type AttachmentRole = (typeof ATTACHMENT_ROLES)[number];

/** `files.class` (§1.5; evidence is kept byte-identical, D117). */
export const FILE_CLASSES = ['evidence', 'photo', 'document', 'video'] as const;
export type FileClass = (typeof FILE_CLASSES)[number];

/** `vendors.kind` (§1.4, D11). */
export const VENDOR_KINDS = ['store', 'online', 'service_centre', 'station', 'other'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

/** A custom field's kind. "Secret" is a flag on a text field, not a kind (Q3). */
export const FIELD_KINDS = [
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'boolean',
  'url',
  'money',
  'person',
  'vendor',
  'file',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * Type capabilities (D154): container, metered, warranty, serialized, consumable, and "expires on"
 * (D141). They are inherited down the type tree.
 */
export const CAPABILITIES = [
  'container',
  'metered',
  'warranty',
  'serialized',
  'consumable',
  'expires',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The built-in sub-place kinds (D33); accounts add custom ones. */
export const BUILTIN_PLACE_KINDS = ['floor', 'room', 'zone', 'closet'] as const;
export type BuiltinPlaceKind = (typeof BUILTIN_PLACE_KINDS)[number];

/**
 * Derived states shown next to the lifecycle (D119). Lent and borrowed come from an open loan
 * (its direction), in repair from a claim in repair (step 4).
 */
export const DERIVED_STATES = [
  'uncertain',
  'draft',
  'ended',
  'lent',
  'borrowed',
  'in_repair',
] as const;
export type DerivedState = (typeof DERIVED_STATES)[number];
