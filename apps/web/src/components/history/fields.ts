/**
 * Which fields of a rendered audit diff a reader sees (#140). The summary line says what happened
 * and its detail lines say what it covered ("12 things", "With photos"); a field earns a line of
 * its own only when it is something a person set and would recognise. Everything else stays in
 * the audit, not on the page:
 *
 * - ids and id lists (`place_id`, `file_ids`, `thingIds`): a reader can't use a UUID;
 * - bookkeeping: row versions, counters a trash or an undo keeps for itself, order, storage;
 * - a report's or a print's settings (digits, locale, filters, include): its sentence and lines
 *   say what it was;
 * - an arrangement's layout, which the server says change by change;
 * - every field of a row whose sentence is the whole story (a report, a label batch, an inbox
 *   item, an upload, an undone capture).
 */
const HIDDEN = new Set([
  // Step 4 (T29): what a delete keeps so undo can put it back (its documents, a service's lines
  // and the schedules it completed), not a change anyone made.
  'documents',
  'lines',
  'completes',
  // Step 5: what a service or a fill keeps for its undo, and a starter set's or a draft's ids.
  'reading_created',
  'cleared_schedules',
  'surface',
  'sort',
  'class',
  'has_gps',
  'derivative_state',
  'sha256',
  'width',
  'height',
  // #140: bookkeeping and settings.
  'version',
  'row_version',
  'meter_version',
  'created_via',
  'moved',
  'trashed',
  'restored',
  'contents',
  'deleted_at',
  'digits',
  'locale',
  'include',
  'filters',
  'scope',
  'layout',
  'mode',
  'meter_created',
  'token_hash',
  'unprinted',
]);

/** Entities whose sentence says it all. */
const SENTENCE_ONLY = new Set(['report', 'label_batch', 'capture_batch', 'inbox_item', 'file']);

/** `id`, `place_id`, `file_ids`, `thingId`, `attachmentIds`. */
const ID = /(^id$|_ids?$|[a-z]Ids?$)/;

/** Whether a diff field gets a line of its own on `entity`'s row. */
export function fieldShown(key: string, entity?: string): boolean {
  if (entity && SENTENCE_ONLY.has(entity)) return false;
  if (key.startsWith('custom.') || key.startsWith('archived_custom.')) return true;
  return !HIDDEN.has(key) && !ID.test(key);
}

const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** New is new (#140): a field that had no value shows only the one it got, with no arrow. */
export function isNewValue(before: unknown): boolean {
  return isEmpty(before);
}

export { isEmpty as isEmptyValue };
