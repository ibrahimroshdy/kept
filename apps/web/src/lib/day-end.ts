/**
 * Membership end dates (D46) are picked as a calendar day and stored as an instant. The server
 * takes an ISO 8601 date-time with an offset only (`z.iso.datetime({offset: true})`), so a bare
 * `2026-10-31T23:59:59` is refused. "Until 31 Oct" means the end of that day where the location
 * is, so both directions go through the location's time zone.
 */
import { parseAbsolute, parseDate, toCalendarDate, toZoned } from '@internationalized/date';

/** The last second of `day` (YYYY-MM-DD) in `timeZone`, as a UTC ISO instant. */
export function endOfDay(day: string, timeZone: string): string {
  const next = toZoned(parseDate(day).add({ days: 1 }), timeZone);
  return new Date(next.toDate().getTime() - 1000).toISOString();
}

/** The calendar day (YYYY-MM-DD) that an ISO instant falls on in `timeZone`. */
export function dayOf(iso: string, timeZone: string): string {
  return toCalendarDate(parseAbsolute(iso, timeZone)).toString();
}
