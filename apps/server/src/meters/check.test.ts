import { describe, expect, it } from 'vitest';
import { dailyLimit, decimalOut, METER_VALUE, milli, placeReading } from './check.js';

// check.ts on its own (D26, D52, D112, §3.4, §7.13). The routes' tests (meters.test.ts) cover the
// same rules end to end.

const day = (d: number, h = 12) => new Date(Date.UTC(2026, 8, d, h));
const r = (id: string, value: string, d: number, h = 12) => ({ id, value, takenAt: day(d, h) });
const km = milli('1500');

describe('placeReading', () => {
  const series = [r('a', '1000', 1), r('b', '2000', 10)];

  it('accepts the first reading, and one that rises plausibly', () => {
    expect(placeReading({ value: '5', takenAt: day(1) }, [], [], km).reason).toBeNull();
    const p = placeReading({ value: '2500', takenAt: day(12) }, series, [], km);
    expect(p.reason).toBeNull();
    expect(p.previous?.id).toBe('b');
    expect(p.next).toBeNull();
  });

  it('accepts a late reading that fits between its neighbours in time (D112)', () => {
    const p = placeReading({ value: '1500', takenAt: day(5) }, series, [], km);
    expect(p).toMatchObject({ reason: null, previous: { id: 'a' }, next: { id: 'b' } });
  });

  it('flags a value below the one before, or above the one after', () => {
    expect(placeReading({ value: '1999.999', takenAt: day(11) }, series, [], km).reason).toBe(
      'lower_than_previous',
    );
    expect(placeReading({ value: '2000.001', takenAt: day(5) }, series, [], km).reason).toBe(
      'higher_than_next',
    );
    // Equal is not backwards: a car that stood still.
    expect(placeReading({ value: '2000', takenAt: day(11) }, series, [], km).reason).toBeNull();
  });

  it('lets a replacement offset explain the drop (D52)', () => {
    const replaced = [{ at: day(11), offset: '2000' }];
    // The new unit reads 30 on day 12: 2,030 in the meter's own series.
    expect(placeReading({ value: '30', takenAt: day(12) }, series, replaced, km).reason).toBeNull();
    // Before the replacement, 30 is still backwards.
    expect(placeReading({ value: '30', takenAt: day(10, 18) }, series, replaced, km).reason).toBe(
      'lower_than_previous',
    );
  });

  it('flags a rise faster than the daily limit, counting any gap as at least a day', () => {
    // 1,500 km in two days is fine; 3,001 is not.
    expect(placeReading({ value: '3500', takenAt: day(12) }, series, [], km).reason).toBeNull();
    expect(placeReading({ value: '5001', takenAt: day(12) }, series, [], km).reason).toBe(
      'implausible_jump',
    );
    // An hour after the last one, up to a day's worth.
    expect(placeReading({ value: '3500', takenAt: day(10, 13) }, series, [], km).reason).toBeNull();
    // A late reading whose climb to the next one is too steep.
    const tight = [r('a', '1000', 1), r('b', '9000', 3)];
    expect(placeReading({ value: '1100', takenAt: day(2) }, tight, [], km).reason).toBe(
      'implausible_jump',
    );
    // No limit, no jump check.
    expect(placeReading({ value: '999999', takenAt: day(12) }, series, [], null).reason).toBeNull();
  });

  it('compares exactly at numeric(14,3)', () => {
    const big = [r('a', '99999999999.998', 1)];
    expect(placeReading({ value: '99999999999.999', takenAt: day(2) }, big, [], null).reason).toBe(
      null,
    );
    expect(placeReading({ value: '99999999999.997', takenAt: day(2) }, big, [], null).reason).toBe(
      'lower_than_previous',
    );
  });
});

describe('helpers', () => {
  it('reads the §3.4 defaults by kind and unit', () => {
    expect(dailyLimit({ kind: 'distance', unit: 'km', maxPerDay: null })).toBe(milli('1500'));
    expect(dailyLimit({ kind: 'distance', unit: 'MI', maxPerDay: null })).toBe(milli('932'));
    expect(dailyLimit({ kind: 'hours', unit: 'h', maxPerDay: null })).toBe(milli('24'));
    expect(dailyLimit({ kind: 'custom', unit: 'kWh', maxPerDay: null })).toBeNull();
    expect(dailyLimit({ kind: 'custom', unit: 'kWh', maxPerDay: '40.5' })).toBe(milli('40.5'));
  });

  it('parses and prints thousandths', () => {
    expect(milli('53000.5')).toBe(53_000_500n);
    expect(milli('-12.25')).toBe(-12_250n);
    expect(decimalOut('53000.000')).toBe('53000');
    expect(decimalOut('0.500')).toBe('0.5');
    expect(decimalOut('120')).toBe('120');
    expect(METER_VALUE.test('99999999999.999')).toBe(true);
    expect(METER_VALUE.test('100000000000')).toBe(false);
    expect(METER_VALUE.test('1.2345')).toBe(false);
    expect(METER_VALUE.test('-1')).toBe(false);
  });
});
