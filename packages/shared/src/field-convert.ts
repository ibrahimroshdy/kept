/**
 * Converting a custom field (step-2 Q3, D172, D177; step-7 plan T1, T18, T24): to or from secret,
 * or to another kind, always through a preview. Only the account owner converts, for every
 * location that uses the type (plan Q20); a value that can't become the new kind goes to the
 * thing's notes as "<label>: <value>".
 */
import type { FieldKind } from './inventory.js';

/** Which kind each kind may become. `money`, `person`, `vendor` and `file` become nothing: 400
 * `field_convert_blocked`. Secret is a flag on a text field, not a kind (Q3): see
 * `canConvertSecret`. */
export const CONVERSIONS: Readonly<Record<FieldKind, readonly FieldKind[]>> = Object.freeze({
  text: ['number', 'date', 'url', 'select'],
  number: ['text'],
  date: ['text'],
  select: ['text', 'multi_select'],
  multi_select: [],
  boolean: ['text'],
  url: [],
  money: [],
  person: [],
  vendor: [],
  file: [],
});

/** Whether a field of kind `from` may become kind `to`. */
export function canConvertKind(from: FieldKind, to: FieldKind): boolean {
  return CONVERSIONS[from].includes(to);
}

/** Only a text field is made secret or plain (text ⇄ secret). */
export function canConvertSecret(kind: FieldKind): boolean {
  return kind === 'text';
}

/** POST /type-fields/:id/convert(/preview): to or from secret, or to another kind with its
 * options (a select's choices) or unit (a number's). */
export type ConvertFieldBody =
  | { toSecret: boolean }
  | { kind: FieldKind; options?: string[]; unit?: string };

/** The preview, per location: counts only, never a value. A location the caller can't see
 * appears with no name (D123). */
export type ConvertPreview = {
  locations: {
    id: string;
    name: string | null;
    /** Things and places holding a value. */
    values: number;
    /** Values that become the new kind. */
    convertible: number;
    /** Values that go to the notes instead. */
    toNotes: number;
  }[];
  total: number;
};

/** POST /type-fields/:id/convert. Not undoable (a secret-class change, screens §8). */
export type ConvertResult = { converted: number; toNotes: number };
