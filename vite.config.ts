import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset URL relative, so the same build works at
// https://<user>.github.io/<repo>/ without editing this file.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // No source maps in the deployed build: they are ~15 MB of the artifact and
    // they publish the whole TypeScript source. Nothing the browser needs at
    // runtime lives in them; `npm run dev` still has full maps.
    sourcemap: false,
    // The editor chunk is Monaco and is deliberately large (~3.6 MB raw, ~950 KB
    // gzip). Splitting it further would mean lazy-loading the editor itself, which
    // delays the only thing the app is for. The 58 MB compiler toolchain is NOT
    // part of the bundle: it is fetched on the first Run.
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
