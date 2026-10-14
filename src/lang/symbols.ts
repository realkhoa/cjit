import type {
  Declaration,
  EnumeratorDecl,
  FunctionDeclNode,
  Statement,
  TranslationUnit,
  TypeRef,
  VarDecl,
} from '@/lang/ast';
import type { SourcePos } from '@/lang/token';

/**
 * Symbol table for completion, hover and go-to-definition.
 *
 * Every symbol carries the *offset range where it is visible*, not just its
 * declaration, because the editor must answer "what is in scope at the caret?"
 * for a cursor sitting anywhere in the file - including inside a nested block.
 *
 * A symbol's file comes from its declaration position, so symbols contributed by
 * an inlined built-in header report `<stdio.h>` rather than the open file.
 */

export type SymbolKind =
  | 'variable'
  | 'parameter'
  | 'function'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumerator'
  | 'typedef'
  | 'member';

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  /** Display type, exactly as written: `const char *`, `struct Point`. */
  readonly type: string;
  /** Extra information for the completion popup, e.g. a full signature. */
  readonly detail?: string;
  /** Enclosing function name, or `global`. */
  readonly scope: string;
  /** File the symbol was declared in: the open file, or `<stdio.h>` etc. */
  readonly file: string;
  readonly declarationStart: SourcePos;
  readonly declarationEnd: SourcePos;
  /** Visibility window, in source offsets (inclusive), within that file. */
  readonly scopeStart: number;
  readonly scopeEnd: number;
  readonly children?: readonly SymbolInfo[];
}

export interface SymbolTable {
  readonly symbols: readonly SymbolInfo[];
  /** Members of every known struct/union, keyed by `struct Foo` and by `Foo`. */
  readonly structMembers: ReadonlyMap<string, readonly SymbolInfo[]>;
  readonly typedefNames: ReadonlySet<string>;
}

const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'variable',
  'typedef',
  'struct',
  'enum',
  'function',
  'unknown-decl',
]);

function isDeclarationItem(item: Statement | Declaration): item is Declaration {
  return DECLARATION_KINDS.has(item.kind);
}

export function describeType(type: TypeRef): string {
  switch (type.kind) {
    case 'pointer':
      return type.pointee ? `${describeType(type.pointee)} *` : `${type.name} *`;
    case 'array':
      return type.element ? `${describeType(type.element)}[]` : `${type.name}[]`;
    case 'function':
      return type.returnType ? `${describeType(type.returnType)}(...)` : `${type.name}(...)`;
    default:
      return type.name;
  }
}

function signatureOf(fn: FunctionDeclNode): string {
  const params = fn.params
    .map((param) => `${describeType(param.type)}${param.name ? ` ${param.name}` : ''}`)
    .join(', ');
  return `${describeType(fn.returnType)} ${fn.name}(${params}${fn.variadic ? (params ? ', ' : '') + '...' : ''})`;
}

interface ScopeContext {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export function buildSymbolTable(
  unit: TranslationUnit,
  typedefNames: ReadonlySet<string>,
): SymbolTable {
  const symbols: SymbolInfo[] = [];
  const structMembers = new Map<string, SymbolInfo[]>();
  const fileEnd = unit.end.offset;

  const makeMember = (
    name: string,
    type: TypeRef,
    start: SourcePos,
    end: SourcePos,
  ): SymbolInfo => ({
    name,
    kind: 'member',
    type: describeType(type),
    scope: 'global',
    file: start.file,
    declarationStart: start,
    declarationEnd: end,
    scopeStart: 0,
    scopeEnd: fileEnd,
  });

  const addStruct = (node: Extract<Declaration, { kind: 'struct' }>, ctx: ScopeContext): void => {
    const keyword = node.isUnion ? 'union' : 'struct';
    const qualified = node.tag ? `${keyword} ${node.tag}` : keyword;

    const members = node.members.map((member) =>
      makeMember(member.name, member.type, member.start, member.end),
    );

    if (node.tag) {
      structMembers.set(qualified, members);
      structMembers.set(node.tag, members);
    }

    if (!node.isDefinition) return;

    if (node.tag) {
      symbols.push({
        name: node.tag,
        kind: node.isUnion ? 'union' : 'struct',
        type: qualified,
        scope: ctx.name,
        file: node.start.file,
        declarationStart: node.start,
        declarationEnd: node.end,
        scopeStart: node.start.offset,
        scopeEnd: fileEnd,
        children: members,
      });
      return;
    }

    // Anonymous struct/union: its members become directly visible.
    for (const member of members) {
      symbols.push({
        ...member,
        kind: 'variable',
        scope: ctx.name,
        scopeStart: node.start.offset,
        scopeEnd: ctx.end,
      });
    }
  };

  const addEnum = (node: Extract<Declaration, { kind: 'enum' }>, ctx: ScopeContext): void => {
    if (!node.isDefinition) return;

    const enumerators: SymbolInfo[] = node.enumerators.map(
      (item: EnumeratorDecl): SymbolInfo => ({
        name: item.name,
        kind: 'enumerator',
        type: node.tag ? `enum ${node.tag}` : 'enum',
        scope: ctx.name,
        file: item.start.file,
        declarationStart: item.start,
        declarationEnd: item.end,
        scopeStart: item.end.offset,
        scopeEnd: fileEnd,
      }),
    );

    if (node.tag) {
      symbols.push({
        name: node.tag,
        kind: 'enum',
        type: `enum ${node.tag}`,
        scope: ctx.name,
        file: node.start.file,
        declarationStart: node.start,
        declarationEnd: node.end,
        scopeStart: node.start.offset,
        scopeEnd: fileEnd,
        children: enumerators,
      });
    }

    // Enumerators are ordinary constants, visible right after their declaration.
    for (const enumerator of enumerators) symbols.push(enumerator);
  };

  const addVariable = (node: VarDecl, ctx: ScopeContext, kind: SymbolKind): void => {
    symbols.push({
      name: node.name,
      kind,
      type: describeType(node.type),
      scope: ctx.name,
      file: node.start.file,
      declarationStart: node.start,
      declarationEnd: node.end,
      // Visible from the end of its own declaration, because `int x = x;` reads
      // the outer x, not the one being declared.
      scopeStart: node.end.offset,
      scopeEnd: ctx.end,
    });
  };

  const visitStatement = (statement: Statement, ctx: ScopeContext): void => {
    switch (statement.kind) {
      case 'compound': {
        const inner: ScopeContext = {
          name: ctx.name,
          start: statement.start.offset,
          end: statement.end.offset,
        };
        for (const item of statement.items) {
          if (isDeclarationItem(item)) handleDeclaration(item, inner);
          else visitStatement(item, inner);
        }
        return;
      }
      case 'decl-stmt':
        handleDeclaration(statement.declaration, ctx);
        return;
      case 'if':
        visitStatement(statement.thenBranch, ctx);
        if (statement.elseBranch) visitStatement(statement.elseBranch, ctx);
        return;
      case 'for': {
        const loop: ScopeContext = {
          name: ctx.name,
          start: statement.start.offset,
          end: statement.end.offset,
        };
        const initializer = statement.initializer;
        if (initializer && isDeclarationItem(initializer)) {
          handleDeclaration(initializer, loop);
        } else if (initializer && initializer.kind === 'expr-stmt') {
          visitStatement(initializer, ctx);
        }
        visitStatement(statement.body, loop);
        return;
      }
      case 'for-range': {
        const inner: ScopeContext = {
          name: ctx.name,
          start: statement.start.offset,
          end: statement.end.offset,
        };
        handleDeclaration(statement.declaration, inner);
        visitStatement(statement.body, inner);
        return;
      }
      case 'while':
      case 'do-while':
      case 'switch':
      case 'case':
      case 'default':
      case 'label':
        visitStatement(statement.body, ctx);
        return;
      default:
        return;
    }
  };

  const handleDeclaration = (declaration: Declaration, ctx: ScopeContext): void => {
    switch (declaration.kind) {
      case 'function': {
        symbols.push({
          name: declaration.name,
          kind: 'function',
          type: describeType(declaration.returnType),
          detail: signatureOf(declaration),
          scope: 'global',
          file: declaration.start.file,
          declarationStart: declaration.start,
          declarationEnd: declaration.end,
          scopeStart: 0,
          scopeEnd: fileEnd,
        });

        if (!declaration.body) return;

        const bodyContext: ScopeContext = {
          name: declaration.name,
          start: declaration.body.start.offset,
          end: declaration.body.end.offset,
        };

        for (const param of declaration.params) {
          if (param.name === undefined) continue;
          symbols.push({
            name: param.name,
            kind: 'parameter',
            type: describeType(param.type),
            scope: declaration.name,
            file: param.start.file,
            declarationStart: param.start,
            declarationEnd: param.end,
            scopeStart: bodyContext.start,
            scopeEnd: bodyContext.end,
          });
        }

        visitStatement(declaration.body, bodyContext);
        return;
      }
      case 'variable':
        addVariable(declaration, ctx, 'variable');
        return;
      case 'typedef':
        symbols.push({
          name: declaration.name,
          kind: 'typedef',
          type: describeType(declaration.type),
          scope: ctx.name,
          file: declaration.start.file,
          declarationStart: declaration.start,
          declarationEnd: declaration.end,
          scopeStart: declaration.end.offset,
          scopeEnd: fileEnd,
        });
        return;
      case 'struct':
        addStruct(declaration, ctx);
        return;
      case 'enum':
        addEnum(declaration, ctx);
        return;
      default:
        return;
    }
  };

  const globalContext: ScopeContext = { name: 'global', start: 0, end: fileEnd };
  for (const declaration of unit.declarations) handleDeclaration(declaration, globalContext);

  return { symbols, structMembers, typedefNames };
}

/** Innermost-first list of symbols visible at `offset`, deduplicated by name. */
export function visibleSymbolsAt(table: SymbolTable, offset: number): SymbolInfo[] {
  const candidates = table.symbols.filter(
    (symbol) => offset >= symbol.scopeStart && offset <= symbol.scopeEnd,
  );

  candidates.sort((a, b) => a.scopeEnd - a.scopeStart - (b.scopeEnd - b.scopeStart));

  const seen = new Set<string>();
  const out: SymbolInfo[] = [];
  for (const symbol of candidates) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    out.push(symbol);
  }
  return out;
}

/** Members of a struct/union given a written type such as `struct Point *` or `Point`. */
export function membersOfType(
  table: SymbolTable,
  writtenType: string,
): readonly SymbolInfo[] | undefined {
  let name = writtenType.trim();
  // Strip pointer/array decorations and const-ness, then try both spellings.
  name = name
    .replace(/\*/g, ' ')
    .replace(/\[\s*\d*\s*\]/g, ' ')
    .replace(/\b(const|volatile)\b/g, ' ');
  name = name.trim().replace(/\s+/g, ' ');

  const direct = table.structMembers.get(name);
  if (direct) return direct;

  const withoutKeyword = name.replace(/^(struct|union)\s+/, '');
  return table.structMembers.get(withoutKeyword);
}
