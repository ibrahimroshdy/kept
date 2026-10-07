import { fileURLToPath } from 'node:url';
import { getConfig } from '@lingui/conf';
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Explicit, because the root `vitest` run starts from the repo root, where Lingui would look.
// The macro plugin gets the resolved config too: the preset doesn't pass it on.
const configPath = fileURLToPath(new URL('./lingui.config.ts', import.meta.url));
const linguiConfig = getConfig({ configPath });

// No router or Tailwind plugins here: component tests need JSX, the Lingui macro and PO imports.
export default defineConfig({
  plugins: [
    react(),
    lingui({ configPath }),
    babel({ presets: [linguiTransformerBabelPreset({ linguiConfig }, { configPath })] }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: '@kept/web',
    environment: 'jsdom',
    env: { TZ: 'Africa/Cairo' },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Screen tests render the whole app in jsdom and drive it with user-event: a few seconds each
    // alone, and past vitest's 5 s default when the full suite shares the CPU with other runs
    // (observed at load average 90+). A real hang still fails, at 20 s.
    testTimeout: 20_000,
  },
});
