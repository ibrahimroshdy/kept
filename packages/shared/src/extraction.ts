/**
 * Extraction output per capture mode (engineering spec §2.1, §7.8; D19, D20, D41, D55, D128;
 * lessons L42, L51, L52; plan Q6, Q11). The model returns JSON only. Every field carries a
 * confidence from 0 to 1. The model never returns IDs or URLs (L51), so free text that looks
 * like either fails its field. What fails is dropped one field at a time (`parseLenient`, L52),
 * never the whole answer.
 *
 * Field names are the model's (snake_case, as in §2.1), not the API's: the extraction job maps
 * them onto thing and purchase fields (`type_hint` → type, `date` → purchased_on, …).
 */

import { z } from 'zod';
import type { ReasoningLevel } from './ai.js';
import type { CaptureMode } from './capture.js';
import { SERVICE_LINE_KINDS } from './household.js';

/** `extractions.status` (§7.8; `waiting_provider` is D206's: the provider's rate limit, an open
 * breaker or a rejected key, never a budget). The database CHECK reads this list (0037). */
export const EXTRACTION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'paused_budget',
  'waiting_provider',
  'no_provider',
  'superseded',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** `Conf<T>`: a value and how sure the model is of it. */
export function conf<T extends z.ZodType>(value: T) {
  return z.object({ value, confidence: z.number().min(0).max(1) });
}
export type Conf<T> = { value: T; confidence: number };

const URL_OR_ID = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !URL_OR_ID.test(s), 'no URLs or ids (L51)');
const unit = z.number().min(0).max(1);
/** `[x, y, w, h]`, each 0–1, relative to the photo. */
const bbox = z.tuple([unit, unit, unit, unit]);
const isoDate = z.iso.date();
const amount = z.number().min(0).max(1e12);
const count = z.number().positive().max(1e6);
const languageCode = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);

export const ThingObject = z.object({
  bbox: bbox.optional(),
  name: conf(text(200)),
  brand: conf(text(120)).optional(),
  model: conf(text(120)).optional(),
  colour: conf(text(60)).optional(),
  type_hint: conf(text(80)).optional(),
  quantity: conf(count).optional(),
  serial: conf(text(120)).optional(),
  /** In each of the location's languages (D41). */
  aliases: z.record(languageCode, z.array(text(80)).max(12)),
});

/** THING: one object in 1.0; many objects is 1.x (D20). */
export const ThingExtraction = z.object({ objects: z.array(ThingObject).max(1) });

const ReceiptLine = z.object({
  description: conf(text(300)),
  quantity: conf(count).optional(),
  unit_price: conf(amount).optional(),
  line_total: conf(amount).optional(),
});

export const ReceiptExtraction = z.object({
  vendor: z
    .object({
      name: conf(text(200)),
      phone: text(40).optional(),
      address: text(300).optional(),
    })
    .optional(),
  date: conf(isoDate).optional(),
  /** What was printed (`$`, `E£`, `EUR`…); `mapCurrencyMark` turns it into a code (D189). */
  currency: conf(text(12)).optional(),
  total: conf(amount).optional(),
  tax: conf(amount).optional(),
  lines: z.array(ReceiptLine).max(200),
  /** Only when printed on the receipt (D55). */
  warranty_terms_printed: conf(text(2000)).optional(),
  /** Where the paper is in the photo, so the server can re-crop the display (Q11, D196). */
  document_bbox: bbox.optional(),
});

/**
 * A service invoice (step 5, Q12): RECEIPT's fields, and each line's optional kind (step 4's
 * `service_lines.kind`). Not a capture mode: the RECEIPT path runs it on a draft service record
 * with the `service-invoice` prompt, and its output only ever becomes suggestions. Its JSON
 * allowance is RECEIPT's (`MAX_OUTPUT_TOKENS.receipt`). A kind outside the list is dropped alone
 * (`parseLenient`, L52); the line stays.
 */
export const ServiceInvoiceExtraction = ReceiptExtraction.extend({
  lines: z
    .array(ReceiptLine.extend({ kind: conf(z.enum(SERVICE_LINE_KINDS)).optional() }))
    .max(200),
});

export const LabelExtraction = z.object({
  brand: conf(text(120)).optional(),
  model: conf(text(120)).optional(),
  serial: conf(text(120)).optional(),
  vin: conf(text(32)).optional(),
  plate: conf(text(32)).optional(),
  document_kind: conf(
    z.enum(['registration', 'insurance', 'licence', 'inspection', 'other']),
  ).optional(),
  expires_on: conf(isoDate).optional(),
  manufactured_on: conf(isoDate).optional(),
});

export const ReadingExtraction = z.object({
  value: conf(z.number().min(0).max(1e9)),
  unit: conf(z.enum(['km', 'mi', 'h'])).optional(),
  display: z.enum(['digital', 'analog']).optional(),
});

export const EXTRACTION_SCHEMAS = Object.freeze({
  thing: ThingExtraction,
  receipt: ReceiptExtraction,
  label: LabelExtraction,
  reading: ReadingExtraction,
} satisfies Record<CaptureMode, z.ZodType>);

export type ThingExtraction = z.output<typeof ThingExtraction>;
export type ReceiptExtraction = z.output<typeof ReceiptExtraction>;
export type LabelExtraction = z.output<typeof LabelExtraction>;
export type ReadingExtraction = z.output<typeof ReadingExtraction>;
export type ServiceInvoiceExtraction = z.output<typeof ServiceInvoiceExtraction>;

/** Filled in without asking when confident enough (D19, D41, D128). */
export const AUTO_ACCEPT = ['name', 'brand', 'model', 'type', 'colour', 'aliases'] as const;
/** Always wait for a person (D19). A quantity of 1 is the default and doesn't wait. */
export const REVIEW_FIELDS = [
  'serial',
  'quantity',
  'price',
  'purchased_on',
  'warranty',
  'reading',
  'vendor',
  'currency',
] as const;
/** Below this, even an auto-accept field waits (§2.1, §3.4). Tunable. */
export const CONFIDENCE_MIN = 0.6;

/**
 * Whether an extracted field waits in the inbox. Unknown fields wait: auto-accepting is the
 * exception that has to be listed.
 */
export function needsReview(field: string, confidence: number, value?: unknown): boolean {
  if (!(confidence >= CONFIDENCE_MIN)) return true;
  if (field === 'quantity') return !(Number(value) === 1);
  return !(AUTO_ACCEPT as readonly string[]).includes(field);
}

/**
 * The inbox field an alias suggestion goes by (D214: an Arabic alias waits for review): its
 * language's base code after `alias_`, e.g. `alias_ar`. Its value is the alias.
 */
export const aliasSuggestionField = (lang: string): string => `alias_${lang}`;

/** The language of an alias suggestion's field, or null for any other field. */
export function aliasSuggestionLanguage(field: string): string | null {
  return /^alias_([a-z]{2,3})$/.exec(field)?.[1] ?? null;
}

/** The JSON allowance per mode, before reasoning (Q6). */
export const MAX_OUTPUT_TOKENS: Readonly<Record<CaptureMode, number>> = Object.freeze({
  thing: 700,
  receipt: 2500,
  label: 600,
  reading: 200,
});

/** Reasoning tokens billed against `maxOutputTokens` (L42, Q6). */
export const REASONING_ALLOWANCE: Readonly<Record<ReasoningLevel, number>> = Object.freeze({
  none: 0,
  minimal: 512,
  low: 2048,
  medium: 6144,
  high: 16384,
});

/** The `maxOutputTokens` sent: JSON allowance plus reasoning allowance. A `length` stop fails. */
export function outputTokenCap(mode: CaptureMode, reasoning: ReasoningLevel): number {
  return MAX_OUTPUT_TOKENS[mode] + REASONING_ALLOWANCE[reasoning];
}

// ---------------------------------------------------------------------------------------------

type Lenient = { ok: true; value: unknown; dropped: string[] } | { ok: false };
const FAIL: Lenient = { ok: false };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The array's max length when that is the only reason `items` failed. */
function tooBigMax(schema: z.ZodType, items: unknown[]): number | null {
  const r = schema.safeParse(items);
  if (r.success) return null;
  const issue = r.error.issues[0];
  return r.error.issues.length === 1 && issue?.code === 'too_big' && issue.path.length === 0
    ? Number(issue.maximum)
    : null;
}

function lenient(schema: z.ZodType, raw: unknown, path: string): Lenient {
  const direct = schema.safeParse(raw);
  if (direct.success) return { ok: true, value: direct.data, dropped: [] };

  if (schema instanceof z.ZodOptional) {
    return raw === undefined
      ? { ok: true, value: undefined, dropped: [] }
      : lenient(schema.unwrap() as z.ZodType, raw, path);
  }
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key));

  if (schema instanceof z.ZodObject && isPlainObject(raw)) {
    const out: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      const r = lenient(field, raw[key], at(key));
      if (r.ok) {
        if (r.value !== undefined) out[key] = r.value;
        dropped.push(...r.dropped);
      } else if (field instanceof z.ZodOptional) {
        dropped.push(at(key));
      } else {
        return FAIL;
      }
    }
    const check = schema.safeParse(out);
    return check.success ? { ok: true, value: check.data, dropped } : FAIL;
  }

  if (schema instanceof z.ZodArray && Array.isArray(raw)) {
    let items: unknown[] = [];
    const dropped: string[] = [];
    raw.forEach((item, i) => {
      const r = lenient(schema.element as z.ZodType, item, at(i));
      if (r.ok) {
        items.push(r.value);
        dropped.push(...r.dropped);
      } else dropped.push(at(i));
    });
    const max = tooBigMax(schema, items);
    if (max !== null) {
      // Cut from the end; the paths name the original indexes that were kept up to `max`.
      const keptIndexes = raw.map((_, i) => i).filter((i) => !dropped.includes(at(i)));
      for (const i of keptIndexes.slice(max)) dropped.push(at(i));
      items = items.slice(0, max);
      dropped.sort();
    }
    const check = schema.safeParse(items);
    return check.success ? { ok: true, value: check.data, dropped } : FAIL;
  }

  if (schema instanceof z.ZodRecord && isPlainObject(raw)) {
    const out: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(raw)) {
      const k = (schema.keyType as z.ZodType).safeParse(key);
      const r = k.success ? lenient(schema.valueType as z.ZodType, value, at(key)) : FAIL;
      if (r.ok) {
        out[key] = r.value;
        dropped.push(...r.dropped);
      } else dropped.push(at(key));
    }
    const check = schema.safeParse(out);
    return check.success ? { ok: true, value: check.data, dropped } : FAIL;
  }

  return FAIL;
}

/**
 * Parses a model's answer, dropping each field that fails instead of failing the whole object
 * (L52): an optional field that fails is left out, a list item that fails is removed, a list
 * over its maximum is cut to it, and unknown keys are ignored. Null when what is left can't
 * satisfy the schema (a required field failed, or it isn't an object at all). `dropped` lists
 * the dotted paths removed, for the call log and the evaluation harness.
 */
export function parseLenient<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): { value: z.output<S>; dropped: string[] } | null {
  const r = lenient(schema, raw, '');
  return r.ok ? { value: r.value as z.output<S>, dropped: r.dropped } : null;
}
