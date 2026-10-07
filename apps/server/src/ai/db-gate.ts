/**
 * The DB-backed BudgetGate and Ledger (ports.ts; step-3 T6), one object for both ports because
 * one door does both jobs: `kept.ai_reserve` holds the estimate and a payer slot, and
 * `kept.ai_settle` writes the ledger row, trues up every bucket and frees the slot in one
 * transaction. So:
 * - `record(entry)` of a settled call (`entry.reservationId` set) calls ai_settle with the
 *   reservation and keeps what it returned; `settle()` for that reservation then just hands the
 *   crossings back.
 * - `record(entry)` without a reservation (a call Kept held back) writes the row alone.
 * - `settle()` of a reservation that was never recorded (callModel's `finally`, after a throw)
 *   trues it up with no row.
 * - `reserve()` refusals carry no `callId`: the port's request has no ledger fields, so callModel
 *   writes the held-back row through `record()`. The door can write it itself when given them.
 * Behaviour matches memory.ts's InMemoryBudgetGate (db-gate.test.ts runs its scenarios), except
 * that the clock is the database's, and an account's share of the instance allowance is paused on
 * its own copy of the default row, never the shared one.
 */
import { budgetTaskOf, DEFAULT_BUDGETS } from '@kept/shared';
import { type DoorRunner, fromDbTime } from './db-run.js';
import type {
  BudgetGate,
  CapPauseReason,
  Crossed,
  Ledger,
  LedgerEntry,
  Reservation,
  ReserveRequest,
  ReserveResult,
} from './ports.js';

/** DEFAULT_BUDGETS (Q7) as the door takes them. */
const DEFAULTS = Object.fromEntries(
  Object.entries(DEFAULT_BUDGETS).map(([task, b]) => [
    task,
    {
      tokens_per_minute: b.tokensPerMinute,
      tokens_per_day: b.tokensPerDay,
      tokens_per_month: b.tokensPerMonth,
    },
  ]),
);
const PAYER_SLOTS = DEFAULT_BUDGETS.extraction.concurrency;

type BudgetCtx = Record<string, unknown>;

function budgetCtx(req: ReserveRequest): BudgetCtx {
  return {
    paying_scope: req.payer.scope,
    paying_account_id: req.payer.accountId,
    paying_user_id: req.payer.userId,
    fell_back: req.payer.fellBack,
    location_id: req.locationId,
    owner_account_id: req.ownerAccountId,
    user_id: req.userId,
    budget_task: req.budgetTask,
    estimate_tokens: req.estimateTokens,
    estimate_cost: req.estimateCost,
    job_id: req.jobId,
    defaults: DEFAULTS,
    payer_slots: PAYER_SLOTS,
  };
}

/** A ledger entry as kept.ai_insert_call reads it: the call's fields in ctx, what happened in
 * usage, the cost. Nothing here can carry a prompt, image, reply, provider message or key. */
function ledgerParts(entry: LedgerEntry) {
  const ctx = {
    at: entry.at.toISOString(),
    request_id: entry.requestId,
    attempt: entry.attempt,
    task: entry.task,
    budget_task: budgetTaskOf(entry.task),
    location_id: entry.locationId,
    owner_account_id: entry.ownerAccountId,
    user_id: entry.userId,
    paying_scope: entry.payingScope,
    paying_account_id: entry.payingAccountId,
    paying_user_id: entry.payingUserId,
    fell_back: entry.fellBack,
    provider_id: entry.providerId,
    provider_kind: entry.providerKind,
    model: entry.model,
    reasoning: entry.reasoning,
    prompt_version: entry.promptVersion,
    estimate_tokens: entry.estimateTokens,
    image_count: entry.imageCount,
    image_tokens_each: entry.imageTokensEach,
    image_bytes: entry.imageBytes,
    attachment_ids: entry.attachmentIds,
    extraction_id: entry.extractionId,
    thread_id: entry.threadId,
    thing_id: entry.thingId,
  };
  const usage = {
    sent: entry.sent,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    reasoning_tokens: entry.reasoningTokens,
    cached_input_tokens: entry.cachedInputTokens,
    usage_estimated: entry.usageEstimated ?? false,
    tokens: (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
    latency_ms: entry.latencyMs,
    finish_reason: entry.finishReason,
    error_code: entry.errorCode,
    http_status: entry.httpStatus,
    ...(entry.rlRemainingTokens === null && entry.rlResetAt === null
      ? {}
      : {
          rl_remaining_tokens: entry.rlRemainingTokens,
          rl_reset_at: entry.rlResetAt?.toISOString() ?? null,
        }),
  };
  const cost = entry.sent
    ? {
        amount: entry.costAmount,
        currency: entry.costCurrency,
        source: entry.costSource,
        price_id: entry.priceId,
      }
    : null;
  return { ctx, usage, cost };
}

type ReserveRow = {
  ok: boolean;
  retry_at: Date | number | null;
  reason: string | null;
  bucket: string | null;
  call_id: string | null;
  buckets: string[];
  slot: number | null;
};
type SettleRow = { call_id: string | null; crossed: Crossed[] };

export class DbBudgetGate implements BudgetGate, Ledger {
  /** Reservations not yet settled: their budget context and estimate. */
  private readonly pending = new Map<string, { ctx: BudgetCtx; reservation: Reservation }>();
  /** Reservations `record()` already settled, with the crossings ai_settle returned. */
  private readonly settled = new Map<string, Crossed[]>();

  constructor(private readonly run: DoorRunner) {}

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const ctx = budgetCtx(req);
    const r = await this.run(async (client) => {
      const { rows } = await client.query<ReserveRow>('SELECT * FROM kept.ai_reserve($1)', [
        JSON.stringify(ctx),
      ]);
      return rows[0] as ReserveRow;
    });
    if (r.ok) {
      const reservation: Reservation = {
        id: r.call_id as string,
        buckets: r.buckets,
        estimateTokens: req.estimateTokens,
        estimateCost: req.estimateCost,
        leaseKey: `payer:${req.payer.scope}:${req.payer.accountId ?? req.payer.userId ?? 'instance'}`,
        slot: r.slot as number,
      };
      this.pending.set(reservation.id, { ctx, reservation });
      return { ok: true, reservation };
    }
    if (r.reason === 'tpm' || r.reason === 'concurrency') {
      return { ok: false, kind: 'wait', reason: r.reason, until: fromDbTime(r.retry_at) as Date };
    }
    return {
      ok: false,
      kind: 'cap',
      reason: r.reason as CapPauseReason,
      until: fromDbTime(r.retry_at) as Date,
      bucket: r.bucket as string,
      ...(r.call_id ? { callId: r.call_id } : {}),
    };
  }

  private settleRow(ctx: BudgetCtx, usage: object, outcome: string, cost: object | null) {
    return this.run(async (client) => {
      const { rows } = await client.query<SettleRow>(
        'SELECT * FROM kept.ai_settle($1, $2, $3, $4)',
        [JSON.stringify(ctx), JSON.stringify(usage), outcome, cost ? JSON.stringify(cost) : null],
      );
      return rows[0] as SettleRow;
    });
  }

  private reservationCtx(id: string) {
    const p = this.pending.get(id);
    if (!p) return null;
    return {
      ...p.ctx,
      reservation: {
        id,
        slot: p.reservation.slot,
        estimate_tokens: p.reservation.estimateTokens,
        estimate_cost: p.reservation.estimateCost,
      },
    };
  }

  async record(entry: LedgerEntry): Promise<string> {
    const { ctx, usage, cost } = ledgerParts(entry);
    const held = entry.reservationId ? this.reservationCtx(entry.reservationId) : null;
    const row = await this.settleRow(
      { ...(held ?? {}), ...ctx, defaults: DEFAULTS },
      usage,
      entry.outcome,
      cost,
    );
    if (held && entry.reservationId) {
      this.pending.delete(entry.reservationId);
      this.settled.set(entry.reservationId, row.crossed);
    }
    return row.call_id as string;
  }

  async settle(
    reservation: Reservation,
    actual: {
      tokens: number;
      cost: { amount: string; currency: string } | null;
      callId: string;
      now: Date;
    },
  ): Promise<Crossed[]> {
    const done = this.settled.get(reservation.id);
    if (done) {
      this.settled.delete(reservation.id);
      return done;
    }
    const ctx = this.reservationCtx(reservation.id);
    if (!ctx) return [];
    this.pending.delete(reservation.id);
    const row = await this.settleRow(
      { ...ctx, record: false },
      { sent: true, tokens: actual.tokens },
      'ok',
      actual.cost
        ? { amount: actual.cost.amount, currency: actual.cost.currency, source: 'provider' }
        : null,
    );
    return row.crossed;
  }
}
