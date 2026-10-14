import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { membersOfType, visibleSymbolsAt } from '@/lang/symbols';
import type { SymbolInfo } from '@/lang/symbols';

/** User symbols only: the realtime tests in analyze.test.ts cover the implicit headers. */
function tableOf(source: string) {
  return analyzeSource(source, 'main.c', { implicitHeaders: false, includePrelude: false }).symbols;
}

function offsetOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`needle not found in source: ${needle}`);
  return index;
}

function names(symbols: readonly SymbolInfo[]): string[] {
  return symbols.map((symbol) => symbol.name);
}

describe('symbols: scope ranges', () => {
  it('lists functions, parameters and locals', () => {
    const source = ['int add(int a, int b) {', '    int total = a + b;', '    return total;', '}'].join(
      '\n',
    );
    const table = tableOf(source);

    expect(names(table.symbols)).toEqual(['add', 'a', 'b', 'total']);
    expect(table.symbols.find((symbol) => symbol.name === 'total')?.kind).toBe('variable');
    expect(table.symbols.find((symbol) => symbol.name === 'a')?.kind).toBe('parameter');
  });

  it('exposes parameters and locals inside the body but not before it', () => {
    const source = ['int add(int a, int b) {', '    int total = a + b;', '    return total;', '}'].join(
      '\n',
    );
    const table = tableOf(source);

    const insideBody = offsetOf(source, 'return total');
    expect(names(visibleSymbolsAt(table, insideBody))).toEqual(
      expect.arrayContaining(['add', 'a', 'b', 'total']),
    );

    const insideParameterList = offsetOf(source, 'int a');
    const visible = names(visibleSymbolsAt(table, insideParameterList));
    expect(visible).not.toContain('total');
    expect(visible).not.toContain('a');
    expect(visible).toContain('add');
  });

  it('keeps a block-local variable inside its block', () => {
    const source = [
      'int main(void) {',
      '    int outer = 1;',
      '    {',
      '        int inner = 2;',
      '    }',
      '    return outer;',
      '}',
    ].join('\n');
    const table = tableOf(source);

    expect(names(visibleSymbolsAt(table, offsetOf(source, 'return outer')))).toContain('outer');
    expect(names(visibleSymbolsAt(table, offsetOf(source, 'return outer')))).not.toContain('inner');
    // `inner` is declared on that line, so it is not yet visible at its own name.
    expect(names(visibleSymbolsAt(table, offsetOf(source, 'int inner')))).not.toContain('inner');
  });

  it('limits a for-loop variable to the loop', () => {
    const source = 'int main(void) { for (int i = 0; i < 3; i++) { } return 0; }';
    const table = tableOf(source);

    expect(names(visibleSymbolsAt(table, offsetOf(source, 'i++')))).toContain('i');
    expect(names(visibleSymbolsAt(table, offsetOf(source, 'return 0')))).not.toContain('i');
  });

  it('prefers the innermost declaration when names shadow', () => {
    const source = [
      'int value = 1;',
      'int main(void) {',
      '    int value = 2;',
      '    return value;',
      '}',
    ].join('\n');
    const table = tableOf(source);

    const visible = visibleSymbolsAt(table, offsetOf(source, 'return value'));
    const matches = visible.filter((symbol) => symbol.name === 'value');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.scope).toBe('main');
  });

  it('resolves members through a written struct type, pointers included', () => {
    const source = [
      'struct Point { int x; int y; };',
      'int main(void) {',
      '    struct Point p;',
      '    struct Point *q = &p;',
      '    p.x = 1;',
      '    q->y = 2;',
      '}',
    ].join('\n');
    const table = tableOf(source);

    expect(names(membersOfType(table, 'struct Point') ?? [])).toEqual(['x', 'y']);
    expect(names(membersOfType(table, 'struct Point *') ?? [])).toEqual(['x', 'y']);
    expect(names(membersOfType(table, 'Point') ?? [])).toEqual(['x', 'y']);
    expect(membersOfType(table, 'int')).toBeUndefined();
  });

  it('exposes enum constants and typedef names', () => {
    const source = [
      'typedef unsigned long u64;',
      'enum Color { RED, GREEN = 5, BLUE };',
      'int main(void) { return RED; }',
    ].join('\n');
    const result = analyzeSource(source, 'main.c', { implicitHeaders: false, includePrelude: false });
    const table = result.symbols;

    expect(table.typedefNames.has('u64')).toBe(true);
    expect(names(table.symbols)).toEqual(expect.arrayContaining(['u64', 'Color', 'RED', 'GREEN', 'BLUE']));
    // Enumerators are constants usable anywhere after their declaration.
    expect(names(visibleSymbolsAt(table, offsetOf(source, 'return RED')))).toContain('RED');
  });

  it('keeps only the most recent analysis in the side channel', () => {
    const options = { implicitHeaders: false, includePrelude: false };
    const first = analyzeSource('int a = 1;', 'main.c', options);
    const second = analyzeSource('int b = 2;', 'main.c', options);
    expect(first.symbols.symbols.map((symbol) => symbol.name)).toEqual(['a']);
    expect(second.symbols.symbols.map((symbol) => symbol.name)).toEqual(['b']);
  });
});
