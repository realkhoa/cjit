import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * `unordered_map` / `unordered_set`.
 *
 * They resolve as real containers rather than falling through to a scalar: before
 * this, `std::unordered_map<int, int> counts;` was silently typed `int` with no
 * diagnostic, and the first `counts[1]` failed as "subscript on a non-pointer
 * value" - a wrong answer that hid its own cause.
 *
 * They share the ordered layout, which the standard allows: it promises no
 * iteration order. Their bucket and hash APIs are not implemented and say so.
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

const MAP = [
  '#include <unordered_map>',
  'int main() {',
  '    std::unordered_map<int, int> counts;',
  '    counts[1] = 10;',
  '    counts[2] = 20;',
  '    int size = counts.size();',
  '    int seen = counts.count(1);',
  '    return size + seen;',
  '}',
].join('\n');

describe('unordered_map', () => {
  it('resolves as a container, not as a scalar', () => {
    expect(shown(MAP, 'counts')).toBe('{1: 10, 2: 20}');
  });

  it('behaves like a map for indexing and lookup', () => {
    const result = run(MAP);
    expect(result.status, result.detail).toBe('ok');
    // size 2 + count 1 = 3
    expect(result.exitCode).toBe(3);
  });

  it('refuses a bucket API instead of inventing one', () => {
    const result = run(
      [
        '#include <unordered_map>',
        'int main() {',
        '    std::unordered_map<int, int> counts;',
        '    return counts.bucket_count();',
        '}',
      ].join('\n'),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('has no member');
  });
});

describe('unordered_set', () => {
  it('resolves and keeps duplicates out', () => {
    const source = [
      '#include <unordered_set>',
      'int main() {',
      '    std::unordered_set<int> values;',
      '    values.insert(3);',
      '    values.insert(3);',
      '    values.insert(1);',
      '    int size = values.size();',
      '    return size;',
      '}',
    ].join('\n');

    const result = run(source);
    expect(result.status, result.detail).toBe('ok');
    expect(result.exitCode).toBe(2);
    expect(shown(source, 'values')).toBe('{1, 3}');
  });
});
