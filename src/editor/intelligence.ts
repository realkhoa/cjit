import type { CallExpr, FunctionDeclNode, TranslationUnit } from '@/lang/ast';
import { walk } from '@/lang/ast';
import type { AnalysisResult } from '@/lang/analyze';
import { describeType, visibleSymbolsAt } from '@/lang/symbols';

/**
 * Editor intelligence derived from the front-end's own analysis.
 *
 * Everything here is a pure function of (analysis, offset), so it is unit tested
 * without a DOM or a Monaco instance - the provider layer is then a thin adapter.
 */

export interface SignatureInfo {
  readonly label: string;
  readonly parameters: readonly string[];
  readonly activeParameter: number;
}

export interface DefinitionTarget {
  /** The open file, or a built-in header label such as `<stdio.h>`. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Length of the identifier, for the selection highlight. */
  readonly length: number;
}

export type OutlineKind =
  | 'function'
  | 'variable'
  | 'struct'
  | 'enum'
  | 'typedef'
  | 'member'
  | 'enumerator';

export interface OutlineSymbol {
  readonly name: string;
  readonly detail: string;
  readonly kind: OutlineKind;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly children?: readonly OutlineSymbol[];
}

const MAX_OUTLINE_SYMBOLS = 500;

function contains(node: { start: { offset: number }; end: { offset: number } }, offset: number): boolean {
  return offset >= node.start.offset && offset <= node.end.offset;
}

/** Every call expression the offset sits inside, innermost (smallest) first. */
function callsAt(unit: TranslationUnit, offset: number): CallExpr[] {
  const found: CallExpr[] = [];
  walk(unit, (node) => {
    if (node.kind !== 'call') return;
    const call = node as unknown as CallExpr;
    if (contains(call, offset)) found.push(call);
  });
  found.sort(
    (left, right) =>
      left.end.offset - left.start.offset - (right.end.offset - right.start.offset),
  );
  return found;
}

function findFunction(unit: TranslationUnit, name: string): FunctionDeclNode | undefined {
  const matches: FunctionDeclNode[] = [];
  walk(unit, (node) => {
    if (node.kind !== 'function') return;
    const declaration = node as unknown as FunctionDeclNode;
    if (declaration.name === name) matches.push(declaration);
  });

  // Prefer a real definition over a prototype, and the last one over an earlier
  // one: the user's own function comes after any header declaration.
  const defined = matches.filter((declaration) => declaration.body !== undefined);
  const pool = defined.length > 0 ? defined : matches;
  return pool[pool.length - 1];
}

function signatureOf(declaration: FunctionDeclNode): { label: string; parameters: string[] } {
  const parameters = declaration.params.map((param) =>
    `${describeType(param.type)}${param.name ? ` ${param.name}` : ''}`.trim(),
  );
  const tail = declaration.variadic ? [...parameters, '...'] : parameters;
  return {
    label: `${describeType(declaration.returnType)} ${declaration.name}(${tail.join(', ')})`,
    parameters: tail,
  };
}

function calleeName(call: CallExpr): string | undefined {
  if (call.callee.kind === 'identifier') return call.callee.name;
  if (call.callee.kind === 'member') return call.callee.property;
  return undefined;
}

/**
 * Signature of the call the offset is inside, with the parameter being typed.
 *
 * The active parameter is derived from which argument's source range contains
 * the offset, which stays correct for nested calls and function-pointer
 * parameters - counting commas would not.
 */
export function signatureAt(
  analysis: AnalysisResult,
  offset: number,
): SignatureInfo | null {
  for (const call of callsAt(analysis.unit, offset)) {
    const name = calleeName(call);
    if (name === undefined) continue;

    const declaration = findFunction(analysis.unit, name);
    if (declaration) {
      const { label, parameters } = signatureOf(declaration);
      return { label, parameters, activeParameter: activeParameterFor(call, offset, parameters.length) };
    }

    // A builtin the engine implements but the headers do not declare: fall back to
    // the symbol table's recorded detail, e.g. `int printf(const char *format, ...)`.
    const symbol = visibleSymbolsAt(analysis.symbols, offset).find(
      (item) => item.name === name && item.kind === 'function',
    );
    if (symbol?.detail) {
      const inner = symbol.detail.slice(symbol.detail.indexOf('(') + 1, symbol.detail.lastIndexOf(')'));
      const parameters = inner.length > 0 ? splitParameters(inner) : [];
      return {
        label: symbol.detail,
        parameters,
        activeParameter: activeParameterFor(call, offset, parameters.length),
      };
    }
  }

  return null;
}

function activeParameterFor(call: CallExpr, offset: number, parameterCount: number): number {
  let active = 0;
  for (let index = 0; index < call.args.length; index += 1) {
    const argument = call.args[index];
    if (!argument) continue;
    if (contains(argument, offset)) {
      active = index;
      break;
    }
    if (offset > argument.end.offset) active = index + 1;
  }

  // Variadic calls can legitimately have more arguments than declared parameters.
  const limit = parameterCount > 0 ? parameterCount - 1 : 0;
  return Math.max(0, Math.min(active, Math.max(limit, 0)));
}

/** Splits a parameter list on top-level commas only. */
function splitParameters(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(' || character === '<') depth += 1;
    else if (character === ')' || character === '>') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/** Where the symbol under the caret is declared, headers included. */
export function definitionAt(
  analysis: AnalysisResult,
  offset: number,
  name: string,
): DefinitionTarget | null {
  if (name.length === 0) return null;

  const candidates = analysis.symbols.symbols.filter(
    (symbol) => symbol.name === name && offset >= symbol.scopeStart && offset <= symbol.scopeEnd,
  );
  if (candidates.length === 0) return null;

  // A name can be declared both in a built-in header and in the open file; the
  // user's own declaration wins, and the latest one wins among equals.
  const own = candidates.filter((symbol) => symbol.file === analysis.file);
  const chosen = (own.length > 0 ? own : candidates)[(own.length > 0 ? own : candidates).length - 1];
  if (!chosen) return null;

  return {
    file: chosen.declarationStart.file,
    line: chosen.declarationStart.line,
    column: chosen.declarationStart.column,
    length: chosen.name.length,
  };
}

/**
 * Outline for the breadcrumb bar and go-to-symbol.
 *
 * Only declarations from the open file: the tokens of the inlined built-in
 * headers carry *their own* line numbers, so including them would fill the
 * outline with `size_t`, `struct tm` and friends pointing at the wrong lines.
 *
 * Top level declarations only, with struct members and enumerators as children -
 * the same shape Visual Studio shows.
 */
export function documentSymbolsFor(analysis: AnalysisResult): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];

  const push = (symbol: OutlineSymbol): void => {
    if (symbols.length >= MAX_OUTLINE_SYMBOLS) return;
    symbols.push(symbol);
  };

  for (const declaration of analysis.unit.declarations) {
    if (symbols.length >= MAX_OUTLINE_SYMBOLS) break;
    if (declaration.start.file !== analysis.file) continue;

    switch (declaration.kind) {
      case 'function':
        push({
          name: declaration.name,
          detail: signatureOf(declaration).label,
          kind: 'function',
          line: declaration.start.line,
          column: declaration.start.column,
          endLine: declaration.end.line,
        });
        break;

      case 'variable':
        push({
          name: declaration.name,
          detail: describeType(declaration.type),
          kind: 'variable',
          line: declaration.start.line,
          column: declaration.start.column,
          endLine: declaration.end.line,
        });
        break;

      case 'typedef':
        push({
          name: declaration.name,
          detail: `typedef ${describeType(declaration.type)}`,
          kind: 'typedef',
          line: declaration.start.line,
          column: declaration.start.column,
          endLine: declaration.end.line,
        });
        break;

      case 'struct':
        if (!declaration.tag || !declaration.isDefinition) break;
        push({
          name: declaration.tag,
          detail: declaration.isUnion ? 'union' : 'struct',
          kind: 'struct',
          line: declaration.start.line,
          column: declaration.start.column,
          endLine: declaration.end.line,
          children: declaration.members.map((member) => ({
            name: member.name,
            detail: describeType(member.type),
            kind: 'member' as const,
            line: member.start.line,
            column: member.start.column,
            endLine: member.end.line,
          })),
        });
        break;

      case 'enum':
        if (!declaration.tag || !declaration.isDefinition) break;
        push({
          name: declaration.tag,
          detail: 'enum',
          kind: 'enum',
          line: declaration.start.line,
          column: declaration.start.column,
          endLine: declaration.end.line,
          children: declaration.enumerators.map((enumerator) => ({
            name: enumerator.name,
            detail: 'enumerator',
            kind: 'enumerator' as const,
            line: enumerator.start.line,
            column: enumerator.start.column,
            endLine: enumerator.end.line,
          })),
        });
        break;

      default:
        break;
    }
  }

  return symbols;
}

/** The symbol trail at a line, for the breadcrumb bar: `sum › for`. */
export function breadcrumbAt(analysis: AnalysisResult, line: number): readonly string[] {
  let deepest: string[] = [];

  const visit = (symbols: readonly OutlineSymbol[], trail: readonly string[]): void => {
    for (const symbol of symbols) {
      if (line < symbol.line || line > symbol.endLine) continue;
      const next = [...trail, symbol.name];
      if (next.length > deepest.length) deepest = next;
      if (symbol.children && symbol.children.length > 0) visit(symbol.children, next);
    }
  };

  visit(documentSymbolsFor(analysis), []);
  return deepest;
}
