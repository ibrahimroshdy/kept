/**
 * Field-level three-way merge for a 412 on save (D156). `base` is the version the edit started
 * from, `mine` is the edit, `theirs` is the latest from the server. Per field:
 *   - only they changed it → theirs (applied silently);
 *   - only I changed it → mine;
 *   - both changed it to the same value → that value;
 *   - both changed it to different values → a conflict, which the conflict sheet shows
 *     ("Alfred changed this since you opened it": keep mine, keep theirs, or edit). Until then
 *     `merged` holds mine.
 * Everything not listed in `fields` (row version, computed fields) comes from theirs. A dotted
 * field (`custom.voltage`) addresses one key of a nested object, so two people editing different
 * custom fields never conflict.
 */

export type Conflict = { field: string; mine: unknown; theirs: unknown };
export type MergeResult<T> = { merged: T; conflicts: Conflict[] };

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    cur[key] = next !== null && typeof next === 'object' ? { ...(next as object) } : {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys.at(-1) as string] = value;
}

/** Structural equality for JSON-shaped values (arrays by order, objects by keys). */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // An absent value and null both mean "empty".
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function merge<T extends Record<string, unknown>>(
  base: T,
  mine: T,
  theirs: T,
  fields: readonly string[],
): MergeResult<T> {
  const merged = structuredClone(theirs) as Record<string, unknown>;
  const conflicts: Conflict[] = [];
  for (const field of fields) {
    const b = get(base, field);
    const m = get(mine, field);
    const t = get(theirs, field);
    const iChanged = !same(b, m);
    const theyChanged = !same(b, t);
    if (!iChanged) continue; // theirs is already in `merged`
    set(merged, field, structuredClone(m));
    if (theyChanged && !same(m, t)) conflicts.push({ field, mine: m, theirs: t });
  }
  return { merged: merged as T, conflicts };
}
