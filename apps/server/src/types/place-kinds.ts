import { BUILTIN_PLACE_KINDS, newId } from '@kept/shared';
import type pg from 'pg';
import type { z } from 'zod';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, notFound } from '../http/errors.js';
import {
  auditRegistry,
  lastChangedBy,
  MANAGE_HINT,
  requireAccount,
  type WriteCtx,
} from '../registries/account.js';
import { FIELD_COLUMNS, type FieldRow, fieldOf } from './graph.js';
import { checkNewField, insertField, typeConflict } from './service.js';
import type {
  CreateFieldBody,
  CreatePlaceKindBody,
  PlaceKindNode,
  ResolvedField,
  UpdatePlaceKindBody,
} from './view.js';

// Place kinds and their fields (T11; D33, D160). Places name their kind by key
// (`places.kind_key`), so an account's kind with a built-in's key is that account's customised
// copy of it and stands in for it in every location of the account: nothing is repointed. The
// copy keeps name NULL, so it still translates (0025), and carries the account's own fields
// (T28 contract decision 7: POST /accounts/:accountId/place-kinds/:builtinKey/customise).
// Built-ins themselves are read-only (409 `reason: 'builtin'`), like built-in types.

type KindRow = {
  id: string;
  owner_account_id: string | null;
  key: string;
  name: string | null;
  icon: string;
  archived_at: Date | null;
  row_version: number;
};

const BUILTIN = new Set<string>(BUILTIN_PLACE_KINDS);
const KIND_COLUMNS =
  'k.id, k.owner_account_id, k.key, k.name, k.icon, k.archived_at, k.row_version';

async function kindRow(client: pg.ClientBase, id: string, lock = false): Promise<KindRow> {
  const { rows } = await client.query<KindRow>(
    `SELECT ${KIND_COLUMNS} FROM public.place_kinds k WHERE k.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function fieldsOf(
  client: pg.ClientBase,
  kindIds: string[],
): Promise<Map<string, ResolvedField[]>> {
  const { rows } = await client.query<FieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM public.type_fields f
      WHERE f.place_kind_id = ANY ($1::uuid[]) ORDER BY f.sort, f.key`,
    [kindIds],
  );
  const out = new Map<string, ResolvedField[]>();
  for (const f of rows) {
    const kind = f.place_kind_id as string;
    out.set(kind, [...(out.get(kind) ?? []), fieldOf(f, 'own', kind)]);
  }
  return out;
}

function nodeOf(k: KindRow, fields: Map<string, ResolvedField[]>): PlaceKindNode {
  return {
    id: k.id,
    key: k.key,
    builtinKey: BUILTIN.has(k.key) ? k.key : null,
    ownerAccountId: k.owner_account_id,
    name: k.name,
    icon: k.icon,
    fields: fields.get(k.id) ?? [],
    rowVersion: k.row_version,
    archivedAt: k.archived_at ? k.archived_at.toISOString() : null,
  };
}

async function nodeById(client: pg.ClientBase, id: string): Promise<PlaceKindNode> {
  const row = await kindRow(client, id);
  return nodeOf(row, await fieldsOf(client, [id]));
}

const kindImage = (k: KindRow) => ({
  key: k.key,
  name: k.name,
  icon: k.icon,
  archived_at: k.archived_at,
});

/** The account's kinds: the built-ins it hasn't customised, then its own, by key. */
export async function listPlaceKinds(
  client: pg.ClientBase,
  accountId: string,
): Promise<PlaceKindNode[]> {
  await requireAccount(client, accountId);
  const { rows } = await client.query<KindRow>(
    `SELECT ${KIND_COLUMNS} FROM public.place_kinds k
      WHERE k.owner_account_id = $1
         OR (k.owner_account_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.place_kinds c
                              WHERE c.owner_account_id = $1 AND c.key = k.key))
      ORDER BY k.owner_account_id IS NOT NULL, k.key`,
    [accountId],
  );
  const fields = await fieldsOf(
    client,
    rows.map((r) => r.id),
  );
  return rows.map((r) => nodeOf(r, fields));
}

export async function createPlaceKind(
  ctx: WriteCtx,
  accountId: string,
  body: z.infer<typeof CreatePlaceKindBody>,
): Promise<PlaceKindNode> {
  const { client } = ctx;
  await requireAccount(client, accountId, 'registries-types.manage', MANAGE_HINT);
  const { rows: same } = await client.query<{ id: string }>(
    `SELECT id FROM public.place_kinds WHERE key = $2 AND (owner_account_id = $1 OR owner_account_id IS NULL)
      ORDER BY owner_account_id NULLS LAST LIMIT 1`,
    [accountId, body.key],
  );
  if (same[0]) {
    throw new AppError('conflict', 409, 'That kind already exists.', { existingId: same[0].id });
  }
  const id = body.id ? assertClientId(body.id) : newId();
  await client.query(
    'INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon) VALUES ($1, $2, $3, $4, $5)',
    [id, accountId, body.key, body.name, body.icon],
  );
  const row = await kindRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'place_kind.create',
    entity: { type: 'place_kind', id },
    after: kindImage(row),
    requestId: ctx.requestId,
  });
  return nodeOf(row, new Map());
}

/** An account kind the caller may change, locked: 404, then 409 builtin, then 403. */
async function editableKind(client: pg.ClientBase, id: string): Promise<KindRow> {
  const seen = await kindRow(client, id);
  if (seen.owner_account_id === null) throw typeConflict('builtin');
  await requireAccount(client, seen.owner_account_id, 'registries-types.manage', MANAGE_HINT);
  return kindRow(client, id, true);
}

export async function updatePlaceKind(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: z.infer<typeof UpdatePlaceKindBody>,
): Promise<PlaceKindNode> {
  const { client } = ctx;
  const before = await editableKind(client, id);
  if (before.row_version !== expected) {
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, 'place_kind', id),
    );
  }
  await client.query(
    `UPDATE public.place_kinds SET name = coalesce($2, name), icon = coalesce($3, icon) WHERE id = $1`,
    [id, body.name ?? null, body.icon ?? null],
  );
  const after = await kindRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id as string,
    userId: ctx.userId,
    action: 'place_kind.update',
    entity: { type: 'place_kind', id },
    before: kindImage(before),
    after: kindImage(after),
    requestId: ctx.requestId,
  });
  return nodeById(client, id);
}

export async function createPlaceKindField(
  ctx: WriteCtx,
  kindId: string,
  body: CreateFieldBody,
): Promise<ResolvedField> {
  const { client } = ctx;
  const seen = await kindRow(client, kindId);
  if (seen.owner_account_id === null) throw typeConflict('builtin');
  const access = await requireAccount(
    client,
    seen.owner_account_id,
    'registries-types.manage',
    MANAGE_HINT,
  );
  checkNewField(body, access);
  const { rows } = await client.query(
    'SELECT 1 FROM public.type_fields WHERE place_kind_id = $1 AND key = $2',
    [kindId, body.key],
  );
  if (rows.length > 0) throw typeConflict('field_redefined', { key: body.key });
  const row = await insertField(ctx, access.accountId, { placeKindId: kindId }, body);
  return fieldOf(row, 'own', kindId);
}

/** The account's copy of a built-in kind, made once (idempotent, like kept.customise_type). */
export async function customisePlaceKind(
  ctx: WriteCtx,
  accountId: string,
  builtinKey: string,
): Promise<{ placeKindId: string }> {
  const { client } = ctx;
  await requireAccount(client, accountId, 'registries-types.manage', MANAGE_HINT);
  if (!BUILTIN.has(builtinKey)) throw notFound();
  const { rows: existing } = await client.query<{ id: string }>(
    'SELECT id FROM public.place_kinds WHERE owner_account_id = $1 AND key = $2',
    [accountId, builtinKey],
  );
  if (existing[0]) return { placeKindId: existing[0].id };
  const { rows: builtin } = await client.query<KindRow>(
    `SELECT ${KIND_COLUMNS} FROM public.place_kinds k WHERE k.owner_account_id IS NULL AND k.key = $1`,
    [builtinKey],
  );
  const source = builtin[0];
  if (!source) throw notFound();
  const id = newId();
  await client.query(
    'INSERT INTO public.place_kinds (id, owner_account_id, key, icon) VALUES ($1, $2, $3, $4)',
    [id, accountId, builtinKey, source.icon],
  );
  await client.query(
    `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind, unit, options,
                                     repeatable, required, sort, secret, archived_at)
     SELECT $1, $2, f.key, f.label, f.kind, f.unit, f.options, f.repeatable, f.required, f.sort,
            f.secret, f.archived_at
       FROM public.type_fields f WHERE f.place_kind_id = $3`,
    [accountId, id, source.id],
  );
  const row = await kindRow(client, id);
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'place_kind.customise',
    entity: { type: 'place_kind', id },
    after: { copied_from_key: builtinKey, ...kindImage(row) },
    requestId: ctx.requestId,
  });
  return { placeKindId: id };
}

export { nodeById as getPlaceKind };
