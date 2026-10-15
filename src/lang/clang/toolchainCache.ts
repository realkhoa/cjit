/**
 * Keeps the WebAssembly toolchain on the machine instead of in the HTTP cache.
 *
 * GitHub Pages serves these files with `Cache-Control: max-age=600`, so a reload
 * after ten minutes has to revalidate at best and re-download 58 MB at worst, and
 * a large entry can be evicted by the browser at any time. Run is a button people
 * press again and again, so the toolchain is persisted in IndexedDB the first time
 * and read from there afterwards - no TTL, no revalidation, and Run keeps working
 * on a slow or offline connection.
 *
 * The logic is separated from IndexedDB so the read-through behaviour (fetch once,
 * never again) is unit tested with a fake storage.
 */

/** Reserved key holding the toolchain revision the cached files belong to. */
const VERSION_KEY = '__toolchain_version';

/**
 * Bump this whenever the toolchain changes: cached bytes from a different
 * revision are discarded rather than mixed with the new ones.
 */
export const TOOLCHAIN_CACHE_VERSION = 'binji-wasm-clang@2023-12-07';

export const TOOLCHAIN_FILES: readonly string[] = [
  'clang',
  'lld',
  'sysroot.tar',
  'memfs',
  'shared.js',
  'LICENSE',
  'LICENSE.llvm',
];

export interface CacheStorage {
  read(key: string): Promise<ArrayBuffer | undefined>;
  write(key: string, value: ArrayBuffer): Promise<void>;
  keys(): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
}

export interface CachedFilesOptions {
  /** Null when IndexedDB is unavailable; the cache is then simply skipped. */
  readonly storage: CacheStorage | null;
  readonly version: string;
  /** Network read, used only on a cache miss. */
  readonly fetchBytes: (name: string) => Promise<Uint8Array>;
  /** Called with a human-readable note about what the cache did. */
  readonly onNote?: (message: string) => void;
}

export interface CachedFiles {
  readBytes(name: string): Promise<Uint8Array>;
  readText(name: string): Promise<string>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function createCachedFiles(options: CachedFilesOptions): CachedFiles {
  const { storage, version } = options;

  /**
   * Once per worker: make sure the cache holds this revision. A mismatch clears the
   * whole store, because old and new toolchain files must not be mixed.
   */
  let prepared: Promise<void> | null = null;
  const prepare = (): Promise<void> => {
    if (prepared) return prepared;
    prepared = (async () => {
      if (!storage) return;
      try {
        const stored = await storage.read(VERSION_KEY);
        const text = stored ? new TextDecoder().decode(new Uint8Array(stored)) : '';
        if (text === version) return;

        for (const key of await storage.keys()) {
          await storage.remove(key);
        }
        await storage.write(VERSION_KEY, toArrayBuffer(new TextEncoder().encode(version)));
      } catch {
        // A cache that cannot be prepared is not an error: reads fall through to
        // the network below.
      }
    })();
    return prepared;
  };

  async function readBytes(name: string): Promise<Uint8Array> {
    await prepare();

    if (storage) {
      try {
        const cached = await storage.read(name);
        if (cached && cached.byteLength > 0) {
          options.onNote?.(`${name} từ cache trong máy`);
          return new Uint8Array(cached);
        }
      } catch {
        // Fall through to the network.
      }
    }

    const fetched = await options.fetchBytes(name);
    if (storage && fetched.byteLength > 0) {
      try {
        await storage.write(name, toArrayBuffer(fetched));
      } catch {
        // Quota or a blocked write: the bytes are still returned.
      }
    }
    return fetched;
  }

  return {
    readBytes,
    async readText(name: string): Promise<string> {
      return new TextDecoder().decode(await readBytes(name));
    },
  };
}

/** IndexedDB-backed storage. Resolves null when IndexedDB is unavailable. */
export async function openToolchainStorage(
  databaseName = 'cjit-toolchain',
): Promise<CacheStorage | null> {
  if (typeof indexedDB === 'undefined') return null;

  return new Promise<CacheStorage | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, 1);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('files')) {
        database.createObjectStore('files');
      }
    };

    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);

    request.onsuccess = () => {
      const database = request.result;

      // Best effort: persistent storage is what keeps 58 MB from being evicted
      // under disk pressure. Browsers may decline (or require a user gesture), and
      // the cache still works when they do.
      try {
        void navigator.storage?.persist?.().catch(() => undefined);
      } catch {
        // No StorageManager: ignore.
      }

      const run = <T>(
        mode: IDBTransactionMode,
        work: (store: IDBObjectStore) => IDBRequest<T>,
      ): Promise<T> =>
        new Promise<T>((resolveRequest, rejectRequest) => {
          const transaction = database.transaction('files', mode);
          const store = transaction.objectStore('files');
          const inner = work(store);
          inner.onsuccess = () => resolveRequest(inner.result);
          inner.onerror = () => rejectRequest(inner.error ?? new Error('indexeddb error'));
        });

      resolve({
        read: async (key) => {
          const value = await run<ArrayBuffer | undefined>('readonly', (store) =>
            store.get(key) as IDBRequest<ArrayBuffer | undefined>,
          );
          return value ?? undefined;
        },
        write: async (key, value) => {
          await run('readwrite', (store) => store.put(value, key));
        },
        keys: async () => {
          const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
          return keys.map((key) => String(key));
        },
        remove: async (key) => {
          await run('readwrite', (store) => store.delete(key));
        },
      });
    };
  });
}
