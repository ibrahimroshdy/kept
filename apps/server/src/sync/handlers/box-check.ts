import { lastChangedBy } from '../../audit/undo.js';
import { boxCheck as check } from '../../boxcheck/service.js';
import { goneDrop, type Handler, presenceOf, requireLive } from './common.js';

// `box_check` → T17's box-check service (boxcheck/service.ts), `via: 'op'`. What the phone counted
// is checked against the box as it is now:
// - the box, a counted thing or one found in it trashed meanwhile: dropped with who trashed it,
//   and a restore (D35);
// - a counted thing that has left the box since (the service's 400 "only what is directly in
//   the box"): the count is stale, so the check is dropped as `target_missing`, and the notice
//   says who moved it. A recount on the phone makes a new check.

export const boxCheckOp: Handler<'box_check'> = async (ctx, { payload }) => {
  const { client } = ctx;
  const boxId = payload.containerId.toLowerCase();
  const box = await requireLive(client, [{ type: 'thing', id: boxId }]);
  if (box) return box;

  for (const line of payload.lines) {
    const id = line.thingId.toLowerCase();
    const p = await presenceOf(client, 'thing', id);
    if (p.state !== 'live') return goneDrop('thing', id, p);
    const { rows } = await client.query<{ container_id: string | null }>(
      'SELECT container_id FROM public.things WHERE id = $1',
      [id],
    );
    if (rows[0]?.container_id !== boxId) {
      const by = p.locationId
        ? await lastChangedBy(client, p.locationId, { type: 'thing', id })
        : null;
      return {
        outcome: 'dropped',
        reason: 'target_missing',
        subject: { type: 'thing', id, name: p.name },
        ...(by
          ? { by, notice: { name: p.name, by: { displayName: by }, action: 'moved' as const } }
          : {}),
      };
    }
  }
  const found = await requireLive(
    client,
    payload.foundElsewhereIds.map((id) => ({ type: 'thing' as const, id })),
  );
  if (found) return found;

  await check(
    ctx,
    boxId,
    { id: payload.id, lines: payload.lines, foundElsewhereIds: payload.foundElsewhereIds },
    { via: 'op' },
  );
  return { outcome: 'applied', entity: { type: 'thing', id: boxId } };
};
