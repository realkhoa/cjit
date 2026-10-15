import { describe, expect, it } from 'vitest';
import {
  createFile,
  defaultCodeFor,
  extensionOf,
  findFile,
  initialWorkspace,
  languageForPath,
  removeFile,
  renameFile,
  uniquePath,
  updateFileCode,
  validateFileName,
} from '@/state/fileStore';
import type { StoredFile } from '@/state/fileStore';
import { loadFilesWorkspace } from '@/state/persistence';
import type { StorageLike } from '@/state/persistence';

function file(id: string, path: string, code = ''): StoredFile {
  return { id, path, language: languageForPath(path), code, updatedAt: 0 };
}

function fakeStorage(entries: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('file names', () => {
  it('accepts the extensions the editor understands', () => {
    for (const name of ['main.c', 'main.cpp', 'util.h', 'lib.hpp', 'a/b.cc', 'my_file-2.cxx']) {
      expect(validateFileName(name), name).toBeUndefined();
    }
  });

  it('explains what is wrong with a bad name', () => {
    expect(validateFileName('')).toContain('empty');
    expect(validateFileName('   ')).toContain('empty');
    expect(validateFileName('my file.c')).toContain('letters');
    expect(validateFileName('main')).toContain('extension');
    expect(validateFileName('main.txt')).toContain('unsupported extension');
    // Each rule reports itself, in a useful order.
    expect(validateFileName('a/../b.c')).toContain('..');
    expect(validateFileName('..')).toContain('..');
    expect(validateFileName('/main.c')).toContain('start or end');
    expect(validateFileName('main.')).toContain('dot');
    expect(validateFileName(`${'a'.repeat(80)}.c`)).toContain('longer than');
  });

  it('maps extensions to a language', () => {
    expect(languageForPath('main.c')).toBe('c');
    expect(languageForPath('main.h')).toBe('c');
    expect(languageForPath('main.cpp')).toBe('cpp');
    expect(languageForPath('main.HPP')).toBe('cpp');
    expect(extensionOf('a/b/main.cxx')).toBe('cxx');
  });
});

describe('uniquePath', () => {
  it('adds a counter instead of overwriting a file that exists', () => {
    const files = [file('1', 'main.c'), file('2', 'main2.c')];

    expect(uniquePath(files, 'main.c')).toBe('main3.c');
    expect(uniquePath(files, 'other.c')).toBe('other.c');
  });

  it('compares names case-insensitively', () => {
    expect(uniquePath([file('1', 'Main.c')], 'main.c')).toBe('main2.c');
  });
});

describe('createFile', () => {
  it('starts a new file from the extension, with a runnable stub', () => {
    const created = createFile([file('1', 'main.cpp')], {
      id: 'new',
      now: 123,
      path: 'scratch.c',
    });

    expect(created.path).toBe('scratch.c');
    expect(created.language).toBe('c');
    expect(created.code).toContain('#include <stdio.h>');
    expect(created.updatedAt).toBe(123);
  });

  it('gives the new file a C++ stub when it is a .cpp', () => {
    const created = createFile([], { id: 'new', now: 0, path: 'thing.cpp' });
    expect(created.code).toContain('#include <iostream>');
  });
});

describe('renameFile', () => {
  const files = [file('1', 'main.c', 'int main(void) { return 0; }'), file('2', 'helper.c')];

  it('renames and re-derives the language', () => {
    const result = renameFile(files, '1', 'main.cpp', 55);

    expect(result.error).toBeUndefined();
    const renamed = findFile(result.files, '1');
    expect(renamed?.path).toBe('main.cpp');
    expect(renamed?.language).toBe('cpp');
    expect(renamed?.updatedAt).toBe(55);
    // Content is untouched by a rename.
    expect(renamed?.code).toContain('int main');
  });

  it('refuses a name that is already taken', () => {
    const result = renameFile(files, '1', 'helper.c', 0);
    expect(result.error).toContain('already exists');
    expect(result.files).toBe(files);
  });

  it('refuses an invalid name without touching the workspace', () => {
    const result = renameFile(files, '1', 'not a name.txt', 0);
    expect(result.error).toBeDefined();
    expect(findFile(result.files, '1')?.path).toBe('main.c');
  });

  it('reports a missing file', () => {
    expect(renameFile(files, 'nope', 'x.c', 0).error).toBe('file not found');
  });
});

describe('removeFile and updateFileCode', () => {
  it('removes only the requested file', () => {
    const files = [file('1', 'a.c'), file('2', 'b.c')];
    expect(removeFile(files, '1').map((item) => item.path)).toEqual(['b.c']);
  });

  it('updates only the target file and its timestamp', () => {
    const files = [file('1', 'a.c', 'old'), file('2', 'b.c', 'keep')];
    const updated = updateFileCode(files, '1', 'new', 999);

    expect(findFile(updated, '1')?.code).toBe('new');
    expect(findFile(updated, '1')?.updatedAt).toBe(999);
    expect(findFile(updated, '2')?.code).toBe('keep');
  });
});

describe('initialWorkspace', () => {
  it('creates one active file', () => {
    const workspace = initialWorkspace('file-1', 0, { path: 'main.cpp', code: 'x' });

    expect(workspace.files).toHaveLength(1);
    expect(workspace.activeId).toBe('file-1');
    expect(workspace.files[0]?.language).toBe('cpp');
    // A new project file is a module: `#pragma once`, and no `main` - a second
    // `main` in the workspace would break the link of the whole project.
    expect(defaultCodeFor('main.c')).toContain('#pragma once');
    expect(defaultCodeFor('main.c')).not.toContain('main(');
    expect(defaultCodeFor('main.cpp')).toContain('#pragma once');
    expect(defaultCodeFor('main.cpp')).not.toContain('main(');
  });
});

describe('loading the workspace out of browser storage', () => {
  it('returns nothing when the browser has never stored a workspace', () => {
    expect(loadFilesWorkspace(fakeStorage())).toBeNull();
    expect(loadFilesWorkspace(null)).toBeNull();
  });

  it('migrates a v1 single-buffer workspace into the first project', () => {
    const cpp = fakeStorage({
      'cjit.workspace.v1': JSON.stringify({ version: 1, code: 'int main() { std::cout << 1; }' }),
    });
    const migrated = loadFilesWorkspace(cpp);
    const files = migrated?.projects[0]?.files ?? [];

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('main.cpp');
    expect(files[0]?.language).toBe('cpp');
    expect(migrated?.projects[0]?.activeId).toBe(files[0]?.id);
    // The code the user had is preserved, not discarded.
    expect(files[0]?.code).toContain('std::cout');

    const c = fakeStorage({
      'cjit.workspace.v1': JSON.stringify({ version: 1, code: '#include <stdio.h>\nint main(void){}' }),
    });
    expect(loadFilesWorkspace(c)?.projects[0]?.files[0]?.path).toBe('main.c');
  });

  it('turns a v2 file list into one project, keeping the file trash', () => {
    const store = fakeStorage({
      'cjit.files.v2': JSON.stringify({
        version: 2,
        files: [file('a', 'one.c', 'one'), file('b', 'two.cpp', 'two')],
        activeId: 'b',
        trash: [{ ...file('c', 'gone.c', 'gone'), deletedAt: 7 }],
      }),
    });

    const loaded = loadFilesWorkspace(store);
    const project = loaded?.projects[0];

    expect(project?.files.map((entry) => entry.path)).toEqual(['one.c', 'two.cpp']);
    expect(project?.activeId).toBe('b');
    expect(project?.name).toBe('main');
    expect(loaded?.activeProjectId).toBe(project?.id);
    // Files that were in the trash are still the user's, so they come across too.
    expect(loaded?.trash?.map((entry) => entry.path)).toEqual(['gone.c']);
    expect(loaded?.projectTrash).toEqual([]);
  });

  it('prefers the project workspace over the older shapes', () => {
    const store = fakeStorage({
      'cjit.files.v2': JSON.stringify({ version: 2, files: [file('old', 'old.cpp', 'old')], activeId: 'old' }),
      'cjit.files.v3': JSON.stringify({
        version: 3,
        projects: [
          { id: 'p1', name: 'bài tập', files: [file('a', 'a.cpp', 'A')], activeId: 'a' },
          { id: 'p2', name: 'lab', files: [file('b', 'b.cpp', 'B')], activeId: 'b' },
        ],
        activeProjectId: 'p2',
      }),
    });

    const loaded = loadFilesWorkspace(store);
    expect(loaded?.projects.map((project) => project.name)).toEqual(['bài tập', 'lab']);
    expect(loaded?.activeProjectId).toBe('p2');
    // The old flat list is not merged in as a third project.
    expect(loaded?.projects).toHaveLength(2);
  });

  it('falls back to the first file when the stored active id is gone', () => {
    const store = fakeStorage({
      'cjit.files.v3': JSON.stringify({
        version: 3,
        projects: [{ id: 'p1', name: 'main', files: [file('a', 'one.c', 'one')], activeId: 'missing' }],
        activeProjectId: 'p1',
      }),
    });

    expect(loadFilesWorkspace(store)?.projects[0]?.activeId).toBe('a');
  });

  it('falls back to the first project when the active one is gone', () => {
    const store = fakeStorage({
      'cjit.files.v3': JSON.stringify({
        version: 3,
        projects: [{ id: 'p1', name: 'main', files: [file('a', 'one.c', 'one')], activeId: 'a' }],
        activeProjectId: 'vanished',
      }),
    });

    expect(loadFilesWorkspace(store)?.activeProjectId).toBe('p1');
  });

  it('ignores unreadable, empty or unusable payloads instead of throwing', () => {
    expect(loadFilesWorkspace(fakeStorage({ 'cjit.files.v3': '{oops' }))).toBeNull();
    expect(loadFilesWorkspace(fakeStorage({ 'cjit.files.v3': '{"projects":[]}' }))).toBeNull();
    expect(loadFilesWorkspace(fakeStorage({ 'cjit.files.v2': '{oops' }))).toBeNull();
    expect(loadFilesWorkspace(fakeStorage({ 'cjit.files.v2': '{"files":[]}' }))).toBeNull();
  });
});
