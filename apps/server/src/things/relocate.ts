import type { AuditActor } from '../audit/audited.js';
import { auditedMany } from '../audit/audited.js';
import type { Tx } from '../db/scope.js';

// Things that change place as a side effect of another write (a container trashed with its
// contents moved out, a restore that sends an orphan to the Unplaced area, an undo that puts them
// back) get a `thing.move` row each, like a move (security review #30), so every thing's history
// says where it went. Not undoable on their own: the write that caused them is what undo reverses.

export type Relocation = {
  id: string;
  before: { place_id: string | null; container_id: string | null };
  after: { place_id: string | null; container_id: string | null };
};

export async function auditRelocations(
  tx: Tx,
  at: { locationId: string; actor: AuditActor; requestId: string | null },
  moves: readonly Relocation[],
): Promise<void> {
  const real = moves.filter(
    (m) => m.before.place_id !== m.after.place_id || m.before.container_id !== m.after.container_id,
  );
  if (real.length === 0) return;
  await auditedMany(
    tx,
    real.map((m) => ({
      locationId: at.locationId,
      actor: at.actor,
      action: 'thing.move',
      entity: { type: 'thing', id: m.id },
      before: m.before,
      after: m.after,
      rootThingId: m.id,
      subjects: [m.id],
      requestId: at.requestId,
    })),
  );
}

/** A thing a restore sent to the Unplaced area, with where it was (Postgres 18's RETURNING old). */
export type Orphan = {
  id: string;
  was_place: string | null;
  was_container: string | null;
  place_id: string | null;
  container_id: string | null;
};

export const ORPHAN_RETURNING = `t.id, old.place_id AS was_place, old.container_id AS was_container,
  t.place_id, t.container_id`;

export const relocationOf = (o: Orphan): Relocation => ({
  id: o.id,
  before: { place_id: o.was_place, container_id: o.was_container },
  after: { place_id: o.place_id, container_id: o.container_id },
});
