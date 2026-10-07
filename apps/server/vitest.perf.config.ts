import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The performance checks (plan T32; test/perf), full mode only: scripts/ci-local.sh `perf`. The
// same setup as the normal run (a database cloned from the run's template), one file at a time.
// Built by hand rather than with mergeConfig, which would concatenate the base's exclude (the one
// that leaves test/perf out of `pnpm test`) into this one.
export default defineConfig({
  test: {
    ...base.test,
    name: '@kept/server perf',
    include: ['test/perf/**/*.perf.test.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false,
  },
});
