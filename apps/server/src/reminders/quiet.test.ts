import { describe, expect, it } from 'vitest';
import { localClock, minutesOf, notBefore, offsetAt, wallToInstant } from './quiet.js';

// Quiet hours on the person's wall clock (plan T14; Q9; spike V21). Wall times turn into
// instants as Postgres reads them: a gap pushes forward, an overlap takes the later instant
// (docs/spikes/2026-09-30-step4-dst.md's table, checked here against the same instants).

const CAIRO = 'Africa/Cairo';
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Cairo's 2026 changes, found from the tz data rather than typed in: the instants its offset
 * differs from the hour before. */
function transitions(year: number, zone: string): Date[] {
  const out: Date[] = [];
  let prev = offsetAt(Date.UTC(year, 0, 1), zone);
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 3_600_000) {
    const off = offsetAt(t, zone);
    if (off !== prev) out.push(new Date(t));
    prev = off;
  }
  return out;
}

describe('wall clocks (V21)', () => {
  it("finds Cairo's two 2026 changes where the spike did", () => {
    expect(transitions(2026, CAIRO).map(iso)).toEqual([
      '2026-04-23T22:00:00.000Z',
      '2026-10-29T21:00:00.000Z',
    ]);
  });

  it('reads times as Postgres does: a gap pushed forward, an overlap the later instant', () => {
    expect(iso(wallToInstant('2026-04-24', 30, CAIRO))).toBe('2026-04-23T22:30:00.000Z');
    expect(iso(wallToInstant('2026-10-29', 23 * 60 + 30, CAIRO))).toBe('2026-10-29T21:30:00.000Z');
    expect(iso(wallToInstant('2026-07-01', 7 * 60, CAIRO))).toBe('2026-07-01T04:00:00.000Z');
    expect(iso(wallToInstant('2026-01-01', 7 * 60, CAIRO))).toBe('2026-01-01T05:00:00.000Z');
  });

  it("gives the local day as the location's date turns", () => {
    expect(localClock(new Date('2026-04-23T21:59:59Z'), CAIRO).date).toBe('2026-04-23');
    expect(localClock(new Date('2026-04-23T22:00:00Z'), CAIRO)).toEqual({
      date: '2026-04-24',
      minutes: 60,
    });
    expect(localClock(new Date('2026-10-29T21:59:59Z'), CAIRO).date).toBe('2026-10-29');
    expect(localClock(new Date('2026-10-29T22:00:00Z'), CAIRO).date).toBe('2026-10-30');
  });

  it('reads Postgres time values', () => {
    expect(minutesOf('07:00')).toBe(420);
    expect(minutesOf('22:00:00')).toBe(1320);
    expect(minutesOf('24:00')).toBeNull();
    expect(minutesOf(null)).toBeNull();
  });
});

describe('notBefore (Q9)', () => {
  it('holds a message inside 22:00–07:00 until 07:00, across midnight', () => {
    // 23:30 in Berlin in summer (UTC+2) → 07:00 the next morning.
    expect(
      iso(notBefore(new Date('2026-07-10T21:30:00Z'), 'Europe/Berlin', '22:00', '07:00')),
    ).toBe('2026-07-11T05:00:00.000Z');
    // 03:00 → 07:00 the same morning.
    expect(
      iso(notBefore(new Date('2026-07-11T01:00:00Z'), 'Europe/Berlin', '22:00', '07:00')),
    ).toBe('2026-07-11T05:00:00.000Z');
    // 07:00 exactly, and the afternoon: not quiet.
    expect(
      notBefore(new Date('2026-07-11T05:00:00Z'), 'Europe/Berlin', '22:00', '07:00'),
    ).toBeNull();
    expect(
      notBefore(new Date('2026-07-11T13:00:00Z'), 'Europe/Berlin', '22:00', '07:00'),
    ).toBeNull();
  });

  it('handles a window within a day, and none at all', () => {
    const lunch = new Date('2026-07-11T10:30:00Z'); // 12:30 in Berlin
    expect(iso(notBefore(lunch, 'Europe/Berlin', '12:00', '14:00'))).toBe(
      '2026-07-11T12:00:00.000Z',
    );
    expect(notBefore(lunch, 'Europe/Berlin', '13:00', '14:00')).toBeNull();
    expect(notBefore(lunch, 'Europe/Berlin', null, '14:00')).toBeNull();
    expect(notBefore(lunch, 'Europe/Berlin', '12:00', '12:00')).toBeNull();
  });

  it("ends at the right instant across Cairo's changes", () => {
    // 23:30 EET on 23 April; the night loses an hour, and 07:00 is EEST (UTC+3).
    expect(iso(notBefore(new Date('2026-04-23T21:30:00Z'), CAIRO, '22:00', '07:00'))).toBe(
      '2026-04-24T04:00:00.000Z',
    );
    // 23:30 EEST on 29 October (the first 23:30); 07:00 the next day is EET (UTC+2).
    expect(iso(notBefore(new Date('2026-10-29T20:30:00Z'), CAIRO, '22:00', '07:00'))).toBe(
      '2026-10-30T05:00:00.000Z',
    );
    // A window ending inside the spring gap (00:30) ends at 01:30 EEST, as Postgres reads it.
    expect(iso(notBefore(new Date('2026-04-23T20:30:00Z'), CAIRO, '22:00', '00:30'))).toBe(
      '2026-04-23T22:30:00.000Z',
    );
  });
});
