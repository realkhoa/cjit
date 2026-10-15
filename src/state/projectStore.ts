/**
 * Projects: a workspace holds several, each with its own files.
 *
 * Until now the workspace *was* the file list, so everything a user wrote lived in one
 * flat project. This layer adds the missing level without touching how files work -
 * a project is a name plus what the file layer already had - which is what keeps the
 * migration from the old shape lossless: the old file list simply becomes project one.
 *
 * Pure, so the rules (a workspace always has a project, deleting is recoverable,
 * names are unique) are tested directly.
 */

import type { StoredFile } from '@/state/fileStore';
import { languageForPath, uniquePath, validateFileName } from '@/state/fileStore';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly files: readonly StoredFile[];
  /** The file that is open when this project is the active one. */
  readonly activeId: string;
}

export interface ProjectWorkspace {
  readonly projects: readonly Project[];
  readonly activeProjectId: string;
}

/** A project that was deleted, kept so deleting it can be undone. */
export interface TrashedProject extends Project {
  readonly deletedAt: number;
}

/** Bounded, like the file trash: a session of deleting cannot fill the quota. */
export const MAX_TRASHED_PROJECTS = 10;
export const MAX_PROJECTS = 20;
export const MAX_PROJECT_NAME_LENGTH = 40;

/**
 * A project name is shown, never used to build a path, so it may be Vietnamese or
 * anything else a person would type - only the characters that would confuse a name
 * with a path (or a control character) are refused.
 */
const PROJECT_NAME_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .+-]*$/u;

/** Human-readable reason a project name is rejected, or undefined when it is fine. */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'tên project không được để trống';
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    return `tên project dài hơn ${MAX_PROJECT_NAME_LENGTH} ký tự`;
  }
  if (!PROJECT_NAME_PATTERN.test(trimmed)) {
    return 'tên project không được chứa ký tự đường dẫn (/ \\ : *) hay ký tự điều khiển';
  }
  return undefined;
}

export function findProject(
  projects: readonly Project[],
  id: string,
): Project | undefined {
  return projects.find((project) => project.id === id);
}

export function activeProject(workspace: ProjectWorkspace): Project | undefined {
  return findProject(workspace.projects, workspace.activeProjectId) ?? workspace.projects[0];
}

/** `main`, `main-2`, `main-3`: never the same name twice in one workspace. */
export function uniqueProjectName(
  projects: readonly Project[],
  wanted: string,
  exceptId?: string,
): string {
  const taken = new Set(
    projects.filter((project) => project.id !== exceptId).map((project) => project.name),
  );
  const base = wanted.trim() || 'project';
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** A new project, starting with one file that is a program (so Run works at once). */
export function newProject(
  id: string,
  name: string,
  fileId: string,
  now: number,
  options: { readonly path?: string; readonly code?: string } = {},
): Project {
  const path = options.path ?? 'main.cpp';
  return {
    id,
    name,
    activeId: fileId,
    files: [
      {
        id: fileId,
        path,
        language: languageForPath(path),
        code: options.code ?? defaultProgram(),
        updatedAt: now,
      },
    ],
  };
}

/** The `main.cpp` a brand-new project opens with. */
export function defaultProgram(): string {
  return [
    '#include <iostream>',
    '',
    'int main() {',
    '    std::cout << "hello\\n";',
    '    return 0;',
    '}',
    '',
  ].join('\n');
}

/** Replaces a project in place, preserving its position in the list. */
export function withProject(
  workspace: ProjectWorkspace,
  project: Project,
): ProjectWorkspace {
  const exists = workspace.projects.some((candidate) => candidate.id === project.id);
  return {
    projects: exists
      ? workspace.projects.map((candidate) => (candidate.id === project.id ? project : candidate))
      : [...workspace.projects, project],
    activeProjectId: workspace.activeProjectId,
  };
}

export function switchProject(workspace: ProjectWorkspace, id: string): ProjectWorkspace {
  if (!workspace.projects.some((project) => project.id === id)) return workspace;
  return { ...workspace, activeProjectId: id };
}

export interface ProjectTrashResult {
  readonly workspace: ProjectWorkspace;
  readonly trash: readonly TrashedProject[];
  /** False when the workspace refused: the last project is never removed. */
  readonly removed: boolean;
}

/** Moves a project into the trash. A workspace always keeps at least one. */
export function trashProject(
  workspace: ProjectWorkspace,
  trash: readonly TrashedProject[],
  id: string,
  now: number,
): ProjectTrashResult {
  if (workspace.projects.length <= 1) {
    return { workspace, trash, removed: false };
  }

  const project = findProject(workspace.projects, id);
  if (!project) return { workspace, trash, removed: false };

  const remaining = workspace.projects.filter((candidate) => candidate.id !== id);
  const nextActive =
    workspace.activeProjectId === id ? (remaining[0]?.id ?? '') : workspace.activeProjectId;

  return {
    workspace: { projects: remaining, activeProjectId: nextActive },
    trash: [{ ...project, deletedAt: now }, ...trash].slice(0, MAX_TRASHED_PROJECTS),
    removed: true,
  };
}

export interface ProjectRestoreResult {
  readonly workspace: ProjectWorkspace;
  readonly trash: readonly TrashedProject[];
  readonly restored?: Project;
}

/** Brings a project back, with a free name and its files untouched. */
export function restoreProject(
  workspace: ProjectWorkspace,
  trash: readonly TrashedProject[],
  id: string,
  now: number,
): ProjectRestoreResult {
  const entry = trash.find((candidate) => candidate.id === id);
  if (!entry) return { workspace, trash };

  const name = uniqueProjectName(workspace.projects, entry.name);
  const restored: Project = {
    id: entry.id,
    name,
    files: entry.files,
    activeId: entry.activeId,
  };
  void now;

  return {
    workspace: {
      projects: [...workspace.projects, restored],
      activeProjectId: restored.id,
    },
    trash: trash.filter((candidate) => candidate.id !== id),
    restored,
  };
}

/** Adds a file to a project, giving it a free name rather than overwriting one. */
export function addFileToProject(
  project: Project,
  path: string,
  code: string,
  id: string,
  now: number,
): Project {
  const free = uniquePath(project.files, path);
  return {
    ...project,
    files: [
      ...project.files,
      { id, path: free, language: languageForPath(free), code, updatedAt: now },
    ],
    activeId: id,
  };
}

function readStoredFiles(value: unknown): StoredFile[] {
  if (!Array.isArray(value)) return [];

  const files: StoredFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<StoredFile>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.path !== 'string' ||
      typeof candidate.code !== 'string' ||
      validateFileName(candidate.path) !== undefined
    ) {
      continue;
    }
    files.push({
      id: candidate.id,
      path: candidate.path,
      language:
        candidate.language === 'c' || candidate.language === 'cpp'
          ? candidate.language
          : languageForPath(candidate.path),
      code: candidate.code,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
    });
  }
  return files;
}

/** Reads projects back out of storage, dropping anything unusable. */
export function validProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const projects: Project[] = [];

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<Project>;
    if (typeof candidate.id !== 'string' || seen.has(candidate.id)) continue;

    const files = readStoredFiles(candidate.files);
    if (files.length === 0) continue;

    seen.add(candidate.id);
    const name =
      typeof candidate.name === 'string' && candidate.name.trim().length > 0
        ? candidate.name.trim().slice(0, MAX_PROJECT_NAME_LENGTH)
        : `project ${projects.length + 1}`;
    const activeId =
      typeof candidate.activeId === 'string' && files.some((file) => file.id === candidate.activeId)
        ? candidate.activeId
        : (files[0]?.id ?? '');

    projects.push({ id: candidate.id, name, files, activeId });
    if (projects.length >= MAX_PROJECTS) break;
  }

  return projects;
}

export function validProjectTrash(value: unknown): TrashedProject[] {
  if (!Array.isArray(value)) return [];

  const entries: TrashedProject[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<TrashedProject>;
    if (typeof candidate.id !== 'string' || typeof candidate.deletedAt !== 'number') continue;

    const files = readStoredFiles(candidate.files);
    if (files.length === 0) continue;

    entries.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' ? candidate.name : 'project',
      files,
      activeId:
        typeof candidate.activeId === 'string' && files.some((file) => file.id === candidate.activeId)
          ? candidate.activeId
          : (files[0]?.id ?? ''),
      deletedAt: candidate.deletedAt,
    });
    if (entries.length >= MAX_TRASHED_PROJECTS) break;
  }

  return entries;
}
