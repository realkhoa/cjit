import type { Engine, EngineId } from './types';
import { createPendingEngine } from './placeholderEngine';

/**
 * Engine registry. Real engines call `registerEngine()` when they are wired up
 * (M1 registers `fast`, M7 registers `clang-wasm`); until then a pending engine
 * with an honest "not wired" answer is served, so the UI code path is identical
 * before and after the implementation lands.
 */

export const ENGINE_ORDER: readonly EngineId[] = ['clang-wasm', 'fast'];

interface PendingDefaults {
  readonly label: string;
  readonly milestone: string;
  readonly note: string;
}

const PENDING_DEFAULTS: Record<EngineId, PendingDefaults> = {
  'clang-wasm': {
    label: 'Clang + LLD (WebAssembly)',
    milestone: 'M7',
    note: 'Biên dịch C++ thật với libc++/STL; cần tải toolchain và sysroot.',
  },
  fast: {
    label: 'Fast watch engine',
    milestone: 'M1–M3',
    note: 'Preprocessor + parser + evaluator nhẹ, đủ nhanh cho debounce 1 giây.',
  },
};

const wired = new Map<EngineId, Engine>();
const pendingCache = new Map<EngineId, Engine>();

export function registerEngine(engine: Engine): void {
  wired.set(engine.id, engine);
  pendingCache.delete(engine.id);
}

/** True when the engine was explicitly registered, i.e. it really exists. */
export function isEngineWired(id: EngineId): boolean {
  return wired.has(id);
}

export function getEngine(id: EngineId): Engine {
  const existing = wired.get(id);
  if (existing) return existing;

  const cached = pendingCache.get(id);
  if (cached) return cached;

  const defaults = PENDING_DEFAULTS[id];
  const pending = createPendingEngine({
    id,
    label: defaults.label,
    milestone: defaults.milestone,
    note: defaults.note,
  });
  pendingCache.set(id, pending);
  return pending;
}

export function engineLabel(id: EngineId): string {
  return getEngine(id).label;
}
