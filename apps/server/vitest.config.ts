import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@kept/server',
    environment: 'node',
    env: { TZ: 'Africa/Cairo' },
    // test/perf runs only in ci-local's `perf` step (vitest.perf.config.ts), never in `pnpm test`.
    exclude: [...configDefaults.exclude, 'test/perf/**'],
    globalSetup: './test/global-setup.ts',
    setupFiles: ['./test/setup.ts'],
    // Hooks clone a database from the run's template and open pools (test/db.ts), and some tests
    // run the CLI in a subprocess (a full migration). Alone each is well under vitest's defaults
    // (10 s hooks, 5 s tests); with other runs on the same machine and Postgres they passed them.
    // A real hang still fails.
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
});
