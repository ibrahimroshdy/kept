import { describe, expect, it } from 'vitest';
import {
  CSV_LIMITS,
  DATE_FORMATS,
  isMappable,
  MAPPABLE,
  parseCsvDate,
  splitPlacePath,
} from './csv-import.js';

describe('CSV import contract (D73, Q18)', () => {
  it('maps the listed fields and custom.<key>, nothing else', () => {
    expect(MAPPABLE).toContain('place_path');
    expect(MAPPABLE).toContain('ignore');
    expect(MAPPABLE).toContain('own_code');
    expect(MAPPABLE).toHaveLength(22);
    expect(isMappable('name')).toBe(true);
    expect(isMappable('custom.voltage')).toBe(true);
    expect(isMappable('custom.Voltage')).toBe(false);
    expect(isMappable('custom.')).toBe(false);
    expect(isMappable('owner_account_id')).toBe(false);
  });

  it('limits a file to 10,000 rows and 8 MB', () => {
    expect(CSV_LIMITS).toEqual({ rows: 10_000, bytes: 8_000_000 });
  });

  it('splits a place path and drops empty segments', () => {
    expect(splitPlacePath('Garage > Shelf A', '>')).toEqual(['Garage', 'Shelf A']);
    expect(splitPlacePath(' Home / Kitchen // Drawer 2 / ', '/')).toEqual([
      'Home',
      'Kitchen',
      'Drawer 2',
    ]);
    expect(splitPlacePath('المطبخ > الدرج')).toEqual(['المطبخ', 'الدرج']);
    expect(splitPlacePath('  ')).toEqual([]);
  });

  it.each([
    ['2026-09-20', 'YYYY-MM-DD', '2026-09-20'],
    ['20/09/2026', 'DD/MM/YYYY', '2026-09-20'],
    ['9/20/2026', 'MM/DD/YYYY', '2026-09-20'],
    ['20.09.2026', 'DD.MM.YYYY', '2026-09-20'],
    ['20-09-2026', 'DD-MM-YYYY', '2026-09-20'],
    ['2026/09/20', 'YYYY/MM/DD', '2026-09-20'],
    ['٢٠/٠٩/٢٠٢٦', 'DD/MM/YYYY', '2026-09-20'],
    ['31/02/2026', 'DD/MM/YYYY', null],
    ['2026-13-01', 'YYYY-MM-DD', null],
    ['20/09/26', 'DD/MM/YYYY', null],
    ['', 'YYYY-MM-DD', null],
  ] as const)('%s as %s → %s', (value, format, expected) => {
    expect(parseCsvDate(value, format)).toBe(expected);
  });

  it('offers each date format once', () => {
    expect(new Set(DATE_FORMATS).size).toBe(DATE_FORMATS.length);
  });
});
