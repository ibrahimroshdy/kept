import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The performance checks (plan T32; test/perf), full mode only: scripts/ci-local.sh `perf`. The
// same setup as the normal run (a database cloned from the run's template), one file at a time.
// Built by hand rather than with mergeConfig, which would concatenate the base's exclude (the one
// that leaves test/perf out of `pnpm test`) into this one. A second global setup times the
// runner's reference workload once, before any file (test/perf/global-setup.ts, issue #159).
export default defineConfig({
  test: {
    ...base.test,
    name: '@kept/server perf',
    include: ['test/perf/**/*.perf.test.ts'],
    exclude: configDefaults.exclude,
    globalSetup: ['./test/global-setup.ts', './test/perf/global-setup.ts'],
    fileParallelism: false,
  },
});
