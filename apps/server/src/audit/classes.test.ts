import { describe, expect, it } from 'vitest';
import { classOf, FIELD_CLASSES } from './classes.js';

// The static field classes (D110), pure: audited.test.ts covers how audited() stores each class.

describe('FIELD_CLASSES', () => {
  it('tags step 5’s money columns: a fill’s cost and a document’s cost (T2)', () => {
    expect(classOf('fuel_entry', 'cost')).toBe('money');
    expect(classOf('expiring_document', 'cost')).toBe('money');
    // Litres, the unit and an issue date are plain.
    expect(classOf('fuel_entry', 'amount')).toBe('plain');
    expect(classOf('expiring_document', 'issued_on')).toBe('plain');
  });

  it('keeps the earlier steps’ money columns', () => {
    for (const key of ['thing.ended_price', 'purchase.total', 'valuation.value', 'claim.cost']) {
      expect(FIELD_CLASSES[key]).toBe('money');
    }
  });

  it('never lowers a class through a per-call extra', () => {
    expect(classOf('fuel_entry', 'cost', 'plain')).toBe('money');
    expect(classOf('fuel_entry', 'note', 'money')).toBe('money');
  });
});
