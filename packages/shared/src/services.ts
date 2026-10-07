/**
 * Service records, step 5's pure rules (screens §5 "Log a service", §7; step-5 plan T1, Q12, Q13):
 * which schedules an invoice's lines complete, and whether the lines add up to the total.
 * Step 4's service records (apps/server/src/schedules/services.ts) own the rest.
 */

import { fromScaled, SCALE, toScaled } from './decimal.js';
import { normalize, stripPrefixes } from './normalize.js';

/** Words too common to decide a match (3 letters or more only matter), in their normalised form. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  [
    'and',
    'the',
    'for',
    'with',
    'from',
    'les',
    'des',
    'pour',
    'avec',
    'und',
    'der',
    'die',
    'das',
    'mit',
    'per',
    'con',
    'del',
    'della',
    'على',
    'إلى',
  ].map(normalize),
);

/** A single-letter Arabic conjunction or preposition written on the word (و ف ب ك ل). */
const ARABIC_PROCLITIC = /^[وفبكل]/u;
const WORD = /[\p{L}\p{N}]+/gu;

/** A name's words after Kept's normalisation (D42) and the article stripped. */
function wordsOf(text: string): string[] {
  return stripPrefixes(normalize(text)).match(WORD) ?? [];
}

/** The words of a schedule's name that decide a match: 3 characters or more, not a stop word. */
export function significantWords(name: string): string[] {
  return wordsOf(name).filter((w) => [...w].length >= 3 && !STOP_WORDS.has(w));
}

/** `line` holds `word`: as a word, a word's start ("filters", "tyres"), or after a proclitic. */
function holds(lineWords: readonly string[], word: string): boolean {
  return lineWords.some(
    (x) =>
      x.startsWith(word) ||
      (ARABIC_PROCLITIC.test(x) && [...x].length > 1 && x.slice(1).startsWith(word)),
  );
}

/**
 * The schedules an invoice's lines complete (Q13): a schedule matches when **one line** holds
 * every significant word of its name. A name with no significant word never matches. It only
 * pre-ticks; the person decides. Ids in the schedules' order.
 */
export function matchSchedules(
  schedules: readonly { id: string; name: string }[],
  lines: readonly { description: string }[],
): string[] {
  const lineWords = lines.map((l) => wordsOf(l.description));
  return schedules
    .filter((s) => {
      const words = significantWords(s.name);
      return words.length > 0 && lineWords.some((lw) => words.every((w) => holds(lw, w)));
    })
    .map((s) => s.id);
}

/** A line as `reconcileTotal` reads it: its quantity (1 when absent) and unit cost. */
export type PricedLine = { quantity?: string | null; unitCost?: string | null };

/**
 * Whether the lines add up to the total within ±1% (the Purchase rule, screens §7; the server's
 * purchases/view.ts `isFlagged`). Checked only when there is a total and every line has a cost;
 * otherwise `ok`. `sum` is the lines' sum (4 decimals at most) when every line has a cost, else
 * null: with the total omitted, it is the total to use.
 */
export function reconcileTotal(
  total: string | null | undefined,
  lines: readonly PricedLine[],
): { result: 'ok' | 'flag'; sum: string | null } {
  if (lines.length === 0 || lines.some((l) => l.unitCost == null || l.unitCost === '')) {
    return { result: 'ok', sum: null };
  }
  const unit = 10n ** BigInt(SCALE);
  const sum = lines.reduce(
    (acc, l) => acc + (toScaled(l.unitCost as string) * toScaled(l.quantity || '1')) / unit,
    0n,
  );
  const out = fromScaled(sum, 4);
  if (total == null || total === '') return { result: 'ok', sum: out };
  const t = toScaled(total);
  const diff = sum > t ? sum - t : t - sum;
  return { result: diff * 100n <= t ? 'ok' : 'flag', sum: out };
}
