/**
 * The code checks after the model (engineering spec §2.1; plan T10; lessons L52, L57). The model
 * and the code never enforce the same rule (L57): the schema (parseLenient, L52) already dropped
 * what doesn't parse; these are the rules only code can apply.
 *
 * - **Below `CONFIDENCE_MIN`, a field is dropped**, not suggested (spike 2026-09-26 finding 6: the
 *   model filled `warranty_terms_printed` with invented text at confidence 0). A reading's value
 *   is the exception: every reading waits for review anyway (D19), and its confidence isn't
 *   trustworthy (finding 4), so a low one changes nothing.
 * - Currency through `mapCurrencyMark` (D136, D189): a code only when unambiguous and enabled; a
 *   bare `$` is ambiguous between USD and CAD, with no preselection.
 * - Receipt lines reconcile with the total within ±1% (with or without the tax), else `flagged`.
 * - Dates are not in the future in the location's time zone, except `expires_on`.
 * - A VIN must look like one (17 characters, no I, O or Q), and one with a check digit (North
 *   American) must pass it (`vinValid`); otherwise it is dropped.
 * - A placeholder ("N/A", "none", "unknown", "not printed") is not a value: dropped.
 * - A thing's quantity is a whole number from 1 to 999; a reading is ≥ 0 and fits numeric(14,3).
 * - Strings are trimmed and capped to their column's limit; aliases keep the location's
 *   languages, at most 20 each, deduplicated through `normalize`.
 * - **An alias is written in its language's own script** (D214; step-7 spike E1): Latin letters
 *   for English, French…, Arabic letters for Arabic, where a Latin acronym ("شاشة LED") may
 *   stand among them. One that isn't ("مودem") is dropped. Latin-script aliases stay
 *   auto-accepted (D19); in any other script, E1 measured a third of the model's aliases wrong
 *   or non-words, so only the first is kept, as a suggestion that waits in the inbox.
 *
 * Pure: no database. The neighbours check of a reading (D112) needs the meter's series, so
 * apply.ts runs it.
 */
import {
  CONFIDENCE_MIN,
  type CurrencyMatch,
  type LabelExtraction,
  mapCurrencyMark,
  normalize,
  type ReadingExtraction,
  type ReceiptExtraction,
  type ServiceInvoiceExtraction,
  type ServiceLineKind,
  type ThingExtraction,
  vinValid,
} from '@kept/shared';

export type Val<T> = { value: T; confidence: number };

export type DropReason =
  | 'schema'
  | 'low_confidence'
  | 'future_date'
  | 'vin_checksum'
  | 'quantity'
  | 'negative'
  | 'too_large'
  | 'not_terms'
  | 'placeholder'
  | 'vin_format'
  /** An alias not written in its language's script (D214). */
  | 'script'
  /** An alias past the one a non-Latin language may suggest (D214). */
  | 'alias_limit';

export type Dropped = { path: string; reason: DropReason };

export type ThingFields = {
  name?: Val<string>;
  brand?: Val<string>;
  model?: Val<string>;
  colour?: Val<string>;
  typeHint?: Val<string>;
  quantity?: Val<number>;
  serial?: Val<string>;
  /** Auto-accepted (D19): the Latin-script languages' aliases. */
  aliases: Record<string, string[]>;
  /** At most one per non-Latin-script language, for review (D214). */
  aliasSuggestions?: AliasSuggestion[];
};

/** An alias that waits in the inbox (D214), with the name's confidence (aliases have none). */
export type AliasSuggestion = { lang: string; value: string; confidence: number };

export type LabelFields = {
  brand?: Val<string>;
  model?: Val<string>;
  serial?: Val<string>;
  vin?: Val<string>;
  plate?: Val<string>;
  documentKind?: Val<string>;
  expiresOn?: Val<string>;
  manufacturedOn?: Val<string>;
};

export type ReceiptLineFields = {
  index: number;
  description: Val<string>;
  quantity?: Val<number>;
  unitPrice?: Val<number>;
  lineTotal?: Val<number>;
  /** A service invoice's line (step 5, Q12): part, labour, fluid or other. */
  kind?: Val<ServiceLineKind>;
};

export type ReceiptFields = {
  vendor?: { name: Val<string>; phone?: string; address?: string };
  date?: Val<string>;
  /** What was printed (`$`, `ج.م`…), and what code decided (null: the mark means nothing). */
  currency?: { seen: string; confidence: number; match: CurrencyMatch | null };
  total?: Val<number>;
  tax?: Val<number>;
  lines: ReceiptLineFields[];
  warrantyTermsPrinted?: Val<string>;
  documentBbox?: [number, number, number, number];
  /** The lines don't add up to the total within ±1% (with or without the tax). */
  flagged: boolean;
};

export type ReadingFields = {
  /** A decimal string that fits numeric(14,3) (meters/check.ts METER_VALUE). */
  value?: Val<string>;
  unit?: Val<'km' | 'mi' | 'h'>;
  display?: 'digital' | 'analog';
};

export type Checked =
  | { mode: 'thing'; fields: ThingFields; dropped: Dropped[] }
  | { mode: 'label'; fields: LabelFields; dropped: Dropped[] }
  | { mode: 'receipt'; fields: ReceiptFields; dropped: Dropped[] }
  | { mode: 'reading'; fields: ReadingFields; dropped: Dropped[] };

export type CheckContext = {
  /** The location's IANA time zone, for "not in the future". */
  timezone: string;
  /** The location's languages, base codes. Aliases in others are dropped. */
  languages: readonly string[];
  /** Currencies enabled on the instance (D168). */
  enabledCurrencies: readonly string[];
  /** Today in the location's time zone (YYYY-MM-DD); computed from `now` when absent. */
  today?: string;
  now?: Date;
};

/** Column limits (things, purchase_lines, brands; validate.ts for aliases). */
export const LIMITS = Object.freeze({
  name: 200,
  brand: 120,
  model: 120,
  serial: 100,
  colour: 60,
  typeHint: 80,
  alias: 200,
  aliasesPerLanguage: 20,
  languages: 10,
  lineDescription: 300,
  vendor: 200,
  plate: 32,
  vin: 32,
});

/** Today's date (YYYY-MM-DD) in `timezone`. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const cap = (s: string, max: number) => s.trim().slice(0, max).trim();

/** What a model writes instead of leaving a field out (a real run, 2026-09-29: "N/A" at 0.95). */
const PLACEHOLDER =
  /^(?:n\/?a|none|null|nil|unknown|not (?:printed|shown|visible|available|applicable)|no warranty(?: terms)?|-+|—|غير متوفر|لا يوجد)$/i;

/**
 * Warranty terms (D55) must be about a warranty: the evaluation run (T11, Groq, 2026-09-29) kept
 * "None printed." and "Thank you for shopping with us" at 0.9, and a sentence the model made up
 * from its own rules at 1.0 ("…is a sign, not a rule for the model…"). Terms need a warranty
 * word in one of Kept's five languages; "no warranty" in any of them, and text that talks about
 * the model or its instructions, are not terms.
 */
const WARRANTY_WORD = /warrant|guarant|ضمان|garanti|gewährleist|garanzi/i;
const WARRANTY_NONE =
  /^(?:none(?: printed)?|no (?:warranty|guarantee)(?: terms)?(?: printed)?|without (?:a )?(?:warranty|guarantee)|بدون ضمان|لا يوجد ضمان|sans garantie|ohne (?:garantie|gewährleistung)|senza garanzia)[.!]?$/i;
const PROMPT_ECHO = /\b(?:the model|instructions?|this field|leave it out|json)\b/i;

export function notWarrantyTerms(text: string): boolean {
  const t = text.trim();
  return !WARRANTY_WORD.test(t) || WARRANTY_NONE.test(t) || PROMPT_ECHO.test(t);
}

/** A VIN (ISO 3779): 17 characters, digits and capitals without I, O and Q. */
const VIN_FORMAT = /^[A-HJ-NPR-Z0-9]{17}$/;

class Collector {
  readonly dropped: Dropped[] = [];
  drop(path: string, reason: DropReason) {
    this.dropped.push({ path, reason });
  }
  /** A confident, non-empty string capped to `max`; undefined (and noted) otherwise. */
  text(v: Val<string> | undefined, path: string, max: number): Val<string> | undefined {
    if (!v) return undefined;
    if (!(v.confidence >= CONFIDENCE_MIN)) {
      this.drop(path, 'low_confidence');
      return undefined;
    }
    const value = cap(v.value, max);
    if (value && PLACEHOLDER.test(value)) {
      this.drop(path, 'placeholder');
      return undefined;
    }
    return value ? { value, confidence: v.confidence } : undefined;
  }
  num(v: Val<number> | undefined, path: string): Val<number> | undefined {
    if (!v) return undefined;
    if (!(v.confidence >= CONFIDENCE_MIN)) {
      this.drop(path, 'low_confidence');
      return undefined;
    }
    return { value: v.value, confidence: v.confidence };
  }
  /** A date that isn't after `today` (unless `future` is allowed). */
  date(
    v: Val<string> | undefined,
    path: string,
    today: string,
    future = false,
  ): Val<string> | undefined {
    const d = this.text(v, path, 10);
    if (!d) return undefined;
    if (!future && d.value > today) {
      this.drop(path, 'future_date');
      return undefined;
    }
    return d;
  }
}

function today(ctx: CheckContext): string {
  return ctx.today ?? todayIn(ctx.timezone, ctx.now);
}

/** Aliases per language, for the location's languages only, deduplicated and capped. */
export function cleanAliases(
  raw: Record<string, string[]>,
  languages: readonly string[],
): Record<string, string[]> {
  const allowed = new Set(languages.map((l) => l.toLowerCase().split('-')[0] as string));
  const out: Record<string, string[]> = {};
  for (const [code, list] of Object.entries(raw)) {
    const lang = code.toLowerCase().split('-')[0] as string;
    if (!/^[a-z]{2,3}$/.test(lang) || !allowed.has(lang)) continue;
    const seen = new Set((out[lang] ?? []).map(normalize));
    const kept = [...(out[lang] ?? [])];
    for (const alias of list) {
      const a = cap(alias, LIMITS.alias);
      const key = normalize(a);
      if (!a || !key || seen.has(key)) continue;
      seen.add(key);
      kept.push(a);
    }
    if (kept.length > 0) out[lang] = kept.slice(0, LIMITS.aliasesPerLanguage);
  }
  return Object.fromEntries(Object.entries(out).slice(0, LIMITS.languages));
}

/** The script each language is written in. A language not listed isn't script-checked, and is
 * treated as not Latin: its first alias is a suggestion. */
const SCRIPT_OF: Readonly<Record<string, Script>> = Object.freeze({
  ...Object.fromEntries(
    'en fr de it es pt nl sv da nb nn no fi is pl cs sk sl hr hu ro tr id ms ca et lv lt'
      .split(' ')
      .map((l) => [l, 'Latin' as const]),
  ),
  ar: 'Arabic',
  fa: 'Arabic',
  ur: 'Arabic',
  ru: 'Cyrillic',
  uk: 'Cyrillic',
  bg: 'Cyrillic',
  el: 'Greek',
  he: 'Hebrew',
});
type Script = 'Latin' | 'Arabic' | 'Cyrillic' | 'Greek' | 'Hebrew';
const IN_SCRIPT: Readonly<Record<Script, RegExp>> = {
  Latin: /\p{Script=Latin}/u,
  Arabic: /\p{Script=Arabic}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Hebrew: /\p{Script=Hebrew}/u,
};
const LETTER = /\p{L}/u;
/** Letters no script owns: the Arabic tatweel, the Japanese long mark… */
const SHARED_LETTER = /[\p{Script=Common}\p{Script=Inherited}]/u;
/** A Latin acronym or model code among another script's words: capitals and digits only. */
const ACRONYM = /^[A-Z0-9]+(?:[-+./&][A-Z0-9]+)*$/;
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Whether the language is written in Latin letters (its aliases are auto-accepted, D214). */
export const latinLanguage = (lang: string) => SCRIPT_OF[lang] === 'Latin';

/**
 * Whether `alias` is written in `lang`'s script: every word's letters are that script's (a word
 * of only digits and marks is neutral), a non-Latin alias may hold a Latin acronym, and at least
 * one word is in the script. A language this table doesn't know passes.
 */
export function inLanguageScript(alias: string, lang: string): boolean {
  const script = SCRIPT_OF[lang];
  if (!script) return true;
  const own = IN_SCRIPT[script];
  let hasOwn = false;
  for (const raw of alias.split(/\s+/)) {
    const word = raw.replace(EDGES, '');
    const letters = [...word].filter((ch) => LETTER.test(ch) && !SHARED_LETTER.test(ch));
    if (letters.length === 0) continue;
    if (letters.every((ch) => own.test(ch))) hasOwn = true;
    else if (script === 'Latin' || !ACRONYM.test(word)) return false;
  }
  return hasOwn;
}

/**
 * D214 over cleaned aliases: those not in their language's script are dropped; Latin-script
 * languages keep theirs (auto-accepted); any other language keeps its first as a suggestion.
 */
export function scriptAliases(
  aliases: Record<string, string[]>,
  confidence: number,
  drop: (path: string, reason: DropReason) => void = () => {},
  path = 'aliases',
): { aliases: Record<string, string[]>; suggestions: AliasSuggestion[] } {
  const out: Record<string, string[]> = {};
  const suggestions: AliasSuggestion[] = [];
  for (const [lang, list] of Object.entries(aliases)) {
    const written = list.filter((a) => {
      if (inLanguageScript(a, lang)) return true;
      drop(`${path}.${lang}`, 'script');
      return false;
    });
    if (written.length === 0) continue;
    if (latinLanguage(lang)) {
      out[lang] = written;
      continue;
    }
    const [first, ...rest] = written as [string, ...string[]];
    suggestions.push({ lang, value: first, confidence });
    for (const _ of rest) drop(`${path}.${lang}`, 'alias_limit');
  }
  return { aliases: out, suggestions };
}

export function checkThing(
  parsed: ThingExtraction,
  ctx: CheckContext,
): Extract<Checked, { mode: 'thing' }> {
  const c = new Collector();
  const o = parsed.objects[0];
  const fields: ThingFields = { aliases: {} };
  if (!o) return { mode: 'thing', fields, dropped: c.dropped };
  const p = 'objects.0';
  const set = <K extends keyof ThingFields>(k: K, v: ThingFields[K] | undefined) => {
    if (v !== undefined) fields[k] = v;
  };
  set('name', c.text(o.name, `${p}.name`, LIMITS.name));
  set('brand', c.text(o.brand, `${p}.brand`, LIMITS.brand));
  set('model', c.text(o.model, `${p}.model`, LIMITS.model));
  set('colour', c.text(o.colour, `${p}.colour`, LIMITS.colour));
  set('typeHint', c.text(o.type_hint, `${p}.type_hint`, LIMITS.typeHint));
  set('serial', c.text(o.serial, `${p}.serial`, LIMITS.serial));
  const q = c.num(o.quantity, `${p}.quantity`);
  if (q) {
    if (Number.isInteger(q.value) && q.value >= 1 && q.value <= 999) fields.quantity = q;
    else c.drop(`${p}.quantity`, 'quantity');
  }
  // Aliases carry no confidence of their own: they follow the name's (D41). An unreadable name
  // means the model doesn't know what this is, and its keywords would mislead search.
  // D214: Latin-script aliases auto-accepted, others one suggestion each, the rest dropped.
  if (fields.name) {
    const scripted = scriptAliases(
      cleanAliases(o.aliases, ctx.languages),
      fields.name.confidence,
      (path, reason) => c.drop(path, reason),
      `${p}.aliases`,
    );
    fields.aliases = scripted.aliases;
    if (scripted.suggestions.length > 0) fields.aliasSuggestions = scripted.suggestions;
  } else if (Object.keys(o.aliases).length > 0) c.drop(`${p}.aliases`, 'low_confidence');
  return { mode: 'thing', fields, dropped: c.dropped };
}

export function checkLabel(
  parsed: LabelExtraction,
  ctx: CheckContext,
): Extract<Checked, { mode: 'label' }> {
  const c = new Collector();
  const day = today(ctx);
  const fields: LabelFields = {};
  const set = <K extends keyof LabelFields>(k: K, v: LabelFields[K] | undefined) => {
    if (v !== undefined) fields[k] = v;
  };
  set('brand', c.text(parsed.brand, 'brand', LIMITS.brand));
  set('model', c.text(parsed.model, 'model', LIMITS.model));
  set('serial', c.text(parsed.serial, 'serial', LIMITS.serial));
  const vin = c.text(parsed.vin, 'vin', LIMITS.vin);
  if (vin) {
    const compact = vin.value.replace(/[\s-]/g, '').toUpperCase();
    // A real run (2026-09-29) put the model code in `vin` at 0.99: a VIN has its own format.
    if (!VIN_FORMAT.test(compact)) c.drop('vin', 'vin_format');
    else if (vinValid(compact) === false) c.drop('vin', 'vin_checksum');
    else fields.vin = { value: compact, confidence: vin.confidence };
  }
  set('plate', c.text(parsed.plate, 'plate', LIMITS.plate));
  set('documentKind', c.text(parsed.document_kind, 'document_kind', 20));
  set('expiresOn', c.date(parsed.expires_on, 'expires_on', day, true));
  set('manufacturedOn', c.date(parsed.manufactured_on, 'manufactured_on', day));
  return { mode: 'label', fields, dropped: c.dropped };
}

/** Whether `sum` is within ±1% of `total`. */
const within = (sum: number, total: number) => Math.abs(sum - total) <= Math.abs(total) * 0.01;

export function checkReceipt(
  parsed: ReceiptExtraction | ServiceInvoiceExtraction,
  ctx: CheckContext,
): Extract<Checked, { mode: 'receipt' }> {
  const c = new Collector();
  const day = today(ctx);
  const fields: ReceiptFields = { lines: [], flagged: false };
  if (parsed.vendor) {
    const name = c.text(parsed.vendor.name, 'vendor.name', LIMITS.vendor);
    if (name) {
      fields.vendor = {
        name,
        ...(parsed.vendor.phone ? { phone: cap(parsed.vendor.phone, 40) } : {}),
        ...(parsed.vendor.address ? { address: cap(parsed.vendor.address, 300) } : {}),
      };
    }
  }
  const date = c.date(parsed.date, 'date', day);
  if (date) fields.date = date;
  const seen = c.text(parsed.currency, 'currency', 12);
  if (seen) {
    fields.currency = {
      seen: seen.value,
      confidence: seen.confidence,
      match: mapCurrencyMark(seen.value, {
        languages: ctx.languages,
        enabled: ctx.enabledCurrencies,
        ...(parsed.vendor?.address ? { addressText: parsed.vendor.address } : {}),
      }),
    };
  }
  const total = c.num(parsed.total, 'total');
  if (total) fields.total = total;
  const tax = c.num(parsed.tax, 'tax');
  if (tax) fields.tax = tax;
  parsed.lines.forEach((l, i) => {
    const p = `lines.${i}`;
    const description = c.text(l.description, `${p}.description`, LIMITS.lineDescription);
    if (!description) return;
    const line: ReceiptLineFields = { index: fields.lines.length, description };
    const quantity = c.num(l.quantity, `${p}.quantity`);
    if (quantity) line.quantity = quantity;
    const unitPrice = c.num(l.unit_price, `${p}.unit_price`);
    if (unitPrice) line.unitPrice = unitPrice;
    const lineTotal = c.num(l.line_total, `${p}.line_total`);
    if (lineTotal) line.lineTotal = lineTotal;
    // A service invoice's kind (the schema already dropped one outside the list): below the
    // confidence floor it is dropped, and the person picks it.
    const kind = (l as { kind?: Val<ServiceLineKind> }).kind;
    if (kind && kind.confidence >= CONFIDENCE_MIN) line.kind = kind;
    else if (kind) c.drop(`${p}.kind`, 'low_confidence');
    fields.lines.push(line);
  });
  const warranty = c.text(parsed.warranty_terms_printed, 'warranty_terms_printed', 2000);
  // A real run (2026-09-29) copied an item's name into the terms at 0.95: a line's description
  // is never warranty terms.
  const items = new Set(fields.lines.map((l) => normalize(l.description.value)));
  if (warranty && (items.has(normalize(warranty.value)) || notWarrantyTerms(warranty.value)))
    c.drop('warranty_terms_printed', 'not_terms');
  else if (warranty) fields.warrantyTermsPrinted = warranty;
  if (parsed.document_bbox) fields.documentBbox = parsed.document_bbox;

  // Reconcile: every line needs an amount, and there must be a total to compare with.
  if (fields.total && fields.lines.length > 0) {
    const amounts = fields.lines.map(lineAmount);
    if (amounts.some((a) => a === null)) fields.flagged = true;
    else {
      const sum = (amounts as number[]).reduce((a, b) => a + b, 0);
      const t = fields.total.value;
      fields.flagged = !(within(sum, t) || (fields.tax && within(sum + fields.tax.value, t)));
    }
  }
  return { mode: 'receipt', fields, dropped: c.dropped };
}

/** A line's amount: its total, else unit price × quantity (1 when not read); null when neither. */
export function lineAmount(l: ReceiptLineFields): number | null {
  if (l.lineTotal) return l.lineTotal.value;
  if (l.unitPrice) return l.unitPrice.value * (l.quantity?.value ?? 1);
  return null;
}

/** A number as numeric(14,3) text: rounded to thousandths, no trailing zeros. */
export function meterValueText(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null;
  const fixed = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return /^\d{1,11}(\.\d{1,3})?$/.test(fixed) ? fixed : null;
}

export function checkReading(
  parsed: ReadingExtraction,
  _ctx: CheckContext,
): Extract<Checked, { mode: 'reading' }> {
  const c = new Collector();
  const fields: ReadingFields = {};
  const text = meterValueText(parsed.value.value);
  if (text === null) c.drop('value', parsed.value.value < 0 ? 'negative' : 'too_large');
  else fields.value = { value: text, confidence: parsed.value.confidence };
  if (parsed.unit) {
    if (parsed.unit.confidence >= CONFIDENCE_MIN) fields.unit = parsed.unit;
    else c.drop('unit', 'low_confidence');
  }
  if (parsed.display) fields.display = parsed.display;
  return { mode: 'reading', fields, dropped: c.dropped };
}

type ParsedByMode = {
  thing: ThingExtraction;
  label: LabelExtraction;
  receipt: ReceiptExtraction;
  reading: ReadingExtraction;
};

/** The checks for `mode`, with parseLenient's own drops listed first (reason `schema`). */
export function check<M extends keyof ParsedByMode>(
  mode: M,
  parsed: ParsedByMode[M],
  schemaDropped: readonly string[],
  ctx: CheckContext,
): Checked {
  const out =
    mode === 'thing'
      ? checkThing(parsed as ThingExtraction, ctx)
      : mode === 'label'
        ? checkLabel(parsed as LabelExtraction, ctx)
        : mode === 'receipt'
          ? checkReceipt(parsed as ReceiptExtraction, ctx)
          : checkReading(parsed as ReadingExtraction, ctx);
  out.dropped.unshift(...schemaDropped.map((path) => ({ path, reason: 'schema' as const })));
  return out;
}
