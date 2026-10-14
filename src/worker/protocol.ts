import type { Diagnostic, RunOutcome, WatchSnapshot } from '@/engine/types';

/**
 * Main-thread <-> worker message contract.
 *
 * The heavy engines (M2 interpreter, M7 clang) run in a Web Worker so a runaway
 * program can never freeze the editor, and a stale edit can be cancelled. M0
 * defines the contract; M4 starts using it. Note that `SharedArrayBuffer` is
 * unavailable on GitHub Pages (no COOP/COEP headers), so this stays
 * `postMessage`-only - no shared memory, no pthreads.
 */

export interface AnalysisLimits {
  /** Interpreter step budget; exceeded -> status `budget`. */
  readonly maxSteps: number;
  /** Wall-clock budget in ms; exceeded -> status `timeout`. */
  readonly maxMillis: number;
  /** Maximum recorded variable snapshots. */
  readonly maxSnapshots: number;
}

export const DEFAULT_LIMITS: AnalysisLimits = {
  maxSteps: 5_000_000,
  maxMillis: 2_000,
  maxSnapshots: 4_096,
};

export type WorkerRequest =
  | {
      readonly kind: 'analyze';
      readonly requestId: number;
      readonly code: string;
      readonly limits: AnalysisLimits;
    }
  | {
      readonly kind: 'run';
      readonly requestId: number;
      readonly code: string;
      readonly stdin: string;
      readonly limits: AnalysisLimits;
    }
  | { readonly kind: 'cancel'; readonly targetId: number };

export type WorkerResponse =
  | { readonly kind: 'diagnostics'; readonly requestId: number; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: 'watch'; readonly requestId: number; readonly snapshot: WatchSnapshot }
  | { readonly kind: 'stdout'; readonly requestId: number; readonly chunk: string }
  | { readonly kind: 'stderr'; readonly requestId: number; readonly chunk: string }
  | { readonly kind: 'done'; readonly requestId: number; readonly outcome: RunOutcome };
