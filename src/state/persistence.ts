/**
 * Workspace persistence (code, stdin, pane geometry).
 *
 * Only small, user-authored state is stored. Console output and watch snapshots
 * are deliberately not persisted: they are regenerated and can be large.
 */

const STORAGE_KEY = 'cjit.workspace.v1';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedWorkspace {
  readonly version: 1;
  readonly code?: string;
  readonly stdin?: string;
  readonly rightPercent?: number;
  readonly bottomPercent?: number;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
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
