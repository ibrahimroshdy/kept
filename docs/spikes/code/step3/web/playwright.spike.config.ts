// SPIKE (step 3, T0). Runs the spike checks against the built dist/:
//   4173  vite preview (V17: "installs in Chromium through vite preview")
//   4198  csp-server.mjs --wasm  (Kept's CSP plus 'wasm-unsafe-eval')
//   4199  csp-server.mjs         (Kept's CSP as it is today)
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './spike-e2e',
  outputDir: '../../.tmp/spike-e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], trace: 'off' },
  webServer: [
    {
      command: 'pnpm exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173/',
      reuseExistingServer: false,
    },
    {
      command: 'node csp-server.mjs 4198 --wasm',
      url: 'http://127.0.0.1:4198/',
      reuseExistingServer: false,
    },
    {
      command: 'node csp-server.mjs 4199',
      url: 'http://127.0.0.1:4199/',
      reuseExistingServer: false,
    },
  ],
});
