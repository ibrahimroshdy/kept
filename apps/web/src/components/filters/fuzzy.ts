/**
 * Fuzzy, Arabic-aware matching for the filter strip's menus (D205): the field list of "+ Filter"
 * and a field's values. Both sides go through the shared normaliser (packages/shared normalize:
 * alef forms, ة/ه, ى/ي, harakat and tatweel, Eastern digits), and each typed word may drop the
 * Arabic article or a joined preposition (`searchVariants`), the way search matches (D42).
 *
 * A typed word matches a text when some word of the text starts with it (best), when the text
 * contains it, or, for words of four letters or more, when a word of the text is one edit away
 * from it (a typo). Every typed word must match; the score orders the results.
 */
import { normalize, searchVariants } from '@kept/shared';

const WORD = /[\p{L}\p{N}]+/gu;

/** At most one insertion, deletion, substitution or adjacent swap between `a` and `b`. */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (x.length === y.length) {
    const rest = (n: number) => x.slice(n).join('') === y.slice(n).join('');
    // a substitution, or a swap of two neighbours
    return rest(i + 1) || (x[i] === y[i + 1] && x[i + 1] === y[i] && rest(i + 2));
  }
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  return long.slice(i + 1).join('') === short.slice(i).join('');
}

/** How well `query` matches `text`: higher is better, `null` when it doesn't. An empty query
 * matches everything with 0. */
export function fuzzyScore(query: string, text: string): number | null {
  const words = normalize(query).match(WORD) ?? [];
  if (words.length === 0) return 0;
  const hay = normalize(text);
  const tokens = hay.match(WORD) ?? [];
  let score = 0;
  for (const word of words) {
    const variants = searchVariants(word);
    let best = -1;
    for (const v of variants) {
      if (hay.startsWith(v)) best = Math.max(best, 4);
      else if (tokens.some((tk) => tk.startsWith(v))) best = Math.max(best, 3);
      else if (hay.includes(v)) best = Math.max(best, 2);
      else if (
        Array.from(v).length >= 4 &&
        tokens.some((tk) => oneEdit(tk.slice(0, v.length + 1), v) || oneEdit(tk, v))
      )
        best = Math.max(best, 1);
    }
    if (best < 0) return null;
    score += best;
  }
  return score;
}

/** `items` that match `query`, best first; the order is kept for equal scores (and for no query). */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
): T[] {
  if (!normalize(query).trim()) return [...items];
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, textOf(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
