import {
  canHost,
  canStandOn,
  firstOverlap,
  isMapModel,
  MAP_LIMITS,
  MAP_ROOM_KINDS,
  MAP_SURFACES,
  type MapModelKey,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import { AppError, invalid } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { mapTree, NODE_COLUMNS, type NodeRow, nodeRows, placeRows, versionOf } from './view.js';

// PUT /api/v1/locations/:id/layout (1.x, D237): one arrange session, the whole layout at once.
//
// - Anyone who may edit things there arranges (members and up, `things.edit`); viewers see the
//   map and can't change it.
// - The body is the location's complete layout: the rows replace the old ones. A room or node
//   left out goes back to the web's automatic layout.
// - `version` is the layout the session started from (GET …/map); if someone arranged since, 409
//   `conflict` with `reason: 'arranged_since'`, so nobody overwrites another's work unseen.
// - Checked: every room is a room of this location (a live place on a floor or at the top);
//   every node a live place in a room or a live thing in use in a room, each at most once; a
//   model from the catalogue; a host that is another node of the session, something can stand
//   on, holding only small things, with no loop; rooms on one floor don't overlap.
// - Audited `place.arrange` on the location with the whole layout before and after (the diff's
//   `layout`, which the web never shows), undoable for ten minutes (undo.ts).

const RoomBody = z.object({
  id: z.uuid(),
  x: z.number().int().min(0).max(MAP_LIMITS.maxCoord),
  z: z.number().int().min(0).max(MAP_LIMITS.maxCoord),
  w: z.number().int().min(MAP_LIMITS.minRoom).max(MAP_LIMITS.maxRoom),
  d: z.number().int().min(MAP_LIMITS.minRoom).max(MAP_LIMITS.maxRoom),
  kind: z.enum(MAP_ROOM_KINDS),
  surface: z.enum(MAP_SURFACES),
});

const NodeBody = z.object({
  id: z.uuid(),
  x: z.number().int().min(0).max(MAP_LIMITS.maxCoord),
  z: z.number().int().min(0).max(MAP_LIMITS.maxCoord),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  model: z.string().max(40),
  hostId: z.uuid().nullable(),
});

export const LayoutBody = z.object({
  version: z.string().max(40).nullable(),
  rooms: z.array(RoomBody).max(MAP_LIMITS.rooms),
  nodes: z.array(NodeBody).max(MAP_LIMITS.nodes),
});
export type LayoutBody = z.infer<typeof LayoutBody>;

export type Ctx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

/** A layout row as the audit stores it, in a fixed order, so undo can compare. */
export type LayoutImage = {
  id: string;
  s: 'place' | 'thing';
  x: number;
  z: number;
  w: number | null;
  d: number | null;
  rot: number;
  model: string | null;
  kind: string | null;
  surface: string | null;
  host: string | null;
};

export function imageOf(rows: readonly NodeRow[]): LayoutImage[] {
  return rows
    .map((r) => ({
      id: (r.place_id ?? r.thing_id) as string,
      s: r.place_id ? ('place' as const) : ('thing' as const),
      x: r.x,
      z: r.z,
      w: r.w,
      d: r.d,
      rot: r.rot,
      model: r.model,
      kind: r.room_kind,
      surface: r.surface,
      host: r.host_id,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Serialises arrange sessions of one location. */
export async function lockLayout(client: pg.ClientBase, locationId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('kept.map'), hashtext($1::text))`, [
    locationId,
  ]);
}

/** Replaces the location's rows with `image` (the caller checked it). */
export async function writeImage(
  client: pg.ClientBase,
  locationId: string,
  image: readonly LayoutImage[],
): Promise<NodeRow[]> {
  await client.query('DELETE FROM public.map_nodes WHERE location_id = $1', [locationId]);
  if (image.length === 0) return [];
  const { rows } = await client.query<NodeRow>(
    `INSERT INTO public.map_nodes (location_id, place_id, thing_id, x_cm, z_cm, w_cm, d_cm, rot, model,
                                   room_kind, surface, host_id, created_by)
     SELECT $1, CASE WHEN r.s = 'place' THEN r.id END, CASE WHEN r.s = 'thing' THEN r.id END,
            r.x, r.z, r.w, r.d, r.rot, r.model, r.kind, r.surface, r.host,
            kept.current_user_id()
       FROM jsonb_to_recordset($2::jsonb)
         AS r(id uuid, s text, x int, z int, w int, d int, rot int, model text, kind text,
              surface text, host uuid)
     RETURNING ${NODE_COLUMNS}`,
    [locationId, JSON.stringify(image)],
  );
  return rows;
}

const refuse = (hint: string) => invalid(hint);

type ThingRef = { id: string; place_id: string | null; container_id: string | null };

/** The checked layout as rows to store. */
async function checkedImage(
  client: pg.ClientBase,
  locationId: string,
  body: LayoutBody,
): Promise<LayoutImage[]> {
  const tree = mapTree(await placeRows(client, locationId));
  const { rows: thingList } = await client.query<ThingRef>(
    `SELECT t.id, t.place_id, t.container_id FROM public.things t
      WHERE t.location_id = $1 AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
        AND t.review_state <> 'draft'`,
    [locationId],
  );
  const things = new Map(thingList.map((t) => [t.id, t]));
  const roomOfThing = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = things.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.place_id) return tree.roomOfPlace(cur.place_id);
      cur = cur.container_id ? things.get(cur.container_id) : undefined;
    }
    return null;
  };

  const seen = new Set<string>();
  const once = (id: string) => {
    if (seen.has(id)) throw refuse(`Check the layout: ${id} is in it twice.`);
    seen.add(id);
  };
  const image: LayoutImage[] = [];
  const byLevel = new Map<string, { x: number; z: number; w: number; d: number }[]>();
  for (const r of body.rooms) {
    const id = r.id.toLowerCase();
    once(id);
    if (!tree.rooms.has(id)) throw refuse(`Check rooms: ${id} is not a room of this location.`);
    const level = tree.rooms.get(id) ?? '';
    byLevel.set(level, [...(byLevel.get(level) ?? []), { x: r.x, z: r.z, w: r.w, d: r.d }]);
    image.push({
      id,
      s: 'place',
      x: r.x,
      z: r.z,
      w: r.w,
      d: r.d,
      rot: 0,
      model: null,
      kind: r.kind,
      surface: r.surface,
      host: null,
    });
  }
  for (const rects of byLevel.values()) {
    if (firstOverlap(rects)) {
      throw new AppError('conflict', 409, 'Rooms on one floor can’t overlap.', {
        reason: 'rooms_overlap',
      });
    }
  }

  const models = new Map<string, MapModelKey>();
  const hosts = new Map<string, string>();
  for (const n of body.nodes) {
    const id = n.id.toLowerCase();
    once(id);
    if (!isMapModel(n.model)) throw refuse(`Check nodes: there is no model "${n.model}".`);
    const place = tree.places.get(id);
    let subject: 'place' | 'thing';
    if (place) {
      if (place.is_unplaced || tree.rooms.has(id) || !tree.roomOfPlace(id)) {
        throw refuse(`Check nodes: ${id} is not a place in a room of this location.`);
      }
      subject = 'place';
    } else if (things.has(id)) {
      if (!roomOfThing(id)) throw refuse(`Check nodes: ${id} is not in a room of this location.`);
      subject = 'thing';
    } else {
      throw refuse(`Check nodes: ${id} is not a place or thing of this location.`);
    }
    models.set(id, n.model);
    if (n.hostId) hosts.set(id, n.hostId.toLowerCase());
    image.push({
      id,
      s: subject,
      x: n.x,
      z: n.z,
      w: null,
      d: null,
      rot: n.rot,
      model: n.model,
      kind: null,
      surface: null,
      host: n.hostId ? n.hostId.toLowerCase() : null,
    });
  }
  for (const [id, host] of hosts) {
    const hostModel = models.get(host);
    if (!hostModel) throw refuse(`Check nodes: ${id} stands on ${host}, which is not on the map.`);
    if (!canHost(hostModel)) throw refuse(`Check nodes: nothing can stand on ${host}.`);
    if (!canStandOn(models.get(id) as MapModelKey)) {
      throw refuse(`Check nodes: ${id} is too big to stand on something.`);
    }
    const chain = new Set([id]);
    let cur: string | undefined = host;
    while (cur) {
      if (chain.has(cur)) throw refuse(`Check nodes: ${id} stands on itself.`);
      chain.add(cur);
      cur = hosts.get(cur);
    }
  }
  return image.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Ten minutes (the arrange session's undo, D237). */
export const ARRANGE_UNDO_MS = 10 * 60 * 1000;

export async function putLayout(
  c: Ctx,
  locationId: string,
  body: LayoutBody,
): Promise<{ version: string | null }> {
  const me = await requireMembership(c.client, locationId);
  requireCan(me.role, 'things.edit');
  await lockLayout(c.client, locationId);
  const before = await nodeRows(c.client, locationId);
  if (versionOf(before) !== body.version) {
    throw new AppError(
      'conflict',
      409,
      'Someone arranged this map since you opened it. Load it again to see theirs.',
      { reason: 'arranged_since' },
    );
  }
  const image = await checkedImage(c.client, locationId, body);
  const after = await writeImage(c.client, locationId, image);
  await audited(c.tx, {
    locationId,
    actor: actorOf(c.scope),
    action: 'place.arrange',
    entity: { type: 'location', id: locationId },
    before: { layout: imageOf(before) },
    after: { layout: image },
    requestId: c.requestId,
    undoableUntil: new Date(Date.now() + ARRANGE_UNDO_MS),
  });
  return { version: versionOf(after) };
}
