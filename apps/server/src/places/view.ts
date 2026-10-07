import {
  ATTACHMENT_ROLES,
  DERIVED_STATES,
  type DerivedState,
  FIELD_KINDS,
  tsQuery,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import { ATTACHMENT_SELECT, type AttachmentRow, attachmentViews } from '../files/views.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { filterOf, lowerIds, manyOf, matchOf, notOf } from '../http/list-filters.js';
import {
  derivedStatesOf,
  householdStateSql,
  isContainerSql,
  pathSql,
  SEARCH_STATES,
  type SearchState,
  STATE_SQL,
} from '../search/query.js';
import { thumbKeysOf, thumbUrlOf } from '../search/service.js';
import { customForView, type Gate, gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';

// What the API shows of places (T13; D45, D118, D160): the shapes of the web contract
// (apps/web/src/api/inventory/types.ts: PlaceNode, PlaceView, PlaceContents, ThingRow), plus the
// step-2 plan's T25 decisions: PathStep.isUnplaced and ThingRow.isContainer. Every read runs on
// the request's kept_app transaction, so row-level security decides what exists: a place in a
// location the caller can't see is simply not found (404, §7.7).

// ---------------------------------------------------------------------------------------------
// Response schemas (the serialiser keeps exactly these fields)
// ---------------------------------------------------------------------------------------------

export const PathStepSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
  /** The step's primary short ID, so a breadcrumb links by code (D208, T19). */
  shortCode: z.string().nullable().optional(),
});
export type PathStep = z.infer<typeof PathStepSchema>;

export const PlaceNodeSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  kindKey: z.string(),
  icon: z.string().nullable(),
  sort: z.number().int(),
  isUnplaced: z.boolean(),
  /** The primary short ID, for the place's `/p/<short-id>` address (D208); null until one exists. */
  shortCode: z.string().nullable(),
  thingCount: z.number().int(),
  childCount: z.number().int(),
});
export type PlaceNode = z.infer<typeof PlaceNodeSchema>;

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

const SecretSummarySchema = z.object({
  fieldKey: z.string(),
  label: z.string().nullable(),
  set: z.boolean(),
  canReveal: z.boolean(),
});

const FileViewSchema = z.object({
  id: z.uuid(),
  sha256: z.string(),
  bytes: z.number(),
  mime: z.string(),
  class: z.string(),
  hasGps: z.boolean(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  derivativeState: z.string(),
  thumbUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
});

const AttachmentViewSchema = z.object({
  id: z.uuid(),
  role: z.enum(ATTACHMENT_ROLES),
  sort: z.number().int(),
  file: FileViewSchema.nullable(),
  url: z.string().nullable(),
  subject: z.object({ placeId: z.uuid() }),
  createdBy: z.object({ displayName: z.string() }),
  rowVersion: z.number().int(),
});
type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const PlaceViewSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  kindKey: z.string(),
  icon: z.string().nullable(),
  isUnplaced: z.boolean(),
  path: z.array(PathStepSchema),
  shortCode: z.string().nullable(),
  fields: z.array(ResolvedFieldSchema),
  custom: z.record(z.string(), z.unknown()),
  secrets: z.array(SecretSummarySchema),
  counts: z.object({ places: z.number().int(), things: z.number().int() }),
  attachments: z.array(AttachmentViewSchema),
  rowVersion: z.number().int(),
});
export type PlaceView = z.infer<typeof PlaceViewSchema>;

export const ThingRowSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  shortCode: z.string().nullable(),
  name: z.string().nullable(),
  type: z
    .object({
      id: z.uuid(),
      icon: z.string(),
      name: z.string().nullable(),
      builtinKey: z.string().nullable(),
    })
    .nullable(),
  quantity: z.number(),
  lifecycle: z.string(),
  derivedState: z.array(z.enum(DERIVED_STATES)),
  path: z.array(PathStepSchema),
  containerThumbUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  isContainer: z.boolean(),
});
export type ThingRow = z.infer<typeof ThingRowSchema>;

export const PlaceContentsSchema = z.object({
  places: z.array(PlaceNodeSchema),
  things: z.object({ items: z.array(ThingRowSchema), next_cursor: z.string().nullable() }),
});
export type PlaceContents = z.infer<typeof PlaceContentsSchema>;

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type PlaceRow = {
  id: string;
  locationId: string;
  ownerAccountId: string;
  parentId: string | null;
  name: string;
  kindKey: string;
  icon: string | null;
  sort: number;
  isUnplaced: boolean;
  custom: Record<string, unknown>;
  deletedAt: Date | null;
  trashBatchId: string | null;
  rowVersion: number;
};

const PLACE_COLUMNS = `p.id, p.location_id, l.owner_account_id, p.parent_id, p.name, p.kind_key,
  p.icon, p.sort, p.is_unplaced, p.custom, p.deleted_at, p.trash_batch_id, p.row_version`;

type RawPlace = {
  id: string;
  location_id: string;
  owner_account_id: string;
  parent_id: string | null;
  name: string;
  kind_key: string;
  icon: string | null;
  sort: number;
  is_unplaced: boolean;
  custom: Record<string, unknown>;
  deleted_at: Date | null;
  trash_batch_id: string | null;
  row_version: number;
};

const placeRowOf = (r: RawPlace): PlaceRow => ({
  id: r.id,
  locationId: r.location_id,
  ownerAccountId: r.owner_account_id,
  parentId: r.parent_id,
  name: r.name,
  kindKey: r.kind_key,
  icon: r.icon,
  sort: r.sort,
  isUnplaced: r.is_unplaced,
  custom: r.custom ?? {},
  deletedAt: r.deleted_at,
  trashBatchId: r.trash_batch_id,
  rowVersion: r.row_version,
});

/**
 * A place the caller can see, or null. `trashed`: 'live' (the default) finds only places not in
 * the trash, 'any' finds both. `lock` takes the row lock a write needs (only a writer may).
 */
export async function findPlace(
  client: pg.ClientBase,
  id: string,
  opts: { trashed?: 'live' | 'any'; lock?: boolean } = {},
): Promise<PlaceRow | null> {
  const live = (opts.trashed ?? 'live') === 'live' ? 'AND p.deleted_at IS NULL' : '';
  const { rows } = await client.query<RawPlace>(
    `SELECT ${PLACE_COLUMNS}
       FROM public.places p JOIN public.locations l ON l.id = p.location_id
      WHERE p.id = $1 ${live} ${opts.lock ? 'FOR UPDATE OF p' : ''}`,
    [id],
  );
  const row = rows[0];
  return row ? placeRowOf(row) : null;
}

/** As findPlace, but 404 when there is none. */
export async function requirePlace(
  client: pg.ClientBase,
  id: string,
  opts: { trashed?: 'live' | 'any'; lock?: boolean } = {},
): Promise<PlaceRow> {
  const found = await findPlace(client, id, opts);
  if (!found) throw notFound();
  return found;
}

/** The location's Unplaced area (D118): every location has exactly one. */
export async function unplacedOf(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced',
    [locationId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`location ${locationId} has no Unplaced area`);
  return id;
}

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

const NODE_COLUMNS = `p.id, p.parent_id, p.name, p.kind_key, p.icon, p.sort, p.is_unplaced,
  (SELECT sc.code FROM public.short_ids sc
    WHERE sc.place_id = p.id AND sc.is_primary AND sc.state = 'assigned' LIMIT 1) AS short_code,
  (SELECT count(*) FROM public.things t
    WHERE t.place_id = p.id AND t.deleted_at IS NULL)::int AS thing_count,
  (SELECT count(*) FROM public.places c
    WHERE c.parent_id = p.id AND c.deleted_at IS NULL)::int AS child_count`;

type RawNode = {
  id: string;
  parent_id: string | null;
  name: string;
  kind_key: string;
  icon: string | null;
  sort: number;
  is_unplaced: boolean;
  short_code: string | null;
  thing_count: number;
  child_count: number;
};

const nodeOf = (r: RawNode): PlaceNode => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  kindKey: r.kind_key,
  icon: r.icon,
  sort: r.sort,
  isUnplaced: r.is_unplaced,
  shortCode: r.short_code,
  thingCount: r.thing_count,
  childCount: r.child_count,
});

/** Every live place of a location, flat (`parentId` makes the tree), in the tree's order. */
export async function placeNodes(client: pg.ClientBase, locationId: string): Promise<PlaceNode[]> {
  const { rows } = await client.query<RawNode>(
    `SELECT ${NODE_COLUMNS} FROM public.places p
      WHERE p.location_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.sort, lower(p.name), p.id`,
    [locationId],
  );
  return rows.map(nodeOf);
}

// ---------------------------------------------------------------------------------------------
// Place kinds and their fields (D160)
// ---------------------------------------------------------------------------------------------

export type PlaceKind = { id: string; key: string; archivedAt: Date | null };

/**
 * The place kind a key names in a location: the location's owner account's own kind, else the
 * built-in one. Null when neither exists.
 */
export async function placeKindOf(
  client: pg.ClientBase,
  ownerAccountId: string,
  key: string,
): Promise<PlaceKind | null> {
  const { rows } = await client.query<{ id: string; key: string; archived_at: Date | null }>(
    `SELECT k.id, k.key, k.archived_at FROM public.place_kinds k
      WHERE k.key = $2 AND (k.owner_account_id = $1 OR k.owner_account_id IS NULL)
      ORDER BY k.owner_account_id NULLS LAST LIMIT 1`,
    [ownerAccountId, key],
  );
  const row = rows[0];
  return row ? { id: row.id, key: row.key, archivedAt: row.archived_at } : null;
}

type RawField = {
  id: string;
  place_kind_id: string;
  key: string;
  label: string | null;
  kind: ResolvedField['kind'];
  unit: string | null;
  options: unknown;
  repeatable: boolean;
  required: boolean;
  secret: boolean;
  sort: number;
  archived_at: Date | null;
  row_version: number;
};

/** A place kind's fields, archived ones included (their values still need a definition to be
 * shown, customForView), in display order. */
export async function kindFields(
  client: pg.ClientBase,
  kind: PlaceKind | null,
): Promise<ResolvedField[]> {
  if (!kind) return [];
  const { rows } = await client.query<RawField>(
    `SELECT f.id, f.place_kind_id, f.key, f.label, f.kind, f.unit, f.options, f.repeatable,
            f.required, f.secret, f.sort, f.archived_at, f.row_version
       FROM public.type_fields f
      WHERE f.place_kind_id = $1
      ORDER BY f.sort, f.key`,
    [kind.id],
  );
  return rows.map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    labelKey: f.label === null ? f.key : null,
    kind: f.kind,
    unit: f.unit,
    options: Array.isArray(f.options) ? f.options.map(String) : null,
    repeatable: f.repeatable,
    required: f.required,
    secret: f.secret,
    sort: f.sort,
    archivedAt: f.archived_at ? f.archived_at.toISOString() : null,
    source: { typeId: f.place_kind_id, via: 'own' as const },
    rowVersion: f.row_version,
  }));
}

// ---------------------------------------------------------------------------------------------
// One place
// ---------------------------------------------------------------------------------------------

async function pathOfPlace(client: pg.ClientBase, placeId: string): Promise<PathStep[]> {
  const { rows } = await client.query<{ path: PathStep[] }>(
    `SELECT ${pathSql('$1::uuid', 'NULL::uuid')} AS path`,
    [placeId],
  );
  return (rows[0]?.path ?? []).map((s) => ({
    ...s,
    name: s.name ?? '',
    shortCode: s.shortCode ?? null,
  }));
}

async function primaryCode(client: pg.ClientBase, placeId: string): Promise<string | null> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT code FROM public.short_ids
      WHERE place_id = $1 AND is_primary AND state = 'assigned' LIMIT 1`,
    [placeId],
  );
  return rows[0]?.code ?? null;
}

async function secretsOf(
  client: pg.ClientBase,
  gate: Gate,
  placeId: string,
  fields: readonly ResolvedField[],
): Promise<PlaceView['secrets']> {
  // With the secrets module off, the place shows no secret fields at all (D116).
  if (!gate.showSecrets) return [];
  const secretFields = fields.filter((f) => f.secret && f.archivedAt === null);
  if (secretFields.length === 0) return [];
  const { rows } = await client.query<{ field_key: string; can_reveal: boolean }>(
    'SELECT field_key, can_reveal FROM kept.secret_fields_set(NULL::uuid, $1::uuid)',
    [placeId],
  );
  const set = new Map(rows.map((r) => [r.field_key, r.can_reveal]));
  const { rows: policy } = await client.query<{ type_field_id: string; can: boolean }>(
    `SELECT f.id AS type_field_id, kept.can_reveal_secret($1::uuid, f.id) AS can
       FROM unnest($2::uuid[]) AS f(id)`,
    [gate.locationId, secretFields.map((f) => f.id)],
  );
  const canById = new Map(policy.map((r) => [r.type_field_id, r.can]));
  return secretFields.map((f) => ({
    fieldKey: f.key,
    label: f.label,
    set: set.has(f.key),
    canReveal: canById.get(f.id) === true,
  }));
}

/** A place's attachments (D155, D160), as the web's AttachmentView (files/views.ts, which reads
 * the derivatives' own storage keys: a copy made by a cross-account move shares its source's
 * blobs, D161). File URLs are short-lived signed URLs of the derivatives (D157); originals are
 * fetched through the files routes. */
async function attachmentsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  placeId: string,
): Promise<AttachmentView[]> {
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.place_id = $1 ORDER BY a.sort, a.created_at, a.id`,
    [placeId],
  );
  return (await attachmentViews(client, files, rows)).map((a) => ({
    ...a,
    subject: { placeId },
    createdBy: { displayName: a.createdBy.displayName || 'A former member' },
  }));
}

/** GET /api/v1/places/:id: the whole view, gated for the caller (money in custom, secrets). */
export async function placeView(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  place: PlaceRow,
): Promise<PlaceView> {
  const gate = await gateFor(tx, place.locationId, scope);
  const kind = await placeKindOf(client, place.ownerAccountId, place.kindKey);
  const fields = await kindFields(client, kind);
  const { rows } = await client.query<{ places: number; things: number }>(
    `SELECT (SELECT count(*) FROM public.places c
              WHERE c.parent_id = $1 AND c.deleted_at IS NULL)::int AS places,
            (SELECT count(*) FROM public.things t
              WHERE t.place_id = $1 AND t.deleted_at IS NULL)::int AS things`,
    [place.id],
  );
  return {
    id: place.id,
    locationId: place.locationId,
    parentId: place.parentId,
    name: place.name,
    kindKey: place.kindKey,
    icon: place.icon,
    isUnplaced: place.isUnplaced,
    path: await pathOfPlace(client, place.id),
    shortCode: await primaryCode(client, place.id),
    fields,
    custom: customForView(gate, fields, place.custom),
    secrets: await secretsOf(client, gate, place.id, fields),
    counts: { places: rows[0]?.places ?? 0, things: rows[0]?.things ?? 0 },
    attachments: await attachmentsOf(client, files, place.id),
    rowVersion: place.rowVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Contents (screens §5: places first, then things)
// ---------------------------------------------------------------------------------------------

export const CONTENTS_SORTS = ['name', 'updated', 'lastSeen'] as const;
export const CONTENTS_GROUPS = ['type', 'none'] as const;

/** The contents list's filters: each takes several values, and "is none of" (D205). */
export const CONTENTS_FILTERS = ['type', 'tag', 'state', 'brand', 'belongsTo'] as const;

export const ContentsQuery = z.object({
  q: z.string().trim().max(200).optional(),
  type: manyOf(z.uuid()).optional(),
  tag: manyOf(z.uuid()).optional(),
  state: manyOf(z.enum(SEARCH_STATES)).optional(),
  brand: manyOf(z.uuid()).optional(),
  /** Whose it is (`belongs_to_person_id`). */
  belongsTo: manyOf(z.uuid()).optional(),
  not: notOf(CONTENTS_FILTERS).optional(),
  group: z.enum(CONTENTS_GROUPS).optional(),
  sort: z.enum(CONTENTS_SORTS).optional(),
  /** The order (D211): `asc` or `desc`. Absent, the sort's own: A to Z for the name, newest
   * first for the dates. */
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
});
export type ContentsQuery = z.infer<typeof ContentsQuery>;

/** The keyset of a contents page: the group key, the sort key, the id. */
const ContentsCursor = z.object({ g: z.string().max(400), s: z.string().max(400), id: z.uuid() });
type ContentsCursor = z.infer<typeof ContentsCursor>;

type RawThing = {
  id: string;
  location_id: string;
  name: string | null;
  quantity: string;
  lifecycle: string;
  location_uncertain: boolean;
  review_state: string;
  in_repair: boolean;
  loan_direction: 'out' | 'in' | null;
  last_seen_at: Date | null;
  short_code: string | null;
  type_id: string | null;
  type_icon: string | null;
  type_name: string | null;
  type_builtin_key: string | null;
  thumb_file_id: string | null;
  is_container: boolean;
  g: string;
  s: string;
};

/** Derived as every thing list derives them (search/query.ts derivedStatesOf). */
const derivedStateOf = (r: RawThing): DerivedState[] => derivedStatesOf(r);

/** Positional parameters for one statement. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** A name contains the (normalised) query: the contents list's quick filter (D42). */
const nameHas = (col: string, q: string) =>
  `strpos(kept.normalize(${col}), kept.normalize(${q}::text)) > 0`;

/** GET /api/v1/places/:id/contents: the live child places, then one page of the live things
 * directly in the place (a container's contents stay inside it). */
export async function placeContents(
  client: pg.ClientBase,
  files: FileStorage | null,
  place: PlaceRow,
  query: ContentsQuery,
): Promise<PlaceContents> {
  const q = query.q ?? '';

  const pp = new Params();
  const placeWhere = [`p.parent_id = ${pp.add(place.id)}::uuid`, 'p.deleted_at IS NULL'];
  if (q) placeWhere.push(nameHas('p.name', pp.add(q)));
  const { rows: placeRows } = await client.query<RawNode>(
    `SELECT ${NODE_COLUMNS} FROM public.places p WHERE ${placeWhere.join(' AND ')}
      ORDER BY p.sort, lower(p.name), p.id`,
    pp.values,
  );

  const p = new Params();
  const where = [`t.place_id = ${p.add(place.id)}::uuid`, 't.deleted_at IS NULL'];
  if (q) {
    const tsq = tsQuery(q);
    const byName = nameHas('t.name', p.add(q));
    where.push(
      tsq ? `(${byName} OR t.search_tsv @@ to_tsquery('simple', ${p.add(tsq)}::text))` : byName,
    );
  }
  // Each filter "is any of" its values or, named in `not`, "none of" them (D205): a thing with
  // no type, tag, brand or owner is "none of" any (http/list-filters.ts).
  const many = (
    values: readonly string[] | undefined,
    name: string,
    cond: (ids: string) => string,
  ) => {
    const f = filterOf(lowerIds(values), name, query.not);
    if (f) where.push(matchOf(cond(`${p.add(f.values)}::uuid[]`), f.not));
  };
  many(query.type, 'type', (ids) => `t.type_id = ANY (${ids})`);
  many(
    query.tag,
    'tag',
    (ids) => `EXISTS (SELECT 1 FROM public.thing_tags g
                       WHERE g.thing_id = t.id AND g.tag_id = ANY (${ids}))`,
  );
  many(query.brand, 'brand', (ids) => `t.brand_id = ANY (${ids})`);
  many(query.belongsTo, 'belongsTo', (ids) => `t.belongs_to_person_id = ANY (${ids})`);
  const state = filterOf(query.state, 'state', query.not);
  if (state) {
    where.push(
      matchOf(`(${state.values.map((x) => STATE_SQL[x as SearchState]).join(' OR ')})`, state.not),
    );
  }

  const sort = query.sort ?? 'name';
  const grouped = query.group === 'type';
  // Grouped by type: typed things first, by built-in key or name, untyped ones last.
  const g = grouped
    ? `CASE WHEN ty.id IS NULL THEN '1' ELSE '0' || coalesce(ty.builtin_key, lower(ty.name)) END`
    : `''`;
  const sortCol =
    sort === 'updated' ? 't.updated_at' : sort === 'lastSeen' ? 't.last_seen_at' : null;
  const s = sortCol ? `${sortCol}::text` : `lower(coalesce(t.name, ''))`;
  // D211: the name A to Z and the dates newest first, unless `dir` turns them around.
  const desc = query.dir ? query.dir === 'desc' : sortCol !== null;

  let after = '';
  if (query.cursor) {
    const parsed = ContentsCursor.safeParse(decodeCursor(query.cursor));
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    const c: ContentsCursor = parsed.data;
    const cg = p.add(c.g);
    const cs = p.add(c.s);
    const cid = p.add(c.id);
    const key = sortCol ? sortCol : s;
    const cast = sortCol ? 'timestamptz' : 'text';
    after = `AND (${g} > ${cg}::text OR (${g} = ${cg}::text AND (${key} ${desc ? '<' : '>'} ${cs}::${cast}
             OR (${key} = ${cs}::${cast} AND t.id > ${cid}::uuid))))`;
  }
  const order = `g, ${sortCol ?? 's'} ${desc ? 'DESC' : 'ASC'}, t.id`;

  const { rows } = await client.query<RawThing>(
    `SELECT t.id, t.location_id, t.name, t.quantity::text AS quantity, t.lifecycle,
            t.location_uncertain, t.review_state, t.last_seen_at,
            (SELECT sc.code FROM public.short_ids sc
              WHERE sc.thing_id = t.id AND sc.is_primary AND sc.state = 'assigned' LIMIT 1)
              AS short_code,
            ty.id AS type_id, ty.icon AS type_icon, ty.name AS type_name,
            ty.builtin_key AS type_builtin_key,
            (SELECT a.file_id FROM public.attachments a
               JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
              WHERE a.thing_id = t.id AND a.role = 'photo'
              ORDER BY a.sort, a.created_at, a.id LIMIT 1) AS thumb_file_id,
            ${isContainerSql('t.id', 't.type_id')} AS is_container,
            ${householdStateSql('t')},
            ${g} AS g, ${s} AS s
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE ${where.join('\n AND ')} ${after}
      ORDER BY ${order}
      LIMIT ${p.add(query.limit + 1)}`,
    p.values,
  );

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  // Every row is directly in this place (`t.place_id` is its id, so no container: D45's one
  // parent), so every row has the place's own breadcrumb: read it once, not once a row. Per row,
  // kept.path_of() ran its lookups under the policies again for each of up to 200 rows, most of
  // the page's time (task 24's benchmark: 82 ms of a 200-row page on the laptop).
  const path = page.length > 0 ? await pathOfPlace(client, place.id) : [];
  const keys = files
    ? await thumbKeysOf(
        client,
        page.map((r) => r.thumb_file_id),
      )
    : new Map();
  const items: ThingRow[] = await Promise.all(
    page.map(async (r) => ({
      id: r.id,
      locationId: r.location_id,
      shortCode: r.short_code,
      name: r.name,
      type:
        r.type_id && r.type_icon
          ? { id: r.type_id, icon: r.type_icon, name: r.type_name, builtinKey: r.type_builtin_key }
          : null,
      quantity: Number(r.quantity),
      lifecycle: r.lifecycle,
      derivedState: derivedStateOf(r),
      path,
      containerThumbUrl: null,
      thumbUrl: await thumbUrlOf(files, keys, r.thumb_file_id),
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
      isContainer: r.is_container,
    })),
  );
  return {
    places: placeRows.map(nodeOf),
    things: {
      items,
      next_cursor:
        rows.length > query.limit && last
          ? encodeCursor({ g: last.g, s: last.s, id: last.id })
          : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Who changed it (the 412 body, D156)
// ---------------------------------------------------------------------------------------------

/** The display name of whoever last changed a place, from its latest audit event. */
export async function lastChangedBy(
  client: pg.ClientBase,
  placeId: string,
): Promise<{ displayName: string } | null> {
  // Only a person's event names someone: a token's, an import's or the system's actor_id is not
  // a user id, even when it happens to equal one.
  const { rows } = await client.query<{ is_user: boolean; display_name: string | null }>(
    `SELECT e.actor_type = 'user' AS is_user, up.display_name FROM public.audit_events e
       LEFT JOIN public.user_profiles up ON e.actor_type = 'user' AND up.user_id = e.actor_id
      WHERE e.entity_type = 'place' AND e.entity_id = $1
      ORDER BY e.at DESC, e.id DESC LIMIT 1`,
    [placeId],
  );
  const row = rows[0];
  if (!row?.is_user) return null;
  return { displayName: row.display_name ?? 'A former member' };
}
