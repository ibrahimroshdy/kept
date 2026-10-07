import { accountEnsurer } from '../accounts/ensure-account.js';
import { createAuth } from '../auth/auth.js';
import type { Env } from '../config/env.js';
import type { Pools } from '../db/pools.js';
import { type AppOptions, buildApp, type KeptApp } from '../http/app.js';
import { authMail, type Mailer } from '../mail/mailer.js';
import type { FileStorage } from '../storage/blob-store.js';
import { type BenchOptions, seedBench } from './bench.js';
import { type SeedReport, seedHouseholds } from './households.js';

// The seed scenarios (D152, D185): development data made through the service layer, reused by
// the tests (and the e2e tests and screenshots).
// - `households`: the board's cast and what their households hold (tasks 26 and 23).
// - `bench`: the RLS benchmark's load fixture, 10,000 things (task 23, for task 24).
// Later steps add their own (vehicles, loans, warranties, expiring things, all five currencies:
// D152).

export const SCENARIOS = ['households', 'bench'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

/** Refuses anywhere but development: the seed makes accounts with a known password. */
export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new SeedRefused('the seed makes accounts with a known password: never in production');
  }
}

/** Mail the seed would send (sign-up notices, security notices) is dropped: nobody reads it. */
const NO_MAIL: Mailer = { send: async () => {} };

/**
 * An in-process Kept app for the seed: Better Auth mounted with its own rate limits off (the seed
 * makes a dozen accounts in a second), sign-up open, ensureAccount wired as in main.ts, no job
 * queue (the owner's new-member notices are not sent) and no mail.
 */
export async function buildSeedApp(
  env: Pick<Env, 'KEPT_PUBLIC_URL' | 'KEPT_AUTH_SECRET'>,
  pools: Pools,
  files: FileStorage | null = null,
  extra: Partial<AppOptions> = {},
): Promise<KeptApp> {
  const accounts = accountEnsurer(pools);
  const auth = createAuth({
    pool: pools.auth,
    env,
    mail: authMail(NO_MAIL),
    rateLimitEnabled: false,
    onUserCreated: accounts.onUserCreated,
  });
  const app = await buildApp({
    env: { KEPT_PUBLIC_URL: env.KEPT_PUBLIC_URL, KEPT_TRUSTED_PROXIES: [] },
    pools,
    auth,
    mailer: NO_MAIL,
    onScope: accounts.onScope,
    jobs: null,
    files,
    isSignupOpen: async () => true,
    ...extra,
  });
  await app.ready();
  return app;
}

export type RunSeedOptions = {
  /** File storage for photos and receipts; without it they are left out (and noted). */
  files?: FileStorage | null;
  /** The bench scenario's knobs (bench.ts). */
  bench?: BenchOptions;
  /** More options for the seed's app (e.g. the keyring secret values need, task 19). */
  app?: Partial<AppOptions>;
};

export async function runSeed(
  scenario: Scenario,
  env: Pick<Env, 'KEPT_PUBLIC_URL' | 'KEPT_AUTH_SECRET'>,
  pools: Pools,
  opts: RunSeedOptions = {},
): Promise<SeedReport> {
  const files = opts.files ?? null;
  const app = await buildSeedApp(env, pools, files, opts.app);
  const ctx = { app, pools, publicUrl: env.KEPT_PUBLIC_URL, hasFiles: files !== null };
  try {
    switch (scenario) {
      case 'households':
        return await seedHouseholds(ctx);
      case 'bench':
        return await seedBench(ctx, opts.bench ?? {});
    }
  } finally {
    await app.close();
  }
}
