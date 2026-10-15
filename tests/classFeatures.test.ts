import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Constructors, destructors, default arguments and operator overloading.
 *
 * These are the things a class means in practice: it builds itself, it cleans up after
 * itself, it can be called with fewer arguments than it declares, and `a + b` on two
 * objects means what the class says rather than the two objects' bytes.
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

describe('constructors', () => {
  it('run when an object is created', () => {
    const { result, messages } = run(
      program(
        'class Counter {',
        'public:',
        '    int value;',
        '    Counter() { value = 42; }',
        '};',
        'int main() {',
        '    Counter counter;',
        '    std::cout << counter.value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('take arguments with braces', () => {
    const { result } = run(
      program(
        'class Point {',
        'public:',
        '    int x; int y;',
        '    Point(int a, int b) { x = a; y = b; }',
        '};',
        'int main() {',
        '    Point p{3, 4};',
        '    std::cout << p.x << " " << p.y << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('3 4\n');
  });

  it('can call a method while building', () => {
    const { result } = run(
      program(
        'class Box {',
        'public:',
        '    int size;',
        '    void grow(int amount) { size = size + amount; }',
        '    Box() { size = 0; grow(5); }',
        '};',
        'int main() {',
        '    Box box;',
        '    std::cout << box.size << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('5\n');
  });

  it('refuse a call with an arity they do not have', () => {
    const { result } = run(
      program(
        'class Only {',
        'public:',
        '    int value;',
        '    Only(int start) { value = start; }',
        '};',
        'int main() {',
        '    Only wrong;',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('no constructor taking 0');
  });
});

describe('destructors', () => {
  it('run when a local goes out of scope, in reverse order', () => {
    const { result } = run(
      program(
        'struct Noisy {',
        '    const char* name;',
        '    ~Noisy() { std::cout << name << "\\n"; }',
        '};',
        'int main() {',
        '    Noisy first{"first"};',
        '    Noisy second{"second"};',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    // Most recent first: the reverse of construction, as C++ destroys them.
    expect(result.stdout).toBe('second\nfirst\n');
  });

  it('run at the end of an inner block', () => {
    const { result } = run(
      program(
        'struct Noisy {',
        '    const char* name;',
        '    ~Noisy() { std::cout << name << "\\n"; }',
        '};',
        'int main() {',
        '    Noisy outer{"outer"};',
        '    {',
        '        Noisy inner{"inner"};',
        '    }',
        '    std::cout << "between\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('inner\nbetween\nouter\n');
  });

  it('do not run for a global, which lives to the end of the program', () => {
    const { result } = run(
      program(
        'struct Noisy {',
        '    ~Noisy() { std::cout << "destroyed\\n"; }',
        '};',
        'Noisy global;',
        'int main() {',
        '    std::cout << "main\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('main\n');
  });
});

describe('default arguments', () => {
  it('fill in what the caller leaves out', () => {
    const { result } = run(
      program(
        'int add(int a, int b = 5, int c = 100) { return a + b + c; }',
        'int main() {',
        '    std::cout << add(1) << " " << add(1, 2) << " " << add(1, 2, 3) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('106 103 6\n');
  });

  it('may be an expression, evaluated at the call', () => {
    const { result } = run(
      program(
        'int scale(int value, int factor = 2 * 3) { return value * factor; }',
        'int main() {',
        '    std::cout << scale(7) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('refuse a call that is short with nothing to fill the gap', () => {
    const { result } = run(
      program(
        'int add(int a, int b) { return a + b; }',
        'int main() {',
        '    std::cout << add(1) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('too few arguments');
  });
});

describe('operator overloading', () => {
  it('a free operator function is used for +', () => {
    const { result } = run(
      program(
        'struct Number { int value; };',
        'Number operator+(Number a, Number b) {',
        '    Number sum;',
        '    sum.value = a.value + b.value;',
        '    return sum;',
        '}',
        'int main() {',
        '    Number a{3};',
        '    Number b{4};',
        '    std::cout << (a + b).value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7\n');
  });

  it('works for comparison operators too', () => {
    const { result } = run(
      program(
        'struct Number { int value; };',
        'bool operator==(Number a, Number b) { return a.value == b.value; }',
        'int main() {',
        '    Number a{3};',
        '    Number b{3};',
        '    Number c{4};',
        '    std::cout << (a == b) << " " << (a == c) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('1 0\n');
  });

  it('a class that defines + is not added byte by byte instead', () => {
    const { result } = run(
      program(
        'struct Wrapped { int value; };',
        'Wrapped operator+(Wrapped a, Wrapped b) {',
        '    Wrapped out;',
        '    out.value = 100 + a.value + b.value;',
        '    return out;',
        '}',
        'int main() {',
        '    Wrapped a{1};',
        '    Wrapped b{2};',
        '    std::cout << (a + b).value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('103\n');
  });
});
