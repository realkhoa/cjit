/**
 * Source positions are 1-based in line/column to match Monaco and the engine
 * `Diagnostic` shape.
 *
 * `file` is part of the position on purpose: with built-in headers inlined into
 * one token stream, identifiers are only unique per file. Offset 120 of
 * `<stdio.h>` and offset 120 of `main.c` are different places, and diagnostics,
 * markers, symbols and go-to-definition all have to say which one they mean.
 */
export interface SourcePos {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly file: string;
}

export type TokenKind =
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'string'
  | 'char'
  | 'punctuator'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Raw source text of the token. */
  readonly text: string;
  /** Decoded contents for string/char literals. */
  readonly value?: string;
  readonly start: SourcePos;
  readonly end: SourcePos;
  /** True when only whitespace/comments precede it on its logical line. */
  readonly atLineStart: boolean;
  readonly hasLeadingSpace: boolean;
  /** 0 when the token came from the main file; otherwise the include depth. */
  readonly includeDepth: number;
  /** File the token came from: the main path, or `<stdio.h>` for a built-in header. */
  readonly file: string;
  /** Identifier of the macro that produced this token during expansion. */
  readonly fromMacro?: string;
}

export function isIdentifier(token: Token, text?: string): boolean {
  if (token.kind !== 'identifier') return false;
  return text === undefined || token.text === text;
}

export function isPunctuator(token: Token, text?: string): boolean {
  if (token.kind !== 'punctuator') return false;
  return text === undefined || token.text === text;
}

export function isKeywordToken(token: Token, text?: string): boolean {
  if (token.kind !== 'keyword') return false;
  return text === undefined || token.text === text;
}

/** Compact `text` rendering used in tests and diagnostics. */
export function describeToken(token: Token): string {
  if (token.kind === 'eof') return '<eof>';
  return token.text;
}
