/**
 * Workspace persistence (code, stdin, pane geometry).
 *
 * Only small, user-authored state is stored. Console output and watch snapshots
 * are deliberately not persisted: they are regenerated and can be large.
 */

import { languageForPath, validTrash } from '@/state/fileStore';
import type { StoredFile, TrashedFile } from '@/state/fileStore';
import { validProjectTrash, validProjects } from '@/state/projectStore';
import type { Project, TrashedProject } from '@/state/projectStore';

const STORAGE_KEY = 'cjit.workspace.v1';
/** The project shape. `v2` below is read once, to migrate from it. */
const FILES_KEY = 'cjit.files.v3';
const LEGACY_FILES_KEY = 'cjit.files.v2';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedWorkspace {
  readonly version: 1;
  readonly code?: string;
  readonly stdin?: string;
  readonly rightPercent?: number;
  readonly bottomPercent?: number;
  readonly explorerWidth?: number;
  readonly fontSize?: number;
  readonly debounceMs?: number;
  readonly minimap?: boolean;
  readonly inlineValues?: boolean;
}

/** What the app now stores: several projects, each with its own files. */
export interface PersistedFiles {
  readonly version: 3;
  readonly projects: readonly Project[];
  readonly activeProjectId: string;
  /** Removed files, kept so deleting or resetting can be undone. */
  readonly trash?: readonly TrashedFile[];
  /** Removed projects, kept whole so deleting one can be undone. */
  readonly projectTrash?: readonly TrashedProject[];
}

/** The shape v2 wrote: one flat file list, which becomes the first project. */
interface LegacyPersistedFiles {
  readonly version?: number;
  readonly files?: readonly StoredFile[];
  readonly activeId?: string;
  readonly trash?: readonly TrashedFile[];
}

/** Narrow slice of the Storage API, so the load path is testable. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function storage(): StorageLike | null {
  return defaultStorage();
}

export function loadWorkspace(): PersistedWorkspace {
  const store = storage();
  if (!store) return { version: 1 };

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { version: 1 };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { version: 1 };
    return { version: 1, ...(parsed as Omit<PersistedWorkspace, 'version'>) };
  } catch {
    return { version: 1 };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: PersistedWorkspace | null = null;

export function scheduleWorkspaceSave(workspace: PersistedWorkspace): void {
  pending = workspace;
  if (saveTimer !== null) return;

  saveTimer = setTimeout(() => {
    saveTimer = null;
    const value = pending;
    pending = null;
    if (value) writeNow(value);
  }, SAVE_DEBOUNCE_MS);
}

export function writeNow(workspace: PersistedWorkspace): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(): void {
  storage()?.removeItem(STORAGE_KEY);
}

// --------------------------------------------------------------- files (v2)

/**
 * Loads the workspace: projects, the trash, and enough migration to never lose code.
 *
 * Three shapes have existed. v1 was a single buffer, v2 a flat file list, and v3 adds
 * projects. Each older one is wrapped into the newer shape rather than discarded -
 * upgrading must never cost someone their work, and a stale key is cheaper than a
 * lost program.
 */
export function loadFilesWorkspace(store: StorageLike | null = storage()): PersistedFiles | null {
  if (!store) return null;

  try {
    const raw = store.getItem(FILES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const candidate = parsed as Partial<PersistedFiles>;

      const projects = validProjects(candidate.projects);
      if (projects.length === 0) return null;

      const activeProjectId =
        typeof candidate.activeProjectId === 'string' &&
        projects.some((project) => project.id === candidate.activeProjectId)
          ? candidate.activeProjectId
          : (projects[0]?.id ?? '');

      return {
        version: 3,
        projects,
        activeProjectId,
        trash: validTrash(candidate.trash),
        projectTrash: validProjectTrash(candidate.projectTrash),
      };
    }

    // v2: the file list *was* the workspace, so it becomes the first project.
    const v2 = store.getItem(LEGACY_FILES_KEY);
    if (v2) {
      const parsed: unknown = JSON.parse(v2);
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = parsed as Partial<LegacyPersistedFiles>;
        const files = Array.isArray(candidate.files) ? candidate.files : [];
        if (files.length > 0) {
          const projects = validProjects([
            { id: 'project-1', name: 'main', files, activeId: candidate.activeId },
          ]);
          if (projects.length > 0) {
            return {
              version: 3,
              projects,
              activeProjectId: projects[0]?.id ?? 'project-1',
              // The old file trash carries over: those files are still the user's.
              trash: validTrash(candidate.trash),
              projectTrash: [],
            };
          }
        }
      }
    }

    const legacy = store.getItem(STORAGE_KEY);
    if (!legacy) return null;

    const parsed: unknown = JSON.parse(legacy);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    if (typeof code !== 'string' || code.length === 0) return null;

    // The extension was not recorded in v1, so it is inferred from the content.
    const path = looksLikeCpp(code) ? 'main.cpp' : 'main.c';
    const files = [
      { id: 'migrated-1', path, language: languageForPath(path), code, updatedAt: Date.now() },
    ];
    return {
      version: 3,
      projects: [{ id: 'project-1', name: 'main', files, activeId: 'migrated-1' }],
      activeProjectId: 'project-1',
      trash: [],
      projectTrash: [],
    };
  } catch {
    return null;
  }
}

function looksLikeCpp(code: string): boolean {
  return (
    code.includes('std::') ||
    code.includes('template') ||
    code.includes('namespace') ||
    code.includes('#include <iostream>') ||
    code.includes('#include <vector>') ||
    code.includes('#include <string>')
  );
}

let filesSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFiles: PersistedFiles | null = null;

export function scheduleFilesSave(workspace: PersistedFiles): void {
  pendingFiles = workspace;
  if (filesSaveTimer !== null) return;

  filesSaveTimer = setTimeout(() => {
    filesSaveTimer = null;
    const value = pendingFiles;
    pendingFiles = null;
    if (value) writeFilesNow(value);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Told once when saving starts failing, and once when it recovers.
 *
 * A full storage quota used to be silent, which is the worst possible behaviour:
 * the app keeps working, so the user keeps typing, and everything is gone on the
 * next reload. The caller turns this into a visible warning.
 */
export type PersistFailureHandler = (message: string | null) => void;

let onPersistFailure: PersistFailureHandler | null = null;
let failing = false;

export function setPersistFailureHandler(handler: PersistFailureHandler | null): void {
  onPersistFailure = handler;
}

function reportPersist(ok: boolean, message: string): void {
  if (ok) {
    if (failing) {
      failing = false;
      onPersistFailure?.(null);
    }
    return;
  }
  if (failing) return;
  failing = true;
  onPersistFailure?.(message);
}

export function writeFilesNow(workspace: PersistedFiles): boolean {
  const store = storage();
  if (!store) {
    reportPersist(false, 'trình duyệt không cho lưu (chế độ riêng tư?) — file chỉ nằm trong tab này');
    return false;
  }

  try {
    store.setItem(FILES_KEY, JSON.stringify(workspace));
    reportPersist(true, '');
    return true;
  } catch {
    reportPersist(
      false,
      'không lưu được workspace (hết dung lượng?) — dùng Share link hoặc tải file về để giữ lại',
    );
    return false;
  }
}

export function clearFilesWorkspace(): void {
  storage()?.removeItem(FILES_KEY);
}
