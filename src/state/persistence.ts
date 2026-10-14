/**
 * Workspace persistence (code, stdin, pane geometry).
 *
 * Only small, user-authored state is stored. Console output and watch snapshots
 * are deliberately not persisted: they are regenerated and can be large.
 */

import { languageForPath } from '@/state/fileStore';
import type { StoredFile } from '@/state/fileStore';

const STORAGE_KEY = 'cjit.workspace.v1';
const FILES_KEY = 'cjit.files.v2';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedWorkspace {
  readonly version: 1;
  readonly code?: string;
  readonly stdin?: string;
  readonly rightPercent?: number;
  readonly bottomPercent?: number;
  readonly explorerWidth?: number;
}

export interface PersistedFiles {
  readonly version: 2;
  readonly files: readonly StoredFile[];
  readonly activeId: string;
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
 * Loads the file workspace, migrating a v1 single-buffer workspace if that is all
 * that exists - otherwise an upgrade would silently discard the user's code.
 */
export function loadFilesWorkspace(store: StorageLike | null = storage()): PersistedFiles | null {
  if (!store) return null;

  try {
    const raw = store.getItem(FILES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const candidate = parsed as Partial<PersistedFiles>;
      const files = Array.isArray(candidate.files) ? candidate.files : [];
      if (files.length === 0) return null;

      const activeId =
        typeof candidate.activeId === 'string' && files.some((file) => file.id === candidate.activeId)
          ? candidate.activeId
          : (files[0]?.id ?? '');
      return { version: 2, files, activeId };
    }

    const legacy = store.getItem(STORAGE_KEY);
    if (!legacy) return null;

    const parsed: unknown = JSON.parse(legacy);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    if (typeof code !== 'string' || code.length === 0) return null;

    // The extension was not recorded in v1, so it is inferred from the content.
    const path = looksLikeCpp(code) ? 'main.cpp' : 'main.c';
    return {
      version: 2,
      files: [{ id: 'migrated-1', path, language: languageForPath(path), code, updatedAt: Date.now() }],
      activeId: 'migrated-1',
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

export function writeFilesNow(workspace: PersistedFiles): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(FILES_KEY, JSON.stringify(workspace));
    return true;
  } catch {
    // Quota exceeded: stop pretending it was saved.
    return false;
  }
}

export function clearFilesWorkspace(): void {
  storage()?.removeItem(FILES_KEY);
}
