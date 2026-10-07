/** The parser settings the page and the worker share (plan T30, Q18). */
import type { ParseConfig } from 'papaparse';

/**
 * Rows as arrays of strings: the header row is read as a row, never typed or evaluated
 * (`dynamicTyping` off), and blank lines (whitespace only, too) are dropped.
 */
export const PARSE_CONFIG = {
  header: false,
  skipEmptyLines: 'greedy',
  dynamicTyping: false,
} as const satisfies ParseConfig;

/** What the worker answers: the rows, and the row of an unclosed quote (null: none). */
export type WorkerAnswer = { rows: string[][]; error: number | null };
