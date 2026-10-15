import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * @brief Helper to analyze and execute a C++ code snippet with the fast engine.
 * @param source C++ source code text.
 * @return Execution result object.
 */
function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.cpp');
  return execute(analysis.unit, { collectWatch: true });
}

describe('function overloading', () => {
  it('selects between int and double parameters based on argument type', () => {
    const source = [
      '#include <iostream>',
      'void show(int x) { std::cout << "int:" << x << " "; }',
      'void show(double d) { std::cout << "double:" << d << " "; }',
      'int main() {',
      '    show(42);',
      '    show(3.14);',
      '    std::cout << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('int:42 double:3.14 \n');
  });

  it('differentiates overloaded functions by parameter count (arity)', () => {
    const source = [
      '#include <iostream>',
      'int add(int a, int b) { return a + b; }',
      'int add(int a, int b, int c) { return a + b + c; }',
      'int main() {',
      '    std::cout << add(10, 20) << " " << add(1, 2, 3) << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('30 6\n');
  });

  it('resolves between string and numeric types using string literal conversion', () => {
    const source = [
      '#include <iostream>',
      '#include <string>',
      'void print(int x) { std::cout << "num:" << x << " "; }',
      'void print(const std::string& s) { std::cout << "str:" << s << " "; }',
      'int main() {',
      '    print(100);',
      '    print("hello");',
      '    std::cout << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('num:100 str:hello \n');
  });

  it('supports overloaded member methods within a class', () => {
    const source = [
      '#include <iostream>',
      'struct Calculator {',
      '    int compute(int x) { return x * 2; }',
      '    double compute(double x) { return x * 3.0; }',
      '};',
      'int main() {',
      '    Calculator calc;',
      '    std::cout << calc.compute(5) << " " << calc.compute(2.5) << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('10 7.5\n');
  });

  it('prefers non-reference exact match or valid reference over incompatible temporary', () => {
    const source = [
      '#include <iostream>',
      'void bump(int& x) { x += 10; std::cout << "ref:" << x << " "; }',
      'void bump(double d) { std::cout << "val:" << d << " "; }',
      'int main() {',
      '    int a = 5;',
      '    bump(a);',
      '    bump(2.5);',
      '    std::cout << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('ref:15 val:2.5 \n');
  });

  it('reports an ambiguous call when neither candidate is strictly better', () => {
    const source = [
      '#include <iostream>',
      'void mix(int a, double b) {}',
      'void mix(double a, int b) {}',
      'int main() {',
      '    mix(1, 1);',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('ambiguous');
  });

  it('handles function prototypes with definitions for overloaded functions', () => {
    const source = [
      '#include <iostream>',
      'void greet(int);',
      'void greet(double);',
      'void greet(int x) { std::cout << "i" << x << " "; }',
      'void greet(double d) { std::cout << "d" << d << " "; }',
      'int main() {',
      '    greet(7);',
      '    greet(1.2);',
      '    std::cout << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status).toBe('ok');
    expect(result.stdout).toBe('i7 d1.2 \n');
  });
});
