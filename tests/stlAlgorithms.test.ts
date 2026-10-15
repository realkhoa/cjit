import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * The algorithms people reach for first, on top of the containers.
 *
 * These take iterators, which this engine models as pointers - the same thing
 * `.begin()` and `.end()` hand back for every container - so one implementation
 * serves vectors, sets, maps and plain arrays.
 */

function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.cpp');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

function value(source: string, expression: string): string {
  const result = run(source.replace('// RETURN', `return ${expression};`));
  expect(result.status, result.detail).toBe('ok');
  return `${result.exitCode}`;
}

function program(body: readonly string[]): string {
  return [
    '#include <iostream>',
    '#include <vector>',
    '#include <set>',
    '#include <map>',
    '#include <numeric>',
    '#include <algorithm>',
    '',
    'int main() {',
    ...body,
    '    // RETURN',
    '}',
  ].join('\n');
}

describe('bounds and search', () => {
  const SORTED = program([
    '    std::vector<int> values{1, 3, 3, 7, 9};',
    '    auto low = std::lower_bound(values.begin(), values.end(), 3);',
    '    auto high = std::upper_bound(values.begin(), values.end(), 3);',
    '    int firstAt = (int)(low - values.begin());',
    '    int afterLast = (int)(high - values.begin());',
    '    int present = std::binary_search(values.begin(), values.end(), 7);',
    '    int absent = std::binary_search(values.begin(), values.end(), 4);',
  ]);

  it('finds the first position a value could go', () => {
    expect(value(SORTED, 'firstAt')).toBe('1');
  });

  it('finds the position just past the last equal value', () => {
    expect(value(SORTED, 'afterLast')).toBe('3');
  });

  it('answers whether a value is there', () => {
    expect(value(SORTED, 'present * 10 + absent')).toBe('10');
  });

  it('gives an index in elements, not in bytes, through an auto iterator', () => {
    // `auto` must keep the pointer's own type: coercing it to a number here made
    // this difference 16 instead of 4 - a wrong answer that still looked plausible.
    const source = program([
      '    std::vector<int> values{1, 2, 3, 4};',
      '    auto last = std::max_element(values.begin(), values.end());',
      '    int at = (int)(last - values.begin());',
    ]);

    expect(value(source, 'at')).toBe('3');
  });
});

describe('min_element and max_element', () => {
  it('hands back an iterator, not the value', () => {
    const source = program([
      '    std::vector<int> values{5, 2, 9, 1};',
      '    int smallest = *std::min_element(values.begin(), values.end());',
      '    int largest = *std::max_element(values.begin(), values.end());',
    ]);

    expect(value(source, 'smallest')).toBe('1');
    expect(value(source, 'largest')).toBe('9');
  });

  it('works on an empty range without inventing a value', () => {
    const source = program([
      '    std::vector<int> empty;',
      '    auto none = std::min_element(empty.begin(), empty.end());',
      '    int atStart = none == empty.begin();',
    ]);

    expect(value(source, 'atStart')).toBe('1');
  });
});

describe('accumulate and iota', () => {
  it('sums a range from an initial value', () => {
    const source = program([
      '    std::vector<int> values{1, 2, 3, 4};',
      '    int total = std::accumulate(values.begin(), values.end(), 10);',
    ]);

    expect(value(source, 'total')).toBe('20');
  });

  it('keeps a double total fractional', () => {
    const source = program([
      '    std::vector<double> values{1.5, 2.25};',
      '    double total = std::accumulate(values.begin(), values.end(), 0.5);',
      '    int doubled = (int)(total * 100);',
    ]);

    expect(value(source, 'doubled')).toBe('425');
  });

  it('fills a range with consecutive numbers', () => {
    const source = program([
      '    std::vector<int> values;',
      '    values.resize(4);',
      '    std::iota(values.begin(), values.end(), 3);',
    ]);

    const result = run(source);
    expect(result.vars.find((item) => item.name === 'values')?.value).toBe('[3, 4, 5, 6]');
  });
});

describe('fill and reverse', () => {
  it('writes one value across a range', () => {
    const source = program([
      '    std::vector<int> values{1, 2, 3, 4};',
      '    std::fill(values.begin(), values.begin() + 2, 9);',
    ]);

    const result = run(source);
    expect(result.vars.find((item) => item.name === 'values')?.value).toBe('[9, 9, 3, 4]');
  });

  it('reverses in place', () => {
    const source = program([
      '    std::vector<int> values{1, 2, 3, 4};',
      '    std::reverse(values.begin(), values.end());',
    ]);

    const result = run(source);
    expect(result.vars.find((item) => item.name === 'values')?.value).toBe('[4, 3, 2, 1]');
  });
});

describe('the algorithms work on the containers too', () => {
  it('searches a set through its iterators', () => {
    const source = program([
      '    std::set<int> values{1, 2, 3};',
      '    int found = std::binary_search(values.begin(), values.end(), 2);',
    ]);

    expect(value(source, 'found')).toBe('1');
  });

  it('refuses to sum something that is not a number, rather than guessing', () => {
    const source = program([
      '    std::map<int, int> counts;',
      '    counts[1] = 10;',
      '    int total = std::accumulate(counts.begin(), counts.end(), 0);',
    ]);

    // A map's elements are pairs: adding them numerically would produce a number
    // that means nothing, so the engine says so instead.
    const result = run(source);
    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('only supports numeric elements');
  });
});
