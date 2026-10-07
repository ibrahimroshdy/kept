// What a tool result touched and what an answer cites (D22, D164, D179; plan Q11).
//
// - `locationsIn(output, known)`: the reachable locations a result names (any of their ids as a
//   value anywhere in it). A result is stored by those locations, so losing one redacts it.
// - `seenIn(outputs)`: every thing and place a result showed, with its location (`{id,
//   location_id}` objects: TOOL_DEFS' thingRef and placeRef).
// - `checkLinks(text, seen)`: an answer's `[name](kept:thing/<id>)` / `kept:place/<id>` links
//   to something no tool showed this turn are reduced to their text (never rendered as a link);
//   the rest are kept and their locations cited.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walk(value: unknown, visit: (v: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const v of value) walk(v, visit);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, visit);
}

/** The ids in `known` that appear anywhere in `output` as a string value. */
export function locationsIn(output: unknown, known: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  walk(output, (v) => {
    if (typeof v === 'string' && UUID.test(v) && known.has(v.toLowerCase())) {
      out.add(v.toLowerCase());
    }
  });
  return [...out];
}

/** Things and places the outputs showed: id → its location. */
export function seenIn(outputs: readonly unknown[]): Map<string, string> {
  const seen = new Map<string, string>();
  for (const o of outputs) {
    walk(o, (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const r = v as { id?: unknown; location_id?: unknown };
      if (typeof r.id === 'string' && typeof r.location_id === 'string' && UUID.test(r.id)) {
        seen.set(r.id.toLowerCase(), r.location_id.toLowerCase());
      }
    });
  }
  return seen;
}

const LINK = /\[([^\]\n]{0,300})\]\(\s*kept:(thing|place)\/([^)\s]{1,80})\s*\)/g;

/** The answer with unseen links reduced to their text, and the locations the kept links cite. */
export function checkLinks(
  text: string,
  seen: ReadonlyMap<string, string>,
): { text: string; cited: string[]; stripped: number } {
  const cited = new Set<string>();
  let stripped = 0;
  const out = text.replace(LINK, (whole, label: string, _kind: string, id: string) => {
    const loc = seen.get(id.toLowerCase());
    if (UUID.test(id) && loc) {
      cited.add(loc);
      return whole;
    }
    stripped++;
    return label;
  });
  return { text: out, cited: [...cited], stripped };
}
