import { type Action, can, newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { forbidden, invalid, notFound } from '../http/errors.js';
import { requireMembership } from '../locations/access.js';
import {
  auditRegistry,
  lastChangedBy,
  MANAGE_HINT,
  requireAccount,
  type WriteCtx,
} from '../registries/account.js';
import { type ResolvedFieldView, resolvedFields, typeCapabilities } from '../things/fields.js';
import { Aliases, checkCustom, checkQuantity, fitsField } from '../things/validate.js';

// Account templates shared per location, and quick add (plan T19; D6, D76, D123, D177; Q17).
// The web contract is apps/web/src/api/capture/types.ts "templates and quick add (T19)".
//
// A template lives on the owner account and is shared into chosen locations of it
// (`template_locations`). Members and above of those locations use it (GET /templates?locationId,
// quick add); changing or deleting it needs admin of **every** location it is shared with (0038's
// policies; Q17), and creating one `registries-types.manage` in the account plus admin of each
// location it is shared into. A template the caller can see but not change is a 403; one they
// can't see, a 404 (§7.7).
//
// The payload (`templateSchema`) never carries money or secrets (D177): it has no price key, and
// `custom` holds only the type's live text, number, url, select and boolean fields that are not
// secret. A create or edit naming anything else is a 400; save-as-template (built from a thing)
// leaves those fields behind. Reads apply the same filter, so a payload written another way (an
// import) still never shows one.
//
// Quick add (`applyTemplate`): POST /things and capture() take `templateId`; the template's
// payload is the base and every field the request sends wins. Template values that no longer fit
// (a deleted brand or tag, a field the chosen type lacks, a quantity its capabilities refuse) are
// dropped rather than failing the create.
//
// Audit: account-level rows (`template.create`, `template.update`, `template.delete`; Q15).

/** Field kinds a template may hold a value of (D177: never money or secrets). */
const TEMPLATE_KINDS = new Set(['text', 'number', 'url', 'select', 'boolean']);

export const NEVER_HINT = 'Templates never hold prices or secrets.';
const EDIT_HINT = 'Only admins of every location it is shared with can change it.';
const SHARE_HINT = 'Share it only with locations you administer.';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Quantity = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'a quantity, e.g. 2 or 1.5');

/** `templateSchema`: strict, so a price or any other key is a 400. */
export const TemplatePayload = z.strictObject({
  name: Text(200).optional(),
  brandId: z.uuid().optional(),
  model: Text(120).optional(),
  colour: Text(60).optional(),
  quantity: Quantity.optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
  aliases: Aliases.optional(),
  notes: Text(5000).optional(),
  custom: z.record(z.string().max(64), z.unknown()).optional(),
});
export type TemplatePayload = z.infer<typeof TemplatePayload>;

const PAYLOAD_KEYS = Object.keys(TemplatePayload.shape) as (keyof TemplatePayload)[];

const Name = Text(80);
const LocationIds = z.array(z.uuid()).min(1, 'Share it with a location.').max(100);

export const CreateTemplateBody = z.strictObject({
  id: z.uuid().optional(),
  name: Name,
  typeId: z.uuid().optional(),
  payload: TemplatePayload,
  locationIds: LocationIds,
});
export type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

export const UpdateTemplateBody = z
  .strictObject({
    name: Name,
    typeId: z.uuid().nullable(),
    payload: TemplatePayload,
    locationIds: LocationIds,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

export const SaveAsTemplateBody = z.strictObject({ name: Name, locationIds: LocationIds });
export type SaveAsTemplateBody = z.infer<typeof SaveAsTemplateBody>;

const PayloadOut = z.record(z.string(), z.unknown());
export const TemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  typeId: z.uuid().nullable(),
  typeIcon: z.string().nullable(),
  payload: PayloadOut,
});
export const AccountTemplateSchema = TemplateSchema.extend({
  locations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  rowVersion: z.number().int(),
});

export type Template = z.infer<typeof TemplateSchema>;
export type AccountTemplate = z.infer<typeof AccountTemplateSchema>;

type Row = {
  id: string;
  owner_account_id: string;
  name: string;
  type_id: string | null;
  type_icon: string | null;
  payload: Record<string, unknown>;
  row_version: number;
};

const SELECT = `SELECT t.id, t.owner_account_id, t.name, t.type_id, ty.icon AS type_icon, t.payload,
                       t.row_version
                  FROM public.templates t LEFT JOIN public.types ty ON ty.id = t.type_id`;

/** The caller administers every location the template is shared with (0038's UPDATE policy). */
const EDITABLE = `t.owner_account_id IN (SELECT kept.admin_account_ids())
  AND NOT EXISTS (SELECT 1 FROM public.template_locations tl
                   WHERE tl.template_id = t.id
                     AND tl.location_id NOT IN (SELECT kept.admin_location_ids()))`;

// ---------------------------------------------------------------------------------------------
// The payload's fields, and the filter every read and write applies
// ---------------------------------------------------------------------------------------------

/** The type's fields a template may hold: live, not secret, not money, of TEMPLATE_KINDS. */
const templateFields = (fields: readonly ResolvedFieldView[]) =>
  fields.filter(
    (f) => f.archivedAt === null && !f.secret && f.kind !== 'money' && TEMPLATE_KINDS.has(f.kind),
  );

/** Resolved fields per type, once per request. */
type FieldCache = Map<string, ResolvedFieldView[]>;

async function fieldsOf(
  client: pg.ClientBase,
  typeId: string | null,
  cache: FieldCache,
): Promise<ResolvedFieldView[]> {
  if (!typeId) return [];
  let fields = cache.get(typeId);
  if (!fields) {
    fields = templateFields(await resolvedFields(client, typeId));
    cache.set(typeId, fields);
  }
  return fields;
}

/** Only the payload's own keys, and in `custom` only values that fit a field a template may
 * hold (a read never shows money or a secret, whoever wrote the row). */
function cleanPayload(
  payload: Record<string, unknown>,
  fields: readonly ResolvedFieldView[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    if (payload[key] !== undefined && key !== 'custom') out[key] = payload[key];
  }
  const custom = payload.custom;
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const kept = Object.fromEntries(
      Object.entries(custom as Record<string, unknown>).filter(([k, v]) => {
        const f = byKey.get(k);
        return f !== undefined && fitsField(f, v);
      }),
    );
    if (Object.keys(kept).length > 0) out.custom = kept;
  }
  return out;
}

/**
 * A create's or edit's payload, checked against the account and the template's type: 400 for
 * money or secret fields, fields the type lacks or a template can't hold, a brand or tag of
 * another account, a quantity the type refuses. Answers the payload as stored.
 */
async function checkPayload(
  client: pg.ClientBase,
  accountId: string,
  typeId: string | null,
  payload: TemplatePayload,
): Promise<TemplatePayload> {
  const out: TemplatePayload = { ...payload };
  const custom = payload.custom ?? {};
  delete out.custom;
  if (Object.keys(custom).length > 0) {
    if (!typeId) throw invalid('payload.custom needs a type.');
    const all = await resolvedFields(client, typeId);
    const live = new Map(all.filter((f) => f.archivedAt === null).map((f) => [f.key, f]));
    for (const [key, value] of Object.entries(custom)) {
      const f = live.get(key);
      if (!f) throw invalid(`Check payload.custom.${key}: the type has no such field.`);
      if (f.secret || f.kind === 'money') throw invalid(NEVER_HINT);
      if (!TEMPLATE_KINDS.has(f.kind)) {
        throw invalid(
          `Check payload.custom.${key}: a template holds only text, number, link, choice and yes-or-no fields.`,
        );
      }
      if (value === null) throw invalid(`Check payload.custom.${key}: leave it out instead.`);
    }
    const { set } = checkCustom(templateFields(all), custom);
    out.custom = set;
  }
  if (payload.brandId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.brands WHERE id = $1 AND owner_account_id = $2',
      [payload.brandId, accountId],
    );
    if (!rowCount) throw invalid('Check payload.brandId: no such brand in this account.');
    out.brandId = payload.brandId.toLowerCase();
  }
  if (payload.tagIds) {
    const ids = [...new Set(payload.tagIds.map((x) => x.toLowerCase()))];
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.tags WHERE id = ANY ($1::uuid[]) AND owner_account_id = $2',
      [ids, accountId],
    );
    if (rowCount !== ids.length)
      throw invalid('Check payload.tagIds: no such tag in this account.');
    out.tagIds = ids;
  }
  if (payload.quantity !== undefined) {
    checkQuantity(
      Number(payload.quantity),
      await typeCapabilities(client, typeId),
      false,
      'payload.quantity',
    );
  }
  return out;
}

/** 404 unless the type is visible and of the account (or built in); 400 for a field group. */
async function checkType(client: pg.ClientBase, accountId: string, typeId: string): Promise<void> {
  const { rows } = await client.query<{ is_field_group: boolean }>(
    `SELECT is_field_group FROM public.types
      WHERE id = $1 AND (owner_account_id IS NULL OR owner_account_id = $2)`,
    [typeId, accountId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.is_field_group) throw invalid('A field group is not a type a thing can have.');
}

/** The locations to share into: 404 for one the caller can't see or of another account, 403
 * for one they don't administer. Answers them deduplicated, lower-cased. */
async function checkLocations(
  client: pg.ClientBase,
  accountId: string,
  locationIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(locationIds.map((x) => x.toLowerCase()))];
  const { rows } = await client.query<{ id: string; admin: boolean }>(
    `SELECT l.id, l.id IN (SELECT kept.admin_location_ids()) AS admin
       FROM public.locations l
      WHERE l.id = ANY ($1::uuid[]) AND l.owner_account_id = $2
        AND l.id IN (SELECT kept.visible_location_ids())`,
    [ids, accountId],
  );
  if (rows.length !== ids.length) throw notFound();
  if (rows.some((r) => !r.admin)) throw forbidden(SHARE_HINT);
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

async function locationsOf(
  client: pg.ClientBase,
  templateIds: readonly string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>();
  if (templateIds.length === 0) return out;
  const { rows } = await client.query<{ template_id: string; id: string; name: string }>(
    `SELECT tl.template_id, l.id, l.name
       FROM public.template_locations tl JOIN public.locations l ON l.id = tl.location_id
      WHERE tl.template_id = ANY ($1::uuid[])
      ORDER BY l.name COLLATE "und-x-icu", l.id`,
    [templateIds],
  );
  for (const r of rows) {
    const list = out.get(r.template_id) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.template_id, list);
  }
  return out;
}

async function viewsOf(client: pg.ClientBase, rows: readonly Row[]): Promise<Template[]> {
  const cache: FieldCache = new Map();
  const out: Template[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      name: r.name,
      typeId: r.type_id,
      typeIcon: r.type_icon,
      payload: cleanPayload(r.payload, await fieldsOf(client, r.type_id, cache)),
    });
  }
  return out;
}

async function accountViewsOf(client: pg.ClientBase, rows: readonly Row[]) {
  const views = await viewsOf(client, rows);
  const where = await locationsOf(
    client,
    rows.map((r) => r.id),
  );
  return views.map(
    (v, i): AccountTemplate => ({
      ...v,
      locations: where.get(v.id) ?? [],
      rowVersion: rows[i]?.row_version ?? 1,
    }),
  );
}

/** GET /api/v1/templates?locationId: the templates usable there, for members and above. A
 * location the caller can't write in (a viewer's, another household's, a random id) has none. */
export async function listUsable(client: pg.ClientBase, locationId: string): Promise<Template[]> {
  const { rows } = await client.query<Row>(
    `${SELECT}
      WHERE t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM public.template_locations tl
                     WHERE tl.template_id = t.id AND tl.location_id = $1
                       AND tl.location_id IN (SELECT kept.writable_location_ids()))
      ORDER BY t.name COLLATE "und-x-icu", t.id`,
    [locationId],
  );
  return viewsOf(client, rows);
}

/** GET /api/v1/accounts/:accountId/templates: the admin view, only templates the caller can
 * change (D177: their contents are for admins of every location that uses them). A member sees
 * none; an account they can't see is a 404. */
export async function listAccount(
  client: pg.ClientBase,
  accountId: string,
): Promise<AccountTemplate[]> {
  await requireAccount(client, accountId);
  const { rows } = await client.query<Row>(
    `${SELECT}
      WHERE t.owner_account_id = $1 AND t.archived_at IS NULL AND ${EDITABLE}
      ORDER BY t.name COLLATE "und-x-icu", t.id`,
    [accountId],
  );
  return accountViewsOf(client, rows);
}

async function accountView(client: pg.ClientBase, id: string): Promise<AccountTemplate> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE t.id = $1`, [id]);
  const [view] = await accountViewsOf(client, rows);
  if (!view) throw notFound();
  return view;
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

type Image = {
  name: string;
  type_id: string | null;
  payload: Record<string, unknown>;
  location_ids: string[];
};

async function imageOf(client: pg.ClientBase, id: string): Promise<Image> {
  const { rows } = await client.query<
    Omit<Image, 'location_ids'> & { location_ids: string[] | null }
  >(
    `SELECT t.name, t.type_id, t.payload,
            (SELECT array_agg(tl.location_id ORDER BY tl.location_id)
               FROM public.template_locations tl WHERE tl.template_id = t.id) AS location_ids
       FROM public.templates t WHERE t.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return {
    name: r.name,
    type_id: r.type_id,
    payload: r.payload,
    location_ids: r.location_ids ?? [],
  };
}

async function insertTemplate(
  ctx: WriteCtx,
  t: {
    id: string;
    accountId: string;
    name: string;
    typeId: string | null;
    payload: TemplatePayload;
    locationIds: readonly string[];
    fromThingId?: string;
  },
): Promise<AccountTemplate> {
  const { client } = ctx;
  await client.query(
    `INSERT INTO public.templates (id, owner_account_id, name, type_id, payload, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.id, t.accountId, t.name, t.typeId, JSON.stringify(t.payload), ctx.userId],
  );
  await client.query(
    `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
     SELECT $1, $2, x FROM unnest($3::uuid[]) AS x`,
    [t.id, t.accountId, t.locationIds],
  );
  await auditRegistry(ctx.tx, {
    accountId: t.accountId,
    userId: ctx.userId,
    action: 'template.create',
    entity: { type: 'template', id: t.id },
    after: {
      ...(await imageOf(client, t.id)),
      ...(t.fromThingId ? { from_thing_id: t.fromThingId } : {}),
    },
    requestId: ctx.requestId,
  });
  return accountView(client, t.id);
}

/** POST /api/v1/accounts/:accountId/templates → 201 AccountTemplate. */
export async function createTemplate(
  ctx: WriteCtx,
  accountId: string,
  body: CreateTemplateBody,
): Promise<AccountTemplate> {
  const { client } = ctx;
  await requireAccount(client, accountId, 'registries-types.manage', MANAGE_HINT);
  const id = body.id ? assertClientId(body.id) : newId();
  const typeId = body.typeId?.toLowerCase() ?? null;
  if (typeId) await checkType(client, accountId, typeId);
  const locationIds = await checkLocations(client, accountId, body.locationIds);
  const payload = await checkPayload(client, accountId, typeId, body.payload);
  return insertTemplate(ctx, { id, accountId, name: body.name, typeId, payload, locationIds });
}

/** The template, locked, once the caller may change it: 404 when invisible, 403 when they don't
 * administer every location it is shared with (checked before the lock, which would otherwise
 * find nothing and answer 404). */
async function editable(client: pg.ClientBase, id: string): Promise<Row> {
  const { rows } = await client.query<Row & { can_edit: boolean }>(
    `SELECT t.id, t.owner_account_id, t.name, t.type_id, t.payload, t.row_version,
            (${EDITABLE}) AS can_edit
       FROM public.templates t WHERE t.id = $1 AND t.archived_at IS NULL`,
    [id],
  );
  const seen = rows[0];
  if (!seen) throw notFound();
  await requireAccount(client, seen.owner_account_id, 'registries-types.manage', MANAGE_HINT);
  if (!seen.can_edit) throw forbidden(EDIT_HINT);
  const { rows: locked } = await client.query<Row>(
    'SELECT row_version FROM public.templates WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!locked[0]) throw notFound();
  return { ...seen, row_version: locked[0].row_version };
}

/** A re-type without a new payload: the stored payload, keeping only the custom values the new
 * type still takes and a quantity its capabilities allow. */
async function retypedPayload(
  client: pg.ClientBase,
  stored: Record<string, unknown>,
  typeId: string | null,
): Promise<TemplatePayload> {
  const out = cleanPayload(stored, templateFields(await resolvedFields(client, typeId)));
  if (typeof out.quantity === 'string') {
    try {
      checkQuantity(Number(out.quantity), await typeCapabilities(client, typeId), false);
    } catch {
      delete out.quantity;
    }
  }
  return out as TemplatePayload;
}

/** PATCH /api/v1/templates/:id (If-Match) → AccountTemplate. */
export async function updateTemplate(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateTemplateBody,
): Promise<AccountTemplate> {
  const { client } = ctx;
  const row = await editable(client, id);
  if (row.row_version !== expected) {
    checkVersion(
      { rowVersion: row.row_version },
      expected,
      Object.keys(body),
      await lastChangedBy(client, 'template', id),
    );
  }
  const accountId = row.owner_account_id;
  const before = await imageOf(client, id);
  const typeId =
    body.typeId === undefined
      ? row.type_id
      : body.typeId === null
        ? null
        : body.typeId.toLowerCase();
  if (typeId && typeId !== row.type_id) await checkType(client, accountId, typeId);
  let payload: TemplatePayload | null = null;
  if (body.payload !== undefined) {
    payload = await checkPayload(client, accountId, typeId, body.payload);
  } else if (typeId !== row.type_id) {
    payload = await retypedPayload(client, row.payload, typeId);
  }

  await client.query(
    `UPDATE public.templates
        SET name = coalesce($2, name), type_id = $3, payload = coalesce($4::jsonb, payload)
      WHERE id = $1`,
    [id, body.name ?? null, typeId, payload ? JSON.stringify(payload) : null],
  );
  if (body.locationIds) {
    const next = await checkLocations(client, accountId, body.locationIds);
    await client.query(
      `DELETE FROM public.template_locations
        WHERE template_id = $1 AND NOT (location_id = ANY ($2::uuid[]))`,
      [id, next],
    );
    await client.query(
      `INSERT INTO public.template_locations (template_id, owner_account_id, location_id)
       SELECT $1, $2, x FROM unnest($3::uuid[]) AS x
       ON CONFLICT (template_id, location_id) DO NOTHING`,
      [id, accountId, next],
    );
  }
  await auditRegistry(ctx.tx, {
    accountId,
    userId: ctx.userId,
    action: 'template.update',
    entity: { type: 'template', id },
    before: before as unknown as Record<string, unknown>,
    after: (await imageOf(client, id)) as unknown as Record<string, unknown>,
    requestId: ctx.requestId,
  });
  return accountView(client, id);
}

/** DELETE /api/v1/templates/:id → 204. Things started from it keep their details. */
export async function deleteTemplate(ctx: WriteCtx, id: string): Promise<void> {
  const { client } = ctx;
  const row = await editable(client, id);
  const before = await imageOf(client, id);
  await client.query('DELETE FROM public.templates WHERE id = $1', [id]);
  await auditRegistry(ctx.tx, {
    accountId: row.owner_account_id,
    userId: ctx.userId,
    action: 'template.delete',
    entity: { type: 'template', id },
    before: before as unknown as Record<string, unknown>,
    requestId: ctx.requestId,
  });
}

/** POST /api/v1/things/:id/save-as-template → 201 AccountTemplate, built from the thing's
 * non-money, non-secret details (D76). The caller manages templates in the thing's own location
 * (its details go to the locations the template is shared with, D177) and administers each of
 * those. */
export async function saveAsTemplate(
  ctx: WriteCtx,
  thingId: string,
  body: SaveAsTemplateBody,
): Promise<AccountTemplate> {
  const { client } = ctx;
  const { rows } = await client.query<{
    location_id: string;
    owner_account_id: string;
    type_id: string | null;
    brand_id: string | null;
    model: string | null;
    colour: string | null;
    notes: string | null;
    quantity: string;
    aliases: Record<string, string[]> | null;
    custom: Record<string, unknown> | null;
    tag_ids: string[] | null;
  }>(
    `SELECT t.location_id, l.owner_account_id, t.type_id, t.brand_id, t.model, t.colour, t.notes,
            t.quantity::text AS quantity, t.aliases, t.custom,
            (SELECT array_agg(g.tag_id ORDER BY g.tag_id) FROM public.thing_tags g
              WHERE g.thing_id = t.id) AS tag_ids
       FROM public.things t JOIN public.locations l ON l.id = t.location_id
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [thingId],
  );
  const thing = rows[0];
  if (!thing) throw notFound();
  const { role } = await requireMembership(client, thing.location_id);
  const manage: Action = 'registries-types.manage';
  if (!can(role, manage)) throw forbidden(MANAGE_HINT);
  const accountId = thing.owner_account_id;
  const locationIds = await checkLocations(client, accountId, body.locationIds);

  const fields = templateFields(await resolvedFields(client, thing.type_id));
  const custom = cleanPayload({ custom: thing.custom ?? {} }, fields).custom;
  const quantity = Number(thing.quantity);
  const aliases = thing.aliases && Object.keys(thing.aliases).length > 0 ? thing.aliases : null;
  const payload: TemplatePayload = {
    ...(thing.brand_id ? { brandId: thing.brand_id } : {}),
    ...(thing.model ? { model: thing.model } : {}),
    ...(thing.colour ? { colour: thing.colour } : {}),
    ...(quantity !== 1 ? { quantity: String(quantity) } : {}),
    ...(thing.tag_ids?.length ? { tagIds: thing.tag_ids } : {}),
    ...(aliases ? { aliases } : {}),
    ...(thing.notes ? { notes: thing.notes } : {}),
    ...(custom ? { custom: custom as Record<string, unknown> } : {}),
  };
  return insertTemplate(ctx, {
    id: newId(),
    accountId,
    name: body.name,
    typeId: thing.type_id,
    payload,
    locationIds,
    fromThingId: thingId,
  });
}

// ---------------------------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------------------------

/** What a create may take from a template. `name: null` is a capture's unnamed draft. */
export type TemplateFields = {
  name?: string | null;
  typeId?: string | undefined;
  brandId?: string | undefined;
  model?: string | undefined;
  colour?: string | undefined;
  quantity?: number | undefined;
  tagIds?: string[] | undefined;
  aliases?: Record<string, string[]> | undefined;
  notes?: string | undefined;
  custom?: Record<string, unknown> | undefined;
};

/**
 * Quick add: `explicit` on top of the template's payload. The template must be shared with
 * `locationId` and the caller write there (404 otherwise, like any row they can't see). Each
 * field the request sends wins; `custom` merges key by key. A missing name falls back to the
 * payload's, then the template's own ("also the new thing's name, until you type one").
 */
export async function applyTemplate<T extends TemplateFields>(
  client: pg.ClientBase,
  templateId: string,
  locationId: string,
  explicit: T,
): Promise<T> {
  const { rows } = await client.query<{
    name: string;
    type_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT t.name, t.type_id, t.payload FROM public.templates t
      WHERE t.id = $1 AND t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM public.template_locations tl
                     WHERE tl.template_id = t.id AND tl.location_id = $2
                       AND tl.location_id IN (SELECT kept.writable_location_ids()))`,
    [templateId.toLowerCase(), locationId],
  );
  const tpl = rows[0];
  if (!tpl) throw notFound();
  const typeId = explicit.typeId?.toLowerCase() ?? tpl.type_id ?? undefined;
  const p = cleanPayload(tpl.payload, templateFields(await resolvedFields(client, typeId ?? null)));
  const out: T = { ...explicit };
  const take = <K extends keyof TemplateFields>(key: K, value: TemplateFields[K] | undefined) => {
    if (out[key] === undefined && value !== undefined) (out as TemplateFields)[key] = value;
  };

  if (out.name === undefined || out.name === null) {
    (out as TemplateFields).name = (p.name as string | undefined) ?? tpl.name;
  }
  take('typeId', typeId);
  take('model', p.model as string | undefined);
  take('colour', p.colour as string | undefined);
  take('notes', p.notes as string | undefined);
  take('aliases', p.aliases as Record<string, string[]> | undefined);
  if (out.brandId === undefined && typeof p.brandId === 'string') {
    const { rowCount } = await client.query('SELECT 1 FROM public.brands WHERE id = $1', [
      p.brandId,
    ]);
    if (rowCount) take('brandId', p.brandId);
  }
  if (out.tagIds === undefined && Array.isArray(p.tagIds) && p.tagIds.length > 0) {
    const { rows: tags } = await client.query<{ id: string }>(
      'SELECT id FROM public.tags WHERE id = ANY ($1::uuid[])',
      [p.tagIds],
    );
    if (tags.length > 0) take('tagIds', tags.map((r) => r.id).sort());
  }
  if (out.quantity === undefined && typeof p.quantity === 'string') {
    const quantity = Number(p.quantity);
    try {
      checkQuantity(quantity, await typeCapabilities(client, typeId ?? null), false);
      take('quantity', quantity);
    } catch {
      // The type refuses it now (D10): the thing starts with the default.
    }
  }
  const custom = { ...(p.custom as Record<string, unknown> | undefined), ...explicit.custom };
  if (Object.keys(custom).length > 0) (out as TemplateFields).custom = custom;
  return out;
}
