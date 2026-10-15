import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The service worker's own build.
 *
 * It has to be a classic script with a stable name (`/sw.js`), which the app build
 * cannot produce: Vite hashes entry names for cache-busting, and a service worker
 * URL that changes every deploy would leave the old worker in charge. So the worker
 * is built separately, into the same `dist`, without emptying it.
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // The app build already wrote this directory.
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./src/pwa/serviceWorker.ts', import.meta.url)),
      formats: ['iife'],
      name: 'CjitServiceWorker',
      fileName: () => 'sw.js',
    },
  },
});
