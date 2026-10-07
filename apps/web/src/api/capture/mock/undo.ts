/**
 * Mock handler for a thing's undoable events (T20): the timeline's "Undo" for 7 days (D150).
 * Like the server (apps/server/src/undo/service.ts): the thing's own events and those rooted in
 * it, still in their window, not undone and not themselves an undo, that the caller may undo
 * (theirs, or any as an owner or admin), plus the captures the capture mock records. The undo
 * itself is step 2's `POST /api/v1/audit/:eventId/undo` (api/inventory/mock/trash.ts), which
 * runs the events the mocks record with `recordEvent(…, {undo})`.
 */
import type { UndoableEvent } from '../../capture/types';
import { accessOf, liveThing } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, notFound, route } from '../../mock/kit';
import { capturePaths as p } from '../paths';

export function undoRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', p.thingUndoable(':id'), ({ params }) => {
      const t = liveThing(state.inventory, params.id ?? null);
      const access = accessOf(state);
      if (!t || !access.visible(t.locationId)) return notFound();
      const events = state.inventory.events;
      const done = new Set(events.filter((e) => e.undo_of).map((e) => e.undo_of as string));
      const at = Date.now();
      const open = (e: { eventId: string; until: string }) =>
        !done.has(e.eventId) && Date.parse(e.until) > at;
      const mine = (actorId: string | null, locationId: string | null) =>
        !!locationId &&
        access.canWrite(locationId) &&
        (access.isAdmin(locationId) || actorId === state.me.user.id);
      const fromHistory: UndoableEvent[] = events
        .filter(
          (e) =>
            e.undoable_until &&
            !e.undo_of &&
            ((e.entity.type === 'thing' && e.entity.id === t.id) || e.root_thing_id === t.id) &&
            mine(e.actor.id, e.location_id),
        )
        .map((e) => ({
          eventId: e.id,
          action: e.action,
          at: e.at,
          until: e.undoable_until as string,
        }));
      const seen = new Set(fromHistory.map((e) => e.eventId));
      const items = [
        ...fromHistory,
        ...(state.capture.undoable[t.id] ?? []).filter((e) => !seen.has(e.eventId)),
      ]
        .filter(open)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      return { items };
    }),
  ];
}
