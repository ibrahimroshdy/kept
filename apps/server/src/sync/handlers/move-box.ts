import { requireMovingOn, unpackBox, updateBox } from '../../moving/service.js';
import { type Handler, requireLive } from './common.js';

// `move_box` (1.x, D251) → moving/service.ts: a moving box marked on the phone in the middle of
// the move, where there may be no signal. `packed` and `in_transit` change its state; `unpacked`
// moves the box with everything in it into its room (the op's `placeId`, else the room chosen
// for it) and marks it unpacked, as the Unpack button does.
//
// Ordering (D112, D35): the op's `takenAt` is when it happened on the phone. A state change older
// than the box's last one (another phone said something newer, and synced first) changes nothing
// and is answered `applied`: the newer word stands, and the board shows it. A box whose container
// or room was trashed meanwhile drops with who trashed it, and a restore; a move that was deleted
// drops as `target_missing`; one marked done, or Moving mode turned off there, as `invalid`.

export const moveBoxOp: Handler<'move_box'> = async (ctx, { locationId, takenAt, payload }) => {
  const { client } = ctx;
  await requireMovingOn(ctx, locationId);
  const gone = await requireLive(client, [
    { type: 'thing', id: payload.containerId },
    ...(payload.placeId ? [{ type: 'place' as const, id: payload.placeId }] : []),
  ]);
  if (gone) return gone;
  const opts = { at: takenAt };
  const out =
    payload.state === 'unpacked'
      ? await unpackBox(
          ctx,
          payload.moveId,
          payload.containerId,
          payload.placeId ? { placeId: payload.placeId } : {},
          opts,
        )
      : await updateBox(ctx, payload.moveId, payload.containerId, { state: payload.state }, opts);
  return {
    outcome: 'applied',
    ...(out.changed ? {} : { reason: 'superseded' }),
    entity: { type: 'thing', id: payload.containerId.toLowerCase() },
  };
};
