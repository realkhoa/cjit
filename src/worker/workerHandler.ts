import {
  RUN_LIMITS,
  WATCH_LIMITS,
  buildCompileErrorSnapshot,
  buildRunOutcome,
  buildWatchSnapshot,
} from '@/engine/fastEngine';
import { analyzeSource } from '@/lang/analyze';
import { summarize } from '@/lang/diagnostics';
import { execute } from '@/lang/runtime/interpreter';
import type { WorkerRequest, WorkerResponse } from '@/worker/protocol';

/**
 * The worker's whole job, as a pure function of request -> posted responses.
 *
 * Kept out of the worker entry file so it can be driven directly in tests: the
 * protocol is then verified without needing a real Worker in the test runtime.
 */
export function handleWorkerRequest(
  request: WorkerRequest,
  post: (response: WorkerResponse) => void,
): void {
  const { requestId } = request;

  try {
    const analysis = analyzeSource(request.code, request.file);

    if (analysis.errorCount > 0) {
      const snapshot = buildCompileErrorSnapshot(analysis);
      if (request.kind === 'run') {
        post({ kind: 'stderr', requestId, chunk: `Build failed: ${summarize(analysis.diagnostics)}\n` });
      }
      post({ kind: 'watch', requestId, snapshot });
      if (request.kind === 'run') {
        post({
          kind: 'done',
          requestId,
          outcome: {
            status: 'compile-error',
            detail: 'Build failed — see the Problems tab',
            exitCode: null,
            elapsedMs: analysis.elapsedMs,
            steps: 0,
            diagnostics: analysis.diagnostics,
          },
        });
      }
      return;
    }

    if (request.kind === 'watch') {
      const result = execute(analysis.unit, { ...WATCH_LIMITS, collectWatch: true });
      post({ kind: 'watch', requestId, snapshot: buildWatchSnapshot(analysis, result) });
      return;
    }

    const result = execute(analysis.unit, {
      ...RUN_LIMITS,
      stdin: request.stdin,
      collectWatch: true,
      onOutput: (chunk, stream) => {
        post(
          stream === 'stderr'
            ? { kind: 'stderr', requestId, chunk }
            : { kind: 'stdout', requestId, chunk },
        );
      },
    });

    post({ kind: 'watch', requestId, snapshot: buildWatchSnapshot(analysis, result) });
    post({ kind: 'done', requestId, outcome: buildRunOutcome(analysis, result) });
  } catch (error) {
    // A crash in the engine is reported, never swallowed.
    post({
      kind: 'failure',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
