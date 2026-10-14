import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecuteOptions, ExecutionResult } from '@/lang/runtime/interpreter';

function run(source: string, options: ExecuteOptions = {}): ExecutionResult {
  const analysis = analyzeSource(source, 'main.c');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, options);
}

function stdoutOf(source: string, options: ExecuteOptions = {}): string {
  return run(source, options).stdout;
}

describe('interpreter: basics', () => {
  it('runs hello world and reports a clean exit', () => {
    const result = run('#include <stdio.h>\nint main(void) { printf("hello\\n"); return 0; }\n');

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('ok');
  });

  it('works without any #include (implicit headers)', () => {
    expect(stdoutOf('int main(void) { printf("hi\\n"); return 0; }')).toBe('hi\n');
  });

  it('evaluates arithmetic with correct precedence', () => {
    expect(stdoutOf('int main(void) { int a = 2; int b = 3; printf("%d\\n", a * b + 1); return 0; }')).toBe('7\n');
  });

  it('wraps 32-bit integers like C does', () => {
    const source = 'int main(void) { int big = 2147483647; big = big + 1; printf("%d\\n", big); return 0; }';
    expect(stdoutOf(source)).toBe('-2147483648\n');
  });

  it('uses the exit code from return', () => {
    expect(run('int main(void) { return 3; }').exitCode).toBe(3);
  });

  it('honours exit()', () => {
    const result = run('int main(void) { printf("a"); exit(7); printf("b"); }');
    expect(result.stdout).toBe('a');
    expect(result.exitCode).toBe(7);
  });
});

describe('interpreter: control flow', () => {
  it('sums a for loop', () => {
    const source = [
      'int main(void) {',
      '    int total = 0;',
      '    for (int i = 1; i <= 10; i++) { total += i; }',
      '    printf("%d\\n", total);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('55\n');
  });

  it('runs while, do/while, break and continue', () => {
    const source = [
      'int main(void) {',
      '    int i = 0;',
      '    int total = 0;',
      '    while (i < 10) { i++; if (i % 2 == 0) continue; if (i > 7) break; total += i; }',
      '    do { total++; } while (total < 20);',
      '    printf("%d\\n", total);',
      '    return 0;',
      '}',
    ].join('\n');
    // 1+3+5+7 = 16, then the do/while runs until 20.
    expect(stdoutOf(source)).toBe('20\n');
  });

  it('handles switch with fall-through and default', () => {
    const source = [
      'int main(void) {',
      '    int total = 0;',
      '    for (int i = 1; i <= 4; i++) {',
      '        switch (i) {',
      '            case 1:',
      '            case 2: total += 10; break;',
      '            case 3: total += 100;',
      '            default: total += 1;',
      '        }',
      '    }',
      '    printf("%d\\n", total);',
      '    return 0;',
      '}',
    ].join('\n');
    // i=1,2 -> +10; i=3 -> +100 +1; i=4 -> default +1
    expect(stdoutOf(source)).toBe('122\n');
  });

  it('supports goto and labels', () => {
    const source = [
      'int main(void) {',
      '    int i = 0;',
      'again:',
      '    i++;',
      '    if (i < 5) goto again;',
      '    printf("%d\\n", i);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('5\n');
  });
});

describe('interpreter: functions', () => {
  it('calls functions and recurses', () => {
    const source = [
      'int factorial(int n) { return n <= 1 ? 1 : n * factorial(n - 1); }',
      'int main(void) { printf("%d\\n", factorial(5)); return 0; }',
    ].join('\n');
    expect(stdoutOf(source)).toBe('120\n');
  });

  it('passes by value and mutates through pointers', () => {
    const source = [
      'void bump(int *p) { *p = *p + 1; }',
      'int main(void) { int x = 5; bump(&x); printf("%d\\n", x); return 0; }',
    ].join('\n');
    expect(stdoutOf(source)).toBe('6\n');
  });

  it('calls through a function pointer', () => {
    const source = [
      'int add(int a, int b) { return a + b; }',
      'int apply(int (*fn)(int, int), int x, int y) { return fn(x, y); }',
      'int main(void) { printf("%d\\n", apply(add, 2, 3)); return 0; }',
    ].join('\n');
    expect(stdoutOf(source)).toBe('5\n');
  });
});

describe('interpreter: memory model', () => {
  it('reads and writes arrays', () => {
    const source = [
      'int main(void) {',
      '    int values[4] = {1, 2, 3, 4};',
      '    int total = 0;',
      '    for (int i = 0; i < 4; i++) { total += values[i]; }',
      '    values[0] = 10;',
      '    printf("%d %d\\n", total, values[0] + values[1]);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('10 12\n');
  });

  it('walks a string with pointer arithmetic', () => {
    const source = [
      'int main(void) {',
      '    char text[] = "abc";',
      '    char *p = text;',
      '    int count = 0;',
      '    while (*p != 0) { count++; p++; }',
      '    printf("%d\\n", count);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('3\n');
  });

  it('lays out and mutates structs', () => {
    const source = [
      'struct Point { int x; int y; };',
      'int main(void) {',
      '    struct Point p = {1, 2};',
      '    struct Point *q = &p;',
      '    q->x = 5;',
      '    printf("%d %d %d\\n", p.x, p.y, (int)sizeof(struct Point));',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('5 2 8\n');
  });

  it('allocates with malloc and reads it back', () => {
    const source = [
      'int main(void) {',
      '    int *values = (int *)malloc(3 * sizeof(int));',
      '    for (int i = 0; i < 3; i++) { values[i] = i * i; }',
      '    int total = 0;',
      '    for (int i = 0; i < 3; i++) { total += values[i]; }',
      '    free(values);',
      '    printf("%d\\n", total);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('5\n');
  });

  it('works with the string library', () => {
    const source = [
      'int main(void) {',
      '    char buffer[32];',
      '    strcpy(buffer, "hello");',
      '    strcat(buffer, " world");',
      '    printf("%d %d\\n", (int)strlen(buffer), strcmp("a", "b") < 0);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source)).toBe('11 1\n');
  });
});

describe('interpreter: printf', () => {
  it('formats integers in every base and with flags', () => {
    const source =
      'int main(void) { printf("%d|%u|%x|%X|%o|%5d|%-5d|%05d|%+d|%%\\n", 255, 255, 255, 255, 255, 42, 42, 42, 42); return 0; }';
    expect(stdoutOf(source)).toBe('255|255|ff|FF|377|   42|42   |00042|+42|%\n');
  });

  it('formats floats with precision', () => {
    const source = 'int main(void) { printf("%.3f|%.1f|%8.2f\\n", sqrt(2.0), 2.5, 3.14159); return 0; }';
    expect(stdoutOf(source)).toBe('1.414|2.5|    3.14\n');
  });

  it('prints characters, strings and pointers', () => {
    const source = 'int main(void) { printf("%c-%s-%s\\n", 65, "ok", (char *)0); return 0; }';
    expect(stdoutOf(source)).toBe('A-ok-(null)\n');
  });
});

describe('interpreter: stdin', () => {
  it('reads two numbers with scanf', () => {
    const source = [
      'int main(void) {',
      '    int a = 0;',
      '    int b = 0;',
      '    scanf("%d %d", &a, &b);',
      '    printf("%d\\n", a + b);',
      '    return 0;',
      '}',
    ].join('\n');
    expect(stdoutOf(source, { stdin: '4 38\n' })).toBe('42\n');
  });

  it('reads characters with getchar', () => {
    const source = 'int main(void) { int c = getchar(); printf("%d\\n", c); return 0; }';
    expect(stdoutOf(source, { stdin: 'A' })).toBe('65\n');
  });
});

describe('interpreter: failure modes are reported, never faked', () => {
  it('catches division by zero', () => {
    const result = run('int main(void) { int z = 0; printf("%d", 1 / z); return 0; }');
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('division by zero');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  it('catches a null pointer dereference', () => {
    const result = run('int main(void) { int *p = 0; printf("%d", *p); return 0; }');
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('null pointer');
  });

  it('stops an infinite loop with a budget instead of hanging', () => {
    const result = run('int main(void) { int i = 0; while (1) { i++; } return 0; }', {
      maxSteps: 200_000,
      maxMillis: 60_000,
    });
    expect(result.status).toBe('budget');
    expect(result.detail).toContain('infinite loop');
    expect(result.frames.map((frame) => frame.function)).toContain('main');
  });

  it('reports a missing main', () => {
    const result = run('int helper(void) { return 1; }');
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('no main');
  });

  it('reports a prototype-only function as a real error', () => {
    const result = run('int later(int);\nint main(void) { return later(1); }');
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('no body');
  });

  it('reports an unimplemented library function by name', () => {
    const result = run('int main(void) { return fopen("x", "r") != 0; }');
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('fopen');
  });

  it('warns when an uninitialized variable is read', () => {
    const result = run('int main(void) { int x; printf("%d\\n", x); return 0; }');
    expect(result.diagnostics.some((item) => item.message.includes('uninitialized'))).toBe(true);
  });
});

describe('interpreter: watch values', () => {
  it('reports final variable values with their real types', () => {
    const source = [
      'int main(void) {',
      '    int answer = 42;',
      '    double ratio = 1.5;',
      '    int i;',
      '    for (i = 0; i < 3; i++) { }',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);

    const byName = new Map(result.vars.map((item) => [item.name, item]));
    expect(byName.get('answer')?.value).toBe('42');
    expect(byName.get('answer')?.type).toBe('int');
    expect(byName.get('ratio')?.value).toBe('1.5');
    expect(byName.get('i')?.value).toBe('3');
    expect(byName.get('i')?.scope).toBe('main');
    expect(result.historyLength).toBeGreaterThan(0);
  });

  it('expands struct members and array elements', () => {
    const source = [
      'struct Point { int x; int y; };',
      'int main(void) {',
      '    struct Point p = {1, 2};',
      '    int values[3] = {7, 8, 9};',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);

    const point = result.vars.find((item) => item.name === 'p');
    expect(point?.type).toBe('struct Point');
    expect(point?.children?.map((child) => `${child.name}=${child.value}`)).toEqual(['x=1', 'y=2']);

    const values = result.vars.find((item) => item.name === 'values');
    expect(values?.children?.map((child) => child.value)).toEqual(['7', '8', '9']);
  });

  it('follows a pointer to the value it points at', () => {
    const source = [
      'int main(void) {',
      '    int x = 99;',
      '    int *p = &x;',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);
    const pointer = result.vars.find((item) => item.name === 'p');
    expect(pointer?.value).toMatch(/^0x/);
    expect(pointer?.children?.[0]?.value).toBe('99');
  });

  it('skips header globals such as stdout', () => {
    const result = run('int main(void) { int mine = 1; return 0; }');
    const names = result.vars.map((item) => item.name);
    expect(names).toContain('mine');
    expect(names).not.toContain('stdout');
  });

  it('does not collect the timeline for a plain run', () => {
    const source = 'int main(void) { int a = 1; a = 2; return 0; }';
    const withWatch = run(source, { collectWatch: true });
    const without = run(source, { collectWatch: false });
    expect(withWatch.historyLength).toBeGreaterThan(0);
    expect(without.historyLength).toBe(0);
    expect(without.vars).toEqual([]);
  });
});

describe('interpreter: per-line state (watch at the cursor line)', () => {
  const PROGRAM = [
    'int main(void) {', //                                     1
    '    int total = 0;', //                                   2
    '    for (int i = 1; i <= 3; i++) {', //                   3
    '        total += i;', //                                  4
    '    }', //                                                5
    '    printf("%d\\n", total);', //                          6
    '    return 0;', //                                        7
    '}', //                                                    8
  ].join('\n');

  it('records the state the first time each line ran', () => {
    const result = run(PROGRAM);

    const valueAt = (line: number, name: string): string | undefined =>
      result.lineStates.find((state) => state.line === line)?.vars.find((item) => item.name === name)
        ?.value;

    expect(valueAt(2, 'total')).toBe('0');
    // Line 4 runs three times; the first run is what a breakpoint would show.
    expect(valueAt(4, 'total')).toBe('1');
    expect(valueAt(4, 'i')).toBe('1');
    // By the printf, the loop has finished.
    expect(valueAt(6, 'total')).toBe('6');
  });

  it('keys the states by line and keeps them ascending', () => {
    const lines = run(PROGRAM).lineStates.map((state) => state.line);
    expect(lines.length).toBeGreaterThan(3);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it('records nothing when watch collection is off', () => {
    const result = run('int main(void) { int a = 1; return 0; }', { collectWatch: false });
    expect(result.lineStates).toEqual([]);
  });
});

describe('interpreter: execution history (timeline scrubber)', () => {
  it('captures a full state for each declaration and assignment', () => {
    const source = [
      'int main(void) {',
      '    int a = 1;',
      '    a = 2;',
      '    a += 3;',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);

    const trace = result.history.map(
      (entry) => `${entry.name}@${entry.line}=${entry.vars.find((item) => item.name === 'a')?.value}`,
    );
    expect(trace[0]).toBe('a@2=1');
    expect(trace[1]).toBe('a@3=2');
    expect(trace[2]).toBe('a@4=5');
    expect(result.historyLength).toBe(result.history.length);
  });

  it('records inside loops, one state per assignment', () => {
    const source = [
      'int main(void) {',
      '    int total = 0;',
      '    for (int i = 0; i < 3; i++) {',
      '        total += i;',
      '    }',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);

    const totals = result.history
      .filter((entry) => entry.name === 'total')
      .map((entry) => entry.vars.find((item) => item.name === 'total')?.value);
    expect(totals).toEqual(['0', '0', '1', '3']);
  });

  it('stops at the snapshot cap and flags the truncation', () => {
    const source = [
      'int main(void) {',
      '    int total = 0;',
      '    for (int i = 0; i < 50; i++) { total += i; }',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source, { maxSnapshots: 5 });

    expect(result.history).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('keeps history out of a plain run', () => {
    const result = run('int main(void) { int a = 1; a = 2; return 0; }', { collectWatch: false });
    expect(result.history).toEqual([]);
  });
});

describe('interpreter: loop iterations (one entry per loop pass)', () => {
  const LOOP = [
    'int main(void) {', //                              1
    '    int total = 0;', //                            2
    '    for (int i = 0; i < 3; i++) {', //             3
    '        total += i;', //                           4
    '    }', //                                         5
    '    return 0;', //                                 6
    '}', //                                             7
  ].join('\n');

  it('records one entry per pass, numbered per loop, with the state it left', () => {
    const result = run(LOOP);
    const passes = result.history.filter((entry) => entry.kind === 'loop-iteration');

    expect(passes).toHaveLength(3);
    expect(passes.map((entry) => entry.iteration)).toEqual([1, 2, 3]);
    expect(passes.every((entry) => entry.line === 3)).toBe(true);
    expect(passes.every((entry) => entry.depth === 1)).toBe(true);

    // Captured after the increment, so the counter has already advanced.
    expect(passes.map((entry) => entry.vars.find((item) => item.name === 'i')?.value)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(passes.map((entry) => entry.vars.find((item) => item.name === 'total')?.value)).toEqual([
      '0',
      '1',
      '3',
    ]);

    // The lines the pass ran, so a caret inside the body finds this loop.
    expect(passes[0]?.lines).toEqual(expect.arrayContaining([3, 4]));
  });

  it('numbers nested loops independently and records their depth', () => {
    const source = [
      'int main(void) {', //                                    1
      '    int count = 0;', //                                  2
      '    for (int i = 0; i < 2; i++) {', //                   3
      '        for (int j = 0; j < 2; j++) {', //               4
      '            count++;', //                                5
      '        }', //                                           6
      '    }', //                                               7
      '    return 0;', //                                       8
      '}',
    ].join('\n');
    const result = run(source);
    const passes = result.history.filter((entry) => entry.kind === 'loop-iteration');

    const inner = passes.filter((entry) => entry.depth === 2);
    const outer = passes.filter((entry) => entry.depth === 1);

    expect(inner).toHaveLength(4);
    expect(outer).toHaveLength(2);
    expect(inner.map((entry) => entry.iteration)).toEqual([1, 2, 1, 2]);
    expect(outer.map((entry) => entry.iteration)).toEqual([1, 2]);
    // An outer pass shows that it also ran the inner loop's lines.
    expect(outer[0]?.lines).toEqual(expect.arrayContaining([3, 4, 5]));
  });

  it('does not record a pass that break cut short', () => {
    const source = [
      'int main(void) {',
      '    for (int i = 0; i < 5; i++) {',
      '        if (i == 2) break;',
      '    }',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);

    // i = 0 and i = 1 finish; the pass that breaks is not a completed iteration.
    expect(result.history.filter((entry) => entry.kind === 'loop-iteration')).toHaveLength(2);
  });

  it('records while, do-while and range-based for passes as well', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    int n = 0;',
      '    while (n < 2) { n++; }',
      '    do { n--; } while (n > 0);',
      '    std::vector<int> values{1, 2, 3};',
      '    int total = 0;',
      '    for (int v : values) { total += v; }',
      '    return 0;',
      '}',
    ].join('\n');
    const result = run(source);
    const byLine = new Map<number, number>();
    for (const entry of result.history) {
      if (entry.kind !== 'loop-iteration') continue;
      byLine.set(entry.line, (byLine.get(entry.line) ?? 0) + 1);
    }

    expect(byLine.get(4)).toBe(2); // while
    expect(byLine.get(5)).toBe(2); // do-while
    expect(byLine.get(8)).toBe(3); // range-based for
  });
});
