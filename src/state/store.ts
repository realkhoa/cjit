import { create } from 'zustand';
import { DEFAULT_EXAMPLE } from '@/examples/sample';
import { getEngine } from '@/engine/registry';
import type { EngineId, WatchSnapshot } from '@/engine/types';
import { emptyWatch } from '@/engine/types';
import { DebouncedAnalyzer } from '@/state/analyzeController';
import { loadWorkspace, scheduleWorkspaceSave } from '@/state/persistence';
import {
  DEFAULT_BOTTOM_PERCENT,
  DEFAULT_RIGHT_PERCENT,
  MAX_BOTTOM_PERCENT,
  MAX_RIGHT_PERCENT,
  MIN_BOTTOM_PERCENT,
  MIN_RIGHT_PERCENT,
  clamp,
} from '@/util/layout';

/** The realtime watch pane refreshes this long after the last keystroke. */
export const ANALYSIS_DEBOUNCE_MS = 1000;

export type RunState = 'idle' | 'running';
export type AnalysisState = 'idle' | 'analyzing';
export type ConsoleTab = 'output' | 'problems' | 'stdin';
export type OutputKind = 'stdout' | 'stderr' | 'system';

export interface OutputLine {
  readonly id: number;
  readonly kind: OutputKind;
  readonly text: string;
}

export interface CursorInfo {
  readonly line: number;
  readonly column: number;
  /** Number of selected characters, shown in the status bar. */
  readonly selected: number;
}

export interface AppState {
  readonly path: string;
  readonly language: 'c' | 'cpp';
  readonly code: string;
  /** Bumped only when code is replaced programmatically, so the editor resyncs. */
  readonly codeRevision: number;
  readonly stdin: string;
  readonly engineId: EngineId;
  readonly runState: RunState;
  readonly analysisState: AnalysisState;
  readonly watch: WatchSnapshot;
  readonly output: readonly OutputLine[];
  readonly consoleTab: ConsoleTab;
  readonly rightPercent: number;
  readonly bottomPercent: number;
  readonly cursor: CursorInfo;

  setCodeFromEditor(code: string): void;
  loadExample(path: string, language: 'c' | 'cpp', code: string): void;
  setStdin(value: string): void;
  setConsoleTab(tab: ConsoleTab): void;
  appendOutput(kind: OutputKind, text: string): void;
  clearOutput(): void;
  setCursor(cursor: CursorInfo): void;
  setEngineId(id: EngineId): void;
  setRightPercent(percent: number): void;
  setBottomPercent(percent: number): void;
  run(): Promise<void>;
  stop(): void;
}

const persisted = loadWorkspace();

let outputSeq = 0;
let runController: AbortController | null = null;

function line(kind: OutputKind, text: string): OutputLine {
  outputSeq += 1;
  return { id: outputSeq, kind, text };
}

export const useAppStore = create<AppState>()((set, get) => ({
  path: DEFAULT_EXAMPLE.path,
  language: DEFAULT_EXAMPLE.language,
  code: persisted.code ?? DEFAULT_EXAMPLE.code,
  codeRevision: 0,
  stdin: persisted.stdin ?? '',
  engineId: 'clang-wasm',
  runState: 'idle',
  analysisState: 'idle',
  watch: emptyWatch({
    detail:
      'Chưa có giá trị biến. Engine phân tích sẽ được nối ở M1–M3; pane này không bao giờ hiển thị giá trị giả.',
  }),
  output: [],
  consoleTab: 'output',
  rightPercent: clamp(
    persisted.rightPercent ?? DEFAULT_RIGHT_PERCENT,
    MIN_RIGHT_PERCENT,
    MAX_RIGHT_PERCENT,
  ),
  bottomPercent: clamp(
    persisted.bottomPercent ?? DEFAULT_BOTTOM_PERCENT,
    MIN_BOTTOM_PERCENT,
    MAX_BOTTOM_PERCENT,
  ),
  cursor: { line: 1, column: 1, selected: 0 },

  setCodeFromEditor(code) {
    set({ code });
    analyzer.schedule(code);
  },

  loadExample(path, language, code) {
    set((state) => ({
      path,
      language,
      code,
      codeRevision: state.codeRevision + 1,
      output: [line('system', `> Opened ${path}`)],
      consoleTab: 'output',
      watch: emptyWatch({ detail: `Đang chờ phân tích ${path}…` }),
    }));
    analyzer.schedule(code);
  },

  setStdin(value) {
    set({ stdin: value });
  },

  setConsoleTab(tab) {
    set({ consoleTab: tab });
  },

  appendOutput(kind, text) {
    if (text.length === 0) return;
    set((state) => ({ output: [...state.output, line(kind, text)] }));
  },

  clearOutput() {
    set({ output: [] });
  },

  setCursor(cursor) {
    set({ cursor });
  },

  setEngineId(id) {
    set({ engineId: id });
    analyzer.schedule(get().code);
  },

  setRightPercent(percent) {
    set({ rightPercent: clamp(percent, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT) });
  },

  setBottomPercent(percent) {
    set({ bottomPercent: clamp(percent, MIN_BOTTOM_PERCENT, MAX_BOTTOM_PERCENT) });
  },

  async run() {
    if (get().runState === 'running') return;

    const engine = getEngine(get().engineId);
    const controller = new AbortController();
    runController = controller;

    set({
      runState: 'running',
      output: [line('system', `> Build and run with ${engine.label}`)],
      consoleTab: 'output',
    });

    const startedAt = Date.now();

    try {
      const state = get();
      const outcome = await engine.run(
        { code: state.code, file: state.path },
        state.stdin,
        {
          stdout: (chunk) => get().appendOutput('stdout', chunk),
          stderr: (chunk) => get().appendOutput('stderr', chunk),
          watch: (snapshot) => set({ watch: snapshot }),
        },
        controller.signal,
      );

      const elapsed = Date.now() - startedAt;
      set((state) => ({
        watch: {
          ...state.watch,
          engine: state.watch.engine ?? engine.id,
          engineLabel: engine.label,
          status: outcome.status,
          detail: outcome.detail,
          diagnostics: outcome.diagnostics.length > 0 ? outcome.diagnostics : state.watch.diagnostics,
        },
        consoleTab: outcome.status === 'compile-error' ? 'problems' : state.consoleTab,
      }));

      if (outcome.detail) get().appendOutput('system', outcome.detail);
      get().appendOutput(
        'system',
        `> Finished in ${elapsed} ms${outcome.exitCode === null ? '' : ` · exit code ${outcome.exitCode}`}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().appendOutput('stderr', `Internal error: ${message}`);
    } finally {
      if (runController === controller) runController = null;
      set({ runState: 'idle' });
    }
  },

  stop() {
    if (!runController) return;
    runController.abort();
    runController = null;
    set({ runState: 'idle' });
    get().appendOutput('system', '> Stopped by user');
  },
}));

/**
 * Realtime analysis pipeline: 1s debounce, in-flight pass aborted on new input.
 * Wired in M0 so the timing contract is real from the start; the engine behind
 * it answers `unsupported` until M1-M3 land.
 */
const analyzer = new DebouncedAnalyzer({
  delayMs: ANALYSIS_DEBOUNCE_MS,
  analyze: async (code, signal) => {
    const { engineId, path } = useAppStore.getState();
    const engine = getEngine(engineId);
    const snapshot = await engine.watch({ code, file: path }, signal);
    if (signal.aborted) return;
    useAppStore.setState({ watch: snapshot });
  },
  onBusyChange: (busy) => {
    useAppStore.setState({ analysisState: busy ? 'analyzing' : 'idle' });
  },
});

/** Forces the pending analysis to run now (used before a run, and in tests). */
export function flushAnalysis(): Promise<void> {
  return analyzer.flush();
}

export function cancelAnalysis(): void {
  analyzer.cancel();
}

useAppStore.subscribe((state, previous) => {
  if (
    state.code !== previous.code ||
    state.stdin !== previous.stdin ||
    state.rightPercent !== previous.rightPercent ||
    state.bottomPercent !== previous.bottomPercent
  ) {
    scheduleWorkspaceSave({
      version: 1,
      code: state.code,
      stdin: state.stdin,
      rightPercent: state.rightPercent,
      bottomPercent: state.bottomPercent,
    });
  }
});
