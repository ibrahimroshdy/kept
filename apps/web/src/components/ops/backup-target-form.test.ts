import { describe, expect, it } from 'vitest';
import { asciiDigits } from './backup-target-form';

describe('asciiDigits (UI review steps 6–8, M7)', () => {
  it('reads what an Arabic or Persian keyboard types as 0–9, so the keep counts and port can be typed', () => {
    expect(asciiDigits('٧')).toBe('7');
    expect(asciiDigits('٢٢')).toBe('22');
    expect(asciiDigits('۱۲')).toBe('12');
    expect(asciiDigits('٣٠a').replace(/\D/g, '')).toBe('30');
  });
});
