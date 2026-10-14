import type {
  Engine,
  RunOutcome,
  RunSink,
  VarNode,
  WatchSnapshot,
  WatchStatus,
} from '@/engine/types';
import { analyzeSource } from '@/lang/analyze';
import type { AnalysisResult } from '@/lang/analyze';
import { publishAnalysis } from '@/lang/analysisCache';
import { summarize } from '@/lang/diagnostics';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import type { WatchVariable } from '@/lang/runtime/interpreter';

/**
 * The fast engine: preprocess + parse + symbols + *execute*, in-process.
 *
 * Both entry points run the program for real:
 *  - `watch` executes with a tight budget and reports the resulting variable
 *    values, so the realtime pane shows numbers that actually came out of the
 *    program;
 *  - `run` executes with the full budget, streams stdout/stderr as it is
 *    produced, and reports the exit code.
 *
 * A runaway loop becomes a `budget`/`timeout` snapshot, never a frozen tab.
 */

/** Realtime passes are cheap: the user is still typing. */
export const WATCH_LIMITS = {
  maxSteps: 1_500_000,
  maxMillis: 1_200,
  maxOutputChars: 64_000,
  maxSnapshots: 400,
} as const;
/** Run is the user's explicit "execute this" and gets room to finish. */
export const RUN_LIMITS = {
  maxSteps: 30_000_000,
  maxMillis: 30_000,
  maxOutputChars: 1_000_000,
  maxSnapshots: 400,
} as const;

function toVarNode(variable: WatchVariable): VarNode {
  return {
    name: variable.name,
    type: variable.type,
    value: variable.value,
    scope: variable.scope,
    changed: variable.changed,
    ...(variable.children && variable.children.length > 0
      ? { children: variable.children.map(toVarNode) }
      : {}),
  };
}

export function statusOf(result: ExecutionResult): WatchStatus {
  switch (result.status) {
    case 'ok':
      return 'ok';
    case 'runtime-error':
      return 'runtime-error';
    case 'timeout':
      return 'timeout';
    case 'budget':
      return 'budget';
    default:
      return 'unsupported';
  }
}

export function detailOf(result: ExecutionResult): string {
  const parts: string[] = [];
  switch (result.status) {
    case 'ok':
      parts.push(`ran to completion in ${result.steps} steps`);
      if (result.stdout.length > 0) parts.push(`${result.stdout.length} chars of stdout`);
      if (result.exitCode !== null && result.exitCode !== 0) parts.push(`exit code ${result.exitCode}`);
      break;
    case 'runtime-error':
      parts.push(result.detail);
      if (result.frames.length > 0) {
        const top = result.frames[0];
        if (top) parts.push(`at ${top.function}:${top.line}`);
      }
      break;
    default:
      parts.push(result.detail);
      break;
  }
  if (result.truncated) parts.push('output truncated by a cap');
  return parts.join(' · ');
}

/**
 * Nothing ran, so there are no values: only diagnostics. Exported because the
 * Web Worker handler builds the same snapshot.
 */
export function buildCompileErrorSnapshot(analysis: AnalysisResult): WatchSnapshot {
  return {
    engine: 'fast',
    engineLabel: 'Fast engine',
    status: 'compile-error',
    detail: `Build failed: ${summarize(analysis.diagnostics)}`,
    vars: [],
    frames: [],
    steps: 0,
    elapsedMs: analysis.elapsedMs,
    truncated: false,
    historyLength: 0,
    diagnostics: analysis.diagnostics,
    lineStates: [],
    history: [],
  };
}

/**
 * Turns an execution into the engine's snapshot. Exported because the Web Worker
 * handler must produce exactly the same shape as the in-process engine - one
 * source of truth, whichever thread did the work.
 */
export function buildWatchSnapshot(
  analysis: AnalysisResult,
  result: ExecutionResult,
): WatchSnapshot {
  return {
    engine: 'fast',
    engineLabel: 'Fast engine',
    status: statusOf(result),
    detail: detailOf(result),
    vars: result.vars.map(toVarNode),
    frames: result.frames.map((frame) => ({ function: frame.function, line: frame.line })),
    steps: result.steps,
    elapsedMs: result.elapsedMs,
    truncated: result.truncated,
    historyLength: result.historyLength,
    diagnostics: [...analysis.diagnostics, ...result.diagnostics],
    lineStates: result.lineStates.map((state) => ({
      line: state.line,
      vars: state.vars.map(toVarNode),
    })),
    history: result.history.map((entry) => ({
      step: entry.step,
      line: entry.line,
      scope: entry.scope,
      name: entry.name,
      vars: entry.vars.map(toVarNode),
    })),
  };
}

export function buildRunOutcome(analysis: AnalysisResult, result: ExecutionResult): RunOutcome {
  return {
    status: statusOf(result),
    detail: detailOf(result),
    exitCode: result.exitCode,
    elapsedMs: result.elapsedMs,
    steps: result.steps,
    diagnostics: [...analysis.diagnostics, ...result.diagnostics],
  };
}

export function createFastEngine(): Engine {
  return {
    id: 'fast',
    label: 'Fast engine',

    async watch(source): Promise<WatchSnapshot> {
      const analysis = analyzeSource(source.code, source.file);
      // Completion/hover read the symbol table published for this snapshot.
      publishAnalysis(analysis);

      if (analysis.errorCount > 0) return buildCompileErrorSnapshot(analysis);

      const result = execute(analysis.unit, { ...WATCH_LIMITS, collectWatch: true });
      return buildWatchSnapshot(analysis, result);
    },

    async run(source, stdin, sink: RunSink, signal): Promise<RunOutcome> {
      const analysis = analyzeSource(source.code, source.file);
      publishAnalysis(analysis);

      if (analysis.errorCount > 0) {
        sink.stderr(`Build failed: ${summarize(analysis.diagnostics)}\n`);
        sink.watch(buildCompileErrorSnapshot(analysis));
        return {
          status: 'compile-error',
          detail: 'Build failed — see the Problems tab',
          exitCode: null,
          elapsedMs: analysis.elapsedMs,
          steps: 0,
          diagnostics: analysis.diagnostics,
        };
      }

      if (signal.aborted) {
        return {
          status: 'idle',
          detail: 'cancelled before the run started',
          exitCode: null,
          elapsedMs: 0,
          steps: 0,
          diagnostics: analysis.diagnostics,
        };
      }

      const result = execute(analysis.unit, {
        ...RUN_LIMITS,
        stdin,
        collectWatch: true,
        onOutput: (chunk, stream) => {
          if (signal.aborted) return;
          if (stream === 'stderr') sink.stderr(chunk);
          else sink.stdout(chunk);
        },
      });

      sink.watch(buildWatchSnapshot(analysis, result));

      return {
        status: statusOf(result),
        detail: detailOf(result),
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        steps: result.steps,
        diagnostics: [...analysis.diagnostics, ...result.diagnostics],
      };
    },
  };
}
