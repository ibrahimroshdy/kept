/**
 * CSV import (D73; plan T18, T30, Q18). The browser parses the file and maps its columns; the
 * server receives rows of strings and validates everything again. Both use these lists. The
 * archive importers (step 7: Homebox and Kept exports) report through the same issue list.
 */
import { HB_ISSUE_CODES } from './homebox.js';
import { ARCHIVE_ISSUE_CODES } from './portability.js';

/** Fields a column can map to, plus `custom.<key>` for a type's custom field. */
export const MAPPABLE = [
  'name',
  'quantity',
  'brand',
  'model',
  'serial',
  'barcode',
  'colour',
  'condition',
  'notes',
  'tags',
  'place_path',
  'type',
  'aliases',
  'purchased_on',
  'vendor',
  'price',
  'currency',
  'manual_url',
  'legacy_code',
  /** The household's own code (D208, T17a): checked against the location's format rule. */
  'own_code',
  'source_id',
  'ignore',
] as const;
export type MappableField = (typeof MAPPABLE)[number] | `custom.${string}`;

/** A custom field key, as registry keys are written (`^[a-z][a-z0-9_]{0,39}$`). */
const CUSTOM = /^custom\.[a-z][a-z0-9_]{0,39}$/;

export function isMappable(field: string): field is MappableField {
  return (MAPPABLE as readonly string[]).includes(field) || CUSTOM.test(field);
}

/**
 * Why a dry-run row isn't simply `ok` (plan T18, T30): a stable code the web translates, with the
 * values its sentence needs in `params`. `message` is the server's English sentence, for a client
 * that doesn't know a newer code.
 */
export const IMPORT_ISSUE_CODES = [
  // skipped rows
  'no_name',
  'name_too_long',
  'already_imported',
  'same_as_row',
  // cells kept as text in the notes
  'too_long',
  'type_not_found',
  'types_not_matched',
  'not_quantity',
  'counted_one_by_one',
  'zero_needs_consumable',
  'brand_too_long',
  'vendor_too_long',
  'not_condition',
  'not_link',
  'tag_not_added',
  'alias_not_added',
  'money_off',
  'not_price',
  'not_date',
  'future_date',
  'needs_price',
  'needs_date',
  'purchase_incomplete',
  'not_currency',
  'not_type_field',
  'no_type',
  'not_field_value',
  'place_name_too_long',
  'no_such_place',
  // not imported, and not kept as text
  'secret_skipped',
  'code_taken',
  // an own code the location's format rule refuses: kept as text, with the owner's message
  'code_format',
  'notes_cut',
  // step 7: an archive's files (a refused type, a missing entry) and the Homebox mapping (D146)
  ...ARCHIVE_ISSUE_CODES,
  ...HB_ISSUE_CODES,
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

/** The values an issue's sentence names: a length limit, an earlier row, the date format, a
 * custom field's kind (`number`, `multi_select`, …). */
export type ImportIssueParams = {
  max?: number;
  row?: number;
  format?: DateFormat;
  kind?: string;
  /** `code_format`: the location's own message for its format rule. */
  rule?: string;
};

/** What an archive import's issue is about (step 7): an entity (a Homebox item or location, a
 * Kept thing or place), an attachment or its file, a maintenance entry or a template, by its id
 * in the archive and its name there. A CSV issue has none: its row number says where. */
export type ImportIssueRef = {
  kind: 'entity' | 'attachment' | 'maintenance' | 'template' | 'file';
  id: string;
  name?: string;
};

/** One reason on a dry-run row; `column` is the CSV header it's about ('' for the whole row, and
 * for an archive row). */
export type ImportIssue = {
  column: string;
  code: ImportIssueCode;
  params?: ImportIssueParams;
  message: string;
  ref?: ImportIssueRef;
};

/** Per file (Q18). */
export const CSV_LIMITS = Object.freeze({ rows: 10_000, bytes: 8_000_000 });

/** A `running` import whose row hasn't moved for this long has lost its job, and may be resumed
 * (POST /imports/:id/run); the web compares it with the run's `updatedAt`. */
export const IMPORT_STALE_MINUTES = 15;

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD.MM.YYYY',
  'DD-MM-YYYY',
  'YYYY/MM/DD',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
const foldDigits = (s: string) =>
  s.replace(EASTERN_DIGITS, (d) => String((d.codePointAt(0) as number) & 0xf));

/**
 * A cell's date in the chosen format, as `YYYY-MM-DD`, or null when it doesn't read as a real
 * date in that format. Eastern Arabic and Persian digits are accepted (D172). Years are four
 * digits: a two-digit year is refused rather than guessed.
 */
export function parseCsvDate(value: string, format: DateFormat): string | null {
  const sep = format.replace(/[YMD]/g, '')[0] as string;
  const parts = foldDigits(value.trim()).split(sep);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const order = format.split(sep);
  const get = (unit: string) => parts[order.indexOf(unit)] as string;
  const yyyy = get('YYYY');
  const mm = get('MM');
  const dd = get('DD');
  if (yyyy.length !== 4 || mm.length > 2 || dd.length > 2) return null;
  const y = Number(yyyy);
  const m = Number(mm);
  const d = Number(dd);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * A place path cell split into place names from the top down, trimmed, with empty segments
 * dropped (`'Garage > Shelf A'` → `['Garage', 'Shelf A']`).
 */
export function splitPlacePath(path: string, separator = '>'): string[] {
  return path
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
