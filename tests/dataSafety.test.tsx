// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { registerDefaultEngines } from '@/engine/bootstrap';
import {
  MAX_TRASHED_FILES,
  pushTrashed,
  restoreTrashed,
  trashAll,
  trashFile,
  validTrash,
} from '@/state/fileStore';
import type { StoredFile, TrashedFile } from '@/state/fileStore';
import { writeFilesNow } from '@/state/persistence';
import { useAppStore } from '@/state/store';
import { Explorer } from '@/ui/Explorer';
import { StatusBar } from '@/ui/StatusBar';

/**
 * Data safety: every path that removes something has to be undoable.
 *
 * A toolbar click once destroyed a file with no confirmation and no undo, so the
 * promise here is concrete rather than aspirational - deleting and resetting both
 * put what they remove in the trash, and a browser that refuses to save says so.
 */

const MINE = '// work worth keeping\nint main(void) { return 0; }\n';

function file(id: string, path: string, code = ''): StoredFile {
  return { id, path, language: path.endsWith('.c') ? 'c' : 'cpp', code, updatedAt: 0 };
}

function trashed(id: string, path: string, code = '', deletedAt = 0): TrashedFile {
  return { ...file(id, path, code), deletedAt };
}

function resetWorkspace(): void {
  useAppStore.setState({ trash: [] });
  while (useAppStore.getState().files.length > 1) {
    const files = useAppStore.getState().files;
    const last = files[files.length - 1];
    if (last) useAppStore.getState().openFile(last.id);
    useAppStore.getState().deleteActiveFile();
  }
  useAppStore.setState({ trash: [] });

  const only = useAppStore.getState().files[0];
  if (!only) throw new Error('a workspace always has one file');
  useAppStore.getState().openFile(only.id);
  useAppStore.getState().renameActiveFile('main.cpp');
  useAppStore.getState().setCodeFromEditor(MINE);
}

beforeEach(() => {
  registerDefaultEngines();
  resetWorkspace();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('trash: pure rules', () => {
  it('moves a file out of the workspace and into the trash', () => {
    const files = [file('1', 'a.c', 'keep'), file('2', 'b.c', 'gone')];
    const result = trashFile(files, [], '2', 42);

    expect(result.files.map((entry) => entry.path)).toEqual(['a.c']);
    expect(result.trash.map((entry) => entry.path)).toEqual(['b.c']);
    expect(result.trash[0]?.deletedAt).toBe(42);
    // The content is kept, which is the whole point.
    expect(result.trash[0]?.code).toBe('gone');
  });

  it('does nothing for an id that is not there', () => {
    const files = [file('1', 'a.c')];
    expect(trashFile(files, [], 'nope', 0).files).toBe(files);
  });

  it('keeps the trash bounded, newest first', () => {
    const many = Array.from({ length: MAX_TRASHED_FILES + 5 }, (_, index) =>
      trashed(`t${index}`, `f${index}.c`),
    );
    const bounded = pushTrashed([], many);

    expect(bounded).toHaveLength(MAX_TRASHED_FILES);
    // The most recently deleted is kept; the oldest fall off the end.
    expect(bounded[0]?.path).toBe('f24.c');
    expect(bounded.some((entry) => entry.path === 'f0.c')).toBe(false);
  });

  it('restores under a free name instead of overwriting what took its place', () => {
    const files = [file('1', 'util.c', 'new content')];
    const trash = [trashed('t1', 'util.c', 'old content')];

    const result = restoreTrashed(files, trash, 't1', 7);

    expect(result.restored?.path).toBe('util2.c');
    expect(result.restored?.code).toBe('old content');
    expect(files.find((entry) => entry.path === 'util.c')?.code).toBe('new content');
    expect(result.trash).toHaveLength(0);
  });

  it('moves a whole workspace into the trash, which is how Reset is undone', () => {
    const kept = trashAll([file('1', 'a.c', 'a'), file('2', 'b.c', 'b')], [], 5);
    expect(kept.map((entry) => entry.path)).toEqual(['a.c', 'b.c']);
    expect(kept.every((entry) => entry.deletedAt === 5)).toBe(true);
  });

  it('ignores rubbish read back out of storage', () => {
    expect(validTrash(null)).toEqual([]);
    expect(validTrash([{ id: 1 }, 'nonsense', { id: 'a', path: 'a.c', code: 'x' }])).toEqual([
      expect.objectContaining({ id: 'a', path: 'a.c', language: 'cpp' }),
    ]);
  });
});

describe('deleting a file is undoable', () => {
  it('puts the file in the trash and keeps its contents', () => {
    useAppStore.getState().createFile();
    useAppStore.getState().setCodeFromEditor('// second file\n');
    const secondId = useAppStore.getState().activeFileId;

    useAppStore.getState().deleteActiveFile();

    const state = useAppStore.getState();
    expect(state.files.some((entry) => entry.id === secondId)).toBe(false);
    const entry = state.trash.find((candidate) => candidate.path === 'untitled.c');
    expect(entry?.code).toBe('// second file\n');
  });

  it('brings it back with its contents when restored', () => {
    useAppStore.getState().createFile();
    useAppStore.getState().setCodeFromEditor('// second file\n');
    useAppStore.getState().deleteActiveFile();

    const entry = useAppStore.getState().trash[0];
    expect(entry).toBeDefined();
    useAppStore.getState().restoreTrashed(entry!.id);

    const state = useAppStore.getState();
    expect(state.files.some((candidate) => candidate.code === '// second file\n')).toBe(true);
    expect(state.trash).toHaveLength(0);
    // The restored file is the one being edited.
    expect(state.code).toBe('// second file\n');
  });

  it('never removes the last file at all', () => {
    expect(useAppStore.getState().files).toHaveLength(1);
    useAppStore.getState().deleteActiveFile();
    expect(useAppStore.getState().files).toHaveLength(1);
    expect(useAppStore.getState().trash).toHaveLength(0);
  });
});

describe('resetting a project is undoable', () => {
  it('keeps the old files in the trash and restores the bundled sample', () => {
    useAppStore.getState().resetProject();

    const state = useAppStore.getState();
    // The project goes back to the bundled sample, which is a project: three files
    // including the module the tour includes.
    expect(state.files.map((file) => file.path)).toEqual(['main.cpp', 'util.h', 'hello.c']);
    const entry = state.trash.find((candidate) => candidate.code === MINE);
    expect(entry?.path).toBe('main.cpp');
  });

  it('does not touch the other projects', () => {
    useAppStore.getState().createProject('other');
    const before = useAppStore.getState().projects.length;

    useAppStore.getState().switchProject(useAppStore.getState().projects[0]!.id);
    useAppStore.getState().resetProject();

    // Resetting one project used to clear the whole stored workspace; it must not.
    expect(useAppStore.getState().projects).toHaveLength(before);
  });

  it('lets the old file come back afterwards', () => {
    useAppStore.getState().resetProject();
    const entry = useAppStore.getState().trash[0];
    useAppStore.getState().restoreTrashed(entry!.id);

    expect(useAppStore.getState().files.some((candidate) => candidate.code === MINE)).toBe(true);
  });

  it('only really deletes when the trash is emptied on purpose', () => {
    useAppStore.getState().resetProject();
    expect(useAppStore.getState().trash.length).toBeGreaterThan(0);

    useAppStore.getState().emptyTrash();
    expect(useAppStore.getState().trash).toEqual([]);
  });
});

describe('the explorer shows the trash', () => {
  it('offers a restore for a deleted file', () => {
    useAppStore.getState().createFile();
    useAppStore.getState().setCodeFromEditor('// second file\n');
    useAppStore.getState().deleteActiveFile();

    render(<Explorer />);
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));

    const restore = screen.getByRole('button', { name: /Restore/ });
    fireEvent.click(restore);

    expect(useAppStore.getState().files.some((file) => file.code === '// second file\n')).toBe(true);
  });

  it('asks before emptying, because that is the one irreversible action', () => {
    useAppStore.getState().createFile();
    useAppStore.getState().deleteActiveFile();

    render(<Explorer />);
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    fireEvent.click(screen.getByRole('button', { name: /Empty trash/ }));

    // Still there until the confirmation is clicked.
    expect(useAppStore.getState().trash).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Xoá hẳn/ }));
    expect(useAppStore.getState().trash).toHaveLength(0);
  });
});

describe('a browser that refuses to save says so', () => {
  it('warns instead of losing work silently', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    const saved = writeFilesNow({
      version: 3,
      projects: [{ id: 'p1', name: 'main', files: [file('1', 'a.c', 'x')], activeId: '1' }],
      activeProjectId: 'p1',
    });

    expect(saved).toBe(false);
    expect(useAppStore.getState().storageWarning).toContain('không lưu được');
    // The console keeps the reason too, next to whatever the program printed.
    expect(
      useAppStore
        .getState()
        .output.some((entry) => entry.text.includes('không lưu được')),
    ).toBe(true);

    setItem.mockRestore();
  });

  it('shows the warning in the status bar', () => {
    useAppStore.setState({ storageWarning: 'không lưu được workspace (hết dung lượng?)' });
    render(<StatusBar />);

    expect(screen.getByRole('status').textContent).toContain('không lưu được');
    useAppStore.setState({ storageWarning: null });
  });
});
