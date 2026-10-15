import { defineConfig } from 'vitest/config';

// The docs site's own code: the Try the map sample home (D241). No browser and no build.
export default defineConfig({
  test: {
    name: '@kept/docs',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
