import { newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { decodeCursor, encodeCursor, PAGE_DEFAULT, PAGE_MAX } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { filterOf, lowerIds, manyOf, matchOf, notOf, When } from '../http/list-filters.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import {
  type RestoreResult,
  restorePlace,
  type TrashBody,
  type TrashResult,
} from '../places/service.js';
import { unplacedOf } from '../places/view.js';
import { enqueueReindex } from '../search/jobs.js';
import { pathSql } from '../search/query.js';
import {
  auditRelocations,
  ORPHAN_RETURNING,
  type Orphan,
  relocationOf,
} from '../things/relocate.js';
import { requireRole, targetOf, writableThing } from '../things/service.js';
import { TRASH_DAYS } from './jobs.js';

// Trash for things, and the trash list for things and places (T21; D45, D162; screens §5 "Trash":
// restore for members and above, delete permanently for admins and above).
//
// - Trashing a thing sets `deleted_at` and a fresh `trash_batch_id` on it; a container with
//   something in it needs the contents choice first (409 `contents_choice_required`, D45): trash
//   what is inside with it (the same batch, however deep), or move it out (to `moveTo`, or by
//   default to where the container itself is). Reminder sources pause by derivation (§7.6).
// - Restoring brings the whole batch back (D162). A batch that holds places began as a place's
//   trash, so it goes through places/service.ts's restorePlace(), which knows what to do with
//   places whose parent is still in the trash; a batch of things alone is restored here. Either
//   way, whatever was inside something that is still in the trash goes to the Unplaced area,
//   and the answer's `hint` says so.
// - Deleting permanently (trashed things only) removes the thing and whatever is inside it, all
//   of which must be in the trash too, and leaves tombstones so phones drop them (§7.4). Its
//   files become unattached and the purge job deletes them (trash/jobs.ts).
// - The trash list is every trashed thing and place in the locations the caller can see; each
//   row says who trashed it (from the trash event of its batch) and when it will be purged.
//
// Places are trashed, restored and deleted through their own routes (places/routes.ts); the
// web calls those for place rows of the list.

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  jobs: JobQueue | null;
};

const actor = (scope: Scope) => actorOf(scope);

type Found = {
  id: string;
  location_id: string;
  name: string | null;
  place_id: string | null;
  container_id: string | null;
  deleted_at: Date | null;
  trash_batch_id: string | null;
};

/** A thing the caller can see, in the trash or not: 404 otherwise. */
async function anyThing(client: pg.ClientBase, id: string, lock = false): Promise<Found> {
  const { rows } = await client.query<Found>(
    `SELECT id, location_id, name, place_id, container_id, deleted_at, trash_batch_id
       FROM public.things WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Everything inside `containerId`, however deep, with whether it is in the trash. */
async function inside(
  client: pg.ClientBase,
  containerId: string,
): Promise<{ id: string; deleted: boolean }[]> {
  const { rows } = await client.query<{ id: string; deleted: boolean }>(
    `WITH RECURSIVE inner_things(id) AS (
       SELECT t.id FROM public.things t WHERE t.container_id = $1
       UNION
       SELECT t.id FROM public.things t JOIN inner_things i ON t.container_id = i.id
     )
     SELECT t.id, t.deleted_at IS NOT NULL AS deleted
       FROM public.things t WHERE t.id IN (SELECT id FROM inner_things)`,
    [containerId],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------------------------

const OUTSIDE = 'Choose somewhere outside the container you are trashing.';

export async function trashThing(c: Ctx, id: string, body: TrashBody): Promise<TrashResult> {
  const thing = await writableThing(c.client, id, 'things.trash');
  const loc = thing.location_id;
  const { rows: counts } = await c.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.things
      WHERE container_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const direct = counts[0]?.n ?? 0;
  if (direct > 0 && !body?.contents) {
    throw new AppError(
      'contents_choice_required',
      409,
      'Move what is inside elsewhere, or trash it too.',
      { counts: { places: 0, things: direct } },
    );
  }

  const batch = newId();
  const trashed: string[] = [id];
  const moved: string[] = [];
  let movedTo: { place_id: string | null; container_id: string | null } | null = null;
  if (direct > 0 && body?.contents === 'trash') {
    const live = (await inside(c.client, id)).filter((t) => !t.deleted).map((t) => t.id);
    const { rows } = await c.client.query<{ id: string }>(
      `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2
        WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL RETURNING id`,
      [live, batch],
    );
    trashed.push(...rows.map((r) => r.id));
  } else if (direct > 0) {
    // Out of the container: to the chosen place or container in this location, or by default
    // to where the container itself is (its place, or the container it sits in).
    let to = { placeId: thing.place_id, containerId: thing.container_id };
    if (body?.moveTo) {
      to = await targetOf(c.client, loc, body.moveTo);
      const within = new Set([id, ...(await inside(c.client, id)).map((t) => t.id)]);
      if (to.containerId && within.has(to.containerId)) throw conflict(OUTSIDE);
    }
    if (!to.placeId && !to.containerId) to.placeId = await unplacedOf(c.client, loc);
    movedTo = { place_id: to.containerId ? null : to.placeId, container_id: to.containerId };
    const { rows } = await c.client.query<{ id: string }>(
      `UPDATE public.things SET place_id = $2::uuid, container_id = $3::uuid
        WHERE container_id = $1 AND deleted_at IS NULL RETURNING id`,
      [id, movedTo.place_id, movedTo.container_id],
    );
    moved.push(...rows.map((r) => r.id));
  }
  const { rows: stamped } = await c.client.query<{ deleted_at: Date }>(
    `UPDATE public.things SET deleted_at = now(), trash_batch_id = $2 WHERE id = $1
     RETURNING deleted_at`,
    [id, batch],
  );

  // The shape things/undo.ts's `thing.trash` handler reads: deleted_at and trash_batch_id.
  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'thing.trash',
    entity: { type: 'thing', id },
    before: { deleted_at: null, trash_batch_id: null },
    after: {
      deleted_at: stamped[0]?.deleted_at ?? new Date(),
      trash_batch_id: batch,
      contents: direct > 0 ? (body?.contents ?? null) : null,
      trashed: trashed.length,
      moved: moved.length,
      // Where the contents went, so undo can put back what is still there (#30): each came out
      // of this container.
      ...(movedTo ? { moved_ids: moved, moved_to: movedTo } : {}),
    },
    rootThingId: id,
    subjects: [...trashed.slice(1), ...moved],
    requestId: c.requestId,
    undoableUntil: undoableUntil(),
  });
  if (movedTo) {
    const to = movedTo;
    await auditRelocations(
      c.tx,
      { locationId: loc, actor: actor(c.scope), requestId: c.requestId },
      moved.map((m) => ({ id: m, before: { place_id: null, container_id: id }, after: to })),
    );
  }
  if (moved.length > 0) await enqueueReindex(c.jobs, c.client, loc);
  return { trashed, moved, trashBatchId: batch };
}

// ---------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------

export async function restoreThing(c: Ctx, id: string): Promise<RestoreResult> {
  const seen = await anyThing(c.client, id);
  await requireRole(c.client, seen.location_id, 'things.trash');
  if (!seen.deleted_at) throw conflict("It isn't in the trash.");
  const loc = seen.location_id;
  const batch = seen.trash_batch_id;

  if (batch) {
    // A batch with places in it is a place's trash: restorePlace() brings back the place at
    // its top and everything trashed with it (the thing asked for included).
    const { rows: roots } = await c.client.query<{ id: string }>(
      `SELECT p.id FROM public.places p
        WHERE p.location_id = $1 AND p.trash_batch_id = $2 AND p.deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.places q
                           WHERE q.id = p.parent_id AND q.trash_batch_id = $2)
        ORDER BY p.deleted_at, p.id LIMIT 1`,
      [loc, batch],
    );
    const root = roots[0];
    if (root) return restorePlace(c, root.id);
  }

  await c.client.query('SELECT 1 FROM public.things WHERE id = $1 FOR UPDATE', [id]);
  const { rows: back } = await c.client.query<{ id: string }>(
    `UPDATE public.things SET deleted_at = NULL, trash_batch_id = NULL
      WHERE location_id = $1 AND deleted_at IS NOT NULL
        AND (id = $2 OR ($3::uuid IS NOT NULL AND trash_batch_id = $3::uuid))
      RETURNING id`,
    [loc, id, batch],
  );
  const restored = back.map((r) => r.id);
  // What was inside something that is still in the trash can't go back there (D162).
  const unplaced = await unplacedOf(c.client, loc);
  const { rows: orphans } = await c.client.query<Orphan>(
    `UPDATE public.things t SET place_id = $2::uuid, container_id = NULL
      WHERE t.id = ANY ($1::uuid[])
        AND (EXISTS (SELECT 1 FROM public.places q
                      WHERE q.id = t.place_id AND q.deleted_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM public.things x
                         WHERE x.id = t.container_id AND x.deleted_at IS NOT NULL))
      RETURNING ${ORPHAN_RETURNING}`,
    [restored, unplaced],
  );

  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'thing.restore',
    entity: { type: 'thing', id },
    before: { deleted_at: seen.deleted_at, trash_batch_id: batch },
    after: { deleted_at: null, trash_batch_id: null, restored: restored.length },
    rootThingId: id,
    subjects: restored.filter((x) => x !== id),
    requestId: c.requestId,
  });
  await auditRelocations(
    c.tx,
    { locationId: loc, actor: actor(c.scope), requestId: c.requestId },
    orphans.map(relocationOf),
  );
  if (orphans.length > 0) await enqueueReindex(c.jobs, c.client, loc);
  return {
    restored,
    ...(orphans.length > 0
      ? { hint: 'Some things went to Unplaced: where they were is still in the trash.' }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Delete permanently
// ---------------------------------------------------------------------------------------------

export async function deleteThing(c: Ctx, id: string): Promise<void> {
  const seen = await anyThing(c.client, id);
  await requireRole(c.client, seen.location_id, 'things.delete-permanently');
  if (!seen.deleted_at) throw conflict('Only a thing in the trash can be deleted for good.');
  const loc = seen.location_id;
  const thing = await anyThing(c.client, id, true);
  if (!thing.deleted_at) throw conflict('Only a thing in the trash can be deleted for good.');
  const within = await inside(c.client, id);
  if (within.some((t) => !t.deleted)) {
    throw conflict('Something inside it is no longer in the trash. Move it out first.');
  }
  const ids = [id, ...within.map((t) => t.id)];
  // Audited first: the event names the thing, which is gone afterwards. Its name stays in the
  // history ("Its history stays, without it").
  await audited(c.tx, {
    locationId: loc,
    actor: actor(c.scope),
    action: 'thing.delete',
    entity: { type: 'thing', id },
    before: {
      name: thing.name,
      place_id: thing.place_id,
      container_id: thing.container_id,
      deleted_at: thing.deleted_at,
      deleted: ids.length,
    },
    after: null,
    requestId: c.requestId,
  });
  await c.client.query('DELETE FROM public.things WHERE id = ANY ($1::uuid[])', [ids]);
  await c.client.query(
    `INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
     SELECT $1, 'thing', unnest($2::uuid[])
     ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now()`,
    [loc, ids],
  );
}

// ---------------------------------------------------------------------------------------------
// The trash list
// ---------------------------------------------------------------------------------------------

/** The trash list's filters that take "is none of" (D205); `kind` takes several values only. */
export const TRASH_FILTERS = ['locationId', 'deletedById'] as const;

export const TrashQuery = z.object({
  locationId: manyOf(z.uuid()).optional(),
  kind: manyOf(z.enum(['thing', 'place'])).optional(),
  /** Who trashed it: the person of the batch's trash event. */
  deletedById: manyOf(z.uuid()).optional(),
  not: notOf(TRASH_FILTERS).optional(),
  /** When it was trashed: inclusive. */
  from: When.optional(),
  /** Exclusive. */
  to: When.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});
export type TrashQuery = z.infer<typeof TrashQuery>;

const PathStep = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
});

export const TrashItemSchema = z.object({
  kind: z.enum(['thing', 'place']),
  id: z.uuid(),
  locationId: z.uuid(),
  name: z.string().nullable(),
  path: z.array(PathStep),
  deletedAt: z.string(),
  /** `id` is the user's, for the "deleted by" filter (D205). */
  deletedBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  purgeAfter: z.string(),
  batchSize: z.number().int(),
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

export const TrashPageSchema = z.object({
  items: z.array(TrashItemSchema),
  next_cursor: z.string().nullable(),
});

type TrashRecord = {
  kind: 'thing' | 'place';
  id: string;
  location_id: string;
  name: string | null;
  path: z.infer<typeof PathStep>[] | null;
  deleted_at: Date;
  /** `deleted_at` as Postgres prints it, microseconds included: the cursor's key (a JS Date
   * would round it to milliseconds and skip rows trashed in the same millisecond). */
  deleted_key: string;
  deleted_by_id: string | null;
  deleted_by: string | null;
  batch_size: number;
};

/** The trash event that stamped a batch (written in the same transaction, so at the same
 * instant as `deleted_at`), when a person made it: `column` of it. `from` is the event, and the
 * person's profile when the column needs it. */
const trashEvent = (alias: string, column: string, from: string) => `(
  SELECT ${column}
    FROM ${from}
   WHERE e.location_id = ${alias}.location_id
     AND e.actor_type = 'user'
     AND e.at BETWEEN ${alias}.deleted_at - interval '1 second'
                  AND ${alias}.deleted_at + interval '1 second'
     AND e.action IN ('thing.trash', 'place.trash')
     AND e.diff->'trash_batch_id'->>'after' = ${alias}.trash_batch_id::text
   ORDER BY e.at DESC LIMIT 1)`;

/** Who trashed a batch: the name (null when their profile is out of sight), and the user id,
 * the "deleted by" filter's value, which needs no profile. */
const deletedBy = (alias: string) =>
  trashEvent(
    alias,
    'up.display_name',
    'public.audit_events e JOIN public.user_profiles up ON up.user_id = e.actor_id',
  );
const deletedById = (alias: string) => trashEvent(alias, 'e.actor_id', 'public.audit_events e');

const batchSize = (alias: string) => `CASE WHEN ${alias}.trash_batch_id IS NULL THEN 1 ELSE
  (SELECT count(*) FROM public.things b
    WHERE b.location_id = ${alias}.location_id AND b.trash_batch_id = ${alias}.trash_batch_id)
  + (SELECT count(*) FROM public.places b
      WHERE b.location_id = ${alias}.location_id AND b.trash_batch_id = ${alias}.trash_batch_id)
  END`;

/** A timestamptz as Postgres prints it (or as ISO 8601). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** GET /api/v1/trash: newest first, across the locations the caller can see (D174). */
export async function listTrash(
  client: pg.ClientBase,
  query: TrashQuery,
): Promise<{ items: TrashItem[]; next_cursor: string | null }> {
  const values: unknown[] = [];
  const v = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where: string[] = [];
  // Each filter "is any of" its values or "is none of" them (D205, http/list-filters.ts). Every
  // location named either way must be one the caller can see (404, review #36).
  const locationIds = lowerIds(query.locationId);
  for (const id of locationIds) await requireMembership(client, id);
  const location = filterOf(locationIds, 'locationId', query.not);
  if (location) {
    where.push(matchOf(`x.location_id = ANY (${v(location.values)}::uuid[])`, location.not));
  }
  if (query.kind?.length) where.push(`x.kind = ANY (${v(query.kind)}::text[])`);
  const by = filterOf(lowerIds(query.deletedById), 'deletedById', query.not);
  if (by) {
    // Who trashed it is only known through its trash event: a thing trashed by a token, an
    // import or the system has nobody, so it is "none of" every person.
    where.push(matchOf(`${deletedById('x')} = ANY (${v(by.values)}::uuid[])`, by.not));
  }
  if (query.from) where.push(`x.deleted_at >= ${v(query.from)}::timestamptz`);
  if (query.to) where.push(`x.deleted_at < ${v(query.to)}::timestamptz`);
  if (query.q) {
    // Names only, normalised the way search matches them (D42), as a substring.
    where.push(`strpos(kept.normalize(coalesce(x.name, '')), kept.normalize(${v(query.q)})) > 0`);
  }
  if (query.cursor) {
    const key = decodeCursor<unknown>(query.cursor);
    if (
      !Array.isArray(key) ||
      typeof key[0] !== 'string' ||
      !TIMESTAMP.test(key[0]) ||
      typeof key[1] !== 'string' ||
      !z.uuid().safeParse(key[1]).success
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    where.push(`(x.deleted_at, x.id) < (${v(key[0])}::timestamptz, ${v(key[1])}::uuid)`);
  }
  const limit = v(query.limit + 1);
  const { rows } = await client.query<TrashRecord>(
    `WITH x AS (
       SELECT 'thing'::text AS kind, t.id, t.location_id, t.name, t.deleted_at, t.trash_batch_id,
              t.place_id, t.container_id
         FROM public.things t WHERE t.deleted_at IS NOT NULL
       UNION ALL
       SELECT 'place', p.id, p.location_id, p.name, p.deleted_at, p.trash_batch_id,
              p.parent_id, NULL::uuid
         FROM public.places p WHERE p.deleted_at IS NOT NULL
     )
     SELECT x.kind, x.id, x.location_id, x.name, x.deleted_at, x.deleted_at::text AS deleted_key,
            ${pathSql('x.place_id', 'x.container_id')} AS path,
            ${deletedBy('x')} AS deleted_by, ${deletedById('x')} AS deleted_by_id,
            ${batchSize('x')}::int AS batch_size
       FROM x
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY x.deleted_at DESC, x.id DESC
      LIMIT ${limit}`,
    values,
  );
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map((r) => ({
      kind: r.kind,
      id: r.id,
      locationId: r.location_id,
      name: r.name,
      path: (r.path ?? []).map((s) => ({ ...s, name: s.name ?? '' })),
      deletedAt: r.deleted_at.toISOString(),
      deletedBy:
        r.deleted_by && r.deleted_by_id ? { id: r.deleted_by_id, displayName: r.deleted_by } : null,
      purgeAfter: new Date(r.deleted_at.getTime() + TRASH_DAYS * 86_400_000).toISOString(),
      batchSize: r.batch_size,
    })),
    next_cursor:
      rows.length > query.limit && last ? encodeCursor([last.deleted_key, last.id]) : null,
  };
}
