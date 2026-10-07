import { type Action, newId } from '@kept/shared';
import type pg from 'pg';
import { assertClientId, checkVersion, pageOf, paginate } from '../http/conventions.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import {
  auditRegistry,
  lastChangedBy,
  locationsUsing,
  MANAGE_HINT,
  reindexUses,
  requireAccount,
  type WriteCtx,
} from './account.js';
import {
  COLUMNS,
  ENTITY,
  type Item,
  imageOf,
  itemOf,
  NAME_COLUMN,
  type RegistryKind,
  TABLE,
} from './view.js';

// Brands, vendors, people and tags (T11; D11, D55, D76, D123, D177; plan Q5, Q15). Account rows
// under 0014's policies: everyone who sees the account reads them; brands are created by its
// admins, the others inline by anyone who writes in one of its locations; changing, merging and
// deleting is an admin's. The routes check can() first so a visible account answers 403, not
// the 404 a refused policy would give. Every write is an account-level audit row (Q15).
//
// Names: a brand or tag is one per account after kept.normalize() (409 `conflict` carrying the
// existing row's id); a vendor or person may share a name, and a create answers the near
// matches (pg_trgm similarity over normalised names > 0.5) as `possibleDuplicates`, a hint the
// client shows, never a block (D11).

type Ctx = WriteCtx;

/** Who may create, and who may change, merge or delete, per kind (§7.1). */
const CREATE: Record<RegistryKind, Action> = {
  brands: 'registries-types.manage',
  vendors: 'people-vendors.create-inline',
  people: 'people-vendors.create-inline',
  tags: 'tags.create',
};
const EDIT: Record<RegistryKind, Action> = {
  brands: 'registries-types.manage',
  vendors: 'registries-types.manage',
  people: 'registries-types.manage',
  tags: 'tags.edit-delete',
};
/** Whose names are unique per account (0014's normalised uniques). */
const UNIQUE_NAMES = new Set<RegistryKind>(['brands', 'tags']);
/** Whose names are in the things' search documents (0016's thing_search_doc). */
const INDEXED: Partial<Record<RegistryKind, 'brand' | 'person' | 'tag'>> = {
  brands: 'brand',
  people: 'person',
  tags: 'tag',
};

const CREATE_HINT: Record<RegistryKind, string> = {
  brands: MANAGE_HINT,
  vendors: 'Viewers can’t add vendors.',
  people: 'Viewers can’t add people.',
  tags: 'Viewers can’t add tags.',
};

type Row = Record<string, unknown> & { id: string; owner_account_id: string; row_version: number };

async function rowOf(
  client: pg.ClientBase,
  kind: RegistryKind,
  id: string,
  lock = false,
): Promise<Row> {
  const { rows } = await client.query<Row>(
    `SELECT * FROM public.${TABLE[kind]} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * The row, locked, once the caller may change it: 404 when invisible, 403 when their role in the
 * account may not (a lock needs the UPDATE policy, which would turn that 403 into a 404).
 */
async function editable(client: pg.ClientBase, kind: RegistryKind, id: string): Promise<Row> {
  const seen = await rowOf(client, kind, id);
  await requireAccount(client, seen.owner_account_id, EDIT[kind], MANAGE_HINT);
  return rowOf(client, kind, id, true);
}

/** 409 `conflict` with `existingId` when a brand or tag of that normalised name exists. */
async function refuseDuplicateName(
  client: pg.ClientBase,
  kind: RegistryKind,
  accountId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  if (!UNIQUE_NAMES.has(kind)) return;
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.${TABLE[kind]}
      WHERE owner_account_id = $1 AND kept.normalize(name) = kept.normalize($2)
        AND ($3::uuid IS NULL OR id <> $3) LIMIT 1`,
    [accountId, name, exceptId],
  );
  const existing = rows[0];
  if (existing) {
    throw new AppError(
      'conflict',
      409,
      kind === 'brands'
        ? 'A brand with that name already exists.'
        : 'A tag with that name already exists.',
      { existingId: existing.id },
    );
  }
}

/** The name a body carries, if any. */
const nameIn = (kind: RegistryKind, body: Record<string, unknown>) =>
  (kind === 'people' ? body.displayName : body.name) as string | undefined;

export async function listItems(
  client: pg.ClientBase,
  kind: RegistryKind,
  accountId: string,
  query: { q?: string | undefined; limit: number; cursor?: string | undefined },
): Promise<{ items: Item[]; next_cursor: string | null }> {
  await requireAccount(client, accountId);
  const page = paginate<number>({ limit: query.limit, cursor: query.cursor });
  const offset = typeof page.after === 'number' && page.after > 0 ? Math.floor(page.after) : 0;
  const col = NAME_COLUMN[kind];
  const q = query.q?.trim() ? query.q.trim() : null;
  // With `q`: a normalised substring or a near trigram match, best first (§7.9, D42).
  const { rows } = await client.query<Row>(
    `SELECT r.* FROM public.${TABLE[kind]} r
      WHERE r.owner_account_id = $1
        AND ($2::text IS NULL
             OR strpos(kept.normalize(r.${col}), kept.normalize($2)) > 0
             OR similarity(kept.normalize(r.${col}), kept.normalize($2)) > 0.3)
      ORDER BY CASE WHEN $2::text IS NULL THEN 0
                    ELSE similarity(kept.normalize(r.${col}), kept.normalize($2)) END DESC,
               kept.normalize(r.${col}), r.id
      LIMIT $3 OFFSET $4`,
    [accountId, q, page.limit + 1, offset],
  );
  const result = pageOf(rows, page.limit, () => offset + page.limit);
  return { items: result.items.map((r) => itemOf(kind, r)), next_cursor: result.next_cursor };
}

export async function getItem(client: pg.ClientBase, kind: RegistryKind, id: string) {
  const item = itemOf(kind, await rowOf(client, kind, id));
  if (kind !== 'brands') return item;
  const { rows } = await client.query<{ has: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM public.brand_logos WHERE brand_id = $1) AS has',
    [id],
  );
  return { ...item, hasLogo: rows[0]?.has ?? false };
}

export async function createItem(
  ctx: Ctx,
  kind: RegistryKind,
  accountId: string,
  body: Record<string, unknown>,
): Promise<{ item: Item; possibleDuplicates: { id: string; name: string; similarity: number }[] }> {
  const { client } = ctx;
  await requireAccount(client, accountId, CREATE[kind], CREATE_HINT[kind]);
  const id = body.id ? assertClientId(body.id as string) : newId();
  const name = nameIn(kind, body) as string;
  await refuseDuplicateName(client, kind, accountId, name, null);

  const cols = ['id', 'owner_account_id'];
  const values: unknown[] = [id, accountId];
  for (const [field, column] of Object.entries(COLUMNS[kind])) {
    if (body[field] === undefined) continue;
    cols.push(column);
    values.push(body[field]);
  }
  const { rows } = await client.query<Row>(
    `INSERT INTO public.${TABLE[kind]} (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values,
  );
  const item = itemOf(kind, rows[0] as Row);

  const col = NAME_COLUMN[kind];
  const { rows: near } = await client.query<{ id: string; name: string; sim: number }>(
    `SELECT r.id, r.${col} AS name,
            similarity(kept.normalize(r.${col}), kept.normalize($2))::float8 AS sim
       FROM public.${TABLE[kind]} r
      WHERE r.owner_account_id = $1 AND r.id <> $3
        AND similarity(kept.normalize(r.${col}), kept.normalize($2)) > 0.5
      ORDER BY sim DESC, r.id LIMIT 5`,
    [accountId, name, id],
  );

  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    action: `${ENTITY[kind]}.create`,
    entity: { type: ENTITY[kind], id },
    after: imageOf(item),
    requestId: ctx.requestId,
  });
  return {
    item,
    possibleDuplicates: near.map((r) => ({ id: r.id, name: r.name, similarity: Number(r.sim) })),
  };
}

export async function updateItem(
  ctx: Ctx,
  kind: RegistryKind,
  id: string,
  expected: number,
  body: Record<string, unknown>,
): Promise<Item> {
  const { client } = ctx;
  const before = await editable(client, kind, id);
  if (before.row_version !== expected) {
    checkVersion(
      { rowVersion: before.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, ENTITY[kind], id),
    );
  }
  const name = nameIn(kind, body);
  if (name !== undefined)
    await refuseDuplicateName(client, kind, before.owner_account_id, name, id);

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, column] of Object.entries(COLUMNS[kind])) {
    if (body[field] === undefined) continue;
    values.push(body[field]);
    sets.push(`${column} = $${values.length}`);
  }
  // PatchBody refuses an empty body; this is the backstop, so a body with nothing this kind
  // writes is a 400 rather than an UPDATE with no SET list (a 500).
  if (sets.length === 0) throw invalid('Nothing to change.');
  const { rows } = await client.query<Row>(
    `UPDATE public.${TABLE[kind]} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  const after = rows[0];
  if (!after) throw notFound();
  const was = itemOf(kind, before);
  const item = itemOf(kind, after);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    action: `${ENTITY[kind]}.update`,
    entity: { type: ENTITY[kind], id },
    before: imageOf(was),
    after: imageOf(item),
    requestId: ctx.requestId,
  });
  const indexed = INDEXED[kind];
  const col = NAME_COLUMN[kind];
  if (indexed && before[col] !== after[col]) await reindexUses(ctx.jobs, client, indexed, id);
  return item;
}

export async function deleteItem(ctx: Ctx, kind: RegistryKind, id: string): Promise<void> {
  const { client } = ctx;
  const before = await editable(client, kind, id);
  if ((await locationsUsing(client, ENTITY[kind], id)).length > 0) {
    throw new AppError(
      'in_use',
      409,
      'Merge it into another one instead, or remove it from its things first.',
    );
  }
  await client.query(`DELETE FROM public.${TABLE[kind]} WHERE id = $1`, [id]);
  await auditRegistry(ctx.tx, {
    accountId: before.owner_account_id,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    action: `${ENTITY[kind]}.delete`,
    entity: { type: ENTITY[kind], id },
    before: imageOf(itemOf(kind, before)),
    requestId: ctx.requestId,
  });
}

export async function mergeItem(
  ctx: Ctx,
  kind: RegistryKind,
  id: string,
  targetId: string,
): Promise<{ repointed: number }> {
  const { client } = ctx;
  const from = await editable(client, kind, id);
  const into = await rowOf(client, kind, targetId);
  if (from.owner_account_id !== into.owner_account_id) throw notFound();
  if (from.id === into.id) throw invalid('Pick a different one to merge into.');
  const { rows } = await client.query<{ n: number }>(
    'SELECT kept.merge_registry($1, $2, $3) AS n',
    [ENTITY[kind], id, targetId],
  );
  const repointed = rows[0]?.n ?? 0;
  await auditRegistry(ctx.tx, {
    accountId: from.owner_account_id,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    action: `${ENTITY[kind]}.merge`,
    entity: { type: ENTITY[kind], id },
    before: imageOf(itemOf(kind, from)),
    after: { merged_into: targetId, repointed },
    requestId: ctx.requestId,
  });
  return { repointed };
}

// ---------------------------------------------------------------------------------------------
// A person's contact details (D177, Q5)
// ---------------------------------------------------------------------------------------------

export type Contact = { phone: string | null; email: string | null; notes: string | null };
const CONTACT_FIELDS = ['phone', 'email', 'notes'] as const;

/** 404 unless the person is visible and their contact details are the caller's to see. */
async function requireContactVisible(client: pg.ClientBase, personId: string): Promise<Row> {
  const person = await rowOf(client, 'people', personId);
  const { rows } = await client.query<{ v: boolean }>(
    'SELECT kept.person_contact_visible($1) AS v',
    [personId],
  );
  if (!rows[0]?.v) throw notFound();
  return person;
}

async function contactRow(client: pg.ClientBase, personId: string): Promise<Contact | null> {
  const { rows } = await client.query<Contact>(
    'SELECT phone, email, notes FROM public.person_contacts WHERE person_id = $1',
    [personId],
  );
  return rows[0] ?? null;
}

const EMPTY: Contact = { phone: null, email: null, notes: null };

export async function getContact(client: pg.ClientBase, personId: string): Promise<Contact> {
  await requireContactVisible(client, personId);
  return (await contactRow(client, personId)) ?? EMPTY;
}

/** Replaces the three fields; one left out is cleared. Audited as secret (Q5). */
export async function putContact(
  ctx: Ctx,
  personId: string,
  body: Partial<Contact>,
): Promise<Contact> {
  const { client } = ctx;
  const person = await requireContactVisible(client, personId);
  const before = await contactRow(client, personId);
  const next: Contact = {
    phone: body.phone?.trim() || null,
    email: body.email?.trim() || null,
    notes: body.notes?.trim() ? body.notes : null,
  };
  if (before) {
    await client.query(
      'UPDATE public.person_contacts SET phone = $2, email = $3, notes = $4 WHERE person_id = $1',
      [personId, next.phone, next.email, next.notes],
    );
  } else {
    await client.query(
      `INSERT INTO public.person_contacts (person_id, owner_account_id, phone, email, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [personId, person.owner_account_id, next.phone, next.email, next.notes],
    );
  }
  await auditRegistry(ctx.tx, {
    accountId: person.owner_account_id,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    action: 'person.contact_update',
    entity: { type: 'person', id: personId },
    before: before ?? EMPTY,
    after: next,
    fieldClasses: Object.fromEntries(CONTACT_FIELDS.map((f) => [f, 'secret'])),
    requestId: ctx.requestId,
  });
  return next;
}

// ---------------------------------------------------------------------------------------------
// The account switcher (Q21)
// ---------------------------------------------------------------------------------------------

export async function listAccounts(client: pg.ClientBase) {
  const { rows } = await client.query<{
    id: string;
    role: string;
    is_own: boolean;
    owner_name: string | null;
  }>(
    `SELECT l.owner_account_id AS id, m.role,
            l.owner_account_id = kept.current_owner_account_id() AS is_own,
            (SELECT p.display_name FROM public.memberships om
               JOIN public.user_profiles p ON p.user_id = om.user_id
              WHERE om.location_id = l.id AND om.role = 'owner' LIMIT 1) AS owner_name
       FROM public.locations l
       JOIN public.memberships m ON m.location_id = l.id AND m.user_id = kept.current_user_id()
      WHERE l.id IN (SELECT kept.visible_location_ids())`,
  );
  const byId = new Map<
    string,
    { id: string; ownerDisplayName: string; isOwn: boolean; canManage: boolean }
  >();
  for (const r of rows) {
    const manage = r.role === 'owner' || r.role === 'admin';
    const seen = byId.get(r.id);
    if (seen) {
      seen.canManage ||= manage;
      if (!seen.ownerDisplayName && r.owner_name) seen.ownerDisplayName = r.owner_name;
    } else {
      byId.set(r.id, {
        id: r.id,
        ownerDisplayName: r.owner_name ?? '',
        isOwn: r.is_own,
        canManage: manage,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.isOwn) - Number(a.isOwn) ||
      a.ownerDisplayName.localeCompare(b.ownerDisplayName) ||
      a.id.localeCompare(b.id),
  );
}
