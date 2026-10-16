import type { SummaryLine } from '@kept/shared';

// An arrange session in words (#140): the stored before/after layouts (map/service.ts LayoutImage)
// compared node by node, one line per change, so the activity row says "Put HD webcam on Corner
// desk" instead of two layouts of JSON. Names are whatever the reader may see (history/service.ts
// resolves them as the caller, under the policies); a node they can't see reads as "a thing" or
// "a place". Shapes, room kinds and floors travel as codes the web says in the reader's language.

/** A layout row as place.arrange stores it (map/service.ts LayoutImage). */
export type ArrangedNode = {
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

/** What the reader may see of a node: its name, and the place it is in (for "in Study"). */
export type NodeName = { name: string; room: string | null };

/** The layout of a place.arrange diff side, or null when it isn't one. */
export function layoutOf(value: unknown): ArrangedNode[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (n): n is ArrangedNode =>
      !!n && typeof n === 'object' && typeof (n as ArrangedNode).id === 'string',
  );
}

const isRoom = (n: ArrangedNode) => n.s === 'place' && n.kind !== null;

/** Every change between two layouts, rooms first, then the rest, each in name order. */
export function arrangeLines(
  before: readonly ArrangedNode[],
  after: readonly ArrangedNode[],
  names: ReadonlyMap<string, NodeName>,
): SummaryLine[] {
  const was = new Map(before.map((n) => [n.id, n]));
  const now = new Map(after.map((n) => [n.id, n]));
  const nameOf = (id: string, s: 'place' | 'thing') =>
    names.get(id)?.name ?? (s === 'place' ? 'a place' : 'a thing');
  const hostName = (id: string) => {
    const host = now.get(id) ?? was.get(id);
    return nameOf(id, host?.s ?? 'thing');
  };
  // A node whose host moved or turned moves with it: that is the host's line, not its own.
  const hostShifted = (n: ArrangedNode) => {
    const a = n.host ? was.get(n.host) : undefined;
    const b = n.host ? now.get(n.host) : undefined;
    return !!a && !!b && (a.x !== b.x || a.z !== b.z || a.rot !== b.rot);
  };

  const ids = [...new Set([...was.keys(), ...now.keys()])];
  const node = (id: string) => (now.get(id) ?? was.get(id)) as ArrangedNode;
  ids.sort((a, b) => {
    const ra = isRoom(node(a)) ? 0 : 1;
    const rb = isRoom(node(b)) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const na = nameOf(a, node(a).s);
    const nb = nameOf(b, node(b).s);
    return na.localeCompare(nb) || (a < b ? -1 : 1);
  });

  const out: SummaryLine[] = [];
  for (const id of ids) {
    const a = was.get(id);
    const b = now.get(id);
    const n = node(id);
    const name = nameOf(id, n.s);
    if (!a && b) {
      if (b.host) out.push({ key: 'map.on', params: { name, host: hostName(b.host) } });
      else {
        const room = isRoom(b) ? null : (names.get(id)?.room ?? null);
        out.push(
          room
            ? { key: 'map.put.room', params: { name, room } }
            : { key: 'map.put', params: { name } },
        );
      }
      continue;
    }
    if (a && !b) {
      out.push({ key: 'map.remove', params: { name } });
      continue;
    }
    if (!a || !b) continue;
    if (a.host !== b.host) {
      if (b.host) out.push({ key: 'map.on', params: { name, host: hostName(b.host) } });
      else if (a.host) out.push({ key: 'map.off', params: { name, host: hostName(a.host) } });
    } else if ((a.x !== b.x || a.z !== b.z) && !(b.host && hostShifted(b))) {
      out.push({ key: 'map.move', params: { name } });
    }
    if (a.rot !== b.rot && !(b.host && a.host === b.host && hostShifted(b))) {
      out.push({ key: 'map.turn', params: { name } });
    }
    if (a.model !== b.model && a.model && b.model) {
      out.push({
        key: 'map.shape',
        params: { name, from: a.model, to: b.model, vocab: 'model' },
      });
    }
    if (a.w !== b.w || a.d !== b.d) out.push({ key: 'map.resize', params: { name } });
    if (a.kind !== b.kind && a.kind && b.kind) {
      out.push({ key: 'map.kind', params: { name, from: a.kind, to: b.kind, vocab: 'kind' } });
    }
    if (a.surface !== b.surface && a.surface && b.surface) {
      out.push({
        key: 'map.floor',
        params: { name, from: a.surface, to: b.surface, vocab: 'surface' },
      });
    }
  }
  return out;
}

/** The ids of the nodes an arrangement touched, by side, for resolving their names. */
export function arrangedIds(diff: unknown): { things: string[]; places: string[] } {
  const layout = (diff as { layout?: { before?: unknown; after?: unknown } } | null)?.layout;
  const all = [...(layoutOf(layout?.before) ?? []), ...(layoutOf(layout?.after) ?? [])];
  const things = new Set<string>();
  const places = new Set<string>();
  // A host is a node of the layout too, so it is named with the rest.
  for (const n of all) (n.s === 'place' ? places : things).add(n.id);
  return { things: [...things], places: [...places] };
}
