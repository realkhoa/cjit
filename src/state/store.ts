import { create } from 'zustand';
import { DEFAULT_EXAMPLE } from '@/examples/sample';
import { getEngine, isEngineWired } from '@/engine/registry';
import type { EngineId, WatchSnapshot } from '@/engine/types';
import { emptyWatch } from '@/engine/types';
import { DebouncedAnalyzer } from '@/state/analyzeController';
import {
  createFile as createStoredFile,
  findFile,
  initialWorkspace,
  removeFile,
  renameFile,
  updateFileCode,
} from '@/state/fileStore';
import type { FileLanguage, FilesWorkspace, StoredFile } from '@/state/fileStore';
import {
  loadFilesWorkspace,
  loadWorkspace,
  scheduleFilesSave,
  scheduleWorkspaceSave,
} from '@/state/persistence';
import {
  DEFAULT_BOTTOM_PERCENT,
  DEFAULT_EXPLORER_WIDTH,
  DEFAULT_RIGHT_PERCENT,
  MAX_BOTTOM_PERCENT,
  MAX_EXPLORER_WIDTH,
  MAX_RIGHT_PERCENT,
  MIN_BOTTOM_PERCENT,
  MIN_EXPLORER_WIDTH,
  MIN_RIGHT_PERCENT,
  clamp,
} from '@/util/layout';

/** The realtime watch pane refreshes this long after the last keystroke. */
export const ANALYSIS_DEBOUNCE_MS = 1000;

/**
 * The watch pane is always served by the fast engine.
 *
 * That is not a preference: a real clang+lld build cannot run once per second,
 * so the realtime pane has exactly one possible engine. `engineId` below is the
 * engine used by Run.
 */
export const WATCH_ENGINE_ID: EngineId = 'fast';

/** Run prefers the real compiler (M7); today it falls back to fast, and says so. */
export const PREFERRED_RUN_ENGINE_ID: EngineId = 'clang-wasm';

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

export interface RenameOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export interface AppState {
  /**
   * The workspace's files. `path`/`language`/`code` below are mirrors of the
   * active file, kept so the editor, engine and status bar do not have to know
   * about the file list.
   */
  readonly files: readonly StoredFile[];
  readonly activeFileId: string;
  readonly path: string;
  readonly language: FileLanguage;
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
  readonly explorerWidth: number;
  readonly cursor: CursorInfo;
  /** Show inline value overlays after each executed line. */
  readonly inlineValues: boolean;

  setCodeFromEditor(code: string): void;
  loadExample(path: string, language: FileLanguage, code: string): void;
  createFile(): void;
  openFile(id: string): void;
  renameActiveFile(path: string): RenameOutcome;
  deleteActiveFile(): void;
  setStdin(value: string): void;
  setConsoleTab(tab: ConsoleTab): void;
  appendOutput(kind: OutputKind, text: string): void;
  clearOutput(): void;
  setCursor(cursor: CursorInfo): void;
  toggleInlineValues(): void;
  setEngineId(id: EngineId): void;
  setRightPercent(percent: number): void;
  setBottomPercent(percent: number): void;
  setExplorerWidth(width: number): void;
  run(): Promise<void>;
  stop(): void;
}

const persisted = loadWorkspace();

let outputSeq = 0;
let runController: AbortController | null = null;
let fileSeq = 0;

function line(kind: OutputKind, text: string): OutputLine {
  outputSeq += 1;
  return { id: outputSeq, kind, text };
}

function nextFileId(): string {
  fileSeq += 1;
  return `file-${Date.now().toString(36)}-${fileSeq}`;
}

/** The workspace to start from: what the browser stored, or a fresh one. */
function initialFiles(): FilesWorkspace {
  const stored = loadFilesWorkspace();
  if (stored) return stored;
  return initialWorkspace('file-1', Date.now(), {
    path: DEFAULT_EXAMPLE.path,
    code: DEFAULT_EXAMPLE.code,
  });
}

function derived(
  files: readonly StoredFile[],
  activeId: string,
): { path: string; language: FileLanguage; code: string } {
  const file = findFile(files, activeId) ?? files[0];
  return {
    path: file?.path ?? DEFAULT_EXAMPLE.path,
    language: file?.language ?? DEFAULT_EXAMPLE.language,
    code: file?.code ?? '',
  };
}

const startFiles = initialFiles();

export const useAppStore = create<AppState>()((set, get) => ({
  files: startFiles.files,
  activeFileId: startFiles.activeId,
  ...derived(startFiles.files, startFiles.activeId),
  codeRevision: 0,
  stdin: persisted.stdin ?? '',
  engineId: PREFERRED_RUN_ENGINE_ID,
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
  explorerWidth: clamp(
    persisted.explorerWidth ?? DEFAULT_EXPLORER_WIDTH,
    MIN_EXPLORER_WIDTH,
    MAX_EXPLORER_WIDTH,
  ),
  cursor: { line: 1, column: 1, selected: 0 },
  inlineValues: true,

  setCodeFromEditor(code) {
    const { files, activeFileId } = get();
    set({ code, files: updateFileCode(files, activeFileId, code, Date.now()) });
    analyzer.schedule(code);
  },

  loadExample(path, language, code) {
    const { files, activeFileId } = get();
    const updated = files.map((file) =>
      file.id === activeFileId
        ? { ...file, path, language, code, updatedAt: Date.now() }
        : file,
    );
    set((state) => ({
      files: updated,
      ...derived(updated, activeFileId),
      codeRevision: state.codeRevision + 1,
      output: [line('system', `> Opened ${path} into ${code.split('\n').length} lines`)],
      consoleTab: 'output',
      watch: emptyWatch({ detail: `Đang chờ phân tích ${path}…` }),
    }));
    analyzer.schedule(code);
  },

  createFile() {
    const { files } = get();
    const created = createStoredFile(files, {
      id: nextFileId(),
      now: Date.now(),
      path: 'untitled.c',
    });
    const next = [...files, created];
    set((state) => ({
      files: next,
      activeFileId: created.id,
      ...derived(next, created.id),
      codeRevision: state.codeRevision + 1,
    }));
    analyzer.schedule(get().code);
  },

  openFile(id) {
    const { files, activeFileId } = get();
    if (id === activeFileId || !findFile(files, id)) return;
    set((state) => ({
      activeFileId: id,
      ...derived(files, id),
      codeRevision: state.codeRevision + 1,
    }));
    analyzer.schedule(get().code);
  },

  renameActiveFile(path) {
    const { files, activeFileId } = get();
    const result = renameFile(files, activeFileId, path, Date.now());
    if (result.error) return { ok: false, error: result.error };
    set((state) => ({
      files: result.files,
      ...derived(result.files, activeFileId),
      codeRevision: state.codeRevision + 1,
    }));
    return { ok: true };
  },

  deleteActiveFile() {
    const { files, activeFileId } = get();
    // The last file is never removed: an empty workspace has nothing to type in.
    if (files.length <= 1) return;

    const remaining = removeFile(files, activeFileId);
    const nextActive = remaining[0]?.id ?? '';
    set((state) => ({
      files: remaining,
      activeFileId: nextActive,
      ...derived(remaining, nextActive),
      codeRevision: state.codeRevision + 1,
    }));
    analyzer.schedule(get().code);
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

  toggleInlineValues() {
    set((state) => ({ inlineValues: !state.inlineValues }));
  },

  setEngineId(id) {
    set({ engineId: id });
  },

  setRightPercent(percent) {
    set({ rightPercent: clamp(percent, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT) });
  },

  setBottomPercent(percent) {
    set({ bottomPercent: clamp(percent, MIN_BOTTOM_PERCENT, MAX_BOTTOM_PERCENT) });
  },

  setExplorerWidth(width) {
    set({ explorerWidth: clamp(width, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH) });
  },

  async run() {
    if (get().runState === 'running') return;

    // Run uses the chosen engine; if it is not implemented yet (clang+lld lands in
    // M7) it falls back to the fast engine **and says so**, rather than pretending
    // the code was compiled by clang.
    const preferred = get().engineId;
    const engine = isEngineWired(preferred) ? getEngine(preferred) : getEngine(WATCH_ENGINE_ID);
    const fellBack = engine.id !== preferred;

    const controller = new AbortController();
    runController = controller;

    set({
      runState: 'running',
      output: [line('system', `> Build and run with ${engine.label}`)],
      consoleTab: 'output',
    });

    if (fellBack) {
      get().appendOutput(
        'system',
        `> ${preferred} chưa được nối (M7) → chạy bằng ${engine.label}`,
      );
    }

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
 * The engine behind it is always the fast one.
 */
const analyzer = new DebouncedAnalyzer({
  delayMs: ANALYSIS_DEBOUNCE_MS,
  analyze: async (code, signal) => {
    const { path } = useAppStore.getState();
    const engine = getEngine(WATCH_ENGINE_ID);
    try {
      const snapshot = await engine.watch({ code, file: path }, signal);
      if (signal.aborted) return;
      useAppStore.setState({ watch: snapshot });
    } catch (error) {
      // An engine crash must be visible, never silent.
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      useAppStore.setState({
        watch: emptyWatch({
          engine: WATCH_ENGINE_ID,
          engineLabel: engine.label,
          status: 'unsupported',
          detail: `engine failed: ${message}`,
        }),
      });
    }
  },
  onBusyChange: (busy) => {
    useAppStore.setState({ analysisState: busy ? 'analyzing' : 'idle' });
  },
});

/** Forces the pending analysis to run now (used before a run, and in tests). */
export function flushAnalysis(): Promise<void> {
  return analyzer.flush();
}

/**
 * Runs the first realtime pass immediately.
 *
 * Without this the watch pane, the inline overlays and the diagnostics stay empty
 * until the user happens to type something - which looks broken on a fresh page.
 */
export async function startInitialAnalysis(): Promise<void> {
  analyzer.schedule(useAppStore.getState().code);
  await analyzer.flush();
}

export function cancelAnalysis(): void {
  analyzer.cancel();
}

useAppStore.subscribe((state, previous) => {
  if (
    state.files !== previous.files ||
    state.activeFileId !== previous.activeFileId
  ) {
    scheduleFilesSave({ version: 2, files: state.files, activeId: state.activeFileId });
  }

  if (
    state.stdin !== previous.stdin ||
    state.rightPercent !== previous.rightPercent ||
    state.bottomPercent !== previous.bottomPercent ||
    state.explorerWidth !== previous.explorerWidth
  ) {
    // v1 now only carries the small layout/stdin state; the code lives in v2.
    scheduleWorkspaceSave({
      version: 1,
      stdin: state.stdin,
      rightPercent: state.rightPercent,
      bottomPercent: state.bottomPercent,
      explorerWidth: state.explorerWidth,
    });
  }
});
