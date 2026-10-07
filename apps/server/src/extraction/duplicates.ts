/**
 * Likely duplicates after an extraction (D36; plan T10). Another live thing in the same location
 * with the same serial (the thing's own, or the one AI suggests), or with the same brand and model
 * **and** the same place or container, opens an inbox `duplicate` item: the reviewer merges them
 * (`kept.merge_things`, T15) or says they are different. Never merged automatically.
 */
import type pg from 'pg';
import { upsertInbox } from './apply.js';

export type DuplicateReason = 'serial' | 'brand_model_place';

export type DuplicateMatch = { otherThingId: string; reason: DuplicateReason };

/** The first likely duplicate of `thingId`, or null. `serial` is a suggested serial, if any. */
export async function findDuplicate(
  client: pg.ClientBase,
  thingId: string,
  suggestedSerial: string | null,
): Promise<DuplicateMatch | null> {
  const { rows } = await client.query<{ other: string; reason: DuplicateReason }>(
    `WITH me AS (
       SELECT t.id, t.location_id, t.brand_id, t.model, t.place_id, t.container_id,
              nullif(kept.normalize(coalesce(t.serial, $2)), '') AS serial_n,
              nullif(kept.normalize(t.model), '') AS model_n
         FROM public.things t WHERE t.id = $1 AND t.deleted_at IS NULL)
     SELECT o.id AS other, 'serial' AS reason
       FROM me JOIN public.things o
         ON o.location_id = me.location_id AND o.id <> me.id AND o.deleted_at IS NULL
        AND me.serial_n IS NOT NULL AND kept.normalize(o.serial) = me.serial_n
     UNION ALL
     SELECT o.id, 'brand_model_place'
       FROM me JOIN public.things o
         ON o.location_id = me.location_id AND o.id <> me.id AND o.deleted_at IS NULL
        AND me.brand_id IS NOT NULL AND o.brand_id = me.brand_id
        AND me.model_n IS NOT NULL AND kept.normalize(o.model) = me.model_n
        AND (o.place_id IS NOT DISTINCT FROM me.place_id
             AND o.container_id IS NOT DISTINCT FROM me.container_id)
     LIMIT 1`,
    [thingId, suggestedSerial],
  );
  const r = rows[0];
  return r ? { otherThingId: r.other, reason: r.reason } : null;
}

/** Opens the `duplicate` item for a match (once per pair while open). Answers its id or null. */
export async function openDuplicate(
  client: pg.ClientBase,
  thing: { id: string; locationId: string; batchId: string | null },
  extractionId: string,
  suggestedSerial: string | null,
): Promise<string | null> {
  const match = await findDuplicate(client, thing.id, suggestedSerial);
  if (!match) return null;
  return upsertInbox(client, {
    locationId: thing.locationId,
    kind: 'duplicate',
    thingId: thing.id,
    otherThingId: match.otherThingId,
    extractionId,
    batchId: thing.batchId,
    payload: { reason: match.reason },
  });
}
