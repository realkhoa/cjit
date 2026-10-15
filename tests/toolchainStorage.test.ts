import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TOOLCHAIN_CACHE_VERSION,
  createCachedFiles,
  openToolchainStorage,
} from '@/lang/clang/toolchainCache';

/**
 * The IndexedDB adapter, driven for real (fake-indexeddb implements the API).
 *
 * The behaviour under test is the one the user asked for: after the toolchain has
 * been downloaded once, a later page load - a new worker with an empty in-memory
 * state - starts zero network requests.
 */

const DATABASE = 'cjit-toolchain-test';

function networkSpy(): { fetchBytes: (name: string) => Promise<Uint8Array>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchBytes: async (name: string) => {
      calls.push(name);
      return new TextEncoder().encode(`content of ${name}`);
    },
  };
}

beforeEach(async () => {
  // Each test starts from an empty database.
  const storage = await openToolchainStorage(DATABASE);
  for (const key of await storage!.keys()) await storage!.remove(key);
});

describe('toolchain storage adapter', () => {
  it('stores and reads back bytes, lists keys and removes them', async () => {
    const storage = await openToolchainStorage(DATABASE);
    expect(storage).not.toBeNull();

    const bytes = new TextEncoder().encode('CLANG');
    await storage!.write('clang', bytes.buffer as ArrayBuffer);

    const read = await storage!.read('clang');
    expect(new TextDecoder().decode(new Uint8Array(read!))).toBe('CLANG');
    expect(await storage!.keys()).toContain('clang');

    await storage!.remove('clang');
    expect(await storage!.read('clang')).toBeUndefined();
  });

  it('serves the second page load from IndexedDB without any download', async () => {
    // First load: nothing cached, so the network is used and the files are stored.
    const first = networkSpy();
    const firstLoad = createCachedFiles({
      storage: await openToolchainStorage(DATABASE),
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: first.fetchBytes,
    });
    await firstLoad.readBytes('clang');
    await firstLoad.readBytes('lld');
    await firstLoad.readText('shared.js');
    expect(first.calls).toEqual(['clang', 'lld', 'shared.js']);

    // Second load: a fresh worker, a fresh cache object, the same database.
    const second = networkSpy();
    const secondLoad = createCachedFiles({
      storage: await openToolchainStorage(DATABASE),
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: second.fetchBytes,
    });

    expect(new TextDecoder().decode(await secondLoad.readBytes('clang'))).toBe('content of clang');
    expect(new TextDecoder().decode(await secondLoad.readBytes('lld'))).toBe('content of lld');
    expect(await secondLoad.readText('shared.js')).toBe('content of shared.js');

    // Not one byte over the network.
    expect(second.calls).toEqual([]);
  });

  it('re-downloads after the toolchain revision changes', async () => {
    const storage = await openToolchainStorage(DATABASE);

    const old = networkSpy();
    await createCachedFiles({
      storage,
      version: 'older-revision',
      fetchBytes: old.fetchBytes,
    }).readBytes('clang');
    expect(old.calls).toEqual(['clang']);

    const current = networkSpy();
    const files = createCachedFiles({
      storage,
      version: TOOLCHAIN_CACHE_VERSION,
      fetchBytes: current.fetchBytes,
    });
    await files.readBytes('clang');

    expect(current.calls).toEqual(['clang']);
  });

  it('resolves to null when IndexedDB is unavailable', async () => {
    const original = globalThis.indexedDB;
    try {
      // @ts-expect-error - deliberately removing the global for this case.
      delete globalThis.indexedDB;
      expect(await openToolchainStorage(DATABASE)).toBeNull();
    } finally {
      globalThis.indexedDB = original;
    }
  });
});
