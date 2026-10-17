/**
 * The way each room was last seen on this device (#150): the 3D view's turn when someone turned it
 * inside a room, so the room opens that way next time. A convenience in local storage: without it
 * (a private window, storage off) a room opens facing its screens.
 */

const KEY = 'kept.map.turns';
/** Rooms remembered at most; the oldest go first. */
const MAX = 200;

const TAU = Math.PI * 2;
const norm = (az: number) => Math.round((((az % TAU) + TAU) % TAU) * 1e4) / 1e4;

function readAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The turn a room was last left at here, or null. */
export function readTurn(roomId: string): number | null {
  const v = readAll()[roomId];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Remembers a room's turn (radians), newest last. */
export function writeTurn(roomId: string, az: number): void {
  if (!Number.isFinite(az)) return;
  const all = readAll();
  delete all[roomId];
  all[roomId] = norm(az);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Remembering the turn is a convenience: the room still opens facing its screens.
  }
}

/** `want`, a whole number of turns away so the camera takes the short way round from `from`. */
export function nearestTurn(from: number, want: number): number {
  return want + Math.round((from - want) / TAU) * TAU;
}
