import { buildCompileErrorSnapshot } from '@/engine/fastEngine';
import { analyzeSource } from '@/lang/analyze';
import { publishAnalysis } from '@/lang/analysisCache';
import type { Engine, RunOutcome, RunSink, SourceUnit, WatchSnapshot } from '@/engine/types';
import { emptyWatch } from '@/engine/types';
import type { WorkerRequest, WorkerResponse } from '@/worker/protocol';

/**
 * Runs the fast engine inside a Web Worker.
 *
 * Why: the engine executes the user's program. On the main thread an infinite
 * loop freezes the editor for the whole budget (1.2s on every debounce tick, up
 * to 30s on Run). In a worker, the editor stays responsive and the worker can
 * simply be terminated to cancel.
 *
 * Two independent workers are used - one for the realtime pass, one for Run - so
 * that typing during a long run does not kill the run, and a long run cannot
 * delay the realtime pane.
 *
 * Parsing still happens on the main thread as well: it is a few milliseconds and
 * it is what feeds completion, hover and the markers. The worker's snapshot is
 * authoritative for *values*, the local analysis for *editor intelligence*.
 */

export function defaultWorkerFactory(): Worker {
  return new Worker(new URL('@/worker/analyze.worker.ts', import.meta.url), { type: 'module' });
}

export interface WorkerEngineOptions {
  /** Injectable for tests; defaults to the Vite-bundled module worker. */
  readonly createWorker?: () => Worker;
}

export function createWorkerEngine(options: WorkerEngineOptions = {}): Engine {
  const createWorker = options.createWorker ?? defaultWorkerFactory;

  let watchWorker: Worker | null = null;
  let watchRequestId = 0;

  let runWorker: Worker | null = null;
  let runRequestId = 0;

  const ensureWatchWorker = (): Worker => {
    if (!watchWorker) watchWorker = createWorker();
    return watchWorker;
  };

  const ensureRunWorker = (): Worker => {
    if (!runWorker) runWorker = createWorker();
    return runWorker;
  };

  const killWatchWorker = (): void => {
    watchWorker?.terminate();
    watchWorker = null;
  };

  const killRunWorker = (): void => {
    runWorker?.terminate();
    runWorker = null;
  };

  const cancelledSnapshot = (detail: string): WatchSnapshot =>
    emptyWatch({ engine: 'fast', engineLabel: 'Fast engine', status: 'idle', detail });

  function watch(source: SourceUnit, signal: AbortSignal): Promise<WatchSnapshot> {
    // Diagnostics and symbols come from the local parse: the worker is only
    // needed when the program has to actually run.
    const analysis = analyzeSource(source.code, source.file);
    publishAnalysis(analysis);

    if (analysis.errorCount > 0) {
      return Promise.resolve(buildCompileErrorSnapshot(analysis));
    }

    if (signal.aborted) return Promise.resolve(cancelledSnapshot('cancelled before it started'));

    return new Promise<WatchSnapshot>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = ensureWatchWorker();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      watchRequestId += 1;
      const requestId = watchRequestId;

      const onMessage = (event: MessageEvent): void => {
        const response = event.data as WorkerResponse;
        if (response.requestId !== requestId) return;

        if (response.kind === 'watch') {
          cleanup();
          resolve({ ...response.snapshot, diagnostics: analysis.diagnostics });
          return;
        }
        if (response.kind === 'failure') {
          cleanup();
          reject(new Error(response.message));
        }
      };

      const onAbort = (): void => {
        cleanup();
        // A synchronous worker cannot be asked to stop: it is terminated.
        killWatchWorker();
        resolve(cancelledSnapshot('cancelled: new input arrived'));
      };

      const cleanup = (): void => {
        worker.removeEventListener('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      worker.addEventListener('message', onMessage);
      signal.addEventListener('abort', onAbort);

      const request: WorkerRequest = {
        kind: 'watch',
        requestId,
        code: source.code,
        file: source.file,
      };
      worker.postMessage(request);
    });
  }

  function run(
    source: SourceUnit,
    stdin: string,
    sink: RunSink,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const analysis = analyzeSource(source.code, source.file);
    publishAnalysis(analysis);

    if (analysis.errorCount > 0) {
      const snapshot = buildCompileErrorSnapshot(analysis);
      sink.watch(snapshot);
      return Promise.resolve({
        status: 'compile-error',
        detail: 'Build failed — see the Problems tab',
        exitCode: null,
        elapsedMs: analysis.elapsedMs,
        steps: 0,
        diagnostics: analysis.diagnostics,
      });
    }

    return new Promise<RunOutcome>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = ensureRunWorker();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      runRequestId += 1;
      const requestId = runRequestId;

      const onMessage = (event: MessageEvent): void => {
        const response = event.data as WorkerResponse;
        if (response.requestId !== requestId) return;

        switch (response.kind) {
          case 'stdout':
            if (!signal.aborted) sink.stdout(response.chunk);
            return;
          case 'stderr':
            if (!signal.aborted) sink.stderr(response.chunk);
            return;
          case 'watch':
            sink.watch({ ...response.snapshot, diagnostics: analysis.diagnostics });
            return;
          case 'done':
            cleanup();
            resolve(response.outcome);
            return;
          case 'failure':
            cleanup();
            reject(new Error(response.message));
            return;
          default:
            return;
        }
      };

      const onAbort = (): void => {
        cleanup();
        killRunWorker();
        resolve({
          status: 'idle',
          detail: 'stopped by the user',
          exitCode: null,
          elapsedMs: 0,
          steps: 0,
          diagnostics: [],
        });
      };

      const cleanup = (): void => {
        worker.removeEventListener('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      worker.addEventListener('message', onMessage);
      signal.addEventListener('abort', onAbort);

      const request: WorkerRequest = {
        kind: 'run',
        requestId,
        code: source.code,
        file: source.file,
        stdin,
      };
      worker.postMessage(request);
    });
  }

  return { id: 'fast', label: 'Fast engine', watch, run };
}
