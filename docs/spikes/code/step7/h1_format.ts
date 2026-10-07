/**
 * H1: a zod schema per table of a Homebox v0.26 export ZIP, checked against every row of the
 * committed fixtures. The draft T9 turns into apps/server/src/imports/homebox/format.ts.
 *
 *   apps/server/node_modules/.bin/tsx docs/spikes/code/step7/h1_format.ts apps/server/test/fixtures/homebox/*.zip
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import yauzl from 'yauzl';

const serverRequire = createRequire(new URL('../../../../apps/server/package.json', import.meta.url));
const { z } = await import(pathToFileURL(serverRequire.resolve('zod')).href);

// Observed encodings (Homebox on SQLite, its default):
// - booleans are 0 or 1 (SQLite has no bool); a Postgres-backed Homebox writes true/false
//   (inferred from v0.27.0-rc.1's import fix, service_exports.go boolColumns), so accept both;
// - timestamps are RFC 3339 in UTC with up to 9 fractional digits; dates are midnight UTC;
// - Go's zero time "0001-01-01T00:00:00Z" means "no date" in maintenance_entries;
// - optional strings are null or "" interchangeably; money and quantity are JSON numbers.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const bool = z.union([z.literal(0), z.literal(1), z.boolean()]).transform((v: number | boolean) => v === 1 || v === true);
const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
const optText = z.string().nullable();
const num = z.number();

const base = { id: uuid, created_at: ts, updated_at: ts };

export const Tables = {
  entity_types: z.object({
    ...base,
    name: z.string(),
    description: optText,
    is_location: bool,
    icon: optText,
    group_entity_types: uuid,
    entity_type_default_template: uuid.nullable(),
  }),
  entity_templates: z.object({
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
    default_tag_ids: optText, // a JSON array of tag UUIDs, as a string
    include_purchase_fields: bool,
    include_sold_fields: bool,
    include_warranty_fields: bool,
    entity_template_location: uuid.nullable(),
    group_entity_templates: uuid,
  }),
  template_fields: z.object({
    ...base,
    name: z.string(),
    description: optText,
    type: z.enum(['text', 'number', 'boolean', 'time']),
    text_value: optText,
    number_value: z.number().int().nullable(),
    boolean_value: bool,
    time_value: ts.nullable(),
    entity_template_fields: uuid,
  }),
  tags: z.object({
    ...base,
    name: z.string(),
    description: optText,
    color: optText, // free text: "#1e88e5" and "red" both occur
    icon: optText,
    tag_children: uuid.nullable(), // despite the name: this tag's PARENT
    group_tags: uuid,
  }),
  entities: z.object({
    ...base,
    name: z.string(),
    description: optText,
    notes: optText,
    import_ref: optText,
    quantity: num, // fractional allowed; 0 when an API client created it without one
    insured: bool,
    archived: bool,
    asset_id: z.number().int().nonnegative(), // 0 = none; shown as 000-001
    serial_number: optText,
    model_number: optText,
    manufacturer: optText,
    lifetime_warranty: bool,
    warranty_expires: ts.nullable(),
    warranty_details: optText,
    purchase_date: ts.nullable(),
    purchase_from: optText,
    purchase_price: num, // 0 when unset
    sold_date: ts.nullable(),
    sold_to: optText,
    sold_price: num, // 0 when unset
    sold_notes: optText,
    sync_child_entity_locations: bool,
    entity_children: uuid.nullable(), // despite the name: this entity's PARENT
    entity_type_entities: uuid,
    group_entities: uuid,
    // v0.27.0-rc.1 adds a location override when the parent isn't a location (#1688).
    entity_location_entities: uuid.nullable().optional(),
  }),
  entity_fields: z.object({
    ...base,
    name: z.string(),
    description: optText,
    type: z.enum(['text', 'number', 'boolean', 'time']),
    text_value: optText,
    number_value: z.number().int().nullable(),
    boolean_value: bool,
    time_value: ts, // always set: the row's creation time unless something set it
    entity_fields: uuid, // the entity
  }),
  maintenance_entries: z.object({
    ...base,
    name: z.string(),
    description: optText,
    date: ts, // "0001-01-01T00:00:00Z" when not done
    scheduled_date: ts, // "0001-01-01T00:00:00Z" when not scheduled
    cost: num, // a number in the ZIP (a string only in the API)
    entity_id: uuid,
  }),
  attachments: z.object({
    ...base,
    type: z.enum(['photo', 'manual', 'warranty', 'attachment', 'receipt', 'thumbnail']),
    primary: bool,
    title: z.string(),
    path: z.string(), // a storage path, or the URL itself when mime_type is "link/url"
    mime_type: z.string(),
    entity_attachments: uuid.nullable(), // null on thumbnail rows
    attachment_thumbnail: uuid.nullable(), // parent → its thumbnail, and thumbnail → its parent
  }),
  tag_entities: z.object({ tag_id: uuid, entity_id: uuid }),
  // Never imported, never logged: `url` holds a notifier's credentials.
  notifiers: z.object({
    ...base,
    name: z.string(),
    url: z.string(),
    is_active: bool,
    group_id: uuid,
    user_id: uuid,
  }),
} as const;

export const Manifest = z.object({
  schemaVersion: z.literal(1),
  exportedAt: ts,
  groupId: uuid,
  homeboxVersion: z.string().optional(), // declared in the Go struct, never set by v0.26.2
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

async function entriesOf(file: string): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(readFileSync(file), { strictFileNames: true });
  const out = new Map<string, Buffer>();
  for await (const e of zip.eachEntry()) {
    if (!e.fileName.endsWith('.json')) continue;
    const chunks: Buffer[] = [];
    for await (const c of await zip.openReadStreamPromise(e)) chunks.push(c as Buffer);
    out.set(e.fileName, Buffer.concat(chunks));
  }
  return out;
}

let failures = 0;
for (const file of process.argv.slice(2)) {
  const files = await entriesOf(file);
  const manifest = Manifest.parse(JSON.parse(files.get('manifest.json')!.toString('utf8')));
  const line = [`${file.split('/').pop()}: manifest ok`];
  for (const [table, schema] of Object.entries(Tables)) {
    const raw = files.get(`${table}.json`);
    if (!raw) {
      line.push(`${table} MISSING`);
      failures++;
      continue;
    }
    const rows = JSON.parse(raw.toString('utf8')) as unknown[];
    let bad = 0;
    for (const r of rows) {
      const res = schema.strict().safeParse(r);
      if (!res.success) {
        bad++;
        console.log(table, JSON.stringify(res.error.issues.slice(0, 3)));
      }
    }
    if (rows.length !== manifest.counts[table]) line.push(`${table} count ${rows.length}≠${manifest.counts[table]}`);
    line.push(`${table} ${rows.length - bad}/${rows.length}`);
    failures += bad;
  }
  console.log(line.join(' · '));
}
process.exit(failures ? 1 : 0);
