import { defineConfig } from 'vitest/config';

// vitest 5 removed `vitest.workspace.ts` / `defineWorkspace` (used by the plan's vitest 3-era
// API); the replacement is `test.projects` on the root config. See commit body.
// KEPT_TEST_WORKERS caps the worker processes across all projects (default: vitest's own, from
// the CPU count). Lower it when the machine is busy with other test runs against the same
// Postgres, where oversubscribed workers turn into timeouts rather than failures of their own.
const workers = Number(process.env.KEPT_TEST_WORKERS);

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server', 'apps/web', 'scripts'],
    ...(Number.isInteger(workers) && workers > 0 ? { maxWorkers: workers } : {}),
  },
});
