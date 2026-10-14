import type { Engine, EngineId, RunOutcome, WatchSnapshot } from './types';
import { emptyWatch } from './types';

export interface PendingEngineOptions {
  readonly id: EngineId;
  readonly label: string;
  readonly milestone: string;
  readonly note: string;
}

/**
 * Stand-in for an engine that is specified but not implemented yet.
 *
 * It answers `unsupported` with a concrete reason instead of returning empty
 * values or fabricated ones, so the watch pane stays honest during M0.
 */
export function createPendingEngine(options: PendingEngineOptions): Engine {
  const detail = `${options.label} chưa được nối (${options.milestone}). ${options.note}`;

  return {
    id: options.id,
    label: options.label,

    async watch(): Promise<WatchSnapshot> {
      return emptyWatch({
        engine: options.id,
        engineLabel: options.label,
        status: 'unsupported',
        detail,
      });
    },

    async run(_source, _stdin, sink): Promise<RunOutcome> {
      sink.watch(
        emptyWatch({
          engine: options.id,
          engineLabel: options.label,
          status: 'unsupported',
          detail,
        }),
      );
      return {
        status: 'unsupported',
        detail,
        exitCode: null,
        elapsedMs: 0,
        steps: 0,
        diagnostics: [],
      };
    },
  };
}
