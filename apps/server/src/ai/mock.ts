/**
 * The mock provider (`KEPT_AI_MOCK=1`: tests, the e2e run, CI's evaluation run; refused in
 * production by config/env.ts). A `MockLanguageModelV4` from `ai/test` (spike: both V3 and V4
 * are accepted; T8 uses V4) that answers deterministically:
 * - by the SHA-256 of the first image part (the first 12 hex characters), from an answers map
 *   (T11's `test/fixtures/eval/mock-answers.json` via `loadMockAnswers`);
 * - otherwise with a schema-valid answer for the mode named by the structured-output name
 *   (`kept_receipt` …, wire.ts), or "red" for a plain-text question (the Test call);
 * - an assistant step (tools offered) whose question a script knows (mock-script.ts, step-6 T17)
 *   with that script's tool calls or answer.
 * An answer can instead act out a failure: a `length` stop (truncated or complete JSON),
 * invalid JSON, a schema miss, a content filter, an HTTP error with headers (429 with
 * `retry-after: 7`, 401, 500, an error inside a 200), or a delay (for timeouts).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { normalize, searchVariants } from '@kept/shared';
import { APICallError } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { packageRoot } from '../package-root.js';
import { type Script, scriptedReply } from './mock-script.js';

export type MockAnswer = {
  /** The JSON answer (serialised as the model's text). */
  output?: unknown;
  /** Raw text instead of `output` (invalid JSON, a plain answer). */
  text?: string;
  finishReason?: 'stop' | 'length' | 'content-filter';
  usage?: { input?: number; output?: number; reasoning?: number; cached?: number };
  headers?: Record<string, string>;
  providerMetadata?: Record<string, Record<string, unknown>>;
  /** Fail the HTTP call instead of answering. */
  error?: { status: number; headers?: Record<string, string>; body?: string };
  delayMs?: number;
};

export type MockAnswers = Record<string, MockAnswer>;

/** The key an image is looked up under: the first 12 hex characters of its SHA-256. */
export function mockKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/** Answers from a JSON file (T11's fixtures); an empty map when it doesn't exist. */
export function loadMockAnswers(path: string): MockAnswers {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as MockAnswers) : {};
}

const c = (value: unknown, confidence = 0.9) => ({ value, confidence });

/** A schema-valid answer per mode, used when an image has no answer of its own. */
export const DEFAULT_MOCK_OUTPUTS: Record<string, unknown> = {
  kept_thing: { objects: [{ name: c('Thing'), aliases: {} }] },
  kept_receipt: {
    vendor: { name: c('Mock Store') },
    date: c('2026-09-14'),
    currency: c('EGP'),
    total: c(300),
    lines: [{ description: c('Item'), line_total: c(300) }],
  },
  kept_label: { brand: c('Mock'), model: c('M-1'), serial: c('SN123456') },
  kept_reading: { value: c(52340), unit: c('km'), display: 'digital' },
  kept_test: { colour: 'red' },
  // Step 7 (T15): alias enrichment's batch answer, schema-valid and empty (enrich/prompt.ts).
  kept_aliases: { items: [] },
};

function firstImage(options: LanguageModelV4CallOptions): Uint8Array | null {
  for (const message of options.prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type !== 'file') continue;
      const data = part.data as unknown;
      if (data instanceof Uint8Array) return data;
      const inner = (data as { type?: string; data?: unknown })?.data;
      if (inner instanceof Uint8Array) return inner;
      if (typeof inner === 'string') return Buffer.from(inner, 'base64');
      if (typeof data === 'string') return Buffer.from(data, 'base64');
    }
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

/** A mock language model answering from `answers`, else the per-mode defaults. */
export function createMockModel(
  answers: MockAnswers = {},
  modelId = 'kept-mock',
  /** The assistant's scripts (mock-script.ts); the committed cases by default. */
  scripts?: Map<string, Script>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'kept-mock',
    modelId,
    doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
      // An assistant step (tools offered): the scripted reply, when a script knows the question
      // (mock-script.ts, step-6 T17).
      const scripted = options.tools?.length ? scriptedReply(options, scripts) : null;
      if (scripted) {
        const usage = {
          inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        };
        if (scripted.kind === 'calls') {
          return {
            content: scripted.calls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.tool,
              input: JSON.stringify(c.input),
            })),
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text', text: scripted.text }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      const image = firstImage(options);
      const answer: MockAnswer = (image && answers[mockKey(image)]) || {};
      if (answer.delayMs) await sleep(answer.delayMs, options.abortSignal);
      if (answer.error) {
        throw new APICallError({
          message: `mock HTTP ${answer.error.status}`,
          url: 'https://mock.invalid/v1/chat/completions',
          requestBodyValues: {},
          statusCode: answer.error.status,
          responseHeaders: answer.error.headers ?? {},
          responseBody: answer.error.body ?? '',
          isRetryable: answer.error.status === 429 || answer.error.status >= 500,
        });
      }
      const format = options.responseFormat;
      const name = format?.type === 'json' ? format.name : undefined;
      const output = answer.output ?? (name ? DEFAULT_MOCK_OUTPUTS[name] : undefined);
      const text = answer.text ?? (output !== undefined ? JSON.stringify(output) : 'red');
      const u = answer.usage ?? {};
      const input = u.input ?? (image ? 1200 : 100);
      const out = u.output ?? Math.max(1, Math.ceil(text.length / 4));
      const reasoning = u.reasoning ?? 0;
      const cached = u.cached ?? 0;
      const unified = answer.finishReason ?? 'stop';
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified, raw: unified },
        usage: {
          inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
          outputTokens: { total: out + reasoning, text: out, reasoning },
        },
        response: { headers: answer.headers ?? {} },
        ...(answer.providerMetadata ? { providerMetadata: answer.providerMetadata as never } : {}),
        warnings: [],
      };
    },
  });
}

/** Dimensions of the mock's vectors: the concept lexicon's, with room to spare. */
export const MOCK_EMBEDDING_DIMS = 64;

/** A deterministic unit vector for a text: equal texts embed equally (KEPT_AI_MOCK, tests). */
export function mockVector(text: string, dims = MOCK_EMBEDDING_DIMS): number[] {
  const h = createHash('sha256').update(text).digest();
  const raw = Array.from({ length: dims }, (_, i) => ((h[i % h.length] as number) - 127.5) / 127.5);
  const norm = Math.sqrt(raw.reduce((a, b) => a + b * b, 0)) || 1;
  return raw.map((v) => v / norm);
}

// --- Vectors that mean something (step-6 T14, T17) ------------------------------------------------
// With only `mockVector`, equal texts embed equally and everything else is noise, so semantic
// search couldn't be shown working under KEPT_AI_MOCK. A small lexicon of concepts
// (test/fixtures/semantic/concepts.json) gives each concept one dimension: a text lights the
// concepts its words name, plus a little of its hash so no two texts are identical and no vector
// is zero. "the thing for the TV" then lands near the HDMI cable, deterministically.

export type ConceptLexicon = { name: string; words: string[] }[];

/** Where the lexicon lives (T14's fixtures). */
export const MOCK_CONCEPTS_PATH = path.join(packageRoot(), 'test/fixtures/semantic/concepts.json');

let lexiconCache: ConceptLexicon | null | undefined;

/** The committed lexicon, or null where it isn't shipped (the mock's vectors are then hashes). */
export function mockLexicon(): ConceptLexicon | null {
  if (lexiconCache === undefined) lexiconCache = loadLexicon(MOCK_CONCEPTS_PATH);
  return lexiconCache;
}

/** A lexicon file's concepts; null when there is none. */
export function loadLexicon(file: string): ConceptLexicon | null {
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { concepts: ConceptLexicon }).concepts
    : null;
}

const WORDS = /[\p{L}\p{N}]+/gu;

/** The concepts a text names (indices into the lexicon). */
export function conceptsOf(text: string, lexicon: ConceptLexicon): Set<number> {
  const words = (normalize(text).match(WORDS) ?? []).flatMap((w) => searchVariants(w));
  const joined = ` ${words.join(' ')} `;
  const hit = new Set<number>();
  lexicon.forEach((c, i) => {
    for (const raw of c.words) {
      const k = (normalize(raw).match(WORDS) ?? []).join(' ');
      if (!k) continue;
      const found = k.includes(' ')
        ? joined.includes(` ${k} `)
        : [...k].length <= 3
          ? words.some((w) => w === k || w === `${k}s`)
          : words.some((w) => w.startsWith(k));
      if (found) {
        hit.add(i);
        return;
      }
    }
  });
  return hit;
}

/** A unit vector: the text's concepts at weight 1, its hash at 0.15 (see above). */
export function conceptVector(text: string, lexicon: ConceptLexicon, dims = MOCK_EMBEDDING_DIMS) {
  const noise = mockVector(text, dims);
  const raw = noise.map((n) => n * 0.15);
  for (const i of conceptsOf(text, lexicon)) if (i < dims) raw[i] = (raw[i] ?? 0) + 1;
  const norm = Math.sqrt(raw.reduce((a, b) => a + b * b, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** The mock's vector for a text: by concept when the lexicon is there, else by hash. */
export function mockEmbedding(text: string, dims = MOCK_EMBEDDING_DIMS): number[] {
  const lexicon = mockLexicon();
  return lexicon && lexicon.length < dims
    ? conceptVector(text, lexicon, dims)
    : mockVector(text, dims);
}

/** A mock embeddings model: one vector per value from `mockEmbedding`, `usage.tokens` from the
 * text length (one token per four characters). */
export function createMockEmbeddingModel(
  modelId = 'kept-mock-embed',
  dims = MOCK_EMBEDDING_DIMS,
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'kept-mock',
    modelId,
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => mockEmbedding(v, dims)),
      usage: { tokens: values.reduce((n, v) => n + Math.max(1, Math.ceil(v.length / 4)), 0) },
      warnings: [],
    }),
  });
}
