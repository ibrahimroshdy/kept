import { CAPABILITIES, FIELD_KINDS } from '@kept/shared';
import { z } from 'zod';

// The type editor's request and response shapes: apps/web/src/api/inventory/types.ts (TypeNode,
// TypeDetail, ResolvedField, TypeImpact, PlaceKindNode and the bodies), camelCase (T11).

const ICON = /^(lucide|tabler|kept):[a-z0-9-]+$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

const Capabilities = z
  .array(z.enum(CAPABILITIES))
  .max(CAPABILITIES.length)
  .refine((xs) => new Set(xs).size === xs.length, 'Each capability once.');
const DefaultMeter = z.strictObject({
  kind: z.string().trim().min(1).max(20),
  unit: z.string().trim().min(1).max(12),
});
const Groups = z.array(z.uuid()).max(20);

export const CreateTypeBody = z.strictObject({
  id: z.uuid().optional(),
  parentId: z.uuid().nullable(),
  name: z.string().trim().min(1).max(80),
  icon: z.string().regex(ICON),
  colour: z.string().regex(COLOUR).nullable().optional(),
  capabilities: Capabilities,
  fieldGroups: Groups.optional(),
  defaultMeter: DefaultMeter.nullable().optional(),
});
export type CreateTypeBody = z.infer<typeof CreateTypeBody>;

export const UpdateTypeBody = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    icon: z.string().regex(ICON),
    colour: z.string().regex(COLOUR).nullable(),
    capabilities: Capabilities,
    parentId: z.uuid().nullable(),
    fieldGroups: Groups,
    defaultWarrantyMonths: z.number().int().min(0).max(1200).nullable(),
  })
  .partial();
export type UpdateTypeBody = z.infer<typeof UpdateTypeBody>;
export const PatchTypeBody = UpdateTypeBody.refine((b) => Object.keys(b).length > 0, {
  message: 'Nothing to change.',
});

export const CreateFieldBody = z.strictObject({
  key: z.string().regex(KEY),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(FIELD_KINDS),
  unit: z.string().trim().min(1).max(12).optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  repeatable: z.boolean().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export type CreateFieldBody = z.infer<typeof CreateFieldBody>;

export const UpdateFieldBody = z
  .strictObject({
    label: z.string().trim().min(1).max(80),
    unit: z.string().trim().min(1).max(12).nullable(),
    options: z.array(z.string().trim().min(1).max(80)).max(100).nullable(),
    required: z.boolean(),
    sort: z.number().int().min(0).max(10_000),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });
export type UpdateFieldBody = z.infer<typeof UpdateFieldBody>;

export const CustomiseBody = z.strictObject({ accountId: z.uuid() });
export const CustomiseResult = z.object({ typeId: z.uuid() });
export const MergeBody = z.strictObject({ targetId: z.uuid() });
export const MergeResult = z.object({ repointed: z.number().int() });

export const CreatePlaceKindBody = z.strictObject({
  id: z.uuid().optional(),
  key: z.string().regex(KEY),
  name: z.string().trim().min(1).max(80),
  icon: z.string().regex(ICON),
});
export const UpdatePlaceKindBody = z
  .strictObject({ name: z.string().trim().min(1).max(80), icon: z.string().regex(ICON) })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });
export const CustomisePlaceKindResult = z.object({ placeKindId: z.uuid() });

// ----- responses -------------------------------------------------------------------------------

export const ResolvedFieldSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string().nullable(),
  labelKey: z.string().nullable(),
  kind: z.enum(FIELD_KINDS),
  unit: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  repeatable: z.boolean(),
  required: z.boolean(),
  secret: z.boolean(),
  sort: z.number().int(),
  archivedAt: z.string().nullable(),
  source: z.object({ typeId: z.uuid(), via: z.enum(['own', 'inherited', 'group']) }),
  rowVersion: z.number().int(),
});
export type ResolvedField = z.infer<typeof ResolvedFieldSchema>;

export const TypeNodeSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  builtinKey: z.string().nullable(),
  name: z.string().nullable(),
  icon: z.string(),
  colour: z.string().nullable(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  resolvedCapabilities: z.array(z.enum(CAPABILITIES)),
  isFieldGroup: z.boolean(),
  fieldGroups: z.array(z.uuid()),
  copiedFromId: z.uuid().nullable(),
  inUse: z.number().int(),
  rowVersion: z.number().int(),
  archivedAt: z.string().nullable(),
});
export type TypeNode = z.infer<typeof TypeNodeSchema>;

export const TypeDetailSchema = TypeNodeSchema.extend({
  fields: z.array(ResolvedFieldSchema),
  defaultMeter: z.object({ kind: z.string(), unit: z.string() }).nullable(),
  defaultWarrantyMonths: z.number().int().nullable(),
});
export type TypeDetail = z.infer<typeof TypeDetailSchema>;

export const TypesResponse = z.object({ types: z.array(TypeNodeSchema) });

export const TypeImpactSchema = z.object({
  descendants: z.array(
    z.object({ id: z.uuid(), name: z.string().nullable(), builtinKey: z.string().nullable() }),
  ),
  perLocation: z.array(
    z.object({ locationId: z.uuid().nullable(), name: z.string().nullable(), things: z.number() }),
  ),
  hiddenLocations: z.number().int(),
  fieldsToArchive: z.array(z.string()),
});

export const PlaceKindNodeSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  builtinKey: z.string().nullable(),
  /** The account whose kind it is; null for a built-in. An account's customised copy of a
   * built-in has the built-in's `builtinKey` and its own account here. */
  ownerAccountId: z.uuid().nullable(),
  name: z.string().nullable(),
  icon: z.string(),
  fields: z.array(ResolvedFieldSchema),
  rowVersion: z.number().int(),
  archivedAt: z.string().nullable(),
});
export type PlaceKindNode = z.infer<typeof PlaceKindNodeSchema>;
export const PlaceKindsResponse = z.object({ placeKinds: z.array(PlaceKindNodeSchema) });
