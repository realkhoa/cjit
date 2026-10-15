import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import { emptyWatch } from '@/engine/types';
import { SAMPLE_MAIN_CPP, exampleFiles } from '@/examples/sample';
import { useAppStore } from '@/state/store';
import { timelineHighlightFor } from '@/ui/watchSelect';

/**
 * A name can be live twice at once: the caller's `int total = sum(nums);` and the
 * `T total{}` accumulating inside the template. The pane used to show the outer one,
 * so every iteration of `sum`'s loop reported `total = 0` while the interpreter was
 * summing correctly. These tests pin the resolution down.
 */

function run(source: string, file = 'main.cpp') {
  const analysis = analyzeSource(source, file);
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

const TEMPLATE = [
  'template <typename T>',
  'T sum(const std::vector<T>& values) {',
  '    T total{};',
  '    for (const auto& v : values) {',
  '        total += v;',
  '    }',
  '    return total;',
  '}',
  'int main() {',
  '    std::vector<int> nums{3, 1, 4};',
  '    int total = sum(nums);',
  '    return 0;',
  '}',
].join('\n');

describe('a shadowed name resolves to the innermost binding', () => {
  it('reports the accumulating total for every loop pass', () => {
    const result = run(TEMPLATE);
    const passes = result.history.filter(
      (entry) => entry.kind === 'loop-iteration' && entry.line === 4,
    );

    expect(passes).toHaveLength(3);
    expect(passes.map((pass) => pass.vars.filter((v) => v.name === 'total').length)).toEqual([
      1, 1, 1,
    ]);
    // 3, then 3 + 1, then 3 + 1 + 4 - the template's own total, not main's 0.
    expect(passes.map((pass) => pass.vars.find((v) => v.name === 'total')?.value)).toEqual([
      '3',
      '4',
      '8',
    ]);
    expect(passes.every((pass) => pass.vars.find((v) => v.name === 'total')?.scope === 'sum')).toBe(
      true,
    );
  });

  it('falls back to the outer binding once the inner scope has ended', () => {
    const result = run(TEMPLATE);
    const total = result.vars.filter((item) => item.name === 'total');

    // After `sum` returns, only main's `total` is live - and it holds the result.
    expect(total).toHaveLength(1);
    expect(total[0]?.scope).toBe('main');
    expect(total[0]?.value).toBe('8');
  });

  it('still reports a variable whose scope has ended', () => {
    const result = run(['int main() {', '    int outer = 7;', '    return 0;', '}'].join('\n'));
    expect(result.vars.map((item) => item.name)).toContain('outer');
  });
});

describe('timelineHighlightFor', () => {  it('highlights the line the selected moment came from', async () => {
    const { createFastEngine } = await import('@/engine/fastEngine');
    const engine = createFastEngine();
    const snapshot = await engine.watch(
      { code: SAMPLE_MAIN_CPP, file: 'main.cpp', files: exampleFiles() },
      new AbortController().signal,
    );

    const entry = snapshot.history.find((item) => item.kind === 'loop-iteration');
    const index = snapshot.history.indexOf(entry!);
    expect(entry).toBeDefined();

    const highlight = timelineHighlightFor(snapshot, {
      mode: 'timeline',
      cursorLine: 1,
      historyIndex: index,
    });
    expect(highlight).toEqual({ line: entry?.line, className: 'cjit-timeline-line' });
  });

  it('highlights nothing in cursor mode: Monaco already marks the caret line', () => {
    const snapshot = emptyWatch();
    expect(
      timelineHighlightFor(snapshot, { mode: 'cursor', cursorLine: 4, historyIndex: 0 }),
    ).toBeNull();
  });

  it('highlights nothing in final mode: a result is not a moment', () => {
    const snapshot = emptyWatch();
    expect(
      timelineHighlightFor(snapshot, { mode: 'final', cursorLine: 4, historyIndex: 0 }),
    ).toBeNull();
  });

  it('highlights nothing when the timeline is empty', () => {
    expect(
      timelineHighlightFor(emptyWatch(), { mode: 'timeline', cursorLine: 1, historyIndex: 0 }),
    ).toBeNull();
  });
});

describe('store: the selected moment is shared with the editor', () => {
  it('keeps the mode in the store so both panes agree', () => {
    useAppStore.getState().setWatchMode('timeline');
    expect(useAppStore.getState().watchMode).toBe('timeline');

    useAppStore.getState().setWatchMode('cursor');
    expect(useAppStore.getState().watchMode).toBe('cursor');
  });

  it('clamps the index to the recorded history', () => {
    const last = Math.max(useAppStore.getState().watch.history.length - 1, 0);

    useAppStore.getState().setTimelineIndex(9999);
    expect(useAppStore.getState().timelineIndex).toBe(last);

    useAppStore.getState().setTimelineIndex(-5);
    expect(useAppStore.getState().timelineIndex).toBe(0);
  });
});
