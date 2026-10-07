/**
 * The DB-backed Pacer (ports.ts; step-3 T6), shared by every process through the doors:
 * - `admit` is `kept.ai_key_admit`: the breaker (`ai_breakers`), the provider's own token window
 *   (`ai_provider_limits`; sleep up to 10 s, else hold until the reset) and the key's slots
 *   (`ai_leases` `key:<provider>`: 1 for Groq, else 2), in one transaction under the key's lock;
 * - `observe` locks the key's breaker row (`kept.ai_breaker_state`), runs breaker.ts's state
 *   machine on it, and stores the next state and the provider's window (`kept.ai_observe`), in
 *   one transaction, so two processes never lose each other's trips;
 * - `clearAuth` is `kept.ai_clear_trip`, for the provider's manager (a replaced key, T9).
 * Behaviour matches memory.ts's InMemoryPacer (db-pacer.test.ts runs its scenarios); the clock
 * that decides trips and windows is the database's for `admit`, the caller's for `observe`.
 */
import type { BreakerReason, BreakerState } from './breaker.js';
import { nextBreaker } from './breaker.js';
import { type DoorRunner, fromDbTime, toDbTime } from './db-run.js';
import { outputFreeInMs, type ProviderLimits, readLimits } from './pacing.js';
import type { Admission, KeyLease, Observed, Pacer, ProviderRef } from './ports.js';

type AdmitRow = {
  ok: boolean;
  kind: 'ok' | 'sleep' | 'hold';
  until: Date | number | null;
  reason: string | null;
  slot: number | null;
  wait_ms: number | null;
};
type BreakerRow = {
  reason: BreakerReason | null;
  until: Date | number | null;
  trips: number;
  recent_errors: Date[];
};

export class DbPacer implements Pacer {
  constructor(private readonly run: DoorRunner) {}

  /** `_now` is the port's; the door decides on the database's clock. */
  async admit(
    p: ProviderRef,
    estimateTokens: number,
    jobId: string,
    _now?: Date,
    expectedOutput = 0,
  ): Promise<Admission> {
    const r = await this.run(async (client) => {
      const { rows } = await client.query<AdmitRow>(
        'SELECT * FROM kept.ai_key_admit($1, $2, $3, $4)',
        [
          p.id,
          Math.max(0, Math.ceil(estimateTokens)),
          jobId,
          Math.max(0, Math.ceil(expectedOutput)),
        ],
      );
      return rows[0] as AdmitRow;
    });
    if (r.ok) return { ok: true, lease: { providerId: p.id, slot: r.slot as number, jobId } };
    if (r.kind === 'sleep') return { ok: false, kind: 'sleep', ms: r.wait_ms ?? 0 };
    return {
      ok: false,
      kind: 'hold',
      until: fromDbTime(r.until) as Date,
      reason: r.reason as 'limits' | 'concurrency' | BreakerReason,
    };
  }

  async release(lease: KeyLease): Promise<void> {
    await this.run((client) =>
      client.query('SELECT kept.ai_key_release($1, $2, $3)', [
        lease.providerId,
        lease.slot,
        lease.jobId,
      ]),
    );
  }

  observe(p: ProviderRef, seen: Observed, now: Date): Promise<ProviderLimits | null> {
    return this.run(async (client) => {
      const { rows } = await client.query<BreakerRow>('SELECT * FROM kept.ai_breaker_state($1)', [
        p.id,
      ]);
      const row = rows[0];
      const state: BreakerState = {
        reason: row?.reason ?? null,
        until: fromDbTime(row?.until ?? null),
        trips: row?.trips ?? 0,
        recentErrors: (row?.recent_errors ?? []).map((d) => d.getTime()),
      };
      const next = nextBreaker(state, seen.signal, now);
      const limits = readLimits(p.kind, seen.headers, now);
      // The output-token window (0045): what a 429 named, else this call's output.
      const output = seen.outputLimit
        ? {
            learned: {
              limit: seen.outputLimit.limit,
              used: seen.outputLimit.used,
              freeInMs: outputFreeInMs(seen.outputLimit, seen.retryAfterMs ?? null),
            },
          }
        : seen.outputTokens
          ? { tokens: seen.outputTokens }
          : null;
      await client.query('SELECT kept.ai_observe($1, $2, $3)', [
        p.id,
        JSON.stringify({
          reason: next.reason,
          until: toDbTime(next.until),
          trips: next.trips,
          recentErrors: next.recentErrors.map((t) => new Date(t).toISOString()),
        }),
        limits || output
          ? JSON.stringify({
              ...(limits
                ? {
                    limitTokens: limits.limitTokens,
                    remainingTokens: limits.remainingTokens,
                    resetAt: limits.resetAt?.toISOString() ?? null,
                  }
                : {}),
              ...(output ? { output } : {}),
            })
          : null,
      ]);
      return limits;
    });
  }

  async clearAuth(providerId: string): Promise<void> {
    await this.run((client) => client.query('SELECT kept.ai_clear_trip($1)', [providerId]));
  }
}
