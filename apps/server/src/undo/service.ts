import type pg from 'pg';
import { z } from 'zod';
import { undoableActions } from '../audit/undo.js';
import { notFound } from '../http/errors.js';

// GET /api/v1/things/:id/undoable (T20; D150): the events on a thing's timeline that still offer
// "Undo", for 7 days. The web's contract is apps/web/src/api/capture/types.ts UndoableResponse.
//
// An event is listed when all of these hold, read as the caller on kept_app (the audit_events
// policy decides what exists):
// - it is about the thing: its own (`entity_id`), rooted at it (`root_thing_id`), or fanned out
//   to it (`audit_event_subjects`: "moved with Box 3", a capture batch, a box check), as the
//   thing's history reads them (history/service.ts);
// - its action has an undo handler, its window is open, it has no undo yet, it is not itself an
//   undo, and its diff holds no secret-class field (plan T20);
// - the caller may undo it: it was theirs, or they are an owner or admin of its location (Q23),
//   and a viewer never.
// Whether the undo would still go through (nothing changed since) is the undo route's to say:
// the list is what the timeline offers, not a promise. A move across locations is written in
// both; the list shows it once.

export const UndoableItem = z.object({
  eventId: z.uuid(),
  action: z.string(),
  at: z.string(),
  until: z.string(),
});
export const UndoableResponse = z.object({ items: z.array(UndoableItem) });
export type UndoableResponse = z.infer<typeof UndoableResponse>;

/** The most a timeline lists: 7 days of one thing's undoable changes. */
const LIMIT = 100;

export async function undoableFor(
  client: pg.ClientBase,
  thingId: string,
): Promise<UndoableResponse> {
  const { rowCount } = await client.query('SELECT 1 FROM public.things WHERE id = $1', [thingId]);
  if (!rowCount) throw notFound();
  const { rows } = await client.query<{
    id: string;
    action: string;
    at: Date;
    undoable_until: Date;
  }>(
    `SELECT DISTINCT ON (coalesce(e.request_id, e.id::text), e.action, e.entity_id)
            e.id, e.action, e.at, e.undoable_until
       FROM public.audit_events e
       JOIN public.memberships m
         ON m.location_id = e.location_id AND m.user_id = kept.current_user_id()
        AND (m.expires_at IS NULL OR m.expires_at > now())
      WHERE e.location_id IS NOT NULL
        AND e.undoable_until > now()
        AND e.undo_of IS NULL
        AND e.action = ANY ($2::text[])
        AND ((e.entity_type = 'thing' AND e.entity_id = $1)
             OR e.root_thing_id = $1
             OR EXISTS (SELECT 1 FROM public.audit_event_subjects s
                         WHERE s.event_id = e.id AND s.event_at = e.at AND s.thing_id = $1))
        AND NOT EXISTS (SELECT 1 FROM public.audit_events u
                         WHERE u.undo_of = e.id AND u.location_id = e.location_id)
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(coalesce(e.diff, '{}'::jsonb)) d
                         WHERE d.value->>'class' = 'secret')
        AND (m.role IN ('owner', 'admin')
             OR (m.role = 'member' AND e.actor_type = 'user'
                 AND e.actor_id = kept.current_user_id()))
      ORDER BY coalesce(e.request_id, e.id::text), e.action, e.entity_id, e.at, e.id`,
    [thingId, undoableActions()],
  );
  const items = rows
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, LIMIT)
    .map((r) => ({
      eventId: r.id,
      action: r.action,
      at: r.at.toISOString(),
      until: r.undoable_until.toISOString(),
    }));
  return { items };
}
