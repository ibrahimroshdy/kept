import { newId } from '@kept/shared';
import type pg from 'pg';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound, pgErrorOf } from '../http/errors.js';
import {
  type AccountAccess,
  auditRegistry,
  lastChangedBy,
  MANAGE_HINT,
  reindexUses,
  requireAccount,
  type WriteCtx,
} from '../registries/account.js';
import {
  FIELD_COLUMNS,
  type FieldRow,
  fieldOf,
  Redefined,
  TYPE_COLUMNS,
  TypeGraph,
  type TypePatch,
  type TypeRow,
} from './graph.js';
import type {
  CreateFieldBody,
  CreateTypeBody,
  ResolvedField,
  TypeDetail,
  TypeNode,
  UpdateFieldBody,
  UpdateTypeBody,
} from './view.js';

// Types and their fields (T11; D92, D123, D154, D172, D177, D192; engineering spec §7.9,
// §7.13; plan Q3, Q4, Q13b). Built-ins are read-only templates: editing one answers 409
// `reason: 'builtin'` and the client offers Customise, which copies it (and its built-in
// subtree) into the account through kept.customise_type(). An account's types are managed by
// its owners and admins (`registries-types.manage`), in every location of the account, including
// ones they can't see: merging and customising go through the definers (0021, 0024), and a
// preview counts hidden locations without naming them (kept.type_impact). Every write is an
// account-level audit row (Q15).

export type ConflictReason = 'cycle' | 'field_redefined' | 'builtin' | 'in_use';

/** 409 with the `reason` the web shows (T28 contract decision 2). */
export function typeConflict(
  reason: ConflictReason,
  extra: Record<string, unknown> = {},
): AppError {
  const hints: Record<ConflictReason, string> = {
    cycle:
      "A type can't sit under itself or one of its descendants. Pick a parent outside this branch.",
    field_redefined:
      'That field key is already used by this type, one it inherits from, or one below it. Pick another key.',
    builtin: 'Built-in types are customised first: use Customise to make an editable copy.',
    in_use: 'This type is in use. Move its things and child types first.',
  };
  return new AppError(reason === 'in_use' ? 'in_use' : 'conflict', 409, hints[reason], {
    reason,
    ...extra,
  });
}

/** The database's own refusals, as the same 409s (a race past the checks here). */
export function mapTypeErrors(err: unknown): never {
  const pg = pgErrorOf(err);
  if (pg?.constraint === 'types_no_loop') throw typeConflict('cycle');
  if (
    pg?.constraint === 'type_fields_inherited_key' ||
    pg?.constraint === 'type_fields_type_key_uq'
  ) {
    const key = /field key (\S+) is already defined/.exec((err as Error).message ?? '')?.[1];
    throw typeConflict('field_redefined', key ? { key } : {});
  }
  if (
    pg?.constraint === 'types_merge_secret_fields' ||
    pg?.constraint === 'types_merge_secret_policy'
  ) {
    throw new AppError(
      'conflict',
      409,
      'A secret value would lose its field or change who may reveal it; only the location owner may merge these.',
    );
  }
  throw err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapTypeErrors(err);
  }
}

async function typeRow(client: pg.ClientBase, id: string, lock = false): Promise<TypeRow> {
  const { rows } = await client.query<TypeRow>(
    `SELECT ${TYPE_COLUMNS} FROM public.types t WHERE t.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** An account type the caller may change, locked: 404, then 409 builtin, then 403. */
async function editableType(
  client: pg.ClientBase,
  id: string,
): Promise<{ row: TypeRow; access: AccountAccess }> {
  const seen = await typeRow(client, id);
  if (seen.owner_account_id === null) throw typeConflict('builtin');
  const access = await requireAccount(
    client,
    seen.owner_account_id,
    'registries-types.manage',
    MANAGE_HINT,
  );
  return { row: await typeRow(client, id, true), access };
}

/** Live things per type in the account's locations the caller can see. */
async function inUseCounts(
  client: pg.ClientBase,
  accountId: string | null,
): Promise<Map<string, number>> {
  const { rows } = await client.query<{ type_id: string; n: number }>(
    `SELECT t.type_id, count(*)::int AS n
       FROM public.things t JOIN public.locations l ON l.id = t.location_id
      WHERE t.deleted_at IS NULL AND t.type_id IS NOT NULL
        AND ($1::uuid IS NULL OR l.owner_account_id = $1)
      GROUP BY t.type_id`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.type_id, r.n]));
}

function nodeOf(graph: TypeGraph, t: TypeRow, inUse: Map<string, number>): TypeNode {
  return {
    id: t.id,
    parentId: t.parent_id,
    builtinKey: graph.builtinKeyOf(t),
    name: t.name,
    icon: t.icon,
    colour: t.colour,
    capabilities: t.capabilities,
    resolvedCapabilities: graph.capabilities(t),
    isFieldGroup: t.is_field_group,
    fieldGroups: t.field_groups,
    copiedFromId: t.copied_from_id,
    inUse: inUse.get(t.id) ?? 0,
    rowVersion: t.row_version,
    archivedAt: t.archived_at ? t.archived_at.toISOString() : null,
  };
}

/** The audit image of a type (its editable columns). */
const typeImage = (t: TypeRow) => ({
  parent_id: t.parent_id,
  name: t.name,
  icon: t.icon,
  colour: t.colour,
  capabilities: t.capabilities,
  default_meter: t.default_meter,
  field_groups: t.field_groups,
  default_warranty_months: t.default_warranty_months,
  archived_at: t.archived_at,
});

const fieldImage = (f: FieldRow) => ({
  type_id: f.type_id,
  place_kind_id: f.place_kind_id,
  key: f.key,
  label: f.label,
  kind: f.kind,
  unit: f.unit,
  options: f.options,
  repeatable: f.repeatable,
  required: f.required,
  sort: f.sort,
  secret: f.secret,
  archived_at: f.archived_at,
});

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function listTypes(
  client: pg.ClientBase,
  accountId: string,
  includeArchived: boolean,
): Promise<TypeNode[]> {
  await requireAccount(client, accountId);
  const graph = await TypeGraph.load(client, accountId);
  const inUse = await inUseCounts(client, accountId);
  return [...graph.types.values()]
    .filter((t) => includeArchived || !t.archived_at)
    .sort(
      (a, b) =>
        Number(a.owner_account_id !== null) - Number(b.owner_account_id !== null) ||
        (a.name ?? graph.builtinKeyOf(a) ?? '').localeCompare(
          b.name ?? graph.builtinKeyOf(b) ?? '',
        ) ||
        a.id.localeCompare(b.id),
    )
    .map((t) => nodeOf(graph, t, inUse));
}

async function detailOf(client: pg.ClientBase, id: string): Promise<TypeDetail> {
  const t = await typeRow(client, id);
  const graph = await TypeGraph.load(client, t.owner_account_id);
  const row = graph.get(id) ?? t;
  const inUse = await inUseCounts(client, t.owner_account_id);
  let fields: ResolvedField[];
  try {
    fields = graph.fields(row);
  } catch (err) {
    if (!(err instanceof Redefined)) throw err;
    fields = []; // the guards make this unreachable; never fail a read over it
  }
  return {
    ...nodeOf(graph, row, inUse),
    fields,
    defaultMeter: row.default_meter,
    defaultWarrantyMonths: row.default_warranty_months,
  };
}

export const getType = detailOf;

/** What a change to `id` would touch (D92, D123), read-only: POST …/preview. */
export async function previewType(client: pg.ClientBase, id: string, body: UpdateTypeBody) {
  const t = await typeRow(client, id);
  // The preview answers what the PATCH would do, so it asks what the PATCH asks: the account's
  // owners and admins (a member or viewer who can see the type gets 403, like the write). A
  // built-in has no account; the PATCH refuses it (409), and type_impact() hides locations.
  if (t.owner_account_id !== null) {
    await requireAccount(client, t.owner_account_id, 'registries-types.manage', MANAGE_HINT);
  }
  const graph = await TypeGraph.load(client, t.owner_account_id);
  const row = graph.get(id) ?? t;
  const { rows } = await client.query<{
    location_id: string | null;
    location_name: string | null;
    things: number;
  }>('SELECT location_id, location_name, things FROM kept.type_impact($1)', [id]);
  let fieldsToArchive: string[] = [];
  try {
    const patch: TypePatch = {};
    if (body.parentId !== undefined) patch.parentId = body.parentId;
    if (body.fieldGroups !== undefined) patch.fieldGroups = body.fieldGroups;
    const after = new Set(graph.fields(row, new Map([[id, patch]])).map((f) => f.key));
    fieldsToArchive = graph
      .fields(row)
      .filter((f) => !f.archivedAt && !after.has(f.key))
      .map((f) => f.key);
  } catch (err) {
    if (!(err instanceof Redefined)) throw err;
    // The PATCH refuses it with the reason; the preview just can't list the fields.
  }
  return {
    descendants: graph
      .descendants(id)
      .map((d) => ({ id: d.id, name: d.name, builtinKey: graph.builtinKeyOf(d) })),
    perLocation: rows
      .filter((r) => r.location_id !== null)
      .map((r) => ({ locationId: r.location_id, name: r.location_name, things: r.things })),
    hiddenLocations: rows.filter((r) => r.location_id === null).length,
    fieldsToArchive,
  };
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** The parent and groups a type may take: built in or the account's, a parent no group. */
function checkRefs(
  graph: TypeGraph,
  parentId: string | null | undefined,
  groups: string[] | undefined,
) {
  if (parentId) {
    const parent = graph.get(parentId);
    if (!parent || parent.is_field_group) throw notFound('No such parent type.');
  }
  for (const g of groups ?? []) {
    if (!graph.get(g)?.is_field_group) throw notFound('No such field group.');
  }
}

export async function createType(
  ctx: WriteCtx,
  accountId: string,
  body: CreateTypeBody,
): Promise<TypeDetail> {
  const { client } = ctx;
  await requireAccount(client, accountId, 'registries-types.manage', MANAGE_HINT);
  const id = body.id ? assertClientId(body.id) : newId();
  const graph = await TypeGraph.load(client, accountId);
  const groups = [...new Set(body.fieldGroups ?? [])];
  checkRefs(graph, body.parentId, groups);
  const draft: TypeRow = {
    id,
    owner_account_id: accountId,
    builtin_key: null,
    copied_from_id: null,
    parent_id: body.parentId,
    name: body.name,
    icon: body.icon,
    colour: body.colour ?? null,
    capabilities: body.capabilities,
    default_meter: body.defaultMeter ?? null,
    is_field_group: false,
    field_groups: groups,
    default_warranty_months: null,
    archived_at: null,
    row_version: 1,
  };
  try {
    graph.fields(draft);
  } catch (err) {
    if (err instanceof Redefined) throw typeConflict('field_redefined', { key: err.key });
    throw err;
  }
  await guarded(() =>
    client.query(
      `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon, colour, capabilities,
                                 field_groups, default_meter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        accountId,
        body.parentId,
        body.name,
        body.icon,
        body.colour ?? null,
        body.capabilities,
        groups,
        body.defaultMeter === undefined ? null : JSON.stringify(body.defaultMeter),
      ],
    ),
  );
  const created = await typeRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'type.create',
    entity: { type: 'type', id },
    after: typeImage(created),
    requestId: ctx.requestId,
  });
  return detailOf(client, id);
}

const TYPE_UPDATE_COLUMNS: Record<keyof UpdateTypeBody, string> = {
  name: 'name',
  icon: 'icon',
  colour: 'colour',
  capabilities: 'capabilities',
  parentId: 'parent_id',
  fieldGroups: 'field_groups',
  defaultWarrantyMonths: 'default_warranty_months',
};

export async function updateType(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateTypeBody,
): Promise<TypeDetail> {
  const { client } = ctx;
  const { row: before } = await editableType(client, id);
  if (before.row_version !== expected) {
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, 'type', id),
    );
  }
  const graph = await TypeGraph.load(client, before.owner_account_id);
  const groups = body.fieldGroups ? [...new Set(body.fieldGroups)] : undefined;
  checkRefs(graph, body.parentId, groups);
  if (body.parentId !== undefined && graph.wouldLoop(id, body.parentId))
    throw typeConflict('cycle');
  const patch: TypePatch = {};
  if (body.parentId !== undefined) patch.parentId = body.parentId;
  if (groups) patch.fieldGroups = groups;
  try {
    graph.check(graph.get(id) ?? before, patch);
  } catch (err) {
    if (err instanceof Redefined) throw typeConflict('field_redefined', { key: err.key });
    throw err;
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, column] of Object.entries(TYPE_UPDATE_COLUMNS) as [
    keyof UpdateTypeBody,
    string,
  ][]) {
    const value = field === 'fieldGroups' ? groups : body[field];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  await guarded(() =>
    client.query(`UPDATE public.types SET ${sets.join(', ')} WHERE id = $1`, values),
  );
  const after = await typeRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id as string,
    userId: ctx.userId,
    action: 'type.update',
    entity: { type: 'type', id },
    before: typeImage(before),
    after: typeImage(after),
    requestId: ctx.requestId,
  });
  if (before.name !== after.name) await reindexUses(ctx.jobs, client, 'type', id);
  return detailOf(client, id);
}

export async function customiseType(
  ctx: WriteCtx,
  id: string,
  accountId: string,
): Promise<{ typeId: string }> {
  const { client } = ctx;
  await requireAccount(client, accountId, 'registries-types.manage', MANAGE_HINT);
  const t = await typeRow(client, id);
  if (t.owner_account_id !== null || t.is_field_group) {
    throw new AppError('conflict', 409, 'Only a built-in type is customised.');
  }
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM public.types WHERE owner_account_id = $1 AND copied_from_id = $2
      ORDER BY created_at, id LIMIT 1`,
    [accountId, id],
  );
  const { rows } = await client.query<{ id: string }>('SELECT kept.customise_type($1, $2) AS id', [
    id,
    accountId,
  ]);
  const typeId = rows[0]?.id as string;
  if (!existing[0]) {
    await auditRegistry(ctx.tx, {
      accountId,
      userId: ctx.userId,
      action: 'type.customise',
      entity: { type: 'type', id: typeId },
      after: { copied_from_id: id, ...typeImage(await typeRow(client, typeId)) },
      requestId: ctx.requestId,
    });
  }
  return { typeId };
}

export async function mergeType(
  ctx: WriteCtx,
  id: string,
  targetId: string,
): Promise<{ repointed: number }> {
  const { client } = ctx;
  const { row: from } = await editableType(client, id);
  const into = await typeRow(client, targetId);
  if (into.owner_account_id !== from.owner_account_id || into.is_field_group) throw notFound();
  if (into.id === from.id) throw invalid('Pick a different type to merge into.');
  const graph = await TypeGraph.load(client, from.owner_account_id);
  if (graph.descendants(id).some((d) => d.id === targetId)) throw typeConflict('cycle');
  const { rows } = await guarded(() =>
    client.query<{ n: number }>("SELECT kept.merge_registry('type', $1, $2) AS n", [id, targetId]),
  );
  const repointed = rows[0]?.n ?? 0;
  await auditRegistry(ctx.tx, {
    accountId: from.owner_account_id as string,
    userId: ctx.userId,
    action: 'type.merge',
    entity: { type: 'type', id },
    before: typeImage(from),
    after: { merged_into: targetId, repointed },
    requestId: ctx.requestId,
  });
  return { repointed };
}

export async function deleteType(ctx: WriteCtx, id: string): Promise<void> {
  const { client } = ctx;
  const { row } = await editableType(client, id);
  const { rows } = await client.query<{ n: number }>(
    'SELECT coalesce(sum(things), 0)::int AS n FROM kept.type_impact($1)',
    [id],
  );
  const { rows: kids } = await client.query(
    'SELECT 1 FROM public.types WHERE parent_id = $1 LIMIT 1',
    [id],
  );
  if ((rows[0]?.n ?? 0) > 0 || kids.length > 0) throw typeConflict('in_use');
  try {
    await client.query('DELETE FROM public.types WHERE id = $1', [id]);
  } catch (err) {
    // A thing in the trash still holds it (things.type_id is NO ACTION).
    if (pgErrorOf(err)?.code === '23503') throw typeConflict('in_use');
    throw err;
  }
  await auditRegistry(ctx.tx, {
    accountId: row.owner_account_id as string,
    userId: ctx.userId,
    action: 'type.delete',
    entity: { type: 'type', id },
    before: typeImage(row),
    requestId: ctx.requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Fields (types and place kinds share them: type_fields)
// ---------------------------------------------------------------------------------------------

async function fieldRow(client: pg.ClientBase, id: string, lock = false): Promise<FieldRow> {
  const { rows } = await client.query<FieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM public.type_fields f WHERE f.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** The checks every new field shares (D177: a secret field is the account owner's to make). */
export function checkNewField(body: CreateFieldBody, access: AccountAccess): void {
  if (body.secret && body.kind !== 'text') throw invalid('Only a text field can be secret.');
  if (body.secret && !access.isOwn) throw forbidden('Only the account owner makes a field secret.');
}

/** Inserts a field of a type or a place kind and audits it; returns the row. */
export async function insertField(
  ctx: WriteCtx,
  accountId: string,
  owner: { typeId: string } | { placeKindId: string },
  body: CreateFieldBody,
): Promise<FieldRow> {
  const { client } = ctx;
  const id = newId();
  const [col, ownerId] =
    'typeId' in owner ? ['type_id', owner.typeId] : ['place_kind_id', owner.placeKindId];
  await guarded(() =>
    client.query(
      `INSERT INTO public.type_fields (id, owner_account_id, ${col}, key, label, kind, unit, options,
                                       repeatable, required, secret, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               (SELECT coalesce(max(f.sort), 0) + 1 FROM public.type_fields f WHERE f.${col} = $3))`,
      [
        id,
        accountId,
        ownerId,
        body.key,
        body.label,
        body.kind,
        body.unit ?? null,
        body.options === undefined ? null : JSON.stringify(body.options),
        body.repeatable ?? false,
        body.required ?? false,
        body.secret ?? false,
      ],
    ),
  );
  const row = await fieldRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'type_field.create',
    entity: { type: 'type_field', id },
    after: fieldImage(row),
    requestId: ctx.requestId,
  });
  return row;
}

export async function createTypeField(
  ctx: WriteCtx,
  typeId: string,
  body: CreateFieldBody,
): Promise<ResolvedField> {
  const { client } = ctx;
  const { row: t, access } = await editableType(client, typeId);
  checkNewField(body, access);
  const graph = await TypeGraph.load(client, t.owner_account_id);
  const draft: FieldRow = {
    id: newId(),
    owner_account_id: t.owner_account_id,
    type_id: t.id,
    place_kind_id: null,
    key: body.key,
    label: body.label,
    kind: body.kind,
    unit: null,
    options: null,
    repeatable: false,
    required: false,
    sort: 0,
    secret: false,
    archived_at: null,
    row_version: 1,
  };
  try {
    graph.check(graph.get(t.id) ?? t, { extraOwn: [draft] });
  } catch (err) {
    if (err instanceof Redefined) throw typeConflict('field_redefined', { key: err.key });
    throw err;
  }
  const row = await insertField(ctx, access.accountId, { typeId: t.id }, body);
  return fieldOf(row, 'own', t.id);
}

/** A field of an account type or kind the caller may change: 404, 409 builtin, then 403. */
async function editableField(client: pg.ClientBase, id: string): Promise<FieldRow> {
  const seen = await fieldRow(client, id);
  if (seen.owner_account_id === null) throw typeConflict('builtin');
  await requireAccount(client, seen.owner_account_id, 'registries-types.manage', MANAGE_HINT);
  return fieldRow(client, id, true);
}

const FIELD_UPDATE_COLUMNS: Record<keyof UpdateFieldBody, string> = {
  label: 'label',
  unit: 'unit',
  options: 'options',
  required: 'required',
  sort: 'sort',
};

/** PATCH /type-fields/:id (If-Match). `required` applies to new edits only (D172). */
export async function updateField(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateFieldBody,
): Promise<ResolvedField> {
  const { client } = ctx;
  const before = await editableField(client, id);
  if (before.row_version !== expected) {
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, 'type_field', id),
    );
  }
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, column] of Object.entries(FIELD_UPDATE_COLUMNS) as [
    keyof UpdateFieldBody,
    string,
  ][]) {
    const value = body[field];
    if (value === undefined) continue;
    values.push(field === 'options' && value !== null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  await client.query(`UPDATE public.type_fields SET ${sets.join(', ')} WHERE id = $1`, values);
  const after = await fieldRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id as string,
    userId: ctx.userId,
    action: 'type_field.update',
    entity: { type: 'type_field', id },
    before: fieldImage(before),
    after: fieldImage(after),
    requestId: ctx.requestId,
  });
  return fieldOf(after, 'own', (after.type_id ?? after.place_kind_id) as string);
}

/** D92: a removed field is archived, never deleted; its values stay on the things. */
export async function setFieldArchived(
  ctx: WriteCtx,
  id: string,
  archived: boolean,
): Promise<void> {
  const { client } = ctx;
  const before = await editableField(client, id);
  if ((before.archived_at !== null) === archived) return;
  await client.query(
    `UPDATE public.type_fields SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE id = $1`,
    [id],
  );
  const after = await fieldRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id as string,
    userId: ctx.userId,
    action: archived ? 'type_field.archive' : 'type_field.restore',
    entity: { type: 'type_field', id },
    before: fieldImage(before),
    after: fieldImage(after),
    requestId: ctx.requestId,
  });
}
