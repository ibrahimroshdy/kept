import { OP_KINDS, type OpKind, parseOpPayload } from '@kept/shared';
import { registerOpReplayer } from '../../inbox/service.js';
import { boxCheckOp } from './box-check.js';
import { claimLabelOp } from './claim-label.js';
import type { Handler } from './common.js';
import { createArea } from './create-area.js';
import { createThing } from './create-thing.js';
import { logReading } from './log-reading.js';
import { markSeen } from './mark-seen.js';
import { move } from './move.js';
import { notHere } from './not-here.js';

/** One handler per op kind (plan T14). */
export const HANDLERS: { readonly [K in OpKind]: Handler<K> } = Object.freeze({
  create_thing: createThing,
  move,
  log_reading: logReading,
  claim_label: claimLabelOp,
  mark_seen: markSeen,
  not_here: notHere,
  create_area: createArea,
  box_check: boxCheckOp,
});

let registered = false;

/**
 * The inbox's "Restore" (T15, D35) for every op kind: once the trashed target is back, the
 * dropped op runs again through its own handler, as the person restoring it, now. Its payload is
 * the one the drop stored (already upgraded to this build's version). Called when the routes are
 * registered; idempotent.
 */
export function registerSyncReplayers(): void {
  if (registered) return;
  registered = true;
  for (const kind of OP_KINDS) {
    registerOpReplayer(kind, async (ctx, payload, { locationId }) => {
      const parsed = parseOpPayload(kind, payload);
      if (!parsed.success) return 'dropped';
      const handler = HANDLERS[kind] as Handler<typeof kind>;
      const out = await handler(ctx, {
        locationId,
        takenAt: new Date(),
        payload: parsed.data as never,
      });
      return out.outcome;
    });
  }
}
