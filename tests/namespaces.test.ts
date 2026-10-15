import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Namespaces.
 *
 * The engine keeps one flat table, so a `namespace` block is spelled out: everything
 * inside is declared under its qualified name (`math::square`), which is exactly how it
 * is called. A bare name only resolves after a `using namespace` - the same rule a
 * native compiler applies, and the reason `square(5)` on its own is an error here too.
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

const MATH = [
  'namespace math {',
  'int square(int value) { return value * value; }',
  'int counter = 3;',
  '}',
];

describe('calling into a namespace', () => {
  it('works with the qualified name', () => {
    const { result, messages } = run(
      program(...MATH, 'int main() {', '    std::cout << math::square(5) << "\\n";', '    return 0;', '}'),
    );

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('25\n');
  });

  it('reads and writes a namespace variable', () => {
    const { result } = run(
      program(
        ...MATH,
        'int main() {',
        '    math::counter = math::counter + 7;',
        '    std::cout << math::counter << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.stdout).toBe('10\n');
  });

  it('nests', () => {
    const { result } = run(
      program(
        'namespace outer {',
        'namespace inner {',
        'int twice(int value) { return value * 2; }',
        '}',
        '}',
        'int main() {',
        '    std::cout << outer::inner::twice(21) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });
});

describe('using namespace', () => {
  it('makes the names visible without the prefix, at file scope', () => {
    const { result } = run(
      program(
        ...MATH,
        'using namespace math;',
        'int main() {',
        '    std::cout << square(4) << " " << counter << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('16 3\n');
  });

  it('works inside a function, and only from that point on', () => {
    const { result } = run(
      program(
        ...MATH,
        'int main() {',
        '    using namespace math;',
        '    std::cout << square(6) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('36\n');
  });

  it('aliases the variable rather than copying it', () => {
    const { result } = run(
      program(
        ...MATH,
        'using namespace math;',
        'int main() {',
        '    counter = 11;',
        '    std::cout << math::counter << " " << counter << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('11 11\n');
  });
});

describe('types inside a namespace', () => {
  it('declares and uses a struct', () => {
    const { result } = run(
      program(
        'namespace shapes {',
        'struct Point { int x; int y; };',
        '}',
        'int main() {',
        '    shapes::Point p;',
        '    p.x = 1;',
        '    p.y = 2;',
        '    std::cout << p.x + p.y << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('3\n');
  });

  it('accepts the elaborated spelling too', () => {
    const { result } = run(
      program(
        'namespace shapes {',
        'struct Point { int x; };',
        '}',
        'int main() {',
        '    struct shapes::Point p;',
        '    p.x = 9;',
        '    std::cout << p.x << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('9\n');
  });
});

describe('what a native compiler refuses, so this does too', () => {
  it('a bare name without any using is an error', () => {
    const { result } = run(
      program(...MATH, 'int main() {', '    std::cout << square(5);', '    return 0;', '}'),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('square');
  });

  it('a name from one namespace is not visible through another', () => {
    const { result } = run(
      program(
        ...MATH,
        'using namespace other;',
        'int main() {',
        '    std::cout << square(5);',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status).toBe('runtime-error');
  });
});
