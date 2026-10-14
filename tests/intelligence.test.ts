import { describe, expect, it } from 'vitest';
import { breadcrumbAt, definitionAt, documentSymbolsFor, signatureAt } from '@/editor/intelligence';
import { analyzeSource } from '@/lang/analyze';

function analyse(source: string, file = 'main.c') {
  const analysis = analyzeSource(source, file);
  expect(
    analysis.errorCount,
    `unexpected parse errors: ${JSON.stringify(analysis.diagnostics, null, 1)}`,
  ).toBe(0);
  return analysis;
}

function offsetOf(source: string, needle: string, from = 0): number {
  const index = source.indexOf(needle, from);
  if (index < 0) throw new Error(`not found: ${needle}`);
  return index;
}

describe('signatureAt', () => {
  const SOURCE = [
    'int add(int a, int b) { return a + b; }',
    'int main(void) {',
    '    int first = add(1, 2);',
    '    int second = add(add(1, 2), 3);',
    '    printf("%d %d %d", 1, 2, 3);',
    '    return 0;',
    '}',
  ].join('\n');

  it('reports the signature and the parameter being typed', () => {
    const analysis = analyse(SOURCE);
    // Offset inside the second argument of the first call.
    const offset = offsetOf(SOURCE, '2);');

    const info = signatureAt(analysis, offset);
    expect(info?.label).toBe('int add(int a, int b)');
    expect(info?.parameters).toEqual(['int a', 'int b']);
    expect(info?.activeParameter).toBe(1);
  });

  it('picks the innermost call when calls nest', () => {
    const analysis = analyse(SOURCE);
    // The `2` inside `add(add(1, 2), 3)`.
    const nested = offsetOf(SOURCE, '2), 3)');

    const info = signatureAt(analysis, nested);
    expect(info?.label).toBe('int add(int a, int b)');
    expect(info?.activeParameter).toBe(1);
  });

  it('finds a library prototype from the inlined header', () => {
    const analysis = analyse(SOURCE);
    const offset = offsetOf(SOURCE, '2, 3);');

    const info = signatureAt(analysis, offset);
    expect(info?.label).toContain('printf');
    expect(info?.parameters[0]).toContain('format');
    // Variadic: the active parameter clamps to the declared ones.
    expect(info?.activeParameter).toBe(1);
  });

  it('returns nothing when the caret is not inside a call', () => {
    const analysis = analyse(SOURCE);
    expect(signatureAt(analysis, offsetOf(SOURCE, 'int first'))).toBeNull();
  });
});

describe('definitionAt', () => {
  const SOURCE = [
    'int counter = 0;',
    'int add(int a, int b) { return a + b; }',
    'int main(void) {',
    '    int local = add(1, 2);',
    '    printf("%d", local);',
    '    return 0;',
    '}',
  ].join('\n');

  it('points at the declaration of a local variable', () => {
    const analysis = analyse(SOURCE);
    const target = definitionAt(analysis, offsetOf(SOURCE, 'local);'), 'local');

    expect(target?.file).toBe('main.c');
    expect(target?.line).toBe(4);
    expect(target?.length).toBe('local'.length);
  });

  it('points at the declaration of a function', () => {
    const analysis = analyse(SOURCE);
    const target = definitionAt(analysis, offsetOf(SOURCE, 'add(1, 2)'), 'add');

    expect(target?.line).toBe(2);
  });

  it('points into the built-in header for printf', () => {
    const analysis = analyse(SOURCE);
    const target = definitionAt(analysis, offsetOf(SOURCE, 'printf('), 'printf');

    expect(target?.file).toBe('<stdio.h>');
    expect(target?.line).toBeGreaterThan(0);
    // The header really contains that declaration.
    expect(analysis.sources.get('<stdio.h>')).toContain('int printf(');
  });

  it('returns nothing for an unknown name', () => {
    const analysis = analyse(SOURCE);
    expect(definitionAt(analysis, 10, 'nope')).toBeNull();
  });
});

describe('documentSymbolsFor', () => {
  it('lists functions, globals, typedefs, structs and enums with children', () => {
    const source = [
      'typedef unsigned long size_type;',
      'struct Point {',
      '    int x;',
      '    int y;',
      '};',
      'enum Color { RED, GREEN };',
      'int counter = 0;',
      'int main(void) { return 0; }',
    ].join('\n');

    const symbols = documentSymbolsFor(analyse(source));
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));

    expect(symbols.map((symbol) => symbol.name)).toEqual([
      'size_type',
      'Point',
      'Color',
      'counter',
      'main',
    ]);
    expect(byName.get('main')?.kind).toBe('function');
    // `(void)` is normalised by the parser to "no parameters", so it renders `()`.
    expect(byName.get('main')?.detail).toBe('int main()');
    expect(byName.get('counter')?.kind).toBe('variable');
    expect(byName.get('size_type')?.detail).toBe('typedef unsigned long');
    expect(byName.get('Point')?.children?.map((child) => child.name)).toEqual(['x', 'y']);
    expect(byName.get('Color')?.children?.map((child) => child.name)).toEqual(['RED', 'GREEN']);
  });
});

describe('breadcrumbAt', () => {
  it('shows the symbol trail at the caret line', () => {
    const source = [
      'struct Point {',
      '    int x;',
      '    int y;',
      '};',
      'int main(void) {',
      '    return 0;',
      '}',
    ].join('\n');
    const analysis = analyse(source);

    expect(breadcrumbAt(analysis, 3)).toEqual(['Point', 'y']);
    expect(breadcrumbAt(analysis, 6)).toEqual(['main']);
    // A blank line between declarations belongs to nothing.
    expect(breadcrumbAt(analysis, 20)).toEqual([]);
  });
});
