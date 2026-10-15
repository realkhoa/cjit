import { describe, expect, it } from 'vitest';
import {
  APP_SHELL_CACHE,
  ASSET_CACHE,
  CACHES,
  isAppShell,
  isHashedAsset,
  isToolchainPath,
  shouldCache,
  shouldRegister,
  shouldSkipWaiting,
  strategyFor,
} from '@/pwa/cachePolicy';

/**
 * The service worker's caching decisions, tested as a module.
 *
 * A service worker that caches the wrong thing is one of the few bugs that survives
 * a reload: a cached `index.html` means a deployed fix never arrives, and a cached
 * toolchain means 58 MB stored twice. Both are decided here, so both are testable
 * without a browser.
 */

const ORIGIN = 'https://realkhoa.github.io';

function facts(path: string, overrides: Partial<Parameters<typeof strategyFor>[0]> = {}) {
  return {
    url: `${ORIGIN}/cjit/${path}`,
    method: 'GET',
    origin: ORIGIN,
    ...overrides,
  };
}

describe('which strategy each request gets', () => {
  it('takes the app shell from the network first, so a deploy is never stale', () => {
    expect(strategyFor(facts('', { mode: 'navigate' }))).toBe('network-first');
    expect(strategyFor(facts('index.html'))).toBe('network-first');
    expect(strategyFor(facts('some/deep/route/', { mode: 'navigate' }))).toBe('network-first');
  });

  it('serves hashed build output from the cache first', () => {
    expect(strategyFor(facts('assets/index-BFoghw9R.js'))).toBe('cache-first');
    expect(strategyFor(facts('assets/index-C7ZlgSpi.css'))).toBe('cache-first');
    expect(strategyFor(facts('manifest.webmanifest'))).toBe('cache-first');
    expect(strategyFor(facts('icons/icon-192.png'))).toBe('cache-first');
  });

  it('leaves the toolchain alone: IndexedDB already has it', () => {
    expect(isToolchainPath('/cjit/toolchain/clang')).toBe(true);
    expect(strategyFor(facts('toolchain/clang'))).toBe('skip');
    expect(strategyFor(facts('toolchain/shared.js'))).toBe('skip');
  });

  it('never touches anything it should not', () => {
    expect(strategyFor(facts('assets/index-abc12345.js', { method: 'POST' }))).toBe('skip');
    expect(strategyFor({ url: 'https://cdn.example.com/lib.js', method: 'GET', origin: ORIGIN })).toBe(
      'skip',
    );
    // The dev server's module graph, or edits stop appearing.
    expect(strategyFor(facts('@vite/client'))).toBe('skip');
    expect(strategyFor(facts('src/main.tsx?t=123'))).toBe('skip');
  });
});

describe('recognising what is what', () => {
  it('spots a content hash in a file name', () => {
    expect(isHashedAsset('/cjit/assets/index-BFoghw9R.js')).toBe(true);
    expect(isHashedAsset('/cjit/assets/editor.worker-DERb3WoQ.js')).toBe(true);
    expect(isHashedAsset('/cjit/index.html')).toBe(false);
    expect(isHashedAsset('/cjit/assets/manual.js')).toBe(false);
  });

  it('recognises a page load by mode or by shape', () => {
    expect(isAppShell('/cjit/', undefined)).toBe(true);
    expect(isAppShell('/cjit/index.html', undefined)).toBe(true);
    expect(isAppShell('/cjit/assets/index-abc.js', 'no-cors')).toBe(false);
    expect(isAppShell('/cjit/anything', 'navigate')).toBe(true);
  });
});

describe('what is worth storing', () => {
  it('stores only complete same-origin successes', () => {
    expect(shouldCache({ ok: true, status: 200, type: 'basic' })).toBe(true);
    expect(shouldCache({ ok: true, status: 200, type: 'cors' })).toBe(true);
    expect(shouldCache({ ok: false, status: 404, type: 'basic' })).toBe(false);
    expect(shouldCache({ ok: true, status: 206, type: 'basic' })).toBe(false);
    expect(shouldCache({ ok: true, status: 200, type: 'opaque' })).toBe(false);
    expect(shouldCache({ ok: true, status: 200, type: 'opaqueredirect' })).toBe(false);
  });
});

describe('when the worker runs at all', () => {
  it('stays out of the dev server', () => {
    expect(shouldRegister({ production: false, serviceWorkerAvailable: true })).toBe(false);
    expect(shouldRegister({ production: true, serviceWorkerAvailable: false })).toBe(false);
    expect(shouldRegister({ production: true, serviceWorkerAvailable: true })).toBe(true);
  });

  it('takes over only when the user asked for it', () => {
    // Reloading under someone mid-edit is worse than running one version behind.
    expect(shouldSkipWaiting(false)).toBe(false);
    expect(shouldSkipWaiting(true)).toBe(true);
  });

  it('names its caches after the version, so a bump is a clean slate', () => {
    expect(APP_SHELL_CACHE).toContain('v1');
    expect(ASSET_CACHE).toContain('v1');
    expect(CACHES).toHaveLength(2);
    expect(new Set(CACHES).size).toBe(2);
  });
});
