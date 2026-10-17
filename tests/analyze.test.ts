import { describe, expect, it } from 'vitest';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { createFastEngine } from '@/engine/fastEngine';
import type { RunSink } from '@/engine/types';
import { SAMPLE_HELLO_C, SAMPLE_MAIN_CPP, exampleFiles, exampleFileMap } from '@/examples/sample';
import { getPublishedAnalysis } from '@/lang/analysisCache';
import { analyzeSource } from '@/lang/analyze';
import { flushAnalysis, useAppStore } from '@/state/store';
import { inlineDecorationSpecs } from '@/ui/inlineValues';
import { buildIterationTable } from '@/ui/iterationTable';

const CLEAN_C = [
  '#include <stdio.h>',
  'int main(void) {',
  '    int answer = 42;',
  '    for (int i = 0; i < 3; i++) {',
  '        printf("%d\\n", i);',
  '    }',
  '    return answer;',
  '}',
  '',
].join('\n');

describe('analyze: the whole front-end on real code', () => {
  it('reports no diagnostics for a clean C program with implicit headers', () => {
    const result = analyzeSource(CLEAN_C, 'main.c');

    expect(result.diagnostics).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.implicitHeaders).toBe(true);
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.symbols.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['main', 'answer', 'i']),
    );
  });

  it('finds printf in the built-in header so calls are known without an include', () => {
    const result = analyzeSource('int main(void) { printf("hi"); return 0; }\n', 'main.c');

    const printf = result.symbols.symbols.find((symbol) => symbol.name === 'printf');
    expect(printf?.kind).toBe('function');
    expect(printf?.file).toBe('<stdio.h>');
  });

  it('reports a syntax error on the line where it happens', () => {
    const broken = ['int main(void) {', '    int a = ;', '    return 0;', '}'].join('\n');
    const result = analyzeSource(broken, 'main.c');

    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.startLine).toBe(2);
  });

  it('resolves the default C++ sample with no diagnostics at all', () => {
    const result = analyzeSource(SAMPLE_MAIN_CPP, 'main.cpp', { files: exampleFileMap() });

    expect(result.diagnostics).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('handles the C sample with and without its explicit include', () => {
    expect(analyzeSource(SAMPLE_HELLO_C, 'main.c').errorCount).toBe(0);
    expect(analyzeSource(`#include <stdio.h>\n${SAMPLE_HELLO_C}`, 'main.c').errorCount).toBe(0);
  });
});

describe('fast engine: honest snapshots and runs', () => {
  it('returns real values from a real execution', async () => {
    const engine = createFastEngine();
    const snapshot = await engine.watch({ code: CLEAN_C, file: 'main.c' }, new AbortController().signal);

    expect(snapshot.engine).toBe('fast');
    expect(snapshot.status).toBe('ok');
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.steps).toBeGreaterThan(0);

    const byName = new Map(snapshot.vars.map((item) => [item.name, item]));
    // These are values the program actually produced, not declarations echoed back.
    expect(byName.get('answer')?.value).toBe('42');
    expect(byName.get('answer')?.type).toBe('int');
    expect(byName.get('i')?.value).toBe('3');
    expect(byName.get('printf')).toBeUndefined();
  });

  it('reports compile-error with diagnostics when the code does not parse', async () => {
    const engine = createFastEngine();
    const snapshot = await engine.watch(
      { code: 'int main(void) { int a = ; return 0; }\n', file: 'main.c' },
      new AbortController().signal,
    );

    expect(snapshot.status).toBe('compile-error');
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
  });

  it('publishes its analysis so completion can use the symbol table', async () => {
    const engine = createFastEngine();
    await engine.watch({ code: 'int main(void) { int local = 1; return local; }\n', file: 'main.c' }, new AbortController().signal);

    const published = getPublishedAnalysis();
    expect(published).not.toBeNull();
    expect(published?.symbols.symbols.map((symbol) => symbol.name)).toContain('local');
  });

  it('streams real stdout and reports the exit code', async () => {
    const engine = createFastEngine();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sink: RunSink = {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      watch: () => undefined,
    };

    const outcome = await engine.run(
      { code: CLEAN_C, file: 'main.c' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(outcome.status).toBe('ok');
    expect(stdout.join('')).toBe('0\n1\n2\n');
    expect(stderr.join('')).toBe('');
    // `return answer;` with answer == 42.
    expect(outcome.exitCode).toBe(42);
  });

  it('reports a build failure on stderr when the code does not parse', async () => {    const engine = createFastEngine();
    const stderr: string[] = [];
    const sink: RunSink = {
      stdout: () => undefined,
      stderr: (chunk) => stderr.push(chunk),
      watch: () => undefined,
    };

    const outcome = await engine.run(
      { code: 'int main(void) { int a = ; }\n', file: 'main.c' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(outcome.status).toBe('compile-error');
    expect(stderr.join('')).toContain('Build failed');
  });
});

describe('engine output feeds the editor overlays', () => {
  it('produces inline overlays and loop iterations for the default C++ sample', async () => {
    const engine = createFastEngine();
    const snapshot = await engine.watch(
      { code: SAMPLE_MAIN_CPP, file: 'main.cpp', files: exampleFiles() },
      new AbortController().signal,
    );

    expect(snapshot.status).toBe('ok');
    expect(snapshot.lineStates.length).toBeGreaterThan(0);

    const specs = inlineDecorationSpecs(snapshot, () => 40);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      // Monaco renders `after` at the end of the range: it must be the line end.
      expect(spec.endColumn).toBe(41);
      // ...and the injected text must be a single line.
      expect(spec.content).not.toMatch(/[\r\n]/);
      expect(spec.content).toContain('//');
    }

    // The tour runs several loops (the sort's output loop, the map's word loop,
    // the container walks), so iterations are recorded per pass.
    const passes = snapshot.history.filter((entry) => entry.kind === 'loop-iteration');
    expect(passes.length).toBeGreaterThanOrEqual(8);

    // And a caret on the loop body finds exactly that loop's iterations. Line 34 is
    // main.cpp's `for (const auto& value : nums)` while building the set, which runs
    // once per element of nums - eight of them.
    const table = buildIterationTable(snapshot.history, 34);
    expect(table.rows.length).toBe(8);

    // `globalIteration` counts passes across the whole run, so an earlier loop makes
    // this one start above 1. What matters is that these eight are consecutive: they
    // are the eight passes of this loop and nothing else.
    const iterations = table.rows.map((row) => row.globalIteration);
    expect(iterations[7]! - iterations[0]!).toBe(7);

    // A vector reads inline as `[value, value, ...]`, not as a type and an address.
    // `std::sort` has already run, so the pane shows the sorted contents.
    const vectorOverlay = specs.find((spec) => spec.content.includes('nums = ['));
    expect(vectorOverlay?.content).toContain('[1, 1, 2, 3, 4, 5, 6, 9]');
  });
});

describe('pipeline: the store drives the real engine through the 1s debounce', () => {
  it('updates the watch pane from real code after the debounce is flushed', async () => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('fast');
    useAppStore.getState().setCodeFromEditor(CLEAN_C);

    // Nothing has run yet: the debounce is still pending.
    expect(useAppStore.getState().analysisState).toBe('idle');

    await flushAnalysis();

    const watch = useAppStore.getState().watch;
    expect(watch.engine).toBe('fast');
    expect(watch.status).toBe('ok');
    const byName = new Map(watch.vars.map((item) => [item.name, item]));
    expect(byName.get('answer')?.value).toBe('42');
    expect(byName.get('i')?.value).toBe('3');
    expect(watch.diagnostics).toEqual([]);
  });

  it('surfaces parse errors from the store as compile-error', async () => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('fast');
    useAppStore.getState().setCodeFromEditor('int main(void) { int a = ; return 0; }\n');
    await flushAnalysis();

    const watch = useAppStore.getState().watch;
    expect(watch.status).toBe('compile-error');
    expect(watch.diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });

  it('keeps the watch pane on the fast engine even when Run is set to clang', async () => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('clang-wasm');
    useAppStore.getState().setCodeFromEditor('int main(void) { int fast = 7; return 0; }\n');
    await flushAnalysis();

    const watch = useAppStore.getState().watch;
    expect(watch.engine).toBe('fast');
    expect(watch.status).toBe('ok');
    expect(watch.vars.map((item) => item.name)).toContain('fast');
  });

  it('falls back to the fast engine for Run, and says why', async () => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('clang-wasm');
    useAppStore.getState().setCodeFromEditor('int main(void) { printf("ran\\n"); return 0; }\n');

    await useAppStore.getState().run();

    const state = useAppStore.getState();
    expect(state.runState).toBe('idle');
    expect(state.output.some((entry) => entry.text.includes('Clang') || entry.text.includes('clang-wasm'))).toBe(true);
    expect(state.output.some((entry) => entry.text.includes('ran'))).toBe(true);
    expect(state.watch.engine).toBe('fast');
  });
});
