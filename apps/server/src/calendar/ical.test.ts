import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Calendar, escapeText, foldLine, nextDay, writeCalendar } from './ical.js';

// The iCal writer (RFC 5545; plan T17) against fixtures written out by hand-checked runs:
// CRLF line ends, folding at 75 octets that never splits a UTF-8 sequence (Arabic titles),
// TEXT escaping, all-day DATE events.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/ical',
);
const fixture = (name: string) => readFileSync(path.join(FIXTURES, `${name}.ics`), 'utf8');

const stamp = new Date('2026-10-01T09:12:00Z');
const CALENDARS: Record<string, Calendar> = {
  basic: {
    prodId: '-//Kept//Calendar feed//EN',
    name: 'Kept',
    stamp,
    events: [
      {
        uid: 'schedule-0192f0c3-7c55-7000-8000-000000000001-date:2026-10-12@kept.example.org',
        date: '2026-10-12',
        summary: 'Boiler service · Kitchen',
        description: 'Ground floor · Home',
        url: 'https://kept.example.org/p/0192f0c3-7c55-7000-8000-000000000003',
      },
      {
        uid: 'loan-0192f0c3-7c55-7000-8000-000000000002-date:2026-12-31@kept.example.org',
        date: '2026-12-31',
        summary: 'Due back · Drill; cordless, 18V \\ blue',
        description: 'Garage › Shelf\nsecond line · Home',
        url: null,
      },
    ],
  },
  arabic: {
    prodId: '-//Kept//Calendar feed//EN',
    name: 'Kept',
    stamp,
    events: [
      {
        uid: 'document-0192f0c3-7c55-7000-8000-000000000004-date:2027-02-28@kept.example.org',
        date: '2027-02-28',
        summary: 'عقد الإيجار · بيت العائلة، الطابق الأرضي، المطبخ، الخزانة العلوية الكبيرة',
        description: 'المرآب › الرف العلوي › الصندوق الأزرق الكبير › العلبة الصغيرة · بيت العائلة',
        url: 'https://kept.example.org/loc/0192f0c3-7c55-7000-8000-000000000005',
      },
    ],
  },
};

describe('writeCalendar', () => {
  it.each(Object.keys(CALENDARS))('matches the %s fixture byte for byte', (name) => {
    expect(writeCalendar(CALENDARS[name] as Calendar)).toBe(fixture(name));
  });

  it.each(Object.keys(CALENDARS))(
    '%s: CRLF only, every line ≤ 75 octets, no split character',
    (name) => {
      const bytes = Buffer.from(fixture(name), 'utf8');
      expect(bytes.subarray(-2).toString()).toBe('\r\n');
      const lines = bytes.toString('latin1').split('\r\n');
      for (const line of lines) {
        expect(line).not.toMatch(/[\r\n]/);
        expect(Buffer.from(line, 'latin1').length).toBeLessThanOrEqual(75);
        // Each physical line is valid UTF-8 on its own: nothing was cut mid-character.
        expect(() =>
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(line, 'latin1')),
        ).not.toThrow();
      }
    },
  );
});

describe('the pieces', () => {
  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds at 75 octets, a continuation starting with a space, around two-byte characters', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(line);
    expect(foldLine('SHORT:x')).toBe('SHORT:x');
  });

  it('ends an all-day event the next day, across months, years and a leap day', () => {
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});
