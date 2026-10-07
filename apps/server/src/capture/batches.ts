import type pg from 'pg';
import { type PageRequest, pageOf } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { pathSql } from '../search/query.js';
import type { PathStep } from '../things/view.js';

// GET /api/v1/captures/batches (plan T13): recent capture sessions, newest first, for the inbox's
// grouping and "Undo this batch" (screens §5, §8). A batch is the live things one camera session
// (or gallery import, or share) made in one location: `things.capture_batch_id`. Read as the
// caller, so only batches in locations they can see appear, and only their visible things count.
//
// `placePath` is where the batch's first capture went ("Garage › Shelf A"); `drafts` the ones
// still unnamed or unreviewed; `byMe` whether the caller captured them. Receipts and readings
// carry no batch on a thing, so they don't make one here (their inbox items carry it).

export type CaptureBatch = {
  batchId: string;
  locationId: string;
  placePath: PathStep[];
  capturedAt: string;
  count: number;
  drafts: number;
  byMe: boolean;
};

type Row = {
  batch_id: string;
  location_id: string;
  captured_at: Date;
  count: number;
  drafts: number;
  by_me: boolean;
  path: PathStep[] | null;
};

/** The resume key: the page's last `capturedAt` (ISO) and batch id. */
type Key = [string, string];

export async function listBatches(
  client: pg.ClientBase,
  q: { locationId: string | null; mine: boolean; page: PageRequest<Key> },
): Promise<{ items: CaptureBatch[]; next_cursor: string | null }> {
  const after = q.page.after;
  if (
    after !== null &&
    !(Array.isArray(after) && typeof after[0] === 'string' && typeof after[1] === 'string')
  ) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  const { rows } = await client.query<Row>(
    `WITH b AS (
       SELECT t.capture_batch_id AS batch_id, t.location_id,
              date_trunc('milliseconds', min(t.created_at)) AS captured_at,
              count(*)::int AS count,
              (count(*) FILTER (WHERE t.review_state = 'draft'))::int AS drafts,
              bool_or(t.created_by = kept.current_user_id()) AS by_me,
              (array_agg(t.id ORDER BY t.created_at, t.id))[1] AS first_id
         FROM public.things t
        WHERE t.capture_batch_id IS NOT NULL AND t.deleted_at IS NULL
          AND ($1::uuid IS NULL OR t.location_id = $1::uuid)
          AND (NOT $2::boolean OR t.created_by = kept.current_user_id())
        GROUP BY t.capture_batch_id, t.location_id
     )
     SELECT b.batch_id, b.location_id, b.captured_at, b.count, b.drafts, b.by_me,
            ${pathSql('f.place_id', 'f.container_id')} AS path
       FROM b JOIN public.things f ON f.id = b.first_id
      WHERE $3::timestamptz IS NULL OR (b.captured_at, b.batch_id) < ($3::timestamptz, $4::uuid)
      ORDER BY b.captured_at DESC, b.batch_id DESC
      LIMIT $5`,
    [q.locationId, q.mine, after?.[0] ?? null, after?.[1] ?? null, q.page.limit + 1],
  );
  const items = rows.map(
    (r): CaptureBatch => ({
      batchId: r.batch_id,
      locationId: r.location_id,
      placePath: (r.path ?? []).map((s) => ({
        id: s.id,
        name: s.name ?? '',
        kind: s.kind,
        isUnplaced: s.isUnplaced === true,
      })),
      capturedAt: new Date(r.captured_at).toISOString(),
      count: r.count,
      drafts: r.drafts,
      byMe: r.by_me,
    }),
  );
  return pageOf(items, q.page.limit, (b): Key => [b.capturedAt, b.batchId]);
}
