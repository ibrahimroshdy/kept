import { newId } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { type AuditEventRow, crossingOf, customKeyOf, renderAudit } from './render.js';

// Task 21's additions to renderAudit() (engineering spec §7.5; D110, D183; T27 decisions): money
// hidden where the Money module is off, custom-field labels on diff entries, and a move from a
// location the viewer can't see rendered as "moved in from another location" with no diff. The
// stored-event cases (a viewer, a secret) are in audited.test.ts.

const HOME = newId();
const GARAGE = newId();
const HIDDEN = newId();

function event(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: newId(),
    at: new Date('2026-09-20T10:00:00.000Z'),
    locationId: HOME,
    ownerAccountId: newId(),
    actorType: 'user',
    actorId: newId(),
    action: 'thing.update',
    entityType: 'thing',
    entityId: newId(),
    rootThingId: null,
    diff: {
      name: { before: 'Drill', after: 'Hammer drill', class: 'plain' },
      ended_price: { before: null, after: '350.0000', class: 'money' },
      'custom.insured_value': { before: '100', after: '200', class: 'money' },
      'custom.warranty_years': { before: 1, after: 2, class: 'plain' },
      'custom.pin': { changed: true, class: 'secret' },
    },
    requestId: null,
    undoOf: null,
    undoableUntil: null,
    ...overrides,
  };
}

describe('renderAudit(): the Money module (§7.6)', () => {
  it('hides money from everyone, the owner included, where Money is off', () => {
    const out = renderAudit(event(), {
      role: 'owner',
      moneyVisibleToViewers: true,
      moneyModule: false,
    });
    expect(out.diff?.ended_price).toEqual({ changed: true, class: 'money', hidden: true });
    expect(out.diff?.['custom.insured_value']).toEqual({
      changed: true,
      class: 'money',
      hidden: true,
    });
    expect(out.diff?.name).toEqual({ before: 'Drill', after: 'Hammer drill', class: 'plain' });
    expect(JSON.stringify(out)).not.toMatch(/350|"200"|"100"/);
  });

  it('shows money where Money is on (and when the flag is left out)', () => {
    for (const moneyModule of [true, undefined]) {
      const out = renderAudit(event(), {
        role: 'member',
        moneyVisibleToViewers: false,
        ...(moneyModule === undefined ? {} : { moneyModule }),
      });
      expect(out.diff?.ended_price).toEqual({ before: null, after: '350', class: 'money' });
    }
  });
});

describe('renderAudit(): custom-field labels (T27)', () => {
  const labelOf = (key: string) =>
    ({
      insured_value: { label: 'Insured value', labelKey: null },
      warranty_years: { label: null, labelKey: 'warranty_years' },
      pin: { label: 'Door PIN', labelKey: null },
    })[key];

  it('labels custom entries by their field, a built-in by its key, never other entries', () => {
    const out = renderAudit(event(), { role: 'viewer', moneyVisibleToViewers: false }, { labelOf });
    expect(out.diff).toEqual({
      name: { before: 'Drill', after: 'Hammer drill', class: 'plain' },
      ended_price: { changed: true, class: 'money', hidden: true },
      'custom.insured_value': {
        changed: true,
        class: 'money',
        hidden: true,
        label: 'Insured value',
      },
      'custom.warranty_years': { before: 1, after: 2, class: 'plain', labelKey: 'warranty_years' },
      'custom.pin': { changed: true, class: 'secret', label: 'Door PIN' },
    });
  });

  it('leaves an entry with no known field unlabelled', () => {
    const out = renderAudit(
      event({ diff: { 'archived_custom.gone': { before: 'a', after: null, class: 'plain' } } }),
      { role: 'owner', moneyVisibleToViewers: false },
      { labelOf: () => undefined },
    );
    expect(out.diff).toEqual({
      'archived_custom.gone': { before: 'a', after: null, class: 'plain' },
    });
  });

  it('reads the key of custom and archived entries only', () => {
    expect(customKeyOf('custom.size')).toBe('size');
    expect(customKeyOf('archived_custom.size')).toBe('size');
    expect(customKeyOf('custom.')).toBeNull();
    expect(customKeyOf('customs')).toBeNull();
    expect(customKeyOf('name')).toBeNull();
  });
});

describe('renderAudit(): moves across locations (D183)', () => {
  const move = (from: string, to: string, at: string) =>
    event({
      action: 'thing.move',
      locationId: at,
      diff: {
        location_id: { before: from, after: to, class: 'plain' },
        place_id: { before: newId(), after: newId(), class: 'plain' },
      },
    });

  it('renders a move in from a location the viewer cannot see with no diff', () => {
    const out = renderAudit(move(HIDDEN, HOME, HOME), {
      role: 'owner',
      moneyVisibleToViewers: false,
      visibleLocationIds: new Set([HOME, GARAGE]),
    });
    expect(out.movedInFromElsewhere).toBe(true);
    expect(out.diff).toBeNull();
    expect(JSON.stringify(out)).not.toContain(HIDDEN);
  });

  it('renders a move out to a location the viewer cannot see with no diff, not as moved in', () => {
    const out = renderAudit(move(HOME, HIDDEN, HOME), {
      role: 'owner',
      moneyVisibleToViewers: false,
      visibleLocationIds: new Set([HOME]),
    });
    expect(out.movedInFromElsewhere).toBeUndefined();
    expect(out.diff).toBeNull();
    expect(crossingOf(move(HOME, HIDDEN, HOME), new Set([HOME]))).toBe('out');
  });

  it('shows the whole move to a viewer who sees both ends', () => {
    const out = renderAudit(move(GARAGE, HOME, HOME), {
      role: 'member',
      moneyVisibleToViewers: false,
      visibleLocationIds: new Set([HOME, GARAGE]),
    });
    expect(out.movedInFromElsewhere).toBeUndefined();
    expect(out.diff?.location_id).toEqual({ before: GARAGE, after: HOME, class: 'plain' });
  });

  it('fails closed without the visible set: the other end counts as unseen', () => {
    const out = renderAudit(move(GARAGE, HOME, HOME), {
      role: 'owner',
      moneyVisibleToViewers: true,
    });
    expect(out.movedInFromElsewhere).toBe(true);
    expect(out.diff).toBeNull();
  });

  it('leaves a move within one location alone', () => {
    const inside = event({
      action: 'thing.move',
      diff: { place_id: { before: newId(), after: newId(), class: 'plain' } },
    });
    expect(crossingOf(inside)).toBeNull();
    expect(renderAudit(inside, { role: 'viewer', moneyVisibleToViewers: false }).diff).not.toBe(
      null,
    );
  });
});
