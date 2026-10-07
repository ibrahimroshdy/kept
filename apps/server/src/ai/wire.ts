/**
 * The "wire" JSON Schema sent to a provider for each extraction mode (spike 2026-09-26 §3,
 * finding 1). What zod generates for `EXTRACTION_SCHEMAS` breaks providers: the bbox tuples
 * become draft-07 `items: [ … ]` arrays that XGrammar-based hosts reject, `z.iso.date()` becomes
 * `format: date` plus a ~300-character regex, and records carry `propertyNames`. The wire form
 * keeps the shape and drops only those:
 * - a tuple becomes `{type: array, items: <first item>, minItems: n, maxItems: n}`;
 * - `format` and `pattern` are removed; a date string says "YYYY-MM-DD" in its description;
 * - `propertyNames` is removed (the record keeps `additionalProperties`).
 *
 * It is sent with `Output.object({schema: jsonSchema(wire)})` and **no validation**, so the raw
 * object comes back and `parseLenient` against the full zod schema drops only what fails (L52);
 * with the zod schema itself, one bad optional field loses the whole answer.
 */
import { type CaptureMode, EXTRACTION_SCHEMAS, ServiceInvoiceExtraction } from '@kept/shared';
import type { JSONSchema7 } from 'ai';
import { z } from 'zod';

type Json = { [key: string]: unknown };

function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (typeof node !== 'object' || node === null) return node;
  const src = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    if (
      key === '$schema' ||
      key === 'pattern' ||
      key === 'propertyNames' ||
      key === 'additionalItems'
    ) {
      continue;
    }
    if (key === 'format') continue;
    if (key === 'items' && Array.isArray(value)) {
      out.items = simplify(value[0] ?? {});
      out.minItems = value.length;
      out.maxItems = value.length;
      continue;
    }
    out[key] = simplify(value);
  }
  if (src.format === 'date') out.description = 'A date, YYYY-MM-DD';
  return out;
}

/**
 * Variants of the wire schema (T11's follow-up), selectable in the evaluation harness:
 * - `simple`: the above; only `lines` is required of a receipt.
 * - `receipt-required`: a receipt's `date` and `currency` are required too, and each date value
 *   carries a short `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` pattern (not zod's ~300-character regex).
 *   Other modes are sent as `simple`.
 *
 * **In use: `receipt-required`** (docs/evals/2026-09-29-groq-receipt-date-currency.md). On the
 * three synthetic receipts with Groq `qwen/qwen3.8-27b` it read the date and the currency 3/3
 * each, where `simple` read them 2/3 and 1/3 (and 0/3 each at temperature 0), with the other
 * fields as right. Its answers were longer (mean 1,107 output tokens against 734), which on a
 * 1,000-a-minute output limit draws Groq's refusals for the next few minutes (pacing.ts). A date
 * and a currency always wait for review (D19), so one the model had to invent is a wrong
 * suggestion, not a stored value. `simple` stays selectable (`--wire simple`).
 */
export const WIRE_VARIANTS = ['simple', 'receipt-required'] as const;
export type WireVariant = (typeof WIRE_VARIANTS)[number];

/** The variant the worker sends. */
export const WIRE_IN_USE: WireVariant = 'receipt-required';

const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

function withDatePattern(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withDatePattern);
  if (typeof node !== 'object' || node === null) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) out[key] = withDatePattern(value);
  if (out.description === 'A date, YYYY-MM-DD') out.pattern = DATE_PATTERN;
  return out;
}

function receiptRequired(simple: JSONSchema7): JSONSchema7 {
  const s = withDatePattern(simple) as JSONSchema7;
  return { ...s, required: [...new Set([...(s.required ?? []), 'date', 'currency'])] };
}

const cache = new Map<string, JSONSchema7>();

/** The provider-portable JSON Schema for a mode. */
export function wireSchema(mode: CaptureMode, variant: WireVariant = WIRE_IN_USE): JSONSchema7 {
  const v = mode === 'receipt' ? variant : 'simple';
  const id = `${mode}:${v}`;
  let s = cache.get(id);
  if (!s) {
    if (v === 'simple') {
      const full = z.toJSONSchema(EXTRACTION_SCHEMAS[mode], { target: 'draft-07', io: 'output' });
      s = simplify(full) as JSONSchema7;
    } else {
      s = receiptRequired(wireSchema(mode, 'simple'));
    }
    cache.set(id, s);
  }
  return s;
}

/**
 * The wire schema of a service invoice (step 5, Q12): RECEIPT's, each line with its optional
 * kind, and RECEIPT's variant (`receipt-required` asks for the date and currency too). Sent under
 * RECEIPT's name (`kept_receipt`), since the ledger task and the mock are RECEIPT's.
 */
export function serviceInvoiceWire(variant: WireVariant = WIRE_IN_USE): JSONSchema7 {
  const id = `service-invoice:${variant}`;
  let s = cache.get(id);
  if (!s) {
    const simple = simplify(
      z.toJSONSchema(ServiceInvoiceExtraction, { target: 'draft-07', io: 'output' }),
    ) as JSONSchema7;
    s = variant === 'simple' ? simple : receiptRequired(simple);
    cache.set(id, s);
  }
  return s;
}

/**
 * The short tag the ledger appends to `prompt_version` for the wire variant actually sent, so the
 * call list and evals can tell a `receipt-required` call from a `simple` one. `simple` adds
 * nothing, which keeps every row written before the variants existed comparable. The tag is short
 * because `llm_calls.prompt_version` is capped at 20 characters (`receipt-v1+req` is 14).
 */
export const WIRE_TAGS: Readonly<Record<WireVariant, string | null>> = Object.freeze({
  simple: null,
  'receipt-required': 'req',
});

/** `prompt_version` as the ledger stores it: the prompt's version plus the wire variant's tag. */
export function ledgerPromptVersion(
  version: string,
  mode: CaptureMode,
  variant: WireVariant = WIRE_IN_USE,
): string {
  const sent = mode === 'receipt' ? variant : 'simple';
  const tag = WIRE_TAGS[sent];
  return tag ? `${version}+${tag}` : version;
}

/** The structured-output name each mode is sent under (`kept_receipt` …); the mock reads it. */
export const wireName = (mode: CaptureMode) => `kept_${mode}` as const;
