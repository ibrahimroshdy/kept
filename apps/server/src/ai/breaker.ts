/**
 * The per-key circuit breaker (L45; engineering spec §3.5, §7.15 "Per key"). A pure state
 * machine: the Pacer port stores the state (in memory here, `ai_breakers` through the
 * `kept.ai_trip` doors with T6).
 *
 * - A 429 or a quota error trips until `retry-after`, else 60 s; each consecutive trip doubles
 *   that, up to one hour. A success resets the count.
 * - 401 or 403: `auth`, until the key is replaced (`clearAuth`, T9).
 * - Three 5xx, timeouts, network failures or errors inside a 200 within 5 minutes:
 *   `provider_down` for 5 minutes.
 * While tripped, `callModel` answers `paused` without calling.
 */

export type BreakerReason = 'rate_limited' | 'quota' | 'auth' | 'provider_down';

export type BreakerState = {
  reason: BreakerReason | null;
  until: Date | null;
  /** Consecutive 429/quota trips, for the doubling. */
  trips: number;
  /** Times (ms) of recent transient failures, within the 5-minute window. */
  recentErrors: number[];
};

export type BreakerSignal =
  | { kind: 'ok' }
  | { kind: 'rate_limited' | 'quota'; retryAfterMs: number | null }
  | { kind: 'auth' }
  | { kind: 'transient' };

/** "Until the key is replaced": Postgres `infinity` in `ai_breakers`. */
export const FOREVER = new Date(8.64e15);
export const DEFAULT_TRIP_MS = 60_000;
export const MAX_TRIP_MS = 3_600_000;
export const DOWN_WINDOW_MS = 5 * 60_000;
export const DOWN_AFTER = 3;
export const DOWN_FOR_MS = 5 * 60_000;

export const CLOSED: BreakerState = Object.freeze({
  reason: null,
  until: null,
  trips: 0,
  recentErrors: [],
}) as BreakerState;

/** The open trip, or null when calls may go. */
export function trippedAt(
  state: BreakerState | null | undefined,
  now: Date,
): { reason: BreakerReason; until: Date } | null {
  if (!state?.reason || !state.until) return null;
  return state.until.getTime() > now.getTime()
    ? { reason: state.reason, until: state.until }
    : null;
}

export function nextBreaker(
  state: BreakerState | null | undefined,
  signal: BreakerSignal,
  now: Date,
): BreakerState {
  const s = state ?? CLOSED;
  const t = now.getTime();
  switch (signal.kind) {
    case 'ok':
      return { ...s, trips: 0, recentErrors: [] };
    case 'rate_limited':
    case 'quota': {
      const trips = s.trips + 1;
      const base = signal.retryAfterMs ?? DEFAULT_TRIP_MS;
      const ms = Math.min(base * 2 ** (trips - 1), MAX_TRIP_MS);
      return { reason: signal.kind, until: new Date(t + ms), trips, recentErrors: s.recentErrors };
    }
    case 'auth':
      return { ...s, reason: 'auth', until: FOREVER };
    case 'transient': {
      const recent = [...s.recentErrors.filter((e) => t - e < DOWN_WINDOW_MS), t];
      if (recent.length >= DOWN_AFTER) {
        return {
          ...s,
          reason: 'provider_down',
          until: new Date(t + DOWN_FOR_MS),
          recentErrors: [],
        };
      }
      return { ...s, recentErrors: recent };
    }
  }
}

/** A replaced key clears an `auth` trip (T9); other trips run their course. */
export function clearAuth(state: BreakerState | null | undefined): BreakerState {
  const s = state ?? CLOSED;
  return s.reason === 'auth' ? { ...s, reason: null, until: null } : s;
}
