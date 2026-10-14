import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import { SAMPLE_MAIN_CPP } from '@/examples/sample';

/**
 * The fast engine resolves the C++ code people actually write here - iostream,
 * vector, string, algorithm, templates, range-based for - instead of pushing it
 * to clang-wasm. These tests are the contract for that: no diagnostics, and the
 * program really runs.
 */

function analyse(source: string, file = 'main.cpp') {
  return analyzeSource(source, file);
}

function run(source: string, file = 'main.cpp'): ExecutionResult {
  const analysis = analyse(source, file);
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

describe('C++ resolution: the default sample', () => {
  it('analyses with no diagnostics at all', () => {
    const analysis = analyse(SAMPLE_MAIN_CPP);

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.errorCount).toBe(0);
    expect(analysis.warningCount).toBe(0);
    expect(analysis.infoCount).toBe(0);
  });

  it('runs and prints the right answer', () => {
    const result = run(SAMPLE_MAIN_CPP);

    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sum = 31\ncount = 8\ndone\n');
  });

  it('reports real values from inside the template function and main', () => {
    const result = run(SAMPLE_MAIN_CPP);
    const byName = new Map(result.vars.map((item) => [item.name, item]));

    expect(byName.get('total')?.value).toBe('31');
    expect(byName.get('total')?.type).toBe('int');
    expect(byName.get('nums')?.type).toBe('std::vector<int>');
    expect(byName.get('nums')?.children?.map((child) => child.value)).toEqual([
      '3',
      '1',
      '4',
      '1',
      '5',
      '9',
      '2',
      '6',
    ]);
  });
});

describe('C++ resolution: headers', () => {
  it('accepts every iostream/vector/string include silently', () => {
    const analysis = analyse(
      [
        '#include <iostream>',
        '#include <vector>',
        '#include <string>',
        '#include <algorithm>',
        'int main() { return 0; }',
      ].join('\n'),
    );

    expect(analysis.diagnostics).toEqual([]);
  });

  it('maps a <c...> wrapper onto the C header it wraps', () => {
    const analysis = analyse('#include <cstdio>\nint main() { printf("hi\\n"); return 0; }');

    expect(analysis.diagnostics).toEqual([]);
    const printfSymbol = analysis.symbols.symbols.find((symbol) => symbol.name === 'printf');
    expect(printfSymbol?.file).toBe('<stdio.h>');
    expect(execute(analysis.unit).stdout).toBe('hi\n');
  });

  it('still reports a genuinely unknown header', () => {
    const analysis = analyse('#include <unistd.h>\nint main() { return 0; }');
    expect(analysis.diagnostics.some((item) => item.message.includes('unknown header'))).toBe(true);
  });
});

describe('C++ resolution: containers and algorithms', () => {
  it('runs vector push_back, indexing, size and range-based for', () => {
    const source = [
      '#include <vector>',
      '#include <iostream>',
      'int main() {',
      '    std::vector<int> values;',
      '    for (int i = 1; i <= 4; i++) { values.push_back(i * i); }',
      '    int total = 0;',
      '    for (int v : values) { total += v; }',
      '    std::cout << total << " " << values.size() << " " << values[3] << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('30 4 16\n');
  });

  it('sorts a vector through std::sort with iterators', () => {
    const source = [
      '#include <bits/stdc++.h>',
      'int main() {',
      '    std::vector<int> values{5, 3, 9, 1};',
      '    std::sort(values.begin(), values.end());',
      '    for (int v : values) { std::cout << v << " "; }',
      '    std::cout << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('1 3 5 9 \n');
  });

  it('sorts with a user comparator', () => {
    const source = [
      '#include <algorithm>',
      'bool descending(int a, int b) { return a > b; }',
      'int main() {',
      '    int values[4] = {1, 4, 2, 3};',
      '    std::sort(values, values + 4, descending);',
      '    printf("%d %d %d %d\\n", values[0], values[1], values[2], values[3]);',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('4 3 2 1\n');
  });

  it('supports std::string concatenation, size and substr', () => {
    const source = [
      '#include <string>',
      '#include <iostream>',
      'int main() {',
      '    std::string first = "hello";',
      '    std::string second = " world";',
      '    std::string both = first + second;',
      '    std::cout << both << "|" << both.size() << "|" << both.substr(0, 5) << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('hello world|11|hello\n');
  });

  it('supports std::min, std::max, std::swap, std::to_string and std::stoi', () => {
    const source = [
      '#include <algorithm>',
      'int main() {',
      '    int a = 3;',
      '    int b = 7;',
      '    std::swap(a, b);',
      '    std::cout << std::min(a, b) << " " << std::max(a, b) << " ";',
      '    std::string text = std::to_string(a) + "!";',
      '    std::cout << text << " " << std::stoi("42") + 1 << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('3 7 7! 43\n');
  });

  it('instantiates a template function for doubles as well as ints', () => {
    const source = [
      '#include <vector>',
      'template <typename T>',
      'T sum(const std::vector<T>& values) {',
      '    T total{};',
      '    for (const auto& v : values) { total += v; }',
      '    return total;',
      '}',
      'int main() {',
      '    std::vector<double> reals{1.5, 2.5};',
      '    std::cout << sum(reals) << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('4\n');
  });
});

describe('C++ resolution: what still needs clang', () => {
  it('says so for a class definition, once', () => {
    const analysis = analyse('class Widget { public: int size; };\nint main() { return 0; }');

    expect(analysis.errorCount).toBe(0);
    const warnings = analysis.diagnostics.filter((item) => item.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('class');
  });

  it('says so for a namespace', () => {
    const analysis = analyse('namespace app { int run(); }\nint main() { return 0; }');

    expect(analysis.errorCount).toBe(0);
    expect(analysis.diagnostics.some((item) => item.message.includes('namespace'))).toBe(true);
  });

  it('does not warn about templates, containers or streams any more', () => {
    const analysis = analyse(
      [
        '#include <iostream>',
        '#include <vector>',
        'template <typename T> T twice(T value) { return value + value; }',
        'int main() { std::vector<int> v{1, 2}; std::cout << twice(v[0]); return 0; }',
      ].join('\n'),
    );

    expect(analysis.warningCount).toBe(0);
    expect(analysis.infoCount).toBe(0);
  });
});
