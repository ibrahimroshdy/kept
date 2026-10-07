/**
 * The provider layer's ports (step-3 T8). `callModel` (call.ts) talks to four of them, so the
 * layer is built and tested before the step-3 tables exist (T6). memory.ts has in-memory
 * implementations for tests, the evaluation harness (T11) and development; the DB-backed ones
 * plug in with T6's `kept.ai_*` doors:
 *
 * | Port | In memory | With T6 |
 * |---|---|---|
 * | `KeyStore` | a provider list + the Q5 cascade (resolve.ts) | `kept.ai_provider_for` / `kept.ai_provider_secret`, then the keyring's `open()` |
 * | `BudgetGate` | caps, buckets and windows (memory.ts) | `kept.ai_reserve` / `kept.ai_settle` |
 * | `Ledger` | an array of rows | `kept.ai_reserve` (held-back rows) and `kept.ai_settle` (the rest) |
 * | `Pacer` | breaker + header limits + key slots | `ai_breakers` (`kept.ai_trip`), `ai_provider_limits`, the `key:` leases |
 *
 * For a DB adapter where one door does two ports' work: `ReserveRefused.callId` lets the gate
 * say it already wrote the held-back row (callModel then records none), and
 * `LedgerEntry.reservationId` lets `Ledger.record` true up the reservation in the same
 * `kept.ai_settle` call (then `BudgetGate.settle` returns what that call returned).
 */
import type {
  AiTask,
  BudgetTask,
  CostSource,
  LedgerOutcome,
  LedgerTask,
  ProviderKind,
} from '@kept/shared';
import type { BreakerReason, BreakerSignal } from './breaker.js';
import type { HeaderBag, OutputLimitSeen, ProviderLimits } from './pacing.js';

import type { Reasoning } from './providers.js';

export type PayerScope = 'instance' | 'account' | 'user';

/** A provider as `kept.ai_provider_for` returns it, minus the key. */
export type ResolvedProvider = {
  id: string;
  scope: PayerScope;
  kind: ProviderKind;
  baseUrl: string | null;
  /** The model for the task being resolved. */
  model: string;
  reasoning: Reasoning;
  /** `capabilities.structured` (matters for `openai_compatible`). */
  structured?: boolean;
};

export type Payer = {
  scope: PayerScope;
  accountId: string | null;
  userId: string | null;
  /** Paid by a scope further down the cascade than the closest one (D206). */
  fellBack: boolean;
};

/** What resolve hands callModel: the key lives only here, in the caller's frame, never logged. */
export type Resolved = {
  provider: ResolvedProvider;
  apiKey: string | null;
  payer: Payer;
  /** The location's owner account, or the person's own account for personal work: the
   * `instance_account:` bucket and `llm_calls.owner_account_id`. */
  ownerAccountId: string | null;
};

export type ResolveRequest = {
  locationId: string | null;
  userId: string | null;
  task: AiTask;
};

export interface KeyStore {
  /** The D121/D167/D206 cascade (Q5) for a task; null: no provider, and AI stays off (D19). */
  resolve(req: ResolveRequest): Promise<Resolved | null>;
  /** One provider the caller manages, for "Test connection" and the model list (T9). */
  forProvider(providerId: string, task: AiTask): Promise<Resolved | null>;
}

/** One `llm_calls` row (engineering spec §7.15), camelCased. Never a prompt, image, reply,
 * provider message or key: there is no field that could hold one. */
export type LedgerEntry = {
  reservationId: string | null;
  at: Date;
  requestId: string;
  attempt: number;
  task: LedgerTask;
  locationId: string | null;
  ownerAccountId: string | null;
  userId: string | null;
  payingScope: PayerScope;
  payingAccountId: string | null;
  payingUserId: string | null;
  fellBack: boolean;
  providerId: string | null;
  providerKind: ProviderKind;
  model: string;
  reasoning: string | null;
  promptVersion: string | null;
  sent: boolean;
  estimateTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  /** `inputTokens` is Kept's estimate: the provider reported none (S6.4 finding 5). */
  usageEstimated?: boolean;
  imageCount: number;
  imageTokensEach: number | null;
  imageBytes: number | null;
  attachmentIds: string[] | null;
  latencyMs: number | null;
  finishReason: string | null;
  outcome: LedgerOutcome;
  /** `^[a-z0-9_]{1,40}$`. */
  errorCode: string | null;
  httpStatus: number | null;
  costAmount: string | null;
  costCurrency: string | null;
  costSource: CostSource;
  priceId: string | null;
  extractionId: string | null;
  threadId: string | null;
  thingId: string | null;
  rlRemainingTokens: number | null;
  rlResetAt: Date | null;
};

export interface Ledger {
  /** Appends one row and returns its id. */
  record(entry: LedgerEntry): Promise<string>;
}

export type CapPauseReason = 'manual' | 'cap_money' | 'cap_tokens' | 'tokens_day';

export type ReserveRequest = {
  payer: Payer;
  locationId: string | null;
  ownerAccountId: string | null;
  userId: string | null;
  budgetTask: BudgetTask;
  estimateTokens: number;
  estimateCost: { amount: string; currency: string } | null;
  jobId: string;
  now: Date;
};

export type Reservation = {
  id: string;
  buckets: string[];
  estimateTokens: number;
  estimateCost: { amount: string; currency: string } | null;
  leaseKey: string;
  slot: number;
};

export type ReserveRefused =
  | {
      ok: false;
      kind: 'cap';
      reason: CapPauseReason;
      until: Date;
      /** The bucket that paused it (`location:<id>`, `account:<id>:<task>` …). */
      bucket: string;
      /** Set when the gate already wrote the `sent = false` row (T6's `kept.ai_reserve`). */
      callId?: string;
    }
  | { ok: false; kind: 'wait'; reason: 'tpm' | 'concurrency'; until: Date };

export type ReserveResult = { ok: true; reservation: Reservation } | ReserveRefused;

/** A monthly cap this call took past 80% or 100% (once per cap per month): enqueue
 * `ai.cap_notice` (T9). */
export type Crossed = { budgetId: string; bucket: string; level: 80 | 100; month: string };

export interface BudgetGate {
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  /** Trues up the reservation (actual − estimate tokens; the real cost replaces the estimate)
   * and frees its payer slot. Every reserved call settles, sent or not. */
  settle(
    reservation: Reservation,
    actual: {
      tokens: number;
      cost: { amount: string; currency: string } | null;
      callId: string;
      now: Date;
    },
  ): Promise<Crossed[]>;
}

export type ProviderRef = { id: string; kind: ProviderKind };

/** What a sent call showed the pacer: the headers, the breaker's signal, and for an output-token
 * limit (pacing.ts) the output it produced or the limit its 429 named. */
export type Observed = {
  headers: HeaderBag;
  signal: BreakerSignal;
  outputTokens?: number | null;
  outputLimit?: OutputLimitSeen | null;
  retryAfterMs?: number | null;
};

export type KeyLease = { providerId: string; slot: number; jobId: string };

export type Admission =
  | { ok: true; lease: KeyLease }
  | { ok: false; kind: 'sleep'; ms: number }
  | {
      ok: false;
      kind: 'hold';
      until: Date;
      reason: 'limits' | 'concurrency' | BreakerReason;
    };

export interface Pacer {
  /** Breaker, then the provider's token window, then the key's concurrency (1 for Groq). */
  admit(
    p: ProviderRef,
    estimateTokens: number,
    jobId: string,
    now: Date,
    /** The call's expected output, for a key with a learned output-token limit (pacing.ts). */
    expectedOutputTokens?: number,
  ): Promise<Admission>;
  release(lease: KeyLease): Promise<void>;
  /** After every sent call: the rate-limit headers and what happened, for the breaker. */
  observe(p: ProviderRef, seen: Observed, now: Date): Promise<ProviderLimits | null>;
  /** A replaced key clears an `auth` trip (T9). */
  clearAuth(providerId: string): Promise<void>;
}
