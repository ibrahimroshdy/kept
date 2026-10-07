/**
 * "Test connection" (D188, D202, L50; plan T9's route calls this with no transaction open):
 * two real calls through callModel, each a `connection_test` ledger row budgeted against the
 * provider's payer:
 * 1. vision: a 64×64 red square, "what colour is this square?", a one-word text answer;
 * 2. structured output: a text-only question answered as JSON against a one-field schema.
 * The spike's square cost ~1.3k tokens and ≈ USD 0.0011 on Groq. The result records whether
 * each worked, so T9 can set `capabilities` and mark the model's `vision` (`visionSource:
 * 'test'`) where the listing didn't say.
 */
import { REASONING_ALLOWANCE } from '@kept/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { type AiRuntime, type CallResult, callModel } from './call.js';
import { fromMicro, toMicro } from './cost.js';
import { allowanceLevel } from './extract.js';
import type { Resolved } from './ports.js';

export const TEST_PROMPT_VERSION = 'test-1';

let square: Promise<Buffer> | null = null;
/** The 64×64 test image: a red square, made once, with no metadata (sharp writes none). */
export function testSquare(): Promise<Buffer> {
  square ??= sharp({ create: { width: 64, height: 64, channels: 3, background: '#d0021b' } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return square;
}

const StructuredAnswer = z.object({ colour: z.string().trim().min(1).max(40) });
const STRUCTURED_SCHEMA = {
  type: 'object' as const,
  properties: { colour: { type: 'string' as const } },
  required: ['colour'],
  additionalProperties: false,
};

export type TestPart = { ok: boolean; latencyMs: number | null; error?: string };

export type TestConnectionResult = {
  model: string;
  vision: TestPart;
  structured: TestPart;
  tokens: number;
  cost: { amount: string; currency: string; source: 'provider' | 'price_table' } | null;
  callIds: string[];
};

function describe(r: CallResult<unknown>): string {
  if (r.status === 'paused') return `paused_${r.reason}`;
  if (r.status === 'failed') return r.errorCode;
  return 'unexpected';
}

export async function testConnection(
  rt: AiRuntime,
  req: { resolved: Resolved; userId: string | null; requestId: string; jobId: string },
): Promise<TestConnectionResult> {
  const { resolved } = req;
  const allowance = REASONING_ALLOWANCE[allowanceLevel(resolved.provider.reasoning)];
  const common = {
    resolved,
    task: 'connection_test' as const,
    locationId: null,
    userId: req.userId,
    links: {},
    promptVersion: TEST_PROMPT_VERSION,
    requestId: req.requestId,
    jobId: req.jobId,
    expectedOutputTokens: 16,
  };
  const results: CallResult<unknown>[] = [];

  const img = await testSquare();
  const vision = await callModel<string>(rt, {
    ...common,
    attempt: 1,
    instructions: 'You answer questions about images in one word.',
    text: 'What colour is this square? Answer with one word.',
    images: [{ bytes: img, mediaType: 'image/jpeg', width: 64, height: 64 }],
    output: null,
    maxOutputTokens: 64 + allowance,
  });
  results.push(vision);
  const visionPart: TestPart =
    vision.status === 'ok'
      ? /red/i.test(vision.value)
        ? { ok: true, latencyMs: vision.latencyMs }
        : { ok: false, latencyMs: vision.latencyMs, error: 'wrong_answer' }
      : { ok: false, latencyMs: null, error: describe(vision) };

  let structuredPart: TestPart = { ok: false, latencyMs: null, error: 'not_run' };
  if (!(vision.status === 'paused' && vision.kind === 'provider')) {
    const structured = await callModel(rt, {
      ...common,
      attempt: 2,
      instructions: 'Return JSON only, matching the schema.',
      text: 'What colour is a ripe tomato? One word.',
      images: [],
      output: {
        name: 'kept_test',
        schema: STRUCTURED_SCHEMA,
        parse: (raw) => {
          const r = StructuredAnswer.safeParse(raw);
          return r.success ? r.data : null;
        },
      },
      maxOutputTokens: 64 + allowance,
    });
    results.push(structured);
    structuredPart =
      structured.status === 'ok'
        ? { ok: true, latencyMs: structured.latencyMs }
        : { ok: false, latencyMs: null, error: describe(structured) };
  }

  let tokens = 0;
  let micro = 0n;
  let currency: string | null = null;
  let source: 'provider' | 'price_table' | null = null;
  let costKnown = true;
  const callIds: string[] = [];
  for (const r of results) {
    if (r.status === 'paused' && r.callId) callIds.push(r.callId);
    if (r.status === 'failed') callIds.push(r.callId);
    if (r.status !== 'ok') continue;
    callIds.push(r.callId);
    tokens += (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0);
    if (r.cost.amount === null || r.cost.currency === null || r.cost.source === 'unknown') {
      costKnown = false;
      continue;
    }
    if (currency !== null && currency !== r.cost.currency) costKnown = false;
    currency = r.cost.currency;
    source = source === 'price_table' ? 'price_table' : r.cost.source;
    micro += toMicro(r.cost.amount);
  }
  return {
    model: resolved.provider.model,
    vision: visionPart,
    structured: structuredPart,
    tokens,
    cost: costKnown && currency && source ? { amount: fromMicro(micro), currency, source } : null,
    callIds,
  };
}
