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
    sourcemap: true,
    // The editor chunk is intentionally large; M6 splits it.
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
