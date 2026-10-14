import { beforeEach, describe, expect, it } from 'vitest';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { flushAnalysis, useAppStore } from '@/state/store';

/**
 * Store-level tests for the file workspace: this is the flow the user actually
 * drives from the Explorer, so it is verified through the same actions the UI
 * calls rather than by touching the state directly.
 */

beforeEach(() => {
  registerDefaultEngines();

  // Collapse back to exactly one file, whatever the previous test left behind.
  while (useAppStore.getState().files.length > 1) {
    const files = useAppStore.getState().files;
    const last = files[files.length - 1];
    if (last) useAppStore.getState().openFile(last.id);
    useAppStore.getState().deleteActiveFile();
  }

  const only = useAppStore.getState().files[0];
  if (only) {
    useAppStore.getState().openFile(only.id);
    useAppStore.getState().renameActiveFile('main.c');
    useAppStore.getState().setCodeFromEditor('int main(void) { return 0; }\n');
  }
});

describe('file workspace: creating and switching', () => {
  it('creates a new file, makes it active and gives it a runnable stub', () => {
    useAppStore.getState().createFile();

    const state = useAppStore.getState();
    expect(state.files).toHaveLength(2);
    const created = state.files.find((file) => file.id === state.activeFileId);
    expect(created?.path).toBe('untitled.c');
    expect(created?.language).toBe('c');
    expect(state.code).toBe(created?.code);
    expect(state.code).toContain('printf');
  });

  it('does not reuse a name that is taken', () => {
    useAppStore.getState().createFile();
    useAppStore.getState().createFile();

    const paths = useAppStore.getState().files.map((file) => file.path);
    expect(paths).toEqual(['main.c', 'untitled.c', 'untitled2.c']);
  });

  it('switches the editor to the file that was opened', () => {
    const first = useAppStore.getState().files[0];
    useAppStore.getState().setCodeFromEditor('// edited main\nint main(void) { return 1; }\n');
    useAppStore.getState().createFile();
    useAppStore.getState().setCodeFromEditor('// second file\n');

    if (first) useAppStore.getState().openFile(first.id);

    const state = useAppStore.getState();
    expect(state.activeFileId).toBe(first?.id);
    expect(state.path).toBe('main.c');
    expect(state.language).toBe('c');
    expect(state.code).toContain('// edited main');
  });

  it('keeps each file\u2019s code separate', () => {
    const first = useAppStore.getState().files[0];
    useAppStore.getState().setCodeFromEditor('AAA');
    useAppStore.getState().createFile();
    useAppStore.getState().setCodeFromEditor('BBB');

    const state = useAppStore.getState();
    const firstFile = state.files.find((file) => file.id === first?.id);
    const active = state.files.find((file) => file.id === state.activeFileId);
    expect(firstFile?.code).toBe('AAA');
    expect(active?.code).toBe('BBB');
  });
});

describe('file workspace: renaming', () => {
  it('renames the active file and follows the new extension', () => {
    const outcome = useAppStore.getState().renameActiveFile('solver.cpp');

    expect(outcome.ok).toBe(true);
    const state = useAppStore.getState();
    expect(state.path).toBe('solver.cpp');
    expect(state.language).toBe('cpp');
  });

  it('refuses an invalid or duplicate name and changes nothing', () => {
    useAppStore.getState().createFile();
    const duplicate = useAppStore.getState().renameActiveFile('main.c');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('already exists');
    expect(useAppStore.getState().path).toBe('untitled.c');

    const invalid = useAppStore.getState().renameActiveFile('nope.txt');
    expect(invalid.ok).toBe(false);
    expect(useAppStore.getState().path).toBe('untitled.c');
  });
});

describe('file workspace: deleting', () => {
  it('removes the active file and activates another one', () => {
    useAppStore.getState().createFile();
    const createdId = useAppStore.getState().activeFileId;
    useAppStore.getState().deleteActiveFile();

    const state = useAppStore.getState();
    expect(state.files.map((file) => file.id)).not.toContain(createdId);
    expect(state.files).toHaveLength(1);
    expect(state.activeFileId).toBe(state.files[0]?.id);
    expect(state.path).toBe('main.c');
  });

  it('never deletes the last file', () => {
    expect(useAppStore.getState().files).toHaveLength(1);
    useAppStore.getState().deleteActiveFile();
    expect(useAppStore.getState().files).toHaveLength(1);
  });
});

describe('file workspace: the analysis follows the active file', () => {
  it('analyses the file that is open', async () => {
    useAppStore.getState().setCodeFromEditor('int main(void) { int marker = 7; return 0; }\n');
    await flushAnalysis();

    expect(useAppStore.getState().watch.status).toBe('ok');
    expect(useAppStore.getState().watch.vars.map((item) => item.name)).toContain('marker');
  });

  it('writes edits into the file the editor is showing', async () => {
    useAppStore.getState().createFile();
    const activeId = useAppStore.getState().activeFileId;
    useAppStore.getState().setCodeFromEditor('int marker_here(void) { return 0; }\n');

    const active = useAppStore.getState().files.find((file) => file.id === activeId);
    expect(active?.code).toBe('int marker_here(void) { return 0; }\n');

    // The other file keeps its own content.
    const other = useAppStore.getState().files.find((file) => file.id !== activeId);
    expect(other?.code).not.toContain('marker_here');
  });
});
