/**
 * "Suggest where I am" (D153; plan T25; V30). Opening capture compares the phone's position with
 * the coordinates of the person's locations **on the device**: within a location's radius
 * (`suggestRadiusM`, 150 m by default), that location is suggested. The position is never sent,
 * stored or logged: this module has no network access and keeps nothing but the on/off choice.
 *
 * The permission prompt appears only when the person turns suggestions on (D153). The on/off
 * choice is the person's, on the server (`/me`'s `profile.suggestLocation`, PATCH /me; T19); this
 * device keeps a copy so capture knows it offline, and adopts the server's when /me loads.
 */
import type { SnapLocation } from '@kept/shared';

export type Position = { latitude: number; longitude: number };

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceM(a: Position, b: Position): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest location with coordinates, if the phone is within its radius. */
export function nearestLocation(
  at: Position,
  locations: readonly SnapLocation[],
): SnapLocation | null {
  let best: { loc: SnapLocation; d: number } | null = null;
  for (const loc of locations) {
    if (loc.latitude === undefined || loc.longitude === undefined) continue;
    const d = distanceM(at, { latitude: loc.latitude, longitude: loc.longitude });
    if (d <= loc.suggestRadiusM && (!best || d < best.d)) best = { loc, d };
  }
  return best?.loc ?? null;
}

export type Geo = Pick<Geolocation, 'getCurrentPosition'>;

export function deviceGeo(): Geo | null {
  return typeof navigator !== 'undefined' && navigator.geolocation ? navigator.geolocation : null;
}

export type PositionResult =
  | { ok: true; position: Position }
  | { ok: false; reason: 'unavailable' | 'denied' | 'failed' };

/** One reading, coarse is fine; nothing is watched and nothing is kept. */
export function currentPosition(geo: Geo | null = deviceGeo()): Promise<PositionResult> {
  if (!geo) return Promise.resolve({ ok: false, reason: 'unavailable' });
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (p) =>
        resolve({
          ok: true,
          position: { latitude: p.coords.latitude, longitude: p.coords.longitude },
        }),
      (e) => resolve({ ok: false, reason: e.code === 1 ? 'denied' : 'failed' }),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
  });
}

const PREF = 'kept.capture.suggestWhere';

export function suggestWhereOn(): boolean {
  try {
    return localStorage.getItem(PREF) === '1';
  } catch {
    return false;
  }
}

export function setSuggestWhere(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF, '1');
    else localStorage.removeItem(PREF);
  } catch {
    // No storage: suggestions stay off, which is the default.
  }
}
