import { buildCompileErrorSnapshot, createFastEngine } from '@/engine/fastEngine';
import { analyzeSource } from '@/lang/analyze';
import { publishAnalysis } from '@/lang/analysisCache';
import type {
  ArtifactSaveResult,
  Engine,
  RunOutcome,
  RunSink,
  SourceUnit,
  WatchSnapshot,
} from '@/engine/types';
import type { ClangRequest, ClangResponse } from '@/worker/clangProtocol';

/**
 * The real C/C++ engine: clang + lld + libc++ in WebAssembly.
 *
 * Scope, deliberately:
 *  - `run` (the Run button / F5) compiles and executes the file with clang;
 *  - `watch` is *not* served by clang: waiting for a compiler once per second is
 *    impossible, so the realtime pane keeps using the fast engine. The Watch pane
 *    stays honest because every snapshot carries the engine that produced it.
 *
 * Cancelling terminates the worker: a synchronous WebAssembly build cannot be
 * asked to stop.
 */

export function defaultClangWorkerFactory(): Worker {
  return new Worker(new URL('@/worker/clang.worker.ts', import.meta.url), { type: 'module' });
}

export interface ClangEngineOptions {
  /** Injectable for tests; defaults to the Vite-bundled module worker. */
  readonly createWorker?: () => Worker;
  /** Absolute URL of the directory holding clang/lld/sysroot/shared.js. */
  readonly toolchainBase?: string;
}

export function defaultToolchainBase(): string {
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  return new URL('toolchain/', base ?? 'http://localhost/').href;
}

export function createClangEngine(options: ClangEngineOptions = {}): Engine {
  const createWorker = options.createWorker ?? defaultClangWorkerFactory;
  const toolchainBase = options.toolchainBase ?? defaultToolchainBase();
  const fastEngine = createFastEngine();

  let worker: Worker | null = null;
  let requestId = 0;

  const ensureWorker = (): Worker => {
    if (!worker) worker = createWorker();
    return worker;
  };

  const killWorker = (): void => {
    worker?.terminate();
    worker = null;
  };

  /**
   * Sends one request and waits for its answer.
   *
   * Used by artifact downloads, which are a single round trip and must not be
   * confused with the streaming protocol a run uses.
   */
  const requestOnce = <T>(
    build: (id: number) => ClangRequest,
    read: (response: ClangResponse) => T | undefined,
  ): Promise<T | null> =>
    new Promise<T | null>((resolve) => {
      let current: Worker;
      try {
        current = ensureWorker();
      } catch {
        resolve(null);
        return;
      }

      requestId += 1;
      const id = requestId;

      const onMessage = (event: MessageEvent): void => {
        const response = event.data as ClangResponse;
        if (response.requestId !== id) return;

        const value = read(response);
        if (value === undefined) return;
        current.removeEventListener('message', onMessage);
        resolve(value);
      };

      current.addEventListener('message', onMessage);
      current.postMessage(build(id));
    });

  return {
    id: 'clang-wasm',
    label: 'Clang + LLD (WebAssembly)',

    // The realtime pane never waits for a compiler.
    watch(source: SourceUnit, signal: AbortSignal): Promise<WatchSnapshot> {
      return fastEngine.watch(source, signal);
    },

    run(source: SourceUnit, stdin: string, sink: RunSink, signal: AbortSignal): Promise<RunOutcome> {
      const analysis = analyzeSource(source.code, source.file);
      publishAnalysis(analysis);

      if (analysis.errorCount > 0) {
        sink.stderr(`Build failed: ${analysis.diagnostics.length} problem(s)\n`);
        sink.watch(buildCompileErrorSnapshot(analysis));
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
        let current: Worker;
        try {
          current = ensureWorker();
        } catch (error) {
          // A worker can be unavailable or blocked (strict CSP, unusual host).
          // That is not the user's code failing, so it is reported as unsupported
          // and the caller falls back to the fast engine and says why.
          resolve({
            status: 'unsupported',
            detail: `cannot start the compiler worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
            exitCode: null,
            elapsedMs: 0,
            steps: 0,
            diagnostics: [],
          });
          return;
        }

        requestId += 1;
        const id = requestId;

        const onMessage = (event: MessageEvent): void => {
          const response = event.data as ClangResponse;
          if (response.requestId !== id) return;

          switch (response.kind) {
            case 'status':
              // Informational (the first run downloads ~58 MB), so not an error.
              if (!signal.aborted) sink.stdout(`${response.message}\n`);
              return;
            case 'output':
              if (signal.aborted) return;
              // Build output is what the compiler said; run output is the program.
              if (response.phase === 'build') sink.stderr(response.chunk);
              else sink.stdout(response.chunk);
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
          killWorker();
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
          current.removeEventListener('message', onMessage);
          signal.removeEventListener('abort', onAbort);
        };

        current.addEventListener('message', onMessage);
        signal.addEventListener('abort', onAbort);

        const request: ClangRequest = {
          kind: 'run',
          requestId: id,
          code: source.code,
          fileName: source.file,
          stdin,
          toolchainBase,
          ...(source.files ? { files: source.files } : {}),
        };
        current.postMessage(request);
      });
    },

    async saveArtifact(source, kind, save): Promise<ArtifactSaveResult> {
      const answer = await requestOnce(
        (id): ClangRequest => ({
          kind: 'artifact',
          requestId: id,
          fileName: source.file,
          which: kind,
        }),
        (response) => {
          if (response.kind === 'artifact') {
            return { ok: true as const, name: response.name, bytes: new Uint8Array(response.bytes) };
          }
          if (response.kind === 'failure') return { ok: false as const, error: response.message };
          return undefined;
        },
      );

      if (!answer) {
        return { ok: false, error: 'the compiler worker did not answer' };
      }
      if (!answer.ok) {
        return { ok: false, error: answer.error };
      }

      save(answer.name, answer.bytes);
      return { ok: true, name: answer.name, byteLength: answer.bytes.byteLength };
    },
  };
}
