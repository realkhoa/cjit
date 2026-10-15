// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Monaco cannot run under jsdom; the toolbar and the store are what matters here.
vi.mock('@/ui/EditorPane', () => ({ EditorPane: () => <div data-pane-marker="editor" /> }));
vi.mock('@/ui/ConsolePanel', () => ({ ConsolePanel: () => <div data-pane-marker="console" /> }));
vi.mock('@/ui/WatchPane', () => ({ WatchPane: () => <div data-pane-marker="watch" /> }));

import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { EXAMPLES } from '@/examples/sample';
import { encodeShare } from '@/state/share';
import { useAppStore } from '@/state/store';

const CPP_EXAMPLE = EXAMPLES[0]!;
const C_EXAMPLE = EXAMPLES[1]!;

/**
 * Regression tests for the examples dropdown that used to overwrite the open file.
 *
 * Picking an example replaced the active file's path and contents with no
 * confirmation and no undo, so a single click could destroy work. The control is
 * gone, and the action behind it now opens a new file instead of writing over one -
 * both are pinned here so they cannot quietly come back.
 */

const MINE = '// my own work, do not touch\nint main(void) { return 0; }\n';

function openCleanWorkspace(): string {
  while (useAppStore.getState().files.length > 1) {
    const files = useAppStore.getState().files;
    const last = files[files.length - 1];
    if (last) useAppStore.getState().openFile(last.id);
    useAppStore.getState().deleteActiveFile();
  }

  const only = useAppStore.getState().files[0];
  if (!only) throw new Error('a workspace always has one file');
  useAppStore.getState().openFile(only.id);
  useAppStore.getState().renameActiveFile('main.cpp');
  useAppStore.getState().setCodeFromEditor(MINE);
  return only.id;
}

beforeEach(() => {
  registerDefaultEngines();
  openCleanWorkspace();
});

afterEach(() => {
  cleanup();
});

describe('the toolbar offers no way to overwrite the open file', () => {
  it('has no example dropdown at all', () => {
    render(<App />);

    expect(screen.queryByLabelText('Example')).toBeNull();
    expect(document.querySelector('#example-select')).toBeNull();
    // The engine picker is still there: only the destructive control was removed.
    expect(document.querySelector('#engine-select')).not.toBeNull();
  });
});

describe('opening a sample never writes over work', () => {
  it('leaves the open file alone and opens the sample as a new file', () => {
    const before = useAppStore.getState();
    const mineId = before.activeFileId;
    const mineCode = before.code;

    useAppStore.getState().openExample(C_EXAMPLE.path, C_EXAMPLE.language, C_EXAMPLE.code);

    const after = useAppStore.getState();
    const mine = after.files.find((file) => file.id === mineId);
    expect(mine?.code).toBe(mineCode);
    expect(mine?.path).toBe('main.cpp');

    // A new, active file holds the sample.
    expect(after.files).toHaveLength(2);
    expect(after.activeFileId).not.toBe(mineId);
    expect(after.code).toBe(C_EXAMPLE.code);
    expect(after.path).toBe(C_EXAMPLE.path);
  });

  it('keeps a name clash from overwriting either file', () => {
    useAppStore.getState().openExample(CPP_EXAMPLE.path, CPP_EXAMPLE.language, CPP_EXAMPLE.code);

    const paths = useAppStore.getState().files.map((file) => file.path);
    // The user's main.cpp survives, and the sample gets a free name.
    expect(paths).toContain('main.cpp');
    expect(paths.filter((path) => path.startsWith('main')).length).toBe(2);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does not start from a file whose contents were replaced', () => {
    // The specific shape of the old bug: the active file kept its id but its code
    // was swapped for the sample's.
    useAppStore.getState().openExample(CPP_EXAMPLE.path, CPP_EXAMPLE.language, CPP_EXAMPLE.code);

    const mine = useAppStore.getState().files.find((file) => file.code === MINE);
    expect(mine).toBeDefined();
  });
});

describe('opening a share link does not replace the workspace either', () => {
  it('adds the shared files and keeps the ones already here', async () => {
    const encoded = await encodeShare({
      version: 1,
      files: [{ path: 'shared.c', code: 'int shared(void) { return 1; }\n' }],
    });
    window.location.hash = `#s=${encoded}`;

    try {
      const opened = await useAppStore.getState().loadSharedWorkspace();
      expect(opened).toBe(true);

      const paths = useAppStore.getState().files.map((file) => file.path);
      expect(paths).toContain('main.cpp'); // work already here survives
      expect(paths).toContain('shared.c'); // and the link's file arrives
      expect(useAppStore.getState().files.some((file) => file.code === MINE)).toBe(true);
    } finally {
      window.location.hash = '';
    }
  });
});
