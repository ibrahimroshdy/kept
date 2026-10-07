// A small iCalendar writer (RFC 5545; step-4 plan T17): Kept's feed is a few all-day VEVENTs, so
// it is written by hand rather than with a library (the plan's "deliberately not added").
//
// - Lines end in CRLF (§3.1).
// - A content line longer than 75 octets is folded: CRLF then one space, each physical line at
//   most 75 octets (the leading space included), and a fold never splits a UTF-8 sequence (§3.1:
//   "a multi-octet character MUST NOT be split"), so Arabic titles stay whole.
// - TEXT values escape backslash, semicolon, comma and newlines (§3.3.11).

export const CRLF = '\r\n';
const MAX_OCTETS = 75;

/** A TEXT value, escaped (§3.3.11). Carriage returns go; newlines become `\n`. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** One content line, folded at 75 octets without splitting a character. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let octets = 0;
  // After the first line, each continuation starts with a space, which counts.
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (octets + size > limit) {
      out.push(current);
      current = ' ';
      octets = 1;
      limit = MAX_OCTETS;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** A date as an iCalendar DATE, `YYYYMMDD`. */
export function icsDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError(`Not a date: ${iso}`);
  return iso.replaceAll('-', '');
}

/** The day after `iso` (an all-day event's exclusive DTEND). */
export function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A UTC timestamp as an iCalendar DATE-TIME, `YYYYMMDDTHHMMSSZ`. */
export function icsStamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export type AllDayEvent = {
  uid: string;
  /** YYYY-MM-DD. */
  date: string;
  summary: string;
  description?: string | null;
  url?: string | null;
};

export type Calendar = {
  prodId: string;
  name: string;
  /** DTSTAMP for every event: when the feed was written. */
  stamp: Date;
  events: readonly AllDayEvent[];
};

/** The whole VCALENDAR, folded, CRLF throughout, ending with a CRLF. */
export function writeCalendar(cal: Calendar): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${cal.prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(cal.name)}`,
  ];
  const stamp = icsStamp(cal.stamp);
  for (const e of cal.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.date))}`,
      `SUMMARY:${escapeText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    // URL is a URI value (§3.8.4.6), not TEXT: never escaped.
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
