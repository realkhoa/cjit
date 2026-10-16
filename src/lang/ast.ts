import type { SourcePos } from '@/lang/token';

/**
 * AST for the C-family subset the fast engine executes.
 *
 * Two design rules:
 *  1. Every node carries its exact source range. The watch pane, the Problems
 *     list and (later) hover all need to point at real user code, so positions
 *     are not optional bookkeeping.
 *  2. Constructs the engine cannot execute are still *represented*
 *     (`UnknownDecl` / `UnknownStmt`), never silently dropped, so the UI can
 *     show "skipped: C++ template" instead of pretending the code vanished.
 */

export interface Node {
  readonly start: SourcePos;
  readonly end: SourcePos;
}

export type StorageClass = 'static' | 'extern' | 'register' | 'auto' | 'inline' | 'typedef';

export type TypeKind = 'builtin' | 'named' | 'pointer' | 'array' | 'function' | 'unknown';

export interface TypeRef extends Node {
  readonly kind: TypeKind;
  /** Canonical display name, e.g. `const unsigned long`, `struct Point`. */
  readonly name: string;
  readonly qualifiers: readonly string[];
  readonly pointee?: TypeRef;
  readonly element?: TypeRef;
  readonly arrayLength?: Expression;
  readonly returnType?: TypeRef;
  readonly params?: readonly ParamDecl[];
  readonly variadic?: boolean;
  /**
   * `T&`: the storage holds the referent's address, and every read or write goes
   * through it. Distinct from `T*`, which is a value you can copy and do arithmetic on.
   */
  readonly reference?: boolean;
}

export interface ParamDecl extends Node {
  readonly name?: string;
  readonly type: TypeRef;
  /**
   * `int add(int a, int b = 5)`: what to use when the caller leaves this out. C++
   * evaluates it at the call site, which is what the engine does too.
   */
  readonly defaultValue?: Expression;
}

export interface MemberDecl extends Node {
  readonly name: string;
  readonly type: TypeRef;
  /** Who may touch it. `struct` defaults to public, `class` to private. */
  readonly access?: Access;
}

export type Access = 'public' | 'private' | 'protected';

/** A member function: `int add(int amount) { ... }` inside the class body. */
export interface MethodDecl extends Node {
  readonly name: string;
  readonly returnType: TypeRef;
  readonly params: readonly ParamDecl[];
  readonly body?: CompoundStmt;
  readonly access?: Access;
  /** `Counter(...)`: runs when an object is created, and has no return type. */
  readonly isConstructor?: boolean;
  /** `~Counter()`: runs when a local object goes out of scope. */
  readonly isDestructor?: boolean;
  /** `static` methods have no `this`; kept so the message can say so. */
  readonly isStatic?: boolean;
  readonly isConst?: boolean;
}

export interface EnumeratorDecl extends Node {
  readonly name: string;
  readonly value?: Expression;
}

export interface LiteralExpr extends Node {
  readonly kind: 'literal';
  readonly literal: 'number' | 'string' | 'char';
  readonly text: string;
  readonly value?: string;
}

export interface IdentifierExpr extends Node {
  readonly kind: 'identifier';
  readonly name: string;
  readonly templateArg?: string;
}

export interface BinaryExpr extends Node {
  readonly kind: 'binary';
  readonly operator: string;
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpr extends Node {
  readonly kind: 'unary';
  readonly operator: string;
  readonly operand: Expression;
  /** True for `-x`, false for `x++`. */
  readonly prefix: boolean;
}

export interface AssignExpr extends Node {
  readonly kind: 'assign';
  readonly operator: string;
  readonly target: Expression;
  readonly value: Expression;
}

export interface CallExpr extends Node {
  readonly kind: 'call';
  readonly callee: Expression;
  readonly args: readonly Expression[];
}

export interface MemberExpr extends Node {
  readonly kind: 'member';
  readonly object: Expression;
  readonly property: string;
  /** `->` instead of `.`. */
  readonly arrow: boolean;
}

export interface IndexExpr extends Node {
  readonly kind: 'index';
  readonly object: Expression;
  readonly index: Expression;
}

export interface CastExpr extends Node {
  readonly kind: 'cast';
  readonly type: TypeRef;
  readonly value: Expression;
}

export interface TernaryExpr extends Node {
  readonly kind: 'ternary';
  readonly condition: Expression;
  readonly thenBranch: Expression;
  readonly elseBranch: Expression;
}

export interface CommaExpr extends Node {
  readonly kind: 'comma';
  readonly items: readonly Expression[];
}

export interface SizeofExpr extends Node {
  readonly kind: 'sizeof';
  readonly ofType?: TypeRef;
  readonly ofExpression?: Expression;
}

/**
 * `new T(args)`, `new T[n]` and `delete p` / `delete[] p`.
 *
 * The engine has the allocator already; these are the operators C++ spells the same
 * thing with, and a program that fails on `new` fails on most real C++.
 */
export interface NewExpr extends Node {
  readonly kind: 'new';
  readonly ofType: TypeRef;
  readonly args: readonly Expression[];
  /** `new T[n]`: how many elements. */
  readonly arrayLength?: Expression;
}

export interface DeleteExpr extends Node {
  readonly kind: 'delete';
  readonly operand: Expression;
  readonly isArray: boolean;
}

export interface InitListExpr extends Node {
  readonly kind: 'init-list';
  readonly items: readonly Expression[];
}

/**
 * `[capture](params) { body }`.
 *
 * A closure: what it captures is decided by the capture list, and the engine keeps a
 * copy for a by-value capture and the address for a by-reference one, as C++ does.
 */
export interface LambdaExpr extends Node {
  readonly kind: 'lambda';
  readonly captures: readonly { readonly name: string; readonly byRef: boolean }[];
  /** `[=]` or `[&]`: capture everything visible, by value or by reference. */
  readonly captureAll?: 'value' | 'reference';
  readonly params: readonly ParamDecl[];
  readonly body: CompoundStmt;
}

export interface UnknownExpr extends Node {
  readonly kind: 'unknown';
  readonly text: string;
}

export type Expression =
  | LiteralExpr
  | IdentifierExpr
  | BinaryExpr
  | UnaryExpr
  | AssignExpr
  | CallExpr
  | MemberExpr
  | IndexExpr
  | CastExpr
  | TernaryExpr
  | CommaExpr
  | SizeofExpr
  | InitListExpr
  | LambdaExpr
  | NewExpr
  | DeleteExpr
  | UnknownExpr;

export interface VarDecl extends Node {
  readonly kind: 'variable';
  readonly name: string;
  readonly type: TypeRef;
  readonly storage: readonly StorageClass[];
  readonly initializer?: Expression;
  /** C++17 structured bindings: `auto [a, b] = ...` */
  readonly structuredBindings?: readonly string[];
}

export interface TypedefDeclNode extends Node {
  readonly kind: 'typedef';
  readonly name: string;
  readonly type: TypeRef;
}

export interface StructDeclNode extends Node {
  readonly kind: 'struct';
  readonly tag?: string;
  readonly isUnion: boolean;
  /** True when a `{ ... }` body was present in this declaration. */
  readonly isDefinition: boolean;
  readonly members: readonly MemberDecl[];
  /** `class` rather than `struct`: same layout, different default access. */
  readonly isClass?: boolean;
  /** Member functions, which are not part of the layout. */
  readonly methods?: readonly MethodDecl[];
  /**
   * `template <typename T> struct Box { T value; };`
   *
   * The parameter names, in order. This is a class *template*: nothing exists until
   * `Box<int>` asks for an instantiation, which is when each `T` becomes a real type.
   */
  readonly templateParams?: readonly string[];
}

export interface EnumDeclNode extends Node {
  readonly kind: 'enum';
  readonly tag?: string;
  readonly isDefinition: boolean;
  readonly enumerators: readonly EnumeratorDecl[];
}

export interface FunctionDeclNode extends Node {
  readonly kind: 'function';
  readonly name: string;
  readonly returnType: TypeRef;
  readonly params: readonly ParamDecl[];
  readonly variadic: boolean;
  readonly storage: readonly StorageClass[];
  /** Absent for a prototype. */
  readonly body?: CompoundStmt;
}

export interface UnknownDeclNode extends Node {
  /** Deliberately distinct from `UnknownStmt.kind` so the unions stay disjoint. */
  readonly kind: 'unknown-decl';
  /** What was skipped, e.g. `template`, for an honest UI message. */
  readonly text: string;
}

/**
 * `using namespace std;` - and `using std::cout;`, which is the same thing for one
 * name.
 *
 * These change which names resolve, so they are a declaration rather than something
 * skipped: without them a program that is valid C++ fails to find `cout`.
 */
export interface UsingDeclNode extends Node {
  readonly kind: 'using';
  /** True for `using namespace X;`. */
  readonly isNamespace: boolean;
  /** The names brought into scope: `std` for a namespace, `std::cout` for a name. */
  readonly names: readonly string[];
}

export type Declaration =
  | VarDecl
  | TypedefDeclNode
  | StructDeclNode
  | EnumDeclNode
  | FunctionDeclNode
  | UsingDeclNode
  | UnknownDeclNode;

export interface CompoundStmt extends Node {
  readonly kind: 'compound';
  readonly items: readonly (Statement | Declaration)[];
}

export interface DeclStmt extends Node {
  readonly kind: 'decl-stmt';
  readonly declaration: Declaration;
}

export interface ExprStmt extends Node {
  readonly kind: 'expr-stmt';
  readonly expression: Expression;
}

export interface IfStmt extends Node {
  readonly kind: 'if';
  readonly condition: Expression;
  readonly thenBranch: Statement;
  readonly elseBranch?: Statement;
  readonly init?: Statement | Declaration | readonly Declaration[];
}

export interface ForStmt extends Node {
  readonly kind: 'for';
  readonly initializer?: Statement | Declaration | readonly Declaration[];
  readonly condition?: Expression;
  readonly increment?: Expression;
  readonly body: Statement;
}

/**
 * Range-based for. The parser used to skip it as "a C++ feature"; the engine
 * executes it now, so it is a first-class node.
 */
export interface ForRangeStmt extends Node {
  readonly kind: 'for-range';
  readonly declaration: Declaration;
  readonly iterable: Expression;
  readonly body: Statement;
}

export interface WhileStmt extends Node {
  readonly kind: 'while';
  readonly condition: Expression;
  readonly body: Statement;
}

export interface DoWhileStmt extends Node {
  readonly kind: 'do-while';
  readonly body: Statement;
  readonly condition: Expression;
}

export interface SwitchStmt extends Node {
  readonly kind: 'switch';
  readonly discriminant: Expression;
  readonly body: Statement;
}

export interface CaseStmt extends Node {
  readonly kind: 'case';
  readonly value: Expression;
  readonly body: Statement;
}

export interface DefaultStmt extends Node {
  readonly kind: 'default';
  readonly body: Statement;
}

export interface ReturnStmt extends Node {
  readonly kind: 'return';
  readonly value?: Expression;
}

export interface BreakStmt extends Node {
  readonly kind: 'break';
}

export interface ContinueStmt extends Node {
  readonly kind: 'continue';
}

export interface GotoStmt extends Node {
  readonly kind: 'goto';
  readonly label: string;
}

export interface LabelStmt extends Node {
  readonly kind: 'label';
  readonly label: string;
  readonly body: Statement;
}

export interface EmptyStmt extends Node {
  readonly kind: 'empty';
}

export interface UnknownStmt extends Node {
  readonly kind: 'unknown';
  readonly text: string;
}

export type Statement =
  | CompoundStmt
  | DeclStmt
  | ExprStmt
  | IfStmt
  | ForStmt
  | ForRangeStmt
  | WhileStmt
  | DoWhileStmt
  | SwitchStmt
  | CaseStmt
  | DefaultStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | GotoStmt
  | LabelStmt
  | EmptyStmt
  | UnknownStmt;

export interface TranslationUnit extends Node {
  readonly kind: 'translation-unit';
  readonly declarations: readonly Declaration[];
}

/** Depth-first walk over every node that has a `kind`, for analysis passes. */
export function walk(node: Node & { kind: string }, visit: (node: Node & { kind: string }) => void): void {
  visit(node);

  const record = node as unknown as Record<string, unknown>;
  const nested: (Node & { kind: string })[] = [];

  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
      nested.push(value as Node & { kind: string });
    }
  };

  for (const [key, value] of Object.entries(record)) {
    if (key === 'start' || key === 'end' || key === 'kind') continue;
    push(value);
  }

  for (const child of nested) walk(child, visit);
}
