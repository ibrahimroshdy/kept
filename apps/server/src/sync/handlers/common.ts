import type { DropReason, OpKind, OpPayload, SyncOpResult } from '@kept/shared';
import type pg from 'pg';
import type { Ctx } from '../../things/service.js';

// What every op handler shares (plan T14). A handler calls the service that owns the change
// (capture, moves, readings, labels, places, box checks) in the op's own scoped transaction; none
// re-implements a domain rule. Before calling it, a handler looks at what the op points at, so a
// change to something trashed in the meantime is answered as D35 asks ("the drill was trashed by
// Alfred", with a restore) instead of as the service's plain 404.

export type OpCtx = Ctx;

export type OpArgs<K extends OpKind> = {
  /** The op's location (for a move, the destination's). */
  locationId: string;
  /** When it was done on the phone, clamped to the server's receipt (D112). */
  takenAt: Date;
  payload: OpPayload<K>;
};

export type Notice = NonNullable<SyncOpResult['notice']>;
export type Entity = NonNullable<SyncOpResult['entity']>;

/** What changed under a dropped op: the inbox item's `entity`, the thing or place to restore. */
export type Subject = { type: 'thing' | 'place'; id: string; name: string };

export type Done = {
  outcome: 'applied' | 'needs_review';
  reason?: string;
  entity?: Entity;
  notice?: Notice;
  inboxItemId?: string;
};

export type Dropped = {
  outcome: 'dropped';
  reason: DropReason;
  notice?: Notice;
  subject?: Subject;
  /** Who did what dropped it, for the inbox item (`by`). */
  by?: string;
};

export type HandlerResult = Done | Dropped;

export type Handler<K extends OpKind> = (ctx: OpCtx, args: OpArgs<K>) => Promise<HandlerResult>;

export type Presence = {
  state: 'live' | 'trashed' | 'missing';
  name: string;
  locationId: string | null;
  /** Who trashed it: the trash event that stamped its batch (as trash/service.ts finds it). */
  trashedBy: string | null;
};

const MISSING: Presence = { state: 'missing', name: '', locationId: null, trashedBy: null };

/**
 * Whether a thing or place the op points at is live, in the trash, or out of sight (missing, or
 * in a location the caller doesn't see: the same answer, §7.7).
 */
export async function presenceOf(
  client: pg.ClientBase,
  type: 'thing' | 'place',
  id: string,
): Promise<Presence> {
  const table = type === 'thing' ? 'things' : 'places';
  const { rows } = await client.query<{
    name: string | null;
    location_id: string;
    trashed: boolean;
    trashed_by: string | null;
  }>(
    `SELECT x.name, x.location_id, x.deleted_at IS NOT NULL AS trashed,
            CASE WHEN x.deleted_at IS NULL THEN NULL ELSE
              (SELECT up.display_name
                 FROM public.audit_events e
                 JOIN public.user_profiles up ON up.user_id = e.actor_id
                WHERE e.location_id = x.location_id
                  AND e.actor_type = 'user'
                  AND e.at BETWEEN x.deleted_at - interval '1 second'
                               AND x.deleted_at + interval '1 second'
                  AND e.action IN ('thing.trash', 'place.trash')
                  AND e.diff->'trash_batch_id'->>'after' = x.trash_batch_id::text
                ORDER BY e.at DESC LIMIT 1)
            END AS trashed_by
       FROM public.${table} x
      WHERE x.id = $1`,
    [id.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return MISSING;
  return {
    state: row.trashed ? 'trashed' : 'live',
    name: row.name ?? '',
    locationId: row.location_id,
    trashedBy: row.trashed_by,
  };
}

/** The drop for something the op needed that isn't live: trashed (with who did it, and the
 * subject a restore brings back), or missing. */
export function goneDrop(type: 'thing' | 'place', id: string, p: Presence): Dropped {
  if (p.state !== 'trashed') return { outcome: 'dropped', reason: 'target_missing' };
  return {
    outcome: 'dropped',
    reason: 'target_trashed',
    subject: { type, id: id.toLowerCase(), name: p.name },
    ...(p.trashedBy
      ? {
          by: p.trashedBy,
          notice: { name: p.name, by: { displayName: p.trashedBy }, action: 'trashed' as const },
        }
      : {}),
  };
}

/**
 * Checks that each of `refs` is live (and, with `locationId`, in that location: elsewhere is as
 * absent as missing). Answers the first drop, or null when all are live.
 */
export async function requireLive(
  client: pg.ClientBase,
  refs: readonly { type: 'thing' | 'place'; id: string }[],
  locationId?: string,
): Promise<Dropped | null> {
  for (const ref of refs) {
    const p = await presenceOf(client, ref.type, ref.id);
    const elsewhere = locationId !== undefined && p.locationId !== locationId.toLowerCase();
    if (p.state !== 'live' || elsewhere) return goneDrop(ref.type, ref.id, elsewhere ? MISSING : p);
  }
  return null;
}

/** The target of a move, a capture or a new box: a place or a container. */
export const targetRef = (to: {
  placeId?: string;
  containerId?: string;
}): { type: 'thing' | 'place'; id: string } | null =>
  to.placeId
    ? { type: 'place', id: to.placeId }
    : to.containerId
      ? { type: 'thing', id: to.containerId }
      : null;
