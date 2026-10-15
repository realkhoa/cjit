import { beforeEach, describe, expect, it } from 'vitest';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { flushAnalysis, useAppStore } from '@/state/store';

/**
 * A multi-file project, driven through the same store actions the UI calls.
 *
 * The workspace always allowed several files; before this, they could not see each
 * other (the fast engine warned that local includes were unsupported, and Run only
 * ever compiled the active buffer). These tests are the contract for the fix.
 */

const MAIN = [
  '#include <iostream>',
  '#include "util.h"',
  'int main() {',
  '    std::cout << "helper(14) = " << helper(14) << \'\\n\';',
  '    return 0;',
  '}',
].join('\n');

const UTIL = 'int factor = 3;\nint helper(int value) { return value * factor; }\n';

/** Leaves the workspace as one file named `main.cpp` with `code`. */
function reset(code: string): void {
  while (useAppStore.getState().files.length > 1) {
    const files = useAppStore.getState().files;
    const last = files[files.length - 1];
    if (last) useAppStore.getState().openFile(last.id);
    useAppStore.getState().deleteActiveFile();
  }

  const only = useAppStore.getState().files[0];
  if (!only) return;
  useAppStore.getState().openFile(only.id);
  useAppStore.getState().renameActiveFile('main.cpp');
  useAppStore.getState().setCodeFromEditor(code);
}

/** Creates `path` with `code` and reopens the main file afterwards. */
function addFile(path: string, code: string): void {
  const mainId = useAppStore.getState().activeFileId;
  useAppStore.getState().createFile();
  useAppStore.getState().renameActiveFile(path);
  useAppStore.getState().setCodeFromEditor(code);
  useAppStore.getState().openFile(mainId);
}

beforeEach(() => {
  registerDefaultEngines();
  useAppStore.getState().setEngineId('fast');
  reset('int main(void) { return 0; }\n');
});

describe('workspace files: the realtime engine', () => {
  it('resolves a quoted include to a workspace file', async () => {
    addFile('util.h', UTIL);
    useAppStore.getState().setCodeFromEditor(MAIN);
    await flushAnalysis();

    const watch = useAppStore.getState().watch;
    expect(watch.status).toBe('ok');
    // The global defined in util.h is live in the watch pane, which is what proves
    // the include was really spliced rather than skipped.
    expect(watch.vars.find((item) => item.name === 'factor')?.value).toBe('3');
    expect(watch.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('says which file an include could not find, instead of "not supported"', async () => {
    useAppStore.getState().setCodeFromEditor('#include "missing.h"\nint main(void) { return 0; }\n');
    await flushAnalysis();

    const messages = useAppStore.getState().watch.diagnostics.map((item) => item.message);
    expect(messages.some((message) => message.includes('cannot find "missing.h"'))).toBe(true);
  });

  it('follows a chain of workspace headers', async () => {
    addFile('inner.h', 'int innerValue = 7;\n');
    addFile('outer.h', '#include "inner.h"\nint outerValue = innerValue + 1;\n');
    useAppStore.getState().setCodeFromEditor(
      '#include "outer.h"\nint main(void) { return outerValue; }\n',
    );
    await flushAnalysis();

    const watch = useAppStore.getState().watch;
    expect(watch.status).toBe('ok');
    expect(watch.vars.find((item) => item.name === 'outerValue')?.value).toBe('8');
  });
});

describe('workspace files: Run', () => {
  it('runs a function defined in another workspace file', async () => {
    addFile('util.h', UTIL);
    useAppStore.getState().setCodeFromEditor(MAIN);

    await useAppStore.getState().run();

    const output = useAppStore.getState().output.map((entry) => entry.text).join('');
    expect(output).toContain('helper(14) = 42');
  });

  it('still reports a genuine error in the active file', async () => {
    addFile('util.h', UTIL);
    useAppStore.getState().setCodeFromEditor('#include "util.h"\nint main() { return nope(); }\n');

    await useAppStore.getState().run();

    // Whether the engine catches it while building or while running, the error has
    // to be visible rather than swallowed.
    const state = useAppStore.getState();
    const reported = [
      ...state.watch.diagnostics.map((item) => item.message),
      ...state.output.map((entry) => entry.text),
    ].join('\n');
    expect(reported).toContain('nope');
    expect(state.watch.status).not.toBe('ok');
  });
});
