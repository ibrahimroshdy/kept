// The evaluation harness's scoring maths, and a whole run on the synthetic fixtures with the mock
// provider (plan T11: "score.test.ts runs the harness on the synthetic fixtures with the mock
// provider and asserts the scoring maths"). No network: the provider is the mock.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMockAnswers } from '../src/ai/mock.js';
import { PROMPT_CHOICES, PROMPT_VERSIONS, promptFor } from '../src/extraction/prompts/index.js';
import { loadCases } from './cases.js';
import { renderReport, writeReport } from './report.js';
import { main, OutputWindow, parseCases, parsePrompts, runEval } from './run.js';
import {
  calibration,
  coverage,
  cropVerdict,
  fieldStats,
  fromLongSide,
  iou,
  sameAliases,
  sameCode,
  sameCurrency,
  sameLines,
  sameNumber,
  sameText,
  scoreMulti,
  tokenSetRatio,
} from './score.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures/eval/', import.meta.url));

describe('comparisons', () => {
  it('text: normalised, reordered words match; a fragment does not', () => {
    expect(sameText('CAIRO HOME STORE', 'Cairo Home Store')).toBe(true);
    expect(sameText('CAIRO HOME STORE', 'Home Store Cairo')).toBe(true);
    expect(sameText('CAIRO HOME STORE', 'STORE')).toBe(false);
    expect(tokenSetRatio('Extension Cord 3m', 'Extension Cord 3 m')).toBeGreaterThanOrEqual(0.9);
    // Arabic letter forms and Arabic-Indic digits fold (normalize, D42).
    expect(sameText('أرز مصري ١ كجم', 'ارز مصري 1 كجم')).toBe(true);
  });

  it('codes ignore spaces and digit scripts, but not other characters', () => {
    expect(sameCode('ق ط ر ١٢٣٤', 'قطر 1234')).toBe(true);
    expect(sameCode('QN55QN90DAFXZA', 'qn55 qn90 dafxza')).toBe(true);
    expect(sameCode('VD-18X', 'VD18X')).toBe(false);
  });

  it('numbers within 0.5%; zero only as zero', () => {
    expect(sameNumber(300, 301.4)).toBe(true);
    expect(sameNumber(300, 301.6)).toBe(false);
    expect(sameNumber(0, 0)).toBe(true);
    expect(sameNumber(0, 0.01)).toBe(false);
  });

  it('currency: the code, or the same ambiguity (D189)', () => {
    expect(sameCurrency('EGP', { code: 'EGP' })).toBe(true);
    expect(sameCurrency({ ambiguous: ['USD', 'CAD'] }, { ambiguous: ['CAD', 'USD'] })).toBe(true);
    expect(sameCurrency({ ambiguous: ['USD', 'CAD'] }, { code: 'USD' })).toBe(false);
    expect(sameCurrency('EGP', null)).toBe(false);
  });

  it('aliases: one expected alias per expected language', () => {
    const want = { en: ['drill', 'power drill'], ar: ['مثقاب'] };
    expect(sameAliases(want, { en: ['Drill', 'tool'], ar: ['مثقاب'] })).toBe(true);
    expect(sameAliases(want, { en: ['drill'] })).toBe(false);
  });

  it('lines: same count, each matching in order', () => {
    const want = [
      { description: 'LED Bulb 9W', quantity: 2, line_total: 90 },
      { description: 'Extension Cord 3m', line_total: 210 },
    ];
    expect(
      sameLines(want, [
        { description: 'LED bulb 9W', quantity: 2, line_total: 90 },
        { description: 'Extension Cord 3m', line_total: 210.5 },
      ]),
    ).toBe(true);
    expect(
      sameLines(want, [
        { description: 'LED Bulb 9W', quantity: 1, line_total: 90 },
        { description: 'Extension Cord 3m', line_total: 210 },
      ]),
    ).toBe(false);
    expect(sameLines(want, want.slice(0, 1))).toBe(false);
  });

  it('boxes: IoU, coverage, and what the worker crop would do (Q11)', () => {
    const full: [number, number, number, number] = [0, 0, 1, 1];
    // T10's real outline for a receipt filling the photo.
    expect(iou([0, 0, 0.7, 0.6], full)).toBeCloseTo(0.42, 5);
    expect(coverage([0, 0, 0.7, 0.6], full)).toBeCloseTo(0.42, 5);
    expect(cropVerdict([0, 0, 0.7, 0.6], full).verdict).toBe('cuts_paper');
    expect(cropVerdict([0, 0, 1, 1], full).verdict).toBe('no_crop');
    expect(cropVerdict([0.29, 0.09, 0.42, 0.82], [0.3, 0.1, 0.4, 0.8]).verdict).toBe('good');
    expect(cropVerdict([0.1, 0.05, 0.8, 0.9], [0.3, 0.1, 0.4, 0.8]).verdict).toBe('loose');
    expect(cropVerdict(undefined, full).verdict).toBe('missing');
  });

  it('a box measured on the longer side, rescaled to the photo (the shelf run, 2026-09-29)', () => {
    const b = fromLongSide([0.12, 0.32, 0.16, 0.15], 1200, 800);
    expect(b.map((v) => Number(v.toFixed(3)))).toEqual([0.12, 0.48, 0.16, 0.225]);
    expect(fromLongSide([0, 0, 0.7, 0.7], 640, 900).map((v) => Number(v.toFixed(3)))).toEqual([
      0, 0, 0.984, 0.7,
    ]);
  });

  it('multi-item boxes: one-to-one at IoU ≥ 0.5', () => {
    const s = scoreMulti(
      [
        { name: 'Mug', bbox: [0, 0, 0.2, 0.2] },
        { name: { anyOf: ['Book'] }, bbox: [0.5, 0.5, 0.2, 0.2] },
      ],
      [
        { name: 'Cup', bbox: [0, 0, 0.2, 0.2] },
        { name: 'Mug', bbox: [0.01, 0, 0.2, 0.2] },
        { name: 'Lamp', bbox: [0.8, 0.8, 0.1, 0.1] },
      ],
    );
    expect(s).toMatchObject({ expected: 2, predicted: 3, matched: 1, named: 0, meanIou: 1 });
  });

  it('calibration: bins, ECE and Brier', () => {
    const f = (confidence: number, correct: boolean) => ({
      field: 'x',
      expectedPresent: true,
      predicted: true,
      correct,
      confidence,
    });
    const c = calibration([f(0.98, true), f(0.98, false), f(0.5, false), f(0.5, false)]);
    expect(c.n).toBe(4);
    expect(c.bins.map((b) => [b.n, b.accuracy])).toEqual([
      [2, 0],
      [2, 0.5],
    ]);
    // ECE: ½·|0 − 0.5| + ½·|0.5 − 0.98| = 0.49. Brier: (0.02² + 0.98² + 0.5² + 0.5²) / 4.
    expect(c.ece).toBeCloseTo(0.49, 10);
    expect(c.brier).toBeCloseTo((0.0004 + 0.9604 + 0.25 + 0.25) / 4, 10);
  });

  it('output tokens a minute: waits for the window to make room', () => {
    const w = new OutputWindow(1000);
    expect(w.waitMs(700, 0)).toBe(0);
    w.record(0, 630);
    // 630 + 700 > 1000: wait until the 630 leave the minute, plus a 2 s margin.
    expect(w.waitMs(700, 10_000)).toBe(52_000);
    expect(w.waitMs(300, 10_000)).toBe(0);
    expect(w.waitMs(700, 61_000)).toBe(0);
  });
});

describe('options', () => {
  it('parses --cases and --prompt, and refuses unknown prompt versions', () => {
    expect(parseCases('receipt-en*2,reading-odometer')).toEqual([
      { id: 'receipt-en', repeat: 2 },
      { id: 'reading-odometer', repeat: 1 },
    ]);
    expect(() => parseCases('x*0')).toThrow();
    expect(parsePrompts(['receipt=receipt-v1,receipt-v2'])).toEqual({
      receipt: ['receipt-v1', 'receipt-v2'],
    });
    expect(() => parsePrompts(['receipt=receipt-v9'])).toThrow(/no receipt prompt/);
  });

  it('keeps receipt-v2 selectable while the worker sends receipt-v1', () => {
    expect(PROMPT_VERSIONS.receipt).toBe('receipt-v1');
    expect(PROMPT_CHOICES.receipt).toEqual(['receipt-v1', 'receipt-v2']);
    const ctx = { languages: ['en'] };
    expect(promptFor('receipt', ctx).version).toBe('receipt-v1');
    expect(promptFor('receipt', ctx, 'receipt-v2').version).toBe('receipt-v2');
    expect(promptFor('receipt', ctx, 'receipt-v2').system).not.toBe(
      promptFor('receipt', ctx).system,
    );
    expect(() => promptFor('label', ctx, 'label-v9')).toThrow();
  });

  it('skips without a folder, and exits 0 (plan T11)', async () => {
    const saved = process.env.KEPT_EVAL_DIR;
    delete process.env.KEPT_EVAL_DIR;
    const lines: string[] = [];
    try {
      expect(await main([], (l) => lines.push(l))).toBe(0);
      expect(
        await main(['--dir', path.join(tmpdir(), 'kept-no-such-eval-folder')], (l) =>
          lines.push(l),
        ),
      ).toBe(0);
    } finally {
      if (saved !== undefined) process.env.KEPT_EVAL_DIR = saved;
    }
    expect(lines).toEqual(['skipped: no evaluation folder', 'skipped: no evaluation folder']);
  });

  it('refuses a real provider without KEPT_EVAL_API_KEY in the environment', async () => {
    const saved = process.env.KEPT_EVAL_API_KEY;
    delete process.env.KEPT_EVAL_API_KEY;
    try {
      await expect(
        main(['--dir', FIXTURES, '--provider', 'groq', '--model', 'qwen/qwen3.8-27b'], () => {}),
      ).rejects.toThrow(/KEPT_EVAL_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.KEPT_EVAL_API_KEY = saved;
    }
  });
});

describe('a mock run on the synthetic fixtures', () => {
  it('scores every case through the real extract() path with known results', {
    timeout: 60_000,
  }, async () => {
    const set = loadCases(FIXTURES);
    expect(set.synthetic).toBe(true);
    expect(set.cases.map((c) => c.id)).toEqual([
      'receipt-en',
      'receipt-ar',
      'receipt-table',
      'label-nameplate',
      'label-registration-ar',
      'reading-odometer',
      'thing-drill-box',
      'thing-mug',
      'multi-shelf',
    ]);
    const answers = loadMockAnswers(path.join(FIXTURES, 'mock-answers.json'));
    const run = await runEval({
      set,
      provider: { kind: 'mock', model: 'kept-mock', answers },
      maxCalls: 20,
      maxCostUsd: 1,
      gapMs: 0,
      outputTpm: null,
      price: {
        id: 'mock',
        inputPerMtok: '1',
        outputPerMtok: '2',
        reasoningPerMtok: null,
        cachedInputPerMtok: null,
        perImage: null,
        currency: 'USD',
      },
      sleep: async () => {},
    });
    expect(run.sent).toBe(9);
    expect(run.results.every((r) => r.status === 'ok')).toBe(true);
    const by = (id: string) =>
      run.results.find((r) => r.caseId === id) as (typeof run.results)[number];

    // Cost from the ledger: 2,000 in × 1 + 500 out × 2 per million = 0.003 a call.
    expect(by('receipt-en').calls.cost).toBe('0.003');
    expect(by('receipt-en').calls).toMatchObject({ sent: 1, inputTokens: 2000, outputTokens: 500 });

    const right = (id: string) => by(id).checked.filter((s) => s.correct).length;
    expect([right('receipt-en'), by('receipt-en').checked.length]).toEqual([6, 6]);
    expect([right('receipt-ar'), by('receipt-ar').checked.length]).toEqual([5, 6]); // wrong date
    expect([right('receipt-table'), by('receipt-table').checked.length]).toEqual([5, 6]); // "USD" for "$"
    expect([right('reading-odometer'), by('reading-odometer').checked.length]).toEqual([2, 3]);

    // The two T10 regressions: the model fills them, the code checks keep them out.
    const field = (id: string, f: string, stage: 'raw' | 'checked') =>
      by(id)[stage].find((s) => s.field === f);
    expect(field('receipt-en', 'warranty_terms_printed', 'raw')).toMatchObject({ predicted: true });
    expect(field('receipt-en', 'warranty_terms_printed', 'checked')).toMatchObject({
      predicted: false,
      correct: true,
    });
    expect(field('label-nameplate', 'vin', 'raw')).toMatchObject({
      predicted: true,
      correct: false,
      confidence: 0.99,
    });
    expect(field('label-nameplate', 'vin', 'checked')).toMatchObject({
      predicted: false,
      correct: true,
    });
    expect(by('label-nameplate').dropped).toEqual({ 'vin: vin_format': 1 });

    // Receipt fields over the three receipts: one wrong date and one wrong currency, both kept
    // at confidence ≥ 0.6, so two false accepts.
    const receipts = run.results.filter((r) => r.mode === 'receipt');
    const stats = Object.fromEntries(fieldStats(receipts).map((s) => [s.field, s]));
    expect(stats.date).toMatchObject({ n: 3, correct: 2, tp: 2, fp: 1, fn: 1, falseAccepts: 1 });
    expect(stats.currency).toMatchObject({ n: 3, correct: 2, falseAccepts: 1 });
    expect(stats.warranty_terms_printed).toMatchObject({ n: 3, correct: 3, droppedByChecks: 1 });
    // A reading's confident nonsense (the spike's 0.04340057 at 0.98) is a false accept.
    const reading = Object.fromEntries(
      fieldStats([by('reading-odometer')]).map((s) => [s.field, s]),
    );
    expect(reading.value).toMatchObject({ correct: 0, falseAccepts: 1, meanConfWrong: 0.98 });

    // The paper outlines: T10's wrong one cuts the paper; a full frame isn't cropped.
    expect(receipts.map((r) => r.crop?.verdict)).toEqual(['cuts_paper', 'no_crop', 'good']);
    // V2: two of three shelf objects boxed.
    expect(by('multi-shelf').multi).toMatchObject({
      expected: 3,
      predicted: 4,
      matched: 2,
      named: 2,
    });

    // The report: numbers and case ids only.
    const md = renderReport(run);
    for (const text of [
      'CAIRO HOME STORE',
      'SUNRISE',
      'QN55QN90DAFXZA',
      'KMHD741CBMU123456',
      'سوبر',
      'VOLTA',
      'NO WARRANTY',
    ]) {
      expect(md).not.toContain(text);
    }
    expect(md).toContain('| receipt | `receipt-v1` | 3/3 | 16/18 (89%)');
    expect(md).toContain('**Total:** 9 request(s), 0.027 USD.');
    // The wire schema is named only when it isn't the worker's.
    expect(run.wire).toBe('receipt-required');
    expect(md).not.toContain('Wire schema');
    expect(renderReport({ ...run, wire: 'simple' })).toContain(
      '- **Wire schema:** **`simple`**, a harness experiment',
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'kept-eval-'));
    try {
      const a = writeReport(run, dir);
      const b = writeReport(run, dir);
      expect(path.basename(a)).toMatch(/^\d{4}-\d{2}-\d{2}-mock-kept-mock\.md$/);
      expect(path.basename(b)).toMatch(/-2\.md$/);
      expect(readFileSync(a, 'utf8')).toBe(md);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
