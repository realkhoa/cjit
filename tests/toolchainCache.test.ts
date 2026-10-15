import { describe, expect, it } from 'vitest';
import {
  TOOLCHAIN_CACHE_VERSION,
  createCachedFiles,
} from '@/lang/clang/toolchainCache';
import type { CacheStorage } from '@/lang/clang/toolchainCache';

/**
 * The point of these tests is the promise the user cares about: the 58 MB toolchain
 * is downloaded once and not again on the next reload.
 */

function memoryStorage(): CacheStorage & { readonly map: Map<string, ArrayBuffer> } {
  const map = new Map<string, ArrayBuffer>();
  return {
    map,
    read: async (key) => map.get(key),
    write: async (key, value) => {
      map.set(key, value);
    },
    keys: async () => [...map.keys()],
    remove: async (key) => {
      map.delete(key);
    },
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('toolchain cache', () => {
  it('downloads a file once and serves later reads from storage', async () => {
    const storage = memoryStorage();
    let fetches = 0;
    const files = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => {
        fetches += 1;
        return bytesOf('CLANG-BYTES');
      },
    });

    expect(new TextDecoder().decode(await files.readBytes('clang'))).toBe('CLANG-BYTES');
    expect(fetches).toBe(1);

    // This is the reload case: a fresh worker with the same storage must not fetch.
    const second = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => {
        fetches += 1;
        return bytesOf('SHOULD-NOT-BE-USED');
      },
    });
    expect(new TextDecoder().decode(await second.readBytes('clang'))).toBe('CLANG-BYTES');
    expect(fetches).toBe(1);
  });

  it('caches each file separately', async () => {
    const storage = memoryStorage();
    const fetched: string[] = [];
    const files = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async (name) => {
        fetched.push(name);
        return bytesOf(`bytes of ${name}`);
      },
    });

    await files.readBytes('clang');
    await files.readBytes('lld');
    await files.readBytes('clang');

    expect(fetched).toEqual(['clang', 'lld']);
  });

  it('discards cached files from a different toolchain revision', async () => {
    const storage = memoryStorage();
    let fetches = 0;
    const fetchBytes = async (): Promise<Uint8Array> => {
      fetches += 1;
      return bytesOf('NEW');
    };

    const old = createCachedFiles({
      storage,
      version: 'binji-wasm-clang@2020-01-01',
      fetchBytes: async () => bytesOf('OLD'),
    });
    expect(new TextDecoder().decode(await old.readBytes('clang'))).toBe('OLD');

    const current = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes,
    });
    expect(new TextDecoder().decode(await current.readBytes('clang'))).toBe('NEW');
    expect(fetches).toBe(1);
    // The stale entry is gone, not merely overwritten later.
    expect(storage.map.has('lld')).toBe(false);
  });

  it('still works when storage throws (quota, blocked, private mode)', async () => {
    const broken: CacheStorage = {
      read: async () => {
        throw new Error('blocked');
      },
      write: async () => {
        throw new Error('quota exceeded');
      },
      keys: async () => {
        throw new Error('blocked');
      },
      remove: async () => {
        throw new Error('blocked');
      },
    };

    const files = createCachedFiles({
      storage: broken,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => bytesOf('FROM-NETWORK'),
    });

    expect(new TextDecoder().decode(await files.readBytes('clang'))).toBe('FROM-NETWORK');
  });

  it('reads straight from the network when there is no storage at all', async () => {
    let fetches = 0;
    const files = createCachedFiles({
      storage: null,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => {
        fetches += 1;
        return bytesOf('PLAIN');
      },
    });

    await files.readBytes('clang');
    await files.readBytes('clang');
    expect(fetches).toBe(2);
  });

  it('does not cache an empty response', async () => {
    const storage = memoryStorage();
    const files = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => new Uint8Array(0),
    });

    await files.readBytes('clang');
    expect(storage.map.has('clang')).toBe(false);
  });

  it('decodes text files', async () => {
    const files = createCachedFiles({
      storage: memoryStorage(),
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: async () => bytesOf('const API = 1;'),
    });

    expect(await files.readText('shared.js')).toBe('const API = 1;');
  });
});
