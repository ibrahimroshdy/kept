import { moveThings } from '../../things/move.js';
import {
  type Dropped,
  goneDrop,
  type Handler,
  type Notice,
  presenceOf,
  requireLive,
  targetRef,
} from './common.js';

// `move` → step 2's move service (things/move.ts), within a location or across two (the op's
// `locationId` is the destination's). Queue ops skip `row_version` (§7.4): the latest change wins,
// visibly (D35). A thing that moved since is moved again, and both moves are in its history.
//
// - The place or container it was going to, trashed or gone meanwhile: nothing moves, and the op
//   is dropped (`target_trashed` with who trashed it, and a restore; or `target_missing`).
// - A thing of the move trashed meanwhile stays in the trash (the later change wins); the others
//   move, and the answer's `notice` names it. When none is left, the op is dropped as trashed.

export const move: Handler<'move'> = async (ctx, { payload }) => {
  const { client } = ctx;
  const to = targetRef(payload.to) as { type: 'thing' | 'place'; id: string };
  const target = await requireLive(client, [to]);
  if (target) return target;

  const live: string[] = [];
  let first: Dropped | null = null;
  for (const id of new Set(payload.thingIds.map((x) => x.toLowerCase()))) {
    const p = await presenceOf(client, 'thing', id);
    if (p.state === 'live') live.push(id);
    else first ??= goneDrop('thing', id, p);
  }
  if (live.length === 0) return first ?? { outcome: 'dropped', reason: 'target_missing' };

  await moveThings(ctx, {
    thingIds: live,
    to: payload.to,
    ...(payload.quantity !== undefined ? { quantity: Number(payload.quantity) } : {}),
  });
  const notice: Notice | undefined = first?.notice;
  return { outcome: 'applied', ...(notice ? { notice } : {}) };
};
