import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Class templates.
 *
 * `template <typename T> struct Box { T value; };` is not a type: nothing has a layout
 * until `Box<int>` asks for one, and then each `T` becomes a real type. One declaration
 * serves every instantiation, which is the point of the feature.
 *
 * What is *not* here yet: methods of a class template. Those belong to each
 * instantiation, and the engine says so rather than handing back an object that quietly
 * lacks them.
 */

function run(source: string): { result: ExecutionResult; messages: string[] } {
  const analysis = analyzeSource(source, 'main.cpp');
  try {
    const result = execute(analysis.unit, { collectWatch: true });
    return {
      result,
      messages: [
        ...analysis.diagnostics,
        ...result.diagnostics,
      ].map((item) => `${item.severity}: ${item.message}`),
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

const BOX = ['template <typename T>', 'struct Box {', '    T value;', '};'];

describe('instantiating', () => {
  it('builds the type the argument names', () => {
    const { result, messages } = run(
      program(
        ...BOX,
        'int main() {',
        '    Box<int> box;',
        '    box.value = 5;',
        '    std::cout << box.value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('5\n');
  });

  it('keeps two instantiations apart', () => {
    const { result } = run(
      program(
        ...BOX,
        'int main() {',
        '    Box<int> whole;',
        '    Box<double> fraction;',
        '    whole.value = 7;',
        '    fraction.value = 2.5;',
        '    std::cout << whole.value << " " << fraction.value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7 2.5\n');
  });

  it('gives each instantiation the size its argument implies', () => {
    const { result } = run(
      program(
        ...BOX,
        'int main() {',
        '    Box<int> whole;',
        '    Box<double> fraction;',
        '    Box<char> letter;',
        '    std::cout << sizeof(whole) << " " << sizeof(fraction) << " " << sizeof(letter) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('4 8 1\n');
  });

  it('takes more than one parameter', () => {
    const { result } = run(
      program(
        'template <typename Key, typename Value>',
        'struct Entry {',
        '    Key key;',
        '    Value value;',
        '};',
        'int main() {',
        '    Entry<int, double> entry;',
        '    entry.key = 3;',
        '    entry.value = 1.5;',
        '    std::cout << entry.key << " " << entry.value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('3 1.5\n');
  });
});

describe('members that are themselves types', () => {
  it('a container of the parameter', () => {
    const { result } = run(
      program(
        '#include <vector>',
        'template <typename T>',
        'struct Bag {',
        '    std::vector<T> items;',
        '};',
        'int main() {',
        '    Bag<std::string> bag;',
        '    bag.items.push_back("one");',
        '    bag.items.push_back("two");',
        '    std::cout << bag.items.size() << " " << bag.items[1] << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('2 two\n');
  });

  it('a pointer to the template itself', () => {
    const { result } = run(
      program(
        'template <typename T>',
        'struct Node {',
        '    T value;',
        '    Node* next;',
        '};',
        'int main() {',
        '    Node<int> first;',
        '    Node<int> second;',
        '    first.value = 1;',
        '    second.value = 2;',
        '    first.next = &second;',
        '    std::cout << first.value << " " << first.next->value << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('1 2\n');
  });

  it('an instantiation passed to a function', () => {
    const { result } = run(
      program(
        ...BOX,
        'int read(Box<int> box) { return box.value; }',
        'int main() {',
        '    Box<int> box;',
        '    box.value = 9;',
        '    std::cout << read(box) << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('9\n');
  });
});

describe('what is not supported yet, and says so', () => {
  it('methods of a class template warn, and calling one fails visibly', () => {
    const { result, messages } = run(
      program(
        'template <typename T>',
        'struct Box {',
        '    T value;',
        '    T get() { return value; }',
        '};',
        'int main() {',
        '    Box<int> box;',
        '    box.value = 4;',
        '    std::cout << box.get() << "\\n";',
        '    return 0;',
        '}',
      ),
    );

    expect(messages.some((message) => message.includes('not supported'))).toBe(true);
    // Refused, not answered wrongly.
    expect(result.status).not.toBe('ok');
    expect(result.stdout).toBe('');
  });
});
