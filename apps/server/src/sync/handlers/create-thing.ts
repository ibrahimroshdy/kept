import { capture } from '../../capture/service.js';
import { claimableCode } from '../../labels/claim.js';
import type { Entity, Handler } from './common.js';
import { requireLive, targetRef } from './common.js';

// `create_thing` → the capture service (T13), the one implementation behind POST /captures: a
// thing (THING, LABEL), photos on a thing ("+ photo"), a draft receipt, or a meter photo. The
// short ID is allocated now, at sync (D112), and comes back as `entity.shortCode` for the phone
// to swap "ID pending" for. A file whose bytes the location already held is taken by its hash
// (capture/service.ts dedupedFileIds). Where the capture goes, and the thing it adds to, must be
// live: trashed meanwhile, the op is dropped with who did it (D35).
//
// A blank label scanned during the capture (`claimCode`) that another phone claimed first leaves
// the capture standing with its own code and a `label_claim` inbox item: the op answers
// `needs_review` / `already_claimed` with that item (D112).

export const createThing: Handler<'create_thing'> = async (ctx, { locationId, payload }) => {
  const refs = [targetRef(payload.target as { placeId?: string; containerId?: string })].filter(
    (r) => r !== null,
  );
  if (payload.attachToThingId) refs.push({ type: 'thing', id: payload.attachToThingId });
  const gone = await requireLive(ctx.client, refs, locationId);
  if (gone) return gone;

  const out = await capture(ctx, { ...payload, locationId }, { via: 'op' });
  const entity: Entity | undefined = out.thing
    ? { type: 'thing', id: out.thing.id, shortCode: out.thing.shortCode }
    : out.purchaseId
      ? { type: 'purchase', id: out.purchaseId }
      : undefined;
  const base = {
    ...(entity ? { entity } : {}),
    ...(out.inboxItemId ? { inboxItemId: out.inboxItemId } : {}),
  };
  if (payload.claimCode && out.thing) {
    const { rows } = await ctx.client.query<{ id: string }>(
      `SELECT id FROM public.inbox_items
        WHERE kind = 'label_claim' AND thing_id = $1 AND code = $2 AND resolved_at IS NULL`,
      [out.thing.id, claimableCode(payload.claimCode)],
    );
    const lost = rows[0]?.id;
    if (lost) {
      return { ...base, outcome: 'needs_review', reason: 'already_claimed', inboxItemId: lost };
    }
  }
  return { ...base, outcome: 'applied' };
};
