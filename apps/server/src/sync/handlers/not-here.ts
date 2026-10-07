import { markNotHere } from '../../things/service.js';
import { type Handler, requireLive } from './common.js';

// `not_here` → step 2's not-here service (D40). A thing trashed meanwhile is dropped with who
// trashed it, and a restore (D35).

export const notHere: Handler<'not_here'> = async (ctx, { payload }) => {
  const id = payload.thingId.toLowerCase();
  const gone = await requireLive(ctx.client, [{ type: 'thing', id }]);
  if (gone) return gone;
  await markNotHere(ctx, id);
  return { outcome: 'applied', entity: { type: 'thing', id } };
};
