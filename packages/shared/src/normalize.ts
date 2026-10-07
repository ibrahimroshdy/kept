/**
 * Search normalisation (D42, D172, screens spec §8): the JavaScript twin of the IMMUTABLE SQL
 * `kept.normalize()` / `kept.strip_prefixes()` (engineering spec §7.9). Both are checked against
 * `normalize.vectors.json`; when they disagree, fix the twin, never the vector (V20).
 *
 * `normalize(s)`, step by step:
 *  1. NFKC, then lower-case (full-width, ligatures, presentation forms, no-break spaces).
 *  2. Arabic alef forms `أ إ آ ٱ` → `ا`. This runs before decomposition so that hamza on waw and
 *     yeh (`ؤ ئ`) survive: D42 folds alef forms only, and the SQL twin never touches them.
 *  3. NFD, drop every non-spacing mark (Latin accents, harakat, the dagger alef) except the
 *     combining hamza, recompose (NFC), then drop any combining hamza left unattached. This
 *     matches SQL's `unaccent` + removal of U+064B–U+0670.
 *  4. Tatweel removed; `ß æ œ ø đ ł þ` spelled out; `ى ی → ي`, `ة → ه`, `ک → ك`.
 *  5. Eastern Arabic (٠–٩) and Persian (۰–۹) digits → 0–9.
 *  6. ASCII whitespace runs collapse to one space; one leading and trailing space trimmed.
 *
 * `stripPrefixes(s)` works on normalised text, per word: `(و|ب|ف|ك)?ال` + at least two letters
 * loses the prefix, then `لل` + at least two letters. A lone `و ب ف ك` is never stripped (Q20):
 * `ورق` and `بيت` stay whole. Search indexes and queries both forms, so recall never drops.
 */

const MARK = /\p{Mn}/gu;
const HAMZA_KEEP = /[ٕٔ]/;
const HAMZA_LEFT = /[ٕٔ]/g;
const ALEF = /[أإآٱ]/g;
const TATWEEL = /ـ/g;
const WHITESPACE = /[\t\n\v\f\r ]+/g;

const LETTER_MAP: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  þ: 'th',
  ى: 'ي', // ى → ي
  ی: 'ي', // ی → ي
  ة: 'ه', // ة → ه
  ک: 'ك', // ک → ك
};
const LETTERS = new RegExp(`[${Object.keys(LETTER_MAP).join('')}]`, 'g');

const DIGITS = /[٠-٩۰-۹]/g;

function foldDigit(d: string): string {
  const c = d.charCodeAt(0);
  return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
}

/** The search form of `s` (D42). Idempotent; see the module comment for each step. */
export function normalize(s: string): string {
  const composed = s.normalize('NFKC').toLowerCase().replace(ALEF, 'ا');
  const unmarked = composed
    .normalize('NFD')
    .replace(MARK, (m) => (HAMZA_KEEP.test(m) ? m : ''))
    .normalize('NFC')
    .replace(HAMZA_LEFT, '');
  const folded = unmarked
    .replace(TATWEEL, '')
    .replace(LETTERS, (c) => LETTER_MAP[c] ?? c)
    .replace(DIGITS, foldDigit);
  return folded.replace(WHITESPACE, ' ').replace(/^ | $/g, '');
}

const ARTICLE = /(^|\s)(?:[وبفك])?ال(\S{2,})/gu;
const LAM_LAM = /(^|\s)لل(\S{2,})/gu;

/** Drop Arabic attached prefixes from each word of already-normalised text (Q20). */
export function stripPrefixes(s: string): string {
  return s.replace(ARTICLE, '$1$2').replace(LAM_LAM, '$1$2');
}

/** The forms of one word that search matches: normalised, and stripped when that differs. */
export function searchVariants(word: string): string[] {
  const normalized = normalize(word);
  const stripped = stripPrefixes(normalized);
  return stripped === normalized ? [normalized] : [normalized, stripped];
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * A `to_tsquery('simple', …)` string for free-text input: every word prefix-matched, each word
 * `(normalised:* | stripped:*)`, words ANDed. Only letters and digits survive, so no tsquery
 * operator can be injected. `null` when the input has no word.
 */
export function tsQuery(q: string): string | null {
  const words = normalize(q).match(WORD);
  if (!words) return null;
  const terms = words.map((w) => {
    const variants = searchVariants(w).map((v) => `${v}:*`);
    return variants.length === 1 ? variants[0] : `(${variants.join(' | ')})`;
  });
  return terms.join(' & ');
}
