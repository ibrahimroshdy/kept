import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@kept/shared',
    environment: 'node',
    env: { TZ: 'Africa/Cairo' },
  },
});
