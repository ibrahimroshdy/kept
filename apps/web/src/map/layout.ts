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
  canCarry,
  capacityOf,
  carryOf,
  cmToM,
  fitsOn,
  footprintOf,
  guessModel,
  isMapModel,
  levelShort,
  MAP_LIMITS,
  type MapModelKey,
  type MapRect,
  type MapRoomKind,
  type MapSurface,
  mapModel,
  mToCm,
  ROOM_KIND_SURFACE,
  rectsOverlap,
  type ShapeFrom,
  snapStep,
  turnOffset,
  unturnOffset,
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
  /** Why it has its shape, when it was put on the map in this session (D249): from its type or
   * its name, or a guess the card asks about. Never stored; picking a shape clears it. */
  shapeFrom?: ShapeFrom;
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
  // Stand only on something that is on the map, can carry it and has room for it (an arm holds
  // one or two monitors), and doesn't stand on it.
  const byId = new Map(items.map((i) => [i.id, i]));
  const carried = new Map<string, number>();
  for (const it of items) {
    const host = it.on ? byId.get(it.on) : undefined;
    if (!host || host.roomId !== it.roomId || !canCarry(host.model, it.model)) {
      it.on = null;
      continue;
    }
    const n = (carried.get(host.id) ?? 0) + 1;
    if (n > capacityOf(host.model)) it.on = null;
    else carried.set(host.id, n);
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

/** The middle of a thing's footprint, in its room. */
export function centreOf(it: Pick<Item, 'x' | 'z' | 'model' | 'rot'>): { x: number; z: number } {
  const f = fp(it);
  return { x: it.x + f.w / 2, z: it.z + f.d / 2 };
}

/** Moves a thing and everything on it so the thing's middle is at a point. */
function centreAt(items: readonly Item[], it: Item, p: { x: number; z: number }): void {
  const c = centreOf(it);
  moveBy(items, it, p.x - c.x, p.z - c.z);
}

/** Quarter turns a thing and everything on it, as one, about the thing's middle. */
function turnStack(items: readonly Item[], it: Item, quarters: number): void {
  const q = ((quarters % 4) + 4) % 4;
  if (!q) return;
  const c = centreOf(it);
  for (const t of [it, ...standingOn(items, it.id).map((id) => items.find((i) => i.id === id))]) {
    if (!t) continue;
    const tc = centreOf(t);
    let dx = tc.x - c.x;
    let dz = tc.z - c.z;
    for (let i = 0; i < q; i++) [dx, dz] = [-dz, dx];
    t.rot = (t.rot + 90 * q) % 360;
    const f = fp(t);
    t.x = c.x + dx - f.w / 2;
    t.z = c.z + dz - f.d / 2;
  }
}

/** Whether a thing is clipped to a screen's edge or held by an arm: it sits where its holder says
 * and turns only with it. */
export function seated(items: readonly Item[], it: Item): boolean {
  const host = it.on ? items.find((i) => i.id === it.on) : undefined;
  const how = host ? carryOf(host.model) : null;
  return how === 'edge' || how === 'arm';
}

/** A quarter turn about its middle, carrying what stands on it (side by side stays side by side).
 * Something seated on an edge or an arm turns with its holder, not by itself. */
export function turn(items: readonly Item[], rooms: readonly Room[], it: Item): void {
  if (seated(items, it)) return;
  turnStack(items, it, 1);
  const room = rooms.find((r) => r.id === it.roomId);
  if (!it.on && room) {
    const bx = it.x;
    const bz = it.z;
    clampIn(it, room);
    for (const id of standingOn(items, it.id)) {
      const t = items.find((i) => i.id === id);
      if (t) {
        t.x += it.x - bx;
        t.z += it.z - bz;
      }
    }
  }
}

// ---- Facing the screens (#150) ----------------------------------------------------------------

/**
 * The turn most of a room's screens have (a monitor, a TV, a laptop: the models with a screen
 * edge), each counted by its width so a TV outweighs a laptop; null when the room has none. Ties
 * go to the first turn met.
 */
export function screensFacing(items: readonly Item[], roomId: string): number | null {
  const weight = new Map<number, number>();
  for (const it of items) {
    if (it.roomId !== roomId || carryOf(it.model) !== 'edge') continue;
    const r = ((it.rot % 360) + 360) % 360;
    weight.set(r, (weight.get(r) ?? 0) + mapModel(it.model).w);
  }
  let best: number | null = null;
  let most = 0;
  for (const [r, w] of weight) {
    if (w > most + 1e-9) {
      best = r;
      most = w;
    }
  }
  return best;
}

/**
 * The 3D view's turn that looks at a model of this turn from its front, half a quarter to one side
 * as the map always looks (the camera sits towards (sin az, cos az) from what it looks at, and a
 * model's front points at turnOffset(0, 1, rot)). Of the two sides, the one with fewer of a
 * room's walls between the camera and the room (they stand on its −x and −z sides): π/4, the
 * map's usual view, for an unturned screen.
 */
export function facingAz(rot: number): number {
  const front = -(rot * Math.PI) / 180;
  const hidden = (az: number) => Number(Math.sin(az) < -1e-9) + Number(Math.cos(az) < -1e-9);
  const a = front + Math.PI / 4;
  const b = front - Math.PI / 4;
  return hidden(b) < hidden(a) ? b : a;
}

// ---- Holders (#137): putting a thing on a desk, a screen's edge or an arm, and off again ------

/** Metres between things put side by side on a holder. */
const SIDE_GAP = 0.02;

/** Where on a holder a thing's middle goes: `along` metres across it from its middle and, on a
 * top, `depth` metres towards its front; on a screen's edge line, or in front of an arm. */
export function spotOn(host: Item, along: number, depth = 0): { x: number; z: number } {
  const m = mapModel(host.model).mount;
  const c = centreOf(host);
  const o = turnOffset(along, m ? m.z : depth, host.rot);
  return { x: c.x + o.x, z: c.z + o.z };
}

/** Where a thing's middle is in its holder's own frame. */
function localOf(host: Item, it: Item): { x: number; z: number } {
  const hc = centreOf(host);
  const c = centreOf(it);
  return unturnOffset(c.x - hc.x, c.z - hc.z, host.rot);
}

/** A thing's width across its holder once it faces the holder's way. */
const widthAcross = (it: Pick<Item, 'model'>) => mapModel(it.model).w;

/** How many more things a holder takes (an arm one per place; anything else no limit). */
export function roomOn(items: readonly Item[], host: Item, except?: string): number {
  return capacityOf(host.model) - childrenOn(items, host.id).filter((c) => c.id !== except).length;
}

/**
 * Where on a holder a thing goes, in the holder's frame: an arm's first free place; on an edge the
 * free spot along it nearest `near`; on a top the free spot nearest `near` across its middle row,
 * then rows to the front and back. Beside what is there already, overlapping only when nothing
 * else fits. Null when an arm is full.
 */
export function freeSpot(
  items: readonly Item[],
  host: Item,
  it: Pick<Item, 'id' | 'model'>,
  near = 0,
): { along: number; depth: number } | null {
  const m = mapModel(host.model);
  const others = childrenOn(items, host.id).filter((c) => c.id !== it.id);
  if (m.mount?.on === 'arm') {
    const free = m.mount.slots.filter(
      (s) => !others.some((o) => Math.abs(localOf(host, o).x - s) < 0.05),
    );
    if (!free.length) return null;
    const a = [...free].sort((x, y) => Math.abs(x - near) - Math.abs(y - near))[0] ?? 0;
    return { along: a, depth: 0 };
  }
  const mine = mapModel(it.model);
  const hw = mine.w / 2;
  const hd = mine.d / 2;
  const taken = others.map((o) => {
    const at = localOf(host, o);
    const om = mapModel(o.model);
    const turned = (o.rot - host.rot) % 180 !== 0;
    return { ...at, hw: (turned ? om.d : om.w) / 2, hd: (turned ? om.w : om.d) / 2 };
  });
  const g = SIDE_GAP / 2;
  const fits = (x: number, z: number) =>
    taken.every(
      (t) =>
        x + hw + g <= t.x - t.hw ||
        x - hw - g >= t.x + t.hw ||
        z + hd + g <= t.z - t.hd ||
        z - hd - g >= t.z + t.hd,
    );
  const xr = Math.max(0, m.w / 2 - hw);
  const zr = m.mount?.on === 'edge' ? 0 : Math.max(0, m.d / 2 - hd);
  const x0 = Math.min(xr, Math.max(-xr, near));
  const steps = (r: number, from: number) => {
    const out = [from];
    for (let i = 1; i <= Math.ceil((2 * r) / 0.01); i++)
      for (const v of [from + i * 0.01, from - i * 0.01])
        if (v >= -r - 1e-9 && v <= r + 1e-9) out.push(v);
    return out;
  };
  const xs = steps(xr, x0);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // #151: an arm clamps at the back edge (away from the chair, the top's front being +z): in the
  // middle, else a back corner, else anywhere along the back; only then where anything else goes.
  if (clampsAtBack(it.model) && m.top !== undefined) {
    const corners = [-xr, xr].sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    for (const x of [0, ...corners, ...xs])
      if (fits(x, -zr)) return { along: r2(x), depth: r2(-zr) };
  }
  for (const z of steps(zr, 0))
    for (const x of xs)
      if (fits(x, z)) return { along: Math.round(x * 100) / 100, depth: Math.round(z * 100) / 100 };
  return { along: x0, depth: 0 };
}

/** A monitor arm (#151): it clamps at the back edge of a top, facing the top's way. */
export const clampsAtBack = (model: MapModelKey): boolean => carryOf(model) === 'arm';

/** Across a holder only: an arm's free place or an edge's free spot (null when an arm is full). */
export function freeAlong(
  items: readonly Item[],
  host: Item,
  it: Pick<Item, 'id' | 'model'>,
  near = 0,
): number | null {
  return freeSpot(items, host, it, near)?.along ?? null;
}

/** The holders a thing would loop through: itself and everything standing on it. */
const stackOf = (items: readonly Item[], it: Item) => new Set([it.id, ...standingOn(items, it.id)]);

/** Whether `host` may take `it` now: same room, it can carry it, has room, and no loop. */
export function canPutOn(items: readonly Item[], host: Item, it: Item): boolean {
  if (host.id === it.id || host.roomId !== it.roomId) return false;
  if (!canCarry(host.model, it.model) || stackOf(items, it).has(host.id)) return false;
  return it.on === host.id || roomOn(items, host, it.id) > 0;
}

/**
 * Puts a thing (and what is on it) on a holder: facing the holder's way, at a free spot across it
 * (or `along`). Map only: nothing moves in Kept. False when it can't go there.
 */
export function putOn(items: readonly Item[], it: Item, host: Item, along?: number): boolean {
  if (!canPutOn(items, host, it)) return false;
  const at = along === undefined ? freeSpot(items, host, it) : { along, depth: 0 };
  if (at === null) return false;
  turnStack(items, it, (host.rot - it.rot) / 90);
  it.on = host.id;
  centreAt(items, it, spotOn(host, at.along, at.depth));
  return true;
}

/** The thing at the bottom of a stack: what stands on the room's floor. */
export function groundOf(items: readonly Item[], it: Item): Item {
  let cur = it;
  const seen = new Set([it.id]);
  for (;;) {
    const up = cur.on ? items.find((i) => i.id === cur.on) : undefined;
    if (!up || seen.has(up.id)) return cur;
    seen.add(up.id);
    cur = up;
  }
}

/**
 * Takes a thing (and what is on it) off its holder onto the room's floor, next to what its holder
 * stands on: to its side, else in front, behind, or the other side, where nothing stands.
 */
export function takeOff(items: readonly Item[], rooms: readonly Room[], it: Item): void {
  if (!it.on) return;
  const ground = groundOf(items, it);
  it.on = null;
  const room = rooms.find((r) => r.id === it.roomId);
  const g = fp(ground);
  const f = fp(it);
  const gap = 0.05;
  const tries = [
    { x: ground.x + g.w + gap, z: ground.z + g.d / 2 - f.d / 2 },
    { x: ground.x + g.w / 2 - f.w / 2, z: ground.z + g.d + gap },
    { x: ground.x - f.w - gap, z: ground.z + g.d / 2 - f.d / 2 },
    { x: ground.x + g.w / 2 - f.w / 2, z: ground.z - f.d - gap },
  ];
  const mine = stackOf(items, it);
  const floor = items.filter((i) => i.roomId === it.roomId && !i.on && !mine.has(i.id));
  const inside = (p: { x: number; z: number }) =>
    !room ||
    (p.x >= 0.12 && p.z >= 0.12 && p.x + f.w <= room.w - 0.08 && p.z + f.d <= room.d - 0.08);
  const free = (p: { x: number; z: number }) =>
    !floor.some((o) => rectsOverlap({ ...p, w: f.w, d: f.d }, { x: o.x, z: o.z, ...fp(o) }));
  const at = tries.find((p) => inside(p) && free(p)) ?? tries.find(inside) ?? tries[0];
  if (at) moveBy(items, it, at.x - it.x, at.z - it.z);
  if (room) {
    const bx = it.x;
    const bz = it.z;
    clampIn(it, room);
    for (const id of standingOn(items, it.id)) {
      const t = items.find((i) => i.id === id);
      if (t) {
        t.x += it.x - bx;
        t.z += it.z - bz;
      }
    }
  }
}

/** What in its room can carry a thing, for its Put on… list: holders it fits on, with room for
 * it, not the one it is on, by name. */
export function holdersFor(items: readonly Item[], it: Item): Item[] {
  return items
    .filter((h) => h.id !== it.on && fitsOn(h.model, it.model) && canPutOn(items, h, it))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The room's things on nothing yet that a holder can take, for its Add on it list, by name. */
export function addableOn(items: readonly Item[], host: Item): Item[] {
  return items
    .filter(
      (c) =>
        c.roomId === host.roomId &&
        !c.on &&
        c.id !== host.id &&
        fitsOn(host.model, c.model) &&
        canPutOn(items, host, c),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a dragged thing lands on a holder (#137), from where its middle is (`c`, in its room):
 * an arm's nearest free place, a screen edge's line, or a top; across a holder it snaps by its own
 * step from the holder's middle, so things line up on the desk, not on the room's grid. `free`
 * (Alt held) drops it where it is, to the centimetre.
 */
export function dropOn(
  items: readonly Item[],
  it: Item,
  host: Item,
  c: { x: number; z: number },
  free = false,
): void {
  const hc = centreOf(host);
  const local = unturnOffset(c.x - hc.x, c.z - hc.z, host.rot);
  const how = carryOf(host.model);
  if (how === 'arm' || how === 'edge') {
    const a = how === 'arm' ? freeAlong(items, host, it, local.x) : local.x;
    if (a === null) return;
    const m = mapModel(host.model);
    const room = Math.max(0, m.w / 2 - widthAcross(it) / 2);
    const along = how === 'arm' ? a : Math.min(room, Math.max(-room, free ? a : snap(a, 0.01)));
    turnStack(items, it, (host.rot - it.rot) / 90);
    it.on = host.id;
    centreAt(items, it, spotOn(host, Math.round(along * 100) / 100));
    return;
  }
  const step = free ? 0.01 : snapStep(it.model);
  let lx = snap(local.x, step);
  let lz = snap(local.z, step);
  if (clampsAtBack(it.model)) {
    // #151: an arm slides along the back edge only, facing the top's way.
    const hm = mapModel(host.model);
    const im = mapModel(it.model);
    const xr = Math.max(0, hm.w / 2 - im.w / 2);
    lx = Math.min(xr, Math.max(-xr, lx));
    lz = -Math.max(0, hm.d / 2 - im.d / 2);
    turnStack(items, it, (host.rot - it.rot) / 90);
  }
  const p = turnOffset(lx, lz, host.rot);
  it.on = host.id;
  centreAt(items, it, { x: hc.x + p.x, z: hc.z + p.z });
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

/**
 * What `it` would stand on at a point (the map's own coordinates): a holder that can carry it and
 * has room for it (#137), under the point, or for an arm, a free place in front of it. Where
 * several are under the point the highest wins: the monitor on the desk, not the desk.
 */
export function hostAt(
  plan: Plan,
  levelKey: string,
  p: { x: number; z: number },
  it: Item,
): Item | undefined {
  const mine = stackOf(plan.items, it);
  const depth = (h: Item) => {
    let n = 0;
    for (let c = h; c.on && n < 20; n++) {
      const up = plan.items.find((i) => i.id === c.on);
      if (!up) break;
      c = up;
    }
    return n;
  };
  const hits = plan.items.filter((h) => {
    if (mine.has(h.id) || h.roomId !== it.roomId) return false;
    if (!canCarry(h.model, it.model) || (it.on !== h.id && roomOn(plan.items, h, it.id) <= 0))
      return false;
    const r = plan.rooms.find((x) => x.id === h.roomId);
    if (!r || r.levelKey !== levelKey) return false;
    const q = { x: p.x - r.x, z: p.z - r.z };
    const f = fp(h);
    if (q.x >= h.x && q.x <= h.x + f.w && q.z >= h.z && q.z <= h.z + f.d) return true;
    const m = mapModel(h.model).mount;
    if (m?.on !== 'arm') return false;
    const c = fp({ model: it.model, rot: h.rot });
    return m.slots.some((s) => {
      const at = spotOn(h, s);
      return Math.abs(q.x - at.x) <= c.w / 2 && Math.abs(q.z - at.z) <= c.d / 2;
    });
  });
  return hits.sort((a, b) => depth(b) - depth(a))[0];
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
