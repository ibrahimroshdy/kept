import { newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { requireUsableFiles } from '../capture/service.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { thumbKeysOf, thumbUrlOf } from '../search/service.js';
import type { FileStorage } from '../storage/blob-store.js';

// Proof photos of readings, and the odometer proof strip (step 5, T8; D27, D195; plan Q10).
//
// From step 5 a proof photo hangs on the reading it proves (`attachments.meter_reading_id`, role
// `proof`): a typed reading's (POST /api/v1/meters/:id/readings `proofFileId`, a READING capture
// with a typed value, the `log_reading` op). Step 3 hung READING proofs on the thing; 0061 moved
// those it could link, and the rest stay there, shown in the strip by the attachment's date
// without a value.
//
// A photo AI reads is different: its READING extraction points at the thing's attachment
// (`extractions.attachment_id`, ON DELETE CASCADE), and kept_app may neither re-subject an
// attachment (0020 grants `role, sort`) nor re-point an extraction, so deleting and re-inserting
// it would take the extraction (its result, its ledger link) with it. That proof stays on the
// thing, and the reading it became is recorded in the extraction's `applied.readingId`
// (extraction/apply.ts, inbox/service.ts): a proof "of" a reading is either kind.

/** A photo that proves something: the attachment, its file, and a thumbnail to show (null while
 * the thumbnail isn't made yet, or for a file that has none). */
export type ProofRef = { attachmentId: string; fileId: string; thumbUrl: string | null };

export const ProofRefSchema = z.object({
  attachmentId: z.uuid(),
  fileId: z.uuid(),
  thumbUrl: z.string().nullable(),
});

/**
 * Hangs `fileId` on the reading as its `proof` (after any it has): 404 unless the file is the
 * caller's to attach in this location (capture/service.ts requireUsableFiles). Answers the
 * attachment's id. The caller audits it with the reading.
 */
export async function attachProof(
  client: pg.ClientBase,
  locationId: string,
  readingId: string,
  fileId: string,
): Promise<string> {
  const file = fileId.toLowerCase();
  await requireUsableFiles(client, locationId, [file]);
  const id = newId();
  await client.query(
    `INSERT INTO public.attachments (id, location_id, file_id, meter_reading_id, role, sort,
                                     created_by)
     VALUES ($1, $2, $3, $4, 'proof',
             (SELECT coalesce(max(a.sort) + 1, 0)::int FROM public.attachments a
               WHERE a.meter_reading_id = $4),
             kept.current_user_id())`,
    [id, locationId, file, readingId],
  );
  return id;
}

/**
 * Moves a thing's proof attachment onto `readingId`, as a DELETE and an INSERT of the same file
 * (kept_app can't re-subject an attachment), unless an extraction reads it (its key would take
 * the extraction too): then the extraction's `applied.readingId` names the reading instead.
 * Answers the proof's attachment id, or null when there was none to move.
 */
export async function moveProofToReading(
  client: pg.ClientBase,
  attachmentId: string,
  readingId: string,
): Promise<string | null> {
  const { rows } = await client.query<{
    location_id: string;
    file_id: string | null;
    read_by: string | null;
  }>(
    `SELECT a.location_id, a.file_id,
            (SELECT e.id FROM public.extractions e WHERE e.attachment_id = a.id
              ORDER BY e.created_at DESC LIMIT 1) AS read_by
       FROM public.attachments a
      WHERE a.id = $1 AND a.role = 'proof' AND a.thing_id IS NOT NULL`,
    [attachmentId],
  );
  const a = rows[0];
  if (!a?.file_id) return null;
  if (a.read_by) {
    await client.query(
      `UPDATE public.extractions
          SET applied = applied || jsonb_build_object('readingId', $2::text)
        WHERE attachment_id = $1`,
      [attachmentId, readingId],
    );
    return attachmentId;
  }
  await client.query('DELETE FROM public.attachments WHERE id = $1', [attachmentId]);
  await client.query(
    `INSERT INTO public.attachments (id, location_id, file_id, meter_reading_id, role, sort,
                                     created_by)
     VALUES ($1, $2, $3, $4, 'proof',
             (SELECT coalesce(max(x.sort) + 1, 0)::int FROM public.attachments x
               WHERE x.meter_reading_id = $4),
             kept.current_user_id())`,
    [attachmentId, a.location_id, a.file_id, readingId],
  );
  return attachmentId;
}

/** SQL: each proof of the readings in `ids` ($1), as (reading_id, attachment_id, file_id, sort). */
const PROOFS_OF_READINGS = `
  SELECT a.meter_reading_id AS reading_id, a.id AS attachment_id, a.file_id, a.sort, a.created_at
    FROM public.attachments a
   WHERE a.meter_reading_id = ANY ($1::uuid[]) AND a.role = 'proof' AND a.file_id IS NOT NULL
  UNION ALL
  SELECT (e.applied->>'readingId')::uuid, a.id, a.file_id, a.sort, a.created_at
    FROM public.extractions e
    JOIN public.attachments a ON a.id = e.attachment_id
   WHERE e.applied ? 'readingId' AND e.applied->>'readingId' = ANY ($1::uuid[]::text[])
     AND a.role = 'proof' AND a.file_id IS NOT NULL`;

/** The first proof photo of each reading (GET …/readings `proof`). */
export async function proofsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  readingIds: readonly string[],
): Promise<Map<string, ProofRef>> {
  const out = new Map<string, ProofRef>();
  if (readingIds.length === 0) return out;
  const { rows } = await client.query<{
    reading_id: string;
    attachment_id: string;
    file_id: string;
  }>(
    `SELECT DISTINCT ON (p.reading_id) p.reading_id, p.attachment_id, p.file_id
       FROM (${PROOFS_OF_READINGS}) p
      ORDER BY p.reading_id, p.sort, p.created_at, p.attachment_id`,
    [[...readingIds]],
  );
  const keys = await thumbKeysOf(
    client,
    rows.map((r) => r.file_id),
  );
  for (const r of rows) {
    out.set(r.reading_id, {
      attachmentId: r.attachment_id,
      fileId: r.file_id,
      thumbUrl: await thumbUrlOf(files, keys, r.file_id),
    });
  }
  return out;
}

export type ProofItem = {
  readingId: string | null;
  value: string | null;
  takenAt: string;
  fileId: string;
  thumbUrl: string | null;
  by: { displayName: string };
};

export const ProofItemSchema = z.object({
  readingId: z.uuid().nullable(),
  value: z.string().nullable(),
  takenAt: z.string(),
  fileId: z.uuid(),
  thumbUrl: z.string().nullable(),
  by: z.object({ displayName: z.string() }),
});

const Cursor = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);

/**
 * GET /api/v1/meters/:id/proofs (the odometer proof strip, D195) → newest first: the proofs of
 * the meter's readings, with the reading's value and time and who logged it; then the step-3
 * proofs still on the meter's thing and read by no extraction, dated by the attachment and by
 * who added it (Q10). The meter is one the caller sees (the route checked it).
 */
export async function listProofs(
  client: pg.ClientBase,
  files: FileStorage | null,
  meter: { id: string; thing_id: string },
  page: { limit: number; cursor?: string | undefined },
): Promise<{ items: ProofItem[]; next_cursor: string | null }> {
  let after: [string, string] | null = null;
  if (page.cursor) {
    const parsed = Cursor.safeParse(decodeCursor(page.cursor));
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    after = parsed.data;
  }
  const { rows } = await client.query<{
    attachment_id: string;
    reading_id: string | null;
    value: string | null;
    taken_at: Date;
    file_id: string;
    by_name: string | null;
  }>(
    `WITH p AS (
       SELECT a.id AS attachment_id, r.id AS reading_id, trim_scale(r.value)::text AS value,
              r.taken_at, a.file_id, r.logged_by AS by
         FROM public.attachments a
         JOIN public.meter_readings r ON r.id = a.meter_reading_id
        WHERE r.meter_id = $1 AND a.role = 'proof' AND a.file_id IS NOT NULL
       UNION ALL
       SELECT a.id, r.id, trim_scale(r.value)::text, r.taken_at, a.file_id, r.logged_by
         FROM public.attachments a
         JOIN public.extractions e ON e.attachment_id = a.id AND e.applied ? 'readingId'
         JOIN public.meter_readings r ON r.id::text = e.applied->>'readingId'
        WHERE a.thing_id = $2 AND r.meter_id = $1 AND a.role = 'proof' AND a.file_id IS NOT NULL
       UNION ALL
       SELECT a.id, NULL, NULL, a.created_at, a.file_id, a.created_by
         FROM public.attachments a
        WHERE a.thing_id = $2 AND a.role = 'proof' AND a.file_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.extractions e
                           WHERE e.attachment_id = a.id AND e.applied ? 'readingId'))
     SELECT p.attachment_id, p.reading_id, p.value, p.taken_at, p.file_id,
            up.display_name AS by_name
       FROM p LEFT JOIN public.user_profiles up ON up.user_id = p.by
      WHERE $3::timestamptz IS NULL OR (p.taken_at, p.attachment_id) < ($3::timestamptz, $4::uuid)
      ORDER BY p.taken_at DESC, p.attachment_id DESC
      LIMIT $5`,
    [meter.id, meter.thing_id, after?.[0] ?? null, after?.[1] ?? null, page.limit + 1],
  );
  const items = rows.slice(0, page.limit);
  const keys = await thumbKeysOf(
    client,
    items.map((r) => r.file_id),
  );
  const out: ProofItem[] = [];
  for (const r of items) {
    out.push({
      readingId: r.reading_id,
      value: r.value,
      takenAt: r.taken_at.toISOString(),
      fileId: r.file_id,
      thumbUrl: await thumbUrlOf(files, keys, r.file_id),
      by: { displayName: r.by_name ?? '' },
    });
  }
  const last = items.at(-1);
  return {
    items: out,
    next_cursor:
      rows.length > page.limit && last
        ? encodeCursor([last.taken_at.toISOString(), last.attachment_id])
        : null,
  };
}
