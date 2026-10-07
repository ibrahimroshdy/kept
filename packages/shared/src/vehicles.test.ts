import { describe, expect, it } from 'vitest';
import { BUILTIN_TYPES } from './builtin-types.js';
import { milli, milliOut } from './fuel.js';
import {
  ADVICE_DAYS,
  COST_CATEGORIES,
  distanceBetween,
  MIN_SPAN_DAYS,
  NUDGE_DAYS_DEFAULT,
  RATE_WINDOW_DAYS,
  readingAdvice,
  STARTER_KEYS,
  STARTER_SCHEDULES,
  starterInterval,
  UNKNOWN_DAYS,
  VEHICLE_TYPE_KEY,
} from './vehicles.js';

const day = (d: string) => `2026-${d}T12:00:00.000Z`;

describe('vehicle constants (D52, D188, Q8)', () => {
  it('match the spec', () => {
    expect([
      RATE_WINDOW_DAYS,
      MIN_SPAN_DAYS,
      ADVICE_DAYS,
      UNKNOWN_DAYS,
      NUDGE_DAYS_DEFAULT,
    ]).toEqual([90, 7, 30, 60, 30]);
    expect(COST_CATEGORIES).toEqual(['fuel', 'service', 'fees']);
  });

  it('the vehicle key is a built-in type with an odometer', () => {
    const vehicle = BUILTIN_TYPES.find((t) => t.key === VEHICLE_TYPE_KEY);
    expect(vehicle?.defaultMeter).toEqual({ kind: 'distance', unit: 'km' });
  });

  it.each([
    [null, 'none'],
    [0, 'fresh'],
    [29, 'fresh'],
    [30, 'stale'],
    [34, 'stale'],
    [59, 'stale'],
    [60, 'unknown'],
    [70, 'unknown'],
  ] as const)('a reading %s days old: %s', (age, advice) => {
    expect(readingAdvice(age)).toBe(advice);
  });
});

describe('starter schedules (§3.4, Q25)', () => {
  it('are the four, with their intervals', () => {
    expect(STARTER_SCHEDULES.map((s) => s.key)).toEqual([...STARTER_KEYS]);
    expect(STARTER_SCHEDULES.map((s) => [s.everyKm, s.everyMonths])).toEqual([
      ['10000', 12],
      ['10000', 12],
      [null, 24],
      ['20000', 24],
    ]);
  });

  it('keep their distance only on a km odometer', () => {
    const oil = STARTER_SCHEDULES[0] as (typeof STARTER_SCHEDULES)[number];
    expect(starterInterval(oil, { kind: 'distance', unit: 'km' })).toEqual({
      everyMonths: 12,
      everyUnits: '10000',
    });
    expect(starterInterval(oil, { kind: 'distance', unit: 'mi' })).toEqual({
      everyMonths: 12,
      everyUnits: null,
    });
    expect(starterInterval(oil, { kind: 'hours', unit: 'h' }).everyUnits).toBeNull();
    expect(starterInterval(oil, null).everyUnits).toBeNull();
  });
});

describe('distanceBetween()', () => {
  const series = [
    { value: '50000', takenAt: day('04-01') },
    { value: '51000', takenAt: day('04-11') },
    { value: '53000', takenAt: day('05-01') },
  ];

  it('interpolates between the readings on both sides of each end', () => {
    // 04-06 is halfway to 04-11 (50,500); 04-21 halfway to 05-01 (52,000).
    expect(distanceBetween(series, day('04-06'), day('04-21'))).toBe('1500');
    expect(distanceBetween(series, day('04-01'), day('05-01'))).toBe('3000');
  });

  it('never extrapolates: a period past the last reading is clipped to it', () => {
    expect(distanceBetween(series, day('04-21'), day('06-30'))).toBe('1000');
    expect(distanceBetween(series, day('03-01'), day('04-11'))).toBe('1000');
    expect(distanceBetween(series, day('05-02'), day('06-30'))).toBeNull();
  });

  it('a meter replaced inside it: offset-corrected values run on', () => {
    // A new odometer at 04-11 read 0 and then 2,000; the replacement's offset (51,000) corrects it.
    const offset = milli('51000');
    const corrected = (raw: string) => milliOut(milli(raw) + offset);
    const replaced = [
      { value: '50000', takenAt: day('04-01') },
      { value: corrected('0'), takenAt: day('04-11') },
      { value: corrected('2000'), takenAt: day('05-01') },
    ];
    expect(distanceBetween(replaced, day('04-06'), day('04-21'))).toBe('1500');
  });

  it('needs two readings', () => {
    expect(
      distanceBetween([series[0] as (typeof series)[number]], day('03-01'), day('06-01')),
    ).toBe(null);
    expect(distanceBetween([], day('03-01'), day('06-01'))).toBeNull();
  });

  it('takes Date instants and readings in any order', () => {
    const shuffled = [series[2], series[0], series[1]] as typeof series;
    expect(distanceBetween(shuffled, new Date(day('04-06')), new Date(day('04-21')))).toBe('1500');
  });
});
