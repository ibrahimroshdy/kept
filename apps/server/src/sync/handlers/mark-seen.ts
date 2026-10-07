import { markSeen as seen } from '../../things/service.js';
import { type Handler, requireLive } from './common.js';

// `mark_seen` → step 2's seen service (D40): seen when the phone saw it (`takenAt`, clamped to
// the receipt, D112), not when the queue reached the server, and no longer "not here". A later
// sighting already recorded is kept. A thing trashed meanwhile is dropped with who trashed it,
// and a restore (D35).

export const markSeen: Handler<'mark_seen'> = async (ctx, { payload, takenAt }) => {
  const id = payload.thingId.toLowerCase();
  const gone = await requireLive(ctx.client, [{ type: 'thing', id }]);
  if (gone) return gone;
  await seen(ctx, id, takenAt);
  return { outcome: 'applied', entity: { type: 'thing', id } };
};
