/// <reference lib="webworker" />

/**
 * The service worker: the app shell and its hashed assets, cached for offline use.
 *
 * A thin translation of `cachePolicy.ts` into fetch handlers. Every decision - which
 * strategy, what is worth storing, whether to take over - lives in that module and is
 * unit tested there; this file only does the caching.
 *
 * Deliberately a classic script, not a module worker: Firefox does not run module
 * service workers, and this is built to `dist/sw.js` with a stable name so the
 * registration URL never has to be computed at runtime.
 */

import {
  APP_SHELL_CACHE,
  ASSET_CACHE,
  CACHES,
  shouldCache,
  strategyFor,
} from '@/pwa/cachePolicy';

declare const self: ServiceWorkerGlobalScope;

const SHELL_FALLBACK = 'index.html';

self.addEventListener('install', () => {
  // No precache list: the shell is cached by the first navigation that goes through
  // the network, and every asset is cached as it is fetched. Injecting a list of
  // hashed names would need a build plugin, and would cache files nothing asked for.
  // Nothing happens until the user agrees to the update (see the message handler).
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // A version bump changes the cache names, so this is what clears the previous
      // release: without it, old hashed assets accumulate forever.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('cjit-') && !CACHES.includes(name as never))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'skip-waiting') {
    void self.skipWaiting();
  }
});

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (shouldCache(response)) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (shouldCache(response)) {
      const cache = await caches.open(APP_SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Offline: the cached shell is what makes the app open at all. `index.html` is
    // the fallback for any path, since this is a single-page app.
    const cached = await caches.match(request);
    if (cached) return cached;

    const shell = await caches.match(SHELL_FALLBACK);
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const strategy = strategyFor({
    url: request.url,
    method: request.method,
    ...(request.mode ? { mode: request.mode } : {}),
    origin: self.location.origin,
  });

  // `skip` means the browser's own networking, untouched.
  if (strategy === 'skip') return;

  event.respondWith(
    strategy === 'network-first' ? networkFirst(request) : cacheFirst(request),
  );
});
