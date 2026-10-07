import { describe, expect, it } from 'vitest';
import { easternTyped, meterUnitLabel } from './units';

describe('meterUnitLabel', () => {
  it('reads km, mi and h in Arabic as the board writes them', () => {
    expect(meterUnitLabel('km', 'ar', 'ar-u-nu-arab')).toBe('كم');
    expect(meterUnitLabel('mi', 'ar', 'ar-u-nu-arab')).toBe('ميل');
    expect(meterUnitLabel('h', 'ar', 'ar-u-nu-arab')).not.toBe('h');
  });

  it('keeps English and any other unit as stored', () => {
    expect(meterUnitLabel('km', 'en')).toBe('km');
    expect(meterUnitLabel('h', 'en')).toBe('h');
    expect(meterUnitLabel('cycles', 'ar')).toBe('cycles');
  });

  it('is idempotent: a label read again stays the same', () => {
    const once = meterUnitLabel('km', 'ar');
    expect(meterUnitLabel(once, 'ar')).toBe(once);
  });
});

describe('easternTyped', () => {
  it('writes a plain number in Eastern digits with the Arabic decimal separator', () => {
    expect(easternTyped('30')).toBe('٣٠');
    expect(easternTyped('1400.50')).toBe('١٤٠٠٫٥٠');
    expect(easternTyped('')).toBe('');
  });
});
