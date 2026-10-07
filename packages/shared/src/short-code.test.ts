import { describe, expect, it } from 'vitest';
import {
  ALPHABET,
  isShortCode,
  normaliseInputCode,
  printedCode,
  randomShortCode,
  SHORT_CODE,
  storedCodeOf,
} from './short-code.js';

describe('short codes (D120: 6 Crockford base32 characters)', () => {
  it('uses the 32-character Crockford alphabet, with no I, L, O or U', () => {
    expect(ALPHABET).toHaveLength(32);
    expect(new Set(ALPHABET).size).toBe(32);
    expect(ALPHABET).not.toMatch(/[ILOU]/);
    for (const c of ALPHABET) expect(`${c}${c}${c}${c}${c}${c}`).toMatch(SHORT_CODE);
  });

  it('SHORT_CODE rejects lower case, ambiguous letters and wrong lengths', () => {
    for (const bad of ['abc123', 'ABCDEI', 'ABCDEL', 'ABCDEO', 'ABCDEU', 'ABC12', 'ABC1234', '']) {
      expect(isShortCode(bad)).toBe(false);
    }
    expect(isShortCode('7K3M9Q')).toBe(true);
  });

  it('generates codes that always match, spread across the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = randomShortCode();
      expect(code).toMatch(SHORT_CODE);
      for (const c of code) seen.add(c);
    }
    expect(seen.size).toBe(32);
  });

  it('normalises typed input: upper case, O → 0, I and L → 1, separators dropped', () => {
    expect(normaliseInputCode('ab1lo0')).toBe('AB1100');
    expect(normaliseInputCode(' 7k3-m9q ')).toBe('7K3M9Q');
    expect(normaliseInputCode('iIlLoO')).toBe('111100');
    // A code copied from a report or a chip: the non-breaking hyphen goes too.
    expect(normaliseInputCode('7k3\u20114mz')).toBe('7K34MZ');
  });

  it('prints a code 3 + 3 around a non-breaking hyphen (D134), and anything else as it is', () => {
    expect(printedCode('7KQ4MZ')).toBe('7KQ\u20114MZ');
    expect(normaliseInputCode(printedCode('7KQ4MZ'))).toBe('7KQ4MZ');
    expect(printedCode('ABC12')).toBe('ABC12');
    expect(printedCode('')).toBe('');
  });
  it('stores a legacy or own code upper case, trimmed, with Eastern digits folded, and nothing else (D208)', () => {
    expect(storedCodeOf(' gar-٠٠٤٢ ')).toBe('GAR-0042');
    expect(storedCodeOf('bolt-01')).toBe('BOLT-01');
    expect(storedCodeOf('۱۲')).toBe('12');
  });
});
