import { describe, expect, it } from 'vitest';
import { matchSchedules, reconcileTotal, significantWords } from './services.js';

const one = (name: string, description: string) =>
  matchSchedules([{ id: 's', name }], [{ description }]).length === 1;

describe('matchSchedules() (Q13)', () => {
  it.each([
    ['Oil & filter', 'Oil filter', true],
    ['Oil & filter', 'Engine oil 5W-30', false],
    ['Oil & filter', 'Oil and filter change', true],
    ['Tyre rotation', 'tyre rotation, 4 wheels', true],
    ['Tyre rotation', 'Tyres rotated', false],
    ['Brake fluid', 'Brake fluid flush (DOT 4)', true],
    ['Air filter', 'Cabin filter', false],
    ['Oil change', 'OIL CHANGE', true],
    ['تغيير الزيت', 'زيت محرك وتغيير', true],
    ['تغيير الزيت', 'فلتر هواء', false],
    ['فلتر الهواء', 'تغيير فلتر هواء', true],
  ])('%s ↔ %s: %s', (name, line, matches) => {
    expect(one(name, line)).toBe(matches);
  });

  it('needs every word on one line, not across lines', () => {
    expect(
      matchSchedules(
        [{ id: 'oil', name: 'Oil & filter' }],
        [{ description: 'Engine oil 5W-30' }, { description: 'Filter' }],
      ),
    ).toEqual([]);
  });

  it('returns the matching ids in the schedules’ order; a name with no significant word never matches', () => {
    const schedules = [
      { id: 'rot', name: 'Tyre rotation' },
      { id: 'ac', name: 'AC' },
      { id: 'oil', name: 'Oil & filter' },
    ];
    const lines = [{ description: 'Oil filter' }, { description: 'Tyre rotation' }];
    expect(matchSchedules(schedules, lines)).toEqual(['rot', 'oil']);
    expect(significantWords('AC')).toEqual([]);
    expect(significantWords('Oil & the filter')).toEqual(['oil', 'filter']);
  });
});

describe('reconcileTotal() (±1%)', () => {
  const lines = [
    { quantity: '4', unitCost: '250' },
    { quantity: null, unitCost: '450.5' },
  ];

  it('ok within 1%, flagged beyond it', () => {
    expect(reconcileTotal('1450.5', lines)).toEqual({ result: 'ok', sum: '1450.5' });
    expect(reconcileTotal('1464', lines)).toEqual({ result: 'ok', sum: '1450.5' });
    expect(reconcileTotal('1470', lines)).toEqual({ result: 'flag', sum: '1450.5' });
    expect(reconcileTotal('1430', lines).result).toBe('flag');
  });

  it('the sum when the total is omitted', () => {
    expect(reconcileTotal(undefined, lines)).toEqual({ result: 'ok', sum: '1450.5' });
    expect(reconcileTotal('', [{ quantity: '1.5', unitCost: '10.25' }])).toEqual({
      result: 'ok',
      sum: '15.375',
    });
  });

  it('nothing to reconcile when a line has no cost, or there are no lines', () => {
    expect(reconcileTotal('100', [{ quantity: '1', unitCost: null }, ...lines])).toEqual({
      result: 'ok',
      sum: null,
    });
    expect(reconcileTotal('100', [])).toEqual({ result: 'ok', sum: null });
  });
});
