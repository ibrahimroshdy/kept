/**
 * The import stepper's words (plan T30, step-7 T19): the fields a column can map to, the dry run's
 * reasons (one sentence per IMPORT_ISSUE_CODES code, with its params; the server's English message
 * for a code this build doesn't know), a row's status, why a file can't be read, and why an
 * archive was refused (ARCHIVE_REFUSALS).
 */
import {
  type ArchiveRefusal,
  CSV_LIMITS,
  type ImportIssue,
  type MappableField,
} from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { ImportRowStatus } from '@/api/capture/types';
import { useFormat } from '@/lib/format';
import { CELL_MAX, COLUMNS_MAX, type ParseProblem } from './parse';

/** The fields offered for a column, in the order the mapping lists them. */
export const FIELD_ORDER = [
  'name',
  'quantity',
  'place_path',
  'type',
  'brand',
  'model',
  'serial',
  'barcode',
  'colour',
  'condition',
  'notes',
  'tags',
  'aliases',
  'purchased_on',
  'price',
  'currency',
  'vendor',
  'manual_url',
  'legacy_code',
  'own_code',
  'source_id',
  'ignore',
] as const satisfies readonly MappableField[];

export function useFieldLabel() {
  const { t } = useLingui();
  const labels: Record<(typeof FIELD_ORDER)[number], string> = {
    name: t`Name`,
    quantity: t`Quantity`,
    place_path: t`Place (a path like Garage > Shelf A)`,
    type: t`Type`,
    brand: t`Brand`,
    model: t`Model`,
    serial: t`Serial number`,
    barcode: t`Barcode`,
    colour: t`Colour`,
    condition: t`Condition`,
    notes: t`Notes`,
    tags: t`Tags`,
    aliases: t`Also called`,
    purchased_on: t`Purchase date`,
    price: t`Price`,
    currency: t`Currency`,
    vendor: t`Shop`,
    manual_url: t`Manual link`,
    legacy_code: t`An old label's code (from another app)`,
    own_code: t`Your own code (checked against your format rule)`,
    source_id: t`Row ID (so a re-import skips it)`,
    ignore: t`Don't import`,
  };
  return (field: string): string => {
    if (field.startsWith('custom.')) {
      const key = field.slice('custom.'.length);
      return t`A type's field: ${key}`;
    }
    return labels[field as keyof typeof labels] ?? field;
  };
}

export function useStatusLabel() {
  const { t } = useLingui();
  const labels: Record<ImportRowStatus, string> = {
    ok: t`Mapped`,
    text: t`Partly as text`,
    skipped: t`Skipped`,
  };
  return (status: ImportRowStatus) => labels[status];
}

/** A dry-run reason in the reader's language. */
export function useIssueText() {
  const { t } = useLingui();
  const f = useFormat();
  return (issue: ImportIssue): string => {
    const max = f.num(issue.params?.max ?? 0);
    const row = f.num(issue.params?.row ?? 0);
    const format = issue.params?.format ?? '';
    switch (issue.code) {
      case 'no_name':
        return t`No name, so it's skipped.`;
      case 'name_too_long':
        return t`The name is longer than ${max} characters, so it's skipped.`;
      case 'already_imported':
        return t`Already imported by an earlier import, so it's skipped.`;
      case 'same_as_row':
        return t`The same as row ${row}, so it's skipped.`;
      case 'too_long':
        return t`Longer than ${max} characters; kept in the notes.`;
      case 'type_not_found':
        return t`No type has this name; kept in the notes.`;
      case 'types_not_matched':
        return t`Types aren't matched by name; kept in the notes.`;
      case 'not_quantity':
        return t`Not a quantity; kept in the notes.`;
      case 'counted_one_by_one':
        return t`This type is counted one by one; kept in the notes.`;
      case 'zero_needs_consumable':
        return t`Only a consumable can have quantity 0; kept in the notes.`;
      case 'brand_too_long':
        return t`Longer than a brand name can be (${max} characters); kept in the notes.`;
      case 'vendor_too_long':
        return t`Longer than a shop name can be (${max} characters); kept in the notes.`;
      case 'not_condition':
        return t`Not a condition Kept knows; kept in the notes.`;
      case 'not_link':
        return t`Not a web link (http or https); kept in the notes.`;
      case 'tag_not_added':
        return t`Not added as a tag (too long, or too many tags); kept in the notes.`;
      case 'alias_not_added':
        return t`Not added as another name (too long, or too many); kept in the notes.`;
      case 'money_off':
        return t`Money is turned off in this location; kept in the notes.`;
      case 'not_price':
        return t`Not a price; kept in the notes.`;
      case 'not_date':
        return t`Not a date written as ${format}; kept in the notes.`;
      case 'future_date':
        return t`The date is in the future; kept in the notes.`;
      case 'needs_price':
        return t`A purchase needs a price; kept in the notes.`;
      case 'needs_date':
        return t`A price needs a purchase date; kept in the notes.`;
      case 'purchase_incomplete':
        return t`The purchase is incomplete; kept in the notes.`;
      case 'not_currency':
        return t`Not a currency turned on in Kept; the price is kept in the notes.`;
      case 'not_type_field':
        return t`Not a field of this row's type; kept in the notes.`;
      case 'no_type':
        return t`The row has no type, so it has no fields; kept in the notes.`;
      case 'not_field_value':
        return t`Not a value this field can hold; kept in the notes.`;
      case 'place_name_too_long':
        return t`A place name is longer than ${max} characters; kept in the notes.`;
      case 'no_such_place':
        return t`No such place, and new places aren't made; it goes to the default place.`;
      case 'secret_skipped':
        return t`Secret fields aren't imported; add it on the thing.`;
      case 'code_taken':
        return t`This code is already on something else, so it isn't added.`;
      case 'code_format': {
        const rule = issue.params?.rule ?? issue.message;
        return t`Doesn't match this location's format rule (${rule}); kept in the notes.`;
      }
      case 'notes_cut':
        return t`The notes are cut to ${max} characters.`;
      // an archive's files (step 7)
      case 'file_type_refused':
        return t`Not imported: a file type Kept doesn't keep.`;
      case 'file_missing':
        return t`The file isn't in the archive, so it's left out.`;
      case 'file_too_large':
        return t`The file is larger than Kept takes, so it's left out.`;
      case 'entry_ignored':
        return t`Not something Kept reads from an export; ignored.`;
      // Homebox (D146)
      case 'hb_archived_skipped':
        return t`Archived in Homebox, left out.`;
      case 'hb_quantity_rounded':
        return t`Counted one by one in Kept; Homebox's quantity is kept in the notes.`;
      case 'hb_quantity_zero':
        return t`Quantity 0 became 1: Homebox gives 0 when none was set.`;
      case 'hb_number_integer':
        return t`Homebox keeps numbers whole, so any decimals were already lost there.`;
      case 'hb_icon_dropped':
        return t`Kept has no icon like Homebox's; the type's own icon is used.`;
      case 'hb_template_partial':
        return t`A Kept template can't hold money or secrets; the rest of the template is imported.`;
      case 'hb_currency_unsupported':
        return t`This currency isn't turned on in Kept; the prices are kept in the notes.`;
      case 'hb_needs_module':
        return t`Kept can't hold this record yet; its text is kept in the thing's notes.`;
      case 'hb_location_in_item':
        return t`A location inside an item became a container.`;
      case 'hb_notifier_skipped':
        return t`Notifiers are never imported: their addresses can hold passwords.`;
      case 'hb_seeded_skipped':
        return t`One of Homebox's starter places or tags, empty and unused, left out.`;
      case 'hb_time_default':
        return t`A date Homebox filled in with the day the item was made; read as empty.`;
      default:
        return issue.message;
    }
  };
}

/** Why a chosen file can't be imported. */
export function useParseProblemText() {
  const { t } = useLingui();
  const f = useFormat();
  return (p: ParseProblem): string => {
    const limitMb = f.num(8);
    const limitRows = f.num(CSV_LIMITS.rows);
    const limitColumns = f.num(COLUMNS_MAX);
    const limitCell = f.num(CELL_MAX);
    switch (p.kind) {
      case 'too_big': {
        const mb = f.num(Math.round(p.bytes / 100_000) / 10);
        return t`This file is ${mb} MB; an import takes at most ${limitMb} MB. Split it into smaller files.`;
      }
      case 'too_many_rows': {
        const rows = f.num(p.rows);
        return t`This file has ${rows} rows; an import takes at most ${limitRows}. Split it into smaller files.`;
      }
      case 'too_many_columns': {
        const columns = f.num(p.columns);
        return t`This file has ${columns} columns; an import takes at most ${limitColumns}.`;
      }
      case 'cell_too_long': {
        const row = f.num(p.row);
        const column = p.column;
        return t`Row ${row}, ${column}, is longer than ${limitCell} characters. Shorten it and try again.`;
      }
      case 'empty':
        return t`This file has no rows under its header row.`;
      default:
        return t`This file can't be read as CSV. Save it from your spreadsheet as CSV (UTF-8) and try again.`;
    }
  };
}

/** Why Kept refused an archive (ARCHIVE_REFUSALS, beside 400 `archive_invalid` or 413
 * `archive_too_large`); `undefined` for a refusal this build doesn't know. */
export function useRefusalText() {
  const { t } = useLingui();
  const f = useFormat();
  return (reason: ArchiveRefusal | string | undefined): string | undefined => {
    switch (reason) {
      case 'too_many_entries': {
        const n = f.num(200_000);
        return t`It holds more than ${n} files.`;
      }
      case 'too_large': {
        const gb = f.num(5);
        return t`It's larger than ${gb} GB.`;
      }
      case 'ratio':
        return t`One of its files unpacks to far more than its size, the way a booby-trapped archive does.`;
      case 'symlink':
        return t`It holds a link to somewhere outside the archive.`;
      case 'bad_name':
        return t`One of its file names points outside the archive.`;
      case 'duplicate_name':
        return t`Two of its files have the same name.`;
      case 'truncated':
        return t`It's incomplete: the download or the copy stopped before the end.`;
      case 'unsupported_version':
        return t`It's from a newer version than this Kept reads. Update Kept, then import it.`;
      case 'encrypted':
        return t`It's protected with a ZIP password, which Kept can't open. Export it again without one.`;
      case 'entry_too_large':
        return t`One of its data files is too large to read.`;
      default:
        return undefined;
    }
  };
}
