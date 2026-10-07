import { describe, expect, it } from 'vitest';
import {
  type ConsumptionFill,
  consumption,
  decimalOut,
  displayConsumption,
  milli,
  milliOut,
  perDistance,
  pricePerUnit,
} from './fuel.js';

const fill = (
  day: number,
  amount: string,
  reading: string | null,
  extra: Partial<ConsumptionFill> = {},
): ConsumptionFill => ({
  takenAt: `2026-04-${String(day).padStart(2, '0')}T08:00:00.000Z`,
  amount,
  unit: 'L',
  isFull: true,
  missedBefore: false,
  reading: reading === null ? null : { value: reading },
  ...extra,
});

describe('milli() and friends', () => {
  it.each([
    ['53000.5', 53000500n],
    ['0', 0n],
    ['0.001', 1n],
    ['12.3456', 12345n],
    ['-2.5', -2500n],
  ])('milli(%s) = %s', (s, n) => expect(milli(s)).toBe(n));

  it('writes thousandths back canonically', () => {
    expect(milliOut(53000500n)).toBe('53000.5');
    expect(milliOut(1n)).toBe('0.001');
    expect(milliOut(-2500n)).toBe('-2.5');
    expect(milliOut(7000n)).toBe('7');
    expect(decimalOut('53000.500')).toBe('53000.5');
    expect(decimalOut('53000.000')).toBe('53000');
  });
});

describe('consumption() (Q6)', () => {
  it('full to full, with a partial between: one interval holding both amounts', () => {
    const c = consumption([
      fill(1, '40', '10000'),
      fill(5, '10', '10150', { isFull: false }),
      fill(9, '30', '10500'),
    ]);
    expect(c.intervals).toEqual([
      {
        perHundred: '8',
        unit: 'L',
        amount: '40',
        distance: '500',
        fromAt: '2026-04-01T08:00:00.000Z',
        toAt: '2026-04-09T08:00:00.000Z',
        fills: 2,
      },
    ]);
    expect(c.whyNone).toBeUndefined();
    expect(c.overall?.perHundred).toBe('8');
  });

  it('three full fills with a partial between the first two: two intervals', () => {
    const c = consumption([
      fill(1, '40', '10000'),
      fill(3, '12', '10160', { isFull: false }),
      fill(6, '24', '10480'),
      fill(12, '35', '11000'),
    ]);
    expect(c.intervals.map((i) => [i.amount, i.distance, i.perHundred, i.fills])).toEqual([
      ['36', '480', '7.5', 2],
      ['35', '520', '6.731', 1],
    ]);
    // Together: 71 L over 1,000 km.
    expect(c.overall).toMatchObject({
      amount: '71',
      distance: '1000',
      perHundred: '7.1',
      fills: 3,
    });
  });

  it('a missed fill-up breaks only its own interval', () => {
    const c = consumption([
      fill(1, '40', '10000'),
      fill(5, '30', '10400', { missedBefore: true }),
      fill(9, '32', '10800'),
    ]);
    expect(c.intervals).toHaveLength(1);
    expect(c.intervals[0]).toMatchObject({ amount: '32', distance: '400', perHundred: '8' });
  });

  it('only a missed interval: whyNone is missed_fill', () => {
    const c = consumption([fill(1, '40', '10000'), fill(5, '30', '10400', { missedBefore: true })]);
    expect(c).toEqual({ intervals: [], overall: null, whyNone: 'missed_fill' });
  });

  it('a kWh charge inside a litre interval: mixed_units', () => {
    const c = consumption([
      fill(1, '30', '10000'),
      fill(3, '9.5', '10060', { unit: 'kWh', isFull: false }),
      fill(6, '25', '10400'),
    ]);
    expect(c.whyNone).toBe('mixed_units');
  });

  it('per unit (a plug-in hybrid): charges bound their own intervals', () => {
    const fills = [
      fill(1, '30', '10000'),
      fill(2, '10', '10050', { unit: 'kWh' }),
      fill(4, '10', '10120', { unit: 'kWh' }),
      fill(6, '25', '10400'),
    ];
    const kwh = consumption(fills, { unit: 'kWh' });
    expect(kwh.intervals).toEqual([expect.objectContaining({ unit: 'kWh', perHundred: '14.286' })]);
    expect(consumption(fills, { unit: 'L' }).whyNone).toBe('mixed_units');
  });

  it('a full fill without a reading: no_readings', () => {
    const c = consumption([fill(1, '40', '10000'), fill(5, '30', null)]);
    expect(c.whyNone).toBe('no_readings');
  });

  it('one full fill: too_few_full_fills', () => {
    expect(consumption([fill(1, '40', '10000')]).whyNone).toBe('too_few_full_fills');
    expect(consumption([]).whyNone).toBe('too_few_full_fills');
    expect(
      consumption([fill(1, '40', '10000'), fill(2, '5', '10050', { isFull: false })]).whyNone,
    ).toBe('too_few_full_fills');
  });

  it('a meter replaced in the window: the offset-corrected values give the distance', () => {
    // The new odometer read 120 at the second fill; the caller corrects it with the replacement's
    // offset (52,000), exactly as meters/check.ts does, so the interval is 420 km, not negative.
    const offset = 52000n * 1000n;
    const corrected = (raw: string) => milliOut(milli(raw) + offset);
    const c = consumption([fill(1, '30', '51700'), fill(9, '31.5', corrected('120'))]);
    expect(c.intervals[0]).toMatchObject({ distance: '420', perHundred: '7.5' });
  });

  it('keeps the last `window` usable intervals', () => {
    const fills = Array.from({ length: 8 }, (_, i) => fill(i + 1, '30', String(10000 + i * 400)));
    const c = consumption(fills, { window: 5 });
    expect(c.intervals).toHaveLength(5);
    expect(c.intervals[0]?.fromAt).toBe('2026-04-03T08:00:00.000Z');
    expect(consumption(fills).intervals).toHaveLength(5);
  });

  it('5 L over 72.5 km: 6.9 L/100 km, 34.1 mpg', () => {
    const c = consumption([fill(1, '20', '1000'), fill(2, '5', '1072.5')]);
    const per = c.intervals[0]?.perHundred as string;
    expect(per).toBe('6.897');
    expect(displayConsumption(per, 'L', 'km', 'metric')).toEqual({
      value: '6.9',
      unit: 'L/100 km',
    });
    expect(displayConsumption(per, 'L', 'km', 'imperial')).toEqual({ value: '34.1', unit: 'mpg' });
  });
});

describe('displayConsumption() (Q7)', () => {
  it.each([
    // [perHundred, fuel, distance unit, system, value, unit]
    ['15', 'kWh', 'km', 'metric', '15', 'kWh/100 km'],
    ['15', 'kWh', 'km', 'imperial', '4.1', 'mi/kWh'],
    ['4', 'gal', 'mi', 'imperial', '25', 'mpg'],
    ['4', 'gal', 'mi', 'metric', '9.4', 'L/100 km'],
    ['10', 'L', 'mi', 'metric', '6.2', 'L/100 km'],
    ['150', 'L', 'h', 'metric', '1.5', 'L/h'],
    ['150', 'L', 'h', 'imperial', '1.5', 'L/h'],
  ] as const)('%s %s per 100 %s in %s → %s %s', (per, fuel, dist, units, value, unit) => {
    expect(displayConsumption(per, fuel, dist, units)).toEqual({ value, unit });
  });
});

describe('prices and cost per distance (Q22)', () => {
  it('a fill’s price per unit', () => {
    expect(pricePerUnit({ amount: '40', cost: '740', currency: 'EGP' })).toEqual({
      amount: '18.5',
      currency: 'EGP',
    });
    expect(pricePerUnit({ amount: '40' })).toBeNull();
  });

  it('per distance, one figure per currency, never added together', () => {
    expect(
      perDistance(
        [
          { amount: '1000', currency: 'EGP' },
          { amount: '750', currency: 'EGP' },
          { amount: '20', currency: 'USD' },
        ],
        '1000',
      ),
    ).toEqual([
      { currency: 'EGP', amount: '1.75' },
      { currency: 'USD', amount: '0.02' },
    ]);
    expect(perDistance([{ amount: '29800', currency: 'EGP' }], '11346')).toEqual([
      { currency: 'EGP', amount: '2.6265' },
    ]);
    expect(perDistance([{ amount: '1', currency: 'EGP' }], '0')).toEqual([]);
  });
});
