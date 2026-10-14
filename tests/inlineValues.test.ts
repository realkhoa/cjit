import { describe, expect, it } from 'vitest';
import { emptyWatch } from '@/engine/types';
import type { VarNode, WatchSnapshot } from '@/engine/types';
import {
  inlineDecorationSpecs,
  inlineValuesFor,
  lineStateAt,
  overlayText,
} from '@/ui/inlineValues';

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

  it('marks the line that produced a value differently from an in-scope one', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('a', '1')] },
      { line: 3, vars: [variable('a', '1'), variable('b', '2')] },
      { line: 4, vars: [variable('a', '1'), variable('b', '2')] },
    ]);

    const overlays = inlineValuesFor(watch);

    expect(overlays.map((overlay) => overlay.line)).toEqual([2, 3, 4]);
    expect(overlays[1]?.kind).toBe('changed');
    expect(overlays[1]?.text).toBe('b = 2');
    // Line 4 changed nothing, so it shows what was in scope there.
    expect(overlays[2]?.kind).toBe('scope');
    expect(overlays[2]?.text).toBe('a = 1, b = 2');
  });

  it('never shows globals as the in-scope fallback', () => {
    const watch = snapshot([
      { line: 2, vars: [{ name: 'g', type: 'int', value: '7', scope: 'global', changed: false }] },
    ]);

    expect(inlineValuesFor(watch)).toEqual([]);
  });

  it('shows the values in scope on a line that only printed something', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('total', '6')] },
      { line: 3, vars: [variable('total', '6')] },
    ]);

    const overlay = inlineValuesFor(watch)[1];
    expect(overlay?.kind).toBe('scope');
    expect(overlay?.text).toBe('total = 6');
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

  it('flattens newlines and tabs, because Monaco injects one line only', () => {
    const watch = snapshot([{ line: 2, vars: [variable('text', 'a\nb\tc')] }]);
    const overlay = inlineValuesFor(watch)[0];

    expect(overlay?.text).toBe('text = a\\nb\\tc');
    expect(overlay?.text).not.toMatch(/[\r\n\t]/);
  });
});

describe('inlineDecorationSpecs', () => {
  it('spans the whole line, so the injected text lands after the code', () => {
    const watch = snapshot([{ line: 3, vars: [variable('total', '6')] }]);

    const specs = inlineDecorationSpecs(watch, (line) => (line === 3 ? 20 : 0));

    expect(specs).toHaveLength(1);
    expect(specs[0]?.line).toBe(3);
    expect(specs[0]?.startColumn).toBe(1);
    // Monaco renders `after` content at the range's end: it must be the line end.
    expect(specs[0]?.endColumn).toBe(21);
    expect(specs[0]?.content.trim()).toBe('// total = 6');
  });

  it('lines the comments up in a column so the code stays readable', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('a', '1')] },
      { line: 3, vars: [variable('b', '2')] },
    ]);

    // Line 2 is short, line 3 is long.
    const specs = inlineDecorationSpecs(watch, (line) => (line === 2 ? 10 : 100));
    const nbsp = '\u00A0';

    // Short line: the comment starts at the fixed column (60), i.e. 49 padding
    // cells after a 10-character line ending at column 11.
    expect(specs[0]?.content.startsWith(nbsp.repeat(49))).toBe(true);
    expect(specs[0]?.content.trimStart().startsWith('//')).toBe(true);

    // Long line: it cannot reach column 60, so it keeps a minimum gap of 4.
    expect(specs[1]?.content.startsWith(`${nbsp.repeat(4)}//`)).toBe(true);
  });

  it('pads with non-breaking spaces so HTML cannot collapse the gap', () => {
    const watch = snapshot([{ line: 2, vars: [variable('a', '1')] }]);

    const content = inlineDecorationSpecs(watch, () => 5)[0]?.content ?? '';
    // Ordinary spaces would be collapsed by the browser; U+00A0 is not.
    expect(content).not.toContain('  ');
    expect(content).toContain('\u00A0');
  });

  it('styles produced values differently from in-scope values', () => {
    const watch = snapshot([
      { line: 2, vars: [variable('a', '1')] },
      { line: 3, vars: [variable('a', '1')] },
      { line: 4, vars: [variable('a', '2')] },
    ]);

    const specs = inlineDecorationSpecs(watch, () => 10);
    // The first line has nothing to compare against, so it counts as in-scope.
    expect(specs[0]?.className).toContain('cjit-inline-value--scope');
    expect(specs[1]?.className).toContain('cjit-inline-value--scope');
    // Line 4 changed a, so it is a produced value.
    expect(specs[2]?.className).toBe('cjit-inline-value');
  });

  it('never emits a multi-line content string', () => {
    const watch = snapshot([{ line: 1, vars: [variable('s', 'x\ny')] }]);
    const specs = inlineDecorationSpecs(watch, () => 5);

    expect(specs[0]?.content).not.toMatch(/[\r\n]/);
  });

  it('emits nothing when there is nothing to show', () => {
    expect(inlineDecorationSpecs(emptyWatch(), () => 10)).toEqual([]);
  });
});

describe('lineStateAt', () => {
  it('returns the state recorded for a line', () => {
    const watch = snapshot([{ line: 7, vars: [variable('n', '9')] }]);
    expect(lineStateAt(watch, 7)?.map((item) => item.value)).toEqual(['9']);
    expect(lineStateAt(watch, 8)).toBeUndefined();
  });
});
