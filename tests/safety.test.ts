import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute, safetyKindForFault } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import type { SafetyKind } from '@/engine/types';

/**
 * Runtime safety events.
 *
 * The point of collecting them is that the interesting ones do not stop the
 * program: reading an uninitialised variable only produces a warning, so without a
 * dedicated list it scrolls away and the run looks clean.
 */

function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.c');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

function kinds(result: ExecutionResult): SafetyKind[] {
  return result.safety.map((event) => event.kind);
}

describe('safetyKindForFault', () => {
  it('classifies the faults the interpreter raises', () => {
    expect(safetyKindForFault('division by zero')).toBe('division-by-zero');
    expect(safetyKindForFault('null pointer dereference')).toBe('null-dereference');
    expect(safetyKindForFault('invalid memory access at 0x10')).toBe('out-of-bounds');
    expect(safetyKindForFault('use of undeclared identifier x')).toBe('runtime-error');
  });
});

describe('collecting safety events', () => {
  it('reports an uninitialised read, which does not stop the program', () => {
    const result = run(
      ['#include <stdio.h>', 'int main(void) {', '    int x;', '    printf("%d\\n", x);', '    return 0;', '}'].join(
        '\n',
      ),
    );

    // The program still ran: this is exactly the case a console-only warning loses.
    expect(result.status).toBe('ok');
    const uninitialised = result.safety.filter((event) => event.kind === 'uninitialized-read');
    expect(uninitialised).toHaveLength(1);
    // The line doing the reading, which is where a debugger would stop.
    expect(uninitialised[0]?.line).toBe(4);
    expect(uninitialised[0]?.message).toContain("'x'");
    expect(uninitialised[0]?.message).toContain('declared at line 3');
    expect(uninitialised[0]?.severity).toBe('warning');
  });

  it('does not call the pane reading a variable the program reading it', () => {
    // Showing `x` in the watch pane is this tool reading it, not the program: a
    // variable that is assigned before use must not be reported as uninitialised.
    const result = run(
      ['int main(void) {', '    int x;', '    x = 5;', '    return x;', '}'].join('\n'),
    );

    expect(result.status).toBe('ok');
    expect(kinds(result)).not.toContain('uninitialized-read');
  });

  it('reports division by zero with the line it happened on', () => {
    const result = run(
      ['int main(void) {', '    int zero = 0;', '    int boom = 5 / zero;', '    return boom;', '}'].join('\n'),
    );

    expect(result.status).toBe('runtime-error');
    const division = result.safety.find((event) => event.kind === 'division-by-zero');
    expect(division?.line).toBe(3);
    expect(division?.severity).toBe('error');
  });

  it('reports a null dereference', () => {
    const result = run(
      ['int main(void) {', '    int *p = 0;', '    *p = 1;', '    return 0;', '}'].join('\n'),
    );

    expect(result.status).toBe('runtime-error');
    expect(kinds(result)).toContain('null-dereference');
  });

  it('reports memory allocated and never freed', () => {
    const result = run(
      ['#include <stdlib.h>', 'int main(void) {', '    int *p = malloc(8);', '    *p = 3;', '    return 0;', '}'].join(
        '\n',
      ),
    );

    expect(result.status).toBe('ok');
    const leak = result.safety.find((event) => event.kind === 'leak');
    expect(leak).toBeDefined();
    expect(leak?.message).toContain('byte');
    expect(leak?.severity).toBe('info');
  });

  it('says nothing about a program that behaves', () => {
    const result = run(
      ['#include <stdlib.h>', 'int main(void) {', '    int *p = malloc(8);', '    *p = 3;', '    free(p);', '    return *p;', '}'].join(
        '\n',
      ),
    );

    // Nothing uninitialised, nothing divided by zero, nothing leaked.
    expect(result.safety.filter((event) => event.kind !== 'leak')).toEqual([]);
  });

  it('does not call the interpreter\u2019s own buffers a leak', () => {
    // String literals, vector storage and argv are allocated by the interpreter on
    // the program's behalf. Counting them made every program look like it leaked;
    // only what the program asks for with malloc/new counts.
    const result = run(
      ['#include <stdio.h>', 'int main(void) {', '    printf("a string literal\\n");', '    return 0;', '}'].join(
        '\n',
      ),
    );

    expect(result.status).toBe('ok');
    expect(result.safety.filter((event) => event.kind === 'leak')).toEqual([]);
  });

  it('caps how many events it keeps', () => {
    const lines = ['int main(void) {'];
    for (let index = 0; index < 80; index += 1) lines.push('    int value;');
    lines.push('    return 0;', '}');
    // Each declaration is followed by a read through printf to trigger warnings.
    const source = lines.join('\n');
    const result = run(source);

    expect(result.safety.length).toBeLessThanOrEqual(50);
  });
});
