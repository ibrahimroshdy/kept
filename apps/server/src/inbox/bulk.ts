import { isDeepStrictEqual } from 'node:util';
import { newId } from '@kept/shared';
import { z } from 'zod';
import { type AuditEventInput, audited, auditedMany } from '../audit/audited.js';
import {
  lastChangedBy,
  registerUndo,
  type UndoArgs,
  undoableUntil,
  undoConflict,
} from '../audit/undo.js';
import { rehomeOrphans } from '../capture/batch-undo.js';
import { AppError, conflict, invalid, toErrorReply } from '../http/errors.js';
import { moveBackForUndo, moveThings } from '../things/move.js';
import { requireRole, updateThing, writableThing } from '../things/service.js';
import { MoveTarget, type UpdateBody } from '../things/validate.js';
import { type Ctx, openItem, resolveItem } from './service.js';

// Bulk review (plan T15; D36 "inbox bulk actions", D150; screens §5 the bulk bar):
// POST /api/v1/inbox/bulk {ids (≤ 200), action, typeId?, to?, tagIds?} → {results, undo?}
//
// - `accept_names`: drafts that have a name become confirmed (their AI fields confirmed too), and
//   their items resolve `accepted`. A draft without a name is `validation`.
// - `set_type`, `set_tags` (replaces the tags), `set_place` (a move, across locations too): the
//   item's thing changes and the item stays open.
// - `discard`: drafts go to the trash together (one trash batch per location); their items wait
//   hidden behind them, as for one discard (service.ts), so the undo brings both back. A draft
//   that holds something is `contents_choice_required`.
//
// Each id is done in a savepoint of its own: one that fails (gone, not a draft, refused) is
// reported in `results` with its error code and leaves the others done. Every thing changed gets
// its own audit event, not undoable on its own; the selection gets one `inbox.bulk` event per
// location it spans, undoable (D150): its diff holds each thing before and after, and undoing it
// (audit/undo.ts registry) puts every one back, reopening the items it resolved, unless one has
// changed since (D124: 409 with who changed it). The response's `undo` names the first location's
// event, and X-Kept-Audit-Event lists each (http/write.ts).

export const BULK_ACTIONS = [
  'accept_names',
  'set_type',
  'set_place',
  'set_tags',
  'discard',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const BulkBody = z
  .strictObject({
    ids: z.array(z.uuid()).min(1).max(200),
    action: z.enum(BULK_ACTIONS),
    typeId: z.uuid().optional(),
    to: MoveTarget.optional(),
    tagIds: z.array(z.uuid()).max(50).optional(),
  })
  .superRefine((b, c) => {
    const need = { set_type: 'typeId', set_place: 'to', set_tags: 'tagIds' } as const;
    const key = need[b.action as keyof typeof need];
    if (key && b[key] === undefined) {
      c.addIssue({ code: 'custom', path: [key], message: `${b.action} needs ${key}` });
    }
  });
export type BulkBody = z.infer<typeof BulkBody>;

export const BulkResultSchema = z.object({
  results: z.array(z.object({ id: z.uuid(), ok: z.boolean(), error: z.string().optional() })),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).optional(),
});
export type BulkResult = z.infer<typeof BulkResultSchema>;

/** One thing in the bulk event: its id, its item, and the fields the action touched. */
type Snap = { id: string; item: string; resolved?: boolean } & Record<string, unknown>;

type Done = { locationId: string; before: Snap; after: Snap };

const sorted = (ids: readonly string[]) => [...new Set(ids.map((x) => x.toLowerCase()))].sort();

/** The fields of a thing an action touches, as they are now. */
async function fieldsOf(
  client: Ctx['client'],
  thingId: string,
  action: BulkAction,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{
    location_id: string;
    place_id: string | null;
    container_id: string | null;
    type_id: string | null;
    review_state: string;
    field_status: Record<string, unknown>;
    deleted_at: string | null;
    trash_batch_id: string | null;
    tag_ids: string[];
  }>(
    `SELECT t.location_id, t.place_id, t.container_id, t.type_id, t.review_state, t.field_status,
            t.deleted_at::text AS deleted_at, t.trash_batch_id,
            coalesce((SELECT array_agg(g.tag_id::text ORDER BY g.tag_id) FROM public.thing_tags g
                       WHERE g.thing_id = t.id), '{}'::text[]) AS tag_ids
       FROM public.things t WHERE t.id = $1`,
    [thingId],
  );
  const r = rows[0];
  if (!r) return {};
  switch (action) {
    case 'accept_names':
      return { review_state: r.review_state, field_status: r.field_status ?? {} };
    case 'set_type':
      return { type_id: r.type_id };
    case 'set_tags':
      return { tag_ids: sorted(r.tag_ids ?? []) };
    case 'set_place':
      return { location_id: r.location_id, place_id: r.place_id, container_id: r.container_id };
    case 'discard':
      return { deleted_at: r.deleted_at, trash_batch_id: r.trash_batch_id };
  }
}

/** One item of the selection. Throws to report it failed. */
async function bulkOne(
  ctx: Ctx,
  id: string,
  body: BulkBody,
  trashBatches: Map<string, string>,
): Promise<Done> {
  const { client } = ctx;
  const item = await openItem(client, id, null);
  if (!item.thing_id) throw conflict('This item has no thing to change.');
  if ((body.action === 'accept_names' || body.action === 'discard') && item.kind !== 'draft') {
    throw conflict('Only drafts are accepted or discarded here.');
  }
  const thingId = item.thing_id;
  const before: Snap = {
    id: thingId,
    item: item.id,
    ...(await fieldsOf(client, thingId, body.action)),
  };
  let resolved = false;

  switch (body.action) {
    case 'accept_names': {
      const t = await writableThing(client, thingId, 'things.edit');
      if (!t.name?.trim()) throw invalid('A thing needs a name.');
      const status = {
        ...((before.field_status as Record<string, Record<string, unknown>>) ?? {}),
      };
      for (const [field, st] of Object.entries(status)) {
        if (st?.state === 'extracted') status[field] = { ...st, state: 'confirmed' };
      }
      await updateThing(ctx, thingId, t.row_version, {} as UpdateBody, 'thing.update', {
        reviewState: 'confirmed',
        fieldStatus: status,
        undoable: false,
      });
      await resolveItem(ctx, item, 'accepted');
      resolved = true;
      break;
    }
    case 'set_type':
    case 'set_tags': {
      const t = await writableThing(client, thingId, 'things.edit');
      const patch =
        body.action === 'set_type'
          ? { typeId: body.typeId as string }
          : { tagIds: body.tagIds as string[] };
      await updateThing(ctx, thingId, t.row_version, patch as UpdateBody, 'thing.update', {
        undoable: false,
      });
      break;
    }
    case 'set_place': {
      await writableThing(client, thingId, 'things.edit');
      await moveThings(ctx, { thingIds: [thingId], to: body.to as MoveTarget }, null, {
        undoable: false,
      });
      break;
    }
    case 'discard': {
      await writableThing(client, thingId, 'things.trash');
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.things WHERE container_id = $1 AND deleted_at IS NULL`,
        [thingId],
      );
      if ((rows[0]?.n ?? 0) > 0) {
        throw new AppError(
          'contents_choice_required',
          409,
          'Something is inside this draft: discard it on its own page.',
        );
      }
      let batch = trashBatches.get(item.location_id);
      if (!batch) {
        batch = newId();
        trashBatches.set(item.location_id, batch);
      }
      const { rows: stamped } = await client.query<{ deleted_at: Date }>(
        `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1
         RETURNING deleted_at`,
        [thingId, batch],
      );
      await audited(ctx.tx, {
        locationId: item.location_id,
        actor: { type: 'user', id: ctx.scope.userId },
        action: 'thing.trash',
        entity: { type: 'thing', id: thingId },
        before: { deleted_at: null, trash_batch_id: null },
        after: { deleted_at: stamped[0]?.deleted_at ?? new Date(), trash_batch_id: batch },
        rootThingId: thingId,
        requestId: ctx.requestId,
      });
      break;
    }
  }
  const after: Snap = {
    id: thingId,
    item: item.id,
    resolved,
    ...(await fieldsOf(client, thingId, body.action)),
  };
  return { locationId: item.location_id, before, after };
}

/** POST /api/v1/inbox/bulk. */
export async function bulk(ctx: Ctx, body: BulkBody): Promise<BulkResult> {
  const { client } = ctx;
  const ids = [...new Set(body.ids.map((x) => x.toLowerCase()))];
  const results: BulkResult['results'] = [];
  const byLocation = new Map<string, Done[]>();
  const trashBatches = new Map<string, string>();
  for (const id of ids) {
    await client.query('SAVEPOINT inbox_bulk');
    try {
      const done = await bulkOne(ctx, id, body, trashBatches);
      await client.query('RELEASE SAVEPOINT inbox_bulk');
      byLocation.set(done.locationId, [...(byLocation.get(done.locationId) ?? []), done]);
      results.push({ id, ok: true });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT inbox_bulk');
      const reply = toErrorReply(err);
      if (reply.status >= 500) throw err;
      results.push({ id, ok: false, error: reply.body.code });
    }
  }

  // One undoable event per location the selection spans (D150).
  const until = undoableUntil();
  let first: string | null = null;
  for (const [locationId, done] of byLocation) {
    const event = await audited(ctx.tx, {
      locationId,
      actor: { type: 'user', id: ctx.scope.userId },
      action: 'inbox.bulk',
      entity: { type: 'inbox_bulk', id: newId() },
      before: { bulk_action: null, things: done.map((d) => d.before) },
      after: { bulk_action: body.action, things: done.map((d) => d.after) },
      subjects: done.map((d) => d.before.id),
      requestId: ctx.requestId,
      undoableUntil: until,
    });
    first ??= event.id;
  }
  return first ? { results, undo: { eventId: first, until: until.toISOString() } } : { results };
}

// ---------------------------------------------------------------------------------------------
// Undo (audit/undo.ts registry)
// ---------------------------------------------------------------------------------------------

const asSnaps = (v: unknown): Snap[] =>
  Array.isArray(v)
    ? v.filter((s): s is Snap => !!s && typeof s === 'object' && typeof s.id === 'string')
    : [];

/** The fields a snapshot holds, besides its bookkeeping. */
const fieldsIn = (s: Snap): Record<string, unknown> => {
  const { id: _id, item: _item, resolved: _resolved, ...rest } = s;
  return rest;
};

/** Undo of a bulk review: every thing back as it was, and the items it resolved reopened. */
async function undoBulk(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const action = event.diff.bulk_action?.after as BulkAction | undefined;
  if (!action || !BULK_ACTIONS.includes(action)) throw conflict("This change can't be undone.");
  await requireRole(
    client,
    event.locationId,
    action === 'discard' ? 'things.trash' : 'things.edit',
  );
  const befores = asSnaps(event.diff.things?.before);
  const afters = new Map(asSnaps(event.diff.things?.after).map((s) => [s.id, s]));
  const ctx: Ctx = {
    tx: args.tx,
    client,
    scope: args.scope,
    requestId: args.requestId,
    jobs: args.deps.jobs,
    files: args.deps.files,
  };

  // D124: each thing must still be as the bulk action left it.
  for (const before of befores) {
    const after = afters.get(before.id);
    if (!after) continue;
    const want = fieldsIn(after);
    const now = await fieldsOf(client, before.id, action);
    const changed = Object.keys(want).filter(
      (k) => !isDeepStrictEqual(JSON.parse(JSON.stringify(now[k] ?? null)), want[k] ?? null),
    );
    if (changed.length > 0 || Object.keys(now).length === 0) {
      const who = await lastChangedBy(
        client,
        event.locationId,
        { type: 'thing', id: before.id },
        event.at,
      );
      throw undoConflict(changed.length > 0 ? changed : ['thing'], who);
    }
  }

  const events: AuditEventInput[] = [];
  const actor = { type: 'user' as const, id: args.scope.userId };
  if (action === 'discard') {
    const batches = [
      ...new Set([...afters.values()].map((a) => a.trash_batch_id).filter((b) => !!b)),
    ] as string[];
    const { rows } = await client.query<{ id: string }>(
      `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
        WHERE location_id = $1 AND trash_batch_id = ANY ($2::uuid[]) AND deleted_at IS NOT NULL
          AND id = ANY ($3::uuid[])
        RETURNING id`,
      [event.locationId, batches, befores.map((b) => b.id)],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) throw undoConflict(['deleted_at']);
    for (const id of ids) {
      const after = afters.get(id);
      events.push({
        locationId: event.locationId,
        actor,
        action: 'thing.restore',
        entity: { type: 'thing', id },
        before: { deleted_at: after?.deleted_at ?? null, trash_batch_id: after?.trash_batch_id },
        after: { deleted_at: null, trash_batch_id: null, restored: 1 },
        rootThingId: id,
        requestId: args.requestId,
      });
    }
    await auditedMany(args.tx, events);
    await rehomeOrphans(args, ids);
  } else {
    for (const before of befores) {
      if (!afters.has(before.id)) continue;
      if (action === 'set_place') {
        await moveBackForUndo(
          ctx,
          before.id,
          {
            locationId: before.location_id as string,
            placeId: (before.place_id as string | null) ?? null,
            containerId: (before.container_id as string | null) ?? null,
          },
          {
            locationId: before.location_id as string,
            write: async (e) => {
              await audited(args.tx, e);
            },
          },
        );
        continue;
      }
      const t = await writableThing(client, before.id, 'things.edit');
      if (action === 'accept_names') {
        await updateThing(ctx, before.id, t.row_version, {} as UpdateBody, 'thing.update', {
          reviewState: 'draft',
          fieldStatus: (before.field_status as Record<string, unknown>) ?? {},
          undoable: false,
        });
      } else if (action === 'set_type') {
        await updateThing(
          ctx,
          before.id,
          t.row_version,
          { typeId: (before.type_id as string | null) ?? null } as UpdateBody,
          'thing.update',
          { undoable: false },
        );
      } else {
        await updateThing(
          ctx,
          before.id,
          t.row_version,
          { tagIds: (before.tag_ids as string[]) ?? [] } as UpdateBody,
          'thing.update',
          { undoable: false },
        );
      }
    }
  }

  // The items it resolved are open again, unless another opened for the same subject since.
  const resolvedItems = [...afters.values()].filter((a) => a.resolved === true).map((a) => a.item);
  if (resolvedItems.length > 0) {
    await client.query(
      `UPDATE public.inbox_items i
          SET resolved_at = NULL, resolved_by = NULL, resolution = NULL
        WHERE i.id = ANY ($1::uuid[]) AND i.resolved_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.inbox_items o
             WHERE o.resolved_at IS NULL AND o.kind = i.kind
               AND coalesce(o.thing_id, o.purchase_id, o.meter_reading_id)
                   = coalesce(i.thing_id, i.purchase_id, i.meter_reading_id)
               AND coalesce(o.other_thing_id, '00000000-0000-0000-0000-000000000000'::uuid)
                   = coalesce(i.other_thing_id, '00000000-0000-0000-0000-000000000000'::uuid)
               AND coalesce(o.code, '') = coalesce(i.code, ''))`,
      [resolvedItems],
    );
  }

  await args.audit({
    action: 'inbox.bulk',
    entity: { type: 'inbox_bulk', id: event.entityId },
    before: { bulk_action: action, things: [...afters.values()] },
    after: { bulk_action: null, things: befores },
    subjects: befores.map((b) => b.id),
  });
}

let registered = false;

/** Registers the bulk review's undo handler (idempotent; inbox/routes.ts calls it). */
export function registerInboxUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('inbox.bulk', undoBulk);
}
