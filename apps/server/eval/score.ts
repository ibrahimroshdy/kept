/**
 * Scoring for the extraction evaluation (plan T11; V1, V2, V3, V37; D19, D129). Pure: no I/O.
 *
 * A case's expected values are the §2.1 shape without confidences. `{"anyOf": [...]}` lists the
 * acceptable answers; `null` means the field must be left out; a field not listed isn't scored.
 * Each field is compared by its kind:
 * - text: equal after `normalize()` (D42: case, Arabic letter forms and Arabic-Indic digits
 *   folded), or a token ratio ≥ 0.9 (below);
 * - code (model, serial, VIN, plate): equal after `normalize()` with the spaces removed;
 * - number: within 0.5%; a reading, a quantity and an enum: exact; a date: exact (YYYY-MM-DD);
 * - currency: the code, or the same ambiguity (`{"ambiguous": ["USD","CAD"]}`, D189), from what
 *   `mapCurrencyMark` made of the printed mark;
 * - aliases: at least one expected alias per expected language (D41);
 * - lines: the same number of lines, each matching in order on the fields the case lists.
 *
 * **The token ratio.** The plan says "token-set ratio". In the usual (fuzzywuzzy) definition a
 * subset scores 100: "STORE" would match "CAIRO HOME STORE". Here the ratio compares the full
 * token sets only (the shared tokens sorted, then each side's own tokens sorted), with a
 * Levenshtein similarity, so reordered words still match and a fragment doesn't. Acceptable
 * short forms go in `anyOf`.
 *
 * Every field is scored twice: on the **raw** answer (after `parseLenient`, before the code
 * checks), which is what the model said and what calibration measures; and on the **checked**
 * fields (checks.ts), which is what Kept stores or suggests, and what accuracy, precision,
 * recall and the false-accept rate measure.
 */
import {
  CONFIDENCE_MIN,
  type CurrencyMatch,
  type LabelExtraction,
  mapCurrencyMark,
  normalize,
  type ReadingExtraction,
  type ReceiptExtraction,
  SUPPORTED_DEFAULT,
  type ThingExtraction,
} from '@kept/shared';
import type { Checked, Dropped } from '../src/extraction/checks.js';

// --- Field kinds ---------------------------------------------------------------------------------

export type FieldKind =
  | 'text'
  | 'code'
  | 'number'
  | 'exact'
  | 'date'
  | 'currency'
  | 'aliases'
  | 'lines';

export type ScoredMode = 'thing' | 'receipt' | 'label' | 'reading';

export const FIELDS: Readonly<Record<ScoredMode, Readonly<Record<string, FieldKind>>>> = {
  thing: {
    name: 'text',
    brand: 'text',
    model: 'code',
    colour: 'text',
    type_hint: 'text',
    quantity: 'exact',
    serial: 'code',
    aliases: 'aliases',
  },
  receipt: {
    vendor: 'text',
    date: 'date',
    currency: 'currency',
    total: 'number',
    tax: 'number',
    lines: 'lines',
    warranty_terms_printed: 'text',
  },
  label: {
    brand: 'text',
    model: 'code',
    serial: 'code',
    vin: 'code',
    plate: 'code',
    document_kind: 'exact',
    expires_on: 'date',
    manufactured_on: 'date',
  },
  reading: { value: 'exact', unit: 'exact', display: 'exact' },
};

/** Filled in without asking when confident (D19; shared AUTO_ACCEPT, with `type` as the hint). */
export const AUTO_ACCEPT_FIELDS: Readonly<Record<ScoredMode, readonly string[]>> = {
  thing: ['name', 'brand', 'model', 'colour', 'type_hint', 'aliases'],
  label: ['brand', 'model'],
  receipt: [],
  reading: [],
};

// --- Comparisons -----------------------------------------------------------------------------

/** Levenshtein similarity, 1 − distance / longer length. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return 1 - (prev[m] as number) / Math.max(n, m);
}

const tokens = (s: string) => [
  ...new Set(
    normalize(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  ),
];

/** The token ratio described in the header (full sets, shared tokens first). */
export function tokenSetRatio(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const shared = ta.filter((t) => tb.includes(t)).sort();
  const onlyA = ta.filter((t) => !tb.includes(t)).sort();
  const onlyB = tb.filter((t) => !ta.includes(t)).sort();
  return similarity([...shared, ...onlyA].join(' '), [...shared, ...onlyB].join(' '));
}

export function sameText(expected: string, got: string): boolean {
  const e = normalize(expected);
  const g = normalize(got);
  return e === g || tokenSetRatio(expected, got) >= 0.9;
}

export function sameCode(expected: string, got: string): boolean {
  const compact = (s: string) => normalize(s).replace(/\s+/g, '');
  return compact(expected) === compact(got);
}

export function sameNumber(expected: number, got: number, tolerance = 0.005): boolean {
  if (!Number.isFinite(got)) return false;
  if (expected === 0) return got === 0;
  return Math.abs(got - expected) <= Math.abs(expected) * tolerance;
}

export type Bbox = [number, number, number, number];

/** Intersection over union of two `[x, y, w, h]` boxes. */
export function iou(a: Bbox, b: Bbox): number {
  const inter = intersection(a, b);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function intersection(a: Bbox, b: Bbox): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The share of `truth` that `box` contains (1: nothing of the truth is outside the box). */
export function coverage(box: Bbox, truth: Bbox): number {
  const area = truth[2] * truth[3];
  return area > 0 ? intersection(box, truth) / area : 0;
}

// --- Expected values ---------------------------------------------------------------------------

type AnyOf = { anyOf: unknown[] };
const isAnyOf = (v: unknown): v is AnyOf =>
  typeof v === 'object' && v !== null && Array.isArray((v as AnyOf).anyOf);

/** What one expected field says: a value (or alternatives), or "must be absent". */
export type ExpectedField = { absent: true } | { absent: false; options: unknown[] };

function expectedField(v: unknown): ExpectedField | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { absent: true };
  return { absent: false, options: isAnyOf(v) ? v.anyOf : [v] };
}

/** The expected fields of a case, by field name. THING reads `objects[0]` (or the top level). */
export function expectedFields(
  mode: ScoredMode,
  expected: Record<string, unknown>,
): Record<string, ExpectedField> {
  const src =
    mode === 'thing' && Array.isArray(expected.objects)
      ? ((expected.objects[0] ?? {}) as Record<string, unknown>)
      : expected;
  const out: Record<string, ExpectedField> = {};
  for (const field of Object.keys(FIELDS[mode])) {
    let v = src[field];
    if (mode === 'receipt' && field === 'vendor' && v && typeof v === 'object' && !isAnyOf(v)) {
      v = (v as { name?: unknown }).name ?? null;
    }
    const e = expectedField(v);
    if (e) out[field] = e;
  }
  return out;
}

// --- Predictions ---------------------------------------------------------------------------------

/** One predicted field: its value and confidence (null: the schema gives it none). */
export type Pred = { value: unknown; confidence: number | null };
export type Preds = Record<string, Pred>;

export type LinePred = {
  description?: string;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
};

export type ScoreContext = {
  languages: readonly string[];
  enabledCurrencies?: readonly string[];
};

const minConf = (xs: (number | undefined)[]) => {
  const c = xs.filter((x): x is number => typeof x === 'number');
  return c.length ? Math.min(...c) : null;
};

/** The raw answer (after parseLenient) as flat predictions. */
export function rawPreds(mode: ScoredMode, parsed: unknown, ctx: ScoreContext): Preds {
  const out: Preds = {};
  const put = (k: string, v: { value: unknown; confidence: number } | undefined) => {
    if (v !== undefined) out[k] = { value: v.value, confidence: v.confidence };
  };
  switch (mode) {
    case 'thing': {
      const o = (parsed as ThingExtraction).objects[0];
      if (!o) return out;
      put('name', o.name);
      put('brand', o.brand);
      put('model', o.model);
      put('colour', o.colour);
      put('type_hint', o.type_hint);
      put('quantity', o.quantity);
      put('serial', o.serial);
      if (Object.keys(o.aliases).length > 0) {
        out.aliases = { value: o.aliases, confidence: o.name.confidence };
      }
      return out;
    }
    case 'label': {
      const p = parsed as LabelExtraction;
      for (const k of Object.keys(FIELDS.label) as (keyof LabelExtraction)[]) put(k, p[k]);
      return out;
    }
    case 'reading': {
      const p = parsed as ReadingExtraction;
      put('value', p.value);
      put('unit', p.unit);
      if (p.display) out.display = { value: p.display, confidence: null };
      return out;
    }
    case 'receipt': {
      const p = parsed as ReceiptExtraction;
      put('vendor', p.vendor?.name);
      put('date', p.date);
      if (p.currency) {
        out.currency = {
          value: mapCurrencyMark(p.currency.value, {
            languages: ctx.languages,
            enabled: ctx.enabledCurrencies ?? SUPPORTED_DEFAULT,
            ...(p.vendor?.address ? { addressText: p.vendor.address } : {}),
          }),
          confidence: p.currency.confidence,
        };
      }
      put('total', p.total);
      put('tax', p.tax);
      if (p.lines.length > 0) {
        out.lines = {
          value: p.lines.map(
            (l): LinePred => ({
              description: l.description.value,
              ...(l.quantity ? { quantity: l.quantity.value } : {}),
              ...(l.unit_price ? { unit_price: l.unit_price.value } : {}),
              ...(l.line_total ? { line_total: l.line_total.value } : {}),
            }),
          ),
          confidence: minConf(p.lines.map((l) => l.description.confidence)),
        };
      }
      put('warranty_terms_printed', p.warranty_terms_printed);
      return out;
    }
  }
}

/** The checked fields (checks.ts) as flat predictions. */
export function checkedPreds(checked: Checked): Preds {
  const out: Preds = {};
  const put = (k: string, v: { value: unknown; confidence: number } | undefined) => {
    if (v !== undefined) out[k] = { value: v.value, confidence: v.confidence };
  };
  switch (checked.mode) {
    case 'thing': {
      const f = checked.fields;
      put('name', f.name);
      put('brand', f.brand);
      put('model', f.model);
      put('colour', f.colour);
      put('type_hint', f.typeHint);
      put('quantity', f.quantity);
      put('serial', f.serial);
      // An alias kept as a suggestion (D214: Arabic) still counts as read.
      const aliases: Record<string, string[]> = { ...f.aliases };
      for (const s of f.aliasSuggestions ?? [])
        aliases[s.lang] = [...(aliases[s.lang] ?? []), s.value];
      if (Object.keys(aliases).length > 0) {
        out.aliases = { value: aliases, confidence: f.name?.confidence ?? null };
      }
      return out;
    }
    case 'label': {
      const f = checked.fields;
      put('brand', f.brand);
      put('model', f.model);
      put('serial', f.serial);
      put('vin', f.vin);
      put('plate', f.plate);
      put('document_kind', f.documentKind);
      put('expires_on', f.expiresOn);
      put('manufactured_on', f.manufacturedOn);
      return out;
    }
    case 'reading': {
      const f = checked.fields;
      if (f.value) out.value = { value: Number(f.value.value), confidence: f.value.confidence };
      put('unit', f.unit);
      if (f.display) out.display = { value: f.display, confidence: null };
      return out;
    }
    case 'receipt': {
      const f = checked.fields;
      put('vendor', f.vendor?.name);
      put('date', f.date);
      if (f.currency) out.currency = { value: f.currency.match, confidence: f.currency.confidence };
      put('total', f.total);
      put('tax', f.tax);
      if (f.lines.length > 0) {
        out.lines = {
          value: f.lines.map(
            (l): LinePred => ({
              description: l.description.value,
              ...(l.quantity ? { quantity: l.quantity.value } : {}),
              ...(l.unitPrice ? { unit_price: l.unitPrice.value } : {}),
              ...(l.lineTotal ? { line_total: l.lineTotal.value } : {}),
            }),
          ),
          confidence: minConf(f.lines.map((l) => l.description.confidence)),
        };
      }
      put('warranty_terms_printed', f.warrantyTermsPrinted);
      return out;
    }
  }
}

// --- Matching one field ------------------------------------------------------------------------

function matchOne(kind: FieldKind, expected: unknown, got: unknown): boolean {
  switch (kind) {
    case 'text':
      return typeof expected === 'string' && typeof got === 'string' && sameText(expected, got);
    case 'code':
      return typeof expected === 'string' && typeof got === 'string' && sameCode(expected, got);
    case 'number':
      return typeof expected === 'number' && typeof got === 'number' && sameNumber(expected, got);
    case 'exact':
      return typeof expected === 'string' && typeof got === 'string'
        ? normalize(expected) === normalize(got)
        : expected === got;
    case 'date':
      return typeof got === 'string' && expected === got;
    case 'currency':
      return sameCurrency(expected, got as CurrencyMatch | null);
    case 'aliases':
      return sameAliases(expected as Record<string, string[]>, got as Record<string, string[]>);
    case 'lines':
      return sameLines(expected as LinePred[], got as LinePred[]);
  }
}

export function sameCurrency(expected: unknown, got: CurrencyMatch | null): boolean {
  if (!got) return false;
  if (typeof expected === 'string') return 'code' in got && got.code === expected;
  const amb = (expected as { ambiguous?: string[] })?.ambiguous;
  if (!Array.isArray(amb) || !('ambiguous' in got)) return false;
  return [...amb].sort().join() === [...got.ambiguous].sort().join();
}

export function sameAliases(
  expected: Record<string, string[]>,
  got: Record<string, string[]> | undefined,
): boolean {
  if (!got) return false;
  return Object.entries(expected).every(([lang, list]) => {
    const want = new Set(list.map(normalize));
    return (got[lang] ?? []).some((a) => want.has(normalize(a)));
  });
}

export function sameLines(expected: LinePred[], got: LinePred[] | undefined): boolean {
  if (!got || got.length !== expected.length) return false;
  return expected.every((e, i) => {
    const g = got[i] as LinePred;
    if (e.description !== undefined && !(g.description && sameText(e.description, g.description)))
      return false;
    if (e.quantity !== undefined && g.quantity !== e.quantity) return false;
    if (
      e.unit_price !== undefined &&
      !(g.unit_price !== undefined && sameNumber(e.unit_price, g.unit_price))
    )
      return false;
    if (
      e.line_total !== undefined &&
      !(g.line_total !== undefined && sameNumber(e.line_total, g.line_total))
    )
      return false;
    return true;
  });
}

// --- Scoring a case ------------------------------------------------------------------------------

export type FieldScore = {
  field: string;
  /** The case expects a value (true) or expects the field left out (false). */
  expectedPresent: boolean;
  predicted: boolean;
  correct: boolean;
  confidence: number | null;
};

export function scoreFields(
  mode: ScoredMode,
  expected: Record<string, ExpectedField>,
  preds: Preds,
): FieldScore[] {
  const out: FieldScore[] = [];
  for (const [field, e] of Object.entries(expected)) {
    const kind = FIELDS[mode][field] as FieldKind;
    const p = preds[field];
    const predicted = p !== undefined;
    const correct = e.absent
      ? !predicted
      : predicted && e.options.some((o) => matchOne(kind, o, p.value));
    out.push({
      field,
      expectedPresent: !e.absent,
      predicted,
      correct,
      confidence: p?.confidence ?? null,
    });
  }
  return out;
}

// --- The paper outline (Q11) -------------------------------------------------------------------

export type CropVerdict = 'missing' | 'no_crop' | 'good' | 'loose' | 'cuts_paper';

/** What the worker's crop (extraction/job.ts `cropToPaper`) would do with an outline. */
export function cropVerdict(
  got: Bbox | undefined,
  truth: Bbox,
): { verdict: CropVerdict; iou: number | null; coverage: number | null } {
  if (!got) return { verdict: 'missing', iou: null, coverage: null };
  const i = iou(got, truth);
  const c = coverage(got, truth);
  const [, , w, h] = got;
  // The worker's own skip rule: too small to trust, or already the whole photo.
  if (w < 0.2 || h < 0.2 || (w > 0.97 && h > 0.97))
    return { verdict: 'no_crop', iou: i, coverage: c };
  if (c < 0.98) return { verdict: 'cuts_paper', iou: i, coverage: c };
  return { verdict: i >= 0.8 ? 'good' : 'loose', iou: i, coverage: c };
}

/**
 * A box measured against the photo's **longer side** (as if the photo were padded to a square),
 * rescaled to its own width and height. Measurement only: the first Groq run (2026-09-29) gave
 * outlines whose short-side coordinates matched this reading (a 1200×800 shelf's objects came
 * back at about 2/3 of their true y and height), so the report shows both.
 */
export function fromLongSide(b: Bbox, width: number, height: number): Bbox {
  const long = Math.max(width, height);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp((b[0] * long) / width),
    clamp((b[1] * long) / height),
    clamp((b[2] * long) / width),
    clamp((b[3] * long) / height),
  ];
}

// --- Multi-item boxes (V2) -----------------------------------------------------------------------

export type MultiObject = { name: string; bbox: Bbox; confidence?: number };

export type MultiScore = {
  expected: number;
  predicted: number;
  matched: number;
  /** Matched objects whose name is also right. */
  named: number;
  meanIou: number | null;
};

/** Greedy one-to-one matching at IoU ≥ 0.5, best pairs first. */
export function scoreMulti(
  expected: { name?: unknown; bbox: Bbox }[],
  got: MultiObject[],
): MultiScore {
  const pairs: { i: number; j: number; v: number }[] = [];
  expected.forEach((e, i) => {
    got.forEach((g, j) => {
      const v = iou(e.bbox, g.bbox);
      if (v >= 0.5) pairs.push({ i, j, v });
    });
  });
  pairs.sort((a, b) => b.v - a.v);
  const usedE = new Set<number>();
  const usedG = new Set<number>();
  const ious: number[] = [];
  let named = 0;
  for (const p of pairs) {
    if (usedE.has(p.i) || usedG.has(p.j)) continue;
    usedE.add(p.i);
    usedG.add(p.j);
    ious.push(p.v);
    const e = expectedField((expected[p.i] as { name?: unknown }).name);
    const g = got[p.j] as MultiObject;
    if (!e || (!e.absent && e.options.some((o) => typeof o === 'string' && sameText(o, g.name)))) {
      named++;
    }
  }
  return {
    expected: expected.length,
    predicted: got.length,
    matched: ious.length,
    named,
    meanIou: ious.length ? ious.reduce((a, b) => a + b, 0) / ious.length : null,
  };
}

// --- Aggregates ----------------------------------------------------------------------------------

export type FieldStats = {
  field: string;
  /** Cases where the field was scored. */
  n: number;
  correct: number;
  tp: number;
  fp: number;
  fn: number;
  /** Checked values at or above CONFIDENCE_MIN (what apply.ts may use). */
  accepted: number;
  falseAccepts: number;
  /** Raw: the model gave a value that the code checks then removed. */
  droppedByChecks: number;
  /** Raw answers: mean confidence when right and when wrong. */
  meanConfRight: number | null;
  meanConfWrong: number | null;
};

export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Per-field statistics over several cases' scores. `raw` and `checked` are index-aligned. */
export function fieldStats(rows: { raw: FieldScore[]; checked: FieldScore[] }[]): FieldStats[] {
  const by = new Map<string, { raw: FieldScore[]; checked: FieldScore[] }>();
  for (const r of rows) {
    for (const s of r.checked) {
      const e = by.get(s.field) ?? { raw: [], checked: [] };
      e.checked.push(s);
      by.set(s.field, e);
    }
    for (const s of r.raw) by.get(s.field)?.raw.push(s);
  }
  return [...by.entries()].map(([field, { raw, checked }]) => {
    const tp = checked.filter((s) => s.predicted && s.correct).length;
    const fp = checked.filter((s) => s.predicted && !s.correct).length;
    const fn = checked.filter((s) => s.expectedPresent && !(s.predicted && s.correct)).length;
    const accepted = checked.filter(
      (s) => s.predicted && (s.confidence === null || s.confidence >= CONFIDENCE_MIN),
    );
    const rawRight = raw.filter((s) => s.predicted && s.correct && s.confidence !== null);
    const rawWrong = raw.filter((s) => s.predicted && !s.correct && s.confidence !== null);
    return {
      field,
      n: checked.length,
      correct: checked.filter((s) => s.correct).length,
      tp,
      fp,
      fn,
      accepted: accepted.length,
      falseAccepts: accepted.filter((s) => !s.correct).length,
      droppedByChecks: raw.filter((s, i) => s.predicted && !checked[i]?.predicted).length,
      meanConfRight: mean(rawRight.map((s) => s.confidence as number)),
      meanConfWrong: mean(rawWrong.map((s) => s.confidence as number)),
    };
  });
}

export type CalibrationBin = {
  from: number;
  to: number;
  n: number;
  meanConf: number;
  accuracy: number;
};
export type Calibration = {
  n: number;
  bins: CalibrationBin[];
  /** Expected calibration error: Σ (n_bin / n) · |accuracy − mean confidence|. */
  ece: number | null;
  /** Mean of (confidence − correct)². */
  brier: number | null;
};

export const CALIBRATION_EDGES = [0, 0.6, 0.8, 0.9, 0.95, 1.0001] as const;

/** Calibration of the raw answers' confidences (every predicted field that has one). */
export function calibration(scores: FieldScore[]): Calibration {
  const xs = scores.filter((s) => s.predicted && s.confidence !== null);
  const bins: CalibrationBin[] = [];
  let ece = 0;
  for (let i = 0; i < CALIBRATION_EDGES.length - 1; i++) {
    const from = CALIBRATION_EDGES[i] as number;
    const to = CALIBRATION_EDGES[i + 1] as number;
    const inBin = xs.filter(
      (s) => (s.confidence as number) >= from && (s.confidence as number) < to,
    );
    if (!inBin.length) continue;
    const meanConf = mean(inBin.map((s) => s.confidence as number)) as number;
    const accuracy = inBin.filter((s) => s.correct).length / inBin.length;
    bins.push({ from, to: Math.min(1, to), n: inBin.length, meanConf, accuracy });
    ece += (inBin.length / xs.length) * Math.abs(accuracy - meanConf);
  }
  const brier = mean(xs.map((s) => ((s.confidence as number) - (s.correct ? 1 : 0)) ** 2));
  return { n: xs.length, bins, ece: xs.length ? ece : null, brier };
}

/** The reasons checks.ts gave for each field it removed, counted (`vin: vin_format ×1`). */
export function droppedReasons(dropped: readonly Dropped[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dropped) {
    const field = d.path
      .replace(/^objects\.0\./, '')
      .replace(/^lines\.\d+\..*$/, 'lines')
      .replace(/^vendor\.name$/, 'vendor');
    const key = `${field}: ${d.reason}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
