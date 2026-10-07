/**
 * The edit form's model, kept pure so the D156 merge can be tested without a screen.
 *
 * A thing's editable values live in "form space": text as strings (numbers too, as typed, so
 * "٢" and "2" are both fine until Save), booleans, string lists for repeatable fields, money as
 * `{amount, currency}`, and `null` for an empty date or choice. The three-way merge
 * (lib/three-way.ts) runs in form space: `base` is what the edit started from, `mine` the form,
 * `theirs` the latest version read after a 412. `toPatch(from, to)` turns the difference into
 * the PATCH body, converting back to wire types.
 */
import { AmountError, parseAmount } from '@kept/shared';
import type { Condition, ResolvedField, ThingView, UpdateThingBody } from '@/api/inventory/types';

export type Money = { amount: string; currency: string };
export type FormValue = string | boolean | string[] | Money | null;
export type FormValues = {
  name: string;
  quantity: string;
  brandId: string | null;
  model: string;
  serial: string;
  barcode: string;
  colour: string;
  condition: Condition | null;
  notes: string;
  manualUrl: string;
  expiresOn: string | null;
  custom: Record<string, FormValue>;
};

export const BUILTIN_KEYS = [
  'name',
  'quantity',
  'brandId',
  'model',
  'serial',
  'barcode',
  'colour',
  'condition',
  'notes',
  'manualUrl',
  'expiresOn',
] as const satisfies readonly (keyof FormValues)[];

/** The kinds the step-2 form edits; person, vendor and file fields are shown read-only. */
const EDITABLE_KINDS = new Set([
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'boolean',
  'url',
  'money',
]);

/** The type's fields the form offers: not secret (those have their own store), not archived. */
export function editableFields(fields: readonly ResolvedField[]): ResolvedField[] {
  return [...fields]
    .filter((f) => !f.secret && !f.archivedAt && EDITABLE_KINDS.has(f.kind))
    .sort((a, b) => a.sort - b.sort);
}

/** The merge's field list: the built-in keys, then `custom.<key>` for each editable field. */
export function mergeFields(fields: readonly ResolvedField[]): string[] {
  return [...BUILTIN_KEYS, ...editableFields(fields).map((f) => `custom.${f.key}`)];
}

function toForm(field: ResolvedField, raw: unknown): FormValue {
  if (raw === undefined || raw === null) {
    if (field.kind === 'boolean') return false;
    if (field.kind === 'multi_select' || field.repeatable) return [];
    if (field.kind === 'date' || field.kind === 'select' || field.kind === 'money') return null;
    return '';
  }
  if (field.kind === 'multi_select' || field.repeatable)
    return (Array.isArray(raw) ? raw : [raw]).map(String);
  if (field.kind === 'boolean') return raw === true;
  if (field.kind === 'money' && typeof raw === 'object') return raw as Money;
  return String(raw);
}

export function formValues(thing: ThingView): FormValues {
  const custom: Record<string, FormValue> = {};
  for (const f of editableFields(thing.fields)) custom[f.key] = toForm(f, thing.custom[f.key]);
  return {
    name: thing.name ?? '',
    quantity: String(thing.quantity),
    brandId: thing.brand?.id ?? null,
    model: thing.model ?? '',
    serial: thing.serial ?? '',
    barcode: thing.barcode ?? '',
    colour: thing.colour ?? '',
    condition: thing.condition,
    notes: thing.notes ?? '',
    manualUrl: thing.manualUrl ?? '',
    expiresOn: thing.expiresOn,
    custom,
  };
}

const LOCAL_DIGITS = /[٠-٩۰-۹]/g;
/** Eastern Arabic and Persian digits to 0–9, and `٫` to `.` (D172). */
export function westernNumber(s: string): string {
  return s
    .trim()
    .replace(LOCAL_DIGITS, (d) => {
      const c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .replace(/٫/g, '.')
    .replace(/[٬,]/g, '');
}

export function parseNumber(s: string): number | null {
  const w = westernNumber(s);
  if (w === '') return null;
  return /^-?\d+(\.\d+)?$/.test(w) ? Number(w) : Number.NaN;
}

export type FieldErrors = Record<string, string>;

export type Messages = {
  nameRequired: string;
  tooLong: (max: number) => string;
  number: string;
  quantity: string;
  url: string;
  amount: string;
};

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** Errors for the fields that changed (D172: "required" applies to new edits only). */
export function validate(
  from: FormValues,
  to: FormValues,
  fields: readonly ResolvedField[],
  m: Messages,
): FieldErrors {
  const e: FieldErrors = {};
  if (to.name.trim() === '') e.name = m.nameRequired;
  else if (to.name.trim().length > 200) e.name = m.tooLong(200);
  const q = parseNumber(to.quantity);
  if (
    differs(from.quantity, to.quantity) &&
    (q === null || Number.isNaN(q) || q < 0 || !Number.isInteger(q))
  )
    e.quantity = m.quantity;
  if (to.notes.length > 5000) e.notes = m.tooLong(5000);
  if (to.serial.length > 100) e.serial = m.tooLong(100);
  if (
    to.manualUrl &&
    differs(from.manualUrl, to.manualUrl) &&
    !/^https?:\/\/\S+$/i.test(to.manualUrl.trim())
  )
    e.manualUrl = m.url;
  for (const f of editableFields(fields)) {
    const v = to.custom[f.key];
    if (!differs(from.custom[f.key], v)) continue;
    if (f.kind === 'number' && typeof v === 'string' && Number.isNaN(parseNumber(v) ?? 0))
      e[`custom.${f.key}`] = m.number;
    if (f.kind === 'url' && typeof v === 'string' && v && !/^https?:\/\/\S+$/i.test(v.trim()))
      e[`custom.${f.key}`] = m.url;
    if (f.kind === 'money' && v && typeof v === 'object' && !Array.isArray(v)) {
      try {
        parseAmount(v.amount);
      } catch (err) {
        if (err instanceof AmountError) e[`custom.${f.key}`] = m.amount;
        else throw err;
      }
    }
    if (f.required && (v === '' || v === null || (Array.isArray(v) && v.length === 0)))
      e[`custom.${f.key}`] = m.nameRequired;
  }
  return e;
}

const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim());

function fromForm(field: ResolvedField, v: FormValue): unknown {
  if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) return null;
  if (field.kind === 'number') {
    if (Array.isArray(v)) return v.map((x) => parseNumber(x));
    return parseNumber(v as string);
  }
  if (field.kind === 'money' && typeof v === 'object' && !Array.isArray(v))
    return { amount: parseAmount(v.amount), currency: v.currency };
  if (typeof v === 'string') return v.trim();
  return v;
}

/** The PATCH body that turns `from` into `to`: only what changed, in wire types. */
export function toPatch(
  from: FormValues,
  to: FormValues,
  fields: readonly ResolvedField[],
): UpdateThingBody {
  const b: UpdateThingBody = {};
  if (differs(from.name, to.name)) b.name = to.name.trim();
  if (differs(from.quantity, to.quantity)) b.quantity = parseNumber(to.quantity) ?? 0;
  if (differs(from.brandId, to.brandId)) b.brandId = to.brandId;
  if (differs(from.model, to.model)) b.model = blankToNull(to.model);
  if (differs(from.serial, to.serial)) b.serial = blankToNull(to.serial);
  if (differs(from.barcode, to.barcode)) b.barcode = blankToNull(to.barcode);
  if (differs(from.colour, to.colour)) b.colour = blankToNull(to.colour);
  if (differs(from.condition, to.condition)) b.condition = to.condition;
  if (differs(from.notes, to.notes)) b.notes = blankToNull(to.notes);
  if (differs(from.manualUrl, to.manualUrl)) b.manualUrl = blankToNull(to.manualUrl);
  if (differs(from.expiresOn, to.expiresOn)) b.expiresOn = to.expiresOn;
  const custom: Record<string, unknown> = {};
  for (const f of editableFields(fields)) {
    const v = to.custom[f.key] ?? null;
    if (differs(from.custom[f.key], v)) custom[f.key] = fromForm(f, v);
  }
  if (Object.keys(custom).length) b.custom = custom;
  return b;
}

export const isEmptyPatch = (b: UpdateThingBody) => Object.keys(b).length === 0;
