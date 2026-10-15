import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Lambdas: a function with no name, plus what it captured.
 *
 * The capture list is the whole point. A by-value capture is a copy taken when the
 * lambda is made, so a later change to the original is not seen; a by-reference capture
 * is the address, so it is seen and can be written through. Getting either backwards
 * produces a wrong answer that looks plausible, which is the one thing this engine must
 * not do.
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

function program(...lines: string[]): string {
  return ['#include <iostream>', ...lines].join('\n');
}

describe('calling a lambda', () => {
  it('can be called where it is written', () => {
    const { result, messages } = run(
      program('int main() {', '    std::cout << [](int value) { return value * 2; }(21) << "\\n";', '    return 0;', '}'),
    );

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('can be stored and called more than once', () => {
    const { result } = run(
      program(
        'int main() {',
        '    auto triple = [](int value) { return value * 3; };',
        '    std::cout << triple(2) << " " << triple(5) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('6 15\n');
  });

  it('takes several parameters', () => {
    const { result } = run(
      program(
        'int main() {',
        '    auto add = [](int a, int b) { return a + b; };',
        '    std::cout << add(3, 4) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.stdout).toBe('7\n');
  });

  it('may return nothing', () => {
    const { result } = run(
      program(
        'int main() {',
        '    auto shout = []() { std::cout << "hey\\n"; };',
        '    shout();',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('hey\n');
  });
});

describe('captures', () => {
  it('by value keeps a copy, so a later change is not seen', () => {
    const { result } = run(
      program(
        'int main() {',
        '    int counter = 3;',
        '    auto snapshot = [counter]() { return counter; };',
        '    counter = 99;',
        '    std::cout << snapshot() << " " << counter << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('3 99\n');
  });

  it('by reference sees the change, and can make one', () => {
    const { result } = run(
      program(
        'int main() {',
        '    int counter = 3;',
        '    auto live = [&counter]() { counter = counter + 1; return counter; };',
        '    live();',
        '    live();',
        '    std::cout << counter << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('5\n');
  });

  it('[=] copies everything visible', () => {
    const { result } = run(
      program(
        'int main() {',
        '    int a = 2;',
        '    int b = 5;',
        '    auto sum = [=]() { return a + b; };',
        '    a = 100;',
        '    std::cout << sum() << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7\n');
  });

  it('[&] refers to everything visible', () => {
    const { result } = run(
      program(
        'int main() {',
        '    int total = 0;',
        '    auto bump = [&]() { total = total + 10; };',
        '    bump();',
        '    bump();',
        '    bump();',
        '    std::cout << total << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('30\n');
  });

  it('captures a string by value', () => {
    const { result } = run(
      program(
        '#include <string>',
        'int main() {',
        '    std::string name = "khoa";',
        '    auto greet = [name]() { std::cout << "hi " << name << "\\n"; };',
        '    name = "other";',
        '    greet();',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('hi khoa\n');
  });
});

describe('lambdas as values', () => {
  it('pass through a function pointer parameter', () => {
    const { result } = run(
      program(
        'int apply(int (*operation)(int), int value) { return operation(value); }',
        'int main() {',
        '    auto double_it = [](int value) { return value * 2; };',
        '    std::cout << apply(double_it, 21) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('live inside std::function', () => {
    const { result } = run(
      program(
        '#include <functional>',
        'int apply(std::function<int(int)> operation, int value) { return operation(value); }',
        'int main() {',
        '    std::function<int(int)> square = [](int value) { return value * value; };',
        '    std::cout << square(6) << " " << apply(square, 3) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('36 9\n');
  });

  it('a lambda with no captures is still callable after the enclosing block', () => {
    const { result } = run(
      program(
        'int main() {',
        '    auto twice = []() { return 0; };',
        '    {',
        '        auto inner = [](int value) { return value + 1; };',
        '        std::cout << inner(41);',
        '    }',
        '    std::cout << " " << twice() << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42 0\n');
  });
});
