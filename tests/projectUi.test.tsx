// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';
import { Explorer } from '@/ui/Explorer';

/**
 * Switching projects, through the panel the user actually uses.
 *
 * The failing modes here are silent ones: a project that does not appear, a switch
 * that leaves the previous project's file open, a delete with no way back.
 */

function resetProjects(): void {
  const store = useAppStore.getState();
  // One project with one file, whatever the previous test left behind.
  useAppStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'main',
        files: [
          { id: 'f1', path: 'main.cpp', language: 'cpp', code: 'int main(){}', updatedAt: 0 },
        ],
        activeId: 'f1',
      },
    ],
    activeProjectId: 'p1',
    files: [
      { id: 'f1', path: 'main.cpp', language: 'cpp', code: 'int main(){}', updatedAt: 0 },
    ],
    activeFileId: 'f1',
    path: 'main.cpp',
    language: 'cpp',
    code: 'int main(){}',
    trash: [],
    projectTrash: [],
  });
  void store;
}

beforeEach(() => {
  registerDefaultEngines();
  resetProjects();
});

afterEach(() => {
  cleanup();
});

function openProjects(): void {
  fireEvent.click(screen.getByRole('button', { name: /Đổi project/ }));
}

describe('the project bar', () => {
  it('shows which project is open', () => {
    render(<Explorer />);
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('lists every project with its file count', () => {
    useAppStore.getState().createProject('lab');
    useAppStore.getState().createFile();
    render(<Explorer />);
    openProjects();

    const rows = screen.getAllByRole('button', { name: /^(main|lab)$/ });
    expect(rows).toHaveLength(2);
    // The new project has two files: its own main.cpp plus the one just created.
    expect(useAppStore.getState().files).toHaveLength(2);
  });

  it('switches to the project that was picked, and shows its files', () => {
    useAppStore.getState().createProject('lab');
    render(<Explorer />);

    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'main' }));

    expect(useAppStore.getState().activeProjectId).toBe('p1');
    expect(useAppStore.getState().files.map((file) => file.path)).toEqual(['main.cpp']);
  });
});

describe('making a project', () => {
  it('creates one and opens it', () => {
    render(<Explorer />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: '+ New project' }));

    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'bài tập 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));

    const state = useAppStore.getState();
    expect(state.projects.map((project) => project.name)).toEqual(['main', 'bài tập 2']);
    expect(state.activeProjectId).not.toBe('p1');
    // A new project is a program already, so Run works immediately.
    expect(state.files[0]?.code).toContain('int main()');
  });

  it('makes the name unique rather than refusing it', () => {
    useAppStore.getState().createProject('main');
    expect(useAppStore.getState().projects.map((project) => project.name)).toEqual([
      'main',
      'main-2',
    ]);
  });
});

describe('renaming a project', () => {
  it('saves the new name', () => {
    render(<Explorer />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'đồ án' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    expect(useAppStore.getState().projects[0]?.name).toBe('đồ án');
  });

  it('refuses a name that would break a path, and says why', () => {
    render(<Explorer />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'a/b' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    expect(useAppStore.getState().projects[0]?.name).toBe('main');
    expect(screen.getByText(/không được chứa ký tự đường dẫn/)).toBeTruthy();
  });
});

describe('deleting a project', () => {
  it('offers no delete for the last one', () => {
    render(<Explorer />);
    openProjects();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('moves it to the project trash and back again', () => {
    useAppStore.getState().createProject('lab');
    useAppStore.getState().switchProject('p1');
    render(<Explorer />);

    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: /Xoá project "main"/ }));

    expect(useAppStore.getState().projects.map((project) => project.name)).toEqual(['lab']);
    expect(useAppStore.getState().projectTrash.map((project) => project.name)).toEqual(['main']);

    // And the trash offers it back.
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));

    expect(useAppStore.getState().projects.map((project) => project.name).sort()).toEqual([
      'lab',
      'main',
    ]);
    expect(useAppStore.getState().projectTrash).toHaveLength(0);
  });

  it('asks before emptying the project trash, because that is irreversible', () => {
    useAppStore.getState().createProject('lab');
    useAppStore.getState().deleteProject('p1');
    render(<Explorer />);

    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    fireEvent.click(screen.getByRole('button', { name: /Empty project trash/ }));
    expect(useAppStore.getState().projectTrash).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Xoá hẳn 1 project/ }));
    expect(useAppStore.getState().projectTrash).toHaveLength(0);
  });
});

describe('files stay inside their project', () => {
  it('keeps each project\u2019s files apart when switching back and forth', () => {
    useAppStore.getState().setCodeFromEditor('// project one\n');
    useAppStore.getState().createProject('lab');
    useAppStore.getState().setCodeFromEditor('// project two\n');

    render(<Explorer />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(useAppStore.getState().code).toBe('// project one\n');

    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'lab' }));
    expect(useAppStore.getState().code).toBe('// project two\n');
  });

  it('counts the files of the project the bar is showing', () => {
    useAppStore.getState().createFile();
    render(<Explorer />);

    const header = screen.getByText('Explorer').parentElement as HTMLElement;
    expect(within(header).getByText('2')).toBeTruthy();
  });
});
