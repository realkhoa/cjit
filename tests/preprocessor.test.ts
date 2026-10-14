import { describe, expect, it } from 'vitest';
import { BITS_HEADER_NOTE } from '@/lang/headers';
import { preprocess } from '@/lang/preprocessor';
import type { PreprocessOptions, PreprocessResult } from '@/lang/preprocessor';
import type { Token } from '@/lang/token';

/** Default engine behaviour: implicit headers on, prelude on. */
function pre(source: string, options: PreprocessOptions = {}): PreprocessResult {
  return preprocess(source, 'main.c', options);
}

/** No implicit headers and no prelude: just the user's own tokens. */
function bare(source: string): PreprocessResult {
  return preprocess(source, 'main.c', { implicitHeaders: false, includePrelude: false });
}

function texts(result: PreprocessResult): string[] {
  return result.tokens.filter((token) => token.kind !== 'eof').map((token) => token.text);
}

function errors(result: PreprocessResult) {
  return result.diagnostics.filter((item) => item.severity === 'error');
}

function warnings(result: PreprocessResult) {
  return result.diagnostics.filter((item) => item.severity === 'warning');
}

function infos(result: PreprocessResult) {
  return result.diagnostics.filter((item) => item.severity === 'info');
}

function find(result: PreprocessResult, text: string): Token | undefined {
  return result.tokens.find((token) => token.text === text);
}

describe('preprocessor: implicit headers (no #include needed)', () => {
  it('makes printf available without any include, and says so', () => {
    const result = pre('int main(void) { printf("hi"); return 0; }');

    expect(result.implicitHeaders).toBe(true);
    expect(errors(result)).toEqual([]);
    expect(find(result, 'printf')?.file).toBe('<stdio.h>');
    expect(find(result, 'malloc')?.file).toBe('<stdlib.h>');
    expect(find(result, 'strlen')?.file).toBe('<string.h>');
  });

  it('can be switched off', () => {
    const result = pre('int main(void) { printf("hi"); return 0; }', {
      implicitHeaders: false,
    });

    expect(result.implicitHeaders).toBe(false);
    // The call site itself still spells `printf`; what must be gone is the
    // declaration coming from <stdio.h>. The prelude typedefs stay (they are
    // always present, like a compiler's built-in types).
    expect(result.tokens.some((token) => token.file === '<stdio.h>')).toBe(false);
    const own = result.tokens
      .filter((token) => token.file === 'main.c' && token.kind !== 'eof')
      .map((token) => token.text);
    expect(own).toEqual([
      'int', 'main', '(', 'void', ')', '{', 'printf', '(', '"hi"', ')', ';', 'return', '0', ';', '}',
    ]);
  });

  it('does not duplicate declarations when the user also writes the include', () => {
    const result = pre('#include <stdio.h>\nint main(void) { printf("hi"); return 0; }');

    const declarations = result.tokens.filter(
      (token) => token.file === '<stdio.h>' && token.text === 'printf',
    );
    expect(declarations).toHaveLength(1);
    expect(warnings(result)).toEqual([]);
    expect(errors(result)).toEqual([]);
  });
});

describe('preprocessor: bits/stdc++.h', () => {
  it('is a known built-in header, not an unknown one', () => {
    const result = pre('#include <bits/stdc++.h>\nint main(void) { printf("hi"); return 0; }');

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    expect(find(result, 'printf')?.file).toBe('<stdio.h>');
  });

  it('explains exactly how far its support goes', () => {
    const result = pre('#include <bits/stdc++.h>\nint main(void) { return 0; }');

    expect(infos(result).some((item) => item.message === BITS_HEADER_NOTE)).toBe(true);
  });

  it('also accepts the <stdc++.h> spelling', () => {
    const result = pre('#include <stdc++.h>\nint main(void) { return 0; }');
    expect(warnings(result)).toEqual([]);
    expect(infos(result)).toHaveLength(1);
  });
});

describe('preprocessor: includes', () => {
  it('inlines a built-in header and tags the tokens with its label', () => {
    const result = pre('#include <math.h>\ndouble x = sqrt(2.0);');

    expect(find(result, 'sqrt')?.file).toBe('<math.h>');
    expect(result.includedFiles).toContain('<math.h>');
    expect(result.sources.has('<math.h>')).toBe(true);
  });

  it('warns about an unknown system header instead of failing', () => {
    const result = pre('#include <unistd.h>\nint main(void) { return 0; }');
    expect(errors(result)).toEqual([]);
    expect(warnings(result).some((item) => item.message.includes('unknown header'))).toBe(true);
  });

  it('warns about a local include, which has no filesystem to resolve against', () => {
    const result = pre('#include "local.h"\nint main(void) { return 0; }');
    expect(warnings(result).some((item) => item.message.includes('local include'))).toBe(true);
  });

  it('resolves a C++ header silently, and a <c...> wrapper to its C header', () => {
    const vector = pre('#include <vector>\nint main(void) { return 0; }');
    expect(errors(vector)).toEqual([]);
    expect(infos(vector)).toEqual([]);
    expect(warnings(vector)).toEqual([]);

    // `<cstdio>` is a wrapper: it must bring in the real C declarations.
    const cstdio = pre('#include <cstdio>\nint main(void) { printf("hi"); return 0; }');
    expect(errors(cstdio)).toEqual([]);
    expect(find(cstdio, 'printf')?.file).toBe('<stdio.h>');
  });
});

describe('preprocessor: macro expansion', () => {
  it('expands an object-like macro', () => {
    const result = bare('#define PI 3.14\nPI\n');
    expect(texts(result)).toEqual(['3.14']);
  });

  it('expands a function-like macro, duplicating argument text', () => {
    const result = bare('#define SQ(x) ((x) * (x))\nSQ(3 + 1)\n');
    expect(texts(result)).toEqual(['(', '(', '3', '+', '1', ')', '*', '(', '3', '+', '1', ')', ')']);
  });

  it('expands nested macros', () => {
    const result = bare('#define A 1\n#define B A\nB\n');
    expect(texts(result)).toEqual(['1']);
  });

  it('terminates on a self-referential macro instead of hanging', () => {
    const result = bare('#define X X\nX\n');
    expect(texts(result)).toEqual(['X']);
  });

  it('leaves a function-like macro name alone when it is not invoked', () => {
    const result = bare('#define SQ(x) ((x) * (x))\nint SQ;\n');
    expect(texts(result)).toEqual(['int', 'SQ', ';']);
  });

  it('supports a multi-line definition', () => {
    const result = bare('#define MAX(a, b) \\\n  ((a) > (b) ? (a) : (b))\nMAX(1, 2)\n');
    expect(texts(result)).toEqual([
      '(', '(', '1', ')', '>', '(', '2', ')', '?', '(', '1', ')', ':', '(', '2', ')', ')',
    ]);
  });

  it('supports variadic macros through __VA_ARGS__', () => {
    const result = bare('#define LOG(fmt, ...) printf(fmt, __VA_ARGS__)\nLOG("%d", x)\n');
    expect(texts(result)).toEqual(['printf', '(', '"%d"', ',', 'x', ')']);
  });

  it('stringizes with #', () => {
    const result = bare('#define STR(x) #x\nSTR(hello world)\n');
    const token = result.tokens.find((item) => item.kind === 'string');
    expect(token?.value).toBe('hello world');
  });

  it('pastes with ##', () => {
    const result = bare('#define CAT(a, b) a##b\nCAT(foo, bar)\n');
    expect(texts(result)).toEqual(['foobar']);
    expect(warnings(result)).toEqual([]);
  });

  it('warns on redefinition and keeps the new body', () => {
    const result = bare('#define X 1\n#define X 2\nX\n');
    expect(warnings(result).some((item) => item.message.includes('redefined'))).toBe(true);
    expect(texts(result)).toEqual(['2']);
  });

  it('honours #undef', () => {
    const result = bare('#define X 1\n#undef X\nX\n');
    expect(texts(result)).toEqual(['X']);
  });

  it('provides __LINE__ and __FILE__', () => {
    const line = bare('int a = __LINE__;\n');
    expect(texts(line)).toEqual(['int', 'a', '=', '1', ';']);

    const file = bare('const char *f = __FILE__;\n');
    const stringToken = file.tokens.find((token) => token.kind === 'string');
    expect(stringToken?.value).toBe('main.c');
  });
});

describe('preprocessor: conditionals', () => {
  it('selects branches with #ifdef / #ifndef / #else / #endif', () => {
    const result = bare(
      [
        '#define FOO',
        '#ifdef FOO',
        'int a;',
        '#else',
        'int b;',
        '#endif',
        '#ifndef FOO',
        'int c;',
        '#endif',
      ].join('\n'),
    );

    const tokens = texts(result);
    expect(tokens).toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).not.toContain('c');
    expect(errors(result)).toEqual([]);
  });

  it('evaluates arithmetic, comparison and defined() in #if', () => {
    const result = bare(
      [
        '#define VERSION 2',
        '#if defined(VERSION) && VERSION * 3 == 6',
        'int ok;',
        '#else',
        'int bad;',
        '#endif',
      ].join('\n'),
    );

    expect(texts(result)).toContain('ok');
    expect(texts(result)).not.toContain('bad');
  });

  it('takes the #elif branch when the first condition is false', () => {
    const result = bare(
      ['#if 0', 'int a;', '#elif 1', 'int b;', '#else', 'int c;', '#endif'].join('\n'),
    );

    expect(texts(result)).toEqual(['int', 'b', ';']);
  });

  it('does not evaluate or report anything inside a skipped branch', () => {
    const result = bare(['#if 0', '#error must not fire', '#include "nope.h"', '#endif', 'int a;'].join('\n'));

    expect(errors(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
    expect(texts(result)).toEqual(['int', 'a', ';']);
  });

  it('tracks nesting so an inner false branch cannot leak out', () => {
    const result = bare(
      ['#if 1', '#if 0', 'int hidden;', '#endif', 'int visible;', '#endif'].join('\n'),
    );

    expect(texts(result)).toEqual(['int', 'visible', ';']);
  });

  it('reports an unterminated conditional and a stray #endif', () => {
    expect(errors(bare('#if 1\nint a;\n')).some((item) => item.message.includes('#endif'))).toBe(
      true,
    );
    expect(errors(bare('#endif\n')).some((item) => item.message.includes('#endif'))).toBe(true);
  });

  it('treats an undefined identifier in #if as 0', () => {
    const result = bare('#if NOT_DEFINED\nint a;\n#else\nint b;\n#endif\n');
    expect(texts(result)).toEqual(['int', 'b', ';']);
  });

  it('surfaces #error with its message', () => {
    const result = bare('#error something is wrong\n');
    const found = errors(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('something is wrong');
  });

  it('ignores comments and keeps working after a null directive', () => {
    const result = bare('#\n// nothing\nint a;\n');
    expect(texts(result)).toEqual(['int', 'a', ';']);
    expect(errors(result)).toEqual([]);
  });
});
