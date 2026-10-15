import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import type { ExecutionResult } from '@/lang/runtime/interpreter';

/**
 * Classes: methods, `this`, and access.
 *
 * A class is a struct with a different default access, and its member functions become
 * ordinary functions under `Counter::add`. `this` arrives as an address rather than a
 * copy, so a method that changes a member changes the object it was called on.
 *
 * Constructors are a separate feature and are not here yet: a class in these tests sets
 * its members explicitly, which is what the engine can do correctly today.
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

const COUNTER = [
  'class Counter {',
  'public:',
  '    int value;',
  '    void add(int amount) { value = value + amount; }',
  '    int doubled() { return value + value; }',
  '};',
  '',
  'int main() {',
  '    Counter counter;',
  '    counter.value = 0;',
  '    counter.add(3);',
  '    counter.add(4);',
  '    std::cout << counter.value << " " << counter.doubled() << "\\n";',
  '    return 0;',
  '}',
];

describe('methods', () => {
  it('are called on an object and change it', () => {
    const { result, messages } = run(['#include <iostream>', ...COUNTER].join('\n'));

    expect(messages).toEqual([]);
    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7 14\n');
  });

  it('work through a pointer with ->', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'struct Point { int x; int y; void move(int dx) { x = x + dx; } };',
        'int main() {',
        '    Point p;',
        '    p.x = 1;',
        '    p.y = 2;',
        '    Point* pointer = &p;',
        '    pointer->move(5);',
        '    std::cout << p.x << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('6\n');
  });

  it('can use this explicitly', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'struct Box { int size; int twice() { return this->size * 2; } };',
        'int main() {',
        '    Box box;',
        '    box.size = 21;',
        '    std::cout << box.twice() << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('42\n');
  });

  it('can call another method of the same class without this->', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'struct Accumulator {',
        '    int total;',
        '    void reset() { total = 0; }',
        '    void add(int amount) { total = total + amount; }',
        '    void restart(int amount) { reset(); add(amount); }',
        '};',
        'int main() {',
        '    Accumulator acc;',
        '    acc.total = 100;',
        '    acc.restart(7);',
        '    std::cout << acc.total << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('7\n');
  });
});

describe('access', () => {
  it('a class member is private by default', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'class Secret {',
        '    int hidden;',
        'public:',
        '    int visible;',
        '};',
        'int main() {',
        '    Secret secret;',
        '    secret.visible = 1;',
        '    secret.hidden = 2;',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('private');
    expect(result.detail).toContain('hidden');
  });

  it('a struct member is public by default', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'struct Open { int value; };',
        'int main() {',
        '    Open open;',
        '    open.value = 5;',
        '    std::cout << open.value << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('5\n');
  });

  it('a private member is reachable from inside the class', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'class Wallet {',
        '    int cents;',
        'public:',
        '    void deposit(int amount) { cents = cents + amount; }',
        '    int total() { return cents; }',
        '};',
        'int main() {',
        '    Wallet wallet;',
        '    wallet.deposit(250);',
        '    std::cout << wallet.total() << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    expect(result.stdout).toBe('250\n');
  });

  it('a private method cannot be called from outside', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'class Machine {',
        '    void secret() { }',
        'public:',
        '    void run() { secret(); }',
        '};',
        'int main() {',
        '    Machine machine;',
        '    machine.secret();',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status).toBe('runtime-error');
    expect(result.detail).toContain('private');
  });
});

describe('layout', () => {
  it('methods are not part of the object', () => {
    const { result } = run(
      [
        '#include <iostream>',
        'struct Sized { int a; void touch() { a = 1; } int b; };',
        'int main() {',
        '    Sized value;',
        '    value.a = 4;',
        '    value.b = 5;',
        '    std::cout << sizeof(value) << " " << value.a + value.b << "\\n";',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    expect(result.status, result.detail).toBe('ok');
    // Two ints, and the method takes no room at all.
    expect(result.stdout).toBe('8 9\n');
  });
});
