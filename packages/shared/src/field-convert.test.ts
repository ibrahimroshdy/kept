import { describe, expect, it } from 'vitest';
import { CONVERSIONS, canConvertKind, canConvertSecret } from './field-convert.js';
import { FIELD_KINDS } from './inventory.js';

describe('field conversions (D172, D177)', () => {
  it('names every field kind', () => {
    expect(Object.keys(CONVERSIONS).sort()).toEqual([...FIELD_KINDS].sort());
  });

  it('turns text into a number, date, link or choice, and back to text', () => {
    for (const to of ['number', 'date', 'url', 'select'] as const) {
      expect(canConvertKind('text', to)).toBe(true);
    }
    expect(canConvertKind('number', 'text')).toBe(true);
    expect(canConvertKind('date', 'text')).toBe(true);
    expect(canConvertKind('boolean', 'text')).toBe(true);
    expect(canConvertKind('select', 'multi_select')).toBe(true);
    expect(canConvertKind('number', 'date')).toBe(false);
  });

  it('blocks money, person, vendor and file', () => {
    for (const kind of ['money', 'person', 'vendor', 'file'] as const) {
      expect(CONVERSIONS[kind]).toEqual([]);
      expect(canConvertSecret(kind)).toBe(false);
    }
  });

  it('makes only a text field secret or plain', () => {
    expect(canConvertSecret('text')).toBe(true);
    expect(canConvertSecret('number')).toBe(false);
  });
});
