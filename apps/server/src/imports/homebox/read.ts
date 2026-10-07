import { HB_SEEDED_PLACES, HB_SEEDED_TAGS } from '@kept/shared';
import { z } from 'zod';
import { ArchiveError } from '../../portability/zip/limits.js';
import {
  expectNames,
  type OpenArchive,
  openArchive,
  UUID_ENTRY,
} from '../../portability/zip/read.js';
import type { BlobStore } from '../../storage/blob-store.js';
import {
  HB_SCHEMA_VERSIONS,
  HB_TABLE_NAMES,
  HB_TABLES,
  type HbAttachment,
  type HbEntity,
  type HbEntityField,
  type HbEntityType,
  type HbMaintenance,
  type HbTableName,
  type HbTag,
  type HbTagEntity,
  type HbTemplate,
  type HbTemplateField,
  Manifest,
} from './format.js';

// Reading a Homebox export ZIP (D146; step-7 plan T9; spike H1) through the one safe archive
// reader (portability/zip/, D157). Only the expected names are ever opened: `manifest.json`, the
// nine tables, and `attachments/<uuid>` (each attachment row's file, by its row id). Everything
// else, `notifiers.json` included, is counted as ignored and never read.
//
// A household's tables are small, so they are loaded whole into maps keyed by UUID; the files
// stay in the archive and are streamed one at a time by the job (T10). A row that doesn't match
// its table's schema (format.ts) is left out and reported, never a crash; a manifest that can't
// be read, or a schema version this reader hasn't seen, refuses the archive.
//
// The tree (T0, V25): an entity's parent is its `entity_children` column. Places are the
// entities whose type has `is_location`; the rest are things. v0.27's location override
// (`entity_location_entities`, set only when the parent is an item) changes nothing here: in Kept
// a thing inside a container is where its container is, so the container wins. The collection is
// `manifest.groupId` (plan Q4: one ZIP, one collection; every row's group column equals it).

/** Which entries a Homebox export may hold that Kept reads. */
export const HOMEBOX_ENTRIES = expectNames(
  ['manifest.json', ...HB_TABLE_NAMES.map((t) => `${t}.json`)],
  [UUID_ENTRY('attachments')],
);

/** The entry of an attachment row's file. */
export const attachmentEntry = (attachmentId: string) => `attachments/${attachmentId}`;

/** A row that failed its table's schema: left out, and an issue in the dry run. */
export type HbBadRow = {
  table: HbTableName;
  index: number;
  id: string | null;
  name: string | null;
};

export type HomeboxData = {
  manifest: Manifest;
  types: Map<string, HbEntityType>;
  templates: HbTemplate[];
  templateFields: HbTemplateField[];
  tags: Map<string, HbTag>;
  /** In the archive's order. */
  entities: Map<string, HbEntity>;
  fields: HbEntityField[];
  maintenance: HbMaintenance[];
  attachments: HbAttachment[];
  tagEntities: HbTagEntity[];
  /** The attachment files the archive holds, by attachment id, with their declared sizes. */
  files: Map<string, number>;
  bad: HbBadRow[];
  /** Entries Kept doesn't read (notifiers.json among them), counted, never opened. */
  ignored: number;
};

/** Opens an uploaded Homebox export (`i/<runId>.zip`) and checks its whole directory. */
export function openHomebox(blobs: BlobStore, key: string, bytes: number): Promise<OpenArchive> {
  return openArchive(blobs, key, bytes, { expect: HOMEBOX_ENTRIES });
}

/** The manifest: ArchiveContentError when missing or unreadable, ArchiveError
 * `unsupported_version` for a schema version this reader hasn't seen. */
export async function readManifest(archive: OpenArchive): Promise<Manifest> {
  // A missing or unreadable manifest is ArchiveContentError: not a Homebox export Kept can read
  // (archive_invalid with no rule broken, imports/archive.ts).
  const manifest = await archive.json('manifest.json', Manifest);
  if (!HB_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    throw new ArchiveError('unsupported_version', `schemaVersion ${manifest.schemaVersion}`);
  }
  return manifest;
}

const Rows = z.array(z.unknown());

const idOf = (raw: unknown): string | null => {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id.toLowerCase().slice(0, 36) : null;
};
const nameOf = (raw: unknown): string | null => {
  const name = (raw as { name?: unknown; title?: unknown } | null)?.name;
  const title = (raw as { title?: unknown } | null)?.title;
  const text = typeof name === 'string' ? name : typeof title === 'string' ? title : null;
  return text ? text.slice(0, 200) : null;
};

/** The group column of the tables that carry one (H1). */
const GROUP_COLUMN: Partial<Record<HbTableName, string>> = {
  entity_types: 'group_entity_types',
  entity_templates: 'group_entity_templates',
  tags: 'group_tags',
  entities: 'group_entities',
};

/** Reads every table. A table the archive lacks is empty; a whole table that isn't a JSON array
 * is ArchiveContentError (not a Homebox export Kept can read). */
export async function readHomebox(archive: OpenArchive): Promise<HomeboxData> {
  const manifest = await readManifest(archive);
  const bad: HbBadRow[] = [];
  const parsed: { [K in HbTableName]: z.infer<(typeof HB_TABLES)[K]>[] } = {
    entity_types: [],
    entity_templates: [],
    template_fields: [],
    tags: [],
    entities: [],
    entity_fields: [],
    maintenance_entries: [],
    attachments: [],
    tag_entities: [],
  };
  for (const table of HB_TABLE_NAMES) {
    const entry = `${table}.json`;
    if (!archive.has(entry)) continue;
    const rows = await archive.json(entry, Rows);
    const schema = HB_TABLES[table] as z.ZodType;
    const group = GROUP_COLUMN[table];
    const out = parsed[table] as unknown[];
    rows.forEach((raw, index) => {
      const row = schema.safeParse(raw);
      const inGroup =
        !group ||
        (row.success &&
          (row.data as Record<string, string>)[group] === manifest.groupId.toLowerCase());
      if (row.success && inGroup) out.push(row.data);
      else bad.push({ table, index, id: idOf(raw), name: nameOf(raw) });
    });
  }

  const files = new Map<string, number>();
  for await (const e of archive.entries()) {
    if (e.name.startsWith('attachments/')) files.set(e.name.slice('attachments/'.length), e.size);
  }

  return {
    manifest,
    types: new Map(parsed.entity_types.map((r) => [r.id, r])),
    templates: parsed.entity_templates,
    templateFields: parsed.template_fields,
    tags: new Map(parsed.tags.map((r) => [r.id, r])),
    entities: new Map(parsed.entities.map((r) => [r.id, r])),
    fields: parsed.entity_fields,
    maintenance: parsed.maintenance_entries,
    attachments: parsed.attachments,
    tagEntities: parsed.tag_entities,
    files,
    bad,
    ignored: archive.ignored,
  };
}

// ---------------------------------------------------------------------------------------------
// The tree, and what the choices step needs
// ---------------------------------------------------------------------------------------------

/** Whether `e` is a place in Homebox's sense: its type has `is_location`. */
export const isLocation = (data: HomeboxData, e: HbEntity): boolean =>
  data.types.get(e.entity_type_entities)?.is_location === true;

/** Each entity's children, by parent id (entities whose parent is missing are roots). */
export function childrenOf(data: HomeboxData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of data.entities.values()) {
    const parent = e.entity_children;
    if (!parent || !data.entities.has(parent)) continue;
    const list = out.get(parent) ?? [];
    list.push(e.id);
    out.set(parent, list);
  }
  return out;
}

/** The ids of Homebox's seeded places and tags (H1) that are empty and unused: a seeded place at
 * the top with nothing inside, no template placing things there, and no file or record of its
 * own; a seeded tag on nothing, with no child tag and in no template's defaults. */
export function seededUnused(data: HomeboxData): { places: Set<string>; tags: Set<string> } {
  const children = childrenOf(data);
  const templatePlaces = new Set(
    data.templates.map((t) => t.entity_template_location).filter((x): x is string => !!x),
  );
  const withRecords = new Set([
    ...data.attachments.map((a) => a.entity_attachments),
    ...data.maintenance.map((m) => m.entity_id),
    ...data.fields.map((f) => f.entity_fields),
    ...data.tagEntities.map((t) => t.entity_id),
  ]);
  const places = new Set<string>();
  const seededPlaces = new Set<string>(HB_SEEDED_PLACES);
  for (const e of data.entities.values()) {
    if (!seededPlaces.has(e.name) || !isLocation(data, e)) continue;
    if (e.entity_children && data.entities.has(e.entity_children)) continue;
    if ((children.get(e.id)?.length ?? 0) > 0) continue;
    if (templatePlaces.has(e.id) || withRecords.has(e.id)) continue;
    places.add(e.id);
  }
  const usedTags = new Set(data.tagEntities.map((t) => t.tag_id));
  const parentTags = new Set(
    [...data.tags.values()].map((t) => t.tag_children).filter((x): x is string => !!x),
  );
  const templateTags = new Set(data.templates.flatMap((t) => templateTagIds(t)));
  const tags = new Set<string>();
  const seededTags = new Set<string>(HB_SEEDED_TAGS);
  for (const t of data.tags.values()) {
    if (!seededTags.has(t.name) || t.tag_children) continue;
    if (usedTags.has(t.id) || parentTags.has(t.id) || templateTags.has(t.id)) continue;
    tags.add(t.id);
  }
  return { places, tags };
}

/** A template's default tags: a JSON array of UUIDs encoded as a string (H1). Anything else is
 * none. */
export function templateTagIds(t: HbTemplate): string[] {
  if (!t.default_tag_ids) return [];
  try {
    const value: unknown = JSON.parse(t.default_tag_ids);
    return Array.isArray(value)
      ? value.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())
      : [];
  } catch {
    return [];
  }
}
