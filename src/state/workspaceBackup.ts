/**
 * Backing the workspace up to a file, and reading one back.
 *
 * The trash protects against mistakes inside the app, but nothing in the app can
 * protect against the browser dropping its storage: clearing site data, eviction
 * under disk pressure, or a private window. A file on the user's disk is the only
 * copy that survives all of those, so the workspace can be written out as JSON and
 * read back in.
 *
 * Kept free of the DOM and of the store: the caller supplies the text, so the
 * format and its limits are unit tested directly.
 */

import type { StoredFile, TrashedFile } from '@/state/fileStore';
import { languageForPath, validateFileName } from '@/state/fileStore';

export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = '.json';

/** Generous but bounded: a backup is not a way to wedge the browser. */
const MAX_BACKUP_FILES = 200;
const MAX_BACKUP_CODE = 4 * 1024 * 1024;

export interface WorkspaceBackup {
  readonly version: 1;
  readonly exportedAt: number;
  readonly files: readonly { readonly path: string; readonly code: string }[];
  readonly trash?: readonly { readonly path: string; readonly code: string }[];
}

export function workspaceToJson(
  files: readonly StoredFile[],
  trash: readonly TrashedFile[] = [],
  now = Date.now(),
): string {
  const backup: WorkspaceBackup = {
    version: BACKUP_VERSION,
    exportedAt: now,
    files: files.map((file) => ({ path: file.path, code: file.code })),
    ...(trash.length > 0
      ? { trash: trash.map((entry) => ({ path: entry.path, code: entry.code })) }
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
  readonly files: readonly { readonly path: string; readonly code: string }[];
  readonly trash: readonly { readonly path: string; readonly code: string }[];
  /** Files dropped because their names are unusable. */
  readonly skipped: number;
}

export type BackupResult =
  | { readonly ok: true; readonly backup: ParsedBackup }
  | { readonly ok: false; readonly error: string };

function readEntries(value: unknown): { entries: { path: string; code: string }[]; skipped: number } {
  if (!Array.isArray(value)) return { entries: [], skipped: 0 };

  const entries: { path: string; code: string }[] = [];
  let skipped = 0;
  let total = 0;

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
    total += candidate.code.length;
    if (total > MAX_BACKUP_CODE || entries.length >= MAX_BACKUP_FILES) {
      skipped += 1;
      continue;
    }
    entries.push({ path: candidate.path, code: candidate.code });
  }

  return { entries, skipped };
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

  const candidate = parsed as { version?: unknown; files?: unknown; trash?: unknown };
  if (candidate.version !== BACKUP_VERSION) {
    return { ok: false, error: `phiên bản backup không hỗ trợ (${String(candidate.version)})` };
  }

  const files = readEntries(candidate.files);
  const trash = readEntries(candidate.trash);
  // A backup of nothing but trashed files is legitimate; an empty one is not.
  if (files.entries.length === 0 && trash.entries.length === 0) {
    return { ok: false, error: 'backup không có file nào dùng được' };
  }

  return {
    ok: true,
    backup: { files: files.entries, trash: trash.entries, skipped: files.skipped + trash.skipped },
  };
}

/**
 * Adds the backup's files to what is already there.
 *
 * Import never replaces: like a share link, the incoming files are added and any
 * name clash is resolved with a free one, so restoring a backup cannot destroy the
 * workspace you are currently in.
 */
export function mergeBackup(
  backup: ParsedBackup,
  makeId: (index: number) => string,
  uniquePathFor: (path: string) => string,
  now = Date.now(),
): StoredFile[] {
  return backup.files.map((file, index) => {
    const path = uniquePathFor(file.path);
    return {
      id: makeId(index),
      path,
      language: languageForPath(path),
      code: file.code,
      updatedAt: now,
    };
  });
}
