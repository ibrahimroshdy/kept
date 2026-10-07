import { createPlace } from '../../places/service.js';
import { type Handler, requireLive } from './common.js';

// `create_area` → step 2's place create (places/service.ts), with the phone's id: a `create_thing`
// queued after it names the area as its target and lists it in `dependsOn`, so it is dropped as
// `parent_dropped` if the area is. The kind must exist in the location's account (else
// `invalid`); a parent trashed meanwhile drops it with who trashed it (D35).

export const createArea: Handler<'create_area'> = async (ctx, { locationId, payload }) => {
  if (payload.parentId) {
    const gone = await requireLive(
      ctx.client,
      [{ type: 'place', id: payload.parentId }],
      locationId,
    );
    if (gone) return gone;
  }
  const place = await createPlace(
    ctx,
    locationId,
    {
      id: payload.id,
      parentId: payload.parentId,
      name: payload.name,
      kindKey: payload.kindKey,
    },
    { via: 'op' },
  );
  return { outcome: 'applied', entity: { type: 'place', id: place.id } };
};
