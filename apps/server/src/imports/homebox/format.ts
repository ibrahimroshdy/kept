import { z } from 'zod';

// A Homebox export ZIP, table by table, exactly as spike H1 recorded it (D146; step-7 plan T9;
// docs/spikes/2026-09-30-step7-homebox.md, its draft docs/spikes/code/step7/h1_format.ts, and the
// fixtures in test/fixtures/homebox/). Nothing here is a guess: a column the spike didn't see is
// not read, and an encoding it didn't see fails the row, which becomes an issue on that row.
//
// - Every table is one JSON array (`<table>.json`, Go's json.Encoder), not NDJSON, read whole.
// - Booleans are 0/1 from SQLite (observed) or true/false from Postgres (inferred from v0.27's
//   import fix); both are accepted.
// - Timestamps are RFC 3339 in UTC; dates are midnight UTC (the importer takes the UTC date
//   part); Go's zero time `0001-01-01T00:00:00Z` means "no date" in maintenance_entries.
// - Optional text is null or "" interchangeably; money and quantity are JSON numbers.
// - Column names are the SQL names, several of which read backwards: `entity_children` and
//   `tag_children` hold the row's PARENT, `entity_fields` the entity a field belongs to.
// - Unknown columns are ignored (z.object strips them), so a newer Homebox's extra column
//   doesn't refuse an export. `notifiers.json` is never opened: its URLs are credentials, and
//   only the manifest's count is reported.

const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .transform((s) => s.toLowerCase());
const bool = z
  .union([z.literal(0), z.literal(1), z.boolean()])
  .transform((v: number | boolean) => v === 1 || v === true);
const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
const optText = z
  .string()
  .nullable()
  .optional()
  .transform((s) => (s ?? '').trim());
const num = z.number().finite();

const base = { id: uuid, created_at: ts, updated_at: ts };

/** Homebox's custom-field kinds (H1). */
export const HB_FIELD_TYPES = ['text', 'number', 'boolean', 'time'] as const;
/** Homebox's attachment kinds (H1); `thumbnail` rows are generated and skipped (D146). */
export const HB_ATTACHMENT_TYPES = [
  'photo',
  'manual',
  'warranty',
  'attachment',
  'receipt',
  'thumbnail',
] as const;

export const EntityType = z.object({
  ...base,
  name: z.string(),
  description: optText,
  is_location: bool,
  icon: z.string().nullable(),
  group_entity_types: uuid,
  entity_type_default_template: uuid.nullable(),
});

export const EntityTemplate = z.object({
  ...base,
  name: z.string(),
  description: optText,
  notes: optText,
  default_name: optText,
  default_description: optText,
  default_quantity: num,
  default_insured: bool,
  default_lifetime_warranty: bool,
  default_manufacturer: optText,
  default_model_number: optText,
  default_warranty_details: optText,
  /** A JSON array of tag UUIDs, encoded as a string (H1). */
  default_tag_ids: z.string().nullable(),
  include_purchase_fields: bool,
  include_sold_fields: bool,
  include_warranty_fields: bool,
  entity_template_location: uuid.nullable(),
  group_entity_templates: uuid,
});

const fieldValues = {
  name: z.string(),
  description: optText,
  type: z.enum(HB_FIELD_TYPES),
  text_value: optText,
  /** Homebox stores numbers as integers (decimals were already lost there). */
  number_value: z.number().int().nullable(),
  boolean_value: bool,
};

export const TemplateField = z.object({
  ...base,
  ...fieldValues,
  time_value: ts.nullable(),
  entity_template_fields: uuid,
});

export const Tag = z.object({
  ...base,
  name: z.string(),
  description: optText,
  /** Free text: `#1e88e5` and `red` both occur. */
  color: optText,
  icon: z.string().nullable(),
  /** Despite the name: this tag's PARENT. */
  tag_children: uuid.nullable(),
  group_tags: uuid,
});

export const Entity = z.object({
  ...base,
  name: z.string(),
  description: optText,
  notes: optText,
  import_ref: optText,
  /** Fractional allowed; 0 when an API client created it without one. */
  quantity: num,
  insured: bool,
  archived: bool,
  /** 0 = none; printed as `000-001`. */
  asset_id: z.number().int().nonnegative(),
  serial_number: optText,
  model_number: optText,
  manufacturer: optText,
  lifetime_warranty: bool,
  warranty_expires: ts.nullable(),
  warranty_details: optText,
  purchase_date: ts.nullable(),
  purchase_from: optText,
  /** 0 when unset. */
  purchase_price: num,
  sold_date: ts.nullable(),
  sold_to: optText,
  /** 0 when unset. */
  sold_price: num,
  sold_notes: optText,
  sync_child_entity_locations: bool,
  /** Despite the name: this entity's PARENT. */
  entity_children: uuid.nullable(),
  entity_type_entities: uuid,
  group_entities: uuid,
  /** v0.27.0-rc.1 (#1688): a location override, set only when the parent isn't a location. */
  entity_location_entities: uuid.nullable().optional(),
});

export const EntityField = z.object({
  ...base,
  ...fieldValues,
  /** Always set: the row's creation time unless something set it (H1). */
  time_value: ts,
  /** The entity. */
  entity_fields: uuid,
});

export const MaintenanceEntry = z.object({
  ...base,
  name: z.string(),
  description: optText,
  /** `0001-01-01T00:00:00Z` when not done. */
  date: ts,
  /** `0001-01-01T00:00:00Z` when not scheduled. */
  scheduled_date: ts,
  /** A number in the ZIP (a string only in the API). */
  cost: num,
  entity_id: uuid,
});

export const Attachment = z.object({
  ...base,
  type: z.enum(HB_ATTACHMENT_TYPES),
  primary: bool,
  title: z.string(),
  /** A storage path, or the URL itself when mime_type is `link/url`. Never read as a path. */
  path: z.string(),
  mime_type: z.string(),
  /** Null on thumbnail rows. */
  entity_attachments: uuid.nullable(),
  /** Parent → its thumbnail, and thumbnail → its parent. */
  attachment_thumbnail: uuid.nullable(),
});

export const TagEntity = z.object({ tag_id: uuid, entity_id: uuid });

/** The schema versions this reader has seen (H1 and V25: v0.26.2 and v0.27.0-rc.1 both write 1). */
export const HB_SCHEMA_VERSIONS: readonly number[] = [1];

export const Manifest = z.object({
  schemaVersion: z.number().int(),
  exportedAt: ts,
  groupId: uuid,
  /** Declared in Homebox's Go struct, never set by v0.26.2 or the rc (H1). */
  homeboxVersion: z.string().max(40).optional(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type Manifest = z.infer<typeof Manifest>;

/** The tables the importer reads, by entry name (`<table>.json`). Not `notifiers`. */
export const HB_TABLES = {
  entity_types: EntityType,
  entity_templates: EntityTemplate,
  template_fields: TemplateField,
  tags: Tag,
  entities: Entity,
  entity_fields: EntityField,
  maintenance_entries: MaintenanceEntry,
  attachments: Attachment,
  tag_entities: TagEntity,
} as const;
export type HbTableName = keyof typeof HB_TABLES;
export const HB_TABLE_NAMES = Object.keys(HB_TABLES) as HbTableName[];

export type HbEntityType = z.infer<typeof EntityType>;
export type HbTemplate = z.infer<typeof EntityTemplate>;
export type HbTemplateField = z.infer<typeof TemplateField>;
export type HbTag = z.infer<typeof Tag>;
export type HbEntity = z.infer<typeof Entity>;
export type HbEntityField = z.infer<typeof EntityField>;
export type HbMaintenance = z.infer<typeof MaintenanceEntry>;
export type HbAttachment = z.infer<typeof Attachment>;
export type HbTagEntity = z.infer<typeof TagEntity>;

/** Go's zero time: "no date" in maintenance_entries. */
export const GO_ZERO_TIME = '0001-01-01T00:00:00Z';

/** A Homebox date (midnight UTC) as Kept's `YYYY-MM-DD`: the UTC date part, never a local-time
 * conversion. Null for none (null, or Go's zero time). */
export function hbDate(value: string | null | undefined): string | null {
  if (!value || value.startsWith('0001-01-01')) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
