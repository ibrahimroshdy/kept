import { v4, v7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { idTimestamp, isV7, newId, withinWindow } from './ids.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const idAt = (msecs: number) => v7({ msecs });

describe('newId', () => {
  it('returns a UUIDv7 stamped with the current time', () => {
    const before = Date.now();
    const id = newId();
    expect(isV7(id)).toBe(true);
    expect(idTimestamp(id)).toBeGreaterThanOrEqual(before);
    expect(idTimestamp(id)).toBeLessThanOrEqual(Date.now());
  });

  it('returns distinct ids', () => {
    expect(new Set(Array.from({ length: 100 }, newId)).size).toBe(100);
  });
});

describe('isV7', () => {
  it('accepts a v7 id in either case', () => {
    const id = idAt(NOW);
    expect(isV7(id)).toBe(true);
    expect(isV7(id.toUpperCase())).toBe(true);
  });

  it('rejects a v4 id, a malformed string and the nil uuid', () => {
    expect(isV7(v4())).toBe(false);
    expect(isV7('not-a-uuid')).toBe(false);
    expect(isV7('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('idTimestamp', () => {
  it('reads the 48-bit millisecond timestamp', () => {
    expect(idTimestamp(idAt(NOW))).toBe(NOW);
  });
});

describe('withinWindow (±7 days, §7.7)', () => {
  it('accepts an id 6 days old and one 6 days ahead', () => {
    expect(withinWindow(idAt(NOW - 6 * DAY), NOW)).toBe(true);
    expect(withinWindow(idAt(NOW + 6 * DAY), NOW)).toBe(true);
  });

  it('rejects an id 8 days old and one 8 days ahead', () => {
    expect(withinWindow(idAt(NOW - 8 * DAY), NOW)).toBe(false);
    expect(withinWindow(idAt(NOW + 8 * DAY), NOW)).toBe(false);
  });

  it('accepts the exact edges of the window', () => {
    expect(withinWindow(idAt(NOW - 7 * DAY), NOW)).toBe(true);
    expect(withinWindow(idAt(NOW + 7 * DAY), NOW)).toBe(true);
  });

  it('honours a custom window', () => {
    expect(withinWindow(idAt(NOW - 2 * DAY), NOW, 1)).toBe(false);
  });

  it('rejects a v4 id', () => {
    expect(withinWindow(v4(), NOW)).toBe(false);
  });
});
