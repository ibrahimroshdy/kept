/**
 * The extraction evaluation harness (plan T11; V1, V2, V3, V36, V37; D19, D129, D206).
 *
 *   pnpm eval:extraction [--dir <folder>] [--provider mock|groq|openai|anthropic|google|
 *     openrouter|compatible --model <id> [--base-url <url>] [--reasoning low]]
 *     [--prompt receipt=receipt-v1,receipt-v2] [--cases id[*n],…] [--max-calls 20]
 *     [--max-cost 0.50] [--gap-ms 5000] [--output-tpm <n>] [--price <in>,<out>[,<cached>]]
 *     [--temperature <t>] [--wire simple|receipt-required]
 *     [--out <folder>] [--no-report] [--details <file>]
 *
 * **The same path as the worker** (extraction/job.ts), minus the database: the photo re-encoded
 * by image.ts (`reencode`, GPS-free, 3072 px for evidence and 2048 px for a thing) → the mode's
 * prompt (prompts/, any selectable version) → `extract()` → `callModel` (the real door: pacing,
 * budgets, the ledger row, cost) on the in-memory ports (ai/memory.ts) → `parseLenient` →
 * `check()` (checks.ts). Tokens and cost are read back from the in-memory ledger.
 *
 * **Opt-in, paced, capped.** Nothing here runs in the normal test run except `score.test.ts`,
 * which uses the mock. The provider is the mock unless `--provider` is given. A real run:
 * - reads its key from `KEPT_EVAL_API_KEY` only (never an argument or a file), and never prints
 *   it: every line printed is also scrubbed of it;
 * - leaves at least `--gap-ms` (5 s) between calls, and keeps the output tokens of the last
 *   minute under `--output-tpm` (Groq's tier here allows 1,000 a minute: its default for
 *   `groq`) on top of callModel's own pacer, which reads the provider's token headers;
 * - stops before `--max-calls` requests (20) or `--max-cost` USD (0.50) would be passed; a 429
 *   is waited out once (at most 2 minutes) and counts as a call.
 *
 * With `--dir` unset it reads `KEPT_EVAL_DIR`; with neither, or a folder that doesn't exist, it
 * prints `skipped: no evaluation folder` and exits 0. The report (report.ts) goes to
 * `docs/evals/<date>-<provider>-<model>.md`: numbers and case ids only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type CaptureMode,
  PROVIDER_KINDS,
  type ProviderKind,
  REFERENCE_FIGURES,
  SUPPORTED_DEFAULT,
} from '@kept/shared';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { type AiRuntime, callModel, type ImageInput } from '../src/ai/call.js';
import { fromMicro, type Price, toMicro } from '../src/ai/cost.js';
import { extract } from '../src/ai/extract.js';
import {
  InMemoryBudgetGate,
  InMemoryKeyStore,
  InMemoryLedger,
  InMemoryPacer,
} from '../src/ai/memory.js';
import { loadMockAnswers, type MockAnswers, mockKey } from '../src/ai/mock.js';
import type { Resolved } from '../src/ai/ports.js';
import { modelFor, type Reasoning } from '../src/ai/providers.js';
import { WIRE_IN_USE, WIRE_VARIANTS, type WireVariant } from '../src/ai/wire.js';
import { type CheckContext, check } from '../src/extraction/checks.js';
import { EVIDENCE_MAX_PX, reencode, THING_MAX_PX } from '../src/extraction/image.js';
import { PROMPT_CHOICES, PROMPT_VERSIONS, promptFor } from '../src/extraction/prompts/index.js';
import { packageRoot } from '../src/package-root.js';
import { type CaseSet, type EvalCase, type EvalMode, loadCases } from './cases.js';
import { MULTI_PROMPT_VERSION, MULTI_WIRE, multiPrompt, parseMulti } from './multi.js';
import { writeReport } from './report.js';
import {
  type Bbox,
  type CropVerdict,
  checkedPreds,
  cropVerdict,
  droppedReasons,
  expectedFields,
  type FieldScore,
  fromLongSide,
  type MultiScore,
  rawPreds,
  type ScoredMode,
  scoreFields,
  scoreMulti,
} from './score.js';

// --- Options -------------------------------------------------------------------------------------

export type ProviderChoice =
  | { kind: 'mock'; model: string; answers: MockAnswers }
  | {
      kind: ProviderKind;
      model: string;
      baseUrl: string | null;
      reasoning: Reasoning;
      structured?: boolean;
      apiKey: string | null;
      /**
       * An experiment, not the worker's path: callModel sends no temperature (the provider's
       * default applies). Set, the model is wrapped to send this one; the report says so.
       */
      temperature?: number;
    };

export type EvalOptions = {
  set: CaseSet;
  provider: ProviderChoice;
  /** Prompt versions per mode (each case of that mode runs once per version); default: in use. */
  prompts?: Partial<Record<CaptureMode, string[]>>;
  /** The cases to run and how many times each; default: every case once. */
  only?: { id: string; repeat: number }[];
  maxCalls: number;
  maxCostUsd: number | null;
  gapMs: number;
  /** Output tokens a minute the provider allows (Groq's tier: 1,000); null: not limited. */
  outputTpm: number | null;
  price: Price | null;
  timezone?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Keep the raw and checked answers per run (for `--details`; never in the report). */
  keepDetails?: boolean;
  /** The wire schema variant (ai/wire.ts); default: the worker's, `WIRE_IN_USE`. */
  wire?: WireVariant;
};

// --- Results -------------------------------------------------------------------------------------

export type RunStatus = 'ok' | 'failed' | 'paused' | 'skipped' | 'not_run';

export type CallFigures = {
  /** Requests sent (a 429 counts). */
  sent: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /** Summed from the ledger; null when any sent call's cost is unknown. */
  cost: string | null;
  costCurrency: string | null;
  latencyMs: number;
  outcomes: string[];
  finishReasons: string[];
};

export type RunResult = {
  caseId: string;
  /** 1-based repeat number. */
  index: number;
  mode: EvalMode;
  promptVersion: string;
  status: RunStatus;
  /** The outcome or skip reason when not ok (`truncated`, `schema_invalid`, `budget_calls`…). */
  reason: string | null;
  raw: FieldScore[];
  checked: FieldScore[];
  /** What checks.ts removed, as `field: reason` counts. */
  dropped: Record<string, number>;
  crop?: { verdict: CropVerdict; iou: number | null; coverage: number | null };
  /** The same outline read as measured against the photo's longer side (score.ts fromLongSide). */
  cropLongSide?: { verdict: CropVerdict; iou: number | null; coverage: number | null };
  multi?: MultiScore;
  /** The same boxes read as measured against the photo's longer side. */
  multiLongSide?: MultiScore;
  calls: CallFigures;
  details?: { raw: unknown; checked: unknown; dropped: unknown };
};

export type EvalRun = {
  startedAt: Date;
  finishedAt: Date;
  set: { name: string; synthetic: boolean; cases: number };
  provider: { kind: string; model: string; reasoning: string | null; temperature: number | null };
  /** The wire schema variant sent (ai/wire.ts); absent in runs from before it was selectable. */
  wire?: WireVariant;
  promptVersions: Record<string, string[]>;
  price: Price | null;
  limits: { maxCalls: number; maxCostUsd: number | null; gapMs: number; outputTpm: number | null };
  results: RunResult[];
  /** Requests sent in total, and requests held back by the pacer or the budgets (not sent). */
  sent: number;
  heldBack: number;
  /** Why the run stopped early, if it did. */
  stopped: string | null;
};

// --- Prices ----------------------------------------------------------------------------------

/**
 * Prices the harness knows, per million tokens, with where each came from. Groq's is its own
 * model listing on 2026-09-26 (docs/spikes/code/step3/server/models-groq-2026-09-26.json:
 * prompt 0.0000008, completion 0.000004, input_cache_read 0.0000004 USD a token). Anything else
 * needs `--price`, or its cost is reported as unknown (never guessed, Q8).
 */
export const LISTED_PRICES: readonly { kind: ProviderKind; model: string; price: Price }[] = [
  {
    kind: 'groq',
    model: 'qwen/qwen3.8-27b',
    price: {
      id: 'groq-listing-2026-09-26',
      inputPerMtok: '0.8',
      outputPerMtok: '4',
      reasoningPerMtok: null,
      cachedInputPerMtok: '0.4',
      perImage: null,
      currency: 'USD',
    },
  },
];

/** The mock's price, so the scoring test can check the cost arithmetic. */
export const MOCK_PRICE: Price = {
  id: 'mock',
  inputPerMtok: '1',
  outputPerMtok: '2',
  reasoningPerMtok: null,
  cachedInputPerMtok: null,
  perImage: null,
  currency: 'USD',
};

// --- Pacing --------------------------------------------------------------------------------------

/** Output tokens of the last minute, so a provider's output-per-minute limit isn't passed. */
export class OutputWindow {
  private readonly spent: { at: number; tokens: number }[] = [];
  constructor(readonly perMinute: number) {}
  record(at: number, tokens: number) {
    if (tokens > 0) this.spent.push({ at, tokens });
  }
  /** How long to wait before a call expected to produce `expected` output tokens. */
  waitMs(expected: number, now: number): number {
    const live = this.spent.filter((s) => s.at > now - 60_000);
    let used = live.reduce((a, s) => a + s.tokens, 0);
    const need = Math.min(expected, this.perMinute);
    if (used + need <= this.perMinute) return 0;
    for (const s of live) {
      used -= s.tokens;
      if (used + need <= this.perMinute) return s.at + 60_000 - now + 2_000;
    }
    return 0;
  }
}

/** What a call of a mode is expected to produce: the most seen so far, else the reference. */
function expectedOutput(mode: EvalMode, seen: Map<EvalMode, number>): number {
  const task = mode === 'multi' ? 'extract_thing' : (`extract_${mode}` as const);
  const ref = REFERENCE_FIGURES.tasks[task]?.outputTokens ?? 600;
  return Math.ceil(Math.max(ref, seen.get(mode) ?? 0) * 1.2);
}

/**
 * `fetch` that prints a refused request's provider message in full (callModel's log keeps 200
 * characters, which cut Groq's OTPM 429 before its numbers). The line passes through `log`,
 * which scrubs the key; the message is the provider's, never the request.
 */
function tellingFetch(log: (line: string) => void): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status >= 400) {
      const body = await res
        .clone()
        .text()
        .catch(() => '');
      const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body;
      log(`  provider said (${res.status}): ${message.slice(0, 500)}`);
    }
    return res;
  };
}

// --- The run -------------------------------------------------------------------------------------

type Planned = { c: EvalCase; version: string; index: number };

function plan(opts: EvalOptions): Planned[] {
  const byId = new Map(opts.set.cases.map((c) => [c.id, c]));
  const picks = opts.only ?? opts.set.cases.map((c) => ({ id: c.id, repeat: 1 }));
  const out: Planned[] = [];
  for (const p of picks) {
    const c = byId.get(p.id);
    if (!c) throw new Error(`no case ${p.id} in ${opts.set.name}`);
    const versions =
      c.mode === 'multi'
        ? [MULTI_PROMPT_VERSION]
        : (opts.prompts?.[c.mode] ?? [PROMPT_VERSIONS[c.mode]]);
    for (let index = 1; index <= p.repeat; index++) {
      for (const version of versions) out.push({ c, version, index });
    }
  }
  return out;
}

const emptyFigures = (): CallFigures => ({
  sent: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cost: null,
  costCurrency: null,
  latencyMs: 0,
  outcomes: [],
  finishReasons: [],
});

function figures(rows: InMemoryLedger['rows']): CallFigures {
  const f = emptyFigures();
  let micro = 0n;
  let known = true;
  for (const r of rows) {
    if (!r.sent) continue;
    f.sent++;
    f.inputTokens += r.inputTokens ?? 0;
    f.outputTokens += r.outputTokens ?? 0;
    f.reasoningTokens += r.reasoningTokens ?? 0;
    f.cachedInputTokens += r.cachedInputTokens ?? 0;
    f.latencyMs += r.latencyMs ?? 0;
    f.outcomes.push(r.httpStatus ? `${r.outcome} (${r.httpStatus})` : r.outcome);
    if (r.finishReason) f.finishReasons.push(r.finishReason);
    const used = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0;
    // A refused request (a 429) reports no tokens and costs nothing; only a call that used
    // tokens without a known price makes the cost unknown.
    if (!used && r.costAmount === null) continue;
    if (r.costAmount === null || r.costCurrency === null) known = false;
    else {
      micro += toMicro(r.costAmount);
      f.costCurrency = r.costCurrency;
    }
  }
  f.cost = known && f.sent > 0 ? fromMicro(micro) : f.sent === 0 ? '0' : null;
  return f;
}

export async function runEval(opts: EvalOptions): Promise<EvalRun> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = opts.log ?? (() => {});
  const apiKey = opts.provider.kind === 'mock' ? null : opts.provider.apiKey;
  const scrub = (s: string) => (apiKey ? s.split(apiKey).join('[KEY]') : s);
  const log = (line: string) => say(scrub(line));

  const p = opts.provider;
  const mock: MockAnswers | null = p.kind === 'mock' ? {} : null;
  const ledger = new InMemoryLedger();
  const pacer = new InMemoryPacer();
  const rt: AiRuntime = {
    keys: new InMemoryKeyStore([]),
    ledger,
    gate: new InMemoryBudgetGate(),
    pacer,
    prices: async () => opts.price,
    fetch: tellingFetch(log),
    now,
    sleep,
    log: {
      warn: (o, m) => log(`  ${m}: ${JSON.stringify(o)}`),
      info: () => {},
    },
    mock,
    ...(p.kind !== 'mock' && p.temperature !== undefined
      ? {
          modelFactory: (r: Resolved) =>
            wrapLanguageModel({
              model: modelFor(r.provider, r.apiKey, tellingFetch(log)),
              middleware: defaultSettingsMiddleware({ settings: { temperature: p.temperature } }),
            }),
        }
      : {}),
  };
  const resolved: Resolved = {
    provider:
      p.kind === 'mock'
        ? {
            id: 'eval-mock',
            scope: 'account',
            kind: 'openai_compatible',
            baseUrl: 'https://mock.invalid/v1',
            model: p.model,
            reasoning: 'low',
            structured: true,
          }
        : {
            id: 'eval',
            scope: 'account',
            kind: p.kind,
            baseUrl: p.baseUrl,
            model: p.model,
            reasoning: p.reasoning,
            ...(p.structured === undefined ? {} : { structured: p.structured }),
          },
    apiKey,
    payer: { scope: 'account', accountId: 'eval', userId: null, fellBack: false },
    ownerAccountId: 'eval',
  };

  const planned = plan(opts);
  const results: RunResult[] = [];
  const outputs = opts.outputTpm ? new OutputWindow(opts.outputTpm) : null;
  const seenOutput = new Map<EvalMode, number>();
  let lastCallEnd = 0;
  let stopped: string | null = null;
  const startedAt = now();
  const sentSoFar = () => ledger.rows.filter((r) => r.sent).length;
  const costSoFar = () =>
    ledger.rows.reduce((a, r) => a + (r.costAmount ? toMicro(r.costAmount) : 0n), 0n);

  for (const [n, item] of planned.entries()) {
    const { c, version, index } = item;
    const base: RunResult = {
      caseId: c.id,
      index,
      mode: c.mode,
      promptVersion: version,
      status: 'not_run',
      reason: null,
      raw: [],
      checked: [],
      dropped: {},
      calls: emptyFigures(),
    };
    if (stopped) {
      results.push({ ...base, reason: stopped });
      continue;
    }

    // The photo, as the worker would send it (image.ts).
    if (/\.pdf$/i.test(c.file)) {
      results.push({ ...base, status: 'skipped', reason: 'pdf_needs_file_text' });
      continue;
    }
    const max = c.mode === 'thing' || c.mode === 'multi' ? THING_MAX_PX : EVIDENCE_MAX_PX;
    const img: ImageInput | null = await reencode(readFileSync(c.file), max);
    if (!img) {
      results.push({ ...base, status: 'skipped', reason: 'undecodable' });
      continue;
    }
    if (mock && p.kind === 'mock') {
      for (const k of Object.keys(mock)) delete mock[k];
      const answer = p.answers[c.id];
      if (answer) mock[mockKey(img.bytes)] = answer;
    }

    const requestId = `eval:${c.id}:${version}:${index}`.slice(0, 64);
    let result: Awaited<ReturnType<typeof extract>> | Awaited<ReturnType<typeof callModel>> | null =
      null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (sentSoFar() >= opts.maxCalls) {
        stopped = 'budget_calls';
        break;
      }
      if (opts.maxCostUsd !== null && costSoFar() >= toMicro(opts.maxCostUsd)) {
        stopped = 'budget_cost';
        break;
      }
      // Pacing: a gap after the last call, and the provider's output tokens a minute.
      const t = now().getTime();
      const gap = lastCallEnd ? Math.max(0, lastCallEnd + opts.gapMs - t) : 0;
      const out = outputs ? outputs.waitMs(expectedOutput(c.mode, seenOutput), t) : 0;
      const wait = Math.max(gap, out);
      if (wait > 0) {
        if (wait > opts.gapMs)
          log(`  waiting ${Math.round(wait / 1000)} s (output tokens a minute)`);
        await sleep(wait);
      }
      const before = ledger.rows.length;
      if (c.mode === 'multi') {
        const prompt = multiPrompt();
        result = await callModel(rt, {
          resolved,
          task: 'extract_thing',
          locationId: 'eval',
          userId: null,
          links: {},
          instructions: prompt.system,
          text: prompt.text,
          images: [img],
          output: { name: 'kept_multi_probe', schema: MULTI_WIRE, parse: parseMulti },
          maxOutputTokens: 1400 + 2048,
          expectedOutputTokens: 600,
          promptVersion: MULTI_PROMPT_VERSION,
          requestId,
          attempt,
          jobId: requestId,
        });
      } else {
        const prompt = promptFor(
          c.mode,
          { languages: c.languages, pages: 1, meter: c.meter ?? null },
          version,
        );
        result = await extract(rt, {
          mode: c.mode,
          images: [img],
          prompt,
          locationId: 'eval',
          userId: null,
          links: {},
          requestId,
          attempt,
          jobId: requestId,
          resolved,
          wire: opts.wire ?? WIRE_IN_USE,
        });
      }
      lastCallEnd = now().getTime();
      for (const r of ledger.rows.slice(before)) {
        if (!r.sent) continue;
        outputs?.record(lastCallEnd, r.outputTokens ?? 0);
        if (r.outputTokens)
          seenOutput.set(c.mode, Math.max(seenOutput.get(c.mode) ?? 0, r.outputTokens));
      }
      if (result.status === 'paused' && result.kind === 'provider' && attempt === 1) {
        const ms = Math.min(
          120_000,
          Math.max(opts.gapMs, result.until.getTime() - now().getTime()),
        );
        log(
          `  ${c.id}: the provider paused us (${result.reason}); waiting ${Math.round(ms / 1000)} s`,
        );
        await sleep(ms);
        continue;
      }
      break;
    }

    const rows = ledger.rows.filter((r) => r.requestId === requestId);
    const calls = figures(rows);
    if (!result) {
      results.push({ ...base, reason: stopped, calls });
      continue;
    }
    const r: RunResult = { ...base, calls };
    if (result.status === 'ok') {
      r.status = 'ok';
      if (c.mode === 'multi') {
        const v = result.value as NonNullable<ReturnType<typeof parseMulti>>;
        const expected = (c.expected.objects ?? []) as { name?: unknown; bbox: Bbox }[];
        r.multi = scoreMulti(expected, v.objects);
        r.multiLongSide = scoreMulti(
          expected,
          v.objects.map((o) => ({ ...o, bbox: fromLongSide(o.bbox, img.width, img.height) })),
        );
        if (opts.keepDetails) r.details = { raw: v, checked: null, dropped: v.dropped };
      } else {
        const mode = c.mode as ScoredMode;
        const got = result.value as { value: unknown; dropped: string[] };
        const ctx: CheckContext = {
          timezone: opts.timezone ?? 'Africa/Cairo',
          languages: c.languages,
          enabledCurrencies: [
            ...new Set([...SUPPORTED_DEFAULT, ...(c.locationCurrency ? [c.locationCurrency] : [])]),
          ],
          now: now(),
        };
        const checked = check(mode, got.value as never, got.dropped, ctx);
        const expected = expectedFields(mode, c.expected);
        const scoreCtx = { languages: c.languages, enabledCurrencies: ctx.enabledCurrencies };
        r.raw = scoreFields(mode, expected, rawPreds(mode, got.value, scoreCtx));
        r.checked = scoreFields(mode, expected, checkedPreds(checked));
        r.dropped = droppedReasons(checked.dropped);
        const truth = c.expected.document_bbox as Bbox | undefined;
        if (mode === 'receipt' && Array.isArray(truth)) {
          const bbox =
            checked.mode === 'receipt'
              ? (checked.fields.documentBbox as Bbox | undefined)
              : undefined;
          r.crop = cropVerdict(bbox, truth);
          r.cropLongSide = cropVerdict(bbox && fromLongSide(bbox, img.width, img.height), truth);
        }
        if (opts.keepDetails)
          r.details = { raw: got.value, checked: checked.fields, dropped: checked.dropped };
      }
    } else if (result.status === 'failed') {
      r.status = 'failed';
      r.reason = result.outcome;
    } else if (result.status === 'paused') {
      r.status = 'paused';
      r.reason = result.reason;
    } else {
      r.status = 'failed';
      r.reason = 'no_provider';
    }
    results.push(r);
    const right = r.checked.filter((s) => s.correct).length;
    log(
      `${String(n + 1).padStart(2)}/${planned.length} ${c.id} #${index} ${version}: ${r.status}` +
        `${r.reason ? ` (${r.reason})` : ''}` +
        (r.checked.length ? ` · ${right}/${r.checked.length} fields` : '') +
        (r.multi ? ` · ${r.multi.matched}/${r.multi.expected} boxes` : '') +
        (r.crop ? ` · crop ${r.crop.verdict}` : '') +
        ` · in ${calls.inputTokens} out ${calls.outputTokens}` +
        ` · ${calls.cost ?? '?'} ${calls.costCurrency ?? ''}`.trimEnd(),
    );
  }

  const versions: Record<string, string[]> = {};
  for (const item of planned) {
    const list = versions[item.c.mode] ?? [];
    versions[item.c.mode] = list;
    if (!list.includes(item.version)) list.push(item.version);
  }
  return {
    startedAt,
    finishedAt: now(),
    set: { name: opts.set.name, synthetic: opts.set.synthetic, cases: opts.set.cases.length },
    provider:
      p.kind === 'mock'
        ? { kind: 'mock', model: p.model, reasoning: null, temperature: null }
        : {
            kind: p.kind,
            model: p.model,
            reasoning: p.reasoning,
            temperature: p.temperature ?? null,
          },
    wire: opts.wire ?? WIRE_IN_USE,
    promptVersions: versions,
    price: opts.price,
    limits: {
      maxCalls: opts.maxCalls,
      maxCostUsd: opts.maxCostUsd,
      gapMs: opts.gapMs,
      outputTpm: opts.outputTpm,
    },
    results,
    sent: sentSoFar(),
    heldBack: ledger.rows.filter((r) => !r.sent).length,
    stopped,
  };
}

// --- The command line ----------------------------------------------------------------------------

/** `compatible` is the plan's word for `openai_compatible`. */
function kindOf(name: string): ProviderKind | 'mock' {
  if (name === 'mock') return 'mock';
  const k = name === 'compatible' ? 'openai_compatible' : name;
  if (!(PROVIDER_KINDS as readonly string[]).includes(k)) {
    throw new Error(`--provider must be mock or one of ${PROVIDER_KINDS.join(', ')}`);
  }
  return k as ProviderKind;
}

/** `receipt=receipt-v1,receipt-v2` (repeatable). */
export function parsePrompts(specs: readonly string[]): Partial<Record<CaptureMode, string[]>> {
  const out: Partial<Record<CaptureMode, string[]>> = {};
  for (const spec of specs) {
    const [mode, list] = spec.split('=');
    if (!mode || !list || !(mode in PROMPT_CHOICES))
      throw new Error(`--prompt ${spec}: mode=version,…`);
    const versions = list.split(',').filter(Boolean);
    for (const v of versions) {
      if (!PROMPT_CHOICES[mode as CaptureMode].includes(v)) {
        throw new Error(
          `--prompt: no ${mode} prompt ${v} (${PROMPT_CHOICES[mode as CaptureMode].join(', ')})`,
        );
      }
    }
    out[mode as CaptureMode] = versions;
  }
  return out;
}

/** `receipt-en*2,reading-odometer` → ids with repeat counts. */
export function parseCases(spec: string): { id: string; repeat: number }[] {
  return spec
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const [id, n] = s.split('*');
      const repeat = n === undefined ? 1 : Number(n);
      if (!id || !Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
        throw new Error(`--cases ${s}: id or id*n (n from 1 to 10)`);
      }
      return { id, repeat };
    });
}

function priceFrom(
  spec: string | undefined,
  kind: ProviderKind | 'mock',
  model: string,
): Price | null {
  if (kind === 'mock') return MOCK_PRICE;
  if (spec) {
    const [input, output, cached] = spec.split(',');
    const dec = /^\d+(\.\d{1,6})?$/;
    if (
      !input ||
      !output ||
      !dec.test(input) ||
      !dec.test(output) ||
      (cached && !dec.test(cached))
    ) {
      throw new Error('--price <input>,<output>[,<cached input>] in USD per million tokens');
    }
    return {
      id: 'cli',
      inputPerMtok: input,
      outputPerMtok: output,
      reasoningPerMtok: null,
      cachedInputPerMtok: cached ?? null,
      perImage: null,
      currency: 'USD',
    };
  }
  return LISTED_PRICES.find((l) => l.kind === kind && l.model === model)?.price ?? null;
}

/** Where the command was typed (pnpm runs the script from apps/server). */
const typedFrom = () => process.env.INIT_CWD ?? process.cwd();
/** A path as the person typing sees it: relative when it is under where they typed. */
const shown = (file: string) => {
  const rel = path.relative(typedFrom(), file);
  return rel.startsWith('..') ? file : rel;
};
const REPO_ROOT = path.resolve(packageRoot(import.meta.url), '../..');
export const MOCK_ANSWERS_FILE = path.join(
  packageRoot(import.meta.url),
  'test/fixtures/eval/mock-answers.json',
);

export async function main(
  argv: string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      reasoning: { type: 'string', default: 'low' },
      structured: { type: 'boolean' },
      temperature: { type: 'string' },
      wire: { type: 'string' },
      prompt: { type: 'string', multiple: true },
      cases: { type: 'string' },
      'max-calls': { type: 'string', default: '20' },
      'max-cost': { type: 'string', default: '0.50' },
      'gap-ms': { type: 'string' },
      'output-tpm': { type: 'string' },
      price: { type: 'string' },
      out: { type: 'string' },
      'no-report': { type: 'boolean', default: false },
      details: { type: 'string' },
      'mock-answers': { type: 'string' },
    },
    strict: true,
  });

  const dirArg = values.dir ?? process.env.KEPT_EVAL_DIR;
  const dir = dirArg ? path.resolve(typedFrom(), dirArg) : null;
  if (!dir || !existsSync(dir)) {
    print('skipped: no evaluation folder');
    return 0;
  }
  const set = loadCases(dir);
  const kind = kindOf(values.provider as string);
  let provider: ProviderChoice;
  if (kind === 'mock') {
    const file = values['mock-answers']
      ? path.resolve(typedFrom(), values['mock-answers'])
      : path.join(dir, 'mock-answers.json');
    provider = { kind: 'mock', model: 'kept-mock', answers: loadMockAnswers(file) };
  } else {
    if (!values.model) throw new Error('--model is required with a real provider');
    const apiKey = process.env.KEPT_EVAL_API_KEY ?? null;
    if (!apiKey && kind !== 'openai_compatible') {
      throw new Error('KEPT_EVAL_API_KEY is not set (the key is read from the environment only)');
    }
    provider = {
      kind,
      model: values.model,
      baseUrl: values['base-url'] ?? null,
      reasoning: values.reasoning as Reasoning,
      ...(values.structured === undefined ? {} : { structured: values.structured }),
      apiKey,
      ...(values.temperature === undefined ? {} : { temperature: Number(values.temperature) }),
    };
  }
  const wire = values.wire ?? WIRE_IN_USE;
  if (!(WIRE_VARIANTS as readonly string[]).includes(wire)) {
    throw new Error(`--wire must be one of ${WIRE_VARIANTS.join(', ')}`);
  }
  const outputTpm = values['output-tpm']
    ? Number(values['output-tpm'])
    : kind === 'groq'
      ? 1000
      : null;
  const run = await runEval({
    set,
    provider,
    prompts: parsePrompts(values.prompt ?? []),
    ...(values.cases ? { only: parseCases(values.cases) } : {}),
    maxCalls: Number(values['max-calls']),
    maxCostUsd: values['max-cost'] === 'none' ? null : Number(values['max-cost']),
    // At least 5 s between real requests, whatever is asked; the mock needs none.
    gapMs:
      kind === 'mock'
        ? Number(values['gap-ms'] ?? 0)
        : Math.max(5000, Number(values['gap-ms'] ?? 5000)),
    outputTpm,
    price: priceFrom(values.price, kind, provider.model),
    log: print,
    keepDetails: Boolean(values.details),
    wire: wire as WireVariant,
  });
  if (values.details) {
    const file = path.resolve(typedFrom(), values.details);
    const lines = run.results.map((r) =>
      JSON.stringify({
        case: r.caseId,
        index: r.index,
        prompt: r.promptVersion,
        status: r.status,
        reason: r.reason,
        details: r.details ?? null,
      }),
    );
    writeFileSync(file, `${lines.join('\n')}\n`);
    print(`details: ${shown(file)} (raw answers; keep it out of Git)`);
  }
  if (!values['no-report']) {
    const outDir = values.out
      ? path.resolve(typedFrom(), values.out)
      : path.join(REPO_ROOT, 'docs/evals');
    const file = writeReport(run, outDir);
    print(`report: ${shown(file)}`);
  }
  print(`${run.sent} request(s) sent${run.stopped ? `; stopped early: ${run.stopped}` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      const key = process.env.KEPT_EVAL_API_KEY;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(key ? msg.split(key).join('[KEY]') : msg);
      process.exit(1);
    },
  );
}
