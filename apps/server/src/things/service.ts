import {
  type Action,
  can,
  canonicalAmount,
  isShortCode,
  newId,
  normaliseInputCode,
  type Role,
  tsQuery,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited, auditedMany } from '../audit/audited.js';
import type { FieldClass } from '../audit/classes.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { enqueueEmbed } from '../embeddings/job.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { filterOf, lowerIds, matchOf } from '../http/list-filters.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import { allocateShortId } from '../places/short-id.js';
import { enqueueReindex } from '../search/jobs.js';
import { STATE_SQL } from '../search/query.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  customClasses,
  moneyShaped,
  moneyShapedClasses,
  readImage,
  type ThingImage,
} from './audit-image.js';
import {
  defaultMeterOf,
  type ResolvedFieldView,
  resolvedFields,
  typeCapabilities,
} from './fields.js';
import {
  type CreateBody,
  checkCustom,
  checkCustomRefs,
  checkQuantity,
  fitsField,
  type LifecycleBody,
  type ListQuery,
  type MoveTarget,
  moneyOff,
  moneyValues,
  requireCurrencies,
  type SplitBody,
  type UpdateBody,
} from './validate.js';
import { linkViewOf, rowsOf, type ThingRow, type ThingView, viewOf } from './view.js';

// Things core (plan T14; D10, D40, D45, D76, D92, D119, D120, D156, D158, D172, D183; engineering
// spec §7.7, §7.13). Every function runs in the request's scoped kept_app transaction: RLS decides
// what exists (a 404 otherwise), can() what the caller's role may do (a 403), and each write and
// its audit rows commit together. Moves (T15), meters and readings (T16), files (T17) and secret
// values (T19) have their own modules; this one leaves them seams:
// - `liveThing()`, `writableThing()` and `requireRole()` for any route addressed by a thing id;
// - `targetOf()` resolves a MoveTarget within one location;
// - `copyTags()`, `allocateShortId()` (places/short-id.ts) and `viewOf()`/`rowsOf()` (view.ts).

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  jobs: JobQueue | null;
  files: FileStorage | null;
};

const actor = (scope: Scope) => actorOf(scope);

// ---------------------------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------------------------

export type LiveThing = {
  id: string;
  location_id: string;
  type_id: string | null;
  place_id: string | null;
  container_id: string | null;
  name: string | null;
  quantity: string;
  row_version: number;
  has_meters: boolean;
};

/** A live (not trashed) thing the caller can see. */
export async function liveThing(client: pg.ClientBase, id: string): Promise<LiveThing> {
  const { rows } = await client.query<LiveThing>(
    `SELECT t.id, t.location_id, t.type_id, t.place_id, t.container_id, t.name,
            t.quantity::text AS quantity, t.row_version,
            EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = t.id) AS has_meters
       FROM public.things t
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * A live thing the caller may change with `action`, locked for this transaction: 404 when they
 * can't see it, 403 when their role can't. The role is checked before the lock because under RLS
 * `FOR UPDATE` passes only rows the UPDATE policy allows, so a viewer's lock would find nothing
 * and turn the 403 into a 404. The row is read again under the lock (its version may have moved).
 */
export async function writableThing(
  client: pg.ClientBase,
  id: string,
  action: Action,
): Promise<LiveThing & { role: Role }> {
  const seen = await liveThing(client, id);
  const role = await requireRole(client, seen.location_id, action);
  await client.query('SELECT 1 FROM public.things WHERE id = $1 FOR UPDATE', [id]);
  return { ...(await liveThing(client, id)), role };
}

/** The caller's role in `locationId`: 404 when they can't see it, 403 unless it allows `action`. */
export async function requireRole(
  client: pg.ClientBase,
  locationId: string,
  action: Action,
): Promise<Role> {
  const { role } = await requireMembership(client, locationId);
  if (!can(role, action)) {
    throw forbidden('You can view this location but not change it.');
  }
  return role;
}

/** Throws 412 (D156) with the fields the request touched and who changed the row since. */
async function requireVersion(
  client: pg.ClientBase,
  thing: LiveThing,
  expected: number,
  fields: readonly string[],
): Promise<void> {
  if (thing.row_version === expected) return;
  const name = await lastChangedBy(client, thing.location_id, { type: 'thing', id: thing.id });
  checkVersion(
    { rowVersion: thing.row_version },
    expected,
    fields,
    name ? { displayName: name } : null,
  );
}

/** 412 unless the live thing `id` is at row version `expected` (If-Match on routes addressed by
 * a body of ids, such as a one-thing move). */
export async function requireThingVersion(
  client: pg.ClientBase,
  id: string,
  expected: number,
): Promise<void> {
  await requireVersion(client, await liveThing(client, id), expected, ['thingIds']);
}

/** Where a MoveTarget is, within `locationId`: a live place or a live thing there. 404 for one
 * the caller can't see or that is elsewhere (the cross-location path is T15's move). */
export async function targetOf(
  client: pg.ClientBase,
  locationId: string,
  to: MoveTarget,
): Promise<{ placeId: string | null; containerId: string | null }> {
  if ('placeId' in to) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM public.places
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [to.placeId, locationId],
    );
    if (!rowCount) throw notFound();
    return { placeId: to.placeId.toLowerCase(), containerId: null };
  }
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.things
      WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
    [to.containerId, locationId],
  );
  if (!rowCount) throw notFound();
  return { placeId: null, containerId: to.containerId.toLowerCase() };
}

/** Copies `from`'s tags onto `to` (same location). */
export async function copyTags(client: pg.ClientBase, from: string, to: string): Promise<void> {
  await client.query(
    `INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
     SELECT t.location_id, $2, g.tag_id FROM public.thing_tags g
       JOIN public.things t ON t.id = $2
      WHERE g.thing_id = $1`,
    [from, to],
  );
}

async function setTags(
  client: pg.ClientBase,
  locationId: string,
  thingId: string,
  tagIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(tagIds.map((x) => x.toLowerCase()))];
  await client.query(
    'DELETE FROM public.thing_tags WHERE thing_id = $1 AND NOT (tag_id = ANY ($2::uuid[]))',
    [thingId, ids],
  );
  if (ids.length === 0) return;
  // kept.guard_thing_tags(): a tag of another account, or one the caller can't see, is a 42501
  // (a 404), like an id that exists nowhere.
  await client.query(
    `INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
     SELECT $1, $2, x FROM unnest($3::uuid[]) AS x
     ON CONFLICT (thing_id, tag_id) DO NOTHING`,
    [locationId, thingId, ids],
  );
}

/** The resolved fields' audit classes for two types (before and after a re-type). */
async function classesFor(
  client: pg.ClientBase,
  typeIds: readonly (string | null)[],
  images: (ThingImage | null)[],
): Promise<Record<string, FieldClass>> {
  const fields: ResolvedFieldView[] = [];
  for (const id of new Set(typeIds)) fields.push(...(await resolvedFields(client, id)));
  return { ...moneyShapedClasses(...images), ...customClasses(fields) };
}

/** A thing whose name shows in other things' breadcrumbs and search documents: renaming it
 * leaves those stale until the location is reindexed (T20). */
async function holdsThings(client: pg.ClientBase, thingId: string): Promise<boolean> {
  const { rows } = await client.query<{ holds: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.things c WHERE c.container_id = $1) AS holds`,
    [thingId],
  );
  return rows[0]?.holds === true;
}

async function requireType(client: pg.ClientBase, typeId: string): Promise<void> {
  const { rows } = await client.query<{ is_field_group: boolean }>(
    'SELECT is_field_group FROM public.types WHERE id = $1',
    [typeId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.is_field_group) throw invalid('A field group is not a type a thing can have.');
}

/** Today in the location's time zone, `YYYY-MM-DD`. */
async function todayIn(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE l.timezone)::date::text AS today
       FROM public.locations l WHERE l.id = $1`,
    [locationId],
  );
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/things → 201 ThingView. */
export async function createThing(ctx: Ctx, body: CreateBody): Promise<ThingView> {
  const id = await insertThing(ctx, body);
  return viewOf(ctx.tx, ctx.client, ctx.scope, ctx.files, id);
}

/**
 * What step 3's other ways in add to a create, which the things route never sends. Capture
 * (capture/service.ts, T13): an unnamed draft (D18, D19: `name` null only while `review_state =
 * 'draft'`), the capture session's batch, the fields' provenance, and the one audit event the
 * capture writes in place of `thing.create`, undoable (Q23). CSV import (imports/job.ts, T18):
 * `created_via`.
 */
export type CaptureExtras = {
  draft?: boolean;
  /** `things.created_via` (default `app`). */
  createdVia?: 'app' | 'import';
  captureBatchId?: string;
  fieldStatus?: Record<string, unknown>;
  /** The caller checked the client id already (a sync op's 90-day window, Q2). */
  idChecked?: boolean;
  audit?: { action: string; after?: Record<string, unknown>; undoableUntil?: Date };
};

/** CreateBody, with the name a draft may leave out. */
export type CreateInput = Omit<CreateBody, 'name'> & { name: string | null };

/** The create itself (createThing without the view): answers the new thing's id. */
export async function insertThing(
  ctx: Ctx,
  body: CreateInput,
  extras: CaptureExtras = {},
): Promise<string> {
  const { client, tx, scope } = ctx;
  const locationId = body.locationId.toLowerCase();
  await requireRole(client, locationId, 'things.edit');
  if (body.name === null && !extras.draft) throw invalid('body.name: a thing needs a name.');
  const gate = await gateFor(tx, locationId, scope);
  let id = newId();
  if (body.id) id = extras.idChecked ? body.id.toLowerCase() : assertClientId(body.id);
  const where = await targetOf(
    client,
    locationId,
    body.placeId ? { placeId: body.placeId } : { containerId: body.containerId as string },
  );

  const typeId = body.typeId?.toLowerCase() ?? null;
  if (typeId) await requireType(client, typeId);
  const caps = await typeCapabilities(client, typeId);
  const fields = await resolvedFields(client, typeId);
  const quantity = body.quantity ?? 1;
  checkQuantity(quantity, caps, false);

  const { set: custom } = checkCustom(fields, body.custom ?? {});
  const money = moneyValues(fields, custom);
  if ((money.length > 0 || body.purchase) && !gate.showMoney) throw moneyOff();
  await requireCurrencies(
    client,
    money.map((m) => m.currency),
    'body.custom',
  );
  await checkCustomRefs(client, fields, custom, locationId);

  let purchaseLineId: string | null = null;
  const purchaseEvents: Parameters<typeof audited>[1][] = [];
  if (body.purchase) {
    const p = body.purchase;
    if (p.purchasedOn > (await todayIn(client, locationId))) {
      throw invalid('body.purchase.purchasedOn is in the future.');
    }
    await requireCurrencies(client, [p.currency], 'body.purchase.currency');
    const purchaseId = newId();
    const lineId = newId();
    const lineQuantity = quantity > 0 ? quantity : 1;
    // `price` is the price of one (the line's unit price); the purchase's total is the line's.
    const { rows } = await client.query<{ total: string }>(
      `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total)
       VALUES ($1, $2, $3, $4, $5, round($6::numeric * $7::numeric, 4))
       RETURNING total::text AS total`,
      [
        purchaseId,
        locationId,
        p.vendorId ?? null,
        p.purchasedOn,
        p.currency,
        p.price,
        lineQuantity,
      ],
    );
    await client.query(
      `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity,
                                          unit_price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [lineId, locationId, purchaseId, body.name, lineQuantity, p.price],
    );
    purchaseLineId = lineId;
    purchaseEvents.push(
      {
        locationId,
        actor: actor(scope),
        action: 'purchase.create',
        entity: { type: 'purchase', id: purchaseId },
        after: {
          vendor_id: p.vendorId ?? null,
          purchased_on: p.purchasedOn,
          currency: p.currency,
          total: canonicalAmount(rows[0]?.total),
        },
        rootThingId: id,
        requestId: ctx.requestId,
      },
      {
        locationId,
        actor: actor(scope),
        action: 'purchase_line.create',
        entity: { type: 'purchase_line', id: lineId },
        after: {
          purchase_id: purchaseId,
          description: body.name,
          quantity: String(lineQuantity),
          unit_price: p.price,
        },
        rootThingId: id,
        requestId: ctx.requestId,
      },
    );
  }

  await client.query(
    `INSERT INTO public.things (id, location_id, place_id, container_id, type_id, name, quantity,
                                brand_id, model, serial, barcode, colour, condition, notes,
                                aliases, belongs_to_person_id, purchase_line_id, manual_url,
                                expires_on, expiry_lead_days, custom, created_via, review_state,
                                field_status, capture_batch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $20, $21, $25, $22, $23, $24)`,
    [
      id,
      locationId,
      where.placeId,
      where.containerId,
      typeId,
      body.name,
      quantity,
      body.brandId ?? null,
      body.model ?? null,
      body.serial ?? null,
      body.barcode ?? null,
      body.colour ?? null,
      body.condition ?? null,
      body.notes ?? null,
      JSON.stringify(body.aliases ?? {}),
      body.belongsToPersonId ?? null,
      purchaseLineId,
      body.manualUrl ?? null,
      body.expiresOn ?? null,
      body.expiryLeadDays ?? null,
      JSON.stringify(custom),
      extras.draft ? 'draft' : 'confirmed',
      JSON.stringify(extras.fieldStatus ?? {}),
      extras.captureBatchId?.toLowerCase() ?? null,
      extras.createdVia ?? 'app',
    ],
  );
  if (body.tagIds?.length) await setTags(client, locationId, id, body.tagIds);
  await allocateShortId(client, locationId, { thingId: id });
  const meterEvent = await createDefaultMeter(ctx, locationId, id, typeId);

  const after = await readImage(client, id);
  for (const e of purchaseEvents) await audited(tx, e);
  await audited(tx, {
    locationId,
    actor: actor(scope),
    action: extras.audit?.action ?? 'thing.create',
    entity: { type: 'thing', id },
    after: { ...after, ...extras.audit?.after },
    fieldClasses: await classesFor(client, [typeId], [after]),
    rootThingId: id,
    subjects: [id],
    requestId: ctx.requestId,
    ...(extras.audit?.undoableUntil ? { undoableUntil: extras.audit.undoableUntil } : {}),
  });
  if (meterEvent) await audited(tx, meterEvent);
  // Its embedding (step-6 T14, D200): a named thing, in this transaction, debounced per thing. A
  // capture's draft waits for its review (the edit re-embeds it) or the hourly backfill.
  if (body.name !== null && !extras.draft) await enqueueEmbed(ctx.jobs, client, id);
  return id;
}

/** The type's default meter (D113: a car starts with its odometer). Returns its audit event. */
async function createDefaultMeter(
  ctx: Ctx,
  locationId: string,
  thingId: string,
  typeId: string | null,
): Promise<Parameters<typeof audited>[1] | null> {
  const meter = await defaultMeterOf(ctx.client, typeId);
  if (!meter) return null;
  const meterId = newId();
  await ctx.client.query(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, $4, $5)`,
    [meterId, locationId, thingId, meter.kind, meter.unit],
  );
  return {
    locationId,
    actor: actor(ctx.scope),
    action: 'meter.create',
    entity: { type: 'meter', id: meterId },
    after: { thing_id: thingId, kind: meter.kind, unit: meter.unit },
    rootThingId: thingId,
    requestId: ctx.requestId,
  };
}

// ---------------------------------------------------------------------------------------------
// Update and re-type
// ---------------------------------------------------------------------------------------------

/** The fields a thing's embedding text is built from (kept.embedding_text, step-6 T14). */
const EMBED_FIELDS = ['name', 'aliases', 'brandId', 'model', 'notes'] as const;

const COLUMN_OF: Partial<Record<keyof UpdateBody, string>> = {
  name: 'name',
  quantity: 'quantity',
  brandId: 'brand_id',
  model: 'model',
  serial: 'serial',
  barcode: 'barcode',
  colour: 'colour',
  condition: 'condition',
  notes: 'notes',
  belongsToPersonId: 'belongs_to_person_id',
  manualUrl: 'manual_url',
  expiresOn: 'expires_on',
  expiryLeadDays: 'expiry_lead_days',
  acquiredFrom: 'acquired_from',
  provenanceNotes: 'provenance_notes',
};

const customOf = (image: ThingImage, prefix: 'custom' | 'archived_custom') =>
  Object.fromEntries(
    Object.entries(image)
      .filter(([k]) => k.startsWith(`${prefix}.`))
      .map(([k, v]) => [k.slice(prefix.length + 1), v]),
  );

/**
 * `custom` and `archived_custom` for a thing moving from `oldFields` to `fields` (D92): a value
 * stays only under a live plain field of the new type of the same kind as the field it was
 * written for, and only if it is still a valid value there; an archived value comes back only
 * into a field it is a valid value of (money-shaped into money, and nothing else). The rest are
 * archived. Nothing is ever deleted by a re-type. (Security review #19: keeping a value under a
 * field of another kind turned an amount into text that the money gate no longer hid.)
 */
function retypeCustom(
  oldFields: readonly ResolvedFieldView[],
  fields: readonly ResolvedFieldView[],
  custom: Record<string, unknown>,
  archived: Record<string, unknown>,
): { custom: Record<string, unknown>; archived: Record<string, unknown> } {
  const plain = new Map(
    fields.filter((f) => !f.secret && f.archivedAt === null).map((f) => [f.key, f]),
  );
  const oldKind = new Map(oldFields.map((f) => [f.key, f.kind]));
  const outCustom: Record<string, unknown> = {};
  const outArchived: Record<string, unknown> = { ...archived };
  for (const [k, v] of Object.entries(custom)) {
    const field = plain.get(k);
    if (field && oldKind.get(k) === field.kind && fitsField(field, v)) outCustom[k] = v;
    else outArchived[k] = v;
  }
  for (const [k, v] of Object.entries(archived)) {
    const field = plain.get(k);
    if (field && !(k in outCustom) && fitsField(field, v)) {
      outCustom[k] = v;
      delete outArchived[k];
    }
  }
  return { custom: outCustom, archived: outArchived };
}

/**
 * What the inbox (T15) adds to an edit: the review's own columns, written in the same UPDATE and
 * the same audit event (so undoing the event puts a draft back as a draft), and whether the
 * event is undoable on its own (a bulk action's per-thing events are not: its one bulk event is).
 */
export type UpdateExtras = {
  reviewState?: 'confirmed' | 'draft';
  fieldStatus?: Record<string, unknown>;
  undoable?: boolean;
};

/** PATCH /api/v1/things/:id (If-Match), and POST …/retype. */
export async function updateThing(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateBody,
  action: 'thing.update' | 'thing.retype' = 'thing.update',
  extras: UpdateExtras = {},
): Promise<ThingView> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.edit');
  await requireVersion(client, thing, expected, Object.keys(body));
  const gate = await gateFor(tx, thing.location_id, scope);
  const before = (await readImage(client, id)) as ThingImage;

  const typeChanged = body.typeId !== undefined && body.typeId?.toLowerCase() !== thing.type_id;
  const typeId = body.typeId !== undefined ? (body.typeId?.toLowerCase() ?? null) : thing.type_id;
  if (typeChanged && typeId) await requireType(client, typeId);
  const fields = await resolvedFields(client, typeId);

  // Quantity (D10), against the new type and any meter.
  if (body.quantity !== undefined || typeChanged) {
    const caps = await typeCapabilities(client, typeId);
    checkQuantity(body.quantity ?? Number(thing.quantity), caps, thing.has_meters);
  }

  // custom: merged per key (null removes), after the re-type has archived what no longer fits.
  let custom = customOf(before, 'custom');
  let archived = customOf(before, 'archived_custom');
  if (typeChanged) {
    const oldFields = await resolvedFields(client, thing.type_id);
    ({ custom, archived } = retypeCustom(oldFields, fields, custom, archived));
  }
  if (body.custom) {
    const { set, removed } = checkCustom(fields, body.custom);
    const moneyKeys = new Set(fields.filter((f) => f.kind === 'money').map((f) => f.key));
    const touchesMoney =
      moneyValues(fields, set).length > 0 || removed.some((k) => moneyKeys.has(k));
    if (touchesMoney && !gate.showMoney) throw moneyOff();
    await requireCurrencies(
      client,
      moneyValues(fields, set).map((m) => m.currency),
      'body.custom',
    );
    await checkCustomRefs(client, fields, set, thing.location_id);
    for (const k of removed) delete custom[k];
    Object.assign(custom, set);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const put = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  for (const [key, column] of Object.entries(COLUMN_OF) as [keyof UpdateBody, string][]) {
    if (body[key] !== undefined) put(column, body[key]);
  }
  if (typeChanged) put('type_id', typeId);
  if (body.aliases) {
    const aliases = { ...((before.aliases as Record<string, string[]>) ?? {}) };
    for (const [lang, list] of Object.entries(body.aliases)) {
      if (list.length === 0) delete aliases[lang];
      else aliases[lang] = list;
    }
    put('aliases', JSON.stringify(aliases));
  }
  if (typeChanged || body.custom) {
    put('custom', JSON.stringify(custom));
    put('archived_custom', JSON.stringify(archived));
  }
  if (extras.reviewState) put('review_state', extras.reviewState);
  if (extras.fieldStatus) put('field_status', JSON.stringify(extras.fieldStatus));
  if (sets.length > 0) {
    values.push(id);
    await client.query(
      `UPDATE public.things SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    );
  }
  if (body.tagIds) {
    await setTags(client, thing.location_id, id, body.tagIds);
    // Tags live in thing_tags, so a tags-only PATCH would leave the thing's row_version where it
    // was and a client's If-Match stale-proof against it (security review #24): touch the row.
    // kept.touch = 'force' makes kept.touch_row() count this bookkeeping-only write (0031).
    if (sets.length === 0) {
      await client.query(`SELECT set_config('kept.touch', 'force', true)`);
      await client.query('UPDATE public.things SET updated_at = now() WHERE id = $1', [id]);
      await client.query(`SELECT set_config('kept.touch', '', true)`);
    }
  }

  const after = (await readImage(client, id)) as ThingImage;
  if (before.name !== after.name && (await holdsThings(client, id))) {
    await enqueueReindex(ctx.jobs, client, thing.location_id);
  }
  // A change to what it is embedded from (embedText's fields) re-embeds it (step-6 T14, D200);
  // a move or a renamed place leaves the vector stale for the hourly backfill.
  if (typeChanged || EMBED_FIELDS.some((k) => body[k] !== undefined)) {
    await enqueueEmbed(ctx.jobs, client, id);
  }
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action,
    entity: { type: 'thing', id },
    before,
    after,
    fieldClasses: await classesFor(client, [thing.type_id, typeId], [before, after]),
    rootThingId: id,
    subjects: [id],
    requestId: ctx.requestId,
    undoableUntil: extras.undoable === false ? null : undoableUntil(),
  });
  return viewOf(tx, client, scope, ctx.files, id);
}

// ---------------------------------------------------------------------------------------------
// Lifecycle, seen, not here
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/things/:id/lifecycle (If-Match). `in_use` clears the end fields ("found", D119).
 * A caller whose gate hides money keeps whatever end price is stored while the thing stays ended,
 * and may not bring back into use a thing with an end price (409 module_off): either would erase
 * an amount it can't see. */
export async function setLifecycle(
  ctx: Ctx,
  id: string,
  expected: number,
  body: LifecycleBody,
): Promise<ThingView> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.edit');
  await requireVersion(client, thing, expected, Object.keys(body));
  const gate = await gateFor(tx, thing.location_id, scope);
  const before = (await readImage(client, id)) as ThingImage;

  if (body.lifecycle === 'in_use') {
    // Back in use clears the end, its price included (things_in_use_chk allows no price on a
    // thing in use). A caller who can't see money can't have meant to erase an amount it never
    // saw, so it is refused rather than cleared (security review #26).
    if (!gate.showMoney && before.ended_price !== null) throw moneyOff();
    await client.query(
      `UPDATE public.things SET lifecycle = 'in_use', ended_on = NULL, ended_price = NULL,
              ended_currency = NULL, ended_to = NULL, ended_notes = NULL
        WHERE id = $1`,
      [id],
    );
  } else {
    const priced = body.endedPrice !== undefined || body.endedCurrency !== undefined;
    if (priced && !gate.showMoney) throw moneyOff();
    if ((body.endedPrice === undefined) !== (body.endedCurrency === undefined)) {
      throw invalid('Send body.endedPrice and body.endedCurrency together.');
    }
    if (body.endedCurrency) {
      await requireCurrencies(client, [body.endedCurrency], 'body.endedCurrency');
    }
    const keepPrice = !gate.showMoney && before.lifecycle !== 'in_use';
    await client.query(
      `UPDATE public.things SET lifecycle = $2, ended_on = $3, ended_to = $4, ended_notes = $5,
              ended_price = CASE WHEN $8 THEN ended_price ELSE $6::numeric END,
              ended_currency = CASE WHEN $8 THEN ended_currency ELSE $7::char(3) END
        WHERE id = $1`,
      [
        id,
        body.lifecycle,
        body.endedOn ?? null,
        body.endedTo ?? null,
        body.endedNotes ?? null,
        body.endedPrice ?? null,
        body.endedCurrency ?? null,
        keepPrice,
      ],
    );
  }
  const after = (await readImage(client, id)) as ThingImage;
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.lifecycle',
    entity: { type: 'thing', id },
    before,
    after,
    rootThingId: id,
    subjects: [id],
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return viewOf(tx, client, scope, ctx.files, id);
}

/** POST /api/v1/things/:id/seen (D40): seen now, and no longer "not here". A queued `mark_seen`
 * (sync/handlers/mark-seen.ts) passes when the phone saw it, `at`; a later sighting already
 * recorded is kept. */
export async function markSeen(
  ctx: Ctx,
  id: string,
  at: Date | null = null,
): Promise<{ lastSeenAt: string }> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.mark-seen');
  const { rows: was } = await client.query<{ last_seen_at: Date; location_uncertain: boolean }>(
    'SELECT last_seen_at, location_uncertain FROM public.things WHERE id = $1',
    [id],
  );
  const { rows } = await client.query<{ last_seen_at: Date; location_uncertain: boolean }>(
    `UPDATE public.things
        SET last_seen_at = greatest(last_seen_at, coalesce($2::timestamptz, now())),
            location_uncertain = false
      WHERE id = $1 RETURNING last_seen_at, location_uncertain`,
    [id, at],
  );
  const now = rows[0] as { last_seen_at: Date; location_uncertain: boolean };
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.seen',
    entity: { type: 'thing', id },
    before: was[0] ?? null,
    after: now,
    rootThingId: id,
    subjects: [id],
    requestId: ctx.requestId,
  });
  return { lastSeenAt: now.last_seen_at.toISOString() };
}

/** POST /api/v1/things/:id/not-here (D40) → ThingView. */
export async function markNotHere(
  ctx: Ctx,
  id: string,
  expected: number | null = null,
): Promise<ThingView> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.mark-seen');
  if (expected !== null) await requireVersion(client, thing, expected, ['locationUncertain']);
  const before = await readImage(client, id);
  await client.query('UPDATE public.things SET location_uncertain = true WHERE id = $1', [id]);
  const after = await readImage(client, id);
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.not_here',
    entity: { type: 'thing', id },
    before,
    after,
    rootThingId: id,
    subjects: [id],
    requestId: ctx.requestId,
  });
  return viewOf(tx, client, scope, ctx.files, id);
}

// ---------------------------------------------------------------------------------------------
// Duplicate and split
// ---------------------------------------------------------------------------------------------

/** The columns a copy takes from its source, as written by INSERT … SELECT. */
const COPIED = `type_id, name, brand_id, model, barcode, colour, condition, notes, aliases,
                belongs_to_person_id, manual_url, expires_on, expiry_lead_days, acquired_from,
                provenance_notes, custom, archived_custom`;

/** POST /api/v1/things/:id/duplicate → 201 ThingView: a new thing in the same place, with no
 * serial, no purchase link, its own short ID, in use, seen now (Q6: step 2's "template"). */
export async function duplicateThing(
  ctx: Ctx,
  id: string,
  body: { id?: string | undefined },
): Promise<ThingView> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.edit');
  const gate = await gateFor(tx, thing.location_id, scope);
  const copyId = body.id ? assertClientId(body.id) : newId();
  const caps = await typeCapabilities(client, thing.type_id);
  const quantity = caps.includes('serialized') || caps.includes('metered') ? '1' : thing.quantity;
  await client.query(
    `INSERT INTO public.things (id, location_id, place_id, container_id, quantity, created_via,
                                ${COPIED})
     SELECT $2, location_id, place_id, container_id, $3::numeric, 'app', ${COPIED}
       FROM public.things WHERE id = $1`,
    [id, copyId, quantity],
  );
  if (!gate.showMoney) {
    // Money the caller can't see isn't copied (security review #26): its money fields and any
    // money-shaped value, current or archived, are left off the copy.
    const src = (await readImage(client, id)) as ThingImage;
    const moneyKeys = new Set(
      (await resolvedFields(client, thing.type_id))
        .filter((f) => f.kind === 'money')
        .map((f) => f.key),
    );
    const keep = (prefix: 'custom' | 'archived_custom') =>
      Object.fromEntries(
        Object.entries(customOf(src, prefix)).filter(
          ([k, v]) => !moneyShaped(v) && !(prefix === 'custom' && moneyKeys.has(k)),
        ),
      );
    await client.query(
      'UPDATE public.things SET custom = $2::jsonb, archived_custom = $3::jsonb WHERE id = $1',
      [copyId, JSON.stringify(keep('custom')), JSON.stringify(keep('archived_custom'))],
    );
  }
  await copyTags(client, id, copyId);
  await allocateShortId(client, thing.location_id, { thingId: copyId });
  const meterEvent = await createDefaultMeter(ctx, thing.location_id, copyId, thing.type_id);
  const after = await readImage(client, copyId);
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.create',
    entity: { type: 'thing', id: copyId },
    after: { ...after, duplicate_of: id },
    fieldClasses: await classesFor(client, [thing.type_id], [after]),
    rootThingId: copyId,
    subjects: [copyId],
    requestId: ctx.requestId,
  });
  if (meterEvent) await audited(tx, meterEvent);
  return viewOf(tx, client, scope, ctx.files, copyId);
}

/**
 * POST /api/v1/things/:id/split (D10, §1.4): part of the quantity becomes a new thing with its
 * own history and short ID, `split_from_id` pointing back and the same purchase line. Refused for
 * anything counted one by one (serialized, metered, with a meter). `to` puts the new part
 * somewhere else in the same location; across locations, T15's move splits first.
 */
export async function splitThing(
  ctx: Ctx,
  id: string,
  body: SplitBody,
  expected: number | null,
): Promise<{ originalId: string; newId: string }> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.edit');
  if (expected !== null) await requireVersion(client, thing, expected, ['quantity']);
  const caps = await typeCapabilities(client, thing.type_id);
  if (caps.includes('serialized') || caps.includes('metered') || thing.has_meters) {
    throw invalid("This is counted one by one, so it can't be split.");
  }
  const total = Number(thing.quantity);
  if (!(body.quantity < total)) {
    throw invalid(`body.quantity must be less than the ${thing.quantity} there are.`);
  }
  const partId = body.id ? assertClientId(body.id) : newId();
  const where = body.to
    ? await targetOf(client, thing.location_id, body.to)
    : { placeId: thing.place_id, containerId: thing.container_id };
  if (where.containerId === id) throw invalid("A part can't go inside what it was split from.");

  const before = await readImage(client, id);
  await client.query(
    `INSERT INTO public.things (id, location_id, place_id, container_id, quantity, created_via,
                                split_from_id, serial, purchase_line_id, lifecycle, ended_on,
                                ended_price, ended_currency, ended_to, ended_notes,
                                location_uncertain, review_state, last_seen_at, ${COPIED})
     SELECT $2, location_id, $3, $4, $5::numeric, 'app', id, serial, purchase_line_id, lifecycle,
            ended_on, ended_price, ended_currency, ended_to, ended_notes, location_uncertain,
            review_state, CASE WHEN $6 THEN now() ELSE last_seen_at END, ${COPIED}
       FROM public.things WHERE id = $1`,
    [id, partId, where.placeId, where.containerId, body.quantity, body.to !== undefined],
  );
  await client.query('UPDATE public.things SET quantity = quantity - $2::numeric WHERE id = $1', [
    id,
    body.quantity,
  ]);
  await copyTags(client, id, partId);
  await allocateShortId(client, thing.location_id, { thingId: partId });

  const after = await readImage(client, id);
  const part = await readImage(client, partId);
  const classes = await classesFor(client, [thing.type_id], [before, after, part]);
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.split',
    entity: { type: 'thing', id },
    before,
    after: { ...after, split_into: partId },
    fieldClasses: classes,
    rootThingId: id,
    subjects: [id, partId],
    requestId: ctx.requestId,
  });
  await audited(tx, {
    locationId: thing.location_id,
    actor: actor(scope),
    action: 'thing.create',
    entity: { type: 'thing', id: partId },
    after: { ...part, split_from_id: id },
    fieldClasses: classes,
    rootThingId: partId,
    subjects: [partId],
    requestId: ctx.requestId,
  });
  if (where.containerId && (await holdsThings(client, partId))) {
    await enqueueReindex(ctx.jobs, client, thing.location_id);
  }
  return { originalId: id, newId: partId };
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/things/:id/links → 201 (D76). Both things are in one location. */
export async function addLink(
  ctx: Ctx,
  id: string,
  body: { toThingId: string; kind: ThingView['links'][number]['kind'] },
): Promise<ThingView['links'][number]> {
  const { client, tx, scope } = ctx;
  const from = await liveThing(client, id);
  const to = await liveThing(client, body.toThingId.toLowerCase());
  await requireRole(client, from.location_id, 'things.edit');
  if (from.id === to.id) throw invalid("A thing can't be linked to itself.");
  if (from.location_id !== to.location_id) {
    throw invalid('Link things of the same location.');
  }
  const linkId = newId();
  await client.query(
    `INSERT INTO public.thing_links (id, location_id, from_thing_id, to_thing_id, kind)
     VALUES ($1, $2, $3, $4, $5)`,
    [linkId, from.location_id, from.id, to.id, body.kind],
  );
  await audited(tx, {
    locationId: from.location_id,
    actor: actor(scope),
    action: 'thing.link',
    entity: { type: 'thing_link', id: linkId },
    after: { from_thing_id: from.id, to_thing_id: to.id, kind: body.kind },
    rootThingId: from.id,
    subjects: [from.id, to.id],
    requestId: ctx.requestId,
  });
  return linkViewOf(client, ctx.files, { id: linkId, kind: body.kind, toThingId: to.id });
}

/** DELETE /api/v1/thing-links/:linkId → 204. */
export async function removeLink(ctx: Ctx, linkId: string): Promise<void> {
  const { client, tx, scope } = ctx;
  const { rows } = await client.query<{
    location_id: string;
    from_thing_id: string;
    to_thing_id: string;
    kind: string;
  }>('SELECT location_id, from_thing_id, to_thing_id, kind FROM public.thing_links WHERE id = $1', [
    linkId,
  ]);
  const link = rows[0];
  if (!link) throw notFound();
  await requireRole(client, link.location_id, 'things.edit');
  await client.query('DELETE FROM public.thing_links WHERE id = $1', [linkId]);
  await audited(tx, {
    locationId: link.location_id,
    actor: actor(scope),
    action: 'thing.unlink',
    entity: { type: 'thing_link', id: linkId },
    before: { from_thing_id: link.from_thing_id, to_thing_id: link.to_thing_id, kind: link.kind },
    after: null,
    rootThingId: link.from_thing_id,
    subjects: [link.from_thing_id, link.to_thing_id],
    requestId: ctx.requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Convert to a place (Q14: same id)
// ---------------------------------------------------------------------------------------------

/** What a thing would lose by becoming a place: a place has none of these (security review #23;
 * the web lists them before the user confirms). Meters are listed too, but the definer refuses
 * a thing with a meter whatever the caller says (things_has_meters): a reading history is never
 * dropped by a conversion. */
export const CONVERT_LOSSES = [
  'brand',
  'ended',
  'links',
  'meters',
  'purchase',
  'serial',
  'tags',
] as const;

async function conversionLosses(client: pg.ClientBase, id: string): Promise<string[]> {
  const { rows } = await client.query<Record<(typeof CONVERT_LOSSES)[number], boolean>>(
    `SELECT t.brand_id IS NOT NULL AS brand,
            t.lifecycle <> 'in_use' AS ended,
            EXISTS (SELECT 1 FROM public.thing_links k
                     WHERE k.from_thing_id = t.id OR k.to_thing_id = t.id) AS links,
            EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = t.id) AS meters,
            t.purchase_line_id IS NOT NULL AS purchase,
            t.serial IS NOT NULL AS serial,
            EXISTS (SELECT 1 FROM public.thing_tags g WHERE g.thing_id = t.id) AS tags
       FROM public.things t WHERE t.id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? CONVERT_LOSSES.filter((k) => row[k]) : [];
}

/**
 * POST /api/v1/things/:id/convert-to-place (If-Match) → {placeId} (Q14: the same id). The thing's
 * row is deleted, so this is for owners and admins (things.delete-permanently, security review
 * #23), and refused (409 `conflict`, `reason: 'discards'`, `discards: [...]`) while the thing
 * carries a record a place can't hold, unless the body says `discard: true`. Audited as
 * `thing.convert_to_place` (with what was discarded), `place.create` for the new place, and a
 * `thing.move` for each thing that was inside it (not undoable: the container is gone).
 */
export async function convertToPlace(
  ctx: Ctx,
  id: string,
  expected: number,
  body: { parentId?: string | undefined; discard?: boolean | undefined },
): Promise<{ placeId: string }> {
  const { client, tx, scope } = ctx;
  const thing = await writableThing(client, id, 'things.delete-permanently');
  await requireVersion(client, thing, expected, ['convert']);
  const discards = await conversionLosses(client, id);
  if (discards.length > 0 && !body.discard) {
    throw new AppError(
      'conflict',
      409,
      `As a place it would lose its ${discards.join(', ')}. Convert anyway to discard them.`,
      { reason: 'discards', discards },
    );
  }
  const before = await readImage(client, id);
  const { rows: inside } = await client.query<{ id: string }>(
    'SELECT id FROM public.things WHERE container_id = $1 ORDER BY id',
    [id],
  );
  const { rows } = await client.query<{ id: string }>(
    'SELECT kept.convert_container_to_place($1, $2) AS id',
    [id, body.parentId?.toLowerCase() ?? null],
  );
  const placeId = rows[0]?.id as string;
  const { rows: made } = await client.query<{
    name: string;
    parent_id: string | null;
    kind_key: string;
  }>('SELECT name, parent_id, kind_key FROM public.places WHERE id = $1', [placeId]);
  const at = { locationId: thing.location_id, actor: actor(scope), requestId: ctx.requestId };
  await audited(tx, {
    ...at,
    action: 'thing.convert_to_place',
    entity: { type: 'thing', id },
    before,
    after: { converted_to: 'place', place_id: placeId, discarded: discards },
    fieldClasses: await classesFor(client, [thing.type_id], [before]),
    rootThingId: id,
    subjects: [id],
  });
  await audited(tx, {
    ...at,
    action: 'place.create',
    entity: { type: 'place', id: placeId },
    after: { ...made[0], converted_from: 'thing' },
  });
  await auditedMany(
    tx,
    inside.map((r) => ({
      ...at,
      action: 'thing.move',
      entity: { type: 'thing', id: r.id },
      before: { place_id: null, container_id: id },
      after: { place_id: placeId, container_id: null },
      rootThingId: r.id,
      subjects: [r.id],
    })),
  );
  // The things that were inside now sit in a place: their breadcrumbs and documents change.
  await enqueueReindex(ctx.jobs, client, thing.location_id);
  return { placeId };
}

// ---------------------------------------------------------------------------------------------
// Codes (D137)
// ---------------------------------------------------------------------------------------------

/** GET /api/v1/codes/:code: the same 404 for a code that doesn't exist, one the caller can't
 * see, and a retired one (D137). */
export async function lookupCode(
  client: pg.ClientBase,
  input: string,
): Promise<{ kind: 'thing' | 'place'; id: string }> {
  const code = normaliseInputCode(input);
  if (!isShortCode(code)) throw notFound();
  const { rows } = await client.query<{ thing_id: string | null; place_id: string | null }>(
    `SELECT s.thing_id, s.place_id FROM public.short_ids s
      WHERE s.code = $1 AND s.state = 'assigned'
        AND (s.thing_id IS NULL OR EXISTS (SELECT 1 FROM public.things t
                                            WHERE t.id = s.thing_id AND t.deleted_at IS NULL))
        AND (s.place_id IS NULL OR EXISTS (SELECT 1 FROM public.places p
                                            WHERE p.id = s.place_id AND p.deleted_at IS NULL))`,
    [code],
  );
  const hit = rows[0];
  if (hit?.thing_id) return { kind: 'thing', id: hit.thing_id };
  if (hit?.place_id) return { kind: 'place', id: hit.place_id };
  throw notFound();
}

// ---------------------------------------------------------------------------------------------
// The list (list-standard, global by default, D174)
// ---------------------------------------------------------------------------------------------

const ListCursor = z.tuple([z.string().max(400), z.string().max(400), z.uuid()]);

const ICU = 'COLLATE "und-x-icu"';

/** The list's filters, without paging (GET /things, GET /things.csv). */
export type ThingListFilter = Omit<ListQuery, 'limit' | 'cursor' | 'group' | 'sort' | 'dir'>;

/**
 * The WHERE conditions of GET /things for `q`, over `public.things t`, their values added through
 * `p`. Shared by the list and its CSV (lists/things-csv.ts, D169), so the file holds exactly the
 * rows the list shows. 404 for a named location the caller can't see.
 */
export async function thingListWhere(
  client: pg.ClientBase,
  q: ThingListFilter,
  p: (v: unknown) => string,
): Promise<string[]> {
  const where = ['t.deleted_at IS NULL'];
  // The multi-value filters are "any of" their values or, named in `not`, "none of" them
  // (D205): a thing with no type, brand or owner is "none of" any (http/list-filters.ts). Every
  // location named either way must be one the caller can see (404, review #36).
  const locationIds = lowerIds(q.locationId);
  for (const id of locationIds) await requireMembership(client, id);
  const many = (
    values: readonly string[] | undefined,
    name: string,
    cond: (ids: string) => string,
  ) => {
    const f = filterOf(lowerIds(values), name, q.not);
    if (f) where.push(matchOf(cond(`${p(f.values)}::uuid[]`), f.not));
  };
  many(locationIds, 'locationId', (ids) => `t.location_id = ANY (${ids})`);
  if (q.placeId) where.push(`t.place_id = ${p(q.placeId)}::uuid`);
  if (q.containerId) where.push(`t.container_id = ${p(q.containerId)}::uuid`);
  many(q.typeId, 'typeId', (ids) => `t.type_id = ANY (${ids})`);
  many(q.brandId, 'brandId', (ids) => `t.brand_id = ANY (${ids})`);
  many(q.belongsToId, 'belongsToId', (ids) => `t.belongs_to_person_id = ANY (${ids})`);
  if (q.lifecycle) where.push(`t.lifecycle = ${p(q.lifecycle)}`);
  many(
    q.tagId,
    'tagId',
    (ids) => `EXISTS (SELECT 1 FROM public.thing_tags g
                       WHERE g.thing_id = t.id AND g.tag_id = ANY (${ids}))`,
  );
  if (q.vendorId) {
    // Through the purchase line (T28): purchases the caller can see.
    where.push(`t.purchase_line_id IN (
      SELECT pl.id FROM public.purchase_lines pl JOIN public.purchases pu ON pu.id = pl.purchase_id
       WHERE pu.vendor_id = ${p(q.vendorId)}::uuid)`);
  }
  const state = filterOf(q.state, 'state', q.not);
  if (state)
    where.push(matchOf(`(${state.values.map((x) => STATE_SQL[x]).join(' OR ')})`, state.not));
  if (q.container === '1') {
    where.push(`('container' = ANY (kept.type_capabilities(t.type_id))
                 OR EXISTS (SELECT 1 FROM public.things c
                             WHERE c.container_id = t.id AND c.deleted_at IS NULL))`);
  }
  if (q.importRunId) {
    // "See what was imported" (step-3 carry-over, step-7 T16): the things a run recorded in
    // import_source_ids. That table is for owners and admins (0038): anyone else, and a run of
    // a location the caller can't administer, matches nothing.
    where.push(`t.id IN (SELECT s.entity_id FROM public.import_source_ids s
                          WHERE s.run_id = ${p(q.importRunId.toLowerCase())}::uuid
                            AND s.entity_type = 'thing')`);
  }
  if (q.q) {
    const tsq = tsQuery(q.q);
    const nq = p(q.q);
    where.push(`(${tsq ? `t.search_tsv @@ to_tsquery('simple', ${p(tsq)}) OR ` : ''}
                 kept.normalize(t.name) % kept.normalize(${nq})
                 OR kept.normalize(t.serial) = kept.normalize(${nq}))`);
  }

  return where;
}

/** The list's order, over `public.things t LEFT JOIN public.types ty` (shared with the CSV):
 * `ORDER BY group, sort [DESC], t.id`. */
export function thingListOrder(q: Pick<ListQuery, 'group' | 'sort' | 'dir'>): {
  group: string;
  sort: string;
  desc: boolean;
} {
  const group =
    q.group === 'type'
      ? `(lower(coalesce(ty.name, ty.builtin_key, '~')) || ' ' || coalesce(ty.id::text, '')) ${ICU}`
      : q.group === 'place'
        ? `coalesce(t.container_id, t.place_id)::text ${ICU}`
        : `''::text ${ICU}`;
  const desc = q.dir ? q.dir === 'desc' : q.sort !== 'name';
  const sort =
    q.sort === 'updated'
      ? 't.updated_at'
      : q.sort === 'lastSeen'
        ? 't.last_seen_at'
        : `lower(coalesce(t.name, '')) ${ICU}`;
  return { group, sort, desc };
}

/**
 * GET /api/v1/things: every live thing the caller can see, filtered, sorted and grouped, one
 * keyset page at a time. `group` sorts by the group key first (type, or where it is), so a group
 * never splits across a page boundary in a different order. `dir` turns the sort around (D211;
 * the name A to Z and the dates newest first by default). Stable across pages: every sort ends
 * in the id.
 */
export async function listThings(
  client: pg.ClientBase,
  files: FileStorage | null,
  q: ListQuery,
): Promise<{ items: ThingRow[]; next_cursor: string | null }> {
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = await thingListWhere(client, q, p);
  const { group, sort, desc } = thingListOrder(q);
  const sortCast = q.sort === 'name' ? `::text ${ICU}` : '::timestamptz';

  if (q.cursor) {
    const parsed = ListCursor.safeParse(decodeCursor(q.cursor));
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    const [g, s, lastId] = parsed.data;
    const G = `${p(g)}::text ${ICU}`;
    const S = `${p(s)}${sortCast}`;
    const I = `${p(lastId)}::uuid`;
    where.push(`(${group} > ${G}
                 OR (${group} = ${G} AND (${sort} ${desc ? '<' : '>'} ${S}
                                          OR (${sort} = ${S} AND t.id > ${I}))))`);
  }

  const { rows } = await client.query<{ id: string; g: string; s: string }>(
    `SELECT t.id, ${group} AS g, (${sort})::text AS s
       FROM public.things t LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${group}, ${sort} ${desc ? 'DESC' : 'ASC'}, t.id
      LIMIT ${p(q.limit + 1)}`,
    values,
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await rowsOf(
      client,
      files,
      page.map((r) => r.id),
    ),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.g, last.s, last.id]) : null,
  };
}
