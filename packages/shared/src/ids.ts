import { v7 } from 'uuid';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** A new UUIDv7: time-ordered, so ids sort by creation and index well. */
export function newId(): string {
  return v7();
}

/** True for a well-formed UUIDv7 (version 7, RFC 9562 variant). */
export function isV7(id: string): boolean {
  return V7.test(id);
}

/** The Unix-epoch milliseconds in a UUIDv7's first 48 bits. Only meaningful when isV7(id). */
export function idTimestamp(id: string): number {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/**
 * True when `id` is a UUIDv7 stamped within ± `days` of `now` (§7.7: client-supplied ids are
 * accepted only inside a 7-day window either side). The edges count as inside.
 */
export function withinWindow(id: string, now: number = Date.now(), days = 7): boolean {
  if (!isV7(id)) return false;
  return Math.abs(idTimestamp(id) - now) <= days * DAY_MS;
}
