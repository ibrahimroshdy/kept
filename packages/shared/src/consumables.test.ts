import { describe, expect, it } from 'vitest';
import { isLow, STOCK_MIN_MAX } from './consumables.js';

describe('consumables (D14, Q19)', () => {
  it('is low below the minimum, not at it', () => {
    expect(isLow(3, 4)).toBe(true);
    expect(isLow(4, 4)).toBe(false);
    expect(isLow('0', '0.5')).toBe(true);
    expect(isLow('2.500', '2.5')).toBe(false);
  });

  it('caps the minimum at a million', () => {
    expect(STOCK_MIN_MAX).toBe(1_000_000);
  });
});
