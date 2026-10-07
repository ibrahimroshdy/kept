// SPIKE (step 3, T0): runs only the AI SDK spike, without the server's database globalSetup.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ai-sdk-spike',
    environment: 'node',
    include: ['src/ai-sdk.spike.test.ts'],
    env: { TZ: 'Africa/Cairo' },
  },
});
