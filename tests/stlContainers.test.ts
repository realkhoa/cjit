import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * The STL surface the fast engine simulates for the realtime pane.
 *
 * The point is coverage of the code people actually write in exercises and
 * contests, with the same display rule as elsewhere: a container shows its
 * elements, capped at twenty, and says how many were left out.
 */

function run(source: string): ExecutionResult {
  const analysis = analyzeSource(source, 'main.cpp');
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return execute(analysis.unit, { collectWatch: true });
}

function shown(source: string, name: string): string {
  const value = run(source).vars.find((item) => item.name === name)?.value;
  expect(value, `${name} was not in the watch snapshot`).toBeDefined();
  return value ?? '';
}

function returns(source: string, expression: string): string {
  const sourceWithReturn = source.replace('// RETURN', `return ${expression};`);
  const result = run(sourceWithReturn);
  expect(result.status, result.detail).toBe('ok');
  return `${result.exitCode}`;
}

function program(body: readonly string[], includes: readonly string[] = ['<iostream>', '<vector>']): string {
  return [...includes.map((header) => `#include ${header}`), '', 'int main() {', ...body, '    // RETURN', '}'].join(
    '\n',
  );
}

describe('std::set', () => {
  it('keeps elements sorted and unique, and shows them in braces', () => {
    const source = program(
      [
        '    std::set<int> values{5, 1, 3, 1};',
        '    values.insert(2);',
        '    values.insert(3);',
        '    int seen = values.count(3);',
        '    int missing = values.count(9);',
      ],
      ['<iostream>', '<set>'],
    );

    expect(shown(source, 'values')).toBe('{1, 2, 3, 5}');
    expect(returns(source, 'seen * 10 + missing')).toBe('10');
  });

  it('erases a value and reports its size', () => {
    const source = program(
      [
        '    std::set<int> values{1, 2, 3};',
        '    values.erase(2);',
        '    int removed = values.erase(99);',
        '    int size = values.size();',
      ],
      ['<iostream>', '<set>'],
    );

    expect(shown(source, 'values')).toBe('{1, 3}');
    expect(returns(source, 'removed * 10 + size')).toBe('2');
  });
});

describe('std::map', () => {
  it('creates entries with operator[], counts them, and prints them by key', () => {
    const source = program(
      [
        '    std::map<std::string, int> counts;',
        '    counts["b"] = 2;',
        '    counts["a"] = 1;',
        '    counts["b"] = counts["b"] + 1;',
      ],
      ['<iostream>', '<map>', '<string>'],
    );

    // Sorted by key, `key: value`, and the last write wins.
    expect(shown(source, 'counts')).toBe('{"a": 1, "b": 3}');
  });

  it('distinguishes a missing key from a zero value', () => {
    const source = program(
      [
        '    std::map<int, int> counts;',
        '    counts[1] = 5;',
        '    int present = counts.count(1);',
        '    int absent = counts.count(2);',
      ],
      ['<iostream>', '<map>'],
    );

    expect(returns(source, 'present * 10 + absent')).toBe('10');
    // `count` must not have inserted anything.
    expect(shown(source, 'counts')).toBe('{1: 5}');
  });

  it('iterates entries in key order with a range-based for', () => {
    const source = program(
      [
        '    std::map<int, int> counts;',
        '    counts[3] = 30;',
        '    counts[1] = 10;',
        '    int total = 0;',
        '    for (const auto& entry : counts) { total = total * 100 + entry.second; }',
      ],
      ['<iostream>', '<map>'],
    );

    // 10 then 30: the map is ordered by key, not by insertion.
    expect(returns(source, 'total')).toBe('1030');
  });

  it('reads a value with at() and refuses a missing key', () => {
    const source = program(
      ['    std::map<int, int> counts;', '    counts[4] = 40;', '    int value = counts.at(4);'],
      ['<iostream>', '<map>'],
    );
    expect(returns(source, 'value')).toBe('40');

    const missing = run(
      ['#include <map>', 'int main() {', '    std::map<int, int> counts;', '    return counts.at(7);', '}'].join(
        '\n',
      ),
    );
    expect(missing.status).toBe('runtime-error');
    expect(missing.detail).toContain('key not found');
  });
});

describe('std::queue, std::stack and std::deque', () => {
  it('queue is first in, first out', () => {
    const source = program(
      [
        '    std::queue<int> pending;',
        '    pending.push(1);',
        '    pending.push(2);',
        '    pending.push(3);',
        '    int front = pending.front();',
        '    pending.pop();',
        '    int next = pending.front();',
      ],
      ['<iostream>', '<queue>'],
    );

    expect(returns(source, 'front * 10 + next')).toBe('12');
    expect(shown(source, 'pending')).toBe('[2, 3]');
  });

  it('stack is last in, first out', () => {
    const source = program(
      [
        '    std::stack<int> history;',
        '    history.push(1);',
        '    history.push(2);',
        '    int top = history.top();',
        '    history.pop();',
        '    int next = history.top();',
      ],
      ['<iostream>', '<stack>'],
    );

    expect(returns(source, 'top * 10 + next')).toBe('21');
    expect(shown(source, 'history')).toBe('[1]');
  });

  it('deque pushes and pops at both ends', () => {
    const source = program(
      [
        '    std::deque<int> values;',
        '    values.push_back(2);',
        '    values.push_front(1);',
        '    values.push_back(3);',
        '    int front = values.front();',
        '    int back = values.back();',
        '    values.pop_front();',
        '    int nowFront = values.front();',
      ],
      ['<iostream>', '<deque>'],
    );

    expect(returns(source, 'front * 100 + back * 10 + nowFront')).toBe('132');
    expect(shown(source, 'values')).toBe('[2, 3]');
  });
});

describe('std::priority_queue', () => {
  it('hands back the largest element first', () => {
    const source = program(
      [
        '    std::priority_queue<int> pending;',
        '    pending.push(3);',
        '    pending.push(9);',
        '    pending.push(5);',
        '    int largest = pending.top();',
        '    pending.pop();',
        '    int next = pending.top();',
      ],
      ['<iostream>', '<queue>'],
    );

    expect(returns(source, 'largest * 10 + next')).toBe('95');
  });

  it('orders a heap built from an initialiser list', () => {
    const source = program(
      ['    std::priority_queue<int> pending{4, 1, 7};', '    int largest = pending.top();'],
      ['<iostream>', '<queue>'],
    );

    expect(returns(source, 'largest')).toBe('7');
    // A max-heap of {4, 1, 7} is [7, 1, 4]: the root is the largest, and the
    // array is a heap, not a sorted list.
    expect(shown(source, 'pending')).toBe('[7, 1, 4]');
  });
});

describe('std::pair', () => {
  it('reads fields and shows the pair', () => {
    const source = program(
      [
        '    std::pair<int, std::string> item{7, "seven"};',
        '    int key = item.first;',
      ],
      ['<iostream>', '<utility>', '<string>'],
    );

    expect(returns(source, 'key')).toBe('7');
    expect(shown(source, 'item')).toBe('(7, "seven")');
  });
});

describe('the 20 element rule applies to every container', () => {
  it('caps a set and says how many were left out', () => {
    const source = program(
      [
        '    std::set<int> values;',
        '    for (int i = 0; i < 25; i++) values.insert(i);',
      ],
      ['<iostream>', '<set>'],
    );

    const text = shown(source, 'values');
    expect(text.startsWith('{0, 1,')).toBe(true);
    expect(text).toContain('+5 more');
  });
});
