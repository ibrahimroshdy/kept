import type { Scope } from '../db/scope.js';
import { embeddingsRoutes } from '../embeddings/routes.js';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { registerAiApi } from './api.js';
import type { AiRuntime } from './call.js';
import { aiRuntime, mockAnswersFor, type RuntimeOptions } from './runtime.js';

/** What the AI routes and jobs get from the app (http/routes.ts InventoryDeps.ai, and the
 * worker's SystemJobDeps.ai): the provider layer on the database (ai/runtime.ts). */
export type AiDeps = {
  /** KEPT_AI_MOCK: every model call answers from ai/mock.ts. Never true in production (the boot
   * refuses it, config/env.ts). */
  mock: boolean;
  /** The provider layer in a person's scope (a request's, or a tenant job's); null: background
   * work, on kept_system. Each call builds a fresh one (the SSRF setting is read each time). */
  runtime: (scope: Scope | null) => Promise<AiRuntime>;
};

/** AiDeps for a process: the runtime on its pools and keyring; the mock when `mock` is set. */
export function createAiDeps(
  opts: Omit<RuntimeOptions, 'mock'> & { mock: boolean; mockAnswersFile?: string },
): AiDeps {
  const answers = mockAnswersFor(opts.mock, opts.mockAnswersFile);
  const { mock: _mock, mockAnswersFile: _file, ...rest } = opts;
  return {
    mock: opts.mock,
    runtime: (scope) => aiRuntime({ ...rest, mock: answers }, scope),
  };
}

/** AI settings: providers and keys, "Test connection", caps, prices, usage and the call ledger
 * (T9, ai/api.ts). Registered by http/routes.ts; add routes here, never there. */
export async function aiRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  await registerAiApi(app, deps);
  // Step 6 (T14, D207): the embeddings source switch for instance admins.
  await embeddingsRoutes(app, deps);
}
