/**
 * What the service worker does with each request.
 *
 * Kept separate from the worker itself, and free of `self`/`caches`, so the policy
 * is unit tested directly instead of being hoped at in a browser. The worker file is
 * a thin translation of these decisions into `fetch` handlers.
 *
 * The two rules that matter:
 *
 * - **Hashed assets are cache-first.** Vite gives every built asset a content hash in
 *   its name, so a cached copy can never be stale: a change produces a new name.
 * - **The app shell is network-first.** `index.html` decides which hashed assets to
 *   load, so serving it from cache is how a deployed update never reaches the user.
 *   Online, it always comes from the network; offline, the cached copy is the
 *   fallback that makes the app open at all.
 */

export const CACHE_PREFIX = 'cjit';
export const CACHE_VERSION = 'v1';

/** The app shell: the HTML entry and anything that has to match it. */
export const APP_SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
/** Content-addressed build output, plus the manifest and icons. */
export const ASSET_CACHE = `${CACHE_PREFIX}-assets-${CACHE_VERSION}`;
export const CACHES = [APP_SHELL_CACHE, ASSET_CACHE] as const;

export type Strategy = 'network-first' | 'cache-first' | 'skip';

export interface RequestFacts {
  /** Absolute URL of the request. */
  readonly url: string;
  readonly method: string;
  /** `navigate` for a page load; anything else for a subresource. */
  readonly mode?: string;
  /** The origin the app is served from, used to keep the cache same-origin. */
  readonly origin: string;
}

/** A file name with a content hash, as Vite emits: `index-BFoghw9R.js`. */
export function isHashedAsset(pathname: string): boolean {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /-[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/.test(name);
}

/**
 * The compiler toolchain, which is 58 MB and already cached in IndexedDB.
 *
 * Caching it a second time in the Cache API would double the storage for no gain,
 * and it is served from our own origin so it would otherwise look cacheable.
 */
export function isToolchainPath(pathname: string): boolean {
  return /(^|\/)toolchain\//.test(pathname);
}

/** A page load: the shell, or any path that resolves to it. */
export function isAppShell(pathname: string, mode?: string): boolean {
  if (mode === 'navigate') return true;
  return pathname.endsWith('/') || pathname.endsWith('/index.html');
}

export function strategyFor(request: RequestFacts): Strategy {
  if (request.method.toUpperCase() !== 'GET') return 'skip';

  let url: URL;
  try {
    url = new URL(request.url, request.origin);
  } catch {
    return 'skip';
  }

  // Same-origin only: a service worker has no business caching a CDN's answers.
  if (url.origin !== request.origin) return 'skip';

  // The toolchain is IndexedDB's job; see isToolchainPath.
  if (isToolchainPath(url.pathname)) return 'skip';

  // A dev server's module graph must never be cached, or edits stop showing up.
  // The base path sits in front of it (`/cjit/@vite/client`), so this looks for the
  // marker anywhere in the path rather than at the start.
  if (url.pathname.includes('/@') || url.pathname.includes('/node_modules/')) return 'skip';
  if (url.searchParams.has('import') || url.searchParams.has('t')) return 'skip';

  if (isAppShell(url.pathname, request.mode)) return 'network-first';

  // Everything else that is ours: hashed assets cannot go stale, and the manifest
  // and icons change rarely enough that a version bump is the right control.
  return 'cache-first';
}

/** Only a complete, successful, same-origin response is worth storing. */
export function shouldCache(response: {
  readonly ok: boolean;
  readonly status: number;
  readonly type?: string;
}): boolean {
  if (!response.ok || response.status !== 200) return false;
  // `opaque` responses have no readable body and a status of 0; `opaqueredirect` and
  // `error` are not worth storing either.
  if (response.type !== undefined && !['basic', 'default', 'cors'].includes(response.type)) {
    return false;
  }
  return true;
}

/**
 * Whether a waiting worker should take over immediately.
 *
 * Only when the user asked for it: reloading a page out from under someone who is
 * mid-edit is worse than running one version behind for another minute.
 */
export function shouldSkipWaiting(userAsked: boolean): boolean {
  return userAsked;
}

/** The dev server must not be wrapped in a service worker at all. */
export function shouldRegister(environment: {
  readonly production: boolean;
  readonly serviceWorkerAvailable: boolean;
}): boolean {
  return environment.production && environment.serviceWorkerAvailable;
}
