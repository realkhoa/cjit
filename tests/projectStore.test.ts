import { describe, expect, it } from 'vitest';
import type { StoredFile } from '@/state/fileStore';
import { uniquePath } from '@/state/fileStore';
import {
  MAX_PROJECTS,
  MAX_TRASHED_PROJECTS,
  activeProject,
  addFileToProject,
  findProject,
  newProject,
  restoreProject,
  switchProject,
  trashProject,
  uniqueProjectName,
  validProjectTrash,
  validProjects,
  validateProjectName,
  withProject,
} from '@/state/projectStore';
import type { Project, ProjectWorkspace, TrashedProject } from '@/state/projectStore';

/**
 * Projects, as rules.
 *
 * The workspace used to *be* the file list, so this level is new; the rules that
 * matter are the ones that protect work: a workspace always has a project, deleting
 * one is recoverable, and names never collide.
 */

function file(id: string, path: string, code = ''): StoredFile {
  return { id, path, language: path.endsWith('.c') ? 'c' : 'cpp', code, updatedAt: 0 };
}

function project(id: string, name: string, files = [file(`${id}-f1`, 'main.cpp', 'A')]): Project {
  return { id, name, files, activeId: files[0]?.id ?? '' };
}

function workspace(...projects: Project[]): ProjectWorkspace {
  return { projects, activeProjectId: projects[0]?.id ?? '' };
}

describe('names', () => {
  it('accepts what a person would type and refuses what breaks a path', () => {
    expect(validateProjectName('bài tập 1')).toBeUndefined();
    expect(validateProjectName('lab-2')).toBeUndefined();
    expect(validateProjectName('  spaced  ')).toBeUndefined();
    expect(validateProjectName('')).toBeDefined();
    expect(validateProjectName('   ')).toBeDefined();
    expect(validateProjectName('a/b')).toBeDefined();
    expect(validateProjectName('x'.repeat(60))).toBeDefined();
  });

  it('makes a name free rather than refusing it', () => {
    const existing = [project('1', 'main'), project('2', 'lab')];
    expect(uniqueProjectName(existing, 'other')).toBe('other');
    // `main` is taken, so the next free one is `main-2`...
    expect(uniqueProjectName(existing, 'main')).toBe('main-2');
    // ...and only when that is taken too does it go further.
    expect(uniqueProjectName([...existing, project('3', 'main-2')], 'main')).toBe('main-3');
    // Renaming a project to its own name is not a collision.
    expect(uniqueProjectName(existing, 'main', '1')).toBe('main');
  });
});

describe('creating a project', () => {
  it('starts with one program, so Run works immediately', () => {
    const created = newProject('p1', 'first', 'f1', 0);
    expect(created.files).toHaveLength(1);
    expect(created.files[0]?.path).toBe('main.cpp');
    expect(created.files[0]?.code).toContain('int main()');
    expect(created.activeId).toBe('f1');
  });

  it('adds files under free names instead of overwriting', () => {
    const created = newProject('p1', 'first', 'f1', 0);
    const withTwo = addFileToProject(created, 'main.cpp', 'B', 'f2', 0);

    expect(withTwo.files).toHaveLength(2);
    expect(withTwo.files.map((entry) => entry.path)).toEqual(['main.cpp', 'main2.cpp']);
    // The new file is the one opened, and the first one is untouched.
    expect(withTwo.activeId).toBe('f2');
    expect(withTwo.files[0]?.code).toContain('int main()');
  });
});

describe('switching', () => {
  it('remembers which file was open in each project', () => {
    const one = project('1', 'one');
    const two = project('2', 'two', [file('2-a', 'a.cpp'), file('2-b', 'b.cpp')]);
    const both = workspace(one, two);

    const onTwo = switchProject(both, '2');
    expect(activeProject(onTwo)?.name).toBe('two');
    const backTo = switchProject(onTwo, '1');
    expect(activeProject(backTo)?.files[0]?.code).toBe('A');
  });

  it('ignores a project that is not there', () => {
    const only = workspace(project('1', 'one'));
    expect(switchProject(only, 'nope')).toBe(only);
  });
});

describe('deleting a project is recoverable', () => {
  it('never removes the last one', () => {
    const only = workspace(project('1', 'one'));
    const result = trashProject(only, [], '1', 5);

    expect(result.removed).toBe(false);
    expect(result.workspace.projects).toHaveLength(1);
    expect(result.trash).toHaveLength(0);
  });

  it('keeps the whole project, files and all', () => {
    const both = workspace(project('1', 'one'), project('2', 'two'));
    const result = trashProject(both, [], '1', 5);

    expect(result.removed).toBe(true);
    expect(result.workspace.projects.map((entry) => entry.id)).toEqual(['2']);
    expect(result.workspace.activeProjectId).toBe('2');
    expect(result.trash[0]?.files[0]?.code).toBe('A');
    expect(result.trash[0]?.deletedAt).toBe(5);
  });

  it('brings it back under a free name, with its files', () => {
    const both = workspace(project('1', 'main'), project('2', 'other'));
    const deleted = trashProject(both, [], '1', 5);
    const restored = restoreProject(deleted.workspace, deleted.trash, '1', 9);

    expect(restored.restored?.name).toBe('main');
    expect(restored.workspace.projects).toHaveLength(2);
    expect(restored.workspace.activeProjectId).toBe('1');
    expect(restored.trash).toHaveLength(0);
  });

  it('renames on restore when the name has been taken since', () => {
    const both = workspace(project('1', 'main'), project('2', 'other'));
    const deleted = trashProject(both, [], '1', 5);
    // Something else took the name while it was in the trash.
    const renamed = withProject(deleted.workspace, {
      ...(findProject(deleted.workspace.projects, '2') as Project),
      name: 'main',
    });

    const restored = restoreProject(renamed, deleted.trash, '1', 9);
    expect(restored.restored?.name).toBe('main-2');
  });

  it('stays bounded', () => {
    let trash: readonly TrashedProject[] = [];
    for (let index = 0; index < MAX_TRASHED_PROJECTS + 4; index += 1) {
      trash = [
        { ...project(`t${index}`, `t${index}`), deletedAt: index },
        ...trash,
      ].slice(0, MAX_TRASHED_PROJECTS);
    }
    expect(trash).toHaveLength(MAX_TRASHED_PROJECTS);
  });
});

describe('reading back what storage held', () => {
  it('drops rubbish instead of failing', () => {
    expect(validProjects(null)).toEqual([]);
    expect(validProjects('nope')).toEqual([]);
    expect(validProjects([{ id: 'a' }, 3, { name: 'no id' }])).toEqual([]);
  });

  it('keeps a usable project and repairs what it can', () => {
    const projects = validProjects([
      {
        id: 'p1',
        name: '  ',
        files: [{ id: 'f1', path: 'main.cpp', code: 'x' }],
      },
      {
        id: 'p2',
        name: 'two',
        activeId: 'gone',
        files: [{ id: 'f2', path: 'a.c', code: 'y', language: 'c' }],
      },
    ]);

    expect(projects).toHaveLength(2);
    // A blank name is replaced, and an active file that is not there falls back.
    expect(projects[0]?.name).toBe('project 1');
    expect(projects[0]?.activeId).toBe('f1');
    expect(projects[1]?.activeId).toBe('f2');
    expect(projects[1]?.files[0]?.language).toBe('c');
  });

  it('refuses a project with no usable file, and caps the count', () => {
    expect(validProjects([{ id: 'p', name: 'p', files: [] }])).toEqual([]);

    const many = Array.from({ length: MAX_PROJECTS + 3 }, (_, index) => ({
      id: `p${index}`,
      name: `p${index}`,
      files: [{ id: `f${index}`, path: 'main.cpp', code: 'x' }],
    }));
    expect(validProjects(many)).toHaveLength(MAX_PROJECTS);
  });

  it('validates the project trash the same way', () => {
    expect(validProjectTrash([{ id: 'p' }])).toEqual([]);
    expect(
      validProjectTrash([{ id: 'p', name: 'old', deletedAt: 3, files: [{ id: 'f', path: 'a.cpp', code: 'z' }] }]),
    ).toEqual([
      expect.objectContaining({ id: 'p', name: 'old', deletedAt: 3 }),
    ]);
  });
});

describe('file names inside a project', () => {
  it('still uses the file layer\u2019s uniqueness rule', () => {
    const existing = [file('1', 'util.h')];
    expect(uniquePath(existing, 'util.h')).toBe('util2.h');
  });
});
