// Quiet hours and wall-clock times (plan T14; D29, D122; spike V21, docs/spikes/2026-09-30-
// step4-dst.md). A person's quiet hours and digest time are wall-clock times in their own zone;
// an overdue item that falls inside their quiet hours waits for the end (Q9). Turning a wall time
// into an instant follows Postgres, so the server never has two readings of one time:
// - a time that doesn't exist (the spring gap, 00:30 on 24 April 2026 in Cairo) is pushed
//   forward by the gap: read with the offset in force before it (00:30 EET = 01:30 EEST);
// - a time that happens twice (the autumn overlap, 23:30 on 29 October 2026 in Cairo) is the
//   second, later one.

const MINUTE = 60_000;
const DAY = 86_400_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at `instant`, as the milliseconds of that wall time read as UTC. */
function wallMs(instant: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
}

/** The zone's offset from UTC at `instant`, in milliseconds (Cairo in summer: +3 h). */
export function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallMs(whole, timeZone) - whole;
}

/** The local date (`YYYY-MM-DD`) and minutes past midnight in `timeZone` at `instant`. */
export function localClock(instant: Date, timeZone: string): { date: string; minutes: number } {
  const wall = wallMs(instant.getTime(), timeZone);
  const d = new Date(wall);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/**
 * The instant the wall clock in `timeZone` reads `date` `minutes` (Postgres's reading: a gap
 * pushes forward, an overlap takes the later instant).
 */
export function wallToInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + minutes * MINUTE;
  const offsets = new Set([offsetAt(wall - DAY, timeZone), offsetAt(wall + DAY, timeZone)]);
  const fits = [...offsets]
    .map((o) => wall - o)
    .filter((instant) => wallMs(instant, timeZone) === wall)
    .sort((a, b) => b - a);
  const later = fits[0];
  if (later !== undefined) return new Date(later);
  // In the gap: read with the offset in force before it, which lands past the gap.
  return new Date(wall - offsetAt(wall - DAY, timeZone));
}

/** `HH:MM` or `HH:MM:SS` (a Postgres `time`) as minutes past midnight; null for anything else. */
export function minutesOf(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/**
 * When an immediate message may go out: null now, or the end of the person's quiet hours when
 * `now` falls inside them. The window is `[quietFrom, quietTo)` on their wall clock, and may cross
 * midnight (22:00–07:00). No window (either end unset, or both equal): null.
 */
export function notBefore(
  now: Date,
  timeZone: string,
  quietFrom: string | null | undefined,
  quietTo: string | null | undefined,
): Date | null {
  const from = minutesOf(quietFrom);
  const to = minutesOf(quietTo);
  if (from === null || to === null || from === to) return null;
  const { date, minutes } = localClock(now, timeZone);
  let endDate: string;
  if (from < to) {
    if (minutes < from || minutes >= to) return null;
    endDate = date;
  } else if (minutes >= from) {
    endDate = addDays(date, 1);
  } else if (minutes < to) {
    endDate = date;
  } else {
    return null;
  }
  const end = wallToInstant(endDate, to, timeZone);
  return end.getTime() > now.getTime() ? end : null;
}
