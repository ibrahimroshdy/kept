// SPIKE (step 5, T0, V38). Throwaway. Same Vite and React plugin as apps/web (vite 8.3.1,
// @vitejs/plugin-react 6.1.1) and the same build defaults, so the lazy chunk's gzip size is
// comparable. The charts are a dynamic import, so they land in their own chunk.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { assetsInlineLimit: 0, manifest: true },
});
