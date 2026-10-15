/**
 * Registering the service worker, and knowing when there is something to install.
 *
 * Only in a production build: a service worker in front of the dev server caches the
 * module graph and hides every edit behind a reload, which is the classic way to lose
 * an afternoon.
 */

import { shouldRegister } from '@/pwa/cachePolicy';

export interface ServiceWorkerUpdate {
  /** The user agreed to swap in the waiting version. */
  readonly apply: () => void;
}

export interface RegisterOptions {
  /** Where the worker is, relative to the app's base URL. */
  readonly url?: string;
  /** Called once a new version is installed and waiting to take over. */
  readonly onUpdateReady?: (update: ServiceWorkerUpdate) => void;
  /** Called with the registration, for anything else that needs it. */
  readonly onRegistered?: (registration: ServiceWorkerRegistration) => void;
}

/**
 * Registers `/sw.js`, if this environment should have one.
 *
 * Returns whether it registered, so callers (and tests) can tell "nothing to do" from
 * "tried and it failed".
 */
export function registerServiceWorker(options: RegisterOptions = {}): boolean {
  const available =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined';

  if (!shouldRegister({ production: import.meta.env.PROD, serviceWorkerAvailable: available })) {
    return false;
  }

  const url = options.url ?? new URL('sw.js', document.baseURI).href;

  void navigator.serviceWorker
    .register(url, { scope: './' })
    .then((registration) => {
      options.onRegistered?.(registration);

      const announce = (worker: ServiceWorker | null): void => {
        if (!worker) return;
        options.onUpdateReady?.({
          apply: () => {
            worker.postMessage({ type: 'skip-waiting' });
            // The new worker takes over, then the page reloads onto it.
            worker.addEventListener('statechange', () => {
              if (worker.state === 'activated') window.location.reload();
            });
          },
        });
      };

      // Already waiting when the page loads, or becomes so while it is open.
      if (registration.waiting && navigator.serviceWorker.controller) {
        announce(registration.waiting);
      }
      registration.addEventListener('updatefound', () => announce(registration.installing));
    })
    .catch(() => {
      // Offline on the first visit, or a browser that refuses: the app works either
      // way, so this stays quiet rather than nagging about caching.
    });

  return true;
}
