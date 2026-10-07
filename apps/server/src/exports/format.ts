import {
  EXPORT_ENTITIES,
  EXPORT_FILE_PATH,
  EXPORT_FORMAT,
  EXPORT_SCOPES,
  type ExportEntity,
  type ExportHistoryEvent,
  type ExportManifest,
} from '@kept/shared';
import { z } from 'zod';
import { type EntityDef, entityDef, type FieldKind, fieldsOf } from './registry.js';

// The Kept export's format as zod (plan T12, T14): the writer (exports/data.ts) and the Kept
// importer (imports/kept/read.ts) read the same registry, so they can't drift. An importer reads
// `data/<entity>.ndjson` lines with entitySchema(entity), `manifest.json` with ManifestSchema
// (after checking `format` and `version` itself, for its own refusal), and
// `data/history.ndjson` with HistoryEventSchema.
//
// Every field may be null. Unknown fields are stripped (a newer minor writer may add some).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

const KIND_SCHEMA: Record<FieldKind, z.ZodType> = {
  uuid,
  uuids: z.array(uuid),
  text: z.string(),
  texts: z.array(z.string()),
  int: z.number().int(),
  dec: decimal,
  float: z.number(),
  bool: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/),
  ts: z.iso.datetime({ offset: true }),
  json: z.unknown(),
};

const cache = new Map<ExportEntity, z.ZodObject>();

function schemaOf(def: EntityDef): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fieldsOf(def)) {
    // A money field the exporter couldn't see is absent; anything else is present, maybe null.
    shape[f.name] = def.money?.includes(f.column)
      ? KIND_SCHEMA[f.kind].nullable().optional()
      : KIND_SCHEMA[f.kind].nullable();
  }
  if (def.money?.length) shape.moneyHidden = z.literal(true).optional();
  if (def.entity === 'location') shape.modules = z.array(z.string());
  if (def.entity === 'types') shape.builtin = z.boolean();
  return z.object(shape);
}

/** The schema of one line of `data/<entity>.ndjson` (every entity but `history`). */
export function entitySchema(entity: ExportEntity): z.ZodObject {
  const hit = cache.get(entity);
  if (hit) return hit;
  const def = entityDef(entity);
  if (!def) throw new Error(`export format: ${entity} has no row schema`);
  const schema = schemaOf(def);
  cache.set(entity, schema);
  return schema;
}

const change = z.union([
  z.object({ before: z.unknown(), after: z.unknown(), class: z.enum(['plain', 'money']) }),
  z.object({ changed: z.literal(true), class: z.literal('money'), hidden: z.literal(true) }),
  z.object({ changed: z.literal(true), class: z.literal('secret') }),
]);

/** One line of `data/history.ndjson`. */
export const HistoryEventSchema = z.object({
  id: uuid,
  at: z.iso.datetime({ offset: true }),
  action: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
  actor: z.object({ type: z.string(), id: uuid.nullable(), name: z.string().nullable() }),
  entity: z.object({ type: z.string(), id: uuid.nullable() }),
  rootThingId: uuid.nullable(),
  subjects: z.array(uuid),
  diff: z.record(z.string(), change).nullable(),
  undoOf: uuid.nullable(),
}) satisfies z.ZodType<ExportHistoryEvent>;

/** `manifest.json` (the importer checks `format` and `version` first). */
export const ManifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().min(1),
  keptVersion: z.string(),
  exportId: uuid,
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.object({ displayName: z.string() }),
  scope: z.enum(EXPORT_SCOPES),
  location: z.object({
    id: uuid,
    name: z.string(),
    kind: z.string(),
    timezone: z.string(),
    currency: z.string(),
    languages: z.array(z.string()),
    modules: z.array(z.string()),
  }),
  options: z.object({
    ended: z.boolean(),
    trashed: z.boolean(),
    history: z.boolean(),
    aiCalls: z.boolean(),
    readable: z.boolean(),
    pdf: z.boolean(),
    locale: z.string(),
    digits: z.enum(['western', 'eastern']),
  }),
  counts: z.record(z.enum(EXPORT_ENTITIES), z.number().int().min(0)),
  moneyHidden: z.boolean(),
  includesSecrets: z.boolean(),
  secretsCount: z.number().int().min(0),
  members: z.array(z.object({ name: z.string(), role: z.string() })),
  files: z.array(
    z.object({
      id: uuid,
      path: z.string().regex(EXPORT_FILE_PATH),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().min(0),
      mime: z.string(),
    }),
  ),
  readable: z.object({
    included: z.boolean(),
    pdf: z.enum(['included', 'off', 'too_many_things', 'failed']),
  }),
}) satisfies z.ZodType<ExportManifest>;
