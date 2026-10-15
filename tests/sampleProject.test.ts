import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import { EXAMPLES, SAMPLE_HELLO_C, SAMPLE_MAIN_CPP, SAMPLE_UTIL_H } from '@/examples/sample';

/**
 * The bundled project has to actually work.
 *
 * It is the default workspace, so the pane on the right analyses it every second:
 * a sample that does not run would make the first impression a broken one. And it
 * is the checklist for the STL support - so it is run here, not just parsed.
 */

function runExample(path: string): { status: string; stdout: string; detail: string } {
  const files = new Map(EXAMPLES.map((file) => [file.path, file.code]));
  const analysis = analyzeSource(files.get(path) ?? '', path, { files });

  expect(
    analysis.errorCount,
    `parse errors in ${path}: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);

  const result = execute(analysis.unit, { collectWatch: true });
  return { status: result.status, stdout: result.stdout, detail: result.detail };
}

describe('the bundled C++ tour', () => {
  const run = runExample('main.cpp');

  it('runs to the end', () => {
    expect(run.status, run.detail).toBe('ok');
  });

  it('prints what each container and algorithm produced', () => {
    expect(run.stdout).toContain('sorted: [1, 1, 2, 3, 4, 5, 6, 9]');
    expect(run.stdout).toContain('sum = 31');
    expect(run.stdout).toContain('min = 1, max = 9');
    expect(run.stdout).toContain('has 5: 1');
    expect(run.stdout).toContain('iota+reverse: [13, 12, 11, 10]');
    expect(run.stdout).toContain('distinct = 7');
    expect(run.stdout).toContain('red appears 3 times');
    expect(run.stdout).toContain('best = green:1');
    expect(run.stdout).toContain('fifo front = 1, size = 3');
    expect(run.stdout).toContain('lifo top = 2');
    expect(run.stdout).toContain('largest = 9');
    expect(run.stdout).toContain('deque front = 1, back = 3');
    // A template function returning T, instantiated for int and for double. This
    // printed 4.4e-323 (the int 9 read as a double) before the slot-width fix.
    expect(run.stdout).toContain('bigger(3, 9) = 9');
    expect(run.stdout).toContain('bigger(2.5, 1.5) = 2.5');
  });

  it('shows the containers in the watch snapshot, not just their printed form', () => {
    const files = new Map(EXAMPLES.map((file) => [file.path, file.code]));
    const analysis = analyzeSource(files.get('main.cpp') ?? '', 'main.cpp', { files });
    const result = execute(analysis.unit, { collectWatch: true });

    const shown = (name: string): string | undefined =>
      result.vars.find((item) => item.name === name)?.value;

    expect(shown('nums')).toBe('[1, 1, 2, 3, 4, 5, 6, 9]');
    expect(shown('unique')).toBe('{1, 2, 3, 4, 5, 6, 9}');
    expect(shown('counts')).toContain('"red": 3');
    expect(shown('best')).toBe('("green", 1)');
    expect(shown('fifo')).toBe('[1, 2, 3]');
    expect(shown('both')).toBe('[1, 2, 3]');
  });

  it('uses the module from util.h', () => {
    expect(SAMPLE_MAIN_CPP).toContain('#include "util.h"');
    expect(SAMPLE_UTIL_H).toContain('#pragma once');
    // A module: no entry point of its own.
    expect(SAMPLE_UTIL_H).not.toContain('int main');
  });
});

describe('the bundled C sample', () => {
  it('prints the loop the watch pane exists for', () => {
    const run = runExample('hello.c');
    expect(run.status, run.detail).toBe('ok');
    expect(run.stdout).toContain('i = 5, i*i = 25');
    expect(SAMPLE_HELLO_C.length).toBeGreaterThan(0);
  });
});

describe('the bundled project as a whole', () => {
  it('has exactly one file with a main, so the project links', () => {
    const withMain = EXAMPLES.filter((file) => /int\s+main\s*\(/.test(file.code)).map((file) => file.path);
    // main.cpp and hello.c are both programs; the entry point decides which one
    // Run uses, and the other is reported rather than silently dropped.
    expect(withMain).toEqual(['main.cpp', 'hello.c']);
  });

  it('gives every module file #pragma once and no main', () => {
    const modules = EXAMPLES.filter((file) => !/int\s+main\s*\(/.test(file.code));
    expect(modules.map((file) => file.path)).toEqual(['util.h']);
    for (const file of modules) expect(file.code).toContain('#pragma once');
  });
});
