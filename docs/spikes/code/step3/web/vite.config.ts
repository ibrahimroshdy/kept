// SPIKE (step 3, T0). Throwaway: apps/web/vite.config.ts with the Serwist plugin (V17), the
// scanner and hints spike pages as extra inputs, and the lucide per-icon chunks moved to
// assets/icons/ so the precache can skip them. apply.sh copies this over apps/web/vite.config.ts.
import { fileURLToPath } from 'node:url';
import { getConfig } from '@lingui/conf';
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import { serwist } from '@serwist/vite';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const configPath = fileURLToPath(new URL('./lingui.config.ts', import.meta.url));
const linguiConfig = getConfig({ configPath });

/** lucide-react/dynamic emits one chunk per icon (~1,900). They are not precached. */
const LUCIDE_ICON = '/lucide-react/dist/esm/icons/';

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single' }),
    react(),
    lingui({ configPath }),
    babel({ presets: [linguiTransformerBabelPreset({ linguiConfig }, { configPath })] }),
    tailwindcss(),
    // Option names read from @serwist/vite 9.5.12 dist/index.d.mts and @serwist/build's
    // index.d.mts. globPatterns must be given: the default is only '**/*.{js,css,html}'.
    serwist({
      swSrc: 'src/sw.ts',
      swDest: 'sw.js',
      globDirectory: 'dist',
      injectionPoint: 'self.__SW_MANIFEST',
      rollupFormat: 'iife',
      globPatterns: ['**/*.{js,css,html,woff2,wasm,svg,png,webmanifest}'],
      // Font subsets Kept never renders (English and Arabic only) stay out of the precache.
      globIgnores: [
        'assets/icons/**',
        'sw.js',
        'assets/ibm-plex-*-{cyrillic,cyrillic-ext,greek,vietnamese}-*.woff2',
      ],
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        scanner: fileURLToPath(new URL('./spike-scanner.html', import.meta.url)),
        hints: fileURLToPath(new URL('./spike-hints.html', import.meta.url)),
      },
      output: {
        chunkFileNames: (chunk) =>
          chunk.facadeModuleId?.includes(LUCIDE_ICON)
            ? 'assets/icons/[name]-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  define: { 'process.env.KEPT_VERSION': 'undefined' },
});
