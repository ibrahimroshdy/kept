/**
 * The provider layer wired to the database (step-3 T10, on T6's adapters and T8's ports): one
 * `AiRuntime` per scope, built from the `kept.ai_*` doors.
 *
 * - `keys`: DbKeyStore (`kept.ai_provider_for`, the keyring's `open()`), so a key lives only in
 *   the call's frame.
 * - `gate` and `ledger`: one DbBudgetGate (`kept.ai_reserve` / `kept.ai_settle`); `pacer`:
 *   DbPacer (`kept.ai_key_admit`, the breaker, the provider's window); `prices`: the price
 *   version in effect.
 * - Each door runs in its own short transaction in the person's scope on kept_app, or on
 *   kept_system for background work (`scope` null), never around a model call (D166).
 * - `fetch`: the SSRF guard (net/ssrf.ts) for every provider. Named providers' hosts are public,
 *   so the guard only ever refuses a user-typed `openai_compatible` base URL that points inside
 *   the network, unless the instance setting `ssrf_allow_private` is true (Q9).
 * - `KEPT_AI_MOCK=1` (config/env.ts refuses it in production): every model is the mock, answering
 *   from `test/fixtures/eval/mock-answers.json` (T11) when it exists, else per-mode defaults.
 */
import path from 'node:path';
import type { Pools } from '../db/pools.js';
import type { Scope } from '../db/scope.js';
import { guardedFetch } from '../net/ssrf.js';
import { packageRoot } from '../package-root.js';
import type { AiLogger, AiRuntime } from './call.js';
import { DbBudgetGate } from './db-gate.js';
import { DbKeyStore } from './db-keys.js';
import { DbPacer } from './db-pacer.js';
import { dbPriceLookup } from './db-prices.js';
import { doorRunner } from './db-run.js';
import { loadMockAnswers, type MockAnswers } from './mock.js';
import type { Crossed, Pacer } from './ports.js';

/** The instance setting that lets `openai_compatible` base URLs reach private addresses (Q9). */
export const SSRF_ALLOW_PRIVATE_KEY = 'ssrf_allow_private';

/** Where the mock's answers live (T11's fixtures). */
export const MOCK_ANSWERS_PATH = path.join(packageRoot(), 'test/fixtures/eval/mock-answers.json');

/** Whether the instance allows private addresses for AI base URLs; read as kept_system. */
export async function allowPrivateAddresses(pools: Pick<Pools, 'system'>): Promise<boolean> {
  const { rows } = await pools.system.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [SSRF_ALLOW_PRIVATE_KEY],
  );
  return rows[0]?.value === true;
}

export type RuntimeOptions = {
  pools: Pick<Pools, 'app' | 'system'>;
  /** The keyring that opens provider keys (crypto/keyring.ts `SecretKeys.get().keyring`). */
  keyring: () => Map<number, Buffer>;
  log: AiLogger;
  /** KEPT_AI_MOCK: the mock's answers (loadMockAnswers); null for real providers. */
  mock: MockAnswers | null;
  /** For each cap a call takes past 80% or 100%: T9's `ai.cap_notice`. */
  onCrossed?: (crossed: Crossed) => Promise<void>;
  /** A provider refused a call's key (401/403, the breaker's `auth` trip): T9's
   * `ai_instance_key_rejected` alert when it is the instance's key (ai/notices.ts). */
  onKeyRejected?: (providerId: string) => Promise<void>;
  /** Tests: the clock, a fetch, a model factory. */
  overrides?: Partial<AiRuntime>;
};

/** The provider layer for one person's scope (null: background work, "Kept (background)"). */
export async function aiRuntime(opts: RuntimeOptions, scope: Scope | null): Promise<AiRuntime> {
  const run = doorRunner(opts.pools, scope);
  const gate = new DbBudgetGate(run);
  const fetch =
    opts.overrides?.fetch ??
    guardedFetch({
      allowPrivate: await allowPrivateAddresses(opts.pools),
    });
  return {
    keys: new DbKeyStore(run, opts.keyring()),
    ledger: gate,
    gate,
    pacer: keyRejectedHook(new DbPacer(run), opts.onKeyRejected),
    prices: dbPriceLookup(run),
    fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: opts.log,
    mock: opts.mock,
    ...(opts.onCrossed ? { onCrossed: opts.onCrossed } : {}),
    ...opts.overrides,
  };
}

/** The pacer, telling `onKeyRejected` after a call whose key the provider refused. */
function keyRejectedHook(pacer: Pacer, onKeyRejected: RuntimeOptions['onKeyRejected']): Pacer {
  if (!onKeyRejected) return pacer;
  return {
    admit: (p, estimate, jobId, now) => pacer.admit(p, estimate, jobId, now),
    release: (lease) => pacer.release(lease),
    clearAuth: (id) => pacer.clearAuth(id),
    observe: async (p, seen, now) => {
      const limits = await pacer.observe(p, seen, now);
      if (seen.signal.kind === 'auth') await onKeyRejected(p.id);
      return limits;
    },
  };
}

/** The mock's answers when KEPT_AI_MOCK is set, else null (real providers). */
export function mockAnswersFor(
  mock: boolean,
  file: string = MOCK_ANSWERS_PATH,
): MockAnswers | null {
  return mock ? loadMockAnswers(file) : null;
}
