/**
 * Where a capture lands, and how the place chip names it (screens §5 "Capture", §8; D153, D194).
 *
 * The default, in order: the box a label or link put in view (`into`), the place asked for
 * ("Capture here"), the nearby location when "Suggest where I am" is on, else the location last
 * captured into, else Personal; in that location the last place used there, else its Unplaced
 * area. A **new home** (no things yet, and rooms to choose from) doesn't quietly default to
 * Unplaced: the screen opens the room grid (D194).
 *
 * Everything here reads the phone's snapshot, so it works offline.
 */
import type { SnapLocation, SnapPlace, SnapThing } from '@kept/shared';
import { can } from '@kept/shared';
import type { OfflineStore } from '@/offline/store';
import type { Target } from './enqueue';

/** Why the chip shows what it shows: its second line ("Nearby · tap to change"). */
export type TargetWhy = 'nearby' | 'last' | 'scanned' | 'chosen' | 'default';

export type ChipTarget = Target & {
  why: TargetWhy;
  /** The container's name when the target is a box. */
  containerName?: string | null;
};

/** Locations where this person can capture (members and above, `things.edit`). */
export const writable = (locations: readonly SnapLocation[]) =>
  locations.filter((l) => can(l.role, 'things.edit'));

/** The names from the location's root down to `placeId`. */
export function placePath(places: readonly SnapPlace[], placeId: string | null): SnapPlace[] {
  const byId = new Map(places.map((p) => [p.id, p]));
  const out: SnapPlace[] = [];
  const seen = new Set<string>();
  for (let cur = placeId ? byId.get(placeId) : undefined; cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Depth-first, in the snapshot's order, Unplaced first: the picker's rows. */
export function flattenPlaces(places: readonly SnapPlace[]): { place: SnapPlace; depth: number }[] {
  const live = places.filter((p) => !p.deleted);
  const ids = new Set(live.map((p) => p.id));
  const kids = new Map<string | null, SnapPlace[]>();
  for (const p of live) {
    const parent = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const order = (a: SnapPlace, b: SnapPlace) =>
    Number(b.isUnplaced) - Number(a.isUnplaced) || a.sort - b.sort || a.name.localeCompare(b.name);
  const out: { place: SnapPlace; depth: number }[] = [];
  const walk = (p: SnapPlace, depth: number) => {
    out.push({ place: p, depth });
    for (const c of (kids.get(p.id) ?? []).sort(order)) walk(c, depth + 1);
  };
  for (const r of (kids.get(null) ?? []).sort(order)) walk(r, 0);
  return out;
}

/** The rooms offered on a new home's first capture: its top-level places (D194). */
export const roomsOf = (places: readonly SnapPlace[]) =>
  places
    .filter((p) => !p.deleted && !p.isUnplaced && p.parentId === null)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

/** A location with no things in any of its places yet. */
export async function isNewHome(store: OfflineStore, places: readonly SnapPlace[]) {
  for (const p of places) if ((await store.contentsOf({ placeId: p.id })).length > 0) return false;
  return true;
}

// ----- the last place used, per location (a per-device convenience) --------------------------

const LAST = 'kept.capture.last';
type Last = { locationId?: string; places?: Record<string, string> };

function readLast(): Last {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Last) : {};
  } catch {
    return {};
  }
}

export function lastLocationId(): string | undefined {
  return readLast().locationId;
}
export function lastPlaceIn(locationId: string): string | undefined {
  return readLast().places?.[locationId];
}
export function rememberTarget(t: Target): void {
  const last = readLast();
  const places = { ...(last.places ?? {}) };
  if (t.placeId) places[t.locationId] = t.placeId;
  try {
    localStorage.setItem(LAST, JSON.stringify({ locationId: t.locationId, places }));
  } catch {
    // No storage: the chip starts from Personal next time.
  }
}

// ----- the default ----------------------------------------------------------------------------

export type DefaultInput = {
  locations: readonly SnapLocation[];
  placesOf: (locationId: string) => readonly SnapPlace[];
  personalLocationId: string | null;
  /** The nearby location (D153), when suggestions are on and one is in range. */
  nearby?: SnapLocation | null;
  /** A box to capture into ("Capture into Box 3", or a link's `into`). */
  into?: SnapThing | null;
  /** A place asked for ("Capture here"). */
  placeId?: string | null;
};

export function defaultTarget(input: DefaultInput): ChipTarget | null {
  const usable = writable(input.locations);
  const byId = new Map(usable.map((l) => [l.id, l]));
  if (input.into && byId.has(input.into.locationId))
    return {
      locationId: input.into.locationId,
      placeId: null,
      containerId: input.into.id,
      containerName: input.into.name,
      why: 'scanned',
    };
  const asked = input.placeId;
  if (asked) {
    const l = usable.find((x) => input.placesOf(x.id).some((p) => p.id === asked && !p.deleted));
    if (l) return { locationId: l.id, placeId: asked, containerId: null, why: 'chosen' };
  }
  const nearby = input.nearby && byId.get(input.nearby.id);
  const last = lastLocationId();
  const loc =
    nearby ??
    (last ? byId.get(last) : undefined) ??
    (input.personalLocationId ? byId.get(input.personalLocationId) : undefined) ??
    usable[0];
  if (!loc) return null;
  const places = input.placesOf(loc.id);
  const lastPlace = lastPlaceIn(loc.id);
  const known = lastPlace && places.some((p) => p.id === lastPlace && !p.deleted);
  const unplaced = places.find((p) => p.isUnplaced)?.id ?? (loc.unplacedPlaceId || null);
  return {
    locationId: loc.id,
    placeId: known ? (lastPlace as string) : unplaced,
    containerId: null,
    why: nearby ? 'nearby' : known ? 'last' : 'default',
  };
}
