/**
 * Mock handlers for the location map (1.x, D237), over the mock inventory: the same rules as
 * apps/server/src/map/view.ts (floors, rooms, nodes, things), and an arrange session that
 * replaces the location's layout. No attention pins: the mock has no stock rules or loans here.
 */
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, route } from '../mock/kit';
import { mapPaths as p } from './paths';
import type { LayoutBody, MapNodeLayout, MapRoomLayout, MapView } from './types';

type Stored = {
  version: string | null;
  rooms: Map<string, MapRoomLayout>;
  nodes: Map<string, MapNodeLayout>;
};
const stores = new WeakMap<MockState, Map<string, Stored>>();
function storeOf(state: MockState, locationId: string): Stored {
  let s = stores.get(state);
  if (!s) {
    s = new Map();
    stores.set(state, s);
  }
  let loc = s.get(locationId);
  if (!loc) {
    loc = { version: null, rooms: new Map(), nodes: new Map() };
    s.set(locationId, loc);
  }
  return loc;
}

/** The map of a mock location, as the server builds it. */
export function mockMapView(state: MockState, locationId: string): MapView | null {
  const loc = state.locations.find((l) => l.id === locationId);
  if (!loc) return null;
  const stored = storeOf(state, locationId);
  const places = state.inventory.places.filter((x) => x.locationId === locationId && !x.deletedAt);
  const byId = new Map(places.map((x) => [x.id, x]));
  const floors = places.filter((x) => x.kindKey === 'floor' && !x.parentId && !x.isUnplaced);
  const floorIds = new Set(floors.map((f) => f.id));
  const rooms = new Map<string, string | null>();
  for (const x of places) {
    if (x.isUnplaced || floorIds.has(x.id)) continue;
    if (!x.parentId) rooms.set(x.id, null);
    else if (floorIds.has(x.parentId)) rooms.set(x.id, x.parentId);
  }
  const roomOfPlace = (id: string | null): string | null => {
    let cur = id;
    for (let i = 0; cur && i < 50; i++) {
      if (rooms.has(cur)) return cur;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return null;
  };
  const things = state.inventory.things.filter(
    (x) =>
      x.locationId === locationId &&
      !x.deletedAt &&
      x.lifecycle === 'in_use' &&
      x.reviewState !== 'draft',
  );
  const thingById = new Map(things.map((x) => [x.id, x]));
  const roomOfThing = (id: string): string | null => {
    let cur = thingById.get(id);
    for (let i = 0; cur && i < 50; i++) {
      if (cur.placeId) return roomOfPlace(cur.placeId);
      cur = cur.containerId ? thingById.get(cur.containerId) : undefined;
    }
    return null;
  };
  const nodeIds = new Set<string>();
  for (const x of places) {
    if (rooms.has(x.id) || x.isUnplaced || !x.parentId) continue;
    if (rooms.has(x.parentId) || (stored.nodes.has(x.id) && roomOfPlace(x.id))) nodeIds.add(x.id);
  }
  for (const x of things) {
    const direct = x.placeId !== null && rooms.has(x.placeId) && x.isContainer;
    if (direct || (stored.nodes.has(x.id) && roomOfThing(x.id))) nodeIds.add(x.id);
  }
  const parentOf = (id: string, subject: 'place' | 'thing'): string | null => {
    let kind = subject;
    let cur: string | null = id;
    for (let i = 0; cur && i < 50; i++) {
      let next: string | null;
      if (kind === 'thing') {
        const x = thingById.get(cur);
        next = x?.containerId ?? x?.placeId ?? null;
        kind = x?.containerId ? 'thing' : 'place';
      } else next = byId.get(cur)?.parentId ?? null;
      if (next && (nodeIds.has(next) || rooms.has(next))) return next;
      cur = next;
    }
    return null;
  };
  const view: MapView = {
    locationId,
    canArrange: loc.role !== 'viewer',
    version: stored.version,
    levels: [
      ...([...rooms.values()].some((v) => v === null) || floors.length === 0
        ? [{ id: null, name: null }]
        : []),
      ...floors.map((f) => ({ id: f.id, name: f.name })),
    ],
    rooms: [...rooms.entries()].map(([id, levelId]) => {
      const x = byId.get(id);
      return {
        id,
        name: x?.name ?? '',
        shortCode: x?.shortCode ?? null,
        levelId,
        kindKey: x?.kindKey ?? 'room',
        layout: stored.rooms.get(id) ?? null,
      };
    }),
    nodes: [],
    things: [],
    more: 0,
    attention: [],
  };
  for (const x of places) {
    const roomId = roomOfPlace(x.id);
    const parentId = parentOf(x.id, 'place');
    if (!nodeIds.has(x.id) || !roomId || !parentId) continue;
    view.nodes.push({
      id: x.id,
      subject: 'place',
      name: x.name,
      shortCode: x.shortCode,
      roomId,
      parentId,
      kindKey: x.kindKey,
      typeKey: null,
      isContainer: false,
      quantity: 1,
      layout: stored.nodes.get(x.id) ?? null,
    });
  }
  for (const x of things) {
    const roomId = roomOfThing(x.id);
    const parentId = parentOf(x.id, 'thing');
    if (!roomId || !parentId) continue;
    if (nodeIds.has(x.id)) {
      view.nodes.push({
        id: x.id,
        subject: 'thing',
        name: x.name ?? '',
        shortCode: x.shortCode,
        roomId,
        parentId,
        kindKey: null,
        typeKey: x.type?.builtinKey ?? null,
        isContainer: x.isContainer,
        quantity: x.quantity,
        layout: stored.nodes.get(x.id) ?? null,
      });
    }
    view.things.push({
      id: x.id,
      name: x.name ?? '',
      shortCode: x.shortCode,
      quantity: x.quantity,
      parentId,
      typeKey: x.type?.builtinKey ?? null,
      typeName: x.type && !x.type.builtinKey ? x.type.name : null,
      isContainer: x.isContainer,
    });
  }
  return view;
}

export function mapMockRoutes(state: MockState): MockRoute[] {
  return [
    route(
      'GET',
      p.map(':id'),
      ({ params }) => mockMapView(state, params.id as string) ?? notFound(),
    ),
    route('PUT', p.layout(':id'), ({ params, body }) => {
      const id = params.id as string;
      const loc = state.locations.find((l) => l.id === id);
      if (!loc) return notFound();
      if (loc.role === 'viewer') return forbidden();
      const b = body as LayoutBody;
      const stored = storeOf(state, id);
      if ((b?.version ?? null) !== stored.version)
        return err(409, 'conflict', 'Conflict.', 'Someone arranged this map since you opened it.', {
          reason: 'arranged_since',
        });
      stored.rooms = new Map(b.rooms.map(({ id: rid, ...r }) => [rid, r]));
      stored.nodes = new Map(b.nodes.map(({ id: nid, ...n }) => [nid, n]));
      stored.version = new Date().toISOString();
      return { version: stored.version };
    }),
  ];
}
