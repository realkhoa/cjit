import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';
import { CONTAINER_PREVIEW_LIMIT } from '@/lang/runtime/container';

/**
 * How containers are *displayed* in the watch pane, the inline overlay and the
 * iteration table.
 *
 * The contract: a sequence reads as `[value, value, ...]`. It used to read as
 * `std::vector<int> @ 0x1f40`, which is an address - an implementation detail of
 * this interpreter - and told the reader nothing about the data.
 */

function run(source: string, file = 'main.cpp'): ExecutionResult {
  const analysis = analyzeSource(source, file);
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

function shown(source: string, name: string, file = 'main.cpp'): string {
  const value = run(source, file).vars.find((item) => item.name === name)?.value;
  expect(value, `${name} was not in the watch snapshot`).toBeDefined();
  return value ?? '';
}

describe('std::vector previews', () => {
  it('shows the elements, not a type and an address', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> numbers{1, 2, 3};',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'numbers')).toBe('[1, 2, 3]');
  });

  it('shows an empty vector as an empty list', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> empty;',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'empty')).toBe('[]');
  });

  it('shows elements appended at runtime', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> numbers;',
      '    for (int i = 0; i < 3; i++) numbers.push_back(i * 10);',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'numbers')).toBe('[0, 10, 20]');
  });

  it('previews 20 floating point elements with their fraction', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<double> values{1.5, 2.25};',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'values')).toBe('[1.5, 2.25]');
  });
});

describe('the 20 element limit', () => {
  it('shows exactly 20 elements and counts the rest', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> numbers;',
      '    for (int i = 0; i < 25; i++) numbers.push_back(i);',
      '    return 0;',
      '}',
    ].join('\n');

    const text = shown(source, 'numbers');
    const expectedFirst = Array.from({ length: CONTAINER_PREVIEW_LIMIT }, (_, i) => i).join(', ');
    expect(text).toBe(`[${expectedFirst}, +5 more]`);
    // The remainder is stated: a truncated list must never look complete.
    expect(text).toContain('+5 more');
  });

  it('does not add a remainder marker at exactly the limit', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> numbers;',
      '    for (int i = 0; i < 20; i++) numbers.push_back(i);',
      '    return 0;',
      '}',
    ].join('\n');

    const text = shown(source, 'numbers');
    expect(text).not.toContain('more');
    expect(text.split(',').length).toBe(20);
  });
});

describe('other sequences', () => {
  it('shows a C array as a list', () => {
    const source = 'int main(void) { int values[4] = {1, 2, 3, 4}; return 0; }\n';
    expect(shown(source, 'values', 'main.c')).toBe('[1, 2, 3, 4]');
  });

  it('reads a char array as a string, because that is what C means by it', () => {
    const source = 'int main(void) { char name[] = "abc"; return 0; }\n';
    expect(shown(source, 'name', 'main.c')).toBe('"abc"');
  });

  it('quotes vector<string> elements', () => {
    // This also covers a crash the old display hid: a string element used to be
    // stored as the literal's characters, so reading it back as a string object
    // followed the text as if it were a pointer and blew up the whole snapshot.
    const source = [
      '#include <vector>',
      '#include <string>',
      'int main() {',
      '    std::vector<std::string> words{"alpha", "beta"};',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'words')).toBe('["alpha", "beta"]');
  });

  it('shows string elements pushed at runtime', () => {
    const source = [
      '#include <vector>',
      '#include <string>',
      'int main() {',
      '    std::vector<std::string> words;',
      '    std::string first = "alpha";',
      '    words.push_back(first);',
      '    words.push_back("beta");',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'words')).toBe('["alpha", "beta"]');
  });

  it('shows vector<char> as characters, without the numeric value', () => {
    const source = [
      '#include <vector>',
      'int main() {',
      "    std::vector<char> letters{'h', 'i'};",
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'letters')).toBe("['h', 'i']");
  });

  it('nests sequences', () => {
    // Nested template arguments need the `> >` spacing and rows are pushed in:
    // the front-end parser does not accept `std::vector<std::vector<int>>`
    // (without the space) nor a nested braced init list. Run uses clang, which
    // accepts both.
    const source = [
      '#include <vector>',
      'int main() {',
      '    std::vector<int> row{1, 2};',
      '    std::vector<int> other{3};',
      '    std::vector<std::vector<int> > grid;',
      '    grid.push_back(row);',
      '    grid.push_back(other);',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'grid')).toBe('[[1, 2], [3]]');
  });

  it('still shows std::string as a quoted string', () => {
    const source = [
      '#include <string>',
      'int main() {',
      '    std::string text = "hello";',
      '    return 0;',
      '}',
    ].join('\n');

    expect(shown(source, 'text')).toBe('"hello"');
  });
});
