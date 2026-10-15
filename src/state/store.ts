import { create } from 'zustand';
import { DEFAULT_EXAMPLE } from '@/examples/sample';
import { getEngine, isEngineWired } from '@/engine/registry';
import type { EngineId, SourceFile, WatchSnapshot } from '@/engine/types';
import type { ArtifactKind } from '@/engine/types';
import { emptyWatch } from '@/engine/types';
import { DebouncedAnalyzer } from '@/state/analyzeController';
import {
  createFile as createStoredFile,
  findFile,
  initialWorkspace,
  languageForPath,
  renameFile,
  restoreTrashed as restoreTrashedFile,
  trashAll,
  trashFile,
  uniquePath,
  updateFileCode,
} from '@/state/fileStore';
import type { FileLanguage, FilesWorkspace, StoredFile, TrashedFile } from '@/state/fileStore';
import {
  clearFilesWorkspace,
  loadFilesWorkspace,
  loadWorkspace,
  scheduleFilesSave,
  scheduleWorkspaceSave,
  setPersistFailureHandler,
} from '@/state/persistence';
import { clampDebounce, clampFontSize, settingsFrom } from '@/state/settings';
import type { EditorSettings } from '@/state/settings';
import { isMobileViewport } from '@/ui/responsive';
import type { PaneId } from '@/ui/responsive';
import {
  clampTimelineIndex,
  entryIndexFor,
  isTimelineAtEnd,
  stepTimeline,
} from '@/ui/timeline';
import type { WatchMode } from '@/ui/watchSelect';
import {
  decodeShare,
  encodeShare,
  readShareFromHash,
  shareUrlFor,
  toSharePayload,
  workspaceFromShare,
} from '@/state/share';
import { formatBytes, saveBytes } from '@/util/download';
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
export type ConsoleTab = 'output' | 'problems' | 'runtime' | 'stdin';
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
  /** Editor and analysis preferences, persisted with the workspace. */
  readonly settings: EditorSettings;
  /**
   * Which pane the narrow layout shows. Not persisted: on a phone the pane you
   * want depends on what you are doing right now, not on last week's session.
   */
  readonly mobilePane: PaneId;
  /**
   * Files that were deleted or cleared by Reset, kept until the user empties the
   * trash. Nothing is destroyed by accident.
   */
  readonly trash: readonly TrashedFile[];
  /** Set when the browser refuses to save, so the user is warned before losing work. */
  readonly storageWarning: string | null;
  /**
   * Which moment the Watch pane is showing. It lives here rather than inside the
   * pane because the editor highlights the line that moment came from, so both
   * have to agree on it.
   */
  readonly watchMode: WatchMode;
  readonly timelineIndex: number;
  /** Playing walks the recorded moments on its own, and stops at the end. */
  readonly timelinePlaying: boolean;
  /** True when the last Run produced files that can be saved. */
  readonly artifactsReady: boolean;

  /** Saves what the last compiler run produced (`.wasm` / `.o`). */
  downloadArtifact(which: ArtifactKind): Promise<void>;

  setMobilePane(pane: PaneId): void;
  setWatchMode(mode: WatchMode): void;
  setTimelineIndex(index: number): void;
  /** Moves `delta` recorded moments; enters timeline mode if it was not already. */
  stepTimeline(delta: number): void;
  setTimelinePlaying(playing: boolean): void;
  toggleTimelinePlayback(): void;
  setCodeFromEditor(code: string): void;
  /**
   * Opens a sample as a new file. Deliberately not "load into the current file":
   * replacing the open buffer is how a toolbar click used to wipe someone's work.
   */
  openExample(path: string, language: FileLanguage, code: string): void;
  createFile(): void;
  openFile(id: string): void;
  renameActiveFile(path: string): RenameOutcome;
  deleteActiveFile(): void;
  /** Brings a trashed file back under a free name. */
  restoreTrashed(id: string): void;
  emptyTrash(): void;
  resetWorkspace(): void;
  shareLink(): Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Loads a workspace out of the URL fragment; true when one was found. */
  loadSharedWorkspace(): Promise<boolean>;
  setStdin(value: string): void;
  setConsoleTab(tab: ConsoleTab): void;
  appendOutput(kind: OutputKind, text: string): void;
  clearOutput(): void;
  setCursor(cursor: CursorInfo): void;
  toggleInlineValues(): void;
  setFontSize(size: number): void;
  setDebounceMs(value: number): void;
  toggleMinimap(): void;
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
function initialFiles(): FilesWorkspace & { readonly trash: readonly TrashedFile[] } {
  const stored = loadFilesWorkspace();
  if (stored) return { ...stored, trash: stored.trash ?? [] };
  return {
    ...initialWorkspace('file-1', Date.now(), {
      path: DEFAULT_EXAMPLE.path,
      code: DEFAULT_EXAMPLE.code,
    }),
    trash: [],
  };
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

/** Turns the workspace files into what the preprocessor expects, if there are any. */
function workspaceFiles(state: AppState): readonly SourceFile[] {
  return state.files
    .filter((file) => file.id !== state.activeFileId)
    .map((file) => ({ path: file.path, code: file.code }));
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
  settings: settingsFrom(persisted),
  mobilePane: 'code',
  trash: startFiles.trash,
  storageWarning: null,
  watchMode: 'cursor',
  timelineIndex: 0,
  timelinePlaying: false,
  artifactsReady: false,

  setCodeFromEditor(code) {
    const { files, activeFileId } = get();
    set({ code, files: updateFileCode(files, activeFileId, code, Date.now()) });
    analyzer.schedule(code);
  },

  openExample(path, language, code) {
    /*
     * Opens the example as a NEW file, never by writing over the one that is open.
     *
     * The old version replaced the active file's path and contents, so picking an
     * example from the toolbar silently destroyed whatever the user had written -
     * no confirmation, no undo. Opening a file cannot lose work, whether or not
     * the example is ever offered in the UI again.
     */
    const { files } = get();
    const created = createStoredFile(files, {
      id: nextFileId(),
      now: Date.now(),
      path,
      code,
    });
    const opened =
      created.language === language ? created : { ...created, language, path: created.path };
    const next = [...files, opened];

    set((state) => ({
      files: next,
      activeFileId: opened.id,
      ...derived(next, opened.id),
      codeRevision: state.codeRevision + 1,
      output: [line('system', `> Opened ${opened.path} as a new file`)],
      consoleTab: 'output',
      watch: emptyWatch({ detail: `Đang chờ phân tích ${opened.path}…` }),
    }));
    analyzer.schedule(opened.code);
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
    const { files, activeFileId, trash } = get();
    // The last file is never removed: an empty workspace has nothing to type in.
    if (files.length <= 1) return;

    // Into the trash, not into oblivion: deleting is undoable from the Explorer.
    const moved = trashFile(files, trash, activeFileId, Date.now());
    const nextActive = moved.files[0]?.id ?? '';

    set((state) => ({
      files: moved.files,
      trash: moved.trash,
      activeFileId: nextActive,
      ...derived(moved.files, nextActive),
      codeRevision: state.codeRevision + 1,
      output: [
        line('system', '> Đã chuyển file vào Trash (mở Explorer để lấy lại nếu cần)'),
      ],
    }));
    analyzer.schedule(get().code);
  },

  restoreTrashed(id) {
    const { files, trash } = get();
    const result = restoreTrashedFile(files, trash, id, Date.now());
    const restored = result.restored;
    if (!restored) return;

    set((state) => ({
      files: result.files,
      trash: result.trash,
      activeFileId: restored.id,
      ...derived(result.files, restored.id),
      codeRevision: state.codeRevision + 1,
      output: [line('system', `> Đã lấy lại ${restored.path} từ Trash`)],
    }));
    analyzer.schedule(get().code);
  },

  emptyTrash() {
    // The only action that really destroys anything, and it says so first.
    set({ trash: [] });
  },

  resetWorkspace() {
    const { files, trash } = get();

    // Forget what the browser stored, or a reload would bring it back - but keep
    // the files themselves in the trash, so Reset is undoable too.
    clearFilesWorkspace();

    const kept = trashAll(files, trash, Date.now());
    const fresh = initialWorkspace(nextFileId(), Date.now(), {
      path: DEFAULT_EXAMPLE.path,
      code: DEFAULT_EXAMPLE.code,
    });
    set((state) => ({
      files: fresh.files,
      trash: kept,
      activeFileId: fresh.activeId,
      ...derived(fresh.files, fresh.activeId),
      codeRevision: state.codeRevision + 1,
      output: [
        line('system', `> Workspace reset — ${files.length} file cũ vẫn nằm trong Trash (Explorer)`),
      ],
      consoleTab: 'output',
    }));
    analyzer.schedule(get().code);
  },

  async shareLink() {
    const { files, activeFileId } = get();
    const encoded = await encodeShare(toSharePayload({ files, activeId: activeFileId }));

    const base =
      typeof window === 'undefined'
        ? 'https://example.invalid/'
        : `${window.location.origin}${window.location.pathname}`;
    const url = shareUrlFor(base, encoded);

    // A URL longer than this is not pasteable anywhere useful; say so instead of
    // handing over a link that will be truncated.
    if (url.length > 60_000) {
      get().appendOutput(
        'system',
        `> Link chia sẻ quá dài (${url.length.toLocaleString()} ký tự) — chia sẻ ít file hơn hoặc dùng file ngắn hơn`,
      );
      return { ok: false, error: 'link too long', url };
    }

    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }

    get().appendOutput(
      'system',
      copied
        ? `> Đã copy link chia sẻ (${url.length.toLocaleString()} ký tự)`
        : `> Link chia sẻ (copy tay): ${url}`,
    );
    return { ok: true, url };
  },

  async loadSharedWorkspace() {
    if (typeof window === 'undefined') return false;

    const encoded = readShareFromHash(window.location.hash);
    if (!encoded) return false;

    const payload = await decodeShare(encoded);
    if (!payload) {
      get().appendOutput('stderr', '> Link chia sẻ không đọc được (hỏng hoặc quá lớn)');
      return false;
    }

    const shared = workspaceFromShare(
      payload,
      (index) => `shared-${Date.now().toString(36)}-${index}`,
      Date.now(),
    );

    /*
     * Added to the workspace, not swapped in for it.
     *
     * Opening a link should not be a way to lose the files already here: the shared
     * ones arrive as further files (names that clash get a free one) and the first
     * of them is opened. Deleting the old files stays a deliberate act.
     */
    const existing = get().files;
    const incoming = shared.files.map((file) => {
      const path = uniquePath([...existing, ...[]], file.path);
      return { ...file, path, language: languageForPath(path) };
    });
    const merged = [...existing, ...incoming];
    const opened = merged.find((file) => file.id === incoming[0]?.id) ?? merged[0];

    set((state) => ({
      files: merged,
      activeFileId: opened?.id ?? state.activeFileId,
      ...derived(merged, opened?.id ?? state.activeFileId),
      codeRevision: state.codeRevision + 1,
      output: [
        line(
          'system',
          `> Đã thêm ${incoming.length} file từ link chia sẻ (giữ nguyên ${existing.length} file đang có)`,
        ),
      ],
      consoleTab: 'output',
    }));
    analyzer.schedule(get().code);
    return true;
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

  setMobilePane(pane) {
    set({ mobilePane: pane });
  },

  setWatchMode(mode) {
    set({ watchMode: mode });
  },

  setTimelineIndex(index) {
    // The history shrinks when the code changes, so the index is clamped here as
    // well as when it is read.
    set({ timelineIndex: clampTimelineIndex(get().watch.history.length, index) });
  },

  stepTimeline(delta) {
    const { watch, watchMode, timelineIndex } = get();
    const historyLength = watch.history.length;

    // Entering the timeline by stepping: forward starts at the beginning (walking
    // the run), backward starts at the end (walking back from what just happened).
    const from =
      watchMode === 'timeline' ? timelineIndex : entryIndexFor(historyLength, delta);

    set({
      watchMode: 'timeline',
      timelineIndex: stepTimeline(historyLength, from, delta),
    });
  },

  setTimelinePlaying(playing) {
    set({ timelinePlaying: playing });
  },

  async downloadArtifact(which) {
    const state = get();
    const engine = isEngineWired(state.engineId)
      ? getEngine(state.engineId)
      : getEngine(WATCH_ENGINE_ID);

    if (!engine.saveArtifact) {
      get().appendOutput(
        'system',
        `> ${engine.id} không tạo ra file để tải — chỉ engine biên dịch thật (clang + lld) mới sinh .wasm/.o`,
      );
      return;
    }

    const result = await engine.saveArtifact(
      { code: state.code, file: state.path, files: workspaceFiles(state) },
      which,
      saveBytes,
    );

    if (!result.ok) {
      get().appendOutput('system', `> Không tải được ${which}: ${result.error ?? 'unknown error'}`);
      return;
    }

    get().appendOutput(
      'system',
      `> Đã tải ${result.name} (${formatBytes(result.byteLength ?? 0)})`,
    );
  },

  toggleTimelinePlayback() {
    const { timelinePlaying, watch, timelineIndex } = get();
    if (timelinePlaying) {
      set({ timelinePlaying: false });
      return;
    }

    const historyLength = watch.history.length;
    if (historyLength === 0) return;

    set({
      watchMode: 'timeline',
      timelinePlaying: true,
      // Playing from the end would end immediately, so replay from the start.
      timelineIndex: isTimelineAtEnd(historyLength, timelineIndex) ? 0 : timelineIndex,
    });
  },

  toggleInlineValues() {
    set((state) => ({
      settings: { ...state.settings, inlineValues: !state.settings.inlineValues },
    }));
  },

  setFontSize(size) {
    set((state) => ({ settings: { ...state.settings, fontSize: clampFontSize(size) } }));
  },

  setDebounceMs(value) {
    const debounceMs = clampDebounce(value);
    analyzer.setDelay(debounceMs);
    set((state) => ({ settings: { ...state.settings, debounceMs } }));
  },

  toggleMinimap() {
    set((state) => ({ settings: { ...state.settings, minimap: !state.settings.minimap } }));
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
      // On a phone the console is a separate pane; running is a request to see
      // the result, so show it.
      ...(isMobileViewport() ? { mobilePane: 'console' as const } : {}),
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
      let outcome = await engine.run(
        { code: state.code, file: state.path, files: workspaceFiles(state) },
        state.stdin,
        {
          stdout: (chunk) => get().appendOutput('stdout', chunk),
          stderr: (chunk) => get().appendOutput('stderr', chunk),
          watch: (snapshot) => set({ watch: snapshot }),
        },
        controller.signal,
      );

      // Clang could not run at all (toolchain not downloaded, or a blocked
      // worker). Run still works: fall back to the fast engine and say so.
      if (engine.id !== WATCH_ENGINE_ID && outcome.status === 'unsupported' && !controller.signal.aborted) {
        const fallback = getEngine(WATCH_ENGINE_ID);
        get().appendOutput(
          'system',
          `> ${engine.id} (${engine.label}) không chạy được: ${outcome.detail} → chạy bằng ${fallback.id}`,
        );
        outcome = await fallback.run(
          { code: state.code, file: state.path, files: workspaceFiles(state) },
          state.stdin,
          {
            stdout: (chunk) => get().appendOutput('stdout', chunk),
            stderr: (chunk) => get().appendOutput('stderr', chunk),
            watch: (snapshot) => set({ watch: snapshot }),
          },
          controller.signal,
        );
      }

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
        // Only a compiler produces files to save, and only if the link succeeded.
        artifactsReady:
          engine.id !== WATCH_ENGINE_ID &&
          (outcome.status === 'ok' || outcome.status === 'runtime-error'),
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
    const state = useAppStore.getState();
    const engine = getEngine(WATCH_ENGINE_ID);
    try {
      const snapshot = await engine.watch(
        { code, file: state.path, files: workspaceFiles(state) },
        signal,
      );
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

/*
 * A browser that refuses to save is the one failure the user cannot see for
 * themselves: the app keeps working, so they keep typing, and everything is gone
 * on the next reload. Surface it instead.
 */
setPersistFailureHandler((message) => {
  useAppStore.setState({ storageWarning: message });
  if (message) {
    useAppStore.getState().appendOutput('stderr', `> ${message}`);
  }
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
    state.activeFileId !== previous.activeFileId ||
    state.trash !== previous.trash
  ) {
    scheduleFilesSave({
      version: 2,
      files: state.files,
      activeId: state.activeFileId,
      trash: state.trash,
    });
  }

  if (
    state.stdin !== previous.stdin ||
    state.rightPercent !== previous.rightPercent ||
    state.bottomPercent !== previous.bottomPercent ||
    state.explorerWidth !== previous.explorerWidth ||
    state.settings !== previous.settings
  ) {
    // v1 now only carries layout, stdin and settings; the code lives in v2.
    scheduleWorkspaceSave({
      version: 1,
      stdin: state.stdin,
      rightPercent: state.rightPercent,
      bottomPercent: state.bottomPercent,
      explorerWidth: state.explorerWidth,
      fontSize: state.settings.fontSize,
      debounceMs: state.settings.debounceMs,
      minimap: state.settings.minimap,
      inlineValues: state.settings.inlineValues,
    });
  }
});
