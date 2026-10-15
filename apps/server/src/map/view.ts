import { can, MAP_ROOM_KINDS, MAP_SURFACES } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import type { Tx } from '../db/scope.js';
import { notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import { requireMembership } from '../locations/access.js';

// GET /api/v1/locations/:id/map (1.x, D237): everything the location map draws and its card and
// list show, in one read under the caller's row-level security.
//
// - Levels are the location's top-level places of the built-in `floor` kind, in the tree's order
//   (the first is the ground). Rooms on no floor share one level of their own (`id: null`), the
//   first, which is the only one when the location has no floors.
// - Rooms are the places directly on a floor or at the top of the tree (not floors, not the
//   Unplaced area), whatever their kind: a location that has no "room" places still draws.
// - Nodes stand in rooms: every place directly in a room, every container directly in a room,
//   and anything someone put on the map (a row in map_nodes) whose room is known.
// - Things: every live thing in use that is in a room, with the nearest node or room above it
//   (`parentId`), up to THING_CAP (the rest are counted in `more`).
// - Attention: low stock (Consumables on), lent out (Lending on) and due soon (the agenda's
//   overdue, due and expiring items, each paused with its module by the view itself).
// A room or node with no layout row comes back with `layout: null`; the web lays it out.

export const THING_CAP = 5000;
const ATTENTION_CAP = 1000;

const RoomLayout = z.object({
  x: z.number().int(),
  z: z.number().int(),
  w: z.number().int(),
  d: z.number().int(),
  kind: z.enum(MAP_ROOM_KINDS),
  surface: z.enum(MAP_SURFACES),
});

const NodeLayout = z.object({
  x: z.number().int(),
  z: z.number().int(),
  rot: z.number().int(),
  model: z.string().nullable(),
  hostId: z.uuid().nullable(),
});

export const MapViewSchema = z.object({
  locationId: z.uuid(),
  canArrange: z.boolean(),
  /** When the layout was last arranged (the arrange session's stamp), or null. A PUT sends it
   * back, so two people arranging at once can't overwrite each other unseen. */
  version: z.string().nullable(),
  levels: z.array(z.object({ id: z.uuid().nullable(), name: z.string().nullable() })),
  rooms: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      shortCode: z.string().nullable(),
      levelId: z.uuid().nullable(),
      kindKey: z.string(),
      layout: RoomLayout.nullable(),
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.uuid(),
      subject: z.enum(['place', 'thing']),
      name: z.string(),
      shortCode: z.string().nullable(),
      roomId: z.uuid(),
      parentId: z.uuid(),
      kindKey: z.string().nullable(),
      typeKey: z.string().nullable(),
      isContainer: z.boolean(),
      quantity: z.number(),
      layout: NodeLayout.nullable(),
    }),
  ),
  things: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      shortCode: z.string().nullable(),
      quantity: z.number(),
      parentId: z.uuid(),
    }),
  ),
  /** Things in rooms past THING_CAP, not in `things`. */
  more: z.number().int(),
  attention: z.array(
    z.object({
      subjectId: z.uuid(),
      kind: z.enum(['low', 'lent', 'due']),
      title: z.string().nullable(),
      sourceType: z.string().nullable(),
      state: z.string().nullable(),
      dueOn: z.string().nullable(),
      person: z.string().nullable(),
      quantity: z.number().nullable(),
      min: z.number().nullable(),
    }),
  ),
});
export type MapView = z.infer<typeof MapViewSchema>;

type PlaceRow = {
  id: string;
  parent_id: string | null;
  name: string;
  kind_key: string;
  is_unplaced: boolean;
  short_code: string | null;
};

type ThingRow = {
  id: string;
  name: string | null;
  place_id: string | null;
  container_id: string | null;
  quantity: string;
  type_key: string | null;
  is_container: boolean;
  short_code: string | null;
  on_map: boolean;
};

export type NodeRow = {
  id: string;
  place_id: string | null;
  thing_id: string | null;
  x: number;
  z: number;
  w: number | null;
  d: number | null;
  rot: number;
  model: string | null;
  room_kind: (typeof MAP_ROOM_KINDS)[number] | null;
  surface: (typeof MAP_SURFACES)[number] | null;
  host_id: string | null;
  created_at: Date;
};

export const NODE_COLUMNS =
  'id, place_id, thing_id, x_cm AS x, z_cm AS z, w_cm AS w, d_cm AS d, rot, model, room_kind, surface, host_id, created_at';

/** The layout's version: the newest row's stamp (an arrange session writes all its rows at once). */
export function versionOf(rows: readonly Pick<NodeRow, 'created_at'>[]): string | null {
  let newest: Date | null = null;
  for (const r of rows) if (!newest || r.created_at > newest) newest = r.created_at;
  return newest ? newest.toISOString() : null;
}

/** The place tree's map roles: floors, rooms, and which room each place is in. */
export type MapTree = {
  floors: string[];
  /** room id → its level (a floor's id, or null for rooms on no floor). */
  rooms: Map<string, string | null>;
  places: Map<string, PlaceRow>;
  /** The room a place is in (itself for a room), or null (a floor, the Unplaced area). */
  roomOfPlace: (id: string) => string | null;
};

export function mapTree(rows: readonly PlaceRow[]): MapTree {
  const places = new Map(rows.map((p) => [p.id, p]));
  const isFloor = (p: PlaceRow) => p.kind_key === 'floor' && p.parent_id === null && !p.is_unplaced;
  const floors = rows.filter(isFloor).map((p) => p.id);
  const floorSet = new Set(floors);
  const rooms = new Map<string, string | null>();
  for (const p of rows) {
    if (p.is_unplaced || floorSet.has(p.id)) continue;
    if (p.parent_id === null) rooms.set(p.id, null);
    else if (floorSet.has(p.parent_id)) rooms.set(p.id, p.parent_id);
  }
  const memo = new Map<string, string | null>();
  const roomOfPlace = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id) ?? null;
    const seen = new Set<string>();
    let cur: string | null = id;
    let found: string | null = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (rooms.has(cur)) {
        found = cur;
        break;
      }
      cur = places.get(cur)?.parent_id ?? null;
    }
    memo.set(id, found);
    return found;
  };
  return { floors, rooms, places, roomOfPlace };
}

export async function placeRows(client: pg.ClientBase, locationId: string): Promise<PlaceRow[]> {
  const { rows } = await client.query<PlaceRow>(
    `SELECT p.id, p.parent_id, p.name, p.kind_key, p.is_unplaced,
            (SELECT sc.code FROM public.short_ids sc
              WHERE sc.place_id = p.id AND sc.is_primary AND sc.state = 'assigned' LIMIT 1)
              AS short_code
       FROM public.places p
      WHERE p.location_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.sort, lower(p.name), p.id`,
    [locationId],
  );
  return rows;
}

/** The location's live things in use, the ones on the map and the containers first. */
async function thingRows(client: pg.ClientBase, locationId: string): Promise<ThingRow[]> {
  const { rows } = await client.query<ThingRow>(
    `SELECT t.id, t.name, t.place_id, t.container_id, t.quantity::text AS quantity,
            coalesce(ty.builtin_key,
                     (SELECT pt.builtin_key FROM public.types pt WHERE pt.id = ty.parent_id))
              AS type_key,
            (coalesce('container' = ANY (kept.type_capabilities(t.type_id)), false)
              OR EXISTS (SELECT 1 FROM public.things c
                          WHERE c.container_id = t.id AND c.deleted_at IS NULL)) AS is_container,
            (SELECT sc.code FROM public.short_ids sc
              WHERE sc.thing_id = t.id AND sc.is_primary AND sc.state = 'assigned' LIMIT 1)
              AS short_code,
            EXISTS (SELECT 1 FROM public.map_nodes n WHERE n.thing_id = t.id) AS on_map
       FROM public.things t
       LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE t.location_id = $1 AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
        AND t.review_state <> 'draft'
      ORDER BY on_map DESC, is_container DESC, lower(coalesce(t.name, '')), t.id`,
    [locationId],
  );
  return rows;
}

export async function nodeRows(client: pg.ClientBase, locationId: string): Promise<NodeRow[]> {
  const { rows } = await client.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM public.map_nodes WHERE location_id = $1 ORDER BY id`,
    [locationId],
  );
  return rows;
}

async function attentionOf(
  tx: Tx,
  client: pg.ClientBase,
  locationId: string,
): Promise<MapView['attention']> {
  const modules = (await locationModuleSet(tx, locationId)) ?? new Set();
  const out: MapView['attention'] = [];
  const blank = {
    title: null,
    sourceType: null,
    state: null,
    dueOn: null,
    person: null,
    quantity: null,
    min: null,
  };
  if (modules.has('consumables')) {
    const { rows } = await client.query<{ thing_id: string; quantity: string; min: string }>(
      `SELECT r.thing_id, trim_scale(t.quantity)::text AS quantity,
              trim_scale(r.min_quantity)::text AS min
         FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
        WHERE t.location_id = $1 AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
          AND t.quantity < r.min_quantity
        ORDER BY r.thing_id LIMIT ${ATTENTION_CAP}`,
      [locationId],
    );
    for (const r of rows) {
      out.push({
        ...blank,
        subjectId: r.thing_id,
        kind: 'low',
        quantity: Number(r.quantity),
        min: Number(r.min),
      });
    }
  }
  if (modules.has('lending')) {
    const { rows } = await client.query<{
      thing_id: string;
      due_on: string | null;
      person: string | null;
    }>(
      `SELECT o.thing_id, o.due_on::text AS due_on, pe.display_name AS person
         FROM public.loans o
         LEFT JOIN public.people pe ON pe.id = o.person_id
        WHERE o.location_id = $1 AND o.returned_at IS NULL AND o.direction = 'out'
        ORDER BY o.thing_id LIMIT ${ATTENTION_CAP}`,
      [locationId],
    );
    for (const r of rows) {
      out.push({
        ...blank,
        subjectId: r.thing_id,
        kind: 'lent',
        dueOn: r.due_on,
        person: r.person,
      });
    }
  }
  const { rows: due } = await client.query<{
    subject_id: string;
    source_type: string;
    state: string;
    due_on: string | null;
    title: string | null;
  }>(
    `SELECT coalesce(a.thing_id, a.place_id) AS subject_id, a.source_type, a.state,
            a.due_on::text AS due_on, a.title
       FROM public.agenda_items a
      WHERE a.location_id = $1 AND a.state IN ('overdue', 'due', 'expiring')
        AND a.source_type NOT IN ('stock', 'loan')
        AND coalesce(a.thing_id, a.place_id) IS NOT NULL
      ORDER BY a.due_on NULLS LAST, subject_id LIMIT ${ATTENTION_CAP}`,
    [locationId],
  );
  for (const r of due) {
    out.push({
      ...blank,
      subjectId: r.subject_id,
      kind: 'due',
      title: r.title,
      sourceType: r.source_type,
      state: r.state,
      dueOn: r.due_on,
    });
  }
  return out;
}

/** The whole map of a location the caller can see (404 otherwise). */
export async function mapView(tx: Tx, client: pg.ClientBase, locationId: string): Promise<MapView> {
  const me = await requireMembership(client, locationId);
  const { rows: loc } = await client.query<{ id: string }>(
    'SELECT id FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
    [locationId],
  );
  if (!loc[0]) throw notFound();
  const placeList = await placeRows(client, locationId);
  const tree = mapTree(placeList);
  const nodes = await nodeRows(client, locationId);
  const things = await thingRows(client, locationId);
  const thingById = new Map(things.map((t) => [t.id, t]));
  const layoutOf = new Map<string, NodeRow>();
  for (const n of nodes) layoutOf.set((n.place_id ?? n.thing_id) as string, n);

  // The room a thing is in: up its containers to a place, then up the tree.
  const roomMemo = new Map<string, string | null>();
  const roomOfThing = (id: string): string | null => {
    if (roomMemo.has(id)) return roomMemo.get(id) ?? null;
    const seen = new Set<string>();
    let cur = thingById.get(id);
    let room: string | null = null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.place_id) {
        room = tree.roomOfPlace(cur.place_id);
        break;
      }
      cur = cur.container_id ? thingById.get(cur.container_id) : undefined;
    }
    roomMemo.set(id, room);
    return room;
  };

  // Which places and things are nodes.
  const nodeIds = new Set<string>();
  for (const p of placeList) {
    if (tree.rooms.has(p.id) || p.is_unplaced || !p.parent_id) continue;
    if (tree.rooms.has(p.parent_id) || (layoutOf.has(p.id) && tree.roomOfPlace(p.id))) {
      nodeIds.add(p.id);
    }
  }
  for (const t of things) {
    const direct = t.place_id !== null && tree.rooms.has(t.place_id) && t.is_container;
    if (direct || (layoutOf.has(t.id) && roomOfThing(t.id))) nodeIds.add(t.id);
  }
  const isNodeOrRoom = (id: string) => nodeIds.has(id) || tree.rooms.has(id);

  /** The nearest node or room above a place or thing (never itself). */
  const parentOf = (subject: 'place' | 'thing', id: string): string | null => {
    const seen = new Set<string>([id]);
    let kind = subject;
    let cur: string | null = id;
    for (;;) {
      let next: string | null;
      if (kind === 'thing') {
        const t = thingById.get(cur as string);
        if (!t) return null;
        next = t.container_id ?? t.place_id;
        kind = t.container_id ? 'thing' : 'place';
      } else {
        next = tree.places.get(cur as string)?.parent_id ?? null;
      }
      if (!next || seen.has(next)) return null;
      if (isNodeOrRoom(next)) return next;
      seen.add(next);
      cur = next;
    }
  };

  const roomLayout = (id: string) => {
    const n = layoutOf.get(id);
    return n && n.w !== null && n.d !== null
      ? {
          x: n.x,
          z: n.z,
          w: n.w,
          d: n.d,
          kind: n.room_kind ?? 'room',
          surface: n.surface ?? ('wood' as const),
        }
      : null;
  };
  const nodeLayout = (id: string) => {
    const n = layoutOf.get(id);
    return n && n.w === null
      ? { x: n.x, z: n.z, rot: n.rot, model: n.model, hostId: n.host_id }
      : null;
  };

  const levels: MapView['levels'] = [];
  const roomList = [...tree.rooms.entries()];
  if (roomList.some(([, level]) => level === null) || tree.floors.length === 0) {
    levels.push({ id: null, name: null });
  }
  for (const f of tree.floors) levels.push({ id: f, name: tree.places.get(f)?.name ?? null });

  const outNodes: MapView['nodes'] = [];
  for (const p of placeList) {
    if (!nodeIds.has(p.id)) continue;
    const roomId = tree.roomOfPlace(p.id);
    const parentId = parentOf('place', p.id);
    if (!roomId || !parentId) continue;
    outNodes.push({
      id: p.id,
      subject: 'place',
      name: p.name,
      shortCode: p.short_code,
      roomId,
      parentId,
      kindKey: p.kind_key,
      typeKey: null,
      isContainer: false,
      quantity: 1,
      layout: nodeLayout(p.id),
    });
  }
  const outThings: MapView['things'] = [];
  let more = 0;
  for (const t of things) {
    const roomId = roomOfThing(t.id);
    if (!roomId) continue;
    const parentId = parentOf('thing', t.id);
    if (!parentId) continue;
    const name = t.name ?? '';
    if (nodeIds.has(t.id)) {
      outNodes.push({
        id: t.id,
        subject: 'thing',
        name,
        shortCode: t.short_code,
        roomId,
        parentId,
        kindKey: null,
        typeKey: t.type_key,
        isContainer: t.is_container,
        quantity: Number(t.quantity),
        layout: nodeLayout(t.id),
      });
    }
    if (outThings.length >= THING_CAP) {
      more++;
      continue;
    }
    outThings.push({
      id: t.id,
      name,
      shortCode: t.short_code,
      quantity: Number(t.quantity),
      parentId,
    });
  }

  return {
    locationId,
    canArrange: can(me.role, 'things.edit'),
    version: versionOf(nodes),
    levels,
    rooms: roomList.map(([id, levelId]) => {
      const p = tree.places.get(id) as PlaceRow;
      return {
        id,
        name: p.name,
        shortCode: p.short_code,
        levelId,
        kindKey: p.kind_key,
        layout: roomLayout(id),
      };
    }),
    nodes: outNodes,
    things: outThings,
    more,
    attention: await attentionOf(tx, client, locationId),
  };
}
