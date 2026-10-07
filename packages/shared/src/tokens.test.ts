import { describe, expect, it } from 'vitest';
import {
  formatToken,
  isPersonalToken,
  newTokenParts,
  parseToken,
  TOKEN_KINDS,
  TOKEN_PREFIX,
  TOKEN_RATE,
  TOKEN_SCOPES,
} from './tokens.js';

describe('tokens', () => {
  it('holds the plan’s constants', () => {
    expect(TOKEN_PREFIX).toBe('kpt_');
    expect(TOKEN_SCOPES).toEqual(['read', 'write']);
    expect(TOKEN_KINDS).toEqual(['personal', 'oauth']);
    expect(TOKEN_RATE).toEqual({ readsPerMinute: 120, writesPerMinute: 30 });
  });

  it('round-trips a new token', () => {
    for (let i = 0; i < 50; i++) {
      const parts = newTokenParts();
      expect(parts.lookup).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(parts.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const token = formatToken(parts);
      expect(token.startsWith('kpt_')).toBe(true);
      expect(parseToken(token)).toEqual(parts);
      expect(parseToken(` ${token}\n`)).toEqual(parts);
    }
  });

  it('is unpredictable: 50 tokens, 50 lookups and secrets', () => {
    const all = Array.from({ length: 50 }, newTokenParts);
    expect(new Set(all.map((p) => p.lookup)).size).toBe(50);
    expect(new Set(all.map((p) => p.secret)).size).toBe(50);
  });

  it.each([
    ['no prefix', `abcdEFGH_${'a'.repeat(43)}`],
    ['another prefix', `kpx_abcdEFGH_${'a'.repeat(43)}`],
    ['a short lookup', `kpt_abcdEFG_${'a'.repeat(43)}`],
    ['a short secret', `kpt_abcdEFGH_${'a'.repeat(42)}`],
    ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['empty', ''],
  ])('refuses %s', (_name, value) => {
    expect(parseToken(value)).toBeNull();
  });

  it('tells a personal token from anything else', () => {
    expect(isPersonalToken(formatToken(newTokenParts()))).toBe(true);
    expect(isPersonalToken('eyJhbGciOi')).toBe(false);
  });
});
