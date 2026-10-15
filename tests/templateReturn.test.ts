import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Template functions whose return type is the template parameter.
 *
 * `template <typename T> T bigger(T, T)` printed 4.4e-323 for bigger(3, 9): the value
 * was written as an int and read back as a float64, eight bytes of which four were
 * zero. A wrong number that looks like a number is the worst kind of bug in a tool
 * meant for learning, so the width of what was actually written decides how it is read
 * back.
 */

const BIGGER = [
  '#include <iostream>',
  'template <typename T>',
  'T bigger(T left, T right) {',
  '    return left > right ? left : right;',
  '}',
  'int main() {',
  '    int a = bigger(3, 9);',
  '    double b = bigger(2.5, 1.5);',
  '    long c = bigger(7L, 4L);',
  '    return 0;',
  '}',
].join('\n');

function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.cpp');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

function valueOf(source: string, name: string): { value: string; type: string } {
  const item = run(source).vars.find((candidate) => candidate.name === name);
  expect(item, `${name} was not in the watch snapshot`).toBeDefined();
  return { value: item?.value ?? '', type: item?.type ?? '' };
}

describe('a template function returning T', () => {
  it('keeps the int result an int', () => {
    const { value, type } = valueOf(BIGGER, 'a');
    expect(value).toBe('9');
    expect(type).toBe('int');
  });

  it('keeps the double result a double', () => {
    expect(valueOf(BIGGER, 'b').value).toBe('2.5');
  });

  it('keeps the long result a long', () => {
    expect(valueOf(BIGGER, 'c')).toEqual({ value: '7', type: 'long' });
  });

  it('prints each instantiation correctly, one after another', () => {
    const result = run(
      [
        '#include <iostream>',
        'template <typename T>',
        'T bigger(T left, T right) {',
        '    return left > right ? left : right;',
        '}',
        'int main() {',
        '    std::cout << bigger(3, 9) << "\\n";',
        '    std::cout << bigger(2.5, 1.5) << "\\n";',
        '    std::cout << bigger(7L, 4L) << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('9\n2.5\n7\n');
  });

  it('still works when the template is only used through a container', () => {
    // The shape the bundled tour uses: a template over T that returns T, called
    // with the element type of a vector.
    const result = run(
      [
        '#include <vector>',
        'template <typename T>',
        'T firstOf(const std::vector<T>& values) {',
        '    T chosen{};',
        '    for (const auto& value : values) {',
        '        if (value > chosen) chosen = value;',
        '    }',
        '    return chosen;',
        '}',
        'int main() {',
        '    std::vector<int> values{2, 8, 5};',
        '    int best = firstOf(values);',
        '    return best;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.exitCode).toBe(8);
  });
});
