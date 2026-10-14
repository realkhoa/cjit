import type { Diagnostic } from '@/engine/types';
import { makeDiagnostic } from '@/lang/diagnostics';
import {
  BITS_HEADER_NOTE,
  BUILTIN_HEADERS,
  CPP_NATIVE_HEADERS,
  IMPLICIT_HEADER_NAMES,
  PRELUDE_LABEL,
  PRELUDE_SOURCE,
  headerAliasTarget,
  headerLabel,
} from '@/lang/headers';
import { lex } from '@/lang/lexer';
import { isPunctuator } from '@/lang/token';
import type { Token } from '@/lang/token';

/**
 * C preprocessor for the fast engine.
 *
 * Implemented, because real programs use them constantly:
 *   #include (built-in headers), #define (object- and function-like, variadic),
 *   #undef, # / ## operators, #if / #ifdef / #ifndef / #elif / #else / #endif with
 *   a real constant-expression evaluator, #error / #warning, `defined`, and
 *   __LINE__ / __FILE__.
 *
 * Deliberately not implemented (each one says so in a diagnostic instead of
 * guessing): local includes, `_Pragma`, trigraphs, and including a built-in
 * header more than once - built-in headers are always *include-once*.
 */

export interface MacroDefinition {
  readonly name: string;
  /** `null` for object-like macros. */
  readonly params: readonly string[] | null;
  readonly variadic: boolean;
  readonly body: readonly Token[];
}

export interface PreprocessResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
  readonly macros: ReadonlyMap<string, MacroDefinition>;
  /** Virtual documents created by includes, keyed by label (`<stdio.h>`). */
  readonly sources: ReadonlyMap<string, string>;
  readonly includedFiles: readonly string[];
  /** True when the C library surface was pre-included, so no #include is needed. */
  readonly implicitHeaders: boolean;
}

export interface PreprocessOptions {
  readonly includePrelude?: boolean;
  /** Pre-include the C library surface. Default true. */
  readonly implicitHeaders?: boolean;
  readonly maxIncludeDepth?: number;
  readonly maxExpansionDepth?: number;
  readonly maxOutputTokens?: number;
}

const DEFAULT_MAX_INCLUDE_DEPTH = 16;
const DEFAULT_MAX_EXPANSION_DEPTH = 96;
const DEFAULT_MAX_OUTPUT_TOKENS = 200_000;
const VARIADIC_NAME = '__VA_ARGS__';

interface ConditionalFrame {
  readonly parentActive: boolean;
  active: boolean;
  taken: boolean;
  readonly token: Token;
}

function parseIntegerLiteral(text: string): number {
  let body = text.replace(/[uUlL]+$/, '');
  if (body.includes('.') || /[eEpP]/.test(body)) {
    const asFloat = Number.parseFloat(body);
    return Number.isNaN(asFloat) ? 0 : Math.trunc(asFloat);
  }
  if (/^0[xX]/.test(body)) {
    const value = Number.parseInt(body.slice(2), 16);
    return Number.isNaN(value) ? 0 : value;
  }
  if (/^0[bB]/.test(body)) {
    const value = Number.parseInt(body.slice(2), 2);
    return Number.isNaN(value) ? 0 : value;
  }
  if (body.length > 1 && body.startsWith('0')) {
    const value = Number.parseInt(body.slice(1), 8);
    return Number.isNaN(value) ? 0 : value;
  }
  const value = Number.parseInt(body, 10);
  return Number.isNaN(value) ? 0 : value;
}

const BINARY_PRECEDENCE: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

class ConditionEvaluator {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly warn: (token: Token, message: string) => void,
  ) {}

  evaluate(): number {
    const value = this.parseConditional();
    const leftover = this.tokens[this.index];
    if (leftover) this.warn(leftover, 'unexpected token in #if expression');
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private parseConditional(): number {
    const condition = this.parseBinary(0);
    const token = this.peek();
    if (token && isPunctuator(token, '?')) {
      this.index += 1;
      const whenTrue = this.parseConditional();
      const colon = this.peek();
      if (colon && isPunctuator(colon, ':')) this.index += 1;
      const whenFalse = this.parseConditional();
      return condition !== 0 ? whenTrue : whenFalse;
    }
    return condition;
  }

  private parseBinary(level: number): number {
    const operators = BINARY_PRECEDENCE[level];
    if (operators === undefined) return this.parseUnary();

    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== 'punctuator' || !operators.includes(token.text)) break;
      this.index += 1;
      const right = this.parseBinary(level + 1);
      left = this.applyBinary(token, left, right);
    }
    return left;
  }

  private applyBinary(token: Token, left: number, right: number): number {
    switch (token.text) {
      case '||':
        return left !== 0 || right !== 0 ? 1 : 0;
      case '&&':
        return left !== 0 && right !== 0 ? 1 : 0;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      case '&':
        return left & right;
      case '==':
        return left === right ? 1 : 0;
      case '!=':
        return left !== right ? 1 : 0;
      case '<':
        return left < right ? 1 : 0;
      case '<=':
        return left <= right ? 1 : 0;
      case '>':
        return left > right ? 1 : 0;
      case '>=':
        return left >= right ? 1 : 0;
      case '<<':
        return left << right;
      case '>>':
        return left >> right;
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) {
          this.warn(token, 'division by zero in #if expression');
          return 0;
        }
        return Math.trunc(left / right);
      case '%':
        if (right === 0) {
          this.warn(token, 'division by zero in #if expression');
          return 0;
        }
        return left % right;
      default:
        return 0;
    }
  }

  private parseUnary(): number {
    const token = this.peek();
    if (!token) return 0;

    if (token.kind === 'punctuator') {
      switch (token.text) {
        case '!':
          this.index += 1;
          return this.parseUnary() === 0 ? 1 : 0;
        case '~':
          this.index += 1;
          return ~this.parseUnary();
        case '-':
          this.index += 1;
          return -this.parseUnary();
        case '+':
          this.index += 1;
          return this.parseUnary();
        case '(': {
          this.index += 1;
          const value = this.parseConditional();
          const close = this.peek();
          if (close && isPunctuator(close, ')')) this.index += 1;
          else this.warn(token, "missing ')' in #if expression");
          return value;
        }
        default:
          break;
      }
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (!token) return 0;
    this.index += 1;

    if (token.kind === 'number') return parseIntegerLiteral(token.text);
    if (token.kind === 'char') return (token.value ?? '\0').charCodeAt(0);
    // An identifier that survived expansion is 0, per the standard.
    return 0;
  }
}

class Preprocessor {
  private readonly work: Token[] = [];
  private readonly output: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly macros = new Map<string, MacroDefinition>();
  private readonly included = new Set<string>();
  private readonly includedOrder: string[] = [];
  private readonly sources = new Map<string, string>();
  private readonly conditionals: ConditionalFrame[] = [];
  private pendingSplice: Token[] = [];
  private readonly maxIncludeDepth: number;
  private readonly maxExpansionDepth: number;
  private readonly maxOutputTokens: number;
  private readonly implicitHeaders: boolean;

  constructor(source: string, file: string, options: PreprocessOptions) {
    this.maxIncludeDepth = options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
    this.maxExpansionDepth = options.maxExpansionDepth ?? DEFAULT_MAX_EXPANSION_DEPTH;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.implicitHeaders = options.implicitHeaders !== false;

    this.sources.set(file, source);

    if (options.includePrelude !== false) {
      this.sources.set(PRELUDE_LABEL, PRELUDE_SOURCE);
      const prelude = lex(PRELUDE_SOURCE, PRELUDE_LABEL);
      for (const diagnostic of prelude.diagnostics) this.diagnostics.push(diagnostic);
      for (const token of prelude.tokens) {
        if (token.kind === 'eof') continue;
        this.work.push({ ...token, includeDepth: 1 });
      }
    }

    if (this.implicitHeaders) {
      for (const name of IMPLICIT_HEADER_NAMES) {
        const headerSource = BUILTIN_HEADERS.get(name);
        if (headerSource === undefined) continue;
        // Registered in the include-once set, so an explicit
        // `#include <stdio.h>` later is a no-op instead of a redefinition.
        this.included.add(name);
        this.includedOrder.push(headerLabel(name));
        for (const token of this.lexHeader(name, headerSource, 1)) this.work.push(token);
      }
    }

    const main = lex(source, file);
    for (const diagnostic of main.diagnostics) this.diagnostics.push(diagnostic);
    this.work.push(...main.tokens);

    this.macros.set('__STDC__', { name: '__STDC__', params: null, variadic: false, body: [] });
  }

  private get active(): boolean {
    const last = this.conditionals[this.conditionals.length - 1];
    return last === undefined ? true : last.active;
  }

  private warn(token: Token | undefined, message: string): void {
    if (!token) return;
    this.diagnostics.push(makeDiagnostic('warning', message, token.file, token.start, token.end));
  }

  private error(token: Token | undefined, message: string): void {
    if (!token) return;
    this.diagnostics.push(makeDiagnostic('error', message, token.file, token.start, token.end));
  }

  private info(token: Token | undefined, message: string): void {
    if (!token) return;
    this.diagnostics.push(makeDiagnostic('info', message, token.file, token.start, token.end));
  }

  run(): PreprocessResult {
    let cursor = 0;
    while (cursor < this.work.length) {
      if (this.output.length > this.maxOutputTokens) {
        const token = this.work[cursor];
        this.warn(token, 'preprocessing produced too many tokens; stopping');
        break;
      }

      const token = this.work[cursor];
      if (token === undefined || token.kind === 'eof') break;

      if (token.kind === 'punctuator' && token.text === '#' && token.atLineStart) {
        cursor = this.handleDirective(cursor);
        continue;
      }

      if (!this.active) {
        cursor += 1;
        continue;
      }

      const expanded = this.expandAt(this.work, cursor, EMPTY_DISABLED, 0);
      for (const item of expanded.tokens) this.output.push(item);
      cursor = expanded.next;
    }

    for (const frame of this.conditionals) {
      this.error(frame.token, 'unterminated conditional directive (#if without #endif)');
    }

    const eof = this.work[this.work.length - 1];
    if (eof) this.output.push(eof);

    return {
      tokens: this.output,
      diagnostics: this.diagnostics,
      macros: this.macros,
      sources: this.sources,
      includedFiles: this.includedOrder,
      implicitHeaders: this.implicitHeaders,
    };
  }

  private handleDirective(cursor: number): number {
    const head: Token[] = [];
    let index = cursor;
    while (index < this.work.length) {
      const token = this.work[index];
      if (token === undefined || token.kind === 'eof') break;
      if (index > cursor && token.atLineStart) break;
      head.push(token);
      index += 1;
    }
    const next = index;

    const hash = head[0];
    // head always contains at least the '#' we were called on.
    if (hash === undefined) return this.finishDirective(next);

    const nameToken = head[1];
    const name =
      nameToken && (nameToken.kind === 'identifier' || nameToken.kind === 'keyword')
        ? nameToken.text
        : '';
    const args = head.slice(2);

    switch (name) {
      case 'if':
        this.pushConditional(hash, this.evaluateCondition(args));
        return this.finishDirective(next);
      case 'ifdef':
        this.pushConditional(hash, this.hasMacro(args[0]) ? 1 : 0);
        return this.finishDirective(next);
      case 'ifndef':
        this.pushConditional(hash, this.hasMacro(args[0]) ? 0 : 1);
        return this.finishDirective(next);
      case 'elif':
        this.handleElif(hash, args);
        return this.finishDirective(next);
      case 'else':
        this.handleElse(hash);
        return this.finishDirective(next);
      case 'endif':
        this.handleEndif(hash);
        return this.finishDirective(next);
      default:
        break;
    }

    if (!this.active) return this.finishDirective(next);

    switch (name) {
      case '':
        break;
      case 'define':
        // args[0] is the macro NAME; nameToken is the word "define".
        this.defineMacro(args[0], args.slice(1));
        break;
      case 'undef': {
        const target = args[0];
        if (isNameToken(target)) this.macros.delete(target.text);
        else this.warn(nameToken ?? hash, 'expected a macro name after #undef');
        break;
      }
      case 'include':
        this.handleInclude(args, hash);
        break;
      case 'error':
        this.error(hash, `#error ${renderTokens(args)}`.trim());
        break;
      case 'warning':
      case 'warn':
        this.warn(hash, `#warning ${renderTokens(args)}`.trim());
        break;
      case 'pragma':
      case 'line':
        // `#pragma once` is implicit for every built-in header; nothing to do.
        break;
      default:
        this.warn(hash, `unknown preprocessor directive #${name}`);
        break;
    }

    return this.finishDirective(next);
  }

  private finishDirective(next: number): number {
    if (this.pendingSplice.length > 0) {
      this.work.splice(next, 0, ...this.pendingSplice);
      this.pendingSplice = [];
    }
    return next;
  }

  private hasMacro(token: Token | undefined): boolean {
    return isNameToken(token) && this.macros.has(token.text);
  }

  private pushConditional(token: Token | undefined, value: number): void {
    const parentActive = this.active;
    const active = parentActive && value !== 0;
    if (token) {
      this.conditionals.push({ parentActive, active, taken: active, token });
    }
  }

  private handleElif(token: Token | undefined, args: readonly Token[]): void {
    const frame = this.conditionals[this.conditionals.length - 1];
    if (!frame) {
      this.error(token, 'unexpected #elif without #if');
      return;
    }
    if (!frame.parentActive || frame.taken) {
      frame.active = false;
      return;
    }
    const value = this.evaluateCondition(args) !== 0;
    frame.active = value;
    frame.taken = value;
  }

  private handleElse(token: Token | undefined): void {
    const frame = this.conditionals[this.conditionals.length - 1];
    if (!frame) {
      this.error(token, 'unexpected #else without #if');
      return;
    }
    frame.active = frame.parentActive && !frame.taken;
    frame.taken = true;
  }

  private handleEndif(token: Token | undefined): void {
    if (this.conditionals.length === 0) {
      this.error(token, 'unexpected #endif without #if');
      return;
    }
    this.conditionals.pop();
  }

  private defineMacro(nameToken: Token | undefined, rest: readonly Token[]): void {
    if (!isNameToken(nameToken)) {
      this.error(nameToken ?? rest[0], 'expected a macro name after #define');
      return;
    }

    const name = nameToken.text;
    let params: string[] | null = null;
    let variadic = false;
    let bodyStart = 0;

    const first = rest[0];
    // Function-like only when '(' touches the name, exactly like real C.
    const functionLike =
      first !== undefined && isPunctuator(first, '(') && first.start.offset === nameToken.end.offset;

    if (functionLike) {
      const list: string[] = [];
      let index = 1;
      let closed = false;
      while (index < rest.length) {
        const token = rest[index];
        if (token === undefined) break;
        if (isPunctuator(token, ')')) {
          closed = true;
          index += 1;
          break;
        }
        if (isPunctuator(token, ',')) {
          index += 1;
          continue;
        }
        if (isPunctuator(token, '...')) {
          variadic = true;
          list.push(VARIADIC_NAME);
          index += 1;
          continue;
        }
        if (token.kind === 'identifier') {
          list.push(token.text);
          index += 1;
          continue;
        }
        index += 1;
      }
      if (!closed) this.warn(nameToken, `macro "${name}" has an unterminated parameter list`);
      params = list;
      bodyStart = index;
    }

    const body = rest.slice(bodyStart);
    const existing = this.macros.get(name);
    if (existing && !sameMacro(existing, params, variadic, body)) {
      this.warn(nameToken, `macro "${name}" redefined`);
    }

    this.macros.set(name, { name, params, variadic, body });
  }

  private handleInclude(args: readonly Token[], hash: Token): void {
    const first = args[0];
    if (!first) {
      this.error(hash, 'expected a file name after #include');
      return;
    }

    let name = '';
    let systemStyle = false;

    if (first.kind === 'string') {
      name = first.value ?? first.text.replace(/"/g, '');
    } else if (isPunctuator(first, '<')) {
      systemStyle = true;
      let close: Token | undefined;
      for (let index = 1; index < args.length; index += 1) {
        const candidate = args[index];
        if (candidate && isPunctuator(candidate, '>')) {
          close = candidate;
          break;
        }
      }
      const source = this.sources.get(first.file);
      const from = args[1]?.start.offset ?? first.end.offset;
      if (!close || source === undefined) {
        this.error(hash, "missing '>' in #include");
        return;
      }
      name = source.slice(from, close.start.offset).trim();
    } else {
      this.error(hash, 'malformed #include');
      return;
    }

    const builtin = BUILTIN_HEADERS.get(name);
    if (builtin !== undefined) {
      if (name === 'bits/stdc++.h' || name === 'stdc++.h') {
        this.info(hash, BITS_HEADER_NOTE);
      }
      // Include-once: covers both a repeated include and the implicit pre-include.
      if (this.included.has(name)) return;
      this.included.add(name);
      this.includedOrder.push(headerLabel(name));
      this.spliceHeader(name, builtin, hash);
      return;
    }

    if (!systemStyle) {
      this.warn(
        hash,
        `local include "${name}" is not supported yet; only built-in headers are available`,
      );
      return;
    }

    // A C++ wrapper such as <cstdio> resolves to the C header it wraps, so the
    // include has real declarations instead of being dropped.
    const alias = headerAliasTarget(name);
    if (alias !== undefined) {
      const target = BUILTIN_HEADERS.get(alias);
      if (target !== undefined) {
        this.included.add(name);
        this.includedOrder.push(headerLabel(name));
        if (!this.included.has(alias)) {
          this.included.add(alias);
          this.includedOrder.push(headerLabel(alias));
          this.spliceHeader(alias, target, hash);
        }
        return;
      }
    }

    // A C++ header the engine implements natively: nothing to inline, and
    // nothing to warn about either.
    if (CPP_NATIVE_HEADERS.has(name)) {
      this.included.add(name);
      this.includedOrder.push(headerLabel(name));
      return;
    }

    this.warn(hash, `unknown header <${name}> ignored by the fast engine`);
  }

  private spliceHeader(name: string, source: string, origin: Token): void {
    const depth = origin.includeDepth + 1;
    if (depth > this.maxIncludeDepth) {
      this.warn(origin, `include nesting deeper than ${this.maxIncludeDepth} levels; ignored`);
      return;
    }
    for (const token of this.lexHeader(name, source, depth)) this.pendingSplice.push(token);
  }

  /** Lexes a virtual header and stamps its include depth. */
  private lexHeader(name: string, source: string, depth: number): Token[] {
    const label = headerLabel(name);
    this.sources.set(label, source);

    const lexed = lex(source, label);
    for (const diagnostic of lexed.diagnostics) this.diagnostics.push(diagnostic);

    const tokens: Token[] = [];
    for (const token of lexed.tokens) {
      if (token.kind === 'eof') continue;
      tokens.push({ ...token, includeDepth: depth });
    }
    return tokens;
  }

  private evaluateCondition(rawTokens: readonly Token[]): number {
    // `defined X` / `defined(X)` must be resolved before macro expansion.
    const replaced: Token[] = [];
    for (let index = 0; index < rawTokens.length; index += 1) {
      const token = rawTokens[index];
      if (token === undefined) continue;

      if (token.kind === 'identifier' && token.text === 'defined') {
        const open = rawTokens[index + 1];
        let name = '';
        if (open && isPunctuator(open, '(')) {
          name = rawTokens[index + 2]?.text ?? '';
          index += 3; // land on ')'
        } else {
          name = rawTokens[index + 1]?.text ?? '';
          index += 1;
        }
        replaced.push(this.numberToken(this.macros.has(name) ? '1' : '0', token));
        continue;
      }

      replaced.push(token);
    }

    const expanded = this.expandSequence(replaced, EMPTY_DISABLED, 0);
    const evaluator = new ConditionEvaluator(expanded, (token, message) =>
      this.warn(token, message),
    );
    return evaluator.evaluate();
  }

  private expandSequence(
    tokens: readonly Token[],
    disabled: ReadonlySet<string>,
    depth: number,
  ): Token[] {
    const out: Token[] = [];
    let index = 0;
    while (index < tokens.length) {
      const result = this.expandAt(tokens, index, disabled, depth);
      for (const token of result.tokens) out.push(token);
      index = result.next;
    }
    return out;
  }

  private expandAt(
    tokens: readonly Token[],
    index: number,
    disabled: ReadonlySet<string>,
    depth: number,
  ): { tokens: Token[]; next: number } {
    const token = tokens[index];
    if (token === undefined) return { tokens: [], next: index + 1 };
    if (!isNameToken(token)) return { tokens: [token], next: index + 1 };

    if (token.text === '__LINE__') {
      return { tokens: [this.numberToken(String(token.start.line), token)], next: index + 1 };
    }
    if (token.text === '__FILE__') {
      return { tokens: [this.stringToken(token.file, token)], next: index + 1 };
    }

    if (depth > this.maxExpansionDepth) {
      this.warn(token, 'macro expansion nested too deeply; stopping');
      return { tokens: [token], next: index + 1 };
    }

    if (disabled.has(token.text)) return { tokens: [token], next: index + 1 };

    const macro = this.macros.get(token.text);
    if (!macro) return { tokens: [token], next: index + 1 };

    const nextDisabled = new Set(disabled);
    nextDisabled.add(macro.name);

    if (macro.params === null) {
      const body = retagAll(macro.body, token);
      return {
        tokens: this.expandSequence(body, nextDisabled, depth + 1),
        next: index + 1,
      };
    }

    const open = tokens[index + 1];
    if (!open || !isPunctuator(open, '(')) {
      // A function-like macro name without arguments is just an identifier.
      return { tokens: [token], next: index + 1 };
    }

    const collected = this.collectArguments(tokens, index + 1);
    if (!collected.closed) {
      this.warn(token, `unterminated argument list for macro "${macro.name}"`);
      return { tokens: [token], next: index + 1 };
    }

    const args = this.normalizeArguments(macro, collected.args, token);
    const substituted = this.substitute(macro, args, token);
    return {
      tokens: this.expandSequence(substituted, nextDisabled, depth + 1),
      next: collected.next,
    };
  }

  private collectArguments(
    tokens: readonly Token[],
    openIndex: number,
  ): { args: Token[][]; next: number; closed: boolean } {
    const args: Token[][] = [];
    let current: Token[] = [];
    let depth = 0;
    let index = openIndex;

    while (index < tokens.length) {
      const token = tokens[index];
      if (token === undefined || token.kind === 'eof') break;

      if (isPunctuator(token, '(')) {
        depth += 1;
        if (depth === 1) {
          index += 1;
          continue;
        }
        current.push(token);
        index += 1;
        continue;
      }

      if (isPunctuator(token, ')')) {
        depth -= 1;
        if (depth === 0) {
          if (current.length > 0 || args.length > 0) args.push(current);
          return { args, next: index + 1, closed: true };
        }
        current.push(token);
        index += 1;
        continue;
      }

      if (isPunctuator(token, ',') && depth === 1) {
        args.push(current);
        current = [];
        index += 1;
        continue;
      }

      current.push(token);
      index += 1;
    }

    return { args, next: index, closed: false };
  }

  private normalizeArguments(
    macro: MacroDefinition,
    args: readonly (readonly Token[])[],
    invocation: Token,
  ): Token[][] {
    const params = macro.params ?? [];

    if (!macro.variadic) {
      return params.map((_, index) => [...(args[index] ?? [])]);
    }

    const fixedCount = Math.max(params.length - 1, 0);
    const normalized: Token[][] = [];
    for (let index = 0; index < fixedCount; index += 1) {
      normalized.push([...(args[index] ?? [])]);
    }

    const rest: Token[] = [];
    for (let index = fixedCount; index < args.length; index += 1) {
      if (index > fixedCount) rest.push(this.commaToken(invocation));
      for (const token of args[index] ?? []) rest.push(token);
    }
    normalized.push(rest);
    return normalized;
  }

  private substitute(
    macro: MacroDefinition,
    args: readonly (readonly Token[])[],
    invocation: Token,
  ): Token[] {
    const out: Token[] = [];
    const body = macro.body;
    const params = macro.params ?? [];

    for (let index = 0; index < body.length; index += 1) {
      const token = body[index];
      if (token === undefined) continue;

      // `#param` -> string literal of the raw argument text.
      if (isPunctuator(token, '#') && params.length > 0) {
        const nextToken = body[index + 1];
        const argIndex = nextToken ? params.indexOf(nextToken.text) : -1;
        if (argIndex >= 0) {
          out.push(this.stringize(args[argIndex] ?? [], invocation));
          index += 1;
          continue;
        }
      }

      // `left ## right` -> single pasted token.
      if (isPunctuator(token, '##')) {
        const nextToken = body[index + 1];
        if (nextToken === undefined) continue;
        const replacement = this.replacementTokens(nextToken, params, args, invocation);
        index += 1;
        if (replacement.length === 0) continue; // pasting an empty argument is a no-op

        const left = out[out.length - 1];
        const firstReplacement = replacement[0];
        if (left === undefined || firstReplacement === undefined) {
          for (const item of replacement) out.push(item);
          continue;
        }
        out[out.length - 1] = this.paste(left, firstReplacement);
        for (let extra = 1; extra < replacement.length; extra += 1) {
          const item = replacement[extra];
          if (item) out.push(item);
        }
        continue;
      }

      const argIndex = isNameToken(token) ? params.indexOf(token.text) : -1;
      if (argIndex >= 0) {
        for (const item of args[argIndex] ?? []) out.push(item);
        continue;
      }

      out.push(retagOne(token, invocation));
    }

    return out;
  }

  private replacementTokens(
    token: Token,
    params: readonly string[],
    args: readonly (readonly Token[])[],
    invocation: Token,
  ): Token[] {
    const argIndex = isNameToken(token) ? params.indexOf(token.text) : -1;
    if (argIndex >= 0) return [...(args[argIndex] ?? [])];
    return [retagOne(token, invocation)];
  }

  private stringize(tokens: readonly Token[], origin: Token): Token {
    let text = '';
    let first = true;
    for (const token of tokens) {
      if (!first && (token.hasLeadingSpace || token.atLineStart)) text += ' ';
      text += token.text;
      first = false;
    }
    return {
      kind: 'string',
      text: JSON.stringify(text),
      value: text,
      start: origin.start,
      end: origin.end,
      atLineStart: origin.atLineStart,
      hasLeadingSpace: origin.hasLeadingSpace,
      includeDepth: origin.includeDepth,
      file: origin.file,
      fromMacro: origin.kind === 'identifier' ? origin.text : 'stringize',
    };
  }

  private paste(left: Token, right: Token): Token {
    const text = left.text + right.text;
    const lexed = lex(text, left.file);
    const meaningful = lexed.tokens.filter((token) => token.kind !== 'eof');
    const single = meaningful[0];
    if (meaningful.length !== 1 || single === undefined || single.kind === 'number') {
      if (meaningful.length !== 1) {
        this.warn(
          left,
          `pasting "${left.text}" and "${right.text}" does not form a single token`,
        );
      }
    }
    const base = single ?? { ...left, kind: 'identifier' as const, text };
    return {
      ...base,
      text,
      start: left.start,
      end: right.end,
      file: left.file,
      includeDepth: left.includeDepth,
      atLineStart: false,
      hasLeadingSpace: left.hasLeadingSpace,
      fromMacro: 'paste',
    };
  }

  private numberToken(text: string, like: Token): Token {
    return {
      kind: 'number',
      text,
      start: like.start,
      end: like.end,
      atLineStart: like.atLineStart,
      hasLeadingSpace: like.hasLeadingSpace,
      includeDepth: like.includeDepth,
      file: like.file,
      fromMacro: 'builtin',
    };
  }

  private stringToken(value: string, like: Token): Token {
    return {
      kind: 'string',
      text: JSON.stringify(value),
      value,
      start: like.start,
      end: like.end,
      atLineStart: like.atLineStart,
      hasLeadingSpace: like.hasLeadingSpace,
      includeDepth: like.includeDepth,
      file: like.file,
      fromMacro: 'builtin',
    };
  }

  private commaToken(like: Token): Token {
    return {
      kind: 'punctuator',
      text: ',',
      start: like.start,
      end: like.end,
      atLineStart: false,
      hasLeadingSpace: false,
      includeDepth: like.includeDepth,
      file: like.file,
      fromMacro: 'variadic',
    };
  }
}

const EMPTY_DISABLED: ReadonlySet<string> = new Set<string>();

/**
 * A macro name is any name-like token. It must include keywords: `stdbool.h`
 * defines `bool`, `true` and `false`, which the lexer classifies as keywords
 * (they are keywords in C++, macros in C).
 */
function isNameToken(token: Token | undefined): token is Token {
  return token !== undefined && (token.kind === 'identifier' || token.kind === 'keyword');
}

function retagOne(token: Token, invocation: Token): Token {
  return {
    ...token,
    start: invocation.start,
    end: invocation.end,
    file: invocation.file,
    includeDepth: invocation.includeDepth,
    atLineStart: invocation.atLineStart,
    hasLeadingSpace: invocation.hasLeadingSpace,
    fromMacro: invocation.text,
  };
}

function retagAll(body: readonly Token[], invocation: Token): Token[] {
  const out: Token[] = [];
  let first = true;
  for (const token of body) {
    out.push({
      ...token,
      start: invocation.start,
      end: invocation.end,
      file: invocation.file,
      includeDepth: invocation.includeDepth,
      atLineStart: first ? invocation.atLineStart : false,
      hasLeadingSpace: first ? invocation.hasLeadingSpace : true,
      fromMacro: invocation.text,
    });
    first = false;
  }
  return out;
}

function sameMacro(
  existing: MacroDefinition,
  params: readonly string[] | null,
  variadic: boolean,
  body: readonly Token[],
): boolean {
  if (existing.variadic !== variadic) return false;
  const left = existing.params ?? [];
  const right = params ?? [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  if (existing.body.length !== body.length) return false;
  for (let index = 0; index < body.length; index += 1) {
    if (existing.body[index]?.text !== body[index]?.text) return false;
  }
  return true;
}

function renderTokens(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(' ');
}

export function preprocess(
  source: string,
  file: string,
  options: PreprocessOptions = {},
): PreprocessResult {
  return new Preprocessor(source, file, options).run();
}
