import { can, customSchema, type FieldDef, newId, type Role } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { FieldClass } from '../audit/classes.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId, checkVersion } from '../http/conventions.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { enqueueReindex } from '../search/jobs.js';
import { gateFor } from '../serialize/gates.js';
import {
  auditRelocations,
  ORPHAN_RETURNING,
  type Orphan,
  relocationOf,
} from '../things/relocate.js';
import { allocateShortId } from './short-id.js';
import {
  findPlace,
  kindFields,
  lastChangedBy,
  type PlaceRow,
  placeKindOf,
  type ResolvedField,
  requirePlace,
  unplacedOf,
} from './view.js';

// The writes of D160 (T13): create, edit and re-parent, trash with the contents choice (D45),
// restore (D162), delete permanently, merge, convert to a container (Q14) and label (D120).
// Each runs in the request's scoped kept_app transaction (scopedWrite) and writes its own audit
// row there; the definers (merge_places, convert_place_to_container) write none. Renaming or
// re-parenting leaves the breadcrumbs and search documents under the place stale until
// kept.reindex_location() runs, so those writes enqueue the `reindex` job (T20).

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  jobs: JobQueue | null;
  requestId: string;
};

const actor = (scope: Scope) => actorOf(scope);

/** Undo for moves and edits (D150): the audit trigger allows at most 7 days from the
 * transaction's start, which is a little before now, so stay a minute inside it. */
const undoableUntil = () => new Date(Date.now() + 7 * 24 * 3600_000 - 60_000);

export const NAME = z.string().trim().min(1).max(120);
export const KIND_KEY = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const ICON = z.string().regex(/^(lucide|tabler|kept):[a-z0-9-]+$/);

/** Places, like the definers, serialise tree changes per location (0005, 0021). */
async function lockTree(client: pg.ClientBase, locationId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('kept.places'), hashtext($1::text))`, [
    locationId,
  ]);
}

/** The live place `id` names as a parent or destination, in `locationId`: 404 otherwise (a place
 * elsewhere is as absent as one that doesn't exist). */
async function requireParent(
  client: pg.ClientBase,
  locationId: string,
  id: string,
): Promise<PlaceRow> {
  const parent = await findPlace(client, id);
  if (!parent || parent.locationId !== locationId) throw notFound();
  return parent;
}

const UNDER_UNPLACED =
  "Places can't go inside the Unplaced area; it holds things only. Choose another place.";

async function requireKind(client: pg.ClientBase, ownerAccountId: string, key: string) {
  const kind = await placeKindOf(client, ownerAccountId, key);
  if (!kind || kind.archivedAt)
    throw invalid(`Check body.kindKey: there is no place kind "${key}".`);
  return kind;
}

/** Whether `role` may merge or permanently delete places: owners and admins (§7.1 "Delete
 * permanently"; merging removes the source place for good). */
function requireOwnerOrAdmin(role: Role): void {
  if (!can(role, 'things.delete-permanently')) {
    throw forbidden('Only owners and admins can do that.');
  }
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export const CreatePlaceBody = z.object({
  id: z.uuid().optional(),
  parentId: z.uuid().nullable().optional(),
  name: NAME,
  kindKey: KIND_KEY,
  icon: ICON.optional(),
});
export type CreatePlaceBody = z.infer<typeof CreatePlaceBody>;

export async function createPlace(
  c: Ctx,
  locationId: string,
  body: CreatePlaceBody,
  /** `op`: the `create_area` sync op (step-3 T14) checked the id against its own 90-day window.
   * `undoable`: the create can be undone for 7 days (a tool's write, step-6 T9, D124): the place
   * goes to the trash unless something was put in it or it changed since. */
  opts: { via?: 'online' | 'op'; undoable?: boolean } = {},
): Promise<PlaceRow> {
  const me = await requireMembership(c.client, locationId);
  requireCan(me.role, 'things.edit');
  const id = body.id
    ? opts.via === 'op'
      ? body.id.toLowerCase()
      : assertClientId(body.id)
    : newId();
  const { rows: loc } = await c.client.query<{ owner_account_id: string }>(
    'SELECT owner_account_id FROM public.locations WHERE id = $1',
    [locationId],
  );
  const ownerAccountId = loc[0]?.owner_account_id;
  if (!ownerAccountId) throw notFound();
  await requireKind(c.client, ownerAccountId, body.kindKey);
  const parentId = body.parentId ? body.parentId.toLowerCase() : null;
  await lockTree(c.client, locationId);
  if (parentId) {
    const parent = await requireParent(c.client, locationId, parentId);
    if (parent.isUnplaced) throw conflict(UNDER_UNPLACED);
  }
  await c.client.query(
    `INSERT INTO public.places (id, location_id, parent_id, name, kind_key, icon, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT coalesce(max(s.sort) + 1, 0) FROM public.places s
               WHERE s.location_id = $2 AND s.parent_id IS NOT DISTINCT FROM $3::uuid
                 AND NOT s.is_unplaced),
             $7)`,
    [id, locationId, parentId, body.name, body.kindKey, body.icon ?? null, c.scope.userId],
  );
  const created = await requirePlace(c.client, id);
  await audited(c.tx, {
    locationId,
    actor: actor(c.scope),
    action: 'place.create',
    entity: { type: 'place', id },
    after: {
      name: created.name,
      parent_id: created.parentId,
      kind_key: created.kindKey,
      icon: created.icon,
    },
    requestId: c.requestId,
    ...(opts.undoable ? { undoableUntil: undoableUntil() } : {}),
  });
  return created;
}

// ---------------------------------------------------------------------------------------------
// Edit and re-parent
// ---------------------------------------------------------------------------------------------

export const UpdatePlaceBody = z
  .object({
    name: NAME.optional(),
    kindKey: KIND_KEY.optional(),
    icon: ICON.nullable().optional(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
    /** null: the top level of the location (T25 decision 2). */
    parentId: z.uuid().nullable().optional(),
    /** A value per field key; null clears the key. */
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');
export type UpdatePlaceBody = z.infer<typeof UpdatePlaceBody>;

const asFieldDef = (f: ResolvedField): FieldDef => ({
  key: f.key,
  kind: f.kind,
  names: { en: f.label ?? f.key, ar: f.label ?? f.key },
  ...(f.unit ? { unit: f.unit } : {}),
  ...(f.options ? { options: f.options } : {}),
  ...(f.secret ? { secret: true } : {}),
  ...(f.repeatable ? { repeatable: true } : {}),
});

/**
 * The place's `custom` after a patch, validated against its kind's fields (D160): only the
 * kind's live fields take values, each of its kind; a secret field is refused (its value goes
 * through the secrets route, Q3); a required field can't be cleared; and a money field can't be
 * written by someone the money gate hides it from.
 */
function patchCustom(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: readonly ResolvedField[],
  showMoney: boolean,
): { next: Record<string, unknown>; classes: Record<string, FieldClass> } {
  const live = fields.filter((f) => f.archivedAt === null);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const set: Record<string, unknown> = {};
  const cleared: string[] = [];
  const classes: Record<string, FieldClass> = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (field?.secret) {
      throw invalid(`Check body.custom.${key}: secret fields are set through the secrets route.`);
    }
    if (field?.kind === 'money') {
      if (!showMoney) {
        throw new AppError('module_off', 409, 'Money is hidden for you in this location.');
      }
      classes[`custom.${key}`] = 'money';
    }
    if (value === null) {
      if (!field && !Object.hasOwn(current, key)) throw invalid(`Check body.custom.${key}.`);
      if (field?.required && field.archivedAt === null) {
        throw invalid(`Check body.custom.${key}: it is required.`);
      }
      cleared.push(key);
    } else {
      set[key] = value;
    }
  }
  const parsed = customSchema(live.map(asFieldDef)).safeParse(set);
  if (!parsed.success) {
    const keys = [
      ...new Set(
        parsed.error.issues.flatMap((i) =>
          i.code === 'unrecognized_keys' ? i.keys : [String(i.path[0] ?? '')],
        ),
      ),
    ]
      .filter(Boolean)
      .map((k) => `body.custom.${k}`);
    throw invalid(keys.length ? `Check ${keys.join(', ')}.` : 'Check body.custom.');
  }
  // The parsed values: money amounts come out of customSchema in canonical form.
  const next: Record<string, unknown> = { ...current, ...(parsed.data as Record<string, unknown>) };
  for (const key of cleared) delete next[key];
  return { next, classes };
}

export async function updatePlace(
  c: Ctx,
  id: string,
  expected: number,
  body: UpdatePlaceBody,
): Promise<PlaceRow> {
  const seen = await requirePlace(c.client, id);
  const me = await requireMembership(c.client, seen.locationId);
  requireCan(me.role, 'things.edit');
  await lockTree(c.client, seen.locationId);
  const before = await requirePlace(c.client, id, { lock: true });
  const fields = Object.keys(body).filter((k) => body[k as keyof UpdatePlaceBody] !== undefined);
  checkVersion(before, expected, fields, await lastChangedBy(c.client, id));

  const parentChanges =
    body.parentId !== undefined && (body.parentId?.toLowerCase() ?? null) !== before.parentId;
  if (body.parentId !== undefined && before.isUnplaced) {
    throw conflict('The Unplaced area stays at the top of its location.');
  }
  if (parentChanges && body.parentId) {
    const parent = await requireParent(c.client, before.locationId, body.parentId.toLowerCase());
    if (parent.isUnplaced) throw conflict(UNDER_UNPLACED);
  }
  const kindKey = body.kindKey ?? before.kindKey;
  const kind =
    body.kindKey !== undefined && body.kindKey !== before.kindKey
      ? await requireKind(c.client, before.ownerAccountId, body.kindKey)
      : await placeKindOf(c.client, before.ownerAccountId, kindKey);

  let custom: Record<string, unknown> | undefined;
  let classes: Record<string, FieldClass> = {};
  if (body.custom !== undefined) {
    const gate = await gateFor(c.tx, before.locationId, c.scope);
    const out = patchCustom(
      before.custom,
      body.custom,
      await kindFields(c.client, kind),
      gate.showMoney,
    );
    custom = out.next;
    classes = out.classes;
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  const put = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };
  if (body.name !== undefined) put('name', body.name);
  if (body.kindKey !== undefined) put('kind_key', body.kindKey);
  if (body.icon !== undefined) put('icon', body.icon);
  if (body.sort !== undefined) put('sort', body.sort);
  if (parentChanges) put('parent_id', body.parentId?.toLowerCase() ?? null, '::uuid');
  if (custom !== undefined) put('custom', JSON.stringify(custom), '::jsonb');
  if (sets.length > 0) {
    await c.client.query(`UPDATE public.places SET ${sets.join(', ')} WHERE id = $1`, values);
  }
  const after = await requirePlace(c.client, id);

  const image = (p: PlaceRow) => {
    const out: Record<string, unknown> = {
      name: p.name,
      kind_key: p.kindKey,
      icon: p.icon,
      sort: p.sort,
      parent_id: p.parentId,
    };
    // Custom is audited per key (plan "Custom-field audit"), so a money field is classed alone.
    const keys = new Set([...Object.keys(before.custom), ...Object.keys(after.custom)]);
    for (const key of keys) out[`custom.${key}`] = p.custom[key] ?? null;
    return out;
  };
  const moveOnly = parentChanges && Object.keys(body).every((k) => k === 'parentId');
  await audited(c.tx, {
    locationId: before.locationId,
    actor: actor(c.scope),
    action: moveOnly ? 'place.move' : 'place.update',
    entity: { type: 'place', id },
    before: image(before),
    after: image(after),
    fieldClasses: classes,
    requestId: c.requestId,
    undoableUntil: undoableUntil(),
  });
  if (parentChanges || after.name !== before.name) {
    await enqueueReindex(c.jobs, c.client, before.locationId);
  }
  return after;
}

// ---------------------------------------------------------------------------------------------
// Trash (D45, D160, D162)
// ---------------------------------------------------------------------------------------------

export const MoveTarget = z.union([
  z.strictObject({ placeId: z.uuid() }),
  z.strictObject({ containerId: z.uuid() }),
]);

export const TrashBody = z
  .object({
    contents: z.enum(['move', 'trash']).optional(),
    moveTo: MoveTarget.optional(),
  })
  .optional();
export type TrashBody = z.infer<typeof TrashBody>;

export type TrashResult = { trashed: string[]; moved: string[]; trashBatchId: string };

/** The place and every place under it, live or not. */
async function subtreeOf(client: pg.ClientBase, placeId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT $1::uuid
       UNION
       SELECT c.id FROM public.places c JOIN sub ON c.parent_id = sub.id
     )
     SELECT id FROM sub`,
    [placeId],
  );
  return rows.map((r) => r.id);
}

/** Every thing in those places, and inside the containers within them, however deep. */
async function thingsUnder(
  client: pg.ClientBase,
  placeIds: readonly string[],
): Promise<{ id: string; deleted: boolean }[]> {
  const { rows } = await client.query<{ id: string; deleted: boolean }>(
    `WITH RECURSIVE inside(id) AS (
       SELECT t.id FROM public.things t WHERE t.place_id = ANY ($1::uuid[])
       UNION
       SELECT t.id FROM public.things t JOIN inside i ON t.container_id = i.id
     )
     SELECT t.id, t.deleted_at IS NOT NULL AS deleted
       FROM public.things t WHERE t.id IN (SELECT id FROM inside)`,
    [placeIds],
  );
  return rows;
}

async function directCounts(
  client: pg.ClientBase,
  placeId: string,
): Promise<{ places: number; things: number }> {
  const { rows } = await client.query<{ places: number; things: number }>(
    `SELECT (SELECT count(*) FROM public.places c
              WHERE c.parent_id = $1 AND c.deleted_at IS NULL)::int AS places,
            (SELECT count(*) FROM public.things t
              WHERE t.place_id = $1 AND t.deleted_at IS NULL)::int AS things`,
    [placeId],
  );
  return rows[0] ?? { places: 0, things: 0 };
}

const OUTSIDE = 'Choose a place outside the one you are trashing.';

export async function trashPlace(
  c: Ctx,
  id: string,
  expected: number | null,
  body: TrashBody,
): Promise<TrashResult> {
  const seen = await requirePlace(c.client, id);
  const me = await requireMembership(c.client, seen.locationId);
  requireCan(me.role, 'things.trash');
  if (seen.isUnplaced) throw conflict("The Unplaced area can't be trashed.");
  await lockTree(c.client, seen.locationId);
  const place = await requirePlace(c.client, id, { lock: true });
  if (expected !== null) checkVersion(place, expected, [], await lastChangedBy(c.client, id));

  const counts = await directCounts(c.client, id);
  const hasContents = counts.places + counts.things > 0;
  if (hasContents && !body?.contents) {
    throw new AppError(
      'contents_choice_required',
      409,
      'Move what is inside elsewhere, or trash it too.',
      { counts },
    );
  }

  const batch = newId();
  const trashed: string[] = [id];
  const moved: string[] = [];
  const subjects: string[] = [];
  const loc = place.locationId;
  // What moved out, and where to, so undo can put back what is still there (places/undo.ts,
  // `place.trash`; as thing.trash does, security review #30).
  let movedOut: {
    moved_thing_ids: string[];
    moved_place_ids: string[];
    moved_to: { place_id: string | null; container_id: string | null; parent_id: string | null };
  } | null = null;

  if (hasContents && body?.contents === 'trash') {
    const live = (await subtreeOf(c.client, id)).filter((x) => x !== id);
    const { rows: places } = await c.client.query<{ id: string }>(
      `UPDATE public.places SET deleted_at = now(), trash_batch_id = $2
        WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL RETURNING id`,
      [live, batch],
    );
    const inside = (await thingsUnder(c.client, [id, ...live]))
      .filter((t) => !t.deleted)
      .map((t) => t.id);
    const { rows: things } = await c.client.query<{ id: string }>(
      `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2
        WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL RETURNING id`,
      [inside, batch],
    );
    trashed.push(...places.map((r) => r.id), ...things.map((r) => r.id));
    subjects.push(...things.map((r) => r.id));
  } else if (hasContents) {
    // Where the contents go (T25 decision 6): by default, the place's parent, or at the top
    // level the Unplaced area for things and the top level itself for places. A chosen place
    // takes both (unless it is the Unplaced area, which takes things only); a chosen container
    // takes the things, and the places go to the default.
    const unplaced = await unplacedOf(c.client, loc);
    const sub = new Set(await subtreeOf(c.client, id));
    let thingPlace: string | null = place.parentId ?? unplaced;
    let thingContainer: string | null = null;
    let childParent: string | null = place.parentId;
    const to = body?.moveTo;
    if (to && 'placeId' in to) {
      const target = await requireParent(c.client, loc, to.placeId.toLowerCase());
      if (sub.has(target.id)) throw conflict(OUTSIDE);
      thingPlace = target.id;
      childParent = target.isUnplaced ? null : target.id;
    } else if (to && 'containerId' in to) {
      const containerId = to.containerId.toLowerCase();
      const { rows } = await c.client.query<{ id: string; location_id: string }>(
        'SELECT id, location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
        [containerId],
      );
      if (!rows[0] || rows[0].location_id !== loc) throw notFound();
      const inside = new Set((await thingsUnder(c.client, [...sub])).map((t) => t.id));
      if (inside.has(containerId)) throw conflict(OUTSIDE);
      thingPlace = null;
      thingContainer = containerId;
    }
    const { rows: things } = await c.client.query<{ id: string }>(
      `UPDATE public.things SET place_id = $2::uuid, container_id = $3::uuid
        WHERE place_id = $1 AND deleted_at IS NULL RETURNING id`,
      [id, thingPlace, thingContainer],
    );
    const { rows: places } = await c.client.query<{ id: string }>(
      `UPDATE public.places SET parent_id = $2::uuid
        WHERE parent_id = $1 AND deleted_at IS NULL RETURNING id`,
      [id, childParent],
    );
    moved.push(...things.map((r) => r.id), ...places.map((r) => r.id));
    subjects.push(...things.map((r) => r.id));
    movedOut = {
      moved_thing_ids: things.map((r) => r.id),
      moved_place_ids: places.map((r) => r.id),
      moved_to: { place_id: thingPlace, container_id: thingContainer, parent_id: childParent },
    };
  }

  await c.client.query(
    'UPDATE public.places SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1',
    [id, batch],
  );
  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'place.trash',
    entity: { type: 'place', id },
    before: { deleted_at: null, trash_batch_id: null },
    after: {
      deleted_at: new Date(),
      trash_batch_id: batch,
      contents: hasContents ? (body?.contents ?? null) : null,
      trashed: trashed.length,
      moved: moved.length,
      ...(movedOut ?? {}),
    },
    subjects,
    requestId: c.requestId,
    undoableUntil: undoableUntil(),
  });
  if (moved.length > 0) await enqueueReindex(c.jobs, c.client, loc);
  return { trashed, moved, trashBatchId: batch };
}

// ---------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------

export type RestoreResult = { restored: string[]; hint?: string };

export async function restorePlace(c: Ctx, id: string): Promise<RestoreResult> {
  const seen = await requirePlace(c.client, id, { trashed: 'any' });
  const me = await requireMembership(c.client, seen.locationId);
  requireCan(me.role, 'things.trash');
  if (!seen.deletedAt) throw conflict("It isn't in the trash.");
  const loc = seen.locationId;
  await lockTree(c.client, loc);

  // The whole batch comes back together (D162): the place, and whatever was trashed with it.
  const batch = seen.trashBatchId;
  const { rows: places } = await c.client.query<{ id: string }>(
    `UPDATE public.places SET deleted_at = NULL, trash_batch_id = NULL
      WHERE location_id = $1 AND deleted_at IS NOT NULL
        AND (id = $2 OR ($3::uuid IS NOT NULL AND trash_batch_id = $3::uuid))
      RETURNING id`,
    [loc, id, batch],
  );
  const { rows: things } = batch
    ? await c.client.query<{ id: string }>(
        `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
          WHERE location_id = $1 AND trash_batch_id = $2 AND deleted_at IS NOT NULL
          RETURNING id`,
        [loc, batch],
      )
    : { rows: [] };

  // What was under something that is still in the trash can't go back there: a place goes to
  // the top level (places never go inside the Unplaced area), a thing to the Unplaced area.
  const restoredPlaces = places.map((r) => r.id);
  const restoredThings = things.map((r) => r.id);
  const { rows: orphanPlaces } = await c.client.query<{ id: string }>(
    `UPDATE public.places p SET parent_id = NULL
      WHERE p.id = ANY ($1::uuid[])
        AND EXISTS (SELECT 1 FROM public.places q
                     WHERE q.id = p.parent_id AND q.deleted_at IS NOT NULL)
      RETURNING p.id`,
    [restoredPlaces],
  );
  const unplaced = await unplacedOf(c.client, loc);
  const { rows: orphanThings } = await c.client.query<Orphan>(
    `UPDATE public.things t SET place_id = $2::uuid, container_id = NULL
      WHERE t.id = ANY ($1::uuid[])
        AND (EXISTS (SELECT 1 FROM public.places q
                      WHERE q.id = t.place_id AND q.deleted_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM public.things x
                         WHERE x.id = t.container_id AND x.deleted_at IS NOT NULL))
      RETURNING ${ORPHAN_RETURNING}`,
    [restoredThings, unplaced],
  );
  const hints: string[] = [];
  if (orphanPlaces.length > 0) {
    hints.push('Some places went to the top level: where they were is still in the trash.');
  }
  if (orphanThings.length > 0) {
    hints.push('Some things went to Unplaced: where they were is still in the trash.');
  }

  const restored = [...restoredPlaces, ...restoredThings];
  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'place.restore',
    entity: { type: 'place', id },
    before: { deleted_at: seen.deletedAt, trash_batch_id: batch },
    after: { deleted_at: null, trash_batch_id: null, restored: restored.length },
    subjects: restoredThings,
    requestId: c.requestId,
  });
  // Each thing sent to the Unplaced area gets its own move row (security review #30).
  await auditRelocations(
    c.tx,
    { locationId: loc, actor: actor(c.scope), requestId: c.requestId },
    orphanThings.map(relocationOf),
  );
  if (orphanPlaces.length + orphanThings.length > 0) {
    await enqueueReindex(c.jobs, c.client, loc);
  }
  return { restored, ...(hints.length ? { hint: hints.join(' ') } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Delete permanently
// ---------------------------------------------------------------------------------------------

export async function deletePlace(c: Ctx, id: string): Promise<void> {
  const seen = await requirePlace(c.client, id, { trashed: 'any' });
  const me = await requireMembership(c.client, seen.locationId);
  requireOwnerOrAdmin(me.role);
  if (!seen.deletedAt) throw conflict('Only a place in the trash can be deleted for good.');
  const loc = seen.locationId;
  await lockTree(c.client, loc);

  const sub = await subtreeOf(c.client, id);
  const { rows: livePlaces } = await c.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.places WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL',
    [sub],
  );
  const inside = await thingsUnder(c.client, sub);
  if ((livePlaces[0]?.n ?? 0) > 0 || inside.some((t) => !t.deleted)) {
    throw conflict('Something inside it is no longer in the trash. Move it out first.');
  }
  const thingIds = inside.map((t) => t.id);
  // Audited first: the event names the place, which is gone afterwards, and the things deleted
  // with it as subjects, so each one's history ends with this row (audit_event_subjects has no
  // foreign key to things; the rows outlive them).
  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'place.delete',
    entity: { type: 'place', id },
    before: { name: seen.name, parent_id: seen.parentId, deleted_at: seen.deletedAt },
    after: null,
    subjects: thingIds,
    requestId: c.requestId,
  });
  if (thingIds.length > 0) {
    await c.client.query('DELETE FROM public.things WHERE id = ANY ($1::uuid[])', [thingIds]);
  }
  await c.client.query('DELETE FROM public.places WHERE id = ANY ($1::uuid[])', [sub]);
  // Tombstones, so offline clients drop them too (§7.13, D156).
  await c.client.query(
    `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
     SELECT $1, e.type, e.id
       FROM (SELECT 'place'::text AS type, unnest($2::uuid[]) AS id
             UNION ALL
             SELECT 'thing', unnest($3::uuid[])) e
     ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now()`,
    [loc, sub, thingIds],
  );
}

// ---------------------------------------------------------------------------------------------
// Merge (D160)
// ---------------------------------------------------------------------------------------------

export const MergeBody = z.object({
  targetId: z.uuid(),
  /** The source place's row version (T25 decision 5); the target's comes in If-Match. */
  sourceRowVersion: z.number().int().min(0),
});
export type MergeBody = z.infer<typeof MergeBody>;

export async function mergePlace(
  c: Ctx,
  id: string,
  expectedTarget: number,
  body: MergeBody,
): Promise<PlaceRow> {
  const seen = await requirePlace(c.client, id);
  const me = await requireMembership(c.client, seen.locationId);
  requireOwnerOrAdmin(me.role);
  const targetId = body.targetId.toLowerCase();
  if (targetId === id) throw conflict("A place can't be merged into itself.");
  await lockTree(c.client, seen.locationId);
  const source = await requirePlace(c.client, id, { lock: true });
  const target = await requireParent(c.client, source.locationId, targetId);
  await requirePlace(c.client, targetId, { lock: true });
  checkVersion(
    source,
    body.sourceRowVersion,
    ['sourceRowVersion'],
    await lastChangedBy(c.client, id),
  );
  checkVersion(target, expectedTarget, ['targetId'], await lastChangedBy(c.client, targetId));

  const { rows: movedThings } = await c.client.query<{ id: string }>(
    'SELECT id FROM public.things WHERE place_id = $1',
    [id],
  );
  const { rows } = await c.client.query<{ n: number }>('SELECT kept.merge_places($1, $2) AS n', [
    id,
    targetId,
  ]);
  await audited(c.tx, {
    locationId: source.locationId,
    actor: actor(c.scope),
    action: 'place.merge',
    entity: { type: 'place', id },
    before: { name: source.name, parent_id: source.parentId, merged_into: null },
    after: { merged_into: targetId, things_moved: rows[0]?.n ?? 0 },
    subjects: movedThings.map((r) => r.id),
    requestId: c.requestId,
  });
  await enqueueReindex(c.jobs, c.client, source.locationId);
  return requirePlace(c.client, targetId);
}

// ---------------------------------------------------------------------------------------------
// Convert to a container (Q14: the same id)
// ---------------------------------------------------------------------------------------------

export const ConvertBody = z.object({ typeId: z.uuid().optional() }).optional();
export type ConvertBody = z.infer<typeof ConvertBody>;

export async function convertToContainer(
  c: Ctx,
  id: string,
  expected: number | null,
  body: ConvertBody,
): Promise<{ thingId: string }> {
  const seen = await requirePlace(c.client, id);
  const me = await requireMembership(c.client, seen.locationId);
  requireCan(me.role, 'things.edit');
  if (expected !== null) {
    await lockTree(c.client, seen.locationId);
    const locked = await requirePlace(c.client, id, { lock: true });
    checkVersion(locked, expected, [], await lastChangedBy(c.client, id));
  }
  const { rows: contents } = await c.client.query<{ id: string }>(
    'SELECT id FROM public.things WHERE place_id = $1 AND deleted_at IS NULL',
    [id],
  );
  const { rows } = await c.client.query<{ id: string }>(
    'SELECT kept.convert_place_to_container($1, $2) AS id',
    [id, body?.typeId?.toLowerCase() ?? null],
  );
  const thingId = rows[0]?.id ?? id;
  await audited(c.tx, {
    locationId: seen.locationId,
    actor: actor(c.scope),
    action: 'place.convert_to_container',
    entity: { type: 'place', id },
    before: { entity_type: 'place', name: seen.name, parent_id: seen.parentId },
    after: { entity_type: 'thing', thing_id: thingId },
    subjects: [thingId, ...contents.map((r) => r.id)],
    requestId: c.requestId,
  });
  await enqueueReindex(c.jobs, c.client, seen.locationId);
  return { thingId };
}

// ---------------------------------------------------------------------------------------------
// Label (D120, D160; printing is step 3)
// ---------------------------------------------------------------------------------------------

export async function labelPlace(
  c: Ctx,
  id: string,
  generate?: () => string,
): Promise<{ code: string }> {
  const place = await requirePlace(c.client, id);
  const me = await requireMembership(c.client, place.locationId);
  requireCan(me.role, 'labels.use');
  const { rows } = await c.client.query<{ code: string }>(
    `SELECT code FROM public.short_ids
      WHERE place_id = $1 AND is_primary AND state = 'assigned' LIMIT 1`,
    [id],
  );
  const existing = rows[0]?.code;
  if (existing) return { code: existing };
  const code = await allocateShortId(c.client, place.locationId, { placeId: id }, generate);
  await audited(c.tx, {
    locationId: place.locationId,
    actor: actor(c.scope),
    action: 'place.label',
    entity: { type: 'place', id },
    before: { short_code: null },
    after: { short_code: code },
    requestId: c.requestId,
  });
  return { code };
}
