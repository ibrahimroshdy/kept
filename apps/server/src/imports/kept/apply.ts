import { type ExportEntity, type ImportEntityType, MODULE_IDS } from '@kept/shared';
import type pg from 'pg';
import { type EntityDef, entityDef, type Field, fieldsOf } from '../../exports/registry.js';
import { adoptCode, type CodeOutcome, type ImportedCode } from './codes.js';
import { type IdMap, importedId, isUuid } from './ids.js';

// Writing a Kept export's rows into the new location (step-7 plan T14, Q8, Q11).
//
// The rows are the export registry's (exports/registry.ts): each entity is one table, its fields
// that table's own columns. So one writer serves every entity, steps 4–6 included, and a column
// the registry adds is written without a change here:
// - the table and the columns come from the registry, never from the archive (D157);
// - every id is remapped (ids.ts): a row's own id to its new one, a reference to the new id of
//   what it names when the export holds that row, else to nothing (null), or, for a reference
//   that can't be null, the row is left out; ids inside JSON (a custom field naming a person, a
//   template's payload) are remapped the same way;
// - `location_id` is the new location, `owner_account_id` its account; the users of the old
//   server are not this one's, so `created_by` (and `logged_by`, `checked_by`) is the importing
//   person (Q11), and `created_via` is `import`;
// - each row is inserted as the importing person, under row-level security and every check and
//   guard the table has, `ON CONFLICT DO NOTHING`: a resumed chunk meets its own rows and moves on.
//
// The account's registries (types and their fields, place kinds, brands, vendors, people, tags,
// templates) are matched before they are made: a built-in type by its key, the rest by
// normalised name (kept.normalize, the CSV import's rule), so importing into an account that
// already has "Bosch" or "Bike" uses those. A matched person keeps their own contact details.
//
// Rows of the entities that need it are put in order first (sortRows): a parent place before its
// children, a container before what it holds, a type before its sub-types, a document before the
// one that supersedes it.

/** The order rows are applied in: whatever a row names comes before it. */
export const APPLY_ORDER: readonly ExportEntity[] = [
  'location',
  'place-kinds',
  'types',
  'type-fields',
  'brands',
  'vendors',
  'people',
  'person-contacts',
  'tags',
  'templates',
  'template-locations',
  'fx-rates',
  'places',
  'files',
  'purchases',
  'purchase-lines',
  'things',
  'codes',
  'legacy-codes',
  'thing-tags',
  'thing-links',
  'meters',
  'readings',
  'meter-events',
  'stock-rules',
  'box-checks',
  'box-check-lines',
  'warranties',
  'incidents',
  'claims',
  'loans',
  'valuations',
  'incident-things',
  'expiring-documents',
  'schedules',
  'service-records',
  'service-lines',
  'service-completions',
  'fuel-entries',
  'attachments',
  'secret-field-policies',
  // After the things and their codes: a numbering location numbers new things only (0046).
  'own-code-settings',
];

/**
 * Entities written by match-or-make: cheap, and run again in full when a job resumes, since the
 * id map's matches live in memory.
 */
export const REGISTRY_ENTITIES: ReadonlySet<ExportEntity> = new Set([
  'location',
  'place-kinds',
  'types',
  'type-fields',
  'brands',
  'vendors',
  'people',
  'person-contacts',
  'tags',
  'templates',
  'template-locations',
  'fx-rates',
]);

/** Not written: own_code_counters moves only through kept.next_own_code(), which skips a number
 * already taken, so a numbering location goes on without colliding with the imported codes. */
export const NOT_APPLIED: ReadonlySet<ExportEntity> = new Set(['own-code-counters', 'history']);

/** What import_source_ids calls an entity, where it names it. */
export const SOURCE_ID_TYPES: Partial<Record<ExportEntity, ImportEntityType>> = {
  places: 'place',
  things: 'thing',
  purchases: 'purchase',
  attachments: 'attachment',
  files: 'file',
  tags: 'tag',
  types: 'type',
  'type-fields': 'type_field',
  brands: 'brand',
  vendors: 'vendor',
  people: 'person',
  templates: 'template',
  meters: 'meter',
  readings: 'reading',
  'box-checks': 'box_check',
  'stock-rules': 'stock_rule',
  warranties: 'warranty',
  'service-records': 'service_record',
  schedules: 'schedule',
  loans: 'loan',
  claims: 'claim',
  incidents: 'incident',
  valuations: 'valuation',
  'expiring-documents': 'expiring_document',
  'fuel-entries': 'fuel_entry',
  'service-lines': 'service_line',
};

export type Row = Record<string, unknown>;

/** The old ids the import holds, and those whose row couldn't be written. */
export class Known {
  private readonly ids = new Set<string>();

  add(id: unknown): void {
    if (isUuid(id)) this.ids.add(id.toLowerCase());
  }

  has(id: string): boolean {
    return this.ids.has(id.toLowerCase());
  }

  /** A row that couldn't be written: what names it gets nothing instead. */
  drop(id: unknown): void {
    if (isUuid(id)) this.ids.delete(id.toLowerCase());
  }

  get size(): number {
    return this.ids.size;
  }
}

/** `generated`: a generated column (warranties.effective_ends_on) is the table's to compute;
 * the export carries its value, and writing it is an error. */
type ColumnInfo = { name: string; nullable: boolean; hasDefault: boolean; generated: boolean };

export type ApplyCtx = {
  client: pg.ClientBase;
  runId: string;
  locationId: string;
  accountId: string;
  ids: IdMap;
  known: Known;
  /** The new location's Unplaced area (D118): the old one's place, and a thing's when its
   * container isn't here. */
  unplacedId: string;
  /** Table columns as kept_app sees them, by table (columnsOf). */
  columns: Map<string, ColumnInfo[]>;
};

export type Applied =
  | { status: 'inserted' | 'matched' | 'existing'; newId: string | null; code?: CodeOutcome }
  | { status: 'skipped'; reason: string };

const USER_COLUMNS = ['created_by', 'logged_by', 'checked_by'] as const;

/** A table's columns, read once per job from the catalogue (only what kept_app may see). */
export async function columnsOf(
  client: pg.ClientBase,
  cache: Map<string, ColumnInfo[]>,
  table: string,
): Promise<ColumnInfo[]> {
  const hit = cache.get(table);
  if (hit) return hit;
  const { rows } = await client.query<{
    name: string;
    nullable: boolean;
    has_default: boolean;
    generated: boolean;
  }>(
    `SELECT column_name AS name, is_nullable = 'YES' AS nullable,
            column_default IS NOT NULL AS has_default, is_generated <> 'NEVER' AS generated
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const cols = rows.map((r) => ({
    name: r.name,
    nullable: r.nullable,
    hasDefault: r.has_default,
    generated: r.generated,
  }));
  cache.set(table, cols);
  return cols;
}

/** Old ids anywhere in a JSON value, remapped where the import holds them. */
export function remapJson(value: unknown, ids: IdMap, known: Known): unknown {
  if (typeof value === 'string') return isUuid(value) && known.has(value) ? ids.of(value) : value;
  if (Array.isArray(value)) return value.map((v) => remapJson(v, ids, known));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapJson(v, ids, known);
    return out;
  }
  return value;
}

/** The value written for one field, or `undefined` to leave the column to its default. */
function fieldValue(f: Field, row: Row, c: ApplyCtx): unknown {
  if (!(f.name in row)) return undefined;
  const v = row[f.name];
  if (v === null || v === undefined) return null;
  switch (f.kind) {
    case 'uuid':
      if (f.column === 'id') return c.ids.of(String(v));
      return typeof v === 'string' && c.known.has(v) ? c.ids.of(v) : null;
    case 'uuids':
      return Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string' && c.known.has(x))
            .map((x) => c.ids.of(x))
        : null;
    case 'json':
      return JSON.stringify(remapJson(v, c.ids, c.known));
    default:
      return v;
  }
}

/** The row's columns and values for its table, with the location, account and person filled. */
async function columnsAndValues(
  def: EntityDef,
  row: Row,
  c: ApplyCtx,
  override: Record<string, unknown> = {},
): Promise<{ cols: string[]; vals: unknown[]; refsMissing: string[] }> {
  const info = await columnsOf(c.client, c.columns, def.table);
  const has = new Set(info.filter((i) => !i.generated).map((i) => i.name));
  const nullable = new Map(info.map((i) => [i.name, i.nullable]));
  const cols: string[] = [];
  const vals: unknown[] = [];
  const refsMissing: string[] = [];
  const set = (col: string, val: unknown) => {
    const at = cols.indexOf(col);
    if (at >= 0) vals[at] = val;
    else {
      cols.push(col);
      vals.push(val);
    }
  };
  for (const f of fieldsOf(def)) {
    if (!has.has(f.column)) continue;
    const v = fieldValue(f, row, c);
    if (v === undefined) continue;
    if (
      f.kind === 'uuid' &&
      f.column !== 'id' &&
      v === null &&
      row[f.name] != null &&
      nullable.get(f.column) === false
    ) {
      refsMissing.push(f.column);
    }
    set(f.column, v);
  }
  if (has.has('location_id') && def.scope !== 'self') set('location_id', c.locationId);
  if (has.has('owner_account_id')) set('owner_account_id', c.accountId);
  if (has.has('created_via')) set('created_via', 'import');
  for (const u of USER_COLUMNS) if (has.has(u)) set(u, { sql: 'kept.current_user_id()' });
  // A trashed row comes as trashed, in one batch of the run's (its undo is the run's).
  if (has.has('trash_batch_id') && row.deletedAt) {
    set('trash_batch_id', importedId(c.runId, c.runId, 0));
  }
  for (const [k, v] of Object.entries(override)) if (has.has(k)) set(k, v);
  return { cols, vals, refsMissing };
}

/** INSERT … ON CONFLICT DO NOTHING; true when a row was written. */
async function insertRow(
  c: ApplyCtx,
  table: string,
  cols: string[],
  vals: unknown[],
): Promise<boolean> {
  const params: unknown[] = [];
  const places = vals.map((v) => {
    if (v && typeof v === 'object' && 'sql' in (v as object)) return (v as { sql: string }).sql;
    params.push(v);
    return `$${params.length}`;
  });
  const { rowCount } = await c.client.query(
    `INSERT INTO public."${table}" (${cols.map((x) => `"${x}"`).join(', ')})
     VALUES (${places.join(', ')})
     ON CONFLICT DO NOTHING`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

/** The generic write: the row as its table's row, inserted. */
async function writeGeneric(
  c: ApplyCtx,
  def: EntityDef,
  row: Row,
  override: Record<string, unknown> = {},
): Promise<Applied> {
  const { cols, vals, refsMissing } = await columnsAndValues(def, row, c, override);
  if (refsMissing.length > 0) {
    return { status: 'skipped', reason: `names something not imported (${refsMissing[0]})` };
  }
  const newId = typeof row.id === 'string' ? c.ids.of(row.id) : null;
  const inserted = await insertRow(c, def.table, cols, vals);
  return { status: inserted ? 'inserted' : 'existing', newId };
}

// ---------------------------------------------------------------------------------------------
// Registries: match, else make
// ---------------------------------------------------------------------------------------------

/** An existing row of the account by normalised name (or another key), or null. */
async function findInAccount(c: ApplyCtx, sql: string, values: unknown[]): Promise<string | null> {
  const { rows } = await c.client.query<{ id: string }>(sql, values);
  return rows[0]?.id ?? null;
}

/** Whether row `id` (already this server's) exists in `table`. */
async function exists(c: ApplyCtx, table: string, id: string): Promise<boolean> {
  const { rowCount } = await c.client.query(`SELECT 1 FROM public."${table}" WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

async function matchOrMake(
  c: ApplyCtx,
  def: EntityDef,
  row: Row,
  find: () => Promise<string | null>,
): Promise<Applied> {
  const oldId = String(row.id);
  const mine = c.ids.of(oldId);
  if (!c.ids.isMatched(oldId) && (await exists(c, def.table, mine))) {
    return { status: 'existing', newId: mine };
  }
  const found = await find();
  if (found) {
    c.ids.match(oldId, found);
    return { status: 'matched', newId: found };
  }
  return writeGeneric(c, def, row);
}

const byName = (table: string, column = 'name') =>
  `SELECT id FROM public."${table}"
    WHERE owner_account_id = $1 AND kept.normalize(${column}) = kept.normalize($2)
    ORDER BY id LIMIT 1`;

async function applyType(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  if (row.builtin === true || (row.builtinKey && row.builtin !== false)) {
    const found = await findInAccount(
      c,
      'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
      [row.builtinKey],
    );
    if (found) {
      c.ids.match(String(row.id), found);
      return { status: 'matched', newId: found };
    }
    // A built-in this server doesn't have (an older Kept): the account gets it as its own.
    return matchOrMake(c, def, { ...row, builtinKey: null }, () =>
      findInAccount(c, byName('types'), [c.accountId, row.name]),
    );
  }
  return matchOrMake(c, def, { ...row, builtinKey: null }, () =>
    findInAccount(c, byName('types'), [c.accountId, row.name]),
  );
}

async function applyTypeField(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  const typeOld = typeof row.typeId === 'string' ? row.typeId : null;
  const kindOld = typeof row.placeKindId === 'string' ? row.placeKindId : null;
  const parentOld = typeOld ?? kindOld;
  if (!parentOld || !c.known.has(parentOld)) {
    return { status: 'skipped', reason: 'its type is not imported' };
  }
  const parent = c.ids.of(parentOld);
  const column = typeOld ? 'type_id' : 'place_kind_id';
  const found = await findInAccount(
    c,
    `SELECT id FROM public.type_fields WHERE ${column} = $1 AND key = $2 ORDER BY id LIMIT 1`,
    [parent, row.key],
  );
  if (found) {
    c.ids.match(String(row.id), found);
    return { status: 'matched', newId: found };
  }
  // A field can't be added to a built-in type: its values stay in each thing's custom data.
  const { rows } = await c.client.query<{ builtin: boolean }>(
    `SELECT owner_account_id IS NULL AS builtin FROM public.${typeOld ? 'types' : 'place_kinds'}
      WHERE id = $1`,
    [parent],
  );
  if (rows[0]?.builtin) return { status: 'skipped', reason: 'a built-in type keeps its fields' };
  return writeGeneric(c, def, row);
}

async function applyPlaceKind(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  return matchOrMake(c, def, row, () =>
    findInAccount(
      c,
      `SELECT id FROM public.place_kinds
        WHERE (owner_account_id = $1 OR owner_account_id IS NULL) AND key = $2
        ORDER BY owner_account_id NULLS LAST LIMIT 1`,
      [c.accountId, row.key],
    ),
  );
}

async function applyPersonContact(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  const person = typeof row.personId === 'string' ? row.personId : null;
  if (!person || !c.known.has(person)) return { status: 'skipped', reason: 'no such person' };
  // A person matched to one already here keeps their own details.
  if (c.ids.isMatched(person)) return { status: 'matched', newId: null };
  return writeGeneric(c, def, row);
}

/** The location row: its settings onto the new location (what kept_app may change), and its
 * modules (the row's `modules`). Name, kind, timezone and currency were chosen with the target. */
async function applyLocation(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  c.ids.match(String(row.id), c.locationId);
  const settable = [
    'address',
    'latitude',
    'longitude',
    'suggest_radius_m',
    'money_visible_to_viewers',
    'require_2fa',
    'long_unseen_months',
    'languages',
  ];
  const fields = fieldsOf(def).filter((f) => settable.includes(f.column) && f.name in row);
  const { rows } = await c.client.query<{ col: string }>(
    `SELECT col FROM unnest($1::text[]) col
      WHERE has_column_privilege('public.locations', col, 'UPDATE')`,
    [fields.map((f) => f.column)],
  );
  const allowed = new Set(rows.map((r) => r.col));
  const sets: string[] = [];
  const vals: unknown[] = [c.locationId];
  for (const f of fields) {
    if (!allowed.has(f.column)) continue;
    const v = row[f.name];
    if (f.column === 'languages' && (!Array.isArray(v) || v.length === 0)) continue;
    vals.push(f.kind === 'json' ? JSON.stringify(v) : v);
    sets.push(`"${f.column}" = $${vals.length}`);
  }
  if (sets.length > 0) {
    await c.client.query(`UPDATE public.locations SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  const modules = Array.isArray(row.modules)
    ? row.modules.filter((m): m is string => (MODULE_IDS as readonly string[]).includes(String(m)))
    : null;
  if (modules) {
    await c.client.query(
      `INSERT INTO public.location_modules (location_id, module, enabled, enabled_at)
       SELECT $1, m, m = ANY($3::text[]), CASE WHEN m = ANY($3::text[]) THEN now() END
         FROM unnest($2::text[]) AS m
       ON CONFLICT (location_id, module) DO UPDATE
         SET enabled = excluded.enabled,
             enabled_at = CASE WHEN excluded.enabled AND NOT location_modules.enabled THEN now()
                               WHEN excluded.enabled THEN location_modules.enabled_at END
       WHERE location_modules.enabled IS DISTINCT FROM excluded.enabled`,
      [c.locationId, [...MODULE_IDS], modules],
    );
  }
  return { status: 'matched', newId: c.locationId };
}

// ---------------------------------------------------------------------------------------------
// Location rows that need a rule of their own
// ---------------------------------------------------------------------------------------------

async function applyPlace(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  if (row.isUnplaced === true) {
    c.ids.match(String(row.id), c.unplacedId);
    return { status: 'matched', newId: c.unplacedId };
  }
  return writeGeneric(c, def, row);
}

async function applyThing(c: ApplyCtx, def: EntityDef, row: Row): Promise<Applied> {
  const container = typeof row.containerId === 'string' && c.known.has(row.containerId);
  const place = typeof row.placeId === 'string' && c.known.has(row.placeId);
  // Exactly one parent (things_one_parent_chk): a container not here leaves it in Unplaced.
  const override = container
    ? { place_id: null }
    : { container_id: null, place_id: place ? c.ids.of(row.placeId as string) : c.unplacedId };
  return writeGeneric(c, def, row, override);
}

async function applyCode(c: ApplyCtx, row: Row): Promise<Applied> {
  const code = typeof row.code === 'string' ? row.code.trim().toUpperCase() : '';
  // Already here (a resumed chunk): ours, so nothing to do.
  const { rowCount } = await c.client.query(
    'SELECT 1 FROM public.short_ids WHERE code = $1 AND location_id = $2',
    [code, c.locationId],
  );
  if ((rowCount ?? 0) > 0) return { status: 'existing', newId: null };
  const ref = (v: unknown) => (typeof v === 'string' && c.known.has(v) ? c.ids.of(v) : null);
  const state = row.state === 'blank' || row.state === 'retired' ? row.state : 'assigned';
  const thingId = ref(row.thingId);
  const placeId = thingId ? null : ref(row.placeId);
  const imported: ImportedCode = {
    code,
    state: state === 'assigned' && !thingId && !placeId ? 'retired' : state,
    thingId,
    placeId,
    isPrimary: row.isPrimary === true,
    printedAt: typeof row.printedAt === 'string' ? row.printedAt : null,
  };
  const outcome = await adoptCode(c.client, c.runId, c.locationId, imported);
  if (outcome === 'dropped') return { status: 'skipped', reason: 'code_taken' };
  return { status: 'inserted', newId: null, code: outcome };
}

/**
 * Writes one row of `entity`. Throws when the database refuses it (the caller rolls the row's
 * savepoint back and reports it).
 */
export async function applyRow(c: ApplyCtx, entity: ExportEntity, row: Row): Promise<Applied> {
  const def = entityDef(entity);
  if (!def) return { status: 'skipped', reason: 'not an entity this server writes' };
  switch (entity) {
    case 'location':
      return applyLocation(c, def, row);
    case 'types':
      return applyType(c, def, row);
    case 'type-fields':
      return applyTypeField(c, def, row);
    case 'place-kinds':
      return applyPlaceKind(c, def, row);
    case 'brands':
    case 'vendors':
    case 'tags':
    case 'templates':
      return matchOrMake(c, def, row, () =>
        findInAccount(c, byName(def.table), [c.accountId, row.name]),
      );
    case 'people':
      return matchOrMake(c, def, row, () =>
        findInAccount(c, byName('people', 'display_name'), [c.accountId, row.displayName]),
      );
    case 'person-contacts':
      return applyPersonContact(c, def, row);
    case 'places':
      return applyPlace(c, def, row);
    case 'things':
      return applyThing(c, def, row);
    case 'codes':
      return applyCode(c, row);
    default:
      return writeGeneric(c, def, row);
  }
}

/** Remembers what a source id became (import_source_ids), where that table names the entity. */
export async function rememberSourceId(
  c: ApplyCtx,
  entity: ExportEntity,
  oldId: string,
  newId: string,
): Promise<void> {
  const type = SOURCE_ID_TYPES[entity];
  if (!type) return;
  await c.client.query(
    `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type, entity_id,
                                           run_id)
     VALUES ($1, 'kept_zip', $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [c.locationId, oldId.toLowerCase(), type, newId, c.runId],
  );
}

// ---------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------

/** The fields of an entity's rows that name rows of the same entity. */
const SELF_REFS: Partial<Record<ExportEntity, readonly string[]>> = {
  places: ['parentId'],
  things: ['containerId', 'splitFromId', 'mergedIntoId'],
  types: ['parentId', 'copiedFromId'],
  'expiring-documents': ['supersededById'],
};

export const needsOrder = (entity: ExportEntity): boolean =>
  entity in SELF_REFS || entity === 'codes';

/** A thing's or place's primary code first, so a secondary adopted before it never becomes the
 * primary (the adopt door makes the first assigned code of a target its primary). */
const primaryFirst = (r: Row): number => (r.isPrimary === true && r.state === 'assigned' ? 0 : 1);

/**
 * Rows in an order where each row comes after the rows of its own entity it names, otherwise as
 * they came (stable). A cycle (which the database refuses anyway) is broken where it is found.
 */
export function sortRows(entity: ExportEntity, rows: Row[]): Row[] {
  if (entity === 'codes') return [...rows].sort((x, y) => primaryFirst(x) - primaryFirst(y));
  const refs = SELF_REFS[entity];
  if (!refs) return rows;
  const byId = new Map<string, Row>();
  for (const r of rows) if (typeof r.id === 'string') byId.set(r.id.toLowerCase(), r);
  const out: Row[] = [];
  const state = new Map<Row, 1 | 2>();
  for (const start of rows) {
    if (state.get(start) === 2) continue;
    // Iterative depth-first: a row's references first.
    const stack: { row: Row; next: number }[] = [{ row: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { row: Row; next: number };
      if (top.next < refs.length) {
        const ref = top.row[refs[top.next] as string];
        top.next += 1;
        const dep = typeof ref === 'string' ? byId.get(ref.toLowerCase()) : undefined;
        if (dep && !state.has(dep)) {
          state.set(dep, 1);
          stack.push({ row: dep, next: 0 });
        }
        continue;
      }
      state.set(top.row, 2);
      out.push(top.row);
      stack.pop();
    }
  }
  return out;
}
