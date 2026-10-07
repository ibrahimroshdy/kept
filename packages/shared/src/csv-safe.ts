/**
 * Safe CSV (D169; step-7 plan T1, Q12, Q13): the one cell writer every CSV Kept produces goes
 * through: the list export, the readable copy of an export, the AI call ledger. UTF-8 with a BOM
 * so Excel reads Arabic, CRLF line ends, and a cell a spreadsheet would run as a formula made
 * inert with a leading `'`.
 *
 * The triggers are the six D169 names: `=`, `+`, `-`, `@`, tab and carriage return. A number that
 * starts with `-` is neutralised too: a spreadsheet reads `-1+1` as a formula, and a cell can't be
 * told apart from one by its first character.
 */

/** The byte-order mark a CSV starts with, so a spreadsheet reads it as UTF-8. */
export const CSV_BOM = '﻿';

/** Rows are joined with CRLF (RFC 4180). */
export const CSV_EOL = '\r\n';

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\n\r]/;

export type CsvValue = string | number | boolean | null | undefined;

/** One cell: empty for null or undefined, neutralised when it could run as a formula, quoted
 * when it holds a quote, a comma or a line break. */
export function safeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row, cells through safeCsvCell(), without the line end. */
export function csvLine(cells: readonly CsvValue[]): string {
  return cells.map(safeCsvCell).join(',');
}

/** A whole CSV: the BOM, then each row and a CRLF after it. */
export function csvDocument(rows: readonly (readonly CsvValue[])[]): string {
  return CSV_BOM + rows.map((r) => csvLine(r) + CSV_EOL).join('');
}
