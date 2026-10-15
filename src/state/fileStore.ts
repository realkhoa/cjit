/**
 * The workspace's files, and the pure operations on them.
 *
 * Kept free of both React and `localStorage` so every rule - name validation,
 * unique naming, language from the extension - is unit tested directly.
 */

export type FileLanguage = 'c' | 'cpp';

export interface StoredFile {
  readonly id: string;
  readonly path: string;
  readonly language: FileLanguage;
  readonly code: string;
  readonly updatedAt: number;
}

export interface FilesWorkspace {
  readonly files: readonly StoredFile[];
  readonly activeId: string;
}

/**
 * A file that was removed, kept so removing it can be undone.
 *
 * Deleting and resetting are the only operations that can destroy work, so both
 * put what they remove here instead: nothing leaves the browser until the user
 * empties the trash on purpose.
 */
export interface TrashedFile extends StoredFile {
  readonly deletedAt: number;
}

/** Bounded so a session of deleting cannot fill the storage quota. */
export const MAX_TRASHED_FILES = 20;

/** Newest first, capped. */
export function pushTrashed(
  trash: readonly TrashedFile[],
  entries: readonly TrashedFile[],
): TrashedFile[] {
  return [...entries].reverse().concat(trash).slice(0, MAX_TRASHED_FILES);
}

/** Moves a file out of the workspace and into the trash. */
export function trashFile(
  files: readonly StoredFile[],
  trash: readonly TrashedFile[],
  id: string,
  now: number,
): { readonly files: readonly StoredFile[]; readonly trash: readonly TrashedFile[] } {
  const file = findFile(files, id);
  if (!file) return { files, trash };

  return {
    files: files.filter((candidate) => candidate.id !== id),
    trash: pushTrashed(trash, [{ ...file, deletedAt: now }]),
  };
}

/** Puts everything back (used by Reset, so a reset can be undone too). */
export function trashAll(
  files: readonly StoredFile[],
  trash: readonly TrashedFile[],
  now: number,
): TrashedFile[] {
  // Original order, unlike a single delete: these were all removed at once, so the
  // list reads the way the workspace did.
  const entries = files.map((file) => ({ ...file, deletedAt: now }));
  return [...entries, ...trash].slice(0, MAX_TRASHED_FILES);
}

export interface RestoreResult {
  readonly files: readonly StoredFile[];
  readonly trash: readonly TrashedFile[];
  readonly restored?: StoredFile;
}

/**
 * Brings a trashed file back under a free name.
 *
 * The restored file gets a new id and, if its old name is taken, a numbered one -
 * restoring must never overwrite whatever took its place.
 */
export function restoreTrashed(
  files: readonly StoredFile[],
  trash: readonly TrashedFile[],
  id: string,
  now: number,
): RestoreResult {
  const entry = trash.find((candidate) => candidate.id === id);
  if (!entry) return { files, trash };

  const path = uniquePath(files, entry.path);
  const restored: StoredFile = {
    id: `${entry.id}-restored-${now.toString(36)}`,
    path,
    language: languageForPath(path),
    code: entry.code,
    updatedAt: now,
  };

  return {
    files: [...files, restored],
    trash: trash.filter((candidate) => candidate.id !== id),
    restored,
  };
}

export function validTrash(value: unknown): readonly TrashedFile[] {
  if (!Array.isArray(value)) return [];
  const entries: TrashedFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<TrashedFile>;
    if (typeof candidate.id !== 'string' || typeof candidate.path !== 'string') continue;
    if (typeof candidate.code !== 'string') continue;
    entries.push({
      id: candidate.id,
      path: candidate.path,
      language: candidate.language === 'c' ? 'c' : 'cpp',
      code: candidate.code,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
      deletedAt: typeof candidate.deletedAt === 'number' ? candidate.deletedAt : 0,
    });
    if (entries.length >= MAX_TRASHED_FILES) break;
  }
  return entries;
}

/** Extensions the editor understands, mapped to the language Monaco uses. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, FileLanguage> = new Map([
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['hxx', 'cpp'],
  ['cppm', 'cpp'],
]);

export const MAX_FILE_NAME_LENGTH = 64;
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

export function languageForPath(path: string): FileLanguage {
  return LANGUAGE_BY_EXTENSION.get(extensionOf(path)) ?? 'cpp';
}

/** Human-readable reason the name is rejected, or undefined when it is fine. */
export function validateFileName(path: string): string | undefined {
  const name = path.trim();
  if (name.length === 0) return 'name cannot be empty';
  if (name.length > MAX_FILE_NAME_LENGTH) return `name is longer than ${MAX_FILE_NAME_LENGTH} characters`;
  // The specific rules come before the character pattern, so the message says
  // what is actually wrong instead of "invalid characters".
  if (name.startsWith('/') || name.endsWith('/')) return 'name cannot start or end with /';
  if (name.includes('..')) return 'name cannot contain ..';
  if (name.endsWith('.')) return 'name cannot end with a dot';
  if (!NAME_PATTERN.test(name)) return 'use letters, digits, _ . / + - only';
  if (extensionOf(name) === '') return 'name needs a file extension such as .c or .cpp';
  if (!LANGUAGE_BY_EXTENSION.has(extensionOf(name))) {
    return `unsupported extension .${extensionOf(name)} (use .c, .h, .cpp, .cc, .hpp)`;
  }
  return undefined;
}

function taken(files: readonly StoredFile[], path: string, exceptId?: string): boolean {
  const lower = path.toLowerCase();
  return files.some((file) => file.id !== exceptId && file.path.toLowerCase() === lower);
}

/** `main.c` -> `main2.c` -> `main3.c`, the way an editor would avoid a clash. */
export function uniquePath(files: readonly StoredFile[], desired: string): string {
  if (!taken(files, desired)) return desired;

  const dot = desired.lastIndexOf('.');
  const stem = dot < 0 ? desired : desired.slice(0, dot);
  const extension = dot < 0 ? '' : desired.slice(dot);

  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${stem}${counter}${extension}`;
    if (!taken(files, candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

export function findFile(files: readonly StoredFile[], id: string): StoredFile | undefined {
  return files.find((file) => file.id === id);
}

export interface NewFileOptions {
  readonly id: string;
  readonly now: number;
  readonly path?: string;
  readonly code?: string;
}

export function createFile(
  files: readonly StoredFile[],
  options: NewFileOptions,
): StoredFile {
  const desired = options.path ?? 'untitled.c';
  const path = uniquePath(files, desired);
  return {
    id: options.id,
    path,
    language: languageForPath(path),
    code: options.code ?? defaultCodeFor(path),
    updatedAt: options.now,
  };
}

export function defaultCodeFor(path: string): string {
  if (languageForPath(path) === 'c') {
    return `#include <stdio.h>\n\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n`;
  }
  return `#include <iostream>\n\nint main() {\n    std::cout << "hello\\n";\n    return 0;\n}\n`;
}

export interface RenameResult {
  readonly files: readonly StoredFile[];
  readonly error?: string;
}

export function renameFile(
  files: readonly StoredFile[],
  id: string,
  nextPath: string,
  now: number,
): RenameResult {
  const file = findFile(files, id);
  if (!file) return { files, error: 'file not found' };

  const path = nextPath.trim();
  const invalid = validateFileName(path);
  if (invalid) return { files, error: invalid };
  if (taken(files, path, id)) return { files, error: `${path} already exists` };

  return {
    files: files.map((candidate) =>
      candidate.id === id
        ? { ...candidate, path, language: languageForPath(path), updatedAt: now }
        : candidate,
    ),
  };
}

export function removeFile(files: readonly StoredFile[], id: string): readonly StoredFile[] {
  return files.filter((file) => file.id !== id);
}

export function updateFileCode(
  files: readonly StoredFile[],
  id: string,
  code: string,
  now: number,
): readonly StoredFile[] {
  return files.map((file) => (file.id === id ? { ...file, code, updatedAt: now } : file));
}

/** The workspace shape a fresh browser starts with. */
export function initialWorkspace(
  id: string,
  now: number,
  options: { readonly path?: string; readonly code?: string } = {},
): FilesWorkspace {
  const path = options.path ?? 'main.cpp';
  const file: StoredFile = {
    id,
    path,
    language: languageForPath(path),
    code: options.code ?? defaultCodeFor(path),
    updatedAt: now,
  };
  return { files: [file], activeId: file.id };
}
