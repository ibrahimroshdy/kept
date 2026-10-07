import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@kept/mcp',
    environment: 'node',
    env: { TZ: 'Africa/Cairo' },
  },
});
