/**
 * In-memory implementations of the four ports (ports.ts), for unit tests, the evaluation
 * harness's no-database run (T11) and development. They follow engineering spec §7.15's rules
 * (buckets, windows, pauses, leases, the 80%/100% crossings) so the tests of callModel exercise
 * the real behaviour; T6's doors are the production implementation.
 *
 * One simplification: a money cap counts only costs in its own currency (the DB door also counts
 * other currencies through the account's `fx_rates`).
 */
import { randomUUID } from 'node:crypto';
import { type AiTask, concurrencyOf, DEFAULT_BUDGETS } from '@kept/shared';
import { type BreakerState, clearAuth, nextBreaker, trippedAt } from './breaker.js';
import { fromMicro, toMicro } from './cost.js';
import {
  nextOutputWindow,
  type OutputWindow,
  type ProviderLimits,
  readLimits,
  waitFor,
  waitForOutput,
} from './pacing.js';
import type {
  Admission,
  BudgetGate,
  CapPauseReason,
  Crossed,
  KeyLease,
  KeyStore,
  Ledger,
  LedgerEntry,
  Observed,
  Pacer,
  ProviderRef,
  Reservation,
  ReserveRequest,
  ReserveResult,
  Resolved,
  ResolveRequest,
} from './ports.js';
import { cascade, type LocationFacts, modelForTask, type ProviderRow, payerOf } from './resolve.js';

// --- KeyStore ------------------------------------------------------------------------------

export class InMemoryKeyStore implements KeyStore {
  constructor(
    readonly providers: ProviderRow[],
    readonly locations: LocationFacts[] = [],
    /** user id → the account they own. */
    readonly userAccounts: Record<string, string> = {},
  ) {}

  async resolve(req: ResolveRequest): Promise<Resolved | null> {
    const location =
      req.locationId === null ? null : this.locations.find((l) => l.id === req.locationId);
    if (location === undefined) return null;
    return cascade({
      providers: this.providers,
      location,
      userId: req.userId,
      userAccountId: req.userId === null ? null : (this.userAccounts[req.userId] ?? null),
      task: req.task,
    });
  }

  async forProvider(providerId: string, task: AiTask): Promise<Resolved | null> {
    const p = this.providers.find((x) => x.id === providerId && !x.disabled);
    const model = p ? modelForTask(p, task) : null;
    if (!p || !model) return null;
    return {
      provider: {
        id: p.id,
        scope: p.scope,
        kind: p.kind,
        baseUrl: p.baseUrl,
        model,
        reasoning: p.reasoning,
        ...(p.structured === undefined ? {} : { structured: p.structured }),
      },
      apiKey: p.apiKey,
      payer: payerOf(p, false),
      ownerAccountId: p.ownerAccountId,
    };
  }
}

// --- Ledger --------------------------------------------------------------------------------

export class InMemoryLedger implements Ledger {
  readonly rows: (LedgerEntry & { id: string })[] = [];
  async record(entry: LedgerEntry): Promise<string> {
    const id = randomUUID();
    this.rows.push({ ...entry, id });
    return id;
  }
}

// --- BudgetGate ----------------------------------------------------------------------------

export type CapRow = {
  id: string;
  scope: 'instance' | 'instance_account' | 'account' | 'location' | 'member' | 'user';
  ownerAccountId: string | null;
  locationId: string | null;
  userId: string | null;
  task: AiTask | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  monthlyCapAmount: string | null;
  capCurrency: string | null;
  pausedUntil: Date | null;
  pausedReason: CapPauseReason | null;
  warned80Month: string | null;
  warned100Month: string | null;
};

export function capRow(partial: Partial<CapRow> & Pick<CapRow, 'scope'>): CapRow {
  return {
    id: randomUUID(),
    ownerAccountId: null,
    locationId: null,
    userId: null,
    task: null,
    tokensPerMinute: null,
    tokensPerDay: null,
    tokensPerMonth: null,
    monthlyCapAmount: null,
    capCurrency: null,
    pausedUntil: null,
    pausedReason: null,
    warned80Month: null,
    warned100Month: null,
    ...partial,
  };
}

const minuteStart = (d: Date) => Math.floor(d.getTime() / 60_000) * 60_000;
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
const nextDay = (d: Date) => new Date(dayStart(d) + 86_400_000);
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

type Windows = {
  minute: Map<number, number>;
  day: Map<number, number>;
  month: Map<string, number>;
};

/**
 * The buckets a call counts against (§7.15): `location:`/`member:` when there is a location
 * (and a person), then the payer's.
 */
export function bucketsFor(
  req: Pick<ReserveRequest, 'payer' | 'locationId' | 'ownerAccountId' | 'userId' | 'budgetTask'>,
): string[] {
  const b: string[] = [];
  if (req.locationId) {
    b.push(`location:${req.locationId}`);
    if (req.userId && req.ownerAccountId) b.push(`member:${req.ownerAccountId}:${req.userId}`);
  }
  switch (req.payer.scope) {
    case 'account':
      b.push(`account:${req.payer.accountId}`, `account:${req.payer.accountId}:${req.budgetTask}`);
      break;
    case 'user':
      b.push(`user:${req.payer.userId}`);
      break;
    case 'instance':
      b.push('instance', `instance:${req.budgetTask}`);
      if (req.ownerAccountId) b.push(`instance_account:${req.ownerAccountId}`);
      break;
  }
  return b.sort();
}

export class InMemoryBudgetGate implements BudgetGate {
  readonly windows = new Map<string, Windows>();
  /** bucket → month → currency → millionths. */
  readonly costs = new Map<string, Map<string, Map<string, bigint>>>();
  readonly leases = new Map<string, (string | null)[]>();
  readonly reservations = new Map<string, Reservation>();

  constructor(
    readonly caps: CapRow[] = [],
    readonly payerSlots = 2,
  ) {}

  /** The cap rows that govern a bucket (a task bucket falls back to DEFAULT_BUDGETS, Q7). */
  private rowsFor(bucket: string): CapRow[] {
    const [kind, a, b] = bucket.split(':') as [string, string | undefined, string | undefined];
    const match = (pred: (c: CapRow) => boolean) => this.caps.filter(pred);
    switch (kind) {
      case 'location':
        return match((c) => c.scope === 'location' && c.locationId === a);
      case 'member':
        return match((c) => c.scope === 'member' && c.ownerAccountId === a && c.userId === b);
      case 'user':
        return match((c) => c.scope === 'user' && c.userId === a);
      case 'account':
        return b === undefined
          ? match((c) => c.scope === 'account' && c.ownerAccountId === a && c.task === null)
          : this.orDefault(
              match((c) => c.scope === 'account' && c.ownerAccountId === a && c.task === b),
              b,
              {
                scope: 'account',
                ownerAccountId: a ?? null,
              },
            );
      case 'instance':
        return a === undefined
          ? match((c) => c.scope === 'instance' && c.task === null)
          : this.orDefault(
              match((c) => c.scope === 'instance' && c.task === a),
              a,
              { scope: 'instance' },
            );
      case 'instance_account': {
        const own = match((c) => c.scope === 'instance_account' && c.ownerAccountId === a);
        return own.length
          ? own
          : match((c) => c.scope === 'instance_account' && c.ownerAccountId === null);
      }
      default:
        return [];
    }
  }

  private orDefault(
    rows: CapRow[],
    task: string,
    at: Partial<CapRow> & Pick<CapRow, 'scope'>,
  ): CapRow[] {
    if (rows.length || task !== 'extraction') return rows;
    const d = DEFAULT_BUDGETS.extraction;
    const row = capRow({
      ...at,
      task: 'extraction',
      tokensPerMinute: d.tokensPerMinute,
      tokensPerDay: d.tokensPerDay,
      tokensPerMonth: d.tokensPerMonth,
    });
    this.caps.push(row); // a pause needs a row to live on, as the door inserts one
    return [row];
  }

  private win(bucket: string): Windows {
    let w = this.windows.get(bucket);
    if (!w) {
      w = { minute: new Map(), day: new Map(), month: new Map() };
      this.windows.set(bucket, w);
    }
    return w;
  }

  private costIn(bucket: string, month: string, currency: string): bigint {
    return this.costs.get(bucket)?.get(month)?.get(currency) ?? 0n;
  }

  private addCost(bucket: string, month: string, currency: string, micro: bigint): void {
    let byMonth = this.costs.get(bucket);
    if (!byMonth) {
      byMonth = new Map();
      this.costs.set(bucket, byMonth);
    }
    let byCur = byMonth.get(month);
    if (!byCur) {
      byCur = new Map();
      byMonth.set(month, byCur);
    }
    byCur.set(currency, (byCur.get(currency) ?? 0n) + micro);
  }

  private addTokens(bucket: string, now: Date, tokens: number): void {
    const w = this.win(bucket);
    const add = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + tokens);
    add(w.minute, minuteStart(now));
    add(w.day, dayStart(now));
    add(w.month, monthKey(now));
  }

  /** Used tokens and cost of a cap row's bucket this month. */
  usage(bucket: string, now: Date) {
    const w = this.win(bucket);
    return {
      minute: w.minute.get(minuteStart(now)) ?? 0,
      day: w.day.get(dayStart(now)) ?? 0,
      month: w.month.get(monthKey(now)) ?? 0,
    };
  }

  private pause(row: CapRow, reason: CapPauseReason, until: Date, now: Date): void {
    row.pausedUntil = until;
    row.pausedReason = reason;
    if (reason === 'cap_money' || reason === 'cap_tokens') row.warned100Month = monthKey(now);
  }

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const { now } = req;
    const buckets = bucketsFor(req);
    const month = monthKey(now);
    const estMicro = req.estimateCost ? toMicro(req.estimateCost.amount) : 0n;

    for (const bucket of buckets) {
      for (const row of this.rowsFor(bucket)) {
        if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime() && row.pausedReason) {
          return {
            ok: false,
            kind: 'cap',
            reason: row.pausedReason,
            until: row.pausedUntil,
            bucket,
          };
        }
      }
    }
    for (const bucket of buckets) {
      const used = this.usage(bucket, now);
      for (const row of this.rowsFor(bucket)) {
        if (
          row.tokensPerMinute !== null &&
          used.minute + req.estimateTokens > row.tokensPerMinute
        ) {
          return {
            ok: false,
            kind: 'wait',
            reason: 'tpm',
            until: new Date(minuteStart(now) + 60_000),
          };
        }
        if (row.tokensPerDay !== null && used.day + req.estimateTokens > row.tokensPerDay) {
          this.pause(row, 'tokens_day', nextDay(now), now);
          return { ok: false, kind: 'cap', reason: 'tokens_day', until: nextDay(now), bucket };
        }
        if (row.tokensPerMonth !== null && used.month + req.estimateTokens > row.tokensPerMonth) {
          this.pause(row, 'cap_tokens', nextMonth(now), now);
          return { ok: false, kind: 'cap', reason: 'cap_tokens', until: nextMonth(now), bucket };
        }
        if (row.monthlyCapAmount !== null && row.capCurrency !== null) {
          const spent = this.costIn(bucket, month, row.capCurrency);
          const add = req.estimateCost?.currency === row.capCurrency ? estMicro : 0n;
          if (spent + add > toMicro(row.monthlyCapAmount)) {
            this.pause(row, 'cap_money', nextMonth(now), now);
            return { ok: false, kind: 'cap', reason: 'cap_money', until: nextMonth(now), bucket };
          }
        }
      }
    }

    const leaseKey = `payer:${req.payer.scope}:${req.payer.accountId ?? req.payer.userId ?? 'instance'}`;
    const slots = this.leases.get(leaseKey) ?? Array.from({ length: this.payerSlots }, () => null);
    this.leases.set(leaseKey, slots);
    const slot = slots.indexOf(null);
    if (slot === -1) {
      return {
        ok: false,
        kind: 'wait',
        reason: 'concurrency',
        until: new Date(now.getTime() + 15_000),
      };
    }

    const reservation: Reservation = {
      id: randomUUID(),
      buckets,
      estimateTokens: req.estimateTokens,
      estimateCost: req.estimateCost,
      leaseKey,
      slot,
    };
    slots[slot] = reservation.id;
    for (const bucket of buckets) {
      this.addTokens(bucket, now, req.estimateTokens);
      if (req.estimateCost) this.addCost(bucket, month, req.estimateCost.currency, estMicro);
    }
    this.reservations.set(reservation.id, reservation);
    return { ok: true, reservation };
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
    const { now } = actual;
    if (!this.reservations.delete(reservation.id)) return [];
    const slots = this.leases.get(reservation.leaseKey);
    if (slots && slots[reservation.slot] === reservation.id) slots[reservation.slot] = null;

    const month = monthKey(now);
    const crossed: Crossed[] = [];
    for (const bucket of reservation.buckets) {
      const before = this.usage(bucket, now).month - reservation.estimateTokens;
      this.addTokens(bucket, now, actual.tokens - reservation.estimateTokens);
      if (reservation.estimateCost) {
        this.addCost(
          bucket,
          month,
          reservation.estimateCost.currency,
          -toMicro(reservation.estimateCost.amount),
        );
      }
      const costBefore = new Map<string, bigint>();
      if (actual.cost)
        costBefore.set(actual.cost.currency, this.costIn(bucket, month, actual.cost.currency));
      if (actual.cost)
        this.addCost(bucket, month, actual.cost.currency, toMicro(actual.cost.amount));
      const after = this.usage(bucket, now).month;

      for (const row of this.rowsFor(bucket)) {
        let pctBefore = 0;
        let pctAfter = 0;
        let unit: 'tokens' | 'money' | null = null;
        if (row.tokensPerMonth !== null) {
          pctBefore = (before / row.tokensPerMonth) * 100;
          pctAfter = (after / row.tokensPerMonth) * 100;
          unit = 'tokens';
        }
        if (
          row.monthlyCapAmount !== null &&
          row.capCurrency !== null &&
          actual.cost?.currency === row.capCurrency
        ) {
          const cap = Number(fromMicro(toMicro(row.monthlyCapAmount)));
          const b = Number(fromMicro(costBefore.get(row.capCurrency) ?? 0n));
          const a = Number(fromMicro(this.costIn(bucket, month, row.capCurrency)));
          if (cap > 0 && (a / cap) * 100 > pctAfter) {
            pctBefore = (b / cap) * 100;
            pctAfter = (a / cap) * 100;
            unit = 'money';
          }
        }
        if (unit === null) continue;
        if (pctBefore < 80 && pctAfter >= 80 && row.warned80Month !== month) {
          row.warned80Month = month;
          crossed.push({ budgetId: row.id, bucket, level: 80, month });
        }
        if (pctBefore < 100 && pctAfter >= 100 && row.warned100Month !== month) {
          this.pause(row, unit === 'money' ? 'cap_money' : 'cap_tokens', nextMonth(now), now);
          crossed.push({ budgetId: row.id, bucket, level: 100, month });
        }
      }
    }
    return crossed;
  }
}

// --- Pacer ---------------------------------------------------------------------------------

export class InMemoryPacer implements Pacer {
  readonly breakers = new Map<string, BreakerState>();
  readonly limits = new Map<string, ProviderLimits>();
  readonly slots = new Map<string, (string | null)[]>();
  readonly output = new Map<string, OutputWindow>();

  async admit(
    p: ProviderRef,
    estimateTokens: number,
    jobId: string,
    now: Date,
    expectedOutput = 0,
  ): Promise<Admission> {
    const trip = trippedAt(this.breakers.get(p.id), now);
    if (trip) return { ok: false, kind: 'hold', until: trip.until, reason: trip.reason };
    let pace = waitFor(this.limits.get(p.id) ?? null, estimateTokens, now);
    if (pace.kind === 'go')
      pace = waitForOutput(this.output.get(p.id) ?? null, expectedOutput, now);
    if (pace.kind === 'sleep') return { ok: false, kind: 'sleep', ms: pace.ms };
    if (pace.kind === 'hold')
      return { ok: false, kind: 'hold', until: pace.until, reason: 'limits' };
    const slots = this.slots.get(p.id) ?? Array.from({ length: concurrencyOf(p.kind) }, () => null);
    this.slots.set(p.id, slots);
    const slot = slots.indexOf(null);
    if (slot === -1) {
      return {
        ok: false,
        kind: 'hold',
        until: new Date(now.getTime() + 15_000),
        reason: 'concurrency',
      };
    }
    slots[slot] = jobId;
    return { ok: true, lease: { providerId: p.id, slot, jobId } };
  }

  async release(lease: KeyLease): Promise<void> {
    const slots = this.slots.get(lease.providerId);
    if (slots && slots[lease.slot] === lease.jobId) slots[lease.slot] = null;
  }

  async observe(p: ProviderRef, seen: Observed, now: Date): Promise<ProviderLimits | null> {
    this.breakers.set(p.id, nextBreaker(this.breakers.get(p.id), seen.signal, now));
    const out = nextOutputWindow(
      this.output.get(p.id) ?? null,
      {
        outputTokens: seen.outputTokens ?? null,
        outputLimit: seen.outputLimit ?? null,
        retryAfterMs: seen.retryAfterMs ?? null,
      },
      now,
    );
    if (out) this.output.set(p.id, out);
    const limits = readLimits(p.kind, seen.headers, now);
    if (limits) this.limits.set(p.id, limits);
    return limits;
  }

  async clearAuth(providerId: string): Promise<void> {
    this.breakers.set(providerId, clearAuth(this.breakers.get(providerId)));
  }
}
