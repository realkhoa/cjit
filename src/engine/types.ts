/**
 * The engine contract.
 *
 * Two implementations are planned and the UI never cares which one answered:
 *
 *  - `fast`       : own preprocessor/parser/evaluator. Fast enough to run after
 *                   every 1s debounce, and it knows every variable at every
 *                   step, which is what the realtime watch pane needs (M1-M3).
 *  - `clang-wasm` : clang + lld compiled to WebAssembly with a libc++ sysroot.
 *                   Real C++ (STL, templates), but far too slow and heavy to run
 *                   on every edit, so it is the engine behind Run / F5 (M7).
 *
 * Every result carries the engine that produced it so the UI can always state
 * where a number came from. No engine is allowed to invent values.
 */

export type EngineId = 'fast' | 'clang-wasm';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  /** e.g. 'main.cpp' or '<built-in>' for virtual headers. */
  readonly source: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly startColumn: number;
  /** 1-based, inclusive. */
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * `unsupported` means "this engine cannot answer yet" - it is never used to
 * disguise an error or an empty result. `front-end-only` means the code was
 * parsed and checked successfully but nothing has been executed yet.
 */
export type WatchStatus =
  | 'idle'
  | 'ok'
  | 'front-end-only'
  | 'compile-error'
  | 'runtime-error'
  | 'timeout'
  | 'budget'
  | 'unsupported';

export interface VarNode {
  readonly name: string;
  readonly type: string;
  /** Already formatted for display, e.g. `42`, `0x7ffd10 -> 42`, `"abc"`. */
  readonly value: string;
  /** Owning function, or `global`. */
  readonly scope: string;
  /** True when the value changed at the most recent observed step. */
  readonly changed: boolean;
  /** Struct members, array elements, or the pointee of a pointer. */
  readonly children?: readonly VarNode[];
}

export interface StackFrame {
  readonly function: string;
  /** The line currently executing inside that frame. */
  readonly line: number;
}

/**
 * Variable values as they were the first time a given line finished running.
 * This is what lets the watch pane answer "what do the variables hold at the
 * line my cursor is on?" instead of only showing the final state.
 */
export interface LineState {
  readonly line: number;
  readonly vars: readonly VarNode[];
}

/**
 * One scrubbable moment in the program's life: the full variable state captured
 * when `name` was declared or assigned on `line`.
 */
export interface WatchHistoryEntry {
  readonly step: number;
  readonly line: number;
  readonly scope: string;
  readonly name: string;
  readonly vars: readonly VarNode[];
}

export interface WatchSnapshot {
  readonly engine: EngineId | null;
  readonly engineLabel: string;
  readonly status: WatchStatus;
  /** Human-readable reason for `status`, always safe to show to the user. */
  readonly detail: string;
  readonly vars: readonly VarNode[];
  readonly frames: readonly StackFrame[];
  /** Interpreter/VM steps executed in the pass that produced this snapshot. */
  readonly steps: number;
  readonly elapsedMs: number;
  /** True when history or values were dropped because a cap was hit. */
  readonly truncated: boolean;
  /** Recorded timeline entries; 0 for engines that keep no history. */
  readonly historyLength: number;
  readonly diagnostics: readonly Diagnostic[];
  /** Per-line snapshots, ascending by line. Empty for engines that keep none. */
  readonly lineStates: readonly LineState[];
  /** Ordered assignment states for the timeline scrubber. */
  readonly history: readonly WatchHistoryEntry[];
}

export interface RunOutcome {
  readonly status: WatchStatus;
  readonly detail: string;
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly steps: number;
  readonly diagnostics: readonly Diagnostic[];
}

/** Streaming sink for a run; called from inside the worker in M2. */
export interface RunSink {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  watch(snapshot: WatchSnapshot): void;
}

/** The code to process, plus the file label diagnostics must be reported against. */
export interface SourceUnit {
  readonly code: string;
  readonly file: string;
}

export interface Engine {
  readonly id: EngineId;
  readonly label: string;
  /** Fast path behind the 1s debounce. Must honour `signal`. */
  watch(source: SourceUnit, signal: AbortSignal): Promise<WatchSnapshot>;
  /** Full execution behind Run / F5. Streams through `sink`. */
  run(
    source: SourceUnit,
    stdin: string,
    sink: RunSink,
    signal: AbortSignal,
  ): Promise<RunOutcome>;
}

export function emptyWatch(patch: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    engine: null,
    engineLabel: 'none',
    status: 'idle',
    detail: '',
    vars: [],
    frames: [],
    steps: 0,
    elapsedMs: 0,
    truncated: false,
    historyLength: 0,
    diagnostics: [],
    lineStates: [],
    history: [],
    ...patch,
  };
}
