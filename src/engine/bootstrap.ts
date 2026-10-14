import { createFastEngine } from '@/engine/fastEngine';
import { registerEngine } from '@/engine/registry';

/**
 * Wires the engines the app can actually run. Registering replaces the
 * "not wired" placeholder, so this is the single place to look when asking
 * "which engines are real right now?".
 */
export function registerDefaultEngines(): void {
  registerEngine(createFastEngine());
}
