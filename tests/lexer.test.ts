import { describe, expect, it } from 'vitest';
import { lex } from '@/lang/lexer';
import type { Token } from '@/lang/token';

function tokensOf(source: string): readonly Token[] {
  return lex(source, 'main.c').tokens;
}

function texts(source: string): string[] {
  return tokensOf(source)
    .filter((token) => token.kind !== 'eof')
    .map((token) => token.text);
}

function kinds(source: string): string[] {
  return tokensOf(source)
    .filter((token) => token.kind !== 'eof')
    .map((token) => token.kind);
}

function firstMatch(source: string, text: string): Token | undefined {
  return tokensOf(source).find((token) => token.text === text);
}

describe('lexer: basic classification', () => {
  it('distinguishes keywords from identifiers', () => {
    expect(kinds('int main')).toEqual(['keyword', 'identifier']);
    expect(texts('sizeof x')).toEqual(['sizeof', 'x']);
  });

  it('keeps every pp-number variant as a single token', () => {
    expect(texts('0 42 3.14 1e-9 0x1Fu 0b1010 100L .5f')).toEqual([
      '0',
      '42',
      '3.14',
      '1e-9',
      '0x1Fu',
      '0b1010',
      '100L',
      '.5f',
    ]);
    expect(kinds('42')[0]).toBe('number');
  });

  it('applies longest-match for punctuators', () => {
    expect(texts('a >>= b')).toEqual(['a', '>>=', 'b']);
    expect(texts('a->b')).toEqual(['a', '->', 'b']);
    expect(texts('a -= -1')).toEqual(['a', '-=', '-', '1']);
    expect(texts('f(a, ...)')).toEqual(['f', '(', 'a', ',', '...', ')']);
    expect(texts('a::b')).toEqual(['a', '::', 'b']);
  });

  it('ends with a single eof token', () => {
    const all = tokensOf('int x;');
    expect(all[all.length - 1]?.kind).toBe('eof');
    expect(all.filter((token) => token.kind === 'eof')).toHaveLength(1);
  });
});

describe('lexer: comments and line tracking', () => {
  it('skips line and block comments while keeping line numbers exact', () => {
    const source = ['int a; // trailing', 'int b; /* multi', 'line */ int c;'].join('\n');
    const result = lex(source, 'main.c');

    expect(result.diagnostics).toEqual([]);
    expect(texts(source)).toEqual(['int', 'a', ';', 'int', 'b', ';', 'int', 'c', ';']);
    expect(firstMatch(source, 'b')?.start.line).toBe(2);
    expect(firstMatch(source, 'c')?.start.line).toBe(3);
    // `line */ int c;` -> c sits at column 13.
    expect(firstMatch(source, 'c')?.start.column).toBe(13);
  });

  it('joins continuation lines but still reports the physical line', () => {
    const source = 'int a\\\nb;';
    const result = lex(source, 'main.c');

    expect(result.diagnostics).toEqual([]);
    expect(texts(source)).toEqual(['int', 'a', 'b', ';']);
    expect(firstMatch(source, 'b')?.start.line).toBe(2);
  });

  it('reports an unterminated block comment instead of silently dropping the rest', () => {
    const result = lex('int a; /* never closed', 'main.c');
    const errors = result.diagnostics.filter((item) => item.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('unterminated block comment');
  });
});

describe('lexer: literals', () => {
  it('decodes string escapes into the token value', () => {
    const token = firstMatch('"a\\nb"', '"a\\nb"');
    expect(token?.kind).toBe('string');
    expect(token?.value).toBe('a\nb');
  });

  it('decodes hex and octal escapes', () => {
    expect(firstMatch('"\\x41"', '"\\x41"')?.value).toBe('A');
    expect(firstMatch('"\\101"', '"\\101"')?.value).toBe('A');
  });

  it('decodes character literals including escaped quotes', () => {
    expect(firstMatch("'a'", "'a'")?.kind).toBe('char');
    expect(firstMatch("'a'", "'a'")?.value).toBe('a');
    expect(firstMatch("'\\\\'", "'\\\\'")?.value).toBe('\\');
  });

  it('handles u8/L prefixed literals as string and char tokens', () => {
    expect(kinds('u8"hi"')).toEqual(['string']);
    expect(firstMatch('u8"hi"', 'u8"hi"')?.value).toBe('hi');
    expect(kinds("L'a'")).toEqual(['char']);
  });

  it('reports an unterminated string literal', () => {
    const result = lex('char *s = "oops;', 'main.c');
    const errors = result.diagnostics.filter((item) => item.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('unterminated string');
  });

  it('degrades a C++ raw string to a warning plus a skippable token', () => {
    const result = lex('auto s = R"(raw)";', 'main.cpp');
    expect(result.diagnostics.some((item) => item.severity === 'warning')).toBe(true);
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(false);
    expect(texts('auto s = R"(raw)";')).toEqual(['auto', 's', '=', 'R"(raw)"', ';']);
  });
});

describe('lexer: logical vs physical lines (directive detection)', () => {
  it('keeps a continued line on the same logical line so multi-line #define works', () => {
    const source = '#define MAX(a, b) \\\n  ((a) > (b) ? (a) : (b))\nint x;';
    const tokens = tokensOf(source);

    expect(tokens.find((token) => token.text === '#')?.atLineStart).toBe(true);
    // Every token of the macro body still belongs to the directive line.
    expect(tokens.filter((token) => token.text === 'b').every((token) => !token.atLineStart)).toBe(
      true,
    );
    expect(tokens.find((token) => token.text === 'int')?.atLineStart).toBe(true);
  });

  it('treats the first token after a multi-line comment as starting its line', () => {
    const tokens = tokensOf('/* a\nb */ int x;');
    expect(tokens.find((token) => token.text === 'int')?.atLineStart).toBe(true);
  });

  it('does not mark a multi-line string as starting its line', () => {
    const stringToken = tokensOf('char *s = "a\\\nb";').find((token) => token.kind === 'string');
    expect(stringToken?.atLineStart).toBe(false);
    expect(stringToken?.value).toBe('ab');
  });
});

describe('lexer: data the preprocessor depends on', () => {
  it('flags a directive hash at line start, with leading whitespace allowed', () => {
    const source = '#include <stdio.h>\n  #  define X 1\nint y;';

    expect(firstMatch(source, '#')?.atLineStart).toBe(true);

    const hashes = tokensOf(source).filter((token) => token.text === '#');
    expect(hashes).toHaveLength(2);
    expect(hashes[1]?.atLineStart).toBe(true);
    expect(hashes[1]?.hasLeadingSpace).toBe(true);

    expect(firstMatch(source, 'y')?.atLineStart).toBe(false);
  });

  it('does not treat a hash following real code as a directive', () => {
    const source = 'int x; # define Y 1';
    expect(firstMatch(source, '#')?.atLineStart).toBe(false);
  });

  it('records include-style angle brackets as ordinary punctuators', () => {
    expect(texts('#include <stdio.h>')).toEqual(['#', 'include', '<', 'stdio', '.', 'h', '>']);
  });

  it('reports characters that are valid in neither language', () => {
    const result = lex('int a` = 1;', 'main.c');
    const errors = result.diagnostics.filter((item) => item.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('unexpected character');
    expect(errors[0]?.startColumn).toBe(6);
  });
});
