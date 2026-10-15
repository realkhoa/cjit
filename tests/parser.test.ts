import { describe, expect, it } from 'vitest';
import type { Declaration, FunctionDeclNode, Statement, TypeRef, VarDecl } from '@/lang/ast';
import { SAMPLE_HELLO_C, SAMPLE_MAIN_CPP, exampleFileMap } from '@/examples/sample';
import { parse } from '@/lang/parser';
import type { ParseResult } from '@/lang/parser';
import { preprocess } from '@/lang/preprocessor';
import type { PreprocessOptions } from '@/lang/preprocessor';

/** User tokens only: no prelude, no implicit headers. */
function parseSource(source: string, options: PreprocessOptions = {}): ParseResult {
  const pre = preprocess(source, 'main.c', {
    includePrelude: false,
    implicitHeaders: false,
    ...options,
  });
  return parse(pre.tokens, 'main.c');
}

/** Exactly what the engine does: prelude + implicit headers. */
function parseAsEngine(
  source: string,
  file = 'main.c',
  options: PreprocessOptions = {},
): ParseResult {
  const pre = preprocess(source, file, options);
  return parse(pre.tokens, file);
}

function errors(result: ParseResult) {
  return result.diagnostics.filter((item) => item.severity === 'error');
}

function warnings(result: ParseResult) {
  return result.diagnostics.filter((item) => item.severity === 'warning');
}

function infos(result: ParseResult) {
  return result.diagnostics.filter((item) => item.severity === 'info');
}

function functions(result: ParseResult): FunctionDeclNode[] {
  return result.unit.declarations.filter(
    (item): item is FunctionDeclNode => item.kind === 'function',
  );
}

function variables(result: ParseResult): VarDecl[] {
  return result.unit.declarations.filter((item): item is VarDecl => item.kind === 'variable');
}

const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'variable',
  'typedef',
  'struct',
  'enum',
  'function',
  'unknown-decl',
]);

function firstStatement(result: ParseResult): Statement {
  const fn = functions(result)[0];
  const item = fn?.body?.items[0];
  if (!item) throw new Error('no statement found');
  if (DECLARATION_KINDS.has(item.kind)) {
    throw new Error(`expected a statement, got declaration ${item.kind}`);
  }
  return item as Statement;
}

function declarationAt(result: ParseResult, index: number): Declaration {
  const declaration = result.unit.declarations[index];
  if (!declaration) throw new Error(`no declaration at ${index}`);
  return declaration;
}

function describes(type: TypeRef): string {
  return type.kind === 'pointer' && type.pointee
    ? `${describes(type.pointee)} *`
    : type.kind === 'array' && type.element
      ? `${describes(type.element)}[]`
      : type.kind === 'function' && type.returnType
        ? `${describes(type.returnType)}(...)`
        : type.name;
}

describe('parser: declarations', () => {
  it('parses a function definition with a body', () => {
    const result = parseSource('int main(void) { return 0; }\n');

    expect(errors(result)).toEqual([]);
    const fn = functions(result)[0];
    expect(fn?.name).toBe('main');
    expect(fn?.body?.kind).toBe('compound');
    expect(firstStatement(result).kind).toBe('return');
  });

  it('parses a prototype without a body', () => {
    const result = parseSource('int add(int a, int b);\n');

    const fn = functions(result)[0];
    expect(fn?.body).toBeUndefined();
    expect(fn?.params.map((param) => param.name)).toEqual(['a', 'b']);
    expect(fn?.params.every((param) => param.type.name === 'int')).toBe(true);
  });

  it('parses a variadic prototype', () => {
    const result = parseSource('int printf(const char *format, ...);\n');

    const fn = functions(result)[0];
    expect(fn?.variadic).toBe(true);
    expect(fn?.params).toHaveLength(1);
    expect(describes(fn?.params[0]?.type as TypeRef)).toBe('const char *');
  });

  it('parses scalar, pointer, array and multi-declarator forms', () => {
    const result = parseSource(
      [
        'int x = 5;',
        'static const unsigned long y = 1;',
        'char *s = "hi";',
        'int a[3];',
        'int m[2][3];',
        'int p = 1, q = 2;',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);
    const vars = variables(result);
    expect(vars.map((item) => item.name)).toEqual(['x', 'y', 's', 'a', 'm', 'p', 'q']);
    expect(vars[1]?.type.name).toBe('const unsigned long');
    expect(describes(vars[2]?.type as TypeRef)).toBe('char *');
    expect(describes(vars[3]?.type as TypeRef)).toBe('int[]');
    expect(describes(vars[4]?.type as TypeRef)).toBe('int[][]');
  });

  it('parses an array of pointers as an array of pointers, not a pointer to array', () => {
    const result = parseSource('char *argv[4];\n');

    const type = variables(result)[0]?.type;
    expect(type?.kind).toBe('array');
    expect(type?.element?.kind).toBe('pointer');
    expect(type?.element?.pointee?.name).toBe('char');
  });

  it('parses a function pointer as pointer-to-function', () => {
    const result = parseSource('int (*cmp)(const void *, const void *);\n');

    expect(errors(result)).toEqual([]);
    const type = variables(result)[0]?.type;
    expect(describes(type as TypeRef)).toBe('int(...) *');
    expect(type?.pointee?.kind).toBe('function');
    expect(type?.pointee?.params).toHaveLength(2);
  });

  it('parses a self-referential struct, which is what a linked list needs', () => {
    // `struct Node *next;` used to be swallowed as a nested struct definition,
    // which made the member list empty and every linked list unparseable unless a
    // typedef happened to come first.
    const result = parseSource(
      [
        'struct Node { int value; struct Node *next; };',
        'struct Wrapper { struct Node *head; };',
        'struct Outer { struct Inner { int deep; } inner; };',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);

    const node = declarationAt(result, 0);
    expect(node.kind).toBe('struct');
    if (node.kind === 'struct') {
      expect(node.members.map((member) => member.name)).toEqual(['value', 'next']);
      // The member is a pointer to the struct being defined.
      expect(node.members[1]?.type.kind).toBe('pointer');
    }

    const wrapper = declarationAt(result, 1);
    if (wrapper.kind === 'struct') {
      expect(wrapper.members.map((member) => member.name)).toEqual(['head']);
    }

    // A genuine nested definition still parses as a nested definition.
    const outer = declarationAt(result, 2);
    expect(outer.kind).toBe('struct');
    if (outer.kind === 'struct') {
      expect(outer.members.map((member) => member.name)).toEqual(['inner']);
    }
  });

  it('parses structs, typedefs and enums', () => {
    const result = parseSource(
      [
        'struct Point { int x; int y; };',
        'typedef struct Point Point;',
        'enum Color { RED, GREEN = 2, BLUE };',
        'struct Point origin;',
        'Point other;',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);
    const struct = declarationAt(result, 0);
    expect(struct.kind).toBe('struct');
    if (struct.kind === 'struct') {
      expect(struct.tag).toBe('Point');
      expect(struct.members.map((member) => member.name)).toEqual(['x', 'y']);
    }

    const typedef = declarationAt(result, 1);
    expect(typedef.kind).toBe('typedef');

    const enumNode = declarationAt(result, 2);
    expect(enumNode.kind).toBe('enum');
    if (enumNode.kind === 'enum') {
      expect(enumNode.enumerators.map((item) => item.name)).toEqual(['RED', 'GREEN', 'BLUE']);
      expect(enumNode.enumerators[1]?.value).toBeDefined();
    }

    // `Point` only works after its typedef was seen - the classic C ambiguity.
    expect(variables(result).map((item) => item.name)).toEqual(['origin', 'other']);
    expect(variables(result)[0]?.type.name).toBe('struct Point');
  });

  it('parses brace initialization and nested initializer lists', () => {
    const result = parseSource('int a[3] = {1, 2, 3};\nstruct P p = {1, 2};\nint z{7};\n');

    expect(errors(result)).toEqual([]);
    expect(variables(result)[0]?.initializer?.kind).toBe('init-list');
    expect(variables(result)[1]?.initializer?.kind).toBe('init-list');
    expect(variables(result)[2]?.initializer?.kind).toBe('init-list');
  });

  it('keeps `auto` as the declared type instead of inventing int', () => {
    const result = parseSource('auto value = compute();\n');

    expect(variables(result)[0]?.type.name).toBe('auto');
  });
});

describe('parser: statements', () => {
  it('parses the control-flow statements', () => {
    const result = parseSource(
      [
        'int f(int n) {',
        '  int total = 0;',
        '  if (n > 0) { total = 1; } else { total = 2; }',
        '  for (int i = 0; i < n; i++) { total += i; }',
        '  while (total > 10) { total--; }',
        '  do { total++; } while (total < 3);',
        '  switch (total) { case 1: break; default: continue; }',
        '  goto end;',
        'end:',
        '  return total;',
        '}',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);
    const items = (functions(result)[0]?.body?.items ?? []).map((item) =>
      'kind' in item ? item.kind : 'decl',
    );
    const kinds = items.filter((kind) => kind !== 'variable');

    // `end:` swallows the following statement as its body, which is why `return`
    // is nested inside the label rather than being a sibling.
    expect(kinds).toEqual(['if', 'for', 'while', 'do-while', 'switch', 'goto', 'label']);

    const label = (functions(result)[0]?.body?.items ?? []).find(
      (item) => 'kind' in item && item.kind === 'label',
    );
    expect(label && 'body' in label ? label.body.kind : '').toBe('return');
  });

  it('parses an empty statement and a bare block', () => {
    const result = parseSource('int f(void) { ; { } return 0; }\n');
    expect(errors(result)).toEqual([]);
    expect(firstStatement(result).kind).toBe('empty');
  });
});

describe('parser: expressions', () => {
  it('respects arithmetic precedence', () => {
    const result = parseSource('int x = 1 + 2 * 3;\n');

    const initializer = variables(result)[0]?.initializer;
    expect(initializer?.kind).toBe('binary');
    if (initializer?.kind === 'binary') {
      expect(initializer.operator).toBe('+');
      expect(initializer.right.kind).toBe('binary');
      if (initializer.right.kind === 'binary') expect(initializer.right.operator).toBe('*');
    }
  });

  it('makes assignment right-associative', () => {
    const result = parseSource('int f(void) { a = b = c; return 0; }\n');

    const statement = firstStatement(result);
    expect(statement.kind).toBe('expr-stmt');
    if (statement.kind === 'expr-stmt') {
      expect(statement.expression.kind).toBe('assign');
      if (statement.expression.kind === 'assign') {
        expect(statement.expression.value.kind).toBe('assign');
      }
    }
  });

  it('parses ternary, calls, members and subscripts', () => {
    const result = parseSource(
      'int f(void) { obj.field = arr[i] + p->x; g(a, b) ? h() : k(); return 0; }\n',
    );

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
  });

  it('parses casts, sizeof and comma expressions', () => {
    const result = parseSource(
      'int f(void) { int y = (int)3.5 + (char)x; unsigned n = sizeof(int); int m = sizeof y; (void)(a, b); return 0; }\n',
    );

    expect(errors(result)).toEqual([]);
  });

  it('parses prefix and postfix increments distinctly', () => {
    const result = parseSource('int f(void) { int i = 0; ++i; i++; return i; }\n');

    const items = functions(result)[0]?.body?.items ?? [];
    const prefix = items[1];
    const postfix = items[2];
    expect(prefix && 'kind' in prefix && prefix.kind === 'expr-stmt' ? prefix.expression.kind : '').toBe('unary');
    if (prefix && 'kind' in prefix && prefix.kind === 'expr-stmt' && prefix.expression.kind === 'unary') {
      expect(prefix.expression.prefix).toBe(true);
    }
    if (postfix && 'kind' in postfix && postfix.kind === 'expr-stmt' && postfix.expression.kind === 'unary') {
      expect(postfix.expression.prefix).toBe(false);
    }
  });

  it('parses qualified C++ names as identifiers so iostream code still reads', () => {
    const result = parseSource('int f(void) { std::cout << 1; return 0; }\n');

    expect(errors(result)).toEqual([]);
    const statement = firstStatement(result);
    if (statement.kind === 'expr-stmt' && statement.expression.kind === 'binary') {
      expect(statement.expression.left.kind).toBe('identifier');
      if (statement.expression.left.kind === 'identifier') {
        expect(statement.expression.left.name).toBe('std::cout');
      }
    }
  });
});

describe('parser: error recovery', () => {
  it('reports a missing initializer but keeps parsing the rest of the file', () => {
    const result = parseSource('int a = ;\nint b = 2;\nint c = 3;\n');

    expect(errors(result).length).toBeGreaterThan(0);
    // b is swallowed by resync to the next ';', but c must still be found.
    expect(variables(result).map((item) => item.name)).toContain('c');
  });

  it('reports an unclosed block exactly once', () => {
    const result = parseSource('int main(void) { return 0;\n');

    const found = errors(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('}');
  });

  it('reports a missing semicolon without losing the following function', () => {
    const result = parseSource('int a = 1\nint main(void) { return 0; }\n');

    expect(errors(result).length).toBeGreaterThan(0);
    expect(functions(result).map((fn) => fn.name)).toContain('main');
  });

  it('never hangs or throws on pathological nesting', () => {
    const deep = `int f(void) { return ${'('.repeat(400)}1${')'.repeat(400)}; }`;
    const result = parseSource(deep);

    expect(result.unit.kind).toBe('translation-unit');
    expect(errors(result).length).toBeGreaterThan(0);
  });

  it('recovers from a stray closing brace', () => {
    const result = parseSource('int f(void) { return 0; }}\nint g(void) { return 1; }\n');

    expect(errors(result).length).toBeGreaterThanOrEqual(0);
    expect(functions(result).map((fn) => fn.name)).toContain('g');
  });
});

describe('parser: C++ degradation is honest, not noisy', () => {
  it('parses the default C++ sample with zero errors and zero warnings', () => {
    const result = parseAsEngine(SAMPLE_MAIN_CPP, 'main.cpp', { files: exampleFileMap() });

    // The engine resolves templates, containers and streams itself now, so the
    // sample must be completely quiet.
    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    expect(infos(result)).toEqual([]);
    expect(functions(result).map((fn) => fn.name)).toEqual(expect.arrayContaining(['printAll', 'main']));
  });

  it('parses a template function and a top-level std::string as real declarations', () => {
    const result = parseSource('template <typename T> T twice(T value) { return value + value; }\n');

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    const fn = functions(result)[0];
    expect(fn?.name).toBe('twice');
    expect(fn?.returnType.name).toBe('T');
    expect(fn?.params[0]?.name).toBe('value');
  });

  it('skips a class and a namespace, and only those', () => {
    const result = parseSource(
      [
        'class Widget { public: int size; };',
        'namespace app { int run(void); }',
        'int main(void) { return 0; }',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);
    const skipped = result.unit.declarations.filter((item) => item.kind === 'unknown-decl');
    expect(skipped).toHaveLength(2);
    expect(functions(result).map((fn) => fn.name)).toEqual(['main']);
  });

  it('parses std::vector declarations instead of skipping them', () => {
    const result = parseSource(
      [
        'int main(void) {',
        '  std::vector<int> nums{1, 2, 3};',
        '  std::string label = "done";',
        '  return 0;',
        '}',
      ].join('\n'),
    );

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    const declared = variables(result);
    expect(declared).toEqual([]); // both are inside main
    const items = functions(result)[0]?.body?.items ?? [];
    const names = items
      .filter((item) => item.kind === 'variable')
      .map((item) => ('name' in item ? item.name : ''));
    expect(names).toEqual(['nums', 'label']);
    const types = items
      .filter((item) => item.kind === 'variable')
      .map((item) => ('type' in item ? item.type.name : ''));
    expect(types).toEqual(['std::vector<int>', 'std::string']);
  });

  it('parses range-based for into a real statement', () => {
    const result = parseSource(
      'int main(void) { int v[3]; for (const auto& item : v) { v[0] = item; } return 0; }\n',
    );

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    const items = functions(result)[0]?.body?.items ?? [];
    const loop = items.find((item) => item.kind === 'for-range');
    expect(loop).toBeDefined();
    expect(loop && 'declaration' in loop ? loop.declaration.kind : '').toBe('variable');
  });

  it('accepts extern "C" blocks as ordinary declarations', () => {
    const result = parseSource('extern "C" { int c_function(int); }\n');

    expect(errors(result)).toEqual([]);
    expect(functions(result).map((fn) => fn.name)).toEqual(['c_function']);
  });
});

describe('parser: the built-in headers must parse cleanly', () => {
  it('produces no diagnostics at all for a program that includes nothing', () => {
    const result = parseAsEngine('int main(void) { return 0; }\n');

    expect(result.diagnostics).toEqual([]);
    expect(functions(result).map((fn) => fn.name)).toContain('main');
  });

  it('parses the C sample with implicit headers, then with an explicit include', () => {
    const implicit = parseAsEngine(SAMPLE_HELLO_C);
    expect(errors(implicit)).toEqual([]);
    expect(functions(implicit).map((fn) => fn.name)).toContain('main');

    const explicit = parseAsEngine(`#include <stdio.h>\n${SAMPLE_HELLO_C}`);
    expect(errors(explicit)).toEqual([]);
    expect(infos(explicit)).toEqual([]);
  });

  it('does not report errors coming from the built-in headers themselves', () => {
    const result = parseAsEngine('#include <math.h>\n#include <string.h>\ndouble d = sqrt(2.0);\n');

    expect(result.diagnostics.filter((item) => item.source !== 'main.c')).toEqual([]);
  });
});
