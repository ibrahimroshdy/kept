import { createHash } from 'node:crypto';
import {
  CSV_LIMITS,
  DATE_FORMATS,
  type DateFormat,
  isMappable,
  MAPPABLE,
  type MappableField,
  parseAmount,
  parseCsvDate,
} from '@kept/shared';
import { z } from 'zod';

// CSV import, the request side and the cell parsers (D73; plan T18, Q18). The browser parses the
// file (papaparse) and posts the rows as strings; the server trusts none of it: every cell is
// read again here, by the same parsers for the dry run and the job (dry-run.ts, job.ts).
//
// Nothing in a cell is ever evaluated. A cell that looks like a spreadsheet formula
// (`=HYPERLINK(…)`) is stored exactly as typed, as plain text; D169's neutralising is for the
// CSVs Kept writes, and applies there.

/** The longest cell kept; longer ones are refused with the request (a 400). */
export const CELL_MAX = 10_000;
/** At most this many columns. */
export const COLUMNS_MAX = 200;
/**
 * The route's body limit: the plan's "body ≤ 8 MB", as bytes of JSON. The rows travel as JSON
 * arrays of strings, a little larger than the CSV they came from (CSV_LIMITS.bytes).
 */
export const BODY_LIMIT = 8 * 1024 * 1024;

/** Fields one row can take from several columns (each column adds to it). Every other field is
 * mapped by at most one column. */
export const MULTI: ReadonlySet<MappableField> = new Set<MappableField>([
  'notes',
  'tags',
  'aliases',
  'legacy_code',
  'own_code',
  'ignore',
]);

export const ImportChoices = z.strictObject({
  placeSeparator: z.enum(['>', '/', '\\']),
  /** Create the places a path names when they don't exist; otherwise such a row lands in the
   * default target and keeps its path as text. */
  createPlaces: z.boolean(),
  dateFormat: z.enum(DATE_FORMATS),
  /** The prices' currency when a row has no currency column (default: the location's). */
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  /** Where a row without a place path (or with one that isn't created) goes. */
  defaultTarget: z.union([
    z.strictObject({ placeId: z.uuid() }),
    z.strictObject({ unplaced: z.literal(true) }),
  ]),
  /** Match the `type` column to the account's and Kept's types by name, in any of the five
   * languages. Off: the column's value is kept in the notes as text. */
  typeByName: z.boolean(),
});
export type ImportChoices = z.infer<typeof ImportChoices>;

/** POST /api/v1/imports/csv. The row count (≤ 10,000) is checked by the route, which answers 413
 * past it, as for a file too large. */
export const CreateImportBody = z.strictObject({
  id: z.uuid().optional(),
  locationId: z.uuid(),
  columns: z.array(z.string().max(200)).min(1).max(COLUMNS_MAX),
  rows: z.array(z.array(z.string().max(CELL_MAX)).max(COLUMNS_MAX)),
  mapping: z.record(
    z.string().max(200),
    z.string().refine(isMappable, `one of ${MAPPABLE.join(', ')} or custom.<key>`),
  ),
  choices: ImportChoices,
});
export type CreateImportBody = z.infer<typeof CreateImportBody>;

export { CSV_LIMITS };

/**
 * The mapping checked against the columns: each key names a column, `name` is mapped, and a
 * single-valued field is mapped once. Returns the problem as a hint, or null.
 */
export function mappingProblem(
  columns: readonly string[],
  mapping: Readonly<Record<string, string>>,
): string | null {
  const names = new Set(columns);
  for (const key of Object.keys(mapping)) {
    if (!names.has(key)) return `Check body.mapping: "${key}" is not one of the columns.`;
  }
  const count = new Map<string, number>();
  for (const column of columns) {
    const field = mapping[column];
    if (field) count.set(field, (count.get(field) ?? 0) + 1);
  }
  if (!count.has('name')) return 'Check body.mapping: map a column to name.';
  for (const [field, n] of count) {
    if (n > 1 && !MULTI.has(field as MappableField)) {
      return `Check body.mapping: ${field} is mapped from more than one column.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

const LOCAL_DIGIT = /[٠-٩۰-۹]/g;
/** Eastern Arabic (٠–٩) and Persian (۰–۹) digits as Western ones (D172). */
export function foldDigits(s: string): string {
  return s.replace(LOCAL_DIGIT, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** A cell as the importer reads it: composed (NFC) and trimmed, with no other change. */
export function cell(value: string | undefined): string {
  return (value ?? '').normalize('NFC').trim();
}

/** A quantity (`3`, `٣٤٥`, `2.5`, `2٫5`), or null when it isn't one a thing can hold. */
export function parseQuantity(value: string): number | null {
  const s = foldDigits(value)
    .replace(/٫/g, '.')
    .replace(/[\s,٬]/g, '');
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n <= 999_999_999 ? n : null;
}

/** A price in @kept/shared's canonical form, or null. Accepts what parseAmount accepts
 * (Eastern digits, `٫`, grouping in threes) after dropping spaces. */
export function parsePrice(value: string): string | null {
  try {
    return parseAmount(value.replace(/\s/g, ''));
  } catch {
    return null;
  }
}

export function parseDate(value: string, format: DateFormat): string | null {
  return parseCsvDate(value, format);
}

const YES = new Set(['yes', 'y', 'true', '1', 'نعم', 'oui', 'ja', 'sì', 'si', '✓', 'x']);
const NO = new Set(['no', 'n', 'false', '0', 'لا', 'non', 'nein', '']);
/** A yes/no cell, or null. */
export function parseBoolean(value: string): boolean | null {
  const s = foldDigits(value).toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return null;
}

/** An http(s) URL of at most 2,000 characters, or null. */
export function parseUrl(value: string): string | null {
  if (value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** A list cell (tags, aliases, choices): split on commas (Latin or Arabic) and semicolons,
 * trimmed, empty and repeated items dropped. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[,،;؛]/)) {
    const item = part.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** How a legacy code is stored (§1.10: `upper(btrim())`), with Eastern digits folded, as a
 * scanner reads them. */
export function legacyCodeOf(value: string): string {
  return foldDigits(value).normalize('NFC').trim().toUpperCase();
}

/**
 * A row's identity when no column is mapped to `source_id`: the SHA-256 of its non-empty cells,
 * each as `header=value` (composed, trimmed, whitespace collapsed), sorted. The same row gives
 * the same id whatever the column order or mapping, so a re-run of the same file creates
 * nothing new.
 */
export function rowHash(columns: readonly string[], row: readonly string[]): string {
  const norm = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ');
  const pairs: string[] = [];
  columns.forEach((column, i) => {
    const value = norm(row[i] ?? '');
    if (value) pairs.push(JSON.stringify([norm(column), value]));
  });
  pairs.sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}
