import { newId } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import {
  lastChangedBy,
  registerUndo,
  type UndoArgs,
  undoableUntil,
  undoConflict,
} from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { conflict, notFound } from '../http/errors.js';
import { enqueueReindex } from '../search/jobs.js';
import {
  auditRelocations,
  ORPHAN_RETURNING,
  type Orphan,
  relocationOf,
} from '../things/relocate.js';
import { requireRole } from '../things/service.js';

// Undoing captures (plan T13, T20; D150; screens §8 "Undo this batch", "Undo from the activity
// feed": a capture batch can be undone as a whole, and its unreviewed drafts go to the trash).
//
// - POST /api/v1/captures/batches/:batchId/undo trashes the caller's own drafts of that batch
//   that are still unreviewed (`review_state = 'draft'`) and hold nothing (a draft someone has
//   since put things into is no longer just a capture). Other people's captures, named ones and
//   reviewed ones stay. One `capture.batch_undo` event per location, undoable: undoing it
//   (POST /audit/:eventId/undo) restores them.
// - `thing.capture` is undoable too (Q23): the Undo toast after a capture trashes that thing,
//   unless it has changed since (D124) or holds things now.
// A batch nobody can see is a 404; one with nothing of the caller's to undo answers
// `{trashed: []}` and writes nothing.

export type BatchUndoResult = { trashed: string[] };

type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

type BatchRow = {
  id: string;
  location_id: string;
  mine_draft: boolean;
  holds: boolean;
};

export async function undoCaptureBatch(ctx: Ctx, batchId: string): Promise<BatchUndoResult> {
  const { client, tx, scope } = ctx;
  const { rows } = await client.query<BatchRow>(
    `SELECT t.id, t.location_id,
            (t.created_by = kept.current_user_id() AND t.review_state = 'draft') AS mine_draft,
            EXISTS (SELECT 1 FROM public.things c
                     WHERE c.container_id = t.id AND c.deleted_at IS NULL) AS holds
       FROM public.things t
      WHERE t.capture_batch_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.created_at, t.id`,
    [batchId],
  );
  if (rows.length === 0) {
    // Nothing live: a batch that was never there, or one already undone (its drafts are in the
    // trash; the undo of that undo brings them back).
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.things WHERE capture_batch_id = $1 LIMIT 1',
      [batchId],
    );
    if (!rowCount) throw notFound();
    return { trashed: [] };
  }
  const byLocation = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.mine_draft || r.holds) continue;
    byLocation.set(r.location_id, [...(byLocation.get(r.location_id) ?? []), r.id]);
  }
  const trashed: string[] = [];
  const until = undoableUntil();
  for (const [locationId, ids] of byLocation) {
    await requireRole(client, locationId, 'things.trash');
    const trashBatchId = newId();
    const { rows: done } = await client.query<{ id: string }>(
      `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2
        WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL AND review_state = 'draft'
        RETURNING id`,
      [ids, trashBatchId],
    );
    const here = done.map((r) => r.id);
    if (here.length === 0) continue;
    await audited(tx, {
      locationId,
      actor: { type: 'user', id: scope.userId },
      action: 'capture.batch_undo',
      entity: { type: 'capture_batch', id: batchId },
      before: { trash_batch_id: null, trashed: [] },
      after: { trash_batch_id: trashBatchId, trashed: here },
      subjects: here,
      requestId: ctx.requestId,
      undoableUntil: until,
    });
    trashed.push(...here);
  }
  return { trashed };
}

// ---------------------------------------------------------------------------------------------
// Undo handlers (audit/undo.ts registry)
// ---------------------------------------------------------------------------------------------

/** Whatever comes back into a place or container that is itself gone goes to Unplaced (shared
 * with the inbox's bulk undo, T15). */
export async function rehomeOrphans(args: UndoArgs, ids: readonly string[]): Promise<void> {
  const { client, event } = args;
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
    [[...ids]],
  );
  if (orphans.length === 0) return;
  await auditRelocations(
    args.tx,
    {
      locationId: event.locationId,
      actor: { type: 'user', id: args.scope.userId },
      requestId: args.requestId,
    },
    orphans.map(relocationOf),
  );
  await enqueueReindex(args.deps.jobs, client, event.locationId);
}

/** Undo of "Undo this batch": the drafts it trashed that are still in that trash come back. */
async function undoBatchUndo(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  await requireRole(client, event.locationId, 'things.trash');
  const trashBatchId = event.diff.trash_batch_id?.after;
  if (typeof trashBatchId !== 'string') throw conflict("This change can't be undone.");
  const { rows } = await client.query<{ id: string }>(
    `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
      WHERE location_id = $1 AND trash_batch_id = $2 AND deleted_at IS NOT NULL
      RETURNING id`,
    [event.locationId, trashBatchId],
  );
  const ids = rows.map((r) => r.id);
  // Restored from the trash, or deleted for good, meanwhile.
  if (ids.length === 0) throw undoConflict(['deleted_at']);
  await rehomeOrphans(args, ids);
  await args.audit({
    action: 'capture.batch_undo',
    entity: { type: 'capture_batch', id: event.entityId },
    before: { trash_batch_id: trashBatchId, trashed: ids },
    after: { trash_batch_id: null, restored: ids },
    subjects: ids,
  });
}

/** Undo of a capture (Q23): the thing it made goes to the trash, unless it changed since. */
async function undoCapture(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const thingId = event.entityId;
  if (event.entityType !== 'thing' || !thingId) throw conflict("This change can't be undone.");
  await requireRole(client, event.locationId, 'things.trash');
  const { rows } = await client.query<{ deleted_at: Date | null; holds: boolean }>(
    `SELECT t.deleted_at,
            EXISTS (SELECT 1 FROM public.things c
                     WHERE c.container_id = t.id AND c.deleted_at IS NULL) AS holds
       FROM public.things t WHERE t.id = $1 FOR UPDATE OF t`,
    [thingId],
  );
  const now = rows[0];
  if (!now) throw notFound();
  if (now.deleted_at) throw undoConflict(['deleted_at']);
  if (now.holds) throw undoConflict(['contents']);
  // Anything written about the thing since, by anyone, except what AI filled in on the capture's
  // behalf (thing.extract, T10), which goes with it.
  const { rows: later } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.audit_events e
      WHERE e.location_id = $1 AND e.entity_type = 'thing' AND e.entity_id = $2
        AND e.at > $3 AND e.action NOT IN ('thing.capture', 'thing.extract')`,
    [event.locationId, thingId, event.at],
  );
  if ((later[0]?.n ?? 0) > 0) {
    throw undoConflict(
      ['thing'],
      await lastChangedBy(client, event.locationId, { type: 'thing', id: thingId }, event.at),
    );
  }
  const trashBatchId = newId();
  const { rows: stamped } = await client.query<{ deleted_at: Date }>(
    `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1
     RETURNING deleted_at`,
    [thingId, trashBatchId],
  );
  await args.audit({
    action: 'thing.trash',
    entity: { type: 'thing', id: thingId },
    before: { deleted_at: null, trash_batch_id: null },
    after: { deleted_at: stamped[0]?.deleted_at ?? new Date(), trash_batch_id: trashBatchId },
    rootThingId: thingId,
  });
}

let registered = false;

/** Registers the capture undo handlers (idempotent; capture/routes.ts calls it). */
export function registerCaptureUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('capture.batch_undo', undoBatchUndo);
  registerUndo('thing.capture', undoCapture);
}
