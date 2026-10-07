import { describe, expect, it } from 'vitest';
import { NEAR_MAX_LETTERS, NEAR_MAX_WORDS, nearWords } from './query.js';

// "Did you mean" is bounded (route security review #32): a query can't make the variant lists,
// which every visible name's words are compared against, grow without limit.
describe('nearWords bounds', () => {
  it(`varies at most ${NEAR_MAX_WORDS} words`, () => {
    const many = nearWords('alpha bravo charlie delta echoo foxtrot golfy hotel');
    const six = nearWords('alpha bravo charlie delta echoo foxtrot');
    expect(many).toEqual(six);
  });

  it(`ignores a word longer than ${NEAR_MAX_LETTERS} letters`, () => {
    const long = 'a'.repeat(NEAR_MAX_LETTERS + 1);
    expect(nearWords(long)).toEqual({ literals: [], patterns: [] });
    expect(nearWords(`${long} hmdi`)).toEqual(nearWords('hmdi'));
    expect(nearWords('b'.repeat(NEAR_MAX_LETTERS)).patterns.length).toBeGreaterThan(0);
  });
});
