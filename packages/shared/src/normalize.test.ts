import { describe, expect, it } from 'vitest';
import { normalize, searchVariants, stripPrefixes, tsQuery } from './normalize.js';
import vectors from './normalize.vectors.json' with { type: 'json' };

type Vector = { in: string; normalized: string; stripped: string; note?: string };
const VECTORS = vectors as Vector[];

describe('normalize.vectors.json (the shared contract with kept.normalize, V20)', () => {
  it('has at least 60 rows, each with in/normalized/stripped strings', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(60);
    for (const v of VECTORS) {
      expect(typeof v.in).toBe('string');
      expect(typeof v.normalized).toBe('string');
      expect(typeof v.stripped).toBe('string');
    }
  });

  it('has no duplicate inputs', () => {
    expect(new Set(VECTORS.map((v) => v.in)).size).toBe(VECTORS.length);
  });

  it.each(VECTORS.map((v) => [v.in, v] as const))('normalize(%j)', (_, v) => {
    expect(normalize(v.in)).toBe(v.normalized);
  });

  it.each(VECTORS.map((v) => [v.in, v] as const))('stripPrefixes(normalize(%j))', (_, v) => {
    expect(stripPrefixes(normalize(v.in))).toBe(v.stripped);
  });

  it('normalize is idempotent over every vector', () => {
    for (const v of VECTORS) expect(normalize(v.normalized)).toBe(v.normalized);
  });
});

describe('searchVariants', () => {
  it('returns the normalised and stripped forms, deduplicated', () => {
    expect(searchVariants('الكابل')).toEqual(['الكابل', 'كابل']);
    expect(searchVariants('ورق')).toEqual(['ورق']);
    expect(searchVariants('Café')).toEqual(['cafe']);
  });
});

describe('tsQuery', () => {
  it('prefix-matches every word, with both variants when stripping changes it', () => {
    expect(tsQuery('الكابل HDMI')).toBe('(الكابل:* | كابل:*) & hdmi:*');
    expect(tsQuery('ثلاجة')).toBe('ثلاجه:*');
  });

  it('keeps tsquery syntax unreachable from input', () => {
    expect(tsQuery("a & b | !c:* <-> 'd' (e)")).toBe('a:* & b:* & c:* & d:* & e:*');
    expect(tsQuery('foo\\bar')).toBe('foo:* & bar:*');
  });

  it('folds before splitting, so Eastern digits and diacritics match', () => {
    expect(tsQuery('غرفة ٣')).toBe('غرفه:* & 3:*');
    expect(tsQuery('Crème')).toBe('creme:*');
  });

  it('returns null when no word is left', () => {
    expect(tsQuery('')).toBeNull();
    expect(tsQuery('  &|!:*() ')).toBeNull();
    expect(tsQuery('ـــ')).toBeNull();
  });
});
