import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import type { FieldClass } from '../audit/classes.js';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { AppError, conflict } from '../http/errors.js';
import { requireCan } from '../locations/access.js';
import { enqueueReindex } from '../search/jobs.js';
import { gateFor } from '../serialize/gates.js';
import {
  auditRelocations,
  ORPHAN_RETURNING,
  type Orphan,
  relocationOf,
} from '../things/relocate.js';
import { findPlace, type PlaceRow, placeKindOf } from './view.js';

// The undo handlers of places (D58, D124, D150; T27's decision), registered with audit/undo.ts.
//
// `place.update` and `place.move` are both written by PATCH /api/v1/places/:id (service.ts,
// updatePlace): `place.move` when the request changed only the parent. Their diff is the place's
// image: `name`, `kind_key`, `icon`, `sort`, `parent_id` and `custom.<key>`, of which only the
// changed fields are stored. Undo checks that every one still holds the event's `after` (D124:
// "Can't undo: Alfred changed name since"), then writes each `before` back and audits the reverse
// under the same action. A parent it would go back under must still be a live place of the same
// location (a trashed one is a 409), a kind it goes back to must still be offered (an archived or
// deleted one is a 409), and the place-loop trigger still guards the tree (409). A
// money field of the place's kind is undone only by someone who sees money there, as for an edit
// (409 `module_off`).
//
// `place.trash` (T20): the trashed batch comes back, and what the trash moved out goes back in
// (undoPlaceTrash below).

const COLUMNS = ['name', 'kind_key', 'icon', 'sort', 'parent_id'] as const;
type Column = (typeof COLUMNS)[number];
const IS_COLUMN = new Set<string>(COLUMNS);

/** The place as updatePlace() audits it, with the custom keys named. */
function imageOf(p: PlaceRow, customKeys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: p.name,
    kind_key: p.kindKey,
    icon: p.icon,
    sort: p.sort,
    parent_id: p.parentId,
  };
  for (const key of customKeys) out[`custom.${key}`] = p.custom[key] ?? null;
  return out;
}

/** Serialises tree changes per location, as updatePlace() and the definers do. */
async function lockTree(client: pg.ClientBase, locationId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('kept.places'), hashtext($1::text))`, [
    locationId,
  ]);
}

async function undoPlace(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'place' || !id) throw notUndoable();
  const seen = await findPlace(client, id, { trashed: 'any' });
  if (!seen || seen.locationId !== event.locationId) {
    throw conflict("Can't undo: that place no longer exists.");
  }
  if (seen.deletedAt) throw conflict("Can't undo: it is in the trash now.");
  await lockTree(client, seen.locationId);
  const current = (await findPlace(client, id, { lock: true })) as PlaceRow;

  const diff = event.diff;
  const customKeys = Object.keys(diff)
    .filter((f) => f.startsWith('custom.'))
    .map((f) => f.slice('custom.'.length));
  const conflicts = changedSince(diff, imageOf(current, customKeys));
  if (conflicts.length > 0) {
    const who = await lastChangedBy(client, event.locationId, { type: 'place', id }, event.at);
    throw undoConflict(conflicts, who);
  }

  const classes: Record<string, FieldClass> = {};
  const back: Partial<Record<Column, unknown>> = {};
  const custom: Record<string, unknown> = { ...current.custom };
  for (const [field, change] of Object.entries(diff)) {
    if (!('before' in change)) throw notUndoable();
    const was = change.before ?? null;
    if (change.class === 'money') classes[field] = 'money';
    if (IS_COLUMN.has(field)) back[field as Column] = was;
    else if (field.startsWith('custom.')) {
      const key = field.slice('custom.'.length);
      if (was === null) delete custom[key];
      else custom[key] = was;
    } else throw notUndoable();
  }
  if (Object.keys(classes).length > 0) {
    const gate = await gateFor(args.tx, current.locationId, args.scope);
    if (!gate.showMoney) {
      throw new AppError('module_off', 409, 'Money is hidden for you in this location.');
    }
  }
  // The kind it goes back to must still be one the account offers, as for an edit
  // (updatePlace()'s requireKind): an archived or deleted kind is a 409, not a 400.
  if (typeof back.kind_key === 'string' && back.kind_key !== current.kindKey) {
    const kind = await placeKindOf(client, current.ownerAccountId, back.kind_key);
    if (!kind || kind.archivedAt) {
      throw conflict("Can't undo: the place kind it had is archived or no longer exists.");
    }
  }
  const parent = back.parent_id;
  if (typeof parent === 'string') {
    const under = await findPlace(client, parent, { trashed: 'any' });
    if (!under || under.locationId !== current.locationId) {
      throw conflict("Can't undo: the place it was in no longer exists.");
    }
    if (under.deletedAt) throw conflict("Can't undo: the place it was in is in the trash.");
  }

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const column of COLUMNS) {
    if (!(column in back)) continue;
    values.push(back[column]);
    sets.push(`${column} = $${values.length}${column === 'parent_id' ? '::uuid' : ''}`);
  }
  if (customKeys.length > 0) {
    values.push(JSON.stringify(custom));
    sets.push(`custom = $${values.length}::jsonb`);
  }
  if (sets.length > 0) {
    await client.query(`UPDATE public.places SET ${sets.join(', ')} WHERE id = $1`, values);
  }
  const after = (await findPlace(client, id)) as PlaceRow;
  await args.audit({
    action: event.action,
    entity: { type: 'place', id },
    before: imageOf(current, customKeys),
    after: imageOf(after, customKeys),
    fieldClasses: classes,
  });
  if (after.parentId !== current.parentId || after.name !== current.name) {
    await enqueueReindex(args.deps.jobs, client, current.locationId);
  }
}

/**
 * Undo of `place.trash` (T20, D150): the batch comes back if the place is still in the trash
 * with it, as a restore brings it back (restorePlace): anything whose parent place or container
 * is still in the trash goes to the top level (a place) or the Unplaced area (a thing). What the
 * trash moved out (`moved_thing_ids`, `moved_place_ids`, `moved_to`) goes back in, where it is
 * still where the trash put it; anything moved on since stays where it is now.
 */
async function undoPlaceTrash(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'place' || !id) throw notUndoable();
  requireCan(args.role, 'things.trash');
  const loc = event.locationId;
  await lockTree(client, loc);
  const seen = await findPlace(client, id, { trashed: 'any', lock: true });
  if (!seen || seen.locationId !== loc) {
    throw conflict("Can't undo: that place no longer exists.");
  }
  const batch = (event.diff.trash_batch_id?.after as string | null | undefined) ?? null;
  if (!seen.deletedAt || (batch && seen.trashBatchId !== batch)) {
    const who = await lastChangedBy(client, loc, { type: 'place', id }, event.at);
    throw undoConflict(['deleted_at'], who);
  }

  const { rows: places } = await client.query<{ id: string }>(
    `UPDATE public.places SET deleted_at = NULL, trash_batch_id = NULL
      WHERE location_id = $1 AND deleted_at IS NOT NULL
        AND (id = $2 OR ($3::uuid IS NOT NULL AND trash_batch_id = $3::uuid))
      RETURNING id`,
    [loc, id, batch],
  );
  const { rows: things } = batch
    ? await client.query<{ id: string }>(
        `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
          WHERE location_id = $1 AND trash_batch_id = $2 AND deleted_at IS NOT NULL
          RETURNING id`,
        [loc, batch],
      )
    : { rows: [] };
  const restoredPlaces = places.map((r) => r.id);
  const restoredThings = things.map((r) => r.id);
  await client.query(
    `UPDATE public.places p SET parent_id = NULL
      WHERE p.id = ANY ($1::uuid[])
        AND EXISTS (SELECT 1 FROM public.places q
                     WHERE q.id = p.parent_id AND q.deleted_at IS NOT NULL)`,
    [restoredPlaces],
  );
  const { rows: orphans } = await client.query<Orphan>(
    `UPDATE public.things t
        SET place_id = (SELECT u.id FROM public.places u
                         WHERE u.location_id = t.location_id AND u.is_unplaced),
            container_id = NULL
      WHERE t.id = ANY ($1::uuid[])
        AND (EXISTS (SELECT 1 FROM public.places q
                      WHERE q.id = t.place_id AND q.deleted_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM public.things x
                         WHERE x.id = t.container_id AND x.deleted_at IS NOT NULL))
      RETURNING ${ORPHAN_RETURNING}`,
    [restoredThings],
  );

  // What the trash moved out goes back in, if it is still where the trash put it.
  const to = event.diff.moved_to?.after as
    | { place_id: string | null; container_id: string | null; parent_id: string | null }
    | undefined;
  const ids = (field: string): string[] => {
    const v = event.diff[field]?.after;
    return Array.isArray(v) ? (v as string[]) : [];
  };
  let back: Orphan[] = [];
  if (to) {
    ({ rows: back } = await client.query<Orphan>(
      `UPDATE public.things t SET place_id = $2, container_id = NULL
        WHERE t.id = ANY ($1::uuid[]) AND t.location_id = $5 AND t.deleted_at IS NULL
          AND t.place_id IS NOT DISTINCT FROM $3::uuid
          AND t.container_id IS NOT DISTINCT FROM $4::uuid
        RETURNING ${ORPHAN_RETURNING}`,
      [ids('moved_thing_ids'), id, to.place_id, to.container_id, loc],
    ));
    await client.query(
      `UPDATE public.places SET parent_id = $2
        WHERE id = ANY ($1::uuid[]) AND location_id = $4 AND deleted_at IS NULL
          AND parent_id IS NOT DISTINCT FROM $3::uuid`,
      [ids('moved_place_ids'), id, to.parent_id, loc],
    );
  }

  await args.audit({
    action: 'place.trash',
    entity: { type: 'place', id },
    before: { deleted_at: seen.deletedAt, trash_batch_id: batch },
    after: {
      deleted_at: null,
      trash_batch_id: null,
      restored: restoredPlaces.length + restoredThings.length,
    },
    subjects: [...restoredThings, ...back.map((b) => b.id)],
  });
  await auditRelocations(
    args.tx,
    { locationId: loc, actor: actorOf(args.scope), requestId: args.requestId },
    [...orphans, ...back].map(relocationOf),
  );
  await enqueueReindex(args.deps.jobs, client, loc);
}

let registered = false;

/** Registers the places' undo handlers (idempotent; places/routes.ts calls it). */
export function registerPlaceUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('place.update', undoPlace);
  registerUndo('place.move', undoPlace);
  registerUndo('place.trash', undoPlaceTrash);
}
