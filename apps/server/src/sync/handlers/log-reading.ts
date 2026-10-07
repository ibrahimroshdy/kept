import { newId } from '@kept/shared';
import { dedupedFileIds } from '../../capture/service.js';
import { createReading, placementOf } from '../../meters/service.js';
import { goneDrop, type Handler, presenceOf } from './common.js';

// `log_reading` → step 2's readings service (meters/service.ts), `via: 'op'`. Readings are ordered
// by when they were taken (device time, clamped to the server's receipt), not by arrival (D112):
// a late reading that fits between its neighbours is accepted. One that doesn't (backwards, or a
// jump past the daily limit) is kept as `needs_review` with an inbox `reading` item carrying the
// neighbours, never silently rejected; the op answers `needs_review` with the reason. A proof
// photo becomes the reading's `proof` attachment (step 5, Q10; before, the thing's). A meter
// whose thing was trashed meanwhile is dropped with who trashed it (D35).

export const logReading: Handler<'log_reading'> = async (ctx, { payload }) => {
  const { client } = ctx;
  const meterId = payload.meterId.toLowerCase();
  const { rows } = await client.query<{ thing_id: string; location_id: string }>(
    'SELECT thing_id, location_id FROM public.meters WHERE id = $1',
    [meterId],
  );
  const meter = rows[0];
  if (!meter) return { outcome: 'dropped', reason: 'target_missing' };
  const thing = await presenceOf(client, 'thing', meter.thing_id);
  if (thing.state !== 'live') return goneDrop('thing', meter.thing_id, thing);

  const source = payload.proofFileId ? 'photo' : 'manual';
  // The proof as uploaded: bytes the location already had answered that file instead
  // (`deduplicatedFrom`, D177), found by the hash, as a capture's files are.
  const proofFileId = payload.proofFileId
    ? (
        await dedupedFileIds(client, meter.location_id, [
          {
            fileId: payload.proofFileId,
            ...(payload.proofSha256 ? { sha256: payload.proofSha256 } : {}),
          },
        ])
      )[0]
    : undefined;
  // Step 5 (Q10, D195): the proof photo hangs on the reading it proves (meters/proofs.ts).
  const made = await createReading(
    ctx,
    meterId,
    {
      id: payload.id,
      value: payload.value,
      takenAt: payload.takenAt,
      ...(payload.note ? { note: payload.note } : {}),
      ...(proofFileId ? { proofFileId } : {}),
    },
    source,
    { via: 'op' },
  );
  let attachmentId: string | undefined;
  if (proofFileId) {
    const { rows: proof } = await client.query<{ id: string }>(
      `SELECT id FROM public.attachments WHERE meter_reading_id = $1 AND role = 'proof'
        ORDER BY sort, id LIMIT 1`,
      [made.reading.id],
    );
    attachmentId = proof[0]?.id;
  }
  const entity = { type: 'meter_reading', id: made.reading.id };
  if (made.state !== 'needs_review') return { outcome: 'applied', entity };

  const reason = made.reason ?? 'implausible_jump';
  const placed = await placementOf(
    client,
    meterId,
    made.reading.value,
    new Date(made.reading.takenAt),
  );
  const neighbour = (r: { value: string; takenAt: Date } | null | undefined) =>
    r ? { value: r.value, takenAt: r.takenAt.toISOString() } : undefined;
  const before = neighbour(placed?.placement.previous);
  const after = neighbour(placed?.placement.next);
  const { rows: item } = await client.query<{ id: string }>(
    `INSERT INTO public.inbox_items (id, location_id, kind, meter_reading_id, created_by, payload)
     VALUES ($1, $2, 'reading', $3, kept.current_user_id(), $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      newId(),
      meter.location_id,
      made.reading.id,
      JSON.stringify({
        meterId,
        thingId: meter.thing_id,
        reason,
        value: made.reading.value,
        takenAt: made.reading.takenAt,
        neighbours: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
        ...(attachmentId ? { attachmentId } : {}),
      }),
    ],
  );
  return {
    outcome: 'needs_review',
    reason,
    entity,
    ...(item[0] ? { inboxItemId: item[0].id } : {}),
  };
};
