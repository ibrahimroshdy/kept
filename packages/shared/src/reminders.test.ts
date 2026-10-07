import { describe, expect, it } from 'vitest';
import { LIST_SURFACES, SURFACE_FILTER_KEYS } from './list-views.js';
import {
  ACCOUNT_LEVEL_KINDS,
  ACTIVE_SOURCE_TYPES,
  CHANNEL_KINDS,
  CHANNEL_KINDS_1_0,
  DEFAULT_DIGEST_TIME,
  defaultPreference,
  duePeriod,
  NOTIFY_KIND_SLOTS,
  NOTIFY_KINDS,
  OCCURRENCE_KINDS,
  PREFERENCE_CHANNELS,
  SOURCE_KINDS,
  SOURCE_MODULE,
  SOURCE_TYPES,
  sourceModuleOn,
} from './reminders.js';
import { ROLES } from './roles.js';

// The CHECK on reminder_occurrences.due_period (step-4 plan T7).
const DUE_PERIOD_CHECK = /^(date:\d{4}-\d{2}-\d{2}|meter:\d+(\.\d{1,3})?)$/;

describe('reminder sources (§1.9; Q3–Q7)', () => {
  it('has the §1.9 sources, and steps 4, 5 and 7 build them all', () => {
    expect([...SOURCE_TYPES].sort()).toEqual(
      [
        'document',
        'loan',
        'reading_stale',
        'registration',
        'schedule',
        'stock',
        'thing_expiry',
        'warranty',
      ].sort(),
    );
    expect(
      SOURCE_TYPES.filter((s) => !(ACTIVE_SOURCE_TYPES as readonly string[]).includes(s)),
    ).toEqual([]);
  });

  it('maps every source to a module (or core) and to its kinds', () => {
    expect(Object.keys(SOURCE_MODULE).sort()).toEqual([...SOURCE_TYPES].sort());
    expect(Object.keys(SOURCE_KINDS).sort()).toEqual([...SOURCE_TYPES].sort());
    for (const s of SOURCE_TYPES) {
      for (const k of SOURCE_KINDS[s]) expect(OCCURRENCE_KINDS).toContain(k);
    }
    for (const s of ACTIVE_SOURCE_TYPES) expect(SOURCE_KINDS[s].length).toBeGreaterThan(0);
  });

  it('produces the Q7 kinds', () => {
    expect(SOURCE_KINDS.schedule).toEqual(['due', 'overdue']);
    expect(SOURCE_KINDS.warranty).toEqual(['expiring']);
    expect(SOURCE_KINDS.registration).toEqual(['due']);
    expect(SOURCE_KINDS.document).toEqual(['expiring', 'overdue']);
    expect(SOURCE_KINDS.loan).toEqual(['overdue']);
    expect(SOURCE_KINDS.thing_expiry).toEqual(['expiring', 'overdue']);
    expect(SOURCE_KINDS.reading_stale).toEqual(['due']);
    expect(SOURCE_KINDS.stock).toEqual(['due']);
  });

  it('pauses a source with its module; a vehicle’s document on Paperwork or Vehicles (step 5)', () => {
    const only =
      (...on: string[]) =>
      (m: string) =>
        on.includes(m);
    expect(sourceModuleOn('reading_stale', only())).toBe(true);
    expect(sourceModuleOn('schedule', only('paperwork'))).toBe(false);
    expect(sourceModuleOn('document', only('vehicles'))).toBe(false);
    expect(sourceModuleOn('document', only('vehicles'), { vehicle: true })).toBe(true);
    expect(sourceModuleOn('document', only('paperwork'), { vehicle: true })).toBe(true);
    expect(sourceModuleOn('document', only(), { vehicle: true })).toBe(false);
    expect(sourceModuleOn('warranty', only('vehicles'), { vehicle: true })).toBe(false);
  });
});

describe('duePeriod() (§7.13)', () => {
  it.each([
    [{ dueOn: '2026-10-17' }, 'date:2026-10-17'],
    [{ dueValue: '60000' }, 'meter:60000'],
    [{ dueValue: '60000.000' }, 'meter:60000'],
    [{ dueValue: '0060000.500' }, 'meter:60000.5'],
    [{ dueValue: '0.125' }, 'meter:0.125'],
    [{ dueValue: '0' }, 'meter:0'],
  ])('%j → %s, which the CHECK accepts', (due, period) => {
    expect(duePeriod(due)).toBe(period);
    expect(period).toMatch(DUE_PERIOD_CHECK);
  });

  it.each([
    { dueOn: '17/10/2026' },
    { dueValue: '1.2345' },
    { dueValue: '-1' },
    { dueValue: '1e3' },
  ])('refuses %j', (due) => {
    expect(() => duePeriod(due)).toThrow(RangeError);
  });
});

describe('notification kinds and channels (D30, D130; Q10, Q35)', () => {
  it('prefers the step-4 and step-5 sources plus the notices', () => {
    expect(NOTIFY_KINDS).toEqual([
      'schedule',
      'warranty',
      'registration',
      'document',
      'loan',
      'thing_expiry',
      'reading_stale',
      'stock',
      'membership',
      'ai_cap',
      'ai_summary',
    ]);
    expect(ACCOUNT_LEVEL_KINDS).toEqual(['ai_summary']);
  });

  it("holds every preference kind in the table's CHECK (0067), the stale-reading nudge taking its slot", () => {
    expect([...NOTIFY_KINDS]).toEqual([...NOTIFY_KIND_SLOTS]);
    expect(NOTIFY_KINDS).toContain('reading_stale');
  });

  it('builds email, push and webhook in 1.0; preferences add in-app', () => {
    expect(CHANNEL_KINDS_1_0).toEqual(['email', 'webpush', 'webhook']);
    for (const c of CHANNEL_KINDS_1_0) expect(CHANNEL_KINDS).toContain(c);
    expect(PREFERENCE_CHANNELS).toEqual(['inapp', 'email', 'webpush', 'webhook']);
  });

  it('sends the digest at 08:00 by default (Q9)', () => {
    expect(DEFAULT_DIGEST_TIME).toBe('08:00');
  });
});

describe('defaultPreference() (D29; Q8)', () => {
  const reminderKinds = ACTIVE_SOURCE_TYPES;

  it('owners and admins get every kind', () => {
    for (const role of ['owner', 'admin'] as const) {
      for (const kind of NOTIFY_KINDS) expect(defaultPreference({ role, kind })).toBe(true);
    }
  });

  it('members get only the loans they recorded, and membership notices', () => {
    expect(defaultPreference({ role: 'member', kind: 'loan', recordedByMe: true })).toBe(true);
    expect(defaultPreference({ role: 'member', kind: 'loan', recordedByMe: false })).toBe(false);
    expect(defaultPreference({ role: 'member', kind: 'loan' })).toBe(false);
    for (const kind of reminderKinds.filter((k) => k !== 'loan')) {
      expect(defaultPreference({ role: 'member', kind, recordedByMe: true })).toBe(false);
    }
    expect(defaultPreference({ role: 'member', kind: 'membership' })).toBe(true);
    expect(defaultPreference({ role: 'member', kind: 'ai_cap' })).toBe(false);
  });

  it('viewers get no reminder kinds, only membership notices', () => {
    for (const kind of reminderKinds) {
      expect(defaultPreference({ role: 'viewer', kind, recordedByMe: true })).toBe(false);
    }
    expect(defaultPreference({ role: 'viewer', kind: 'membership' })).toBe(true);
    expect(defaultPreference({ role: 'viewer', kind: 'ai_cap' })).toBe(false);
  });

  it('the AI monthly summary is opt-out for everyone', () => {
    for (const role of ROLES) expect(defaultPreference({ role, kind: 'ai_summary' })).toBe(true);
  });
});

describe('step-4 list surfaces (D205)', () => {
  it('keep saved views, with surface names the saved_views CHECK accepts', () => {
    for (const s of [
      'schedules',
      'lending',
      'paperwork',
      'expiring',
      'notifications',
      'incidents',
      'ai-calls',
    ] as const) {
      expect(LIST_SURFACES).toContain(s);
      expect(s).toMatch(/^[a-z][a-z-]{0,31}$/);
      expect(SURFACE_FILTER_KEYS[s].length).toBeGreaterThan(0);
    }
    expect(Object.keys(SURFACE_FILTER_KEYS).sort()).toEqual([...LIST_SURFACES].sort());
  });
});
