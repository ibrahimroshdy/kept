import { actorOf } from '../audit/actor.js';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { AppError, conflict } from '../http/errors.js';
import { enqueueReindex } from '../search/jobs.js';
import { gateFor } from '../serialize/gates.js';
import {
  customClasses,
  IMAGE_COLUMNS,
  type ImageColumn,
  moneyShaped,
  moneyShapedClasses,
  readImage,
  type ThingImage,
} from './audit-image.js';
import { resolvedFields } from './fields.js';
import { moveBackForUndo } from './move.js';
import { auditRelocations, ORPHAN_RETURNING, type Orphan, relocationOf } from './relocate.js';
import { requireRole } from './service.js';

// The undo handlers of things (D58, D124, D150; T27 decision), registered with audit/undo.ts.
//
// - `thing.update`, `thing.retype`, `thing.lifecycle` (this task's own events): the diff is an
//   audit image (audit-image.ts), so undo checks that every field the event changed still holds
//   the event's `after`, then writes each `before` back: columns, `custom.<key>`,
//   `archived_custom.<key>` and `tag_ids`.
// - `thing.move` (T15 writes it): the diff holds `place_id` and `container_id`, and `location_id`
//   when the move crossed locations. Undo puts the thing back if it is still where the move left
//   it, through move.ts's moveBackForUndo(): the forward move's checks, definer and audit rows
//   (D124; security review #21). A place or container it came from that is gone meanwhile
//   gives way to the Unplaced area.
// - An image-diffed edit is undone only in the location it was made in (a thing that moved
//   since is a conflict on `location_id`, #20), and money only by someone who sees it (#26).
// - `thing.trash` (T21 writes it): the diff holds `deleted_at` (null → a time) and
//   `trash_batch_id`. Undo restores the batch if the thing is still in the trash with that batch;
//   anything whose place or container is gone meanwhile lands in the Unplaced area.
//
// The event T15 and T21 write must carry those diff fields (audited() with before/after images
// holding them), `entity: {type: 'thing', id}` and `undoableUntil: undoableUntil()`.

async function refuseIfChanged(args: UndoArgs, conflicts: string[]): Promise<void> {
  if (conflicts.length === 0) return;
  const { event, client } = args;
  const who = await lastChangedBy(
    client,
    event.locationId,
    { type: 'thing', id: event.entityId as string },
    event.at,
  );
  throw undoConflict(conflicts, who);
}

const COLUMNS = new Set<string>(IMAGE_COLUMNS);
const JSON_COLUMNS = new Set<ImageColumn>(['aliases']);

/** Writes `image`'s values for `fields` back to the thing. */
async function writeFields(
  args: UndoArgs,
  thingId: string,
  locationId: string,
  current: ThingImage,
  fields: Readonly<Record<string, unknown>>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const custom = { ...prefixed(current, 'custom') };
  const archived = { ...prefixed(current, 'archived_custom') };
  let touchedCustom = false;
  let tags: string[] | null = null;
  for (const [field, value] of Object.entries(fields)) {
    if (COLUMNS.has(field)) {
      values.push(JSON_COLUMNS.has(field as ImageColumn) ? JSON.stringify(value ?? {}) : value);
      sets.push(`${field} = $${values.length}`);
    } else if (field.startsWith('custom.') || field.startsWith('archived_custom.')) {
      const into = field.startsWith('custom.') ? custom : archived;
      const key = field.slice(field.indexOf('.') + 1);
      if (value === null || value === undefined) delete into[key];
      else into[key] = value;
      touchedCustom = true;
    } else if (field === 'tag_ids') {
      tags = Array.isArray(value) ? (value as string[]) : [];
    }
  }
  if (touchedCustom) {
    values.push(JSON.stringify(custom));
    sets.push(`custom = $${values.length}`);
    values.push(JSON.stringify(archived));
    sets.push(`archived_custom = $${values.length}`);
  }
  if (sets.length > 0) {
    values.push(thingId);
    await args.client.query(
      `UPDATE public.things SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    );
  }
  if (tags) {
    await args.client.query(
      'DELETE FROM public.thing_tags WHERE thing_id = $1 AND NOT (tag_id = ANY ($2::uuid[]))',
      [thingId, tags],
    );
    await args.client.query(
      `INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
       SELECT $1, $2, x FROM unnest($3::uuid[]) AS x ON CONFLICT (thing_id, tag_id) DO NOTHING`,
      [locationId, thingId, tags],
    );
  }
}

function prefixed(image: ThingImage, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(image)) {
    if (k.startsWith(`${prefix}.`)) out[k.slice(prefix.length + 1)] = v;
  }
  return out;
}

/** Undo of an image-diffed edit: every changed field back to its `before`. Also the core of
 * `thing.extract`'s undo (undo/registry.ts). */
export async function undoFields(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const thingId = event.entityId;
  if (event.entityType !== 'thing' || !thingId) throw notUndoable();
  await requireRole(client, event.locationId, 'things.edit');
  const current = await readImage(client, thingId, { lock: true });
  if (!current || current.deleted_at !== null) {
    throw conflict("Can't undo: it is in the trash now.");
  }
  // An edit is undone where it was made: a thing that has moved to another location since is a
  // conflict on its location (security review #20), not a write into wherever it is now.
  const { rows: where } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.things WHERE id = $1',
    [thingId],
  );
  if (where[0]?.location_id !== event.locationId) await refuseIfChanged(args, ['location_id']);
  // Only the fields an image holds can be undone; the rest (none today) refuse.
  const diff = event.diff;
  await refuseIfChanged(args, changedSince(diff, current));
  // Money is written back only by someone who sees it there (security review #26), as for an
  // edit: a money-classed field, or a value shaped like money.
  const touchesMoney = Object.values(diff).some(
    (c) => c.class === 'money' || moneyShaped(c.before) || moneyShaped(c.after),
  );
  if (touchesMoney && !(await gateFor(args.tx, event.locationId, args.scope)).showMoney) {
    throw new AppError('module_off', 409, 'Money is hidden for you in this location.');
  }
  const target: Record<string, unknown> = {};
  for (const [field, change] of Object.entries(diff)) {
    if (!('before' in change)) throw notUndoable();
    target[field] = change.before ?? null;
  }
  await writeFields(args, thingId, event.locationId, current, target);
  const after = (await readImage(client, thingId)) as ThingImage;
  const fields = [
    ...(await resolvedFields(client, current.type_id as string | null)),
    ...(await resolvedFields(client, after.type_id as string | null)),
  ];
  if (current.name !== after.name) await enqueueReindex(args.deps.jobs, client, event.locationId);
  await args.audit({
    action: event.action,
    entity: { type: 'thing', id: thingId },
    before: current,
    after,
    fieldClasses: { ...moneyShapedClasses(current, after), ...customClasses(fields) },
    rootThingId: thingId,
    subjects: [thingId],
  });
}

/** Undo of a move: back where it was, if it is still where the move put it. The move itself is
 * move.ts's (security review #21): the forward move's checks, definer and audit rows. */
async function undoMove(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const thingId = event.entityId;
  if (event.entityType !== 'thing' || !thingId) throw notUndoable();
  const { rows } = await client.query<{
    location_id: string;
    place_id: string | null;
    container_id: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT location_id, place_id, container_id, deleted_at FROM public.things
      WHERE id = $1 FOR UPDATE`,
    [thingId],
  );
  const now = rows[0];
  if (!now || now.deleted_at) throw conflict("Can't undo: it is in the trash now.");
  const diff = event.diff;
  const current: Record<string, unknown> = {
    place_id: now.place_id,
    container_id: now.container_id,
    location_id: now.location_id,
  };
  const moved = ['place_id', 'container_id', 'location_id'].filter((f) => f in diff);
  const relevant = Object.fromEntries(moved.map((f) => [f, diff[f] as object]));
  await refuseIfChanged(args, changedSince(relevant, current));
  const before = (f: string) =>
    f in diff ? ((diff[f]?.before as string | null) ?? null) : (current[f] as string | null);
  await requireRole(client, now.location_id, 'things.edit');
  await moveBackForUndo(
    {
      tx: args.tx,
      client,
      scope: args.scope,
      requestId: args.requestId,
      jobs: args.deps.jobs,
      files: args.deps.files,
    },
    thingId,
    {
      locationId: before('location_id') as string,
      placeId: before('place_id'),
      containerId: before('container_id'),
    },
    {
      locationId: event.locationId,
      write: async (e) => {
        await args.audit({
          action: e.action,
          entity: e.entity,
          before: e.before ?? null,
          after: e.after ?? null,
          ...(e.fieldClasses ? { fieldClasses: e.fieldClasses } : {}),
          rootThingId: e.rootThingId ?? null,
          subjects: e.subjects ?? [],
        });
      },
    },
  );
}

/** Undo of a trash: the batch comes back; anything whose place or container is gone meanwhile
 * goes to the Unplaced area. */
async function undoTrash(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const thingId = event.entityId;
  if (event.entityType !== 'thing' || !thingId) throw notUndoable();
  await requireRole(client, event.locationId, 'things.trash');
  const batch = event.diff.trash_batch_id?.after as string | null | undefined;
  const { rows } = await client.query<{ deleted_at: Date | null; trash_batch_id: string | null }>(
    'SELECT deleted_at, trash_batch_id FROM public.things WHERE id = $1 FOR UPDATE',
    [thingId],
  );
  const now = rows[0];
  if (!now?.deleted_at || (batch && now.trash_batch_id !== batch)) {
    await refuseIfChanged(args, ['deleted_at']);
  }
  const restored = await client.query<{ id: string }>(
    `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
      WHERE location_id = $1 AND deleted_at IS NOT NULL
        AND (id = $2 OR ($3::uuid IS NOT NULL AND trash_batch_id = $3::uuid))
      RETURNING id`,
    [event.locationId, thingId, batch ?? null],
  );
  const ids = restored.rows.map((r) => r.id);
  // Whatever comes back into a place or container that is itself gone goes to Unplaced.
  const { rows: orphans } = await client.query<Orphan>(
    `UPDATE public.things t
        SET place_id = (SELECT u.id FROM public.places u
                         WHERE u.location_id = t.location_id AND u.is_unplaced),
            container_id = NULL
      WHERE t.id = ANY ($1::uuid[])
        AND ((t.place_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.places p
                                                  WHERE p.id = t.place_id AND p.deleted_at IS NOT NULL))
             OR (t.container_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.things c
                                                         WHERE c.id = t.container_id
                                                           AND c.deleted_at IS NOT NULL)))
      RETURNING ${ORPHAN_RETURNING}`,
    [ids],
  );
  // What the trash moved out of the container goes back in, if it is still where the trash put
  // it (security review #30); anything moved on since stays where it is now.
  const movedIds = event.diff.moved_ids?.after;
  const movedTo = event.diff.moved_to?.after as
    | { place_id: string | null; container_id: string | null }
    | undefined;
  let back: Orphan[] = [];
  if (Array.isArray(movedIds) && movedIds.length > 0 && movedTo) {
    ({ rows: back } = await client.query<Orphan>(
      `UPDATE public.things t SET place_id = NULL, container_id = $2
        WHERE t.id = ANY ($1::uuid[]) AND t.location_id = $5 AND t.deleted_at IS NULL
          AND t.place_id IS NOT DISTINCT FROM $3::uuid
          AND t.container_id IS NOT DISTINCT FROM $4::uuid
        RETURNING ${ORPHAN_RETURNING}`,
      [movedIds, thingId, movedTo.place_id, movedTo.container_id, event.locationId],
    ));
  }
  await args.audit({
    action: 'thing.trash',
    entity: { type: 'thing', id: thingId },
    before: { deleted_at: now?.deleted_at ?? null, trash_batch_id: now?.trash_batch_id ?? null },
    after: { deleted_at: null, trash_batch_id: null },
    rootThingId: thingId,
    subjects: ids,
  });
  await auditRelocations(
    args.tx,
    {
      locationId: event.locationId,
      actor: actorOf(args.scope),
      requestId: args.requestId,
    },
    [...orphans, ...back].map(relocationOf),
  );
  await enqueueReindex(args.deps.jobs, client, event.locationId);
}

let registered = false;

/** Registers the things' undo handlers (idempotent; things/routes.ts calls it). */
export function registerThingUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('thing.update', undoFields);
  registerUndo('thing.retype', undoFields);
  registerUndo('thing.lifecycle', undoFields);
  registerUndo('thing.move', undoMove);
  registerUndo('thing.trash', undoTrash);
}
