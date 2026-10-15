/**
 * The location map's plan (1.x, D237): the server's map turned into metres, with everything
 * nobody arranged laid out automatically, and the arrange rules (footprints, turns, standing on
 * something, rooms that can't overlap). Pure: no three.js, no DOM, so it is tested on its own.
 *
 * Auto layout (M2): rooms nobody arranged go side by side in the tree's order, to the right of
 * the arranged ones, wrapping to a new row past ROW_WIDTH; what stands in a room goes in rows
 * from its corner, around anything arranged there. A room nobody arranged is sized to fit.
 */
import {
  canHost,
  canStandOn,
  cmToM,
  footprintOf,
  guessModel,
  isMapModel,
  levelShort,
  MAP_LIMITS,
  type MapModelKey,
  type MapRect,
  type MapRoomKind,
  type MapSurface,
  mToCm,
  ROOM_KIND_SURFACE,
  rectsOverlap,
} from '@kept/shared';
import type {
  LayoutBody,
  MapAttention,
  MapAttentionKind,
  MapNodeView,
  MapThingView,
  MapView,
} from '@/api/map/types';

export const NO_FLOOR = '_';
/** Metres between rooms laid out automatically, and the row they wrap at. */
export const ROOM_GAP = 1;
export const ROW_WIDTH = 24;
/** Metres between things laid out automatically, and from the walls. */
const ITEM_GAP = 0.3;
const WALL = 0.15;

export type Level = { key: string; id: string | null; name: string; short: string };

export type Room = {
  id: string;
  levelKey: string;
  name: string;
  shortCode: string | null;
  kindKey: string;
  x: number;
  z: number;
  w: number;
  d: number;
  kind: MapRoomKind;
  surface: MapSurface;
};

export type Item = {
  id: string;
  subject: 'place' | 'thing';
  roomId: string;
  name: string;
  shortCode: string | null;
  model: MapModelKey;
  x: number;
  z: number;
  rot: number;
  /** The item it stands on. */
  on: string | null;
  /** Kept's nearest room or node above it. */
  parentId: string;
  isContainer: boolean;
  quantity: number;
  /** On the map because of where it is (a place in a room, a container in a room), not because
   * someone put it there: it can't be taken off. */
  auto: boolean;
};

export type Plan = { levels: Level[]; rooms: Room[]; items: Item[] };

/** What the auto layout and the names need from the page. */
export type PlanNames = { noFloor: string; location: string };

export const levelKeyOf = (id: string | null) => id ?? NO_FLOOR;

export function fp(item: Pick<Item, 'model' | 'rot'>): { w: number; d: number } {
  return footprintOf(item.model, item.rot);
}

const modelOf = (n: MapNodeView): MapModelKey =>
  n.layout?.model && isMapModel(n.layout.model)
    ? n.layout.model
    : guessModel({
        name: n.name,
        subject: n.subject,
        kindKey: n.kindKey,
        typeKey: n.typeKey,
        isContainer: n.isContainer,
      });

/** Packs footprints into rows inside `width`, avoiding `taken`; returns positions and depth. */
function pack(
  sizes: { w: number; d: number }[],
  width: number,
  taken: MapRect[],
): { at: { x: number; z: number }[]; depth: number } {
  const at: { x: number; z: number }[] = [];
  let x = WALL;
  let z = WALL;
  let rowDepth = 0;
  let depth = WALL;
  for (const s of sizes) {
    for (let guard = 0; guard < 500; guard++) {
      if (x > WALL && x + s.w > width - WALL / 2) {
        x = WALL;
        z += rowDepth + ITEM_GAP;
        rowDepth = 0;
      }
      const rect = { x, z, w: s.w, d: s.d };
      const hit = taken.find((r) => rectsOverlap(r, rect));
      if (!hit) break;
      x = hit.x + hit.w + ITEM_GAP;
    }
    at.push({ x, z });
    taken.push({ x, z, w: s.w, d: s.d });
    x += s.w + ITEM_GAP;
    rowDepth = Math.max(rowDepth, s.d);
    depth = Math.max(depth, z + s.d + WALL);
  }
  return { at, depth };
}

/** The server's map as a plan in metres, laid out where nobody arranged it. */
export function planOf(view: MapView, names: PlanNames): Plan {
  const levels: Level[] = view.levels.map((l, i) => {
    const name =
      l.id === null ? (view.levels.length > 1 ? names.noFloor : names.location) : (l.name ?? '');
    return { key: levelKeyOf(l.id), id: l.id, name, short: levelShort(name, i) };
  });
  const nodesByRoom = new Map<string, MapNodeView[]>();
  for (const n of view.nodes) nodesByRoom.set(n.roomId, [...(nodesByRoom.get(n.roomId) ?? []), n]);

  const items: Item[] = [];
  const rooms: Room[] = [];
  // Rooms someone arranged keep their place; the others are sized to fit what stands in them.
  const sized = new Map<string, { w: number; d: number }>();
  for (const r of view.rooms) {
    const nodes = nodesByRoom.get(r.id) ?? [];
    const placed = nodes.filter((n) => n.layout);
    const loose = nodes.filter((n) => !n.layout);
    const models = loose.map(modelOf);
    const sizes = models.map((m) => footprintOf(m, 0));
    let w: number;
    if (r.layout) w = cmToM(r.layout.w);
    else {
      const area = sizes.reduce((a, s) => a + s.w * s.d, 0);
      const widest = sizes.reduce((a, s) => Math.max(a, s.w), 0);
      w = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(area * 3)), Math.ceil(widest + 2 * WALL)));
    }
    const taken: MapRect[] = placed.map((n) => {
      const f = footprintOf(modelOf(n), n.layout?.rot ?? 0);
      return { x: cmToM(n.layout?.x ?? 0), z: cmToM(n.layout?.z ?? 0), w: f.w, d: f.d };
    });
    const { at, depth } = pack(sizes, w, taken);
    const d = r.layout ? cmToM(r.layout.d) : Math.max(3, Math.ceil(depth));
    sized.set(r.id, { w, d });
    for (const n of placed) {
      items.push(itemOf(n, modelOf(n), cmToM(n.layout?.x ?? 0), cmToM(n.layout?.z ?? 0)));
    }
    loose.forEach((n, i) => {
      const p = at[i] ?? { x: WALL, z: WALL };
      items.push(itemOf(n, models[i] as MapModelKey, p.x, p.z));
    });
  }
  // Stand only on something that is on the map, can hold it, and doesn't stand on it.
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const it of items) {
    const host = it.on ? byId.get(it.on) : undefined;
    if (!host || host.roomId !== it.roomId || !canHost(host.model) || !canStandOn(it.model))
      it.on = null;
  }
  for (const it of items) {
    const seen = new Set([it.id]);
    let cur = it.on ? byId.get(it.on) : undefined;
    while (cur) {
      if (seen.has(cur.id)) {
        it.on = null;
        break;
      }
      seen.add(cur.id);
      cur = cur.on ? byId.get(cur.on) : undefined;
    }
  }

  for (const level of levels) {
    const here = view.rooms.filter((r) => levelKeyOf(r.levelId) === level.key);
    const taken: MapRect[] = [];
    for (const r of here) {
      if (!r.layout) continue;
      const rect = {
        x: cmToM(r.layout.x),
        z: cmToM(r.layout.z),
        w: cmToM(r.layout.w),
        d: cmToM(r.layout.d),
      };
      taken.push(rect);
      rooms.push(roomOf(r, level.key, rect, r.layout.kind, r.layout.surface));
    }
    const startX = taken.length ? Math.max(...taken.map((t) => t.x + t.w)) + ROOM_GAP : 0;
    let x = startX;
    let z = 0;
    let rowDepth = 0;
    for (const r of here) {
      if (r.layout) continue;
      const size = sized.get(r.id) ?? { w: 4, d: 4 };
      let rect = { x, z, ...size };
      for (let guard = 0; guard < 1000; guard++) {
        if (x > startX && x + size.w > startX + ROW_WIDTH) {
          x = startX;
          z += rowDepth + ROOM_GAP;
          rowDepth = 0;
        }
        rect = { x, z, ...size };
        const hit = taken.find((t) => rectsOverlap(t, rect));
        if (!hit) break;
        x = hit.x + hit.w + ROOM_GAP;
      }
      taken.push(rect);
      x += size.w + ROOM_GAP;
      rowDepth = Math.max(rowDepth, size.d);
      const kind = defaultKind(r.name);
      rooms.push(roomOf(r, level.key, rect, kind, ROOM_KIND_SURFACE[kind]));
    }
  }
  return { levels, rooms, items };
}

/** A room nobody arranged: a garden, balcony or terrace by its name, else a room. */
export function defaultKind(name: string): MapRoomKind {
  const n = name.toLowerCase();
  if (/\b(garden|yard|lawn)\b/.test(n)) return 'garden';
  if (/\bbalcon/.test(n)) return 'balcony';
  if (/\b(terrace|roof|patio|deck)\b/.test(n)) return 'terrace';
  return 'room';
}

function roomOf(
  r: MapView['rooms'][number],
  levelKey: string,
  rect: MapRect,
  kind: MapRoomKind,
  surface: MapSurface,
): Room {
  return {
    id: r.id,
    levelKey,
    name: r.name,
    shortCode: r.shortCode,
    kindKey: r.kindKey,
    ...rect,
    kind,
    surface,
  };
}

function itemOf(n: MapNodeView, model: MapModelKey, x: number, z: number): Item {
  return {
    id: n.id,
    subject: n.subject,
    roomId: n.roomId,
    name: n.name,
    shortCode: n.shortCode,
    model,
    x,
    z,
    rot: n.layout?.rot ?? 0,
    on: n.layout?.hostId ?? null,
    parentId: n.parentId,
    isContainer: n.isContainer,
    quantity: n.quantity,
    auto: n.parentId === n.roomId && (n.subject === 'place' || n.isContainer),
  };
}

// ---------------------------------------------------------------------------------------------
// Arranging
// ---------------------------------------------------------------------------------------------

export const snap = (v: number, s: number) => Math.round(v / s) * s;

/** Keeps a thing inside its room's walls. */
export function clampIn(it: Item, r: Pick<Room, 'w' | 'd'>): void {
  const f = fp(it);
  it.x = Math.min(Math.max(0.12, it.x), Math.max(0.12, r.w - f.w - 0.08));
  it.z = Math.min(Math.max(0.12, it.z), Math.max(0.12, r.d - f.d - 0.08));
}

export const childrenOn = (items: readonly Item[], id: string) => items.filter((i) => i.on === id);

/** Everything standing on `id`, and on those, and so on. */
export function standingOn(items: readonly Item[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const walk = (host: string) => {
    for (const c of childrenOn(items, host)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** Moves a thing and everything on it. */
export function moveBy(items: readonly Item[], it: Item, dx: number, dz: number): void {
  for (const id of [it.id, ...standingOn(items, it.id)]) {
    const t = items.find((i) => i.id === id);
    if (t) {
      t.x += dx;
      t.z += dz;
    }
  }
}

/** A quarter turn about its middle, carrying what stands on it. */
export function turn(items: readonly Item[], rooms: readonly Room[], it: Item): void {
  const f0 = fp(it);
  const cx = it.x + f0.w / 2;
  const cz = it.z + f0.d / 2;
  it.rot = (it.rot + 90) % 360;
  const f = fp(it);
  it.x = cx - f.w / 2;
  it.z = cz - f.d / 2;
  const room = rooms.find((r) => r.id === it.roomId);
  if (!it.on && room) clampIn(it, room);
  for (const c of childrenOn(items, it.id)) {
    c.rot = (c.rot + 90) % 360;
    const cf = fp(c);
    c.x = it.x + f.w / 2 - cf.w / 2;
    c.z = it.z + f.d / 2 - cf.d / 2;
  }
}

/** Whether a rectangle overlaps another room on the level. */
export function overlapsRoom(
  rooms: readonly Room[],
  rect: MapRect,
  skipId: string | null,
  levelKey: string,
): boolean {
  return rooms.some((o) => o.id !== skipId && o.levelKey === levelKey && rectsOverlap(rect, o));
}

/** The room under a point on a level. */
export function roomAt(
  rooms: readonly Room[],
  levelKey: string,
  p: { x: number; z: number },
): Room | undefined {
  return rooms.find(
    (r) =>
      r.levelKey === levelKey && p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d,
  );
}

/** What `it` would stand on at a point: only small things go on a counter, desk, shelf or box. */
export function hostAt(
  plan: Plan,
  levelKey: string,
  p: { x: number; z: number },
  it: Item,
): Item | undefined {
  if (!canStandOn(it.model)) return undefined;
  const mine = new Set([it.id, ...standingOn(plan.items, it.id)]);
  return plan.items.find((h) => {
    if (mine.has(h.id) || !canHost(h.model)) return false;
    const r = plan.rooms.find((x) => x.id === h.roomId);
    if (!r || r.levelKey !== levelKey) return false;
    const f = fp(h);
    return p.x >= r.x + h.x && p.x <= r.x + h.x + f.w && p.z >= r.z + h.z && p.z <= r.z + h.z + f.d;
  });
}

/** Moves a room's things into another room (the map's own coordinates). */
export function rehome(items: readonly Item[], it: Item, from: Room, to: Room): void {
  const ox = from.x - to.x;
  const oz = from.z - to.z;
  for (const id of [it.id, ...standingOn(items, it.id)]) {
    const t = items.find((i) => i.id === id);
    if (!t) continue;
    t.roomId = to.id;
    t.x += ox;
    t.z += oz;
  }
}

/** The arrange session as the PUT's body: centimetres, every floor moved to start at 0. */
export function bodyOf(plan: Plan, version: string | null): LayoutBody {
  const shift = new Map<string, { x: number; z: number }>();
  for (const l of plan.levels) {
    const here = plan.rooms.filter((r) => r.levelKey === l.key);
    if (!here.length) continue;
    shift.set(l.key, {
      x: Math.min(0, ...here.map((r) => r.x)),
      z: Math.min(0, ...here.map((r) => r.z)),
    });
  }
  const cm = (m: number, min: number, max: number) => Math.min(max, Math.max(min, mToCm(m)));
  const rooms = plan.rooms.map((r) => {
    const s = shift.get(r.levelKey) ?? { x: 0, z: 0 };
    return {
      id: r.id,
      x: cm(r.x - s.x, 0, MAP_LIMITS.maxCoord),
      z: cm(r.z - s.z, 0, MAP_LIMITS.maxCoord),
      w: cm(r.w, MAP_LIMITS.minRoom, MAP_LIMITS.maxRoom),
      d: cm(r.d, MAP_LIMITS.minRoom, MAP_LIMITS.maxRoom),
      kind: r.kind,
      surface: r.surface,
    };
  });
  const nodes = plan.items.map((i) => ({
    id: i.id,
    x: cm(i.x, 0, MAP_LIMITS.maxCoord),
    z: cm(i.z, 0, MAP_LIMITS.maxCoord),
    rot: i.rot,
    model: i.model,
    hostId: i.on,
  }));
  return { version, rooms, nodes };
}

// ---------------------------------------------------------------------------------------------
// Contents and pins
// ---------------------------------------------------------------------------------------------

export type Contents = {
  /** Things directly under a room or node (Kept's nearest one above them). */
  under: Map<string, MapThingView[]>;
  /** Places on the map directly under a room or node: walked through, never counted. */
  places: Map<string, string[]>;
  /** The flags of each thing or place, its own. */
  own: Map<string, Set<MapAttentionKind>>;
  /** The attention rows of each thing or place. */
  rows: Map<string, MapAttention[]>;
};

export function contentsOf(view: Pick<MapView, 'things' | 'attention' | 'nodes'>): Contents {
  const under = new Map<string, MapThingView[]>();
  for (const t of view.things) under.set(t.parentId, [...(under.get(t.parentId) ?? []), t]);
  const places = new Map<string, string[]>();
  for (const n of view.nodes) {
    if (n.subject === 'place') places.set(n.parentId, [...(places.get(n.parentId) ?? []), n.id]);
  }
  const own = new Map<string, Set<MapAttentionKind>>();
  const rows = new Map<string, MapAttention[]>();
  for (const a of view.attention) {
    own.set(a.subjectId, (own.get(a.subjectId) ?? new Set()).add(a.kind));
    rows.set(a.subjectId, [...(rows.get(a.subjectId) ?? []), a]);
  }
  return { under, places, own, rows };
}

/** Every thing under a room or node, at any depth. */
export function allUnder(c: Contents, id: string): MapThingView[] {
  const out: MapThingView[] = [];
  const seen = new Set<string>([id]);
  const walk = (at: string) => {
    for (const t of c.under.get(at) ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      walk(t.id);
    }
    for (const p of c.places.get(at) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      walk(p);
    }
  };
  walk(id);
  return out;
}

/** How many things are in a room or node (null for a thing that holds nothing). */
export function countIn(c: Contents, it: Pick<Item, 'id' | 'subject' | 'isContainer' | 'model'>) {
  const n = allUnder(c, it.id).length;
  if (n > 0) return n;
  return it.subject === 'place' || it.isContainer ? 0 : null;
}

/** The flags a node shows: its own and everything's under it. */
export function flagsOf(c: Contents, id: string): MapAttentionKind[] {
  const out = new Set<MapAttentionKind>(c.own.get(id) ?? []);
  for (const t of allUnder(c, id)) for (const k of c.own.get(t.id) ?? []) out.add(k);
  return (['low', 'lent', 'due'] as const).filter((k) => out.has(k));
}
