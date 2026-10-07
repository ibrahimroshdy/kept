import { VENDOR_KINDS } from '@kept/shared';
import { z } from 'zod';

// The registries' request and response shapes: apps/web/src/api/inventory/types.ts (Brand,
// Vendor, Person, Tag, CreateRegistryResult, PersonContact, AccountsResponse), camelCase, with a
// row image for the audit next to each (T11).

export const REGISTRY_KINDS = ['brands', 'vendors', 'people', 'tags'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** The audit entity type and the merge_registry()/registry_use_locations() kind of each. */
export const ENTITY: Record<RegistryKind, 'brand' | 'vendor' | 'person' | 'tag'> = {
  brands: 'brand',
  vendors: 'vendor',
  people: 'person',
  tags: 'tag',
};

const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const name = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const months = z.number().int().min(0).max(1200).nullable().optional();

export const CreateBody = {
  brands: z.strictObject({
    id: z.uuid().optional(),
    name: name(120),
    website: optText(2000),
    supportPhone: optText(40),
    claimUrl: optText(2000),
    defaultWarrantyMonths: months,
  }),
  vendors: z.strictObject({
    id: z.uuid().optional(),
    name: name(120),
    kind: z.enum(VENDOR_KINDS).optional(),
    address: optText(500),
    phone: optText(40),
    website: optText(2000),
  }),
  people: z.strictObject({
    id: z.uuid().optional(),
    displayName: name(120),
    userId: z.uuid().nullable().optional(),
  }),
  tags: z.strictObject({
    id: z.uuid().optional(),
    name: name(60),
    colour: z.string().regex(COLOUR).nullable().optional(),
  }),
} as const;

const nonEmpty = <T extends z.ZodObject>(s: T) =>
  s.refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change.' });

export const PatchBody = {
  brands: nonEmpty(CreateBody.brands.omit({ id: true }).partial()),
  vendors: nonEmpty(CreateBody.vendors.omit({ id: true }).partial()),
  people: nonEmpty(CreateBody.people.omit({ id: true, userId: true }).partial()),
  tags: nonEmpty(CreateBody.tags.omit({ id: true }).partial()),
} as const;

/** API field → column, per kind (the columns kept_app may write, 0014). */
export const COLUMNS: Record<RegistryKind, Record<string, string>> = {
  brands: {
    name: 'name',
    website: 'website',
    supportPhone: 'support_phone',
    claimUrl: 'claim_url',
    defaultWarrantyMonths: 'default_warranty_months',
  },
  vendors: { name: 'name', kind: 'kind', address: 'address', phone: 'phone', website: 'website' },
  people: { displayName: 'display_name', userId: 'member_user_id' },
  tags: { name: 'name', colour: 'colour' },
};

export const TABLE: Record<RegistryKind, string> = {
  brands: 'brands',
  vendors: 'vendors',
  people: 'people',
  tags: 'tags',
};

export const NAME_COLUMN: Record<RegistryKind, string> = {
  brands: 'name',
  vendors: 'name',
  people: 'display_name',
  tags: 'name',
};

const Base = { id: z.uuid(), rowVersion: z.number().int() };
export const ItemSchema = {
  brands: z.object({
    ...Base,
    ownerAccountId: z.uuid().nullable(),
    name: z.string(),
    website: z.string().nullable(),
    supportPhone: z.string().nullable(),
    claimUrl: z.string().nullable(),
    defaultWarrantyMonths: z.number().int().nullable(),
    /** Whether `GET /brands/:id/logo` has an image: set on `GET /brands/:id` only, so the brand
     * page asks for no logo it would get a 404 for (UI step-4 review L8). */
    hasLogo: z.boolean().optional(),
  }),
  vendors: z.object({
    ...Base,
    ownerAccountId: z.uuid(),
    name: z.string(),
    kind: z.enum(VENDOR_KINDS),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string().nullable(),
  }),
  people: z.object({
    ...Base,
    ownerAccountId: z.uuid(),
    displayName: z.string(),
    userId: z.uuid().nullable(),
  }),
  tags: z.object({
    ...Base,
    ownerAccountId: z.uuid(),
    name: z.string(),
    colour: z.string().nullable(),
  }),
} as const;

export type ItemOf<K extends RegistryKind> = z.infer<(typeof ItemSchema)[K]>;
export type Item = ItemOf<RegistryKind>;

/** A row (all columns) as the web's item shape. */
export function itemOf<K extends RegistryKind>(kind: K, r: Record<string, unknown>): ItemOf<K> {
  return itemShape(kind, r) as ItemOf<K>;
}

function itemShape(kind: RegistryKind, r: Record<string, unknown>): Record<string, unknown> {
  const base = {
    id: r.id as string,
    ownerAccountId: r.owner_account_id as string,
    rowVersion: r.row_version as number,
  };
  switch (kind) {
    case 'brands':
      return {
        ...base,
        name: r.name,
        website: r.website ?? null,
        supportPhone: r.support_phone ?? null,
        claimUrl: r.claim_url ?? null,
        defaultWarrantyMonths: r.default_warranty_months ?? null,
      };
    case 'vendors':
      return {
        ...base,
        name: r.name,
        kind: r.kind,
        address: r.address ?? null,
        phone: r.phone ?? null,
        website: r.website ?? null,
      };
    case 'people':
      return { ...base, displayName: r.display_name, userId: r.member_user_id ?? null };
    case 'tags':
      return { ...base, name: r.name, colour: r.colour ?? null };
  }
}

/** The audit image: the item without its id, account and version (bookkeeping). */
export function imageOf(item: Item): Record<string, unknown> {
  const { id: _i, ownerAccountId: _o, rowVersion: _v, ...rest } = item as Record<string, unknown>;
  return rest;
}

export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

export const CreateResult = <T extends z.ZodType>(item: T) =>
  z.object({
    item,
    possibleDuplicates: z.array(
      z.object({ id: z.uuid(), name: z.string(), similarity: z.number() }),
    ),
  });

export const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().max(2048).optional(),
});

export const MergeBody = z.strictObject({ targetId: z.uuid() });
export const MergeResult = z.object({ repointed: z.number().int() });

export const ContactSchema = z.object({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
});
export const ContactBody = z.strictObject({
  phone: optText(40),
  email: optText(320),
  notes: z.string().max(5000).nullable().optional(),
});

export const AccountsSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.uuid(),
      ownerDisplayName: z.string(),
      isOwn: z.boolean(),
      canManage: z.boolean(),
    }),
  ),
});
