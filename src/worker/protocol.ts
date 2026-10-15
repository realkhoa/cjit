import type { Diagnostic, RunOutcome, SourceFile, WatchSnapshot } from '@/engine/types';

/**
 * Main-thread <-> worker protocol.
 *
 * The engines execute arbitrary user programs, so they run in a Web Worker: a
 * runaway loop must not be able to freeze the editor. Note that
 * `SharedArrayBuffer` is unavailable on GitHub Pages (no COOP/COEP headers), so
 * this stays `postMessage`-only - and because the worker executes synchronously,
 * cancelling means terminating it, not asking it to stop.
 */

/** The rest of the workspace, so quoted includes resolve inside the worker too. */
type WorkspaceFiles = readonly SourceFile[];

export interface WatchRequest {
  readonly kind: 'watch';
  readonly requestId: number;
  readonly code: string;
  readonly file: string;
  readonly files?: WorkspaceFiles;
}

export interface RunRequest {
  readonly kind: 'run';
  readonly requestId: number;
  readonly code: string;
  readonly file: string;
  readonly stdin: string;
  readonly files?: WorkspaceFiles;
}

export type WorkerRequest = WatchRequest | RunRequest;

export type WorkerResponse =
  | { readonly kind: 'watch'; readonly requestId: number; readonly snapshot: WatchSnapshot }
  | { readonly kind: 'stdout'; readonly requestId: number; readonly chunk: string }
  | { readonly kind: 'stderr'; readonly requestId: number; readonly chunk: string }
  | { readonly kind: 'done'; readonly requestId: number; readonly outcome: RunOutcome }
  | { readonly kind: 'failure'; readonly requestId: number; readonly message: string };

/** The worker never sends analysis structures: only cloneable plain data. */
export type WorkerDiagnostics = readonly Diagnostic[];
