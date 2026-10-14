import { createFastEngine } from '@/engine/fastEngine';
import { registerEngine } from '@/engine/registry';
import { createWorkerEngine } from '@/engine/workerEngine';

/**
 * Wires the engines the app can actually run.
 *
 * The fast engine is registered through a Web Worker whenever the environment
 * provides one, so executing the user's program cannot freeze the editor. The
 * in-process engine remains the fallback for environments without workers (and
 * is what unit tests exercise directly).
 */
export function registerDefaultEngines(): void {
  registerEngine(createDefaultFastEngine());
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
