import { createClangEngine } from '@/engine/clangEngine';
import { createFastEngine } from '@/engine/fastEngine';
import { registerEngine } from '@/engine/registry';
import { createWorkerEngine } from '@/engine/workerEngine';

/**
 * Wires the engines the app can actually run.
 *
 * - The fast engine serves the realtime pane (and Run, until clang answers), in a
 *   Web Worker so executing the user's program cannot freeze the editor.
 * - The clang engine serves Run with a real compiler. It is registered even when
 *   the toolchain has not been downloaded: it reports that honestly, and the store
 *   falls back to the fast engine with a visible note rather than failing.
 */
export function registerDefaultEngines(): void {
  registerEngine(createDefaultFastEngine());
  registerEngine(createClangEngine());
}

export function createDefaultFastEngine() {
  if (typeof Worker === 'undefined') return createFastEngine();
  try {
    return createWorkerEngine();
  } catch {
    // A blocked worker (CSP, file://) must not take the whole app down.
    return createFastEngine();
  }
}
