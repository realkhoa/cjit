/**
 * Backing the workspace up to a file, and reading one back.
 *
 * The trash protects against mistakes inside the app, but nothing in the app can
 * protect against the browser dropping its storage: clearing site data, eviction
 * under disk pressure, or a private window. A file on the user's disk is the only
 * copy that survives all of those.
 *
 * Format 2 carries projects. Format 1 - a flat file list, written before projects
 * existed - is still read, as one project, because refusing an old backup is the same
 * as losing it. Kept free of the DOM and of the store, so the format and its limits
 * are tested directly.
 */

import type { StoredFile, TrashedFile } from '@/state/fileStore';
import { validateFileName } from '@/state/fileStore';
import type { Project, TrashedProject } from '@/state/projectStore';
import { validateProjectName } from '@/state/projectStore';

export const BACKUP_VERSION = 2;
export const BACKUP_EXTENSION = '.json';

/** Generous but bounded: a backup is not a way to wedge the browser. */
const MAX_BACKUP_PROJECTS = 40;
const MAX_BACKUP_FILES = 400;
const MAX_BACKUP_CODE = 8 * 1024 * 1024;

export interface BackupFile {
  readonly path: string;
  readonly code: string;
}

export interface BackupProject {
  readonly name: string;
  readonly files: readonly BackupFile[];
}

export interface WorkspaceBackup {
  readonly version: 2;
  readonly exportedAt: number;
  readonly projects: readonly BackupProject[];
  readonly trash?: readonly BackupFile[];
  readonly projectTrash?: readonly BackupProject[];
}

export function workspaceToJson(
  projects: readonly Project[],
  trash: readonly TrashedFile[] = [],
  projectTrash: readonly TrashedProject[] = [],
  now = Date.now(),
): string {
  const backup: WorkspaceBackup = {
    version: BACKUP_VERSION,
    exportedAt: now,
    projects: projects.map((project) => ({
      name: project.name,
      files: project.files.map((file) => ({ path: file.path, code: file.code })),
    })),
    ...(trash.length > 0 ? { trash: trash.map((file) => ({ path: file.path, code: file.code })) } : {}),
    ...(projectTrash.length > 0
      ? {
          projectTrash: projectTrash.map((project) => ({
            name: project.name,
            files: project.files.map((file) => ({ path: file.path, code: file.code })),
          })),
        }
      : {}),
  };
  return JSON.stringify(backup, null, 2);
}

/** `cjit-workspace-2026-02-14.json`, so several backups can sit side by side. */
export function backupFileName(now = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `cjit-workspace-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${BACKUP_EXTENSION}`;
}

export interface ParsedBackup {
  readonly projects: readonly BackupProject[];
  readonly trash: readonly BackupFile[];
  /** Entries dropped because they were unusable. */
  readonly skipped: number;
}

export type BackupResult =
  | { readonly ok: true; readonly backup: ParsedBackup }
  | { readonly ok: false; readonly error: string };

function readFiles(value: unknown, budget: { left: number }): { files: BackupFile[]; skipped: number } {
  if (!Array.isArray(value)) return { files: [], skipped: 0 };

  const files: BackupFile[] = [];
  let skipped = 0;

  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      skipped += 1;
      continue;
    }
    const candidate = item as { path?: unknown; code?: unknown };
    if (typeof candidate.path !== 'string' || typeof candidate.code !== 'string') {
      skipped += 1;
      continue;
    }
    // A backup can come from anywhere, so names are validated like any other input.
    if (validateFileName(candidate.path) !== undefined) {
      skipped += 1;
      continue;
    }
    if (candidate.code.length > budget.left || files.length >= MAX_BACKUP_FILES) {
      skipped += 1;
      continue;
    }

    budget.left -= candidate.code.length;
    files.push({ path: candidate.path, code: candidate.code });
  }

  return { files, skipped };
}

function readProjects(
  value: unknown,
  budget: { left: number },
): { projects: BackupProject[]; skipped: number } {
  if (!Array.isArray(value)) return { projects: [], skipped: 0 };

  const projects: BackupProject[] = [];
  let skipped = 0;

  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      skipped += 1;
      continue;
    }
    const candidate = item as { name?: unknown; files?: unknown };
    const read = readFiles(candidate.files, budget);
    skipped += read.skipped;
    if (read.files.length === 0) {
      skipped += 1;
      continue;
    }

    const wanted = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const name = validateProjectName(wanted) === undefined && wanted.length > 0 ? wanted : 'imported';
    projects.push({ name, files: read.files });
    if (projects.length >= MAX_BACKUP_PROJECTS) break;
  }

  return { projects, skipped };
}

export function parseWorkspaceJson(text: string): BackupResult {
  if (text.trim().length === 0) return { ok: false, error: 'file rỗng' };
  if (text.length > MAX_BACKUP_CODE * 2) return { ok: false, error: 'file quá lớn' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'không phải JSON hợp lệ' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'nội dung không phải một workspace' };
  }

  const candidate = parsed as {
    version?: unknown;
    projects?: unknown;
    files?: unknown;
    trash?: unknown;
    projectTrash?: unknown;
  };

  const budget = { left: MAX_BACKUP_CODE };

  // Format 1: a flat file list, which becomes one project named `imported`.
  if (candidate.version === 1 || (candidate.version === undefined && Array.isArray(candidate.files))) {
    const files = readFiles(candidate.files, budget);
    const trash = readFiles(candidate.trash, budget);
    if (files.files.length === 0) {
      return { ok: false, error: 'backup không có file nào dùng được' };
    }
    return {
      ok: true,
      backup: {
        projects: [{ name: 'imported', files: files.files }],
        trash: trash.files,
        skipped: files.skipped + trash.skipped,
      },
    };
  }

  if (candidate.version !== BACKUP_VERSION) {
    return { ok: false, error: `phiên bản backup không hỗ trợ (${String(candidate.version)})` };
  }

  const projects = readProjects(candidate.projects, budget);
  const trash = readFiles(candidate.trash, budget);
  const projectTrash = readProjects(candidate.projectTrash, budget);

  // A backup of nothing but trashed work is legitimate; an empty one is not.
  if (projects.projects.length === 0 && projectTrash.projects.length === 0) {
    return { ok: false, error: 'backup không có project nào dùng được' };
  }

  return {
    ok: true,
    backup: {
      projects: projects.projects,
      trash: trash.files,
      skipped: projects.skipped + trash.skipped + projectTrash.skipped,
    },
  };
}

/** Files from a restored project, renamed to avoid the ones already here. */
export function mergeBackupFiles(
  backup: BackupProject,
  makeId: (index: number) => string,
  uniquePathFor: (path: string) => string,
  languageFor: (path: string) => StoredFile['language'],
  now = Date.now(),
): StoredFile[] {
  return backup.files.map((file, index) => {
    const path = uniquePathFor(file.path);
    return {
      id: makeId(index),
      path,
      language: languageFor(path),
      code: file.code,
      updatedAt: now,
    };
  });
}
