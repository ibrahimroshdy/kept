import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsClamped,
  CLAIM_STATUSES,
  CLAIM_TRANSITIONS,
  CLOSED_CLAIM_STATUSES,
  canTransitionClaim,
  coverage,
  type ScheduleRule,
  scheduleNext,
  UNITS_LEAD_DIVISOR,
  warrantyEnds,
} from './household.js';
import { LEAD_DEFAULTS } from './reminders.js';

describe('addMonthsClamped() (Q27)', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-10-01', 24, '2028-10-01'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2028-02-29', 48, '2032-02-29'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-01-15', -13, '2024-12-15'],
    ['2026-05-10', 0, '2026-05-10'],
  ])('%s + %i months = %s', (from, months, to) => {
    expect(addMonthsClamped(from, months)).toBe(to);
  });

  it('refuses a malformed date', () => {
    expect(() => addMonthsClamped('2026-1-31', 1)).toThrow(RangeError);
  });
});

describe('addDays()', () => {
  it.each([
    ['2026-02-28', 1, '2026-03-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-10-01', -14, '2026-09-17'],
  ])('%s + %i days = %s', (from, days, to) => {
    expect(addDays(from, days)).toBe(to);
  });
});

describe('warrantyEnds() (L2: inclusive)', () => {
  it.each([
    [{ startsOn: '2026-10-01', termMonths: 24 }, '2028-09-30'],
    [{ startsOn: '2026-01-31', termMonths: 1 }, '2026-02-27'],
    [{ startsOn: '2028-02-29', termMonths: 12 }, '2029-02-27'],
    [{ startsOn: '2026-03-01', termMonths: 12 }, '2027-02-28'],
    [{ startsOn: '2027-03-01', termMonths: 12 }, '2028-02-29'],
    [{ startsOn: '2026-10-01', endsOn: '2027-06-30' }, '2027-06-30'],
    [{ startsOn: '2026-10-01', lifetime: true }, 'lifetime'],
    [{ startsOn: '2026-10-01' }, null],
  ])('%j ends %s', (w, end) => {
    expect(warrantyEnds(w)).toBe(end);
  });
});

describe('coverage() (D195)', () => {
  const tv = [
    { id: 'maker', startsOn: '2026-01-10', termMonths: 12 },
    { id: 'extended', startsOn: '2027-01-10', termMonths: 24 },
    { id: 'card', startsOn: '2026-01-10', termMonths: 3 },
  ];

  it('covers until the longest warranty not yet ended, from the earliest start', () => {
    expect(coverage(tv, '2026-10-01')).toEqual({
      longestId: 'extended',
      coveredUntil: '2029-01-09',
      boughtOn: '2026-01-10',
    });
  });

  it('a lifetime warranty beats any date', () => {
    expect(
      coverage([...tv, { id: 'life', startsOn: '2026-01-10', lifetime: true }], '2026-10-01'),
    ).toMatchObject({ longestId: 'life', coveredUntil: 'lifetime' });
  });

  it('covers through the last day, not after it', () => {
    const one = [{ id: 'maker', startsOn: '2026-01-10', termMonths: 12 }];
    expect(coverage(one, '2027-01-09').coveredUntil).toBe('2027-01-09');
    expect(coverage(one, '2027-01-10')).toEqual({
      longestId: null,
      coveredUntil: null,
      boughtOn: '2026-01-10',
    });
  });

  it('keeps the first of two that end the same day', () => {
    const two = [
      { id: 'a', startsOn: '2026-01-01', endsOn: '2027-01-01' },
      { id: 'b', startsOn: '2026-02-01', endsOn: '2027-01-01' },
    ];
    expect(coverage(two, '2026-06-01').longestId).toBe('a');
  });

  it('has nothing to show without warranties', () => {
    expect(coverage([], '2026-10-01')).toEqual({
      longestId: null,
      coveredUntil: null,
      boughtOn: null,
    });
  });
});

describe('claim transitions (Q18)', () => {
  it('lists a row for every status, and closed claims go nowhere', () => {
    expect(Object.keys(CLAIM_TRANSITIONS).sort()).toEqual([...CLAIM_STATUSES].sort());
    for (const closed of CLOSED_CLAIM_STATUSES) expect(CLAIM_TRANSITIONS[closed]).toEqual([]);
  });

  it.each([
    ['open', 'in_repair', true],
    ['open', 'resolved', true],
    ['in_repair', 'open', true],
    ['in_repair', 'rejected', true],
    ['resolved', 'open', false],
    ['rejected', 'in_repair', false],
    ['open', 'open', false],
  ] as const)('%s → %s: %s', (from, to, ok) => {
    expect(canTransitionClaim(from, to)).toBe(ok);
  });
});

describe('scheduleNext() (D29, D162; Q2, Q28)', () => {
  const boiler: ScheduleRule = { everyMonths: 12, anchorOn: '2025-11-15' };
  const oil: ScheduleRule = { everyUnits: '10000', anchorOn: '2026-01-01', anchorValue: '50000' };
  const both: ScheduleRule = { ...oil, everyMonths: 12 };

  type Case = [
    string,
    ScheduleRule,
    {
      today: string;
      latestValue?: string | null;
      eta?: ((value: string) => string | null) | null;
    },
    object,
  ];
  // Step 5's estimate (T7): 60,000 is the oil change's due point; its due-from reading is 59,000.
  const eta = (dates: Record<string, string>) => (value: string) => dates[value] ?? null;
  const cases: Case[] = [
    [
      'estimate: none once the reading itself is there',
      oil,
      { today: '2026-10-20', latestValue: '59000', eta: eta({ '59000': '2026-10-20' }) },
      { state: 'due', basis: 'units', estimatedOn: null, estimated: false },
    ],
    [
      'estimate: due from the day the meter is expected at 59,000 (the 10% lead)',
      oil,
      { today: '2026-10-20', latestValue: '57000', eta: eta({ '59000': '2026-10-20' }) },
      { state: 'due', basis: 'units', estimatedOn: '2026-10-20', estimated: true },
    ],
    [
      'estimate: upcoming the day before, and labelled estimated',
      oil,
      { today: '2026-10-19', latestValue: '57000', eta: eta({ '59000': '2026-10-20' }) },
      { state: 'upcoming', estimatedOn: '2026-10-20', estimated: true },
    ],
    [
      'estimate: unknown rate, no date',
      oil,
      { today: '2026-10-19', latestValue: '57000', eta: () => null },
      { state: 'upcoming', estimatedOn: null, estimated: false },
    ],
    [
      'estimate first: before the months side’s due-from day',
      both,
      { today: '2026-11-01', latestValue: '57000', eta: eta({ '59000': '2026-11-01' }) },
      { dueOn: '2027-01-01', state: 'due', basis: 'units', estimated: true },
    ],
    [
      'months first: the estimate comes after the date side’s due-from day',
      both,
      { today: '2026-12-20', latestValue: '57000', eta: eta({ '59000': '2027-02-01' }) },
      { dueOn: '2027-01-01', state: 'due', basis: 'date', estimated: false },
    ],
    [
      'estimate never makes it overdue',
      oil,
      { today: '2027-06-01', latestValue: '57000', eta: eta({ '59000': '2026-11-01' }) },
      { state: 'due', estimated: true },
    ],
    [
      'estimate on a snooze by reading: no lead',
      { ...oil, snoozedUntilValue: '61500' },
      { today: '2026-12-01', latestValue: '60000', eta: eta({ '61500': '2026-12-01' }) },
      { state: 'due', estimatedOn: '2026-12-01', estimated: true },
    ],
    // Months, with the default 14-day lead.
    [
      'months: upcoming',
      boiler,
      { today: '2026-10-31' },
      { dueOn: '2026-11-15', state: 'upcoming', basis: 'date', dueValue: null },
    ],
    [
      'months: due at the lead',
      boiler,
      { today: '2026-11-01' },
      { dueOn: '2026-11-15', state: 'due' },
    ],
    ['months: due on the day', boiler, { today: '2026-11-15' }, { state: 'due' }],
    ['months: overdue the day after', boiler, { today: '2026-11-16' }, { state: 'overdue' }],
    [
      'months: own lead',
      { ...boiler, leadDays: 0 },
      { today: '2026-11-14' },
      { state: 'upcoming' },
    ],
    [
      'months: month end clamps',
      { everyMonths: 1, anchorOn: '2026-01-31' },
      { today: '2026-01-31' },
      { dueOn: '2026-02-28' },
    ],
    [
      'months: leap day',
      { everyMonths: 12, anchorOn: '2028-02-29' },
      { today: '2028-03-01' },
      { dueOn: '2029-02-28' },
    ],
    [
      'months: skip adds one interval from the anchor',
      { everyMonths: 1, anchorOn: '2026-01-31', skipNext: true },
      { today: '2026-02-01' },
      { dueOn: '2026-03-31', state: 'upcoming' },
    ],
    // One-off (D146).
    [
      'one-off: due',
      { dueOn: '2026-10-10', anchorOn: '2026-09-01' },
      { today: '2026-10-01' },
      { dueOn: '2026-10-10', state: 'due' },
    ],
    [
      'one-off: skip ignored',
      { dueOn: '2026-10-10', anchorOn: '2026-09-01', skipNext: true },
      { today: '2026-10-11' },
      { dueOn: '2026-10-10', state: 'overdue' },
    ],
    // Units only (Q2: no estimate).
    [
      'units: no reading yet',
      oil,
      { today: '2026-10-01', latestValue: null },
      { dueOn: null, dueValue: '60000', state: 'upcoming', basis: 'units' },
    ],
    [
      'units: below the lead',
      oil,
      { today: '2026-10-01', latestValue: '58999.9' },
      { state: 'upcoming' },
    ],
    [
      'units: at the 10% lead',
      oil,
      { today: '2026-10-01', latestValue: '59000' },
      { state: 'due' },
    ],
    [
      'units: at the due value',
      oil,
      { today: '2026-10-01', latestValue: '60000' },
      { state: 'due' },
    ],
    ['units: past it', oil, { today: '2026-10-01', latestValue: '60000.5' }, { state: 'overdue' }],
    [
      'units: own lead',
      { ...oil, leadUnits: '500' },
      { today: '2026-10-01', latestValue: '59000' },
      { state: 'upcoming' },
    ],
    [
      'units: decimals',
      { everyUnits: '2.5', anchorOn: '2026-01-01', anchorValue: '1.125' },
      { today: '2026-10-01', latestValue: '3.4' },
      { dueValue: '3.625', state: 'due' },
    ],
    [
      'units: no anchor reads as 0',
      { everyUnits: '500', anchorOn: '2026-01-01' },
      { today: '2026-10-01', latestValue: '10' },
      { dueValue: '500' },
    ],
    [
      'units: skip',
      { ...oil, skipNext: true },
      { today: '2026-10-01', latestValue: '60000.5' },
      { dueValue: '70000', state: 'upcoming' },
    ],
    // Whichever comes first.
    [
      'both: the date comes first',
      both,
      { today: '2026-12-20', latestValue: '52000' },
      { dueOn: '2027-01-01', dueValue: '60000', state: 'due', basis: 'date' },
    ],
    [
      'both: the units come first',
      both,
      { today: '2026-06-01', latestValue: '61000' },
      { state: 'overdue', basis: 'units' },
    ],
    [
      'both: overdue by date beats due by units',
      both,
      { today: '2027-01-02', latestValue: '59500' },
      { state: 'overdue', basis: 'date' },
    ],
    [
      'both: a tie goes to the date',
      both,
      { today: '2026-06-01', latestValue: '52000' },
      { state: 'upcoming', basis: 'date' },
    ],
    // A snooze replaces the whole due point, without a lead.
    [
      'snooze by date',
      { ...boiler, snoozedUntil: '2026-11-20' },
      { today: '2026-11-19' },
      { dueOn: '2026-11-20', state: 'upcoming' },
    ],
    [
      'snooze by date: due on the day',
      { ...boiler, snoozedUntil: '2026-11-20' },
      { today: '2026-11-20' },
      { state: 'due' },
    ],
    [
      'snooze by date: overdue after',
      { ...boiler, snoozedUntil: '2026-11-20' },
      { today: '2026-11-21' },
      { state: 'overdue' },
    ],
    [
      'snooze beats skip',
      { ...boiler, snoozedUntil: '2026-11-20', skipNext: true },
      { today: '2026-11-01' },
      { dueOn: '2026-11-20' },
    ],
    [
      'snooze by date drops the units side',
      { ...both, snoozedUntil: '2026-12-01' },
      { today: '2026-11-01', latestValue: '65000' },
      { dueOn: '2026-12-01', dueValue: null, state: 'upcoming', basis: 'date' },
    ],
    [
      'snooze by reading',
      { ...oil, snoozedUntilValue: '61000' },
      { today: '2026-10-01', latestValue: '60500' },
      { dueOn: null, dueValue: '61000', state: 'upcoming' },
    ],
    [
      'snooze by reading: reached',
      { ...oil, snoozedUntilValue: '61000' },
      { today: '2026-10-01', latestValue: '61000' },
      { state: 'due' },
    ],
  ];

  it.each(cases)('%s', (_name, rule, at, expected) => {
    expect(scheduleNext(rule, at)).toMatchObject(expected);
  });

  it('refuses a schedule with no interval and no date', () => {
    expect(() => scheduleNext({ anchorOn: '2026-01-01' }, { today: '2026-01-01' })).toThrow(
      RangeError,
    );
  });

  it('uses the plan defaults (§3.4, Q9)', () => {
    expect(LEAD_DEFAULTS.schedule_days).toBe(14);
    expect(1 / Number(UNITS_LEAD_DIVISOR)).toBe(LEAD_DEFAULTS.schedule_units_ratio);
  });
});
