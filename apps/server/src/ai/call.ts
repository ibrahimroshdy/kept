/**
 * `callModel`, the one door every model call goes through (L41–L47, D121, D167, D206; plan T8).
 * No other file calls `generateText` (no-direct-calls.test.ts).
 *
 * 1. Images are checked: JPEG, PNG or WebP with **no EXIF** (D202: only the EXIF-stripped
 *    display derivative, or an in-memory re-encode, ever goes to a provider). A violation throws:
 *    it is a programming error, not an outcome.
 * 2. The Pacer admits it: the breaker (a trip holds the call, with a `sent = false` row when it
 *    pauses work), the provider's own token window (sleep ≤ 10 s in place, else hold), and the
 *    key's concurrency (1 for Groq).
 * 3. The BudgetGate reserves the estimate against every bucket (§7.15). A cap, day budget or
 *    manual pause refuses with one `sent = false` `over_budget` row; `tpm` and `concurrency`
 *    are short waits with no row.
 * 4. With no transaction open, `generateText` with `maxRetries: 0`, `maxOutputTokens` (the JSON
 *    allowance plus the reasoning allowance, Q6), the provider's reasoning setting and an 80 s
 *    timeout. Structured output is the wire JSON Schema, unvalidated; the caller's `parse`
 *    (parseLenient, L52) decides what survives.
 * 5. The result maps to a D206 outcome; a `length` finish is `truncated`, never retried (L42).
 * 6. The cost (cost.ts), the ledger row (never a prompt, image, reply, provider message or key),
 *    the settlement and its 80%/100% crossings. Every reserved call settles and every lease is
 *    released, whatever happens (`finally`).
 *
 * Step 6 (plan T8) adds, on the same path:
 * - **tool calling with a conversation**: the thread's messages (convert.ts) and tool specs in,
 *   the model's tool calls out, **exactly one provider request per call**: a one-step stop
 *   condition always, no `execute` on any tool, never `toolApproval`, `repairToolCall`,
 *   `prepareStep` or tool callers. Kept runs the loop (assistant/loop.ts), so every step is one
 *   reservation, one settlement and one ledger row. A call the SDK flags invalid (an unknown tool,
 *   input its schema refuses; spike S6.3 finding 3: flagged, never thrown) is `schema_invalid` /
 *   `tool_input`, with the calls returned so the loop can answer them.
 * - **`embedValues`**: one embeddings request (`embedMany` with `maxParallelCalls: 1` and at most
 *   the model's own per-call limit, spike S6.4 finding 4), reserved, paced, settled and ledgered
 *   the same way. Vectors and inputs never reach the ledger or a log.
 */
import type { BudgetTask, LedgerOutcome, LedgerTask } from '@kept/shared';
import { budgetTaskOf, EMBED_BATCH_MAX, estimateTextTokens } from '@kept/shared';
import {
  embedMany,
  generateText,
  isStepCount,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  Output,
  type ToolSet,
  tool,
} from 'ai';
import sharp from 'sharp';
import {
  conversationText,
  fromToolCalls,
  type KeptMessage,
  type ToolCallOut,
  type ToolSpec,
  toModelMessages,
} from './convert.js';
import {
  type CallUsage,
  type Cost,
  costOf,
  estimateCost,
  type Price,
  providerReportedCost,
} from './cost.js';
import { classifyError, providerErrorForLog } from './errors.js';
import { estimateCall } from './estimate.js';
import { createMockEmbeddingModel, createMockModel, type MockAnswers } from './mock.js';
import type { ProviderLimits } from './pacing.js';
import type {
  BudgetGate,
  CapPauseReason,
  Crossed,
  KeyLease,
  KeyStore,
  Ledger,
  LedgerEntry,
  Pacer,
  Reservation,
  Resolved,
} from './ports.js';
import {
  callSettingsFor,
  type EmbeddingModelObject,
  embeddingDimensionsOption,
  embeddingModelFor,
  type ModelObject,
  modelFor,
} from './providers.js';

// The SDK prints warnings to the console by default (spike); Kept's logs are pino only.
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = false;

export type PriceLookup = (
  kind: Resolved['provider']['kind'],
  model: string,
  at: Date,
) => Promise<Price | null>;

export type AiLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
};

/** What the provider layer needs from the app. T9 builds it for routes and jobs. */
export type AiRuntime = {
  keys: KeyStore;
  ledger: Ledger;
  gate: BudgetGate;
  pacer: Pacer;
  prices: PriceLookup;
  /** The SSRF-guarded fetch (net/ssrf.ts) for user-typed base URLs; plain fetch otherwise. */
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: AiLogger;
  /** KEPT_AI_MOCK: every model is the mock, answering from these (config/env.ts refuses it in
   * production). Null: real providers. */
  mock: MockAnswers | null;
  /** Builds the model instead of the provider packages or the mock (tests, the eval harness). */
  modelFactory?: (r: Resolved) => ModelObject;
  /** Builds the embeddings model instead of the provider packages or the mock (tests). */
  embeddingModelFactory?: (r: Resolved) => EmbeddingModelObject;
  /** 80 s (§3.5); tests shorten it. */
  callTimeoutMs?: number;
  /** For each cap crossed at settle, enqueue `ai.cap_notice` (T9). */
  onCrossed?: (crossed: Crossed) => Promise<void>;
};

export const CALL_TIMEOUT_MS = 80_000;
const MAX_INLINE_SLEEPS = 3;
/** Holds for the provider's window shorter than this are waits, not ledger rows (§3.5). */
const HOLD_ROW_AFTER_MS = 60_000;

export type ImageInput = {
  bytes: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  attachmentId?: string;
};

export type CallRequest<T> = {
  resolved: Resolved;
  task: LedgerTask;
  locationId: string | null;
  /** Null: "Kept (background)". */
  userId: string | null;
  links: { extractionId?: string; threadId?: string; thingId?: string };
  instructions: string;
  text: string;
  images: ImageInput[];
  /** Structured output: the wire schema, its name, and the lenient parse. Null: a text answer. */
  output: { name: string; schema: JSONSchema7; parse: (raw: unknown) => T | null } | null;
  maxOutputTokens: number;
  /**
   * Step 6 (T8): the thread so far (convert.ts pairs every tool call with one result). `text` is
   * then the new user message, or '' when the conversation already ends with what the model must
   * answer (a tool result).
   */
  conversation?: { messages: KeptMessage[] };
  /** Step 6 (T8): the tools offered for this one step; never a function to run. A tool-calling
   * request passes `output: null`: `value` is the text answer ('' for a step of tool calls). */
  tools?: { defs: ToolSpec[]; choice: 'auto' | 'none' };
  /** What a call like this usually produces, for the provider's window (estimate.ts). */
  expectedOutputTokens: number;
  promptVersion: string | null;
  requestId: string;
  attempt: number;
  jobId: string;
};

export type ProviderPauseReason =
  | 'tpm'
  | 'concurrency'
  | 'limits'
  | 'rate_limited'
  | 'quota'
  | 'provider_down'
  | 'auth';

export type CallResult<T> =
  | {
      status: 'ok';
      value: T;
      usage: CallUsage;
      cost: Cost;
      callId: string;
      latencyMs: number;
      crossed: Crossed[];
      /** The calls the model asked for, in order (empty for extraction and for an answer). */
      toolCalls: ToolCallOut[];
      /** The SDK's unified finish reason (`stop`, `tool-calls` …). */
      finishReason: string | null;
      /** The reasoning the provider returned, kept in the private thread only (S6.3 finding 4). */
      reasoning: string | null;
    }
  | {
      status: 'paused';
      kind: 'cap';
      until: Date;
      reason: CapPauseReason;
      bucket: string;
      callId: string;
    }
  | {
      status: 'paused';
      kind: 'provider';
      until: Date;
      reason: ProviderPauseReason;
      callId?: string;
    }
  | {
      status: 'failed';
      outcome: Exclude<LedgerOutcome, 'ok' | 'over_budget'>;
      errorCode: string;
      retryable: boolean;
      callId: string;
      /** `tool_input` only: every call of the step, the invalid ones flagged, so the loop can run
       * the valid ones and tell the model about the rest (T13). */
      toolCalls?: ToolCallOut[];
      reasoning?: string | null;
    };

/** D202: only EXIF-free images reach a provider. Throws on a violation. */
export async function assertSendable(images: readonly ImageInput[]): Promise<void> {
  for (const img of images) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(img.mediaType)) {
      throw new Error(`callModel: ${img.mediaType} images are not sent to providers`);
    }
    const meta = await sharp(img.bytes).metadata();
    if (meta.exif || meta.xmp) {
      throw new Error(
        'callModel: an image part carries EXIF/XMP metadata; send the stripped derivative (D202)',
      );
    }
  }
}

function model(rt: AiRuntime, r: Resolved): ModelObject {
  if (rt.modelFactory) return rt.modelFactory(r);
  if (rt.mock) return createMockModel(rt.mock, r.provider.model);
  return modelFor(r.provider, r.apiKey, rt.fetch);
}

function embeddingModel(rt: AiRuntime, r: Resolved): EmbeddingModelObject {
  if (rt.embeddingModelFactory) return rt.embeddingModelFactory(r);
  if (rt.mock) return createMockEmbeddingModel(r.provider.model);
  return embeddingModelFor(r.provider, r.apiKey, rt.fetch);
}

/** The SDK's tools for these specs: a description and a validating JSON Schema each, **never** an
 * `execute` (one request per call; spike S6.3 finding 1). The only place Kept builds SDK tools. */
export function toToolSet(defs: readonly ToolSpec[]): ToolSet {
  const set: ToolSet = {};
  for (const d of defs) {
    set[d.name] = tool({
      description: d.description,
      inputSchema: jsonSchema(d.inputSchema, d.validate ? { validate: d.validate } : {}),
    });
  }
  return set;
}

const BUCKET_KIND = /^([a-z_]+):/;

/** `over_budget`'s `error_code`: the bucket's kind and the reason (`location_cap_money`). */
export function capErrorCode(bucket: string, reason: CapPauseReason): string {
  const kind = BUCKET_KIND.exec(bucket)?.[1] ?? bucket.replace(/[^a-z_]/g, '');
  return `${kind}_${reason}`.slice(0, 40);
}

type ProviderPaused = {
  status: 'paused';
  kind: 'provider';
  until: Date;
  reason: ProviderPauseReason;
  callId?: string;
};

/**
 * The pacer's admission (step 2): sleeps up to `MAX_INLINE_SLEEPS` times in place, else holds. A
 * hold that is more than a short wait (a breaker trip, or the provider's window held for a minute
 * or more) records a `sent = false` row through `heldRow`.
 */
async function admitCall(
  rt: AiRuntime,
  provider: { id: string; kind: Resolved['provider']['kind'] },
  paceTokens: number,
  jobId: string,
  expectedOutputTokens: number,
  heldRow: (now: Date, outcome: LedgerOutcome, errorCode: string) => Promise<string>,
): Promise<{ lease: KeyLease } | ProviderPaused> {
  for (let sleeps = 0; ; sleeps++) {
    const now = rt.now();
    const a = await rt.pacer.admit(provider, paceTokens, jobId, now, expectedOutputTokens);
    if (a.ok) return { lease: a.lease };
    if (a.kind === 'sleep' && sleeps < MAX_INLINE_SLEEPS) {
      await rt.sleep(a.ms);
      continue;
    }
    const until = a.kind === 'sleep' ? new Date(now.getTime() + a.ms) : a.until;
    const reason: ProviderPauseReason = a.kind === 'sleep' ? 'limits' : a.reason;
    const held =
      reason === 'rate_limited' ||
      reason === 'quota' ||
      reason === 'provider_down' ||
      reason === 'auth' ||
      (reason === 'limits' && until.getTime() - now.getTime() >= HOLD_ROW_AFTER_MS);
    if (!held) return { status: 'paused', kind: 'provider', until, reason };
    const callId = await heldRow(
      now,
      reason === 'provider_down' || reason === 'auth' ? 'provider_error' : 'rate_limited',
      reason,
    );
    return { status: 'paused', kind: 'provider', until, reason, callId };
  }
}

export async function callModel<T>(rt: AiRuntime, req: CallRequest<T>): Promise<CallResult<T>> {
  await assertSendable(req.images);
  const { resolved } = req;
  const provider = { id: resolved.provider.id, kind: resolved.provider.kind };
  const settings = callSettingsFor(resolved.provider);
  const budgetTask: BudgetTask = budgetTaskOf(req.task);

  let instructions = req.instructions;
  if (req.output && settings.schemaInPrompt) {
    instructions += `\n\nAnswer with one JSON object matching this JSON Schema:\n${JSON.stringify(req.output.schema)}`;
  }
  const history = req.conversation?.messages ?? [];
  const toolText = req.tools
    ? JSON.stringify(req.tools.defs.map((d) => ({ n: d.name, d: d.description, s: d.inputSchema })))
    : '';
  const est = estimateCall({
    kind: provider.kind,
    images: req.images,
    promptText: `${instructions}\n${toolText}\n${conversationText(history)}\n${req.text}`,
    maxOutputTokens: req.maxOutputTokens,
    expectedOutputTokens: req.expectedOutputTokens,
  });
  const imageBytes = req.images.reduce((n, i) => n + i.bytes.byteLength, 0);
  const attachmentIds = req.images.flatMap((i) => (i.attachmentId ? [i.attachmentId] : []));

  const row = (now: Date, over: Partial<LedgerEntry>): LedgerEntry => ({
    reservationId: null,
    at: now,
    requestId: req.requestId,
    attempt: req.attempt,
    task: req.task,
    locationId: req.locationId,
    ownerAccountId: resolved.ownerAccountId,
    userId: req.userId,
    payingScope: resolved.payer.scope,
    payingAccountId: resolved.payer.accountId,
    payingUserId: resolved.payer.userId,
    fellBack: resolved.payer.fellBack,
    providerId: resolved.provider.id,
    providerKind: provider.kind,
    model: resolved.provider.model,
    reasoning: resolved.provider.reasoning,
    promptVersion: req.promptVersion,
    sent: false,
    estimateTokens: est.reserveTokens,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    imageCount: req.images.length,
    imageTokensEach: est.imageTokensEach,
    imageBytes: req.images.length ? imageBytes : null,
    attachmentIds: attachmentIds.length ? attachmentIds : null,
    latencyMs: null,
    finishReason: null,
    outcome: 'over_budget',
    errorCode: null,
    httpStatus: null,
    costAmount: null,
    costCurrency: null,
    costSource: 'not_sent',
    priceId: null,
    extractionId: req.links.extractionId ?? null,
    threadId: req.links.threadId ?? null,
    thingId: req.links.thingId ?? null,
    rlRemainingTokens: null,
    rlResetAt: null,
    ...over,
  });

  // 2. The provider's side: breaker, token window, key concurrency.
  const admitted = await admitCall(
    rt,
    provider,
    est.paceTokens,
    req.jobId,
    req.expectedOutputTokens,
    (now, outcome, errorCode) => rt.ledger.record(row(now, { outcome, errorCode })),
  );
  if ('status' in admitted) return admitted;
  let lease: KeyLease | null = admitted.lease;

  let reservation: Reservation | null = null;
  let settled = false;
  try {
    // 3. Kept's budgets and caps.
    const reserveAt = rt.now();
    const price = await rt.prices(provider.kind, resolved.provider.model, reserveAt);
    const r = await rt.gate.reserve({
      payer: resolved.payer,
      locationId: req.locationId,
      ownerAccountId: resolved.ownerAccountId,
      userId: req.userId,
      budgetTask,
      estimateTokens: est.reserveTokens,
      estimateCost: estimateCost(price, {
        inputTokens: est.inputTokens,
        outputTokens: req.maxOutputTokens,
      }),
      jobId: req.jobId,
      now: reserveAt,
    });
    if (!r.ok) {
      if (r.kind === 'wait')
        return { status: 'paused', kind: 'provider', until: r.until, reason: r.reason };
      const callId =
        r.callId ??
        (await rt.ledger.record(
          row(reserveAt, { outcome: 'over_budget', errorCode: capErrorCode(r.bucket, r.reason) }),
        ));
      return {
        status: 'paused',
        kind: 'cap',
        until: r.until,
        reason: r.reason,
        bucket: r.bucket,
        callId,
      };
    }
    reservation = r.reservation;

    // 4. The call, outside any transaction.
    const started = rt.now();
    const t0 = performance.now();
    const content = [
      { type: 'text' as const, text: req.text },
      ...req.images.map((img) => ({
        type: 'file' as const,
        mediaType: img.mediaType,
        data: { type: 'data' as const, data: img.bytes },
        ...(settings.imagePartOptions ? { providerOptions: settings.imagePartOptions } : {}),
      })),
    ];
    let usage: CallUsage = {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
    };
    let finishReason: string | null = null;
    let headers: Record<string, string> | undefined;
    let providerMetadata: unknown;
    let outcome: LedgerOutcome = 'ok';
    let errorCode: string | null = null;
    let httpStatus: number | null = null;
    let retryable = false;
    let pauses = false;
    let signal: Parameters<AiRuntime['pacer']['observe']>[1]['signal'] = { kind: 'ok' };
    let outputLimit: ReturnType<typeof classifyError>['outputLimit'] = null;
    let retryAfterMs: number | null = null;
    let value: T | null = null;
    let toolCalls: ToolCallOut[] = [];
    let reasoning: string | null = null;
    const messages: ModelMessage[] = [
      ...toModelMessages(history),
      ...(req.text || req.images.length ? [{ role: 'user' as const, content }] : []),
    ];

    try {
      const result = await generateText({
        model: model(rt, resolved),
        instructions,
        messages,
        ...(req.tools ? { tools: toToolSet(req.tools.defs), toolChoice: req.tools.choice } : {}),
        // One provider request per call, always: Kept runs the loop (the SDK's default today,
        // set so a future default can't start a loop Kept can't see).
        stopWhen: isStepCount(1),
        ...(req.output
          ? {
              output: Output.object({
                schema: jsonSchema(req.output.schema),
                name: req.output.name,
              }),
            }
          : {}),
        maxRetries: 0,
        maxOutputTokens: req.maxOutputTokens,
        ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
        ...(settings.providerOptions ? { providerOptions: settings.providerOptions } : {}),
        abortSignal: AbortSignal.timeout(rt.callTimeoutMs ?? CALL_TIMEOUT_MS),
      });
      usage = {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
        reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens ?? null,
        cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? null,
      };
      finishReason = result.finishReason;
      headers = result.response?.headers;
      providerMetadata = result.providerMetadata;
      toolCalls = fromToolCalls(result);
      reasoning = result.reasoningText ?? null;
      if (result.finishReason === 'length') {
        outcome = 'truncated';
        errorCode = 'length';
      } else if (result.finishReason === 'content-filter') {
        outcome = 'refused';
        errorCode = 'content_filter';
      } else if (toolCalls.some((c) => c.invalid)) {
        outcome = 'schema_invalid';
        errorCode = 'tool_input';
      } else if (req.output) {
        value = req.output.parse(result.output);
        if (value === null) {
          outcome = 'schema_invalid';
          errorCode = 'schema';
        }
      } else {
        value = result.text as T;
      }
    } catch (e) {
      const c = classifyError(e, rt.now());
      ({ outcome, errorCode, httpStatus, retryable, pauses, signal } = c);
      outputLimit = c.outputLimit ?? null;
      retryAfterMs = c.retryAfterMs ?? null;
      headers =
        c.headers ?? (e as { response?: { headers?: Record<string, string> } }).response?.headers;
      const u = (
        e as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            outputTokenDetails?: { reasoningTokens?: number };
            inputTokenDetails?: { cacheReadTokens?: number };
          };
        }
      ).usage;
      if (u) {
        usage = {
          inputTokens: u.inputTokens ?? null,
          outputTokens: u.outputTokens ?? null,
          reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? null,
          cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? null,
        };
      }
      finishReason = (e as { finishReason?: string }).finishReason ?? null;
      rt.log.warn(
        {
          ai: providerErrorForLog(e, resolved.apiKey),
          task: req.task,
          providerKind: provider.kind,
          model: resolved.provider.model,
          requestId: req.requestId,
          outcome,
        },
        'AI call failed',
      );
    }
    const latencyMs = Math.round(performance.now() - t0);
    const doneAt = rt.now();
    const limits: ProviderLimits | null = await rt.pacer.observe(
      provider,
      { headers, signal, outputTokens: usage.outputTokens, outputLimit, retryAfterMs },
      doneAt,
    );
    await rt.pacer.release(lease);
    lease = null;

    // 6. Cost, the ledger row, the settlement.
    const cost = costOf({
      providerCost: providerReportedCost(providerMetadata),
      price,
      usage,
      imageCount: req.images.length,
    });
    const callId = await rt.ledger.record(
      row(started, {
        reservationId: reservation.id,
        sent: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        latencyMs,
        finishReason: finishReason?.slice(0, 40) ?? null,
        outcome,
        errorCode,
        httpStatus,
        costAmount: cost.amount,
        costCurrency: cost.currency,
        costSource: cost.source,
        priceId: cost.priceId,
        rlRemainingTokens: limits?.remainingTokens ?? null,
        rlResetAt: limits?.resetAt ?? null,
      }),
    );
    const crossed = await rt.gate.settle(reservation, {
      tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      cost:
        cost.amount !== null && cost.currency !== null
          ? { amount: cost.amount, currency: cost.currency }
          : null,
      callId,
      now: doneAt,
    });
    settled = true;
    if (rt.onCrossed) for (const c of crossed) await rt.onCrossed(c);

    if (outcome === 'ok' && value !== null) {
      return {
        status: 'ok',
        value,
        usage,
        cost,
        callId,
        latencyMs,
        crossed,
        toolCalls,
        finishReason,
        reasoning,
      };
    }
    if (pauses) {
      const trip = await rt.pacer.admit(provider, 0, `${req.jobId}:probe`, rt.now());
      if (trip.ok) await rt.pacer.release(trip.lease);
      const until =
        !trip.ok && trip.kind === 'hold' ? trip.until : new Date(doneAt.getTime() + 60_000);
      const reason: ProviderPauseReason =
        errorCode === 'auth' ? 'auth' : errorCode === 'quota' ? 'quota' : 'rate_limited';
      return { status: 'paused', kind: 'provider', until, reason, callId };
    }
    return {
      status: 'failed',
      outcome: outcome as Exclude<LedgerOutcome, 'ok' | 'over_budget'>,
      errorCode: errorCode ?? 'unknown',
      retryable,
      callId,
      ...(errorCode === 'tool_input' ? { toolCalls, reasoning } : {}),
    };
  } finally {
    if (lease) await rt.pacer.release(lease);
    if (reservation && !settled) {
      await rt.gate.settle(reservation, { tokens: 0, cost: null, callId: '', now: rt.now() });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The embedding door (step-6 plan T8 step 6; D200, D206, D207; spike S6.4).

export type EmbedRequest = {
  resolved: Resolved;
  task: Extract<LedgerTask, 'embed_thing' | 'embed_query'>;
  locationId: string | null;
  userId: string | null;
  /** `thingId` for a single thing's embedding; none for a batch. */
  links: { thingId?: string };
  /** At most EMBED_BATCH_MAX values and the model's own per-request limit: one request. Never a
   * secret or a money figure (D116, D200): the caller builds them (embeddings/text.ts). */
  values: string[];
  /** Shorter vectors where the provider allows it (spike S6.4 finding 2). */
  dimensions?: number;
  requestId: string;
  attempt: number;
  jobId: string;
};

export type EmbedResult =
  | {
      status: 'ok';
      vectors: number[][];
      /** Input tokens as the provider reported them; null when it reported none (Google,
       * spike S6.4 finding 5), and the budgets were then settled on the estimate. */
      usage: { tokens: number | null };
      cost: Cost;
      callId: string;
      latencyMs: number;
      crossed: Crossed[];
    }
  | Extract<CallResult<never>, { status: 'paused' }>
  | Omit<Extract<CallResult<never>, { status: 'failed' }>, 'toolCalls' | 'reasoning'>;

/** The values one request may carry for this model: the smaller of its own limit and ours. */
export async function embedBatchLimit(m: EmbeddingModelObject): Promise<number> {
  const own = await (m as { maxEmbeddingsPerCall?: PromiseLike<number | undefined> | number })
    .maxEmbeddingsPerCall;
  return typeof own === 'number' && Number.isFinite(own) && own > 0
    ? Math.min(own, EMBED_BATCH_MAX)
    : EMBED_BATCH_MAX;
}

/**
 * Embeds `values` in **one** provider request, on callModel's path: the pacer admits it, the gate
 * reserves the estimate (budget task `embeddings`), `embedMany` runs with retries off, one value
 * per request at most the model's limit and `maxParallelCalls: 1`, no transaction open; then the
 * pacer observes, the cost, **one ledger row** (`image_count` 0, the thing for a single thing,
 * never a value or a vector), the settlement and its crossings. A batch over the limit is a
 * programming error (the caller chunks).
 */
export async function embedValues(rt: AiRuntime, req: EmbedRequest): Promise<EmbedResult> {
  const { resolved } = req;
  const provider = { id: resolved.provider.id, kind: resolved.provider.kind };
  const m = embeddingModel(rt, resolved);
  const limit = await embedBatchLimit(m);
  if (req.values.length === 0 || req.values.length > limit) {
    throw new Error(`embedValues: 1–${limit} values per request, got ${req.values.length}`);
  }
  const estimateTokens = req.values.reduce((n, v) => n + estimateTextTokens(v), 0);
  const base = (now: Date, over: Partial<LedgerEntry>): LedgerEntry => ({
    reservationId: null,
    at: now,
    requestId: req.requestId,
    attempt: req.attempt,
    task: req.task,
    locationId: req.locationId,
    ownerAccountId: resolved.ownerAccountId,
    userId: req.userId,
    payingScope: resolved.payer.scope,
    payingAccountId: resolved.payer.accountId,
    payingUserId: resolved.payer.userId,
    fellBack: resolved.payer.fellBack,
    providerId: resolved.provider.id,
    providerKind: provider.kind,
    model: resolved.provider.model,
    reasoning: null,
    promptVersion: null,
    sent: false,
    estimateTokens,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    imageCount: 0,
    imageTokensEach: null,
    imageBytes: null,
    attachmentIds: null,
    latencyMs: null,
    finishReason: null,
    outcome: 'over_budget',
    errorCode: null,
    httpStatus: null,
    costAmount: null,
    costCurrency: null,
    costSource: 'not_sent',
    priceId: null,
    extractionId: null,
    threadId: null,
    thingId: req.links.thingId ?? null,
    rlRemainingTokens: null,
    rlResetAt: null,
    ...over,
  });

  const admitted = await admitCall(
    rt,
    provider,
    estimateTokens,
    req.jobId,
    0,
    (now, outcome, code) => rt.ledger.record(base(now, { outcome, errorCode: code })),
  );
  if ('status' in admitted) return admitted;
  let lease: KeyLease | null = admitted.lease;

  let reservation: Reservation | null = null;
  let settled = false;
  try {
    const reserveAt = rt.now();
    const price = await rt.prices(provider.kind, resolved.provider.model, reserveAt);
    const r = await rt.gate.reserve({
      payer: resolved.payer,
      locationId: req.locationId,
      ownerAccountId: resolved.ownerAccountId,
      userId: req.userId,
      budgetTask: 'embeddings',
      estimateTokens,
      estimateCost: estimateCost(price, { inputTokens: estimateTokens, outputTokens: 0 }),
      jobId: req.jobId,
      now: reserveAt,
    });
    if (!r.ok) {
      if (r.kind === 'wait')
        return { status: 'paused', kind: 'provider', until: r.until, reason: r.reason };
      const callId =
        r.callId ??
        (await rt.ledger.record(
          base(reserveAt, { outcome: 'over_budget', errorCode: capErrorCode(r.bucket, r.reason) }),
        ));
      return {
        status: 'paused',
        kind: 'cap',
        until: r.until,
        reason: r.reason,
        bucket: r.bucket,
        callId,
      };
    }
    reservation = r.reservation;

    const started = rt.now();
    const t0 = performance.now();
    let reported: number | null = null;
    let headers: Record<string, string> | undefined;
    let providerMetadata: unknown;
    let outcome: LedgerOutcome = 'ok';
    let errorCode: string | null = null;
    let httpStatus: number | null = null;
    let retryable = false;
    let pauses = false;
    let signal: Parameters<AiRuntime['pacer']['observe']>[1]['signal'] = { kind: 'ok' };
    let retryAfterMs: number | null = null;
    let vectors: number[][] | null = null;
    try {
      const providerOptions = embeddingDimensionsOption(provider.kind, req.dimensions);
      const result = await embedMany({
        model: m,
        values: req.values,
        maxRetries: 0,
        maxParallelCalls: 1,
        ...(providerOptions ? { providerOptions } : {}),
        abortSignal: AbortSignal.timeout(rt.callTimeoutMs ?? CALL_TIMEOUT_MS),
      });
      vectors = result.embeddings.map((e) => Array.from(e));
      const tokens = result.usage?.tokens;
      reported = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
      headers = result.responses?.[0]?.headers;
      providerMetadata = result.providerMetadata;
      if (vectors.length !== req.values.length) {
        outcome = 'schema_invalid';
        errorCode = 'vector_count';
        vectors = null;
      }
    } catch (e) {
      const c = classifyError(e, rt.now());
      ({ outcome, errorCode, httpStatus, retryable, pauses, signal } = c);
      retryAfterMs = c.retryAfterMs ?? null;
      headers =
        c.headers ?? (e as { response?: { headers?: Record<string, string> } }).response?.headers;
      rt.log.warn(
        {
          ai: providerErrorForLog(e, resolved.apiKey),
          task: req.task,
          providerKind: provider.kind,
          model: resolved.provider.model,
          requestId: req.requestId,
          outcome,
        },
        'AI embedding failed',
      );
    }
    const latencyMs = Math.round(performance.now() - t0);
    const doneAt = rt.now();
    const limits = await rt.pacer.observe(
      provider,
      { headers, signal, outputTokens: 0, outputLimit: null, retryAfterMs },
      doneAt,
    );
    await rt.pacer.release(lease);
    lease = null;

    // A provider that reports no tokens (S6.4 finding 5): the row carries the estimate, flagged
    // usage_estimated, and is priced from it, as the budgets are settled on it below.
    const estimated = outcome === 'ok' && reported === null;
    const usage: CallUsage = {
      inputTokens: estimated ? estimateTokens : reported,
      outputTokens: outcome === 'ok' ? 0 : null,
      reasoningTokens: null,
      cachedInputTokens: null,
    };
    const cost = costOf({
      providerCost: providerReportedCost(providerMetadata),
      price,
      usage,
      imageCount: 0,
    });
    const callId = await rt.ledger.record(
      base(started, {
        reservationId: reservation.id,
        sent: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usageEstimated: estimated,
        latencyMs,
        outcome,
        errorCode,
        httpStatus,
        costAmount: cost.amount,
        costCurrency: cost.currency,
        costSource: cost.source,
        priceId: cost.priceId,
        rlRemainingTokens: limits?.remainingTokens ?? null,
        rlResetAt: limits?.resetAt ?? null,
      }),
    );
    const crossed = await rt.gate.settle(reservation, {
      tokens: usage.inputTokens ?? 0,
      cost:
        cost.amount !== null && cost.currency !== null
          ? { amount: cost.amount, currency: cost.currency }
          : null,
      callId,
      now: doneAt,
    });
    settled = true;
    if (rt.onCrossed) for (const c of crossed) await rt.onCrossed(c);

    if (outcome === 'ok' && vectors) {
      return {
        status: 'ok',
        vectors,
        usage: { tokens: reported },
        cost,
        callId,
        latencyMs,
        crossed,
      };
    }
    if (pauses) {
      const trip = await rt.pacer.admit(provider, 0, `${req.jobId}:probe`, rt.now());
      if (trip.ok) await rt.pacer.release(trip.lease);
      const until =
        !trip.ok && trip.kind === 'hold' ? trip.until : new Date(doneAt.getTime() + 60_000);
      const reason: ProviderPauseReason =
        errorCode === 'auth' ? 'auth' : errorCode === 'quota' ? 'quota' : 'rate_limited';
      return { status: 'paused', kind: 'provider', until, reason, callId };
    }
    return {
      status: 'failed',
      outcome: outcome as Exclude<LedgerOutcome, 'ok' | 'over_budget'>,
      errorCode: errorCode ?? 'unknown',
      retryable,
      callId,
    };
  } finally {
    if (lease) await rt.pacer.release(lease);
    if (reservation && !settled) {
      await rt.gate.settle(reservation, { tokens: 0, cost: null, callId: '', now: rt.now() });
    }
  }
}
