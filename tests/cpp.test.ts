import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import { SAMPLE_MAIN_CPP, exampleFileMap } from '@/examples/sample';

/**
 * The fast engine resolves the C++ code people actually write here - iostream,
 * vector, string, algorithm, templates, range-based for - instead of pushing it
 * to clang-wasm. These tests are the contract for that: no diagnostics, and the
 * program really runs.
 *
 * The sample is a project (`main.cpp` includes `util.h`), so the whole project is
 * handed to the engine: analysing one file alone reports a missing include that is
 * the caller's fault, not the sample's.
 */

function analyse(source: string, file = 'main.cpp') {
  return analyzeSource(source, file, { files: exampleFileMap() });
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

  it('runs the whole tour and prints what each container produced', () => {
    const result = run(SAMPLE_MAIN_CPP);

    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sorted: [1, 1, 2, 3, 4, 5, 6, 9]');
    expect(result.stdout).toContain('sum = 31');
    expect(result.stdout).toContain('red appears 3 times');
  });

  it('reports real values from main, including what the template saw', () => {
    const result = run(SAMPLE_MAIN_CPP);
    const byName = new Map(result.vars.map((item) => [item.name, item]));

    expect(byName.get('nums')?.type).toBe('std::vector<int>');
    // Sorted in place by std::sort, so the pane shows the sorted order.
    expect(byName.get('nums')?.value).toBe('[1, 1, 2, 3, 4, 5, 6, 9]');
    expect(byName.get('unique')?.value).toBe('{1, 2, 3, 4, 5, 6, 9}');
    expect(byName.get('counts')?.value).toContain('"red": 3');
    // A binding from inside the template function is visible too.
    expect(byName.get('value')).toBeDefined();
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

  it('iterates over an initializer list in a range-based for loop', () => {
    const source = [
      '#include <iostream>',
      'int main() {',
      '    int total = 0;',
      '    for (int v : {10, 20, 30}) { total += v; }',
      '    std::cout << total << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('60\n');
  });

  it('iterates over an initializer list with auto and references', () => {
    const source = [
      '#include <iostream>',
      'int main() {',
      '    double total = 0.0;',
      '    for (const auto& v : {1.25, 2.5, 3.25}) { total += v; }',
      '    std::cout << total << "\\n";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(run(source).stdout).toBe('7\n');
  });
});

describe('C++ resolution: what still needs clang', () => {
  it('runs a class definition now, with no warning at all', () => {
    const analysis = analyse(
      [
        'class Widget {',
        '    int size;',
        'public:',
        '    void grow() { size = size + 1; }',
        '    int current() { return size; }',
        '};',
        'int main() { return 0; }',
      ].join('\n'),
    );

    expect(analysis.errorCount).toBe(0);
    expect(analysis.diagnostics).toEqual([]);
  });

  it('runs a namespace now, and calls into it by its qualified name', () => {
    const result = run(
      [
        '#include <iostream>',
        'namespace app {',
        'int run() { return 7; }',
        '}',
        'int main() { std::cout << app::run() << "\\n"; return 0; }',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7\n');
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

  it('accepts forward_list, any and other modern headers without unknown header warning', () => {
    const analysis = analyse(
      [
        '#include <forward_list>',
        '#include <any>',
        '#include <charconv>',
        'int main() { return 0; }',
      ].join('\n'),
    );

    expect(analysis.errorCount).toBe(0);
    expect(analysis.warningCount).toBe(0);
  });

  it('parses structs with member default initializers and const operator methods', () => {
    const analysis = analyse(
      [
        '#include <string>',
        'struct Person {',
        '    std::string name;',
        '    int age{};',
        '    bool operator<(const Person& other) const { return age < other.age; }',
        '};',
        'struct IsEven {',
        '    bool operator()(int n) const { return n % 2 == 0; }',
        '};',
        'int main() { return 0; }',
      ].join('\n'),
    );

    expect(analysis.errorCount).toBe(0);
  });

  it('parses templates with SFINAE default parameters and concept constraints', () => {
    const analysis = analyse(
      [
        'template <typename T>',
        'concept Numeric = true;',
        'template <Numeric T>',
        'T add(T a, T b) { return a + b; }',
        'template <typename T, typename = int>',
        'T sub(T a, T b) { return a - b; }',
        'int main() { return 0; }',
      ].join('\n'),
    );

    expect(analysis.errorCount).toBe(0);
  });

  it('parses structured bindings in declarations and range-for loops', () => {
    const analysis = analyse(
      [
        '#include <vector>',
        '#include <utility>',
        'int main() {',
        '    std::pair<int, int> p{1, 2};',
        '    auto [x, y] = p;',
        '    std::vector<std::pair<int, int>> vec;',
        '    for (const auto& [a, b] : vec) {}',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(analysis.errorCount).toBe(0);
  });
});
