import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * References: `int&`, `const int&`.
 *
 * A reference is its referent, not a copy and not a pointer. Modelling `&` as `*` is
 * what made `void bump(int& value)` pass the *value* (4) as an address and stop the
 * program on `invalid memory access at 0x4` - the loud kind of wrong, at least, but
 * wrong.
 *
 * What matters here: writes through a reference reach the caller's object, a `const`
 * reference refuses them, and the two rules a native compiler enforces - a plain
 * reference cannot bind a temporary, and neither can exist uninitialised - are
 * enforced rather than ignored.
 */

function run(source: string): { result: ExecutionResult; messages: string[] } {
  const analysis = analyzeSource(source, 'main.cpp');
  try {
    return {
      result: execute(analysis.unit, { collectWatch: true }),
      messages: analysis.diagnostics.map((item) => `${item.severity}: ${item.message}`),
    };
  } catch (error) {
    return {
      result: {
        status: 'threw',
        stdout: '',
        stderr: '',
        detail: error instanceof Error ? error.message : String(error),
        diagnostics: [],
      } as unknown as ExecutionResult,
      messages: analysis.diagnostics.map((item) => `${item.severity}: ${item.message}`),
    };
  }
}

function program(body: readonly string[]): string {
  return ['#include <iostream>', ...body].join('\n');
}

describe('a reference parameter is the caller\u2019s object', () => {
  it('writes reach the caller', () => {
    const { result } = run(
      program([
        'void bump(int& value) { value = value + 1; }',
        'int main() {',
        '    int x = 10;',
        '    bump(x);',
        '    std::cout << x << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('11\n');
  });

  it('two references can be swapped', () => {
    const { result } = run(
      program([
        'void swap_values(int& a, int& b) { int t = a; a = b; b = t; }',
        'int main() {',
        '    int x = 1; int y = 2;',
        '    swap_values(x, y);',
        '    std::cout << x << " " << y << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.stdout).toBe('2 1\n');
  });

  it('passes the reference on to another function', () => {
    const { result } = run(
      program([
        'void inner(int& value) { value = 5; }',
        'void outer(int& value) { inner(value); }',
        'int main() {',
        '    int x = 0;',
        '    outer(x);',
        '    std::cout << x << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.stdout).toBe('5\n');
  });

  it('a parameter that is not a reference is still a copy', () => {
    const { result } = run(
      program([
        'void noop(int value) { value = 99; }',
        'int main() {',
        '    int x = 1;',
        '    noop(x);',
        '    std::cout << x << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.stdout).toBe('1\n');
  });
});

describe('reference locals', () => {
  it('alias the object they were bound to', () => {
    const { result } = run(
      program([
        'int main() {',
        '    int number = 7;',
        '    int& alias = number;',
        '    alias = 40;',
        '    std::cout << number << " " << alias << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.stdout).toBe('40 40\n');
  });

  it('can refer to an array element', () => {
    const { result } = run(
      program([
        'int main() {',
        '    int values[3] = {1, 2, 3};',
        '    int& middle = values[1];',
        '    middle = 9;',
        '    std::cout << values[1] << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('9\n');
  });
});

describe('const references', () => {
  it('are readable', () => {
    const { result } = run(
      program([
        'int doubled(const int& value) { return value * 2; }',
        'int main() {',
        '    int x = 6;',
        '    std::cout << doubled(x) << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.stdout).toBe('12\n');
  });

  it('may bind a temporary', () => {
    const { result } = run(
      program([
        'int doubled(const int& value) { return value * 2; }',
        'int main() {',
        '    std::cout << doubled(21) << "\\n";',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('refuse to be written through, and say why', () => {
    const { result } = run(
      program([
        'void spoil(const int& value) { value = 1; }',
        'int main() {',
        '    int x = 5;',
        '    spoil(x);',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('reference to const');
    // The caller's value is untouched: a refusal is not a partial write.
    const after = run(
      program([
        'void spoil(const int& value) { value = 1; }',
        'int main() { int x = 5; spoil(x); std::cout << x << "\\n"; return 0; }',
      ]),
    );
    expect(after.result.stdout).toBe('');
  });
});

describe('what a native compiler refuses, so this does too', () => {
  it('a plain reference cannot bind a temporary', () => {
    const { result } = run(
      program([
        'void bump(int& value) { value = value + 1; }',
        'int main() {',
        '    bump(3);',
        '    return 0;',
        '}',
      ]),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('temporary');
  });

  it('a reference must be initialised', () => {
    // `int& nothing = 0;` would be a reference to a temporary, which C++ refuses. The
    // interpreter reports it in the run's own diagnostics, so that is what is checked.
    const { result } = run(program(['int main() {', '    int& nothing = 0;', '    return 0;', '}']));
    const reported = result.diagnostics.map((item) => `${item.severity}: ${item.message}`);

    expect(reported.some((message) => message.startsWith('error'))).toBe(true);
    expect(reported.join(' ')).toContain('reference');
  });
});
