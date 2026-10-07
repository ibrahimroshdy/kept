/**
 * Offline search: the `normalize()` twin of the server's search (D42). A query's words are
 * normalised and their Arabic prefixes stripped; a row matches when every word is the start of
 * one of its terms (`termsOf()`: name, aliases, short code, legacy and own codes). So `كابل`
 * finds `الكابل`, `display` finds a cable whose English alias is "display cable", and `gar-00`
 * finds the thing whose own code is GAR-0042.
 */
import { normalize, stripPrefixes } from '@kept/shared';

/** The query's words, normalised and stripped. Empty for a blank query. */
export function queryWords(q: string): string[] {
  return normalize(q)
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => stripPrefixes(w));
}

/** Every word starts one of the terms. */
export function matchesAll(terms: readonly string[], words: readonly string[]): boolean {
  return words.every((w) => terms.some((term) => term.startsWith(w)));
}

/** The word to look up in the `*terms` index: the longest is the most selective. */
export function indexWord(words: readonly string[]): string | undefined {
  return [...words].sort((a, b) => b.length - a.length)[0];
}
