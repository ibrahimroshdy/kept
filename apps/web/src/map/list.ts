/**
 * "What's in <location>" under the map (1.x, D237): the rooms as cards of what stands and lies
 * in them, or what needs attention (low stock, lent out, due soon), with a search, a floor
 * filter and Show more. Pure, so the filters are tested without the map.
 */
import type { MapAttention, MapAttentionKind, MapView } from '@/api/map/types';
import {
  allUnder,
  type Contents,
  flagsOf,
  type Item,
  type Level,
  type Plan,
  type Room,
} from './layout';

export type ListShow = 'room' | 'attention';
export type ListQuery = { q: string; floor: string; show: ListShow };

/** Rows a room card shows before Show more, and an attention card. */
export const ROOM_ROWS = 4;
export const ATTENTION_ROWS = 6;

export type Row = {
  id: string;
  /** A node on the map, or a thing that is only in the list. */
  kind: 'node' | 'thing';
  name: string;
  shortCode: string | null;
  quantity: number;
  /** Things under it (for a node). */
  count: number | null;
  flags: MapAttentionKind[];
  children: Row[];
};

export type RoomCard = { room: Room; level: Level | undefined; total: number; rows: Row[] };

const norm = (s: string) => s.toLocaleLowerCase();
const codeOf = (s: string) => s.replace(/[-‑\s]/g, '').toLocaleUpperCase();

/** Whether a name or short ID matches the words. */
export function matches(q: string, name: string, shortCode: string | null): boolean {
  const words = q.trim();
  if (!words) return true;
  if (norm(name).includes(norm(words))) return true;
  const code = codeOf(words);
  return !!shortCode && code.length >= 2 && shortCode.toUpperCase().includes(code);
}

export function roomCards(
  plan: Plan,
  view: Pick<MapView, 'things'>,
  c: Contents,
  query: ListQuery,
): RoomCard[] {
  const q = query.q.trim();
  const nodes = new Map(plan.items.map((i) => [i.id, i]));
  const thingRow = (id: string, depth: number): Row | null => {
    const t = view.things.find((x) => x.id === id);
    if (!t) return null;
    const kids = depth < 6 ? childRows(t.id, depth + 1) : [];
    const self = matches(q, t.name, t.shortCode);
    if (q && !self && !kids.length) return null;
    return {
      id: t.id,
      kind: 'thing',
      name: t.name,
      shortCode: t.shortCode,
      quantity: t.quantity,
      count: null,
      flags: flagsOf(c, t.id),
      children: kids,
    };
  };
  const nodeRow = (it: Item, depth: number): Row | null => {
    const kids = depth < 6 ? childRows(it.id, depth + 1) : [];
    const self = matches(q, it.name, it.shortCode);
    if (q && !self && !kids.length) return null;
    return {
      id: it.id,
      kind: 'node',
      name: it.name,
      shortCode: it.shortCode,
      quantity: it.quantity,
      count: allUnder(c, it.id).length,
      flags: flagsOf(c, it.id),
      children: kids,
    };
  };
  /** What stands on a node, then what Kept says is in it (nodes inside it as nodes). */
  function childRows(id: string, depth: number): Row[] {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const it of plan.items) {
      if (it.on !== id) continue;
      seen.add(it.id);
      const r = nodeRow(it, depth);
      if (r) out.push(r);
    }
    for (const t of c.under.get(id) ?? []) {
      if (seen.has(t.id)) continue;
      const node = nodes.get(t.id);
      if (node?.on) continue;
      const r = node ? nodeRow(node, depth) : thingRow(t.id, depth);
      if (r) out.push(r);
    }
    return out;
  }

  const cards: RoomCard[] = [];
  for (const level of plan.levels) {
    if (query.floor !== 'all' && query.floor !== level.key) continue;
    for (const room of plan.rooms.filter((r) => r.levelKey === level.key)) {
      const rows: Row[] = [];
      const seen = new Set<string>();
      for (const it of plan.items) {
        if (it.roomId !== room.id || it.on) continue;
        seen.add(it.id);
        const r = nodeRow(it, 0);
        if (r) rows.push(r);
      }
      for (const t of c.under.get(room.id) ?? []) {
        if (seen.has(t.id) || nodes.has(t.id)) continue;
        const r = thingRow(t.id, 0);
        if (r) rows.push(r);
      }
      if (q && !rows.length && !matches(q, room.name, room.shortCode)) continue;
      cards.push({ room, level, total: allUnder(c, room.id).length, rows });
    }
  }
  return cards;
}

export type AttentionRow = {
  attention: MapAttention;
  id: string;
  name: string;
  shortCode: string | null;
  /** Room, then the node it is in, outermost first. */
  where: string[];
  roomId: string;
};

export type AttentionGroup = { kind: MapAttentionKind; rows: AttentionRow[] };

/** Where each thing or node is: its room and the node it is in. */
export function whereOf(plan: Plan, view: Pick<MapView, 'things'>, id: string) {
  const nodes = new Map(plan.items.map((i) => [i.id, i]));
  const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
  const things = new Map(view.things.map((t) => [t.id, t]));
  const path: string[] = [];
  let cur = nodes.get(id)?.parentId ?? things.get(id)?.parentId;
  let roomId: string | null = rooms.has(id) ? id : null;
  for (let guard = 0; cur && guard < 20; guard++) {
    const room = rooms.get(cur);
    if (room) {
      path.unshift(room.name);
      roomId = room.id;
      break;
    }
    const node = nodes.get(cur);
    if (node) {
      path.unshift(node.name);
      cur = node.parentId;
      continue;
    }
    const thing = things.get(cur);
    if (!thing) break;
    path.unshift(thing.name);
    cur = thing.parentId;
  }
  return { path, roomId };
}

export function attentionGroups(
  plan: Plan,
  view: Pick<MapView, 'things' | 'attention'>,
  query: ListQuery,
): AttentionGroup[] {
  const nodes = new Map(plan.items.map((i) => [i.id, i]));
  const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
  const things = new Map(view.things.map((t) => [t.id, t]));
  const out: AttentionGroup[] = (['low', 'lent', 'due'] as const).map((kind) => ({
    kind,
    rows: [],
  }));
  for (const a of view.attention) {
    const subject = nodes.get(a.subjectId) ?? things.get(a.subjectId) ?? rooms.get(a.subjectId);
    if (!subject) continue;
    const { path, roomId } = whereOf(plan, view, a.subjectId);
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room) continue;
    if (query.floor !== 'all' && room.levelKey !== query.floor) continue;
    const shortCode = subject.shortCode;
    if (
      query.q.trim() &&
      !matches(query.q, subject.name, shortCode) &&
      !path.some((p) => matches(query.q, p, null))
    )
      continue;
    out
      .find((g) => g.kind === a.kind)
      ?.rows.push({
        attention: a,
        id: a.subjectId,
        name: subject.name,
        shortCode,
        where: path,
        roomId: room.id,
      });
  }
  return out;
}

/** The summary line: things, rooms and floors, and each flag's count, regardless of filters. */
export function summaryOf(plan: Plan, view: Pick<MapView, 'things' | 'attention' | 'more'>) {
  const count = (k: MapAttentionKind) => view.attention.filter((a) => a.kind === k).length;
  return {
    things: view.things.length + view.more,
    rooms: plan.rooms.length,
    floors: plan.levels.length,
    low: count('low'),
    lent: count('lent'),
    due: count('due'),
  };
}
