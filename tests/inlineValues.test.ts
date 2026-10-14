import { describe, expect, it } from 'vitest';
import { emptyWatch } from '@/engine/types';
import type { VarNode, WatchSnapshot } from '@/engine/types';
import { inlineValuesFor, lineStateAt, overlayText } from '@/ui/inlineValues';

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function snapshot(lineStates: WatchSnapshot['lineStates']): WatchSnapshot {
  return emptyWatch({ status: 'ok', lineStates });
}

describe('inlineValuesFor', () => {
  it('shows what each line produced, not every variable in scope', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('a', '1')] },
      { line: 3, vars: [variable('a', '1'), variable('b', '2')] },
    ]);

    const overlays = inlineValuesFor(watch);

    expect(overlays.map((overlay) => overlay.line)).toEqual([2, 3]);
    expect(overlays[1]?.text).toBe('b = 2');
    expect(overlays[1]?.names).toEqual(['b']);
    // A line that changed nothing produces no overlay at all.
    expect(overlays.some((overlay) => overlay.text.includes('a = 1'))).toBe(true);
  });

  it('skips lines whose values did not change', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('a', '1')] },
      { line: 3, vars: [variable('a', '1')] },
      { line: 4, vars: [variable('a', '2')] },
    ]);

    expect(inlineValuesFor(watch).map((overlay) => overlay.line)).toEqual([2, 4]);
  });

  it('caps the names per line and reports how many were hidden', () => {
    const watch = snapshot([
      {
        line: 5,
        vars: [
          variable('a', '1'),
          variable('b', '2'),
          variable('c', '3'),
          variable('d', '4'),
          variable('e', '5'),
        ],
      },
    ]);

    const overlay = inlineValuesFor(watch)[0];
    expect(overlay?.names).toEqual(['a', 'b', 'c']);
    expect(overlay?.hiddenCount).toBe(2);
    expect(overlayText(overlay!)).toBe('// a = 1, b = 2, c = 3 (+2)');
  });

  it('shortens very long values so the line stays readable', () => {
    const watch = snapshot([{ line: 2, vars: [variable('text', 'x'.repeat(80))] }]);
    const overlay = inlineValuesFor(watch)[0];

    // The cap applies to the value, not to the `name = ` prefix.
    const shownValue = overlay?.text.split(' = ')[1] ?? '';
    expect(shownValue.length).toBeLessThanOrEqual(28);
    expect(shownValue.endsWith('…')).toBe(true);
  });

  it('produces nothing for a program that never ran', () => {
    expect(inlineValuesFor(emptyWatch())).toEqual([]);
  });
});

describe('lineStateAt', () => {
  it('returns the state recorded for a line', () => {
    const watch = snapshot([{ line: 7, vars: [variable('n', '9')] }]);
    expect(lineStateAt(watch, 7)?.map((item) => item.value)).toEqual(['9']);
    expect(lineStateAt(watch, 8)).toBeUndefined();
  });
});
