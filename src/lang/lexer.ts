import type { Diagnostic } from '@/engine/types';
import { makeDiagnostic } from '@/lang/diagnostics';
import { isKeyword } from '@/lang/keywords';
import type { SourcePos, Token, TokenKind } from '@/lang/token';

/**
 * C/C++ tokenizer.
 *
 * Design notes:
 *  - Tokens keep exact source positions because both Monaco markers and the
 *    watch pane need to point at real user code.
 *  - `atLineStart` / `hasLeadingSpace` are recorded although the parser does not
 *    need them: the preprocessor does, to recognise directives and to render
 *    macro-expanded text.
 *  - Numbers use the standard *pp-number* rule (digits plus letters, dots and
 *    exponent signs) so `1.5f`, `0x1Fu`, `1e-9` and `123abc` all come out as one
 *    token; validation is the parser's job, not the lexer's.
 */

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const PUNCTUATORS: readonly string[] = [
  '<<=', '>>=', '->*', '...', '::', '->', '++', '--', '<<', '>>', '<=', '>=', '==',
  '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', ':', '?', '~', '!',
  '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '=',
  '#', '@', '\\',
];

const SORTED_PUNCTUATORS: readonly string[] = [...PUNCTUATORS].sort(
  (a, b) => b.length - a.length,
);

/** String literal prefixes accepted before a `"` / `'` (C and C++). */
const LITERAL_PREFIXES: readonly string[] = ['u8', 'u', 'U', 'L'];

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isIdentifierStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
  );
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code);
}

function isHorizontalSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 11 || code === 12 || code === 13;
}

function isNewline(code: number): boolean {
  return code === 10;
}

interface EscapeResult {
  readonly text: string;
  readonly next: number;
  readonly problem?: string;
}

function decodeEscape(source: string, slashIndex: number): EscapeResult {
  const code = source.charCodeAt(slashIndex + 1);
  const simple: Record<number, string> = {
    110: '\n', // n
    116: '\t', // t
    114: '\r', // r
    97: '\x07', // a
    98: '\b', // b
    102: '\f', // f
    118: '\v', // v
    92: '\\', // backslash
    39: "'",
    34: '"',
    63: '?',
  };

  // Octal escape (including \0) must be handled before the simple map, which
  // would otherwise swallow the leading digit of \012.
  if (code >= 48 && code <= 55) {
    let index = slashIndex + 1;
    let digits = '';
    while (index < source.length && digits.length < 3) {
      const digit = source.charCodeAt(index);
      if (digit < 48 || digit > 55) break;
      digits += source.charAt(index);
      index += 1;
    }
    return { text: String.fromCodePoint(Number.parseInt(digits, 8) & 0xff), next: index };
  }

  const mapped = simple[code];
  if (mapped !== undefined) return { text: mapped, next: slashIndex + 2 };

  if (code === 120) {
    // \xHH...
    let index = slashIndex + 2;
    let digits = '';
    while (index < source.length && isHexDigit(source.charCodeAt(index))) {
      digits += source.charAt(index);
      index += 1;
    }
    if (digits.length === 0) {
      return { text: 'x', next: slashIndex + 2, problem: '\\x used with no hex digits' };
    }
    const value = Number.parseInt(digits, 16);
    return { text: String.fromCodePoint(value & 0x10ffff), next: index };
  }

  if (Number.isNaN(code)) {
    return { text: '', next: slashIndex + 1, problem: 'unterminated escape sequence' };
  }

  // Unknown escape: C leaves it implementation-defined; keep the character.
  return { text: source.charAt(slashIndex + 1), next: slashIndex + 2 };
}

interface QuotedResult {
  readonly end: number;
  readonly value: string;
  readonly terminated: boolean;
  readonly problems: readonly string[];
}

/** Scans a `"`- or `'`-delimited literal starting at `start` (the opening quote). */
function scanQuoted(source: string, start: number, quote: number): QuotedResult {
  let index = start + 1;
  let value = '';
  const problems: string[] = [];

  while (index < source.length) {
    const code = source.charCodeAt(index);

    if (code === quote) {
      return { end: index + 1, value, terminated: true, problems };
    }

    if (isNewline(code)) {
      // A raw newline terminates the literal: this is an error, resync there.
      return { end: index, value, terminated: false, problems };
    }

    if (code === 92) {
      // Line continuation inside a literal.
      let next = index + 1;
      if (source.charCodeAt(next) === 13) next += 1;
      if (source.charCodeAt(next) === 10) {
        index = next + 1;
        continue;
      }
      const escaped = decodeEscape(source, index);
      if (escaped.problem) problems.push(escaped.problem);
      value += escaped.text;
      index = escaped.next;
      continue;
    }

    value += source.charAt(index);
    index += 1;
  }

  return { end: source.length, value, terminated: false, problems };
}

export function lex(source: string, file: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];

  let index = 0;
  let line = 1;
  let lineStart = 0;
  let sawTokenOnLine = false;
  let pendingSpace = false;
  // Snapshot of the flags taken when a token starts, so a token that spans lines
  // (multi-line string, block comment) reports the state of its FIRST line.
  let tokenAtLineStart = false;
  let tokenLeadingSpace = false;

  const here = (): SourcePos => ({ offset: index, line, column: index - lineStart + 1, file });

  /** Must be called immediately before consuming a token's text. */
  const markStart = (): SourcePos => {
    tokenAtLineStart = !sawTokenOnLine;
    tokenLeadingSpace = pendingSpace;
    return here();
  };

  /** Recomputes line/lineStart after consuming a multi-line span. */
  const syncLines = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (source.charCodeAt(cursor) === 10) {
        line += 1;
        lineStart = cursor + 1;
        sawTokenOnLine = false;
      }
    }
  };

  const emit = (kind: TokenKind, startOffset: number, start: SourcePos, value?: string): void => {
    const end: SourcePos = { offset: index, line, column: index - lineStart + 1, file };
    tokens.push({
      kind,
      text: source.slice(startOffset, index),
      start,
      end,
      atLineStart: tokenAtLineStart,
      hasLeadingSpace: tokenLeadingSpace,
      includeDepth: 0,
      file,
      ...(value === undefined ? {} : { value }),
    });
    sawTokenOnLine = true;
    pendingSpace = false;
  };

  while (index < source.length) {
    const code = source.charCodeAt(index);

    // Line continuation: backslash immediately followed by a newline.
    if (code === 92) {
      let next = index + 1;
      if (source.charCodeAt(next) === 13) next += 1;
      if (source.charCodeAt(next) === 10) {
        index = next + 1;
        line += 1;
        lineStart = index;
        // A continued line is still the same LOGICAL line: keep sawTokenOnLine,
        // otherwise a multi-line #define would look like the end of a directive.
        pendingSpace = true;
        continue;
      }
    }

    if (isNewline(code)) {
      index += 1;
      line += 1;
      lineStart = index;
      sawTokenOnLine = false;
      pendingSpace = false;
      continue;
    }

    if (isHorizontalSpace(code)) {
      pendingSpace = true;
      index += 1;
      continue;
    }

    // Comments.
    if (code === 47 /* / */) {
      const next = source.charCodeAt(index + 1);
      if (next === 47) {
        const lineEnd = source.indexOf('\n', index);
        index = lineEnd === -1 ? source.length : lineEnd;
        pendingSpace = true;
        continue;
      }
      if (next === 42 /* * */) {
        const commentStart = here();
        const close = source.indexOf('*/', index + 2);
        if (close === -1) {
          index = source.length;
          syncLines(commentStart.offset, index);
          diagnostics.push(
            makeDiagnostic('error', 'unterminated block comment', file, commentStart, here()),
          );
          pendingSpace = true;
          continue;
        }
        index = close + 2;
        syncLines(commentStart.offset, index);
        pendingSpace = true;
        continue;
      }
    }

    // Identifiers, keywords and prefixed literals.
    if (isIdentifierStart(code)) {
      const startOffset = index;
      const start = markStart();
      let cursor = index;
      while (cursor < source.length && isIdentifierPart(source.charCodeAt(cursor))) cursor += 1;
      const text = source.slice(startOffset, cursor);
      const after = source.charCodeAt(cursor);

      if (LITERAL_PREFIXES.includes(text) && (after === 34 || after === 39)) {
        index = cursor;
        const quote = after;
        const literal = scanQuoted(source, index, quote);
        index = literal.end;
        syncLines(startOffset, index);
        const kind: TokenKind = quote === 34 ? 'string' : 'char';
        emit(kind, startOffset, start, literal.value);
        if (!literal.terminated) {
          diagnostics.push(
            makeDiagnostic(
              'error',
              quote === 34 ? 'unterminated string literal' : 'unterminated character literal',
              file,
              start,
              here(),
            ),
          );
        }
        for (const problem of literal.problems) {
          diagnostics.push(makeDiagnostic('warning', problem, file, start, here()));
        }
        continue;
      }

      if (
        (text === 'R' || text === 'u8R' || text === 'LR' || text === 'uR' || text === 'UR') &&
        after === 34
      ) {
        // C++ raw string: R"delimiter(content)delimiter"
        const delimCursor = cursor + 1;
        const parenIndex = source.indexOf('(', delimCursor);
        if (parenIndex !== -1 && parenIndex - delimCursor <= 16) {
          const delimiter = source.slice(delimCursor, parenIndex);
          const contentStart = parenIndex + 1;
          const closingPattern = `)${delimiter}"`;
          const closeIndex = source.indexOf(closingPattern, contentStart);
          if (closeIndex !== -1) {
            index = closeIndex + closingPattern.length;
            syncLines(startOffset, index);
            const content = source.slice(contentStart, closeIndex);
            emit('string', startOffset, start, content);
            continue;
          }
        }
        // Fallback for unterminated raw string literal
        const fallbackClose = source.indexOf(')"', cursor);
        index = fallbackClose === -1 ? source.length : fallbackClose + 2;
        syncLines(startOffset, index);
        emit('string', startOffset, start, '');
        diagnostics.push(
          makeDiagnostic('error', 'unterminated raw string literal', file, start, here()),
        );
        continue;
      }

      index = cursor;
      emit(isKeyword(text) ? 'keyword' : 'identifier', startOffset, start);
      continue;
    }

    // Numbers (pp-number).
    if (isDigit(code) || (code === 46 && isDigit(source.charCodeAt(index + 1)))) {
      const startOffset = index;
      const start = markStart();
      let cursor = index;
      if (source.charCodeAt(cursor) === 46) cursor += 1;
      while (cursor < source.length) {
        const current = source.charCodeAt(cursor);
        if (isIdentifierPart(current) || current === 46) {
          cursor += 1;
          continue;
        }
        if (current === 43 || current === 45) {
          const previous = source.charCodeAt(cursor - 1);
          if (previous === 101 || previous === 69 || previous === 112 || previous === 80) {
            cursor += 1;
            continue;
          }
        }
        break;
      }
      index = cursor;
      emit('number', startOffset, start);
      continue;
    }

    // String / char literals without a prefix.
    if (code === 34 || code === 39) {
      const startOffset = index;
      const start = markStart();
      const literal = scanQuoted(source, index, code);
      index = literal.end;
      syncLines(startOffset, index);
      emit(code === 34 ? 'string' : 'char', startOffset, start, literal.value);
      if (!literal.terminated) {
        diagnostics.push(
          makeDiagnostic(
            'error',
            code === 34 ? 'unterminated string literal' : 'unterminated character literal',
            file,
            start,
            here(),
          ),
        );
      }
      for (const problem of literal.problems) {
        diagnostics.push(makeDiagnostic('warning', problem, file, start, here()));
      }
      continue;
    }

    // Punctuators: longest match wins so `>>=` never lexes as `>` `>` `=`.
    const matched = SORTED_PUNCTUATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (matched !== undefined) {
      const startOffset = index;
      const start = markStart();
      index += matched.length;
      emit('punctuator', startOffset, start);
      continue;
    }

    // Anything else is not valid in either language.
    const startOffset = index;
    const start = here();
    index += 1;
    const text = source.slice(startOffset, index);
    diagnostics.push(
      makeDiagnostic('error', `unexpected character ${JSON.stringify(text)}`, file, start, here()),
    );
  }

  tokens.push({
    kind: 'eof',
    text: '',
    start: here(),
    end: here(),
    atLineStart: !sawTokenOnLine,
    hasLeadingSpace: pendingSpace,
    includeDepth: 0,
    file,
  });

  return { tokens, diagnostics };
}

export function isHexDigitChar(code: number): boolean {
  return isHexDigit(code);
}
