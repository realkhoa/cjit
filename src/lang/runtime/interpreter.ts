import type { Diagnostic } from '@/engine/types';
import type {
  CompoundStmt,
  Declaration,
  Expression,
  FunctionDeclNode,
  Statement,
  TranslationUnit,
  VarDecl,
} from '@/lang/ast';
import {
  TypeResolver,
  UNKNOWN_TYPE,
  VOID_TYPE,
  alignOf,
  arrayOf,
  elementKindCode,
  elementTypeFromCode,
  isFloatType,
  isIntegerType,
  isPointerType,
  isStringType,
  isVectorType,
  pointerTo,
} from '@/lang/ctype';
import type { CType } from '@/lang/ctype';
import { makeDiagnostic } from '@/lang/diagnostics';
import { Memory, MemoryError } from '@/lang/memory';
import { INTERPRETER_BUILTINS, SIMPLE_BUILTINS } from '@/lang/runtime/builtins';
import type { SimpleBuiltinContext } from '@/lang/runtime/builtins';
import { formatC } from '@/lang/runtime/printf';
import {
  convertTo,
  floatValue,
  formatValue,
  intValue,
  pointerValue,
  toBoolean,
  toNumber,
  toPointerAddress,
  voidValue,
} from '@/lang/runtime/value';
import type { Value } from '@/lang/runtime/value';
import type { SourcePos } from '@/lang/token';

/**
 * Tree-walking C interpreter.
 *
 * Design:
 *  - every variable lives in `Memory`, so `&x`, pointer arithmetic, arrays and
 *    structs behave like C instead of like special cases;
 *  - control flow is exception based (`break`/`continue`/`return`/`goto`/`exit`),
 *    which keeps statement execution readable;
 *  - execution is *cooperative*: a step counter and a wall-clock check turn a
 *    runaway loop into a `budget` result instead of a frozen tab;
 *  - every stop point (finished, error, budget, timeout) produces the same shape
 *    of result, so the watch pane never has to special-case anything.
 */

export interface WatchVariable {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly scope: string;
  readonly changed: boolean;
  readonly line: number;
  readonly children?: readonly WatchVariable[];
}

export interface StackFrameInfo {
  readonly function: string;
  readonly line: number;
}

export type ExecutionStatus =
  | 'ok'
  | 'runtime-error'
  | 'timeout'
  | 'budget'
  | 'unsupported';

export interface LineStateSnapshot {
  readonly line: number;
  readonly vars: readonly WatchVariable[];
}

export interface HistoryEntry {
  /** Interpreter step at which this state was captured. */
  readonly step: number;
  readonly line: number;
  readonly scope: string;
  /** The variable whose assignment produced this state, for the scrubber label. */
  readonly name: string;
  readonly vars: readonly WatchVariable[];
}

export interface ExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly status: ExecutionStatus;
  readonly detail: string;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly vars: readonly WatchVariable[];
  /** Values the first time each line finished running, ascending by line. */
  readonly lineStates: readonly LineStateSnapshot[];
  /** Ordered states captured on declarations and assignments, for scrubbing. */
  readonly history: readonly HistoryEntry[];
  readonly frames: readonly StackFrameInfo[];
  readonly historyLength: number;
  /** True when a cap (variables, children, snapshots) dropped something. */
  readonly truncated: boolean;
}

export interface ExecuteOptions {
  readonly stdin?: string;
  readonly maxSteps?: number;
  readonly maxMillis?: number;
  readonly maxOutputChars?: number;
  readonly maxSnapshots?: number;
  readonly maxRecursionDepth?: number;
  readonly maxVars?: number;
  /** Collect the variable timeline. Runs skip it: nobody scrubs a console run. */
  readonly collectWatch?: boolean;
  /** Called as output is produced, so the console can stream instead of wait. */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

const DEFAULTS = {
  maxSteps: 8_000_000,
  maxMillis: 3_000,
  maxOutputChars: 1_000_000,
  // Each recorded entry now holds a full variable state, so the cap is much
  // lower than a flat log would need: 400 states is a long, scrubbable history.
  maxSnapshots: 400,
  maxRecursionDepth: 256,
  maxVars: 200,
} as const;

const CHECK_INTERVAL = 2_048;
const MAX_CHILDREN = 24;
/** Ceiling on recorded per-line states; a huge program must not grow without bound. */
const MAX_LINE_STATES = 2_000;

interface Binding {
  readonly name: string;
  /**
   * Mutable on purpose: a template's `T total{};` starts with an unknown type and
   * adopts the type of the first value assigned to it, so `sum(vector<double>)`
   * adds doubles instead of quietly truncating to int.
   */
  type: CType;
  readonly address: number;
  readonly storage: 'local' | 'param' | 'global' | 'static';
  readonly scopeName: string;
  readonly declaredAt: SourcePos;
}

interface Scope {
  readonly name: string;
  readonly bindings: Map<string, Binding>;
}

class ControlFlow extends Error {
  constructor(
    readonly flow: 'break' | 'continue' | 'return' | 'goto' | 'exit',
    readonly value?: Value,
    readonly label?: string,
    readonly code?: number,
  ) {
    super(flow);
    this.name = 'ControlFlow';
  }
}

/**
 * Set while a runtime fault is unwinding. `callFunction` must NOT refresh the
 * stack snapshot in that case, otherwise the frames reported to the user would
 * be empty by the time `run()` catches the fault.
 */
let faultPropagating = false;

class RuntimeFault extends Error {
  constructor(
    message: string,
    readonly position: SourcePos,
  ) {
    super(message);
    this.name = 'RuntimeFault';
    faultPropagating = true;
  }
}

class BudgetFault extends Error {
  constructor(
    readonly reason: 'steps' | 'time' | 'output' | 'recursion',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetFault';
    faultPropagating = true;
  }
}

function intType(): CType {
  return { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 };
}function longType(): CType {
  return { kind: 'int', name: 'long', size: 8, signed: true, bits: 64 };
}

function doubleType(): CType {
  return { kind: 'double', name: 'double', size: 8, signed: true, bits: 64 };
}

function charType(): CType {
  return { kind: 'char', name: 'char', size: 1, signed: true, bits: 8 };
}

function isFloaty(left: Value, right: Value): boolean {
  return isFloatType(left.type) || isFloatType(right.type);
}

/** Usual arithmetic conversions, simplified to the widths this model supports. */
function promoteInteger(left: CType, right: CType): CType {
  const a = isIntegerType(left) ? left : intType();
  const b = isIntegerType(right) ? right : intType();
  const bits = Math.max(a.bits, b.bits);
  const signed = a.signed && b.signed;
  const base = bits >= 64 ? longType() : intType();
  return {
    ...base,
    bits,
    signed,
    size: Math.max(bits / 8, 1),
    name: signed ? base.name : `unsigned ${base.name}`,
  };
}

/** Collects struct/union/enum/typedef declarations so types resolve everywhere. */
export function buildTypeResolver(unit: TranslationUnit): TypeResolver {
  const resolver = new TypeResolver();

  const walk = (declarations: readonly Declaration[]): void => {
    for (const declaration of declarations) {
      switch (declaration.kind) {
        case 'struct':
          if (declaration.isDefinition) {
            resolver.registerStruct(declaration.tag, declaration.members, declaration.isUnion);
          }
          break;
        case 'enum':
          if (declaration.isDefinition) resolver.registerEnum(declaration.tag);
          break;
        case 'typedef':
          resolver.registerTypedef(declaration.name, declaration.type);
          break;
        case 'function':
          if (declaration.body) walk(collectNestedDeclarations(declaration.body));
          break;
        default:
          break;
      }
    }
  };

  walk(unit.declarations);
  return resolver;
}

/** Declarations nested in a function body (local structs, typedefs, statics). */
function collectNestedDeclarations(statement: Statement): Declaration[] {
  const out: Declaration[] = [];

  const visit = (node: Statement): void => {
    if (node.kind === 'compound') {
      for (const item of node.items) {
        if ('kind' in item && isDeclarationKind(item.kind)) out.push(item as Declaration);
        else if ('kind' in item) visit(item as Statement);
      }
      return;
    }
    switch (node.kind) {
      case 'if':
        visit(node.thenBranch);
        if (node.elseBranch) visit(node.elseBranch);
        return;
      case 'for':
      case 'while':
      case 'do-while':
      case 'switch':
      case 'case':
      case 'default':
      case 'label':
        visit(node.body);
        return;
      case 'for-range':
        out.push(node.declaration);
        visit(node.body);
        return;
      default:
        return;
    }
  };

  visit(statement);
  return out;
}

function isDeclarationKind(kind: string): boolean {
  return (
    kind === 'variable' ||
    kind === 'typedef' ||
    kind === 'struct' ||
    kind === 'enum' ||
    kind === 'function' ||
    kind === 'unknown-decl'
  );
}

export function execute(
  unit: TranslationUnit,
  options: ExecuteOptions = {},
): ExecutionResult {
  return new Interpreter(unit, options).run();
}

class Interpreter {
  private readonly memory = new Memory();
  private readonly resolver: TypeResolver;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly functions = new Map<string, FunctionDeclNode>();
  /** Only functions that actually have a body: library prototypes must not shadow builtins. */
  private readonly definitions = new Map<string, FunctionDeclNode>();
  private readonly functionTable: string[] = [''];
  private readonly globals = new Map<string, Binding>();
  private readonly statics = new Map<string, Binding>();
  private readonly allBindings: Binding[] = [];
  private scopes: Scope[] = [];
  private output = '';
  private errorOutput = '';
  private steps = 0;
  private readonly uninitialized = new Set<number>();
  private readonly warnedUninitialized = new Set<number>();
  private readonly literalCache = new Map<Expression, { address: number; length: number }>();
  private readonly allocations = new Map<number, number>();
  private readonly rng = { state: 1 };
  private stdinText: string;
  private stdinCursor = 0;
  private readonly callStack: Array<{ name: string; position: SourcePos }> = [];
  private lastStackSnapshot: StackFrameInfo[] = [];
  private readonly history: HistoryEntry[] = [];
  private readonly lineStates = new Map<number, WatchVariable[]>();
  private readonly limits: Required<Omit<ExecuteOptions, 'stdin' | 'onOutput'>>;
  private readonly onOutput: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  private startedAt = Date.now();
  private recursionDepth = 0;
  private truncated = false;
  private lastStepCheck = 0;
  private mainFile = '';

  constructor(
    private readonly unit: TranslationUnit,
    options: ExecuteOptions,
  ) {
    this.resolver = buildTypeResolver(unit);
    this.stdinText = options.stdin ?? '';
    this.onOutput = options.onOutput;
    this.limits = {
      maxSteps: options.maxSteps ?? DEFAULTS.maxSteps,
      maxMillis: options.maxMillis ?? DEFAULTS.maxMillis,
      maxOutputChars: options.maxOutputChars ?? DEFAULTS.maxOutputChars,
      maxSnapshots: options.maxSnapshots ?? DEFAULTS.maxSnapshots,
      maxRecursionDepth: options.maxRecursionDepth ?? DEFAULTS.maxRecursionDepth,
      maxVars: options.maxVars ?? DEFAULTS.maxVars,
      collectWatch: options.collectWatch ?? true,
    };
    this.mainFile = unit.end.file;
  }

  // ------------------------------------------------------------- lifecycle

  run(): ExecutionResult {
    this.startedAt = Date.now();
    faultPropagating = false;
    try {
      this.prepare();
      const main = this.functions.get('main');
      if (!main) {
        throw new RuntimeFault('no main function found', this.unit.start);
      }

      const result = this.callFunction(main, [intValue(intType(), 1), this.createArgv()]);
      const exitCode =
        result.kind === 'int' || result.kind === 'float' ? Math.trunc(toNumber(result)) : 0;
      return this.finish('ok', exitCode, 'program finished normally');
    } catch (error) {
      if (error instanceof ControlFlow) {
        if (error.flow === 'exit') {
          return this.finish('ok', error.code ?? 0, 'program called exit()');
        }
        return this.finish('runtime-error', null, `stray ${error.flow} outside of a valid context`);
      }
      if (error instanceof BudgetFault) {
        const status = error.reason === 'time' ? 'timeout' : 'budget';
        return this.finish(status, null, error.message);
      }
      if (error instanceof RuntimeFault) {
        this.diagnostics.push(
          makeDiagnostic('error', error.message, error.position.file, error.position, error.position),
        );
        return this.finish('runtime-error', null, error.message);
      }
      if (error instanceof MemoryError) {
        return this.finish('runtime-error', null, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.finish('runtime-error', null, `internal error: ${message}`);
    }
  }

  private finish(status: ExecutionStatus, exitCode: number | null, detail: string): ExecutionResult {
    const vars = this.limits.collectWatch ? this.collectWatch() : [];
    const lineStates = [...this.lineStates.entries()]
      .map(([line, stateVars]) => ({ line, vars: stateVars }))
      .sort((left, right) => left.line - right.line);

    return {
      stdout: this.output,
      stderr: this.errorOutput,
      exitCode,
      status,
      detail,
      steps: this.steps,
      elapsedMs: Date.now() - this.startedAt,
      diagnostics: this.diagnostics,
      vars,
      lineStates: this.limits.collectWatch ? lineStates : [],
      history: this.limits.collectWatch ? [...this.history] : [],
      frames: status === 'ok' ? [] : this.lastStackSnapshot,
      historyLength: this.history.length,
      truncated: this.truncated,
    };
  }

  private prepare(): void {
    // Types first: globals and parameters need sizes before anything is allocated.
    this.prepareTypes(this.unit.declarations);

    for (const declaration of this.unit.declarations) {
      if (declaration.kind === 'function') this.registerFunction(declaration);
    }

    for (const declaration of this.unit.declarations) {
      if (declaration.kind === 'variable') this.declareVariable(declaration, 'global', 'global');
    }
  }

  private prepareTypes(declarations: readonly Declaration[]): void {
    for (const declaration of declarations) {
      if (declaration.kind === 'struct' && declaration.isDefinition) {
        this.resolver.registerStruct(declaration.tag, declaration.members, declaration.isUnion);
        continue;
      }
      if (declaration.kind === 'enum' && declaration.isDefinition) {
        this.resolver.registerEnum(declaration.tag);
        continue;
      }
      if (declaration.kind === 'typedef') {
        this.resolver.registerTypedef(declaration.name, declaration.type);
        continue;
      }
      if (declaration.kind === 'function' && declaration.body) {
        this.prepareTypes(collectNestedDeclarations(declaration.body));
      }
    }
  }

  private registerFunction(declaration: FunctionDeclNode): void {
    this.functions.set(declaration.name, declaration);
    if (!declaration.body) return;
    this.definitions.set(declaration.name, declaration);
    if (!this.functionTable.includes(declaration.name)) {
      this.functionTable.push(declaration.name);
    }
  }

  /** The call stack as it was at the last enter/exit, for error reporting. */
  private refreshStackSnapshot(): void {
    this.lastStackSnapshot = this.callStack
      .slice()
      .reverse()
      .map((frame) => ({ function: frame.name, line: frame.position.line }));
  }

  private createArgv(): Value {
    const argvType = pointerTo(pointerTo(charType()));
    const address = this.memory.alloc(16, 8);
    const programName = this.memory.writeCString(this.mainFile);
    this.memory.writeUint64(address, programName);
    this.memory.writeUint64(address + 8, 0);
    return { kind: 'pointer', type: argvType, address };
  }

  // --------------------------------------------------------------- scopes

  private pushScope(name: string): void {
    this.scopes.push({ name, bindings: new Map() });
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private get currentScope(): Scope | undefined {
    return this.scopes[this.scopes.length - 1];
  }

  private currentScopeName(): string {
    return this.currentScope?.name ?? 'global';
  }

  private lookup(name: string): Binding | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const found = this.scopes[index]?.bindings.get(name);
      if (found) return found;
    }
    return this.globals.get(name);
  }

  private bind(binding: Binding): void {
    this.currentScope?.bindings.set(binding.name, binding);
    this.allBindings.push(binding);
  }

  private allocateFor(type: CType): number {
    const size = Math.max(type.size, 1);
    const address = this.memory.alloc(size, alignOf(type));
    if (type.kind === 'struct' || type.kind === 'union' || type.kind === 'array') {
      // C zero-initializes only globals/statics; callers clear explicitly.
    }
    return address;
  }

  // ---------------------------------------------------------- declarations

  private declareVariable(
    declaration: VarDecl,
    storage: Binding['storage'],
    scopeName: string,
  ): void {
    this.prepareTypes([declaration]);

    const isStatic = declaration.storage.includes('static') || storage === 'global';
    const staticKey = `${declaration.name}@${declaration.start.offset}`;

    let type = this.resolver.resolve(declaration.type);
    let address: number;

    // `int a[] = {1, 2, 3};` and `char s[] = "abc";` take their length from the
    // initializer, exactly as C does.
    if (type.kind === 'array' && type.length === undefined && type.element) {
      const initializer = declaration.initializer;
      if (initializer?.kind === 'init-list') {
        type = arrayOf(type.element, initializer.items.length);
      } else if (initializer?.kind === 'literal' && initializer.literal === 'string') {
        type = arrayOf(type.element, (initializer.value ?? '').length + 1);
      }
    }

    if (storage === 'static' || (isStatic && storage !== 'global')) {
      const existing = this.statics.get(staticKey);
      if (existing) {
        this.bind({ ...existing, scopeName });
        return;
      }
    }

    // `auto x = expr;` and a template's `T total{};` take their type from the
    // initializer value.
    if (type.kind === 'unknown' || type.name === 'auto') {
      if (declaration.initializer && declaration.initializer.kind === 'init-list' && declaration.initializer.items.length === 0) {
        // `T total{};` - value-initialization of a template parameter. The type
        // stays unknown and is inferred from the first assignment, which is what
        // makes the same template work for int and for double.
        address = this.allocateFor({ ...type, size: 8 });
        this.memory.fill(address, 0, 8);
      } else if (declaration.initializer) {
        const initial = this.evaluate(declaration.initializer);
        type = initial.type;
        address = this.allocateFor(type);
        this.store(type, address, convertTo(type, initial));
      } else {
        this.diagnostics.push(
          makeDiagnostic(
            'warning',
            `cannot infer the type of '${declaration.name}'; treated as int`,
            declaration.start.file,
            declaration.start,
            declaration.end,
          ),
        );
        type = intType();
        address = this.allocateFor(type);
      }
    } else {
      address = this.allocateFor(type);
      if (isStatic) {
        this.memory.fill(address, 0, Math.max(type.size, 1));
      } else {
        this.uninitialized.add(address);
      }
    }

    const binding: Binding = {
      name: declaration.name,
      type,
      address,
      storage: isStatic ? (storage === 'global' ? 'global' : 'static') : storage,
      scopeName,
      declaredAt: declaration.start,
    };

    if (storage === 'global') {
      this.globals.set(declaration.name, binding);
      this.allBindings.push(binding);
    } else {
      this.bind(binding);
      if (binding.storage === 'static') this.statics.set(staticKey, binding);
    }

    if (declaration.initializer) {
      this.uninitialized.delete(address);
      this.initialize(binding, declaration.initializer);
      this.record(binding, declaration.start);
    }
  }

  private initialize(binding: Binding, initializer: Expression): void {
    // C++ containers have their own construction rules.
    if (isVectorType(binding.type)) {
      if (initializer.kind === 'init-list') {
        this.createVector(binding.type, binding.address, initializer.items);
      } else {
        const source = this.evaluate(initializer);
        if (isVectorType(source.type) && source.kind === 'aggregate') {
          this.copyVector(source.address, source.type, binding.address, binding.type);
        } else {
          this.createVector(binding.type, binding.address, []);
        }
      }
      return;
    }

    if (isStringType(binding.type)) {
      let text = '';
      if (initializer.kind === 'literal' && initializer.literal === 'string') {
        text = initializer.value ?? '';
      } else if (initializer.kind === 'init-list') {
        text = initializer.items.map((item) => this.readStringValue(this.evaluate(item))).join('');
      } else {
        const value = this.evaluate(initializer);
        text =
          value.kind === 'aggregate' && isStringType(value.type)
            ? this.stringText(value.address)
            : this.readStringValue(value);
      }
      this.createString(binding.address, text);
      return;
    }

    if (initializer.kind === 'init-list') {
      // `int x{};` value-initializes to zero.
      if (initializer.items.length === 0) {
        this.memory.fill(binding.address, 0, Math.max(binding.type.size, 1));
        return;
      }
      this.initializeAggregate(binding.type, binding.address, initializer.items);
      return;
    }

    const value = convertTo(binding.type, this.evaluate(initializer));
    this.store(binding.type, binding.address, value);
  }

  private initializeAggregate(
    type: CType,
    address: number,
    items: readonly Expression[],
  ): void {
    if (type.kind === 'array' && type.element) {
      items.forEach((item, index) => {
        const elementAddress = address + index * Math.max(type.element?.size ?? 1, 1);
        if (item.kind === 'init-list') {
          if (type.element) this.initializeAggregate(type.element, elementAddress, item.items);
          return;
        }
        const value = convertTo(type.element ?? UNKNOWN_TYPE, this.evaluate(item));
        this.store(type.element ?? UNKNOWN_TYPE, elementAddress, value);
      });
      return;
    }

    if ((type.kind === 'struct' || type.kind === 'union') && type.members) {
      items.forEach((item, index) => {
        const member = type.members?.[index];
        if (!member) return;
        const memberAddress = address + member.offset;
        if (item.kind === 'init-list') {
          this.initializeAggregate(member.type, memberAddress, item.items);
          return;
        }
        this.store(member.type, memberAddress, convertTo(member.type, this.evaluate(item)));
      });
      return;
    }

    const first = items[0];
    if (first) this.store(type, address, convertTo(type, this.evaluate(first)));
  }

  // ------------------------------------------------------------ statements

  private executeStatement(statement: Statement): void {
    this.tick();

    switch (statement.kind) {
      case 'compound': {
        this.pushScope(this.currentScopeName());
        try {
          this.executeCompoundItems(statement);
        } finally {
          this.popScope();
        }
        return;
      }
      case 'decl-stmt':
        this.executeDeclaration(statement.declaration);
        this.recordLine(statement.start.line);
        return;
      case 'expr-stmt':
        this.evaluate(statement.expression);
        this.recordLine(statement.start.line);
        return;
      case 'empty':
        return;
      case 'if':
        if (toBoolean(this.evaluate(statement.condition))) this.executeStatement(statement.thenBranch);
        else if (statement.elseBranch) this.executeStatement(statement.elseBranch);
        return;
      case 'while':
        while (toBoolean(this.evaluate(statement.condition))) {
          this.tick();
          try {
            this.executeStatement(statement.body);
          } catch (flow) {
            if (flow instanceof ControlFlow) {
              if (flow.flow === 'break') break;
              if (flow.flow === 'continue') continue;
            }
            throw flow;
          }
        }
        return;
      case 'do-while':
        do {
          this.tick();
          try {
            this.executeStatement(statement.body);
          } catch (flow) {
            if (flow instanceof ControlFlow) {
              if (flow.flow === 'break') break;
              if (flow.flow === 'continue') {
                // fall through to the condition
              } else {
                throw flow;
              }
            } else {
              throw flow;
            }
          }
        } while (toBoolean(this.evaluate(statement.condition)));
        return;
      case 'for':
        this.executeFor(statement);
        return;
      case 'for-range':
        this.executeForRange(statement);
        return;
      case 'switch':
        this.executeSwitch(statement);
        return;
      case 'case':
      case 'default':
        // A label reached without a matching switch: execute its body normally.
        this.executeStatement(statement.body);
        return;
      case 'return': {
        const value = statement.value ? this.evaluate(statement.value) : voidValue();
        this.recordLine(statement.start.line);
        throw new ControlFlow('return', value);
      }
      case 'break':
        throw new ControlFlow('break');
      case 'continue':
        throw new ControlFlow('continue');
      case 'goto':
        throw new ControlFlow('goto', undefined, statement.label);
      case 'label':
        this.executeStatement(statement.body);
        return;
      case 'unknown':
        throw new RuntimeFault(
          `cannot execute unsupported construct '${statement.text}'`,
          statement.start,
        );
      default:
        return;
    }
  }

  private executeCompoundItems(compound: CompoundStmt): void {
    const items = compound.items;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      try {
        if (isDeclarationKind(item.kind)) {
          this.executeDeclaration(item as Declaration);
          // Declarations in a block go through their own path, so record here too:
          // otherwise `int total = 0;` would have no state for its own line.
          this.recordLine(item.start.line);
        } else {
          this.executeStatement(item as Statement);
        }
      } catch (flow) {
        if (flow instanceof ControlFlow && flow.flow === 'goto' && flow.label !== undefined) {
          const target = items.findIndex(
            (candidate) => candidate.kind === 'label' && candidate.label === flow.label,
          );
          if (target >= 0) {
            index = target - 1;
            continue;
          }
        }
        throw flow;
      }
    }
  }

  private executeFor(statement: Extract<Statement, { kind: 'for' }>): void {
    this.pushScope(this.currentScopeName());
    try {
      const initializer = statement.initializer;
      if (initializer) {
        if (isDeclarationKind(initializer.kind)) {
          this.executeDeclaration(initializer as Declaration);
          this.recordLine(initializer.start.line);
        } else {
          this.executeStatement(initializer as Statement);
        }
      }

      for (;;) {
        this.tick();
        if (statement.condition && !toBoolean(this.evaluate(statement.condition))) break;
        try {
          this.executeStatement(statement.body);
        } catch (flow) {
          if (flow instanceof ControlFlow) {
            if (flow.flow === 'break') break;
            if (flow.flow !== 'continue') throw flow;
          } else {
            throw flow;
          }
        }
        if (statement.increment) this.evaluate(statement.increment);
      }
    } finally {
      this.popScope();
    }
  }

  private executeSwitch(statement: Extract<Statement, { kind: 'switch' }>): void {
    const discriminant = this.evaluate(statement.discriminant);
    const segments = flattenSwitch(statement.body);
    const values = segments.map((segment) =>
      segment.value ? toNumber(this.evaluate(segment.value)) : undefined,
    );
    const target = toNumber(discriminant);

    let start = values.findIndex((value) => value !== undefined && value === target);
    if (start < 0) start = segments.findIndex((segment) => segment.isDefault);
    if (start < 0) return;

    this.pushScope(this.currentScopeName());
    try {
      for (let index = start; index < segments.length; index += 1) {
        const segment = segments[index];
        if (!segment) continue;
        for (const item of segment.statements) {
          try {
            if (isDeclarationKind(item.kind)) this.executeDeclaration(item as Declaration);
            else this.executeStatement(item as Statement);
          } catch (flow) {
            if (flow instanceof ControlFlow && flow.flow === 'break') return;
            throw flow;
          }
        }
      }
    } finally {
      this.popScope();
    }
  }

  private executeDeclaration(declaration: Declaration): void {
    switch (declaration.kind) {
      case 'variable':
        this.declareVariable(declaration, 'local', this.currentScopeName());
        return;
      case 'struct':
        if (declaration.isDefinition) {
          this.resolver.registerStruct(declaration.tag, declaration.members, declaration.isUnion);
        }
        return;
      case 'enum':
        if (declaration.isDefinition) this.resolver.registerEnum(declaration.tag);
        return;
      case 'typedef':
        this.resolver.registerTypedef(declaration.name, declaration.type);
        return;
      case 'function': {
        // A nested function declaration (C++ style local prototype).
        this.registerFunction(declaration);
        return;
      }
      default:
        // The only declaration left is one the parser already flagged as skipped.
        throw new RuntimeFault(
          `cannot execute unsupported declaration '${declaration.text}'`,
          declaration.start,
        );
    }
  }

  // ----------------------------------------------------------- expressions

  private evaluate(expression: Expression): Value {
    this.tick();

    switch (expression.kind) {
      case 'literal':
        return this.literalValue(expression);
      case 'identifier':
        return this.loadIdentifier(expression.name, expression.start);
      case 'binary':
        return this.evaluateBinary(expression);
      case 'unary':
        return this.evaluateUnary(expression);
      case 'assign':
        return this.evaluateAssign(expression);
      case 'call':
        return this.evaluateCall(expression);
      case 'member':
        return this.evaluateMember(expression);
      case 'index': {
        const target = this.resolveIndex(expression);
        return this.load(target.type, target.address);
      }
      case 'cast': {
        const type = this.resolver.resolve(expression.type);
        return convertTo(type, this.evaluate(expression.value));
      }
      case 'ternary':
        return toBoolean(this.evaluate(expression.condition))
          ? this.evaluate(expression.thenBranch)
          : this.evaluate(expression.elseBranch);
      case 'comma': {
        let value: Value = voidValue();
        for (const item of expression.items) value = this.evaluate(item);
        return value;
      }
      case 'sizeof': {
        const type = expression.ofType
          ? this.resolver.resolve(expression.ofType)
          : this.typeOf(expression.ofExpression ?? expression);
        return intValue(longType(), Math.max(type.size, 1));
      }
      case 'init-list':
        throw new RuntimeFault(
          'initializer list is only valid in a declaration',
          expression.start,
        );
      case 'unknown':
        throw new RuntimeFault(
          `cannot evaluate '${expression.text}'`,
          expression.start,
        );
      default:
        return voidValue();
    }
  }

  private literalValue(expression: Extract<Expression, { kind: 'literal' }>): Value {
    if (expression.literal === 'string') {
      return this.stringLiteral(expression);
    }
    if (expression.literal === 'char') {
      const text = expression.value ?? '';
      return intValue(charType(), text.length > 0 ? text.charCodeAt(0) : 0);
    }
    return this.numberLiteral(expression.text);
  }

  private stringLiteral(expression: Extract<Expression, { kind: 'literal' }>): Value {
    const cached = this.literalCache.get(expression);
    if (cached) {
      return {
        kind: 'aggregate',
        type: arrayOf(charType(), cached.length),
        address: cached.address,
      };
    }

    const text = expression.value ?? '';
    const address = this.memory.writeCString(text);
    this.literalCache.set(expression, { address, length: text.length + 1 });
    return { kind: 'aggregate', type: arrayOf(charType(), text.length + 1), address };
  }

  private numberLiteral(text: string): Value {
    const isFloat =
      text.includes('.') || (!/^0[xXbB]/.test(text) && /[eE][-+]?\d/.test(text)) || /[fF]$/.test(text) && text.includes('.');

    if (isFloat) {
      const value = Number.parseFloat(text.replace(/[fFlL]+$/, ''));
      return floatValue(text.toLowerCase().endsWith('f') ? { ...doubleType(), kind: 'float', name: 'float', size: 4, bits: 32 } : doubleType(), Number.isNaN(value) ? 0 : value);
    }

    const unsigned = /u/i.test(text);
    const wide = /l/i.test(text);
    let body = text.replace(/[uUlL]+$/, '');
    let value = 0;

    if (/^0[xX]/.test(body)) value = Number.parseInt(body.slice(2), 16);
    else if (/^0[bB]/.test(body)) value = Number.parseInt(body.slice(2), 2);
    else if (body.length > 1 && body.startsWith('0')) value = Number.parseInt(body.slice(1), 8);
    else value = Number.parseInt(body, 10);

    if (Number.isNaN(value)) value = 0;

    const type: CType = wide
      ? { ...longType(), signed: !unsigned, name: unsigned ? 'unsigned long' : 'long' }
      : { ...intType(), signed: !unsigned, name: unsigned ? 'unsigned int' : 'int' };

    return intValue(type, value);
  }

  private loadIdentifier(name: string, position: SourcePos): Value {
    // Streams and stream manipulators are values, not variables.
    if (name === 'std::cout') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream' } };
    if (name === 'std::cerr') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream:cerr' } };
    if (name === 'std::endl') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::endl' } };

    if (name === 'NULL' || name === 'nullptr') return pointerValue(VOID_TYPE, 0);

    const binding = this.lookup(name);
    if (binding) return this.load(binding.type, binding.address, binding);

    const declaration = this.definitions.get(name);
    if (declaration) {
      const index = this.functionTable.indexOf(name);
      return {
        kind: 'pointer',
        type: pointerTo(
          this.resolver.resolve({
            kind: 'function',
            name: `${declaration.name}(...)`,
            start: declaration.start,
            end: declaration.end,
            returnType: declaration.returnType,
            params: declaration.params,
            variadic: declaration.variadic,
            qualifiers: [],
          }),
        ),
        address: index,
      };
    }

    throw new RuntimeFault(`use of undeclared identifier '${name}'`, position);
  }

  private evaluateBinary(expression: Extract<Expression, { kind: 'binary' }>): Value {
    const operator = expression.operator;

    if (operator === '&&') {
      if (!toBoolean(this.evaluate(expression.left))) return intValue(intType(), 0);
      return intValue(intType(), toBoolean(this.evaluate(expression.right)) ? 1 : 0);
    }
    if (operator === '||') {
      if (toBoolean(this.evaluate(expression.left))) return intValue(intType(), 1);
      return intValue(intType(), toBoolean(this.evaluate(expression.right)) ? 1 : 0);
    }

    if (operator === '<<' || operator === '>>') {
      const stream = this.streamOf(expression.left);
      if (stream && operator === '<<') {
        // Evaluate the left link FIRST: in `cout << a << b` the left side carries
        // the earlier insertions, so skipping it would silently drop them.
        this.evaluate(expression.left);
        const text = this.streamText(this.evaluate(expression.right));
        this.appendOutput(text, stream === 'cerr');
        return stream === 'cerr'
          ? { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream:cerr' } }
          : { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream' } };
      }
    }

    const leftRaw = this.evaluate(expression.left);
    const rightRaw = this.evaluate(expression.right);
    const left = this.decay(leftRaw);
    const right = this.decay(rightRaw);

    // `std::string` concatenation, in either operand position.
    if (operator === '+' && (isStringType(leftRaw.type) || isStringType(rightRaw.type))) {
      return this.makeString(this.plainText(leftRaw) + this.plainText(rightRaw));
    }

    const leftPointer = toPointerAddress(left);
    const rightPointer = toPointerAddress(right);
    const pointerish =
      (isPointerType(left.type) || left.type.kind === 'array') && leftPointer !== null;

    switch (operator) {
      case '+':
        if (pointerish && !isPointerType(right.type)) {
          return this.shiftPointer(left, toNumber(right), expression);
        }
        if (!isPointerType(left.type) && rightPointer !== null && isPointerType(right.type)) {
          return this.shiftPointer(right, toNumber(left), expression);
        }
        return this.arithmetic(left, right, (a, b) => a + b);
      case '-':
        if (pointerish) {
          if (isPointerType(right.type)) {
            const elementSize = Math.max(left.type.pointee?.size ?? 1, 1);
            return intValue(longType(), ((leftPointer ?? 0) - (rightPointer ?? 0)) / elementSize);
          }
          return this.shiftPointer(left, -toNumber(right), expression);
        }
        return this.arithmetic(left, right, (a, b) => a - b);
      case '*':
        return this.arithmetic(left, right, (a, b) => a * b);
      case '/': {
        const divisor = toNumber(right);
        if (divisor === 0) {
          throw new RuntimeFault('division by zero', expression.start);
        }
        return this.arithmetic(left, right, (a, b) => (isFloaty(left, right) ? a / b : Math.trunc(a / b)));
      }
      case '%': {
        const divisor = toNumber(right);
        if (divisor === 0) throw new RuntimeFault('division by zero', expression.start);
        return this.arithmetic(left, right, (a, b) => a % b);
      }
      case '&':
        return intValue(intType(), toNumber(left) & toNumber(right));
      case '|':
        return intValue(intType(), toNumber(left) | toNumber(right));
      case '^':
        return intValue(intType(), toNumber(left) ^ toNumber(right));
      case '<<':
        return intValue(intType(), Math.trunc(toNumber(left)) << (Math.trunc(toNumber(right)) & 31));
      case '>>':
        return intValue(intType(), Math.trunc(toNumber(left)) >> (Math.trunc(toNumber(right)) & 31));
      case '==':
        return intValue(intType(), this.compare(left, right) === 0 ? 1 : 0);
      case '!=':
        return intValue(intType(), this.compare(left, right) !== 0 ? 1 : 0);
      case '<':
        return intValue(intType(), this.compare(left, right) < 0 ? 1 : 0);
      case '<=':
        return intValue(intType(), this.compare(left, right) <= 0 ? 1 : 0);
      case '>':
        return intValue(intType(), this.compare(left, right) > 0 ? 1 : 0);
      case '>=':
        return intValue(intType(), this.compare(left, right) >= 0 ? 1 : 0);
      default:
        throw new RuntimeFault(`unsupported operator '${operator}'`, expression.start);
    }
  }

  private shiftPointer(value: Value, elements: number, expression: Expression): Value {
    const pointee = value.type.pointee ?? value.type.element ?? UNKNOWN_TYPE;
    const size = Math.max(pointee.size, 1);
    if (value.kind === 'pointer') {
      return { kind: 'pointer', type: value.type, address: value.address + elements * size };
    }
    if (value.kind === 'aggregate') {
      return pointerValue(pointee, value.address + elements * size);
    }
    throw new RuntimeFault('pointer arithmetic on a non-pointer value', expression.start);
  }

  private arithmetic(
    left: Value,
    right: Value,
    operation: (a: number, b: number) => number,
  ): Value {
    const result = operation(toNumber(left), toNumber(right));
    if (isFloaty(left, right)) {
      return floatValue(left.kind === 'float' ? left.type : right.type, result);
    }
    return intValue(promoteInteger(left.type, right.type), result);
  }

  private compare(left: Value, right: Value): number {
    if (isFloatType(left.type) || isFloatType(right.type)) {
      return toNumber(left) === toNumber(right) ? 0 : toNumber(left) < toNumber(right) ? -1 : 1;
    }
    const a = toNumber(left);
    const b = toNumber(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  private evaluateUnary(expression: Extract<Expression, { kind: 'unary' }>): Value {
    const operator = expression.operator;

    if (operator === '&') {
      const target = this.lvalue(expression.operand);
      if (!target) {
        // `&func` - a function pointer, represented as its table index.
        if (expression.operand.kind === 'identifier') {
          const index = this.functionTable.indexOf(expression.operand.name);
          if (index > 0) {
            return pointerValue(VOID_TYPE, index);
          }
        }
        throw new RuntimeFault('cannot take the address of this expression', expression.start);
      }
      return pointerValue(target.type, target.address);
    }

    if (operator === '*' || operator === '->') {
      const pointer = this.decay(this.evaluate(expression.operand));
      const address = toPointerAddress(pointer);
      const pointee = pointer.type.pointee ?? pointer.type.element ?? UNKNOWN_TYPE;
      if (address === null) {
        throw new RuntimeFault('dereference of a non-pointer value', expression.start);
      }
      if (address === 0 && pointee.size > 0) {
        throw new RuntimeFault('null pointer dereference', expression.start);
      }
      return this.load(pointee, address);
    }

    if (operator === '++' || operator === '--') {
      const target = this.lvalue(expression.operand);
      if (!target) throw new RuntimeFault(`cannot ${operator === '++' ? 'increment' : 'decrement'} this expression`, expression.start);
      const current = this.load(target.type, target.address);
      const step = isPointerType(target.type) ? Math.max(target.type.pointee?.size ?? 1, 1) : 1;
      const next = convertTo(
        target.type,
        intValue(intType(), toNumber(current) + (operator === '++' ? step : -step)),
      );
      this.store(target.type, target.address, next);
      if (expression.prefix) return next;
      return current;
    }

    const value = this.decay(this.evaluate(expression.operand));
    switch (operator) {
      case '-':
        return isFloatType(value.type)
          ? floatValue(value.type, -toNumber(value))
          : intValue(promoteInteger(value.type, value.type), -toNumber(value));
      case '+':
        return value;
      case '!':
        return intValue(intType(), toBoolean(value) ? 0 : 1);
      case '~':
        return intValue(intType(), ~Math.trunc(toNumber(value)));
      default:
        throw new RuntimeFault(`unsupported unary operator '${operator}'`, expression.start);
    }
  }

  private evaluateAssign(expression: Extract<Expression, { kind: 'assign' }>): Value {
    const target = this.lvalue(expression.target);
    if (!target) {
      throw new RuntimeFault('cannot assign to this expression', expression.start);
    }

    const operator = expression.operator;
    let value: Value;

    if (operator === '=') {
      const raw = this.evaluate(expression.value);
      if (target.type.kind === 'pointer') {
        const address = this.pointerAddressOf(raw);
        value = { kind: 'pointer', type: target.type, address: address ?? 0 };
      } else {
        value = convertTo(target.type, raw);
      }
    } else {
      const current = this.load(target.type, target.address);
      const right = this.decay(this.evaluate(expression.value));
      const base = operator.slice(0, -1);
      const combined = this.compoundValue(target.type, current, right, base, expression);
      value = combined;
    }

    this.store(target.type, target.address, value);
    this.uninitialized.delete(target.address);

    if (expression.target.kind === 'identifier') {
      const binding = this.lookup(expression.target.name);
      if (binding) {
        // First real assignment to a template-typed variable fixes its type.
        if (binding.type.kind === 'unknown' && value.kind !== 'uninit' && value.kind !== 'void') {
          binding.type = value.type;
        }
        this.record(binding, expression.start);
      }
    }
    return value;
  }

  private compoundValue(
    type: CType,
    current: Value,
    right: Value,
    operator: string,
    expression: Expression,
  ): Value {
    // A template-typed target adopts the operand's type.
    const effective =
      type.kind === 'unknown' ? (isFloatType(right.type) ? right.type : intType()) : type;

    if (isPointerType(effective) && (operator === '+' || operator === '-')) {
      const step = Math.max(effective.pointee?.size ?? 1, 1) * toNumber(right) * (operator === '-' ? -1 : 1);
      return { kind: 'pointer', type: effective, address: toNumber(current) + step };
    }

    const a = toNumber(current);
    const b = toNumber(right);
    let result: number;
    switch (operator) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b === 0) throw new RuntimeFault('division by zero', expression.start);
        result = isFloatType(type) ? a / b : Math.trunc(a / b);
        break;
      case '%':
        if (b === 0) throw new RuntimeFault('division by zero', expression.start);
        result = a % b;
        break;
      case '&':
        result = Math.trunc(a) & Math.trunc(b);
        break;
      case '|':
        result = Math.trunc(a) | Math.trunc(b);
        break;
      case '^':
        result = Math.trunc(a) ^ Math.trunc(b);
        break;
      case '<<':
        result = Math.trunc(a) << (Math.trunc(b) & 31);
        break;
      case '>>':
        result = Math.trunc(a) >> (Math.trunc(b) & 31);
        break;
      default:
        throw new RuntimeFault(`unsupported compound assignment '${operator}='`, expression.start);
    }

    return isFloatType(effective) ? floatValue(effective, result) : intValue(effective, result);
  }

  private evaluateMember(expression: Extract<Expression, { kind: 'member' }>): Value {
    const target = this.memberTarget(expression);
    if (!target) {
      throw new RuntimeFault(
        `'${expression.property}' is not a member of that value`,
        expression.start,
      );
    }
    return this.load(target.type, target.address);
  }

  private memberTarget(
    expression: Extract<Expression, { kind: 'member' }>,
  ): { address: number; type: CType } | null {
    let baseAddress: number;
    let baseType: CType;

    if (expression.arrow) {
      const pointer = this.decay(this.evaluate(expression.object));
      const address = toPointerAddress(pointer);
      if (address === null || address === 0) {
        throw new RuntimeFault('null pointer dereference', expression.start);
      }
      baseAddress = address;
      baseType = pointer.type.pointee ?? UNKNOWN_TYPE;
    } else {
      const aggregate = this.evaluate(expression.object);
      if (aggregate.kind !== 'aggregate') {
        throw new RuntimeFault('member access on a non-aggregate value', expression.start);
      }
      baseAddress = aggregate.address;
      baseType = aggregate.type;
    }

    const member = baseType.members?.find((item) => item.name === expression.property);
    if (!member) return null;
    return { address: baseAddress + member.offset, type: member.type };
  }

  private resolveIndex(expression: Extract<Expression, { kind: 'index' }>): {
    address: number;
    type: CType;
  } {
    const base = this.decay(this.evaluate(expression.object));
    const index = Math.trunc(toNumber(this.evaluate(expression.index)));

    if (base.kind === 'aggregate' && base.type.kind === 'array' && base.type.element) {
      return { address: base.address + index * Math.max(base.type.element.size, 1), type: base.type.element };
    }

    // C++ containers: element 0 lives at the data pointer, not at the control block.
    if (base.kind === 'aggregate' && isVectorType(base.type)) {
      const element = this.vectorElement(base.address, base.type);
      const data = this.memory.readUint64(base.address);
      return { address: data + index * Math.max(element.size, 1), type: element };
    }

    const pointeeOfBase = base.type.pointee;
    if (base.kind === 'pointer' && pointeeOfBase && (isVectorType(pointeeOfBase) || isStringType(pointeeOfBase))) {
      const isVector = isVectorType(pointeeOfBase);
      const element = isVector ? this.vectorElement(base.address, pointeeOfBase) : charType();
      const data = this.memory.readUint64(base.address);
      return { address: data + index * Math.max(element.size, 1), type: element };
    }

    const address = toPointerAddress(base);
    const pointee = base.type.pointee;
    if (address === null || !pointee) {
      throw new RuntimeFault('subscript on a non-pointer value', expression.start);
    }
    if (address === 0) throw new RuntimeFault('null pointer dereference', expression.start);
    return { address: address + index * Math.max(pointee.size, 1), type: pointee };
  }

  private evaluateCall(expression: Extract<Expression, { kind: 'call' }>): Value {
    const callee = expression.callee;

    if (callee.kind === 'identifier') {
      const name = callee.name;
      const definition = this.definitions.get(name);
      if (definition) return this.callFunction(definition, this.callArguments(expression.args, definition));

      if (INTERPRETER_BUILTINS.has(name) || SIMPLE_BUILTINS.has(name)) {
        return this.callBuiltin(name, expression.args, expression.start);
      }

      // C++ helpers the engine implements itself: std::sort, std::min, std::swap…
      const helper = this.callCppHelper(name, expression.args, expression.start);
      if (helper !== undefined) return helper;

      // A prototype with no body: report it as such rather than as "unknown".
      const prototype = this.functions.get(name);
      if (prototype) {
        throw new RuntimeFault(
          `function '${name}' has no body (only a prototype was declared)`,
          expression.start,
        );
      }
      // Otherwise fall through: the name may be a variable holding a function
      // pointer, which the generic path below resolves.
    }

    // Container member calls: v.size(), v.push_back(x), s.substr(1, 2)…
    if (callee.kind === 'member') {
      const container = this.callContainerMethod(callee, expression.args, expression.start);
      if (container !== undefined) return container;
    }

    // Calling through a function pointer.
    const value = this.evaluate(callee);
    const address = toPointerAddress(value);
    if (value.kind === 'pointer' && address !== null && address > 0) {
      const name = this.functionTable[address];
      const target = name ? this.functions.get(name) : undefined;
      if (target) return this.callFunction(target, this.callArguments(expression.args, target));
    }

    throw new RuntimeFault('call of a value that is not a function', expression.start);
  }

  private callArguments(args: readonly Expression[], target: FunctionDeclNode): Value[] {
    const params = target.params;
    const values: Value[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!argument) continue;
      const raw = this.evaluateRaw(argument);
      const param = params[index];
      const paramType = param ? this.resolver.resolve(param.type) : undefined;
      if (paramType && isPointerType(paramType)) {
        const address = this.pointerAddressOf(raw);
        values.push({ kind: 'pointer', type: paramType, address: address ?? 0 });
      } else if (paramType) {
        values.push(convertTo(paramType, raw));
      } else {
        values.push(this.decay(raw));
      }
    }
    return values;
  }

  /** Evaluates without decaying arrays, so `sizeof`/`&` see the real thing. */
  private evaluateRaw(expression: Expression): Value {
    return this.evaluate(expression);
  }

  private callFunction(declaration: FunctionDeclNode, args: readonly Value[]): Value {
    this.recursionDepth += 1;
    if (this.recursionDepth > this.limits.maxRecursionDepth) {
      throw new BudgetFault(
        'recursion',
        `recursion deeper than ${this.limits.maxRecursionDepth} frames`,
      );
    }

    if (!declaration.body) {
      throw new RuntimeFault(
        `function '${declaration.name}' has no body (only a prototype was declared)`,
        declaration.start,
      );
    }

    const body = declaration.body;
    this.pushScope(declaration.name);
    this.callStack.push({ name: declaration.name, position: body.start });
    this.refreshStackSnapshot();

    try {
      declaration.params.forEach((param, index) => {
        if (param.name === undefined) return;
        const type = this.resolver.resolve(param.type);
        const address = this.allocateFor(type);
        const argument = args[index] ?? intValue(intType(), 0);
        this.store(type, address, convertTo(type, argument));
        this.bind({
          name: param.name,
          type,
          address,
          storage: 'param',
          scopeName: declaration.name,
          declaredAt: param.start,
        });
      });

      if (declaration.variadic) {
        // Extra arguments are reachable only through va_list, which is not
        // implemented; nothing to bind here.
      }

      try {
        this.executeStatement(body);
      } catch (flow) {
        if (flow instanceof ControlFlow && flow.flow === 'return') {
          return flow.value ?? voidValue();
        }
        throw flow;
      }
      return voidValue();
    } finally {
      this.callStack.pop();
      // Keep the deepest snapshot when unwinding a fault, so `frames` points at
      // where the program actually failed.
      if (!faultPropagating) this.refreshStackSnapshot();
      this.popScope();
      this.recursionDepth -= 1;
    }
  }

  // -------------------------------------------------------------- builtins

  private builtinContext(): SimpleBuiltinContext {
    return {
      memory: this.memory,
      types: {
        int: intType(),
        long: longType(),
        double: doubleType(),
        char: charType(),
        voidPointer: pointerTo(VOID_TYPE),
        charPointer: pointerTo(charType()),
        voidType: VOID_TYPE,
      },
      rng: this.rng,
      alloc: (size) => this.builtinAlloc(size),
      free: (address) => this.builtinFree(address),
      allocationSize: (address) => this.allocations.get(address),
      readString: (address) => this.memory.readCString(address),
      writeString: (address, text) => {
        for (let index = 0; index < text.length; index += 1) {
          this.memory.writeUint8(address + index, text.charCodeAt(index) & 0xff);
        }
        this.memory.writeUint8(address + text.length, 0);
      },
      fail: (message) => {
        throw new RuntimeFault(message, this.unit.start);
      },
    };
  }

  private builtinAlloc(size: number): number {
    const address = this.memory.alloc(Math.max(Math.trunc(size), 1), 16);
    this.allocations.set(address, Math.max(Math.trunc(size), 1));
    return address;
  }

  private builtinFree(address: number): void {
    if (address === 0) return;
    this.memory.free(address);
    this.allocations.delete(address);
  }

  private callBuiltin(name: string, args: readonly Expression[], position: SourcePos): Value {
    const values = args.map((argument) => this.evaluateRaw(argument));

    if (name === 'getchar') {
      const code = this.readStdinChar();
      return intValue(intType(), code);
    }
    if (name === 'fflush') return intValue(intType(), 0);
    if (name === 'perror') {
      const prefix = this.readStringValue(values[0]);
      this.errorOutput += `${prefix}: error\n`;
      return voidValue();
    }
    if (name === 'time' || name === 'clock') {
      return name === 'time'
        ? intValue(longType(), Math.floor(Date.now() / 1000))
        : intValue(longType(), Math.floor(this.steps / 1000));
    }
    if (name === 'exit') {
      throw new ControlFlow('exit', undefined, undefined, Math.trunc(toNumber(values[0] ?? intValue(intType(), 0))));
    }
    if (name === '__assert_fail') {
      const expression = this.readStringValue(values[0]);
      throw new RuntimeFault(`assertion failed: ${expression}`, position);
    }
    if (name === 'printf' || name === 'fprintf') {
      const toStderr = name === 'fprintf' || this.streamName(values[0]) === 'cerr';
      const formatIndex = name === 'fprintf' ? 1 : 0;
      const format = this.readStringValue(values[formatIndex]);
      const { text } = formatC(format, values.slice(formatIndex + 1), this.memory);
      this.appendOutput(text, toStderr);
      return intValue(intType(), text.length);
    }
    if (name === 'sprintf' || name === 'snprintf') {
      const destination = toNumber(values[0] ?? intValue(intType(), 0));
      const format = this.readStringValue(values[1]);
      const { text } = formatC(format, values.slice(2), this.memory);
      const payload =
        name === 'snprintf'
          ? text.slice(0, Math.max(Math.trunc(toNumber(values[1 + 1] ?? intValue(intType(), 0))) - 1, 0))
          : text;
      this.writeStringAt(destination, payload);
      return intValue(intType(), payload.length);
    }
    if (name === 'scanf' || name === 'sscanf') {
      const source = name === 'sscanf' ? this.readStringValue(values[0]) : undefined;
      const formatIndex = name === 'sscanf' ? 1 : 0;
      const format = this.readStringValue(values[formatIndex]);
      return intValue(intType(), this.scan(format, values.slice(formatIndex + 1), source));
    }
    if (name === 'qsort') {
      this.qsort(values, position);
      return voidValue();
    }

    const simple = SIMPLE_BUILTINS.get(name);
    if (simple) {
      const result = simple.call(values, this.builtinContext());
      if (name === 'putchar') {
        this.appendOutput(String.fromCharCode(Math.trunc(toNumber(values[0] ?? intValue(intType(), 0))) & 0xff), false);
      }
      if (name === 'puts' || name === 'fputs') {
        this.appendOutput(`${this.readStringValue(values[0])}\n`, false);
      }
      return result;
    }

    throw new RuntimeFault(`function '${name}' is declared but not implemented`, position);
  }

  private writeStringAt(address: number, text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      this.memory.writeUint8(address + index, text.charCodeAt(index) & 0xff);
    }
    this.memory.writeUint8(address + text.length, 0);
  }

  private scan(format: string, targets: readonly Value[], source: string | undefined): number {
    const input = source ?? this.stdinText.slice(this.stdinCursor);
    let cursor = 0;
    let assigned = 0;
    let formatIndex = 0;

    const skipWhitespace = (): void => {
      while (cursor < input.length && /\s/.test(input.charAt(cursor))) cursor += 1;
    };

    while (formatIndex < format.length) {
      const spec = format.charAt(formatIndex);
      if (spec === '%') {
        formatIndex += 1;
        const conversion = format.charAt(formatIndex);
        formatIndex += 1;

        if (conversion === 'd' || conversion === 'i' || conversion === 'u' || conversion === 'x') {
          skipWhitespace();
          const start = cursor;
          if (input.charAt(cursor) === '-' || input.charAt(cursor) === '+') cursor += 1;
          while (cursor < input.length && /[0-9a-fA-F]/.test(input.charAt(cursor))) cursor += 1;
          const text = input.slice(start, cursor);
          const base = conversion === 'x' ? 16 : 10;
          const value = Number.parseInt(text, base);
          const target = targets[assigned];
          if (target) {
            this.storeThroughPointer(target, intValue(intType(), Number.isNaN(value) ? 0 : value));
            assigned += 1;
          }
          continue;
        }

        if (conversion === 'f' || conversion === 'e' || conversion === 'g') {
          skipWhitespace();
          const start = cursor;
          while (cursor < input.length && /[-+0-9.eE]/.test(input.charAt(cursor))) cursor += 1;
          const value = Number.parseFloat(input.slice(start, cursor));
          const target = targets[assigned];
          if (target) {
            this.storeThroughPointer(
              target,
              floatValue(this.pointerPointee(target) ?? doubleType(), Number.isNaN(value) ? 0 : value),
            );
            assigned += 1;
          }
          continue;
        }

        if (conversion === 'c') {
          const target = targets[assigned];
          if (target) {
            this.storeThroughPointer(target, intValue(charType(), input.charCodeAt(cursor)));
            assigned += 1;
          }
          cursor += 1;
          continue;
        }

        if (conversion === 's') {
          skipWhitespace();
          const start = cursor;
          while (cursor < input.length && !/\s/.test(input.charAt(cursor))) cursor += 1;
          const target = targets[assigned];
          if (target) {
            const address = this.pointerAddressOf(target) ?? 0;
            this.writeStringAt(address, input.slice(start, cursor));
            assigned += 1;
          }
          continue;
        }

        continue;
      }

      if (/\s/.test(spec)) {
        skipWhitespace();
        formatIndex += 1;
        continue;
      }

      if (input.charAt(cursor) === spec) cursor += 1;
      formatIndex += 1;
    }

    if (source === undefined) this.stdinCursor += cursor;
    return assigned;
  }

  private storeThroughPointer(target: Value, value: Value): void {
    const address = this.pointerAddressOf(target);
    if (address === null || address === 0) return;
    const pointee = this.pointerPointee(target) ?? intType();
    this.store(pointee, address, convertTo(pointee, value));
  }

  private pointerPointee(value: Value): CType | undefined {
    if (value.kind === 'pointer') return value.type.pointee;
    if (value.kind === 'aggregate') return value.type.element;
    return undefined;
  }

  private qsort(values: readonly Value[], position: SourcePos): void {
    const base = toNumber(values[0] ?? intValue(intType(), 0));
    const count = Math.trunc(toNumber(values[1] ?? intValue(intType(), 0)));
    const size = Math.max(Math.trunc(toNumber(values[2] ?? intValue(intType(), 0))), 1);
    const comparator = values[3];
    if (!comparator) throw new RuntimeFault('qsort requires a comparator', position);

    const left = this.builtinAlloc(size);
    const right = this.builtinAlloc(size);

    const compare = (a: number, b: number): number => {
      this.memory.copy(a, left, size);
      this.memory.copy(b, right, size);
      const result = this.callFunctionPointer(comparator, [
        pointerValue(VOID_TYPE, left),
        pointerValue(VOID_TYPE, right),
      ]);
      return Math.trunc(toNumber(result));
    };

    for (let index = 1; index < count; index += 1) {
      let cursor = index;
      while (cursor > 0) {
        const current = base + cursor * size;
        const previous = base + (cursor - 1) * size;
        if (compare(previous, current) <= 0) break;
        this.memory.copy(previous, left, size);
        this.memory.copy(current, previous, size);
        this.memory.copy(left, current, size);
        cursor -= 1;
      }
    }

    this.builtinFree(left);
    this.builtinFree(right);
  }

  private callFunctionPointer(value: Value, args: readonly Value[]): Value {
    const address = toPointerAddress(value);
    const name = address !== null ? this.functionTable[address] : undefined;
    const declaration = name ? this.definitions.get(name) : undefined;
    if (!declaration) throw new RuntimeFault('call through an invalid function pointer', this.unit.start);
    return this.callFunction(declaration, args);
  }

  // ------------------------------------------------------- C++ containers

  /** Element type of a vector: the declared one, else its runtime descriptor. */
  private vectorElement(address: number, type: CType): CType {
    const declared = type.element;
    if (declared && declared.kind !== 'unknown') return declared;
    const code = this.memory.readInt32(address + 24);
    const size = this.memory.readInt32(address + 28);
    return elementTypeFromCode(code, size);
  }

  private createVector(type: CType, address: number, items: readonly Expression[]): void {
    const declared = type.element;
    const element = declared && declared.kind !== 'unknown' ? declared : intType();
    const elementSize = Math.max(element.size, 1);
    const capacity = Math.max(items.length, 4);
    const data = this.builtinAlloc(capacity * elementSize);

    items.forEach((item, index) => {
      if (item.kind === 'init-list') return;
      const value = convertTo(element, this.evaluate(item));
      this.store(element, data + index * elementSize, value);
    });

    this.memory.writeUint64(address, data);
    this.memory.writeInt64(address + 8, items.length);
    this.memory.writeInt64(address + 16, capacity);
    this.memory.writeInt32(address + 24, elementKindCode(element));
    this.memory.writeInt32(address + 28, elementSize);
  }

  private copyVector(
    sourceAddress: number,
    sourceType: CType,
    destinationAddress: number,
    destinationType: CType,
  ): void {
    const element = this.vectorElement(sourceAddress, sourceType);
    const size = this.memory.readInt64(sourceAddress + 8);
    const elementSize = Math.max(element.size, 1);
    const data = this.builtinAlloc(Math.max(size, 1) * elementSize);
    if (size > 0) {
      this.memory.copy(this.memory.readUint64(sourceAddress), data, size * elementSize);
    }
    this.memory.writeUint64(destinationAddress, data);
    this.memory.writeInt64(destinationAddress + 8, size);
    this.memory.writeInt64(destinationAddress + 16, Math.max(size, 4));
    this.memory.writeInt32(destinationAddress + 24, elementKindCode(element));
    this.memory.writeInt32(destinationAddress + 28, elementSize);
    void destinationType;
  }

  private vectorPush(address: number, type: CType, argument: Value): void {
    const element = this.vectorElement(address, type);
    const elementSize = Math.max(element.size, 1);
    let data = this.memory.readUint64(address);
    const size = this.memory.readInt64(address + 8);
    let capacity = this.memory.readInt64(address + 16);

    if (size + 1 > capacity) {
      const grown = Math.max(capacity * 2, 4);
      const next = this.memory.alloc(grown * elementSize, 8);
      if (size > 0) this.memory.copy(data, next, size * elementSize);
      data = next;
      capacity = grown;
      this.memory.writeUint64(address, data);
      this.memory.writeInt64(address + 16, capacity);
    }

    this.store(element, data + size * elementSize, convertTo(element, argument));
    this.memory.writeInt64(address + 8, size + 1);
  }

  private createString(address: number, text: string): void {
    const data = this.builtinAlloc(Math.max(text.length + 1, 1));
    this.writeStringAt(data, text);
    this.memory.writeUint64(address, data);
    this.memory.writeInt64(address + 8, text.length);
  }

  private stringText(address: number): string {
    return this.memory.readCString(this.memory.readUint64(address), 1 << 16);
  }

  private stringAppend(address: number, extra: string): void {
    this.createString(address, this.stringText(address) + extra);
  }

  /** Allocates a fresh std::string (for `to_string`, `substr`, `+`). */
  private makeString(text: string): Value {
    const address = this.builtinAlloc(16);
    this.createString(address, text);
    return { kind: 'aggregate', type: this.resolver.resolveByName('std::string'), address };
  }

  /** Renders any printable value the way `std::cout` would. */
  private plainText(value: Value): string {
    if (value.kind === 'pointer' && value.type.pointee?.kind === 'char') {
      return value.address === 0 ? '' : this.memory.readCString(value.address, 1 << 16);
    }
    if (value.kind === 'aggregate') {
      if (isStringType(value.type)) return this.stringText(value.address);
      if (value.type.kind === 'array' && value.type.element?.kind === 'char') {
        return this.memory.readCString(value.address, 1 << 16);
      }
    }
    if (value.kind === 'int' && value.type.kind === 'char') {
      return String.fromCharCode(value.value & 0xff);
    }
    // `std::cout << 4.0` prints "4", not the watch pane's "4.0".
    if (value.kind === 'float') return `${value.value}`;
    return formatValue(value, this.memory);
  }

  /**
   * A view over anything iterable: C array, `std::vector`, `std::string`, or a
   * pointer to one of those. Sharing this is what lets range-based for, `sort`
   * and the watch pane all agree on what "length" means.
   */
  private sequenceOf(
    value: Value,
  ): { length: number; element: CType; data: number; stride: number } | null {
    if (value.kind === 'aggregate' && value.type.kind === 'array' && value.type.element) {
      return {
        length: value.type.length ?? 0,
        element: value.type.element,
        data: value.address,
        stride: Math.max(value.type.element.size, 1),
      };
    }

    if (value.kind === 'aggregate' && isVectorType(value.type)) {
      const element = this.vectorElement(value.address, value.type);
      return {
        length: this.memory.readInt64(value.address + 8),
        element,
        data: this.memory.readUint64(value.address),
        stride: Math.max(element.size, 1),
      };
    }

    if (value.kind === 'aggregate' && isStringType(value.type)) {
      return {
        length: this.memory.readInt64(value.address + 8),
        element: charType(),
        data: this.memory.readUint64(value.address),
        stride: 1,
      };
    }

    if (value.kind === 'pointer' && value.type.pointee) {
      const pointee = value.type.pointee;
      if (isVectorType(pointee)) {
        const element = this.vectorElement(value.address, pointee);
        return {
          length: this.memory.readInt64(value.address + 8),
          element,
          data: this.memory.readUint64(value.address),
          stride: Math.max(element.size, 1),
        };
      }
      if (isStringType(pointee)) {
        return {
          length: this.memory.readInt64(value.address + 8),
          element: charType(),
          data: this.memory.readUint64(value.address),
          stride: 1,
        };
      }
    }

    return null;
  }

  private executeForRange(statement: Extract<Statement, { kind: 'for-range' }>): void {
    const iterable = this.evaluateRaw(statement.iterable);
    const sequence = this.sequenceOf(iterable);
    if (!sequence) {
      throw new RuntimeFault(
        'range-based for needs an array, std::vector or std::string',
        statement.start,
      );
    }

    const declaration = statement.declaration;
    if (declaration.kind !== 'variable') {
      throw new RuntimeFault('range-based for needs a loop variable', statement.start);
    }

    this.pushScope(this.currentScopeName());
    try {
      const declaredType = this.resolver.resolve(declaration.type);
      // `const auto& v` arrives as a pointer to auto: the element type wins.
      const elementType =
        declaredType.kind === 'unknown' || declaredType.kind === 'pointer'
          ? sequence.element
          : declaredType;

      const address = this.allocateFor(elementType);
      const binding: Binding = {
        name: declaration.name,
        type: elementType,
        address,
        storage: 'local',
        scopeName: this.currentScopeName(),
        declaredAt: declaration.start,
      };
      this.bind(binding);

      for (let index = 0; index < sequence.length; index += 1) {
        this.tick();
        const value = this.load(sequence.element, sequence.data + index * sequence.stride);
        this.store(elementType, address, convertTo(elementType, value));
        this.record(binding, declaration.start);
        try {
          this.executeStatement(statement.body);
        } catch (flow) {
          if (flow instanceof ControlFlow) {
            if (flow.flow === 'break') break;
            if (flow.flow !== 'continue') throw flow;
          } else {
            throw flow;
          }
        }
      }
    } finally {
      this.popScope();
    }
  }

  private callContainerMethod(
    member: Extract<Expression, { kind: 'member' }>,
    args: readonly Expression[],
    position: SourcePos,
  ): Value | undefined {
    const object = this.evaluateRaw(member.object);
    const property = member.property;

    if (object.kind === 'aggregate' && isVectorType(object.type)) {
      const address = object.address;
      const element = this.vectorElement(address, object.type);
      const data = this.memory.readUint64(address);
      const stride = Math.max(element.size, 1);
      const size = this.memory.readInt64(address + 8);

      const argumentAt = (index: number): Value =>
        args[index] ? this.evaluateRaw(args[index] as Expression) : intValue(intType(), 0);

      switch (property) {
        case 'size':
        case 'length':
          return intValue(longType(), size);
        case 'empty':
          return intValue(intType(), size === 0 ? 1 : 0);
        case 'clear':
          this.memory.writeInt64(address + 8, 0);
          return voidValue();
        case 'push_back':
          this.vectorPush(address, object.type, argumentAt(0));
          return voidValue();
        case 'emplace_back':
          this.vectorPush(address, object.type, argumentAt(0));
          return voidValue();
        case 'pop_back':
          if (size > 0) this.memory.writeInt64(address + 8, size - 1);
          return voidValue();
        case 'front':
          return size > 0 ? this.load(element, data) : voidValue();
        case 'back':
          return size > 0 ? this.load(element, data + (size - 1) * stride) : voidValue();
        case 'at': {
          const index = Math.trunc(toNumber(argumentAt(0)));
          if (index < 0 || index >= size) {
            throw new RuntimeFault(`std::vector index ${index} is out of range`, position);
          }
          return this.load(element, data + index * stride);
        }
        case 'data':
        case 'begin':
          return pointerValue(element, data);
        case 'end':
          return pointerValue(element, data + size * stride);
        case 'resize': {
          const wanted = Math.max(Math.trunc(toNumber(argumentAt(0))), 0);
          while (this.memory.readInt64(address + 8) < wanted) {
            this.vectorPush(address, object.type, intValue(element, 0));
          }
          if (wanted < this.memory.readInt64(address + 8)) {
            this.memory.writeInt64(address + 8, wanted);
          }
          return voidValue();
        }
        case 'reserve':
        case 'shrink_to_fit':
          return voidValue();
        default:
          throw new RuntimeFault(`std::vector has no member '${property}'`, position);
      }
    }

    if (object.kind === 'aggregate' && isStringType(object.type)) {
      const address = object.address;
      const text = this.stringText(address);

      const argumentAt = (index: number): Value =>
        args[index] ? this.evaluateRaw(args[index] as Expression) : intValue(intType(), 0);

      switch (property) {
        case 'size':
        case 'length':
          return intValue(longType(), text.length);
        case 'empty':
          return intValue(intType(), text.length === 0 ? 1 : 0);
        case 'clear':
          this.createString(address, '');
          return voidValue();
        case 'c_str':
        case 'data':
          return pointerValue(charType(), this.memory.readUint64(address));
        case 'push_back':
          this.stringAppend(address, String.fromCharCode(Math.trunc(toNumber(argumentAt(0))) & 0xff));
          return voidValue();
        case 'append':
        case 'operator+=':
          this.stringAppend(address, this.plainText(argumentAt(0)));
          return voidValue();
        case 'substr': {
          const from = Math.trunc(toNumber(argumentAt(0)));
          const count = args[1] ? Math.trunc(toNumber(argumentAt(1))) : text.length - from;
          return this.makeString(text.slice(from, from + count));
        }
        case 'find':
          return intValue(longType(), text.indexOf(this.plainText(argumentAt(0))));
        case 'compare': {
          const other = this.plainText(argumentAt(0));
          return intValue(intType(), text < other ? -1 : text > other ? 1 : 0);
        }
        default:
          throw new RuntimeFault(`std::string has no member '${property}'`, position);
      }
    }

    return undefined;
  }

  /** `std::sort`, `std::min`, `std::max`, `std::swap`, `std::to_string`, ... */
  private callCppHelper(
    name: string,
    args: readonly Expression[],
    position: SourcePos,
  ): Value | undefined {
    const base = name.replace(/^std::/, '');
    const supported = new Set([
      'min', 'max', 'abs', 'swap', 'sort', 'reverse', 'distance',
      'to_string', 'stoi', 'stod', 'fabs',
    ]);
    if (!name.startsWith('std::') && !supported.has(base)) return undefined;
    if (!supported.has(base)) return undefined;

    const argumentAt = (index: number): Value => {
      const expression = args[index];
      if (!expression) throw new RuntimeFault(`${name} needs more arguments`, position);
      return this.evaluateRaw(expression);
    };

    switch (base) {
      case 'min':
      case 'max': {
        const left = argumentAt(0);
        const right = argumentAt(1);
        const takeLeft = base === 'min' ? toNumber(left) <= toNumber(right) : toNumber(left) >= toNumber(right);
        return takeLeft ? left : right;
      }
      case 'abs':
      case 'fabs': {
        const value = argumentAt(0);
        const magnitude = Math.abs(toNumber(value));
        return isFloatType(value.type) ? floatValue(value.type, magnitude) : intValue(value.type, magnitude);
      }
      case 'swap': {
        const leftTarget = args[0] ? this.lvalue(args[0]) : null;
        const rightTarget = args[1] ? this.lvalue(args[1]) : null;
        if (!leftTarget || !rightTarget) {
          throw new RuntimeFault('swap needs two assignable arguments', position);
        }
        const size = Math.min(
          Math.max(leftTarget.type.size, 1),
          Math.max(rightTarget.type.size, 1),
        );
        const temporary = this.memory.readBytes(leftTarget.address, size);
        this.memory.copy(rightTarget.address, leftTarget.address, size);
        this.memory.writeBytes(rightTarget.address, temporary);
        return voidValue();
      }
      case 'sort':
      case 'reverse':
        this.sortRange(args, position, base === 'reverse');
        return voidValue();
      case 'distance': {
        const from = this.decay(argumentAt(0));
        const to = this.decay(argumentAt(1));
        const element = from.type.pointee ?? from.type.element;
        return intValue(longType(), Math.floor((toNumber(to) - toNumber(from)) / Math.max(element?.size ?? 1, 1)));
      }
      case 'to_string':
        return this.makeString(this.plainText(argumentAt(0)));
      case 'stoi':
        return intValue(
          intType(),
          Number.parseInt(this.plainText(argumentAt(0)).trim(), 10) || 0,
        );
      case 'stod':
        return floatValue(doubleType(), Number.parseFloat(this.plainText(argumentAt(0)).trim()) || 0);
      default:
        return undefined;
    }
  }

  private sortRange(args: readonly Expression[], position: SourcePos, reverse: boolean): void {
    const first = args[0];
    if (!first) throw new RuntimeFault('sort needs a range', position);

    const fromValue = this.decay(this.evaluateRaw(first));
    let from = toNumber(fromValue);
    let element = fromValue.type.pointee ?? fromValue.type.element;
    let count = 0;

    const second = args[1];
    if (second) {
      const toValue = this.decay(this.evaluateRaw(second));
      const to = toNumber(toValue);
      element = element ?? toValue.type.pointee ?? toValue.type.element;
      if (!element) throw new RuntimeFault('cannot determine the element type to sort', position);
      count = Math.floor((to - from) / Math.max(element.size, 1));
    } else {
      const sequence = this.sequenceOf(fromValue);
      if (!sequence) throw new RuntimeFault('sort needs a range', position);
      from = sequence.data;
      element = sequence.element;
      count = sequence.length;
    }

    if (count <= 1) return;
    const elementSize = Math.max(element.size, 1);

    // With a comparator, sort through the user's own ordering.
    const comparatorExpression = args[2];
    if (comparatorExpression) {
      const comparator = this.evaluateRaw(comparatorExpression);
      const temporary = this.builtinAlloc(elementSize);
      for (let index = 1; index < count; index += 1) {
        let cursor = index;
        while (cursor > 0) {
          const current = from + cursor * elementSize;
          const previous = from + (cursor - 1) * elementSize;
          // A C++ comparator is "less": cmp(a, b) != 0 means a must come first,
          // so compare (current, previous) and swap when it says so. (C's qsort
          // comparator is the other convention, and qsort keeps its own order.)
          const result = this.callFunctionPointer(comparator, [
            this.load(element, current),
            this.load(element, previous),
          ]);
          const before = toNumber(result) !== 0;
          const shouldSwap = reverse ? !before : before;
          if (!shouldSwap) break;
          this.memory.copy(previous, temporary, elementSize);
          this.memory.copy(current, previous, elementSize);
          this.memory.copy(temporary, current, elementSize);
          cursor -= 1;
        }
      }
      this.builtinFree(temporary);
      return;
    }

    const entries: Array<{ key: number | string; bytes: Uint8Array }> = [];
    for (let index = 0; index < count; index += 1) {
      const address = from + index * elementSize;
      entries.push({ key: this.sortKey(element, address), bytes: this.memory.readBytes(address, elementSize) });
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (reverse) entries.reverse();
    entries.forEach((entry, index) => this.memory.writeBytes(from + index * elementSize, entry.bytes));
  }

  private sortKey(element: CType, address: number): number | string {
    if (element.kind === 'pointer') {
      const pointer: Value = { kind: 'pointer', type: element, address: this.memory.readUint64(address) };
      return this.plainText(pointer);
    }
    return toNumber(this.load(element, address));
  }

  // ------------------------------------------------------------- memory IO

  private store(type: CType, address: number, value: Value): void {
    switch (type.kind) {
      case 'bool':
        this.memory.writeUint8(address, toNumber(value) !== 0 ? 1 : 0);
        return;
      case 'char':
        this.memory.writeUint8(address, toNumber(value) & 0xff);
        return;
      case 'int':
      case 'enum':
        if (type.size === 2) {
          this.memory.writeInt16(address, toNumber(value));
        } else if (type.size === 1) {
          this.memory.writeUint8(address, toNumber(value) & 0xff);
        } else if (type.size === 8) {
          if (type.signed) this.memory.writeInt64(address, toNumber(value));
          else this.memory.writeUint64(address, toNumber(value));
        } else if (type.signed) {
          this.memory.writeInt32(address, toNumber(value));
        } else {
          this.memory.writeUint32(address, toNumber(value));
        }
        return;
      case 'float':
        this.memory.writeFloat32(address, toNumber(value));
        return;
      case 'double':
        this.memory.writeFloat64(address, toNumber(value));
        return;
      case 'pointer':
        this.memory.writeUint64(address, this.pointerAddressOf(value) ?? 0);
        return;
      case 'struct':
      case 'union': {
        if (value.kind === 'aggregate') {
          this.memory.copy(value.address, address, Math.max(type.size, 1));
          return;
        }
        // Struct initialized from a scalar: zero it and store the first member.
        this.memory.fill(address, 0, Math.max(type.size, 1));
        const first = type.members?.[0];
        if (first) this.store(first.type, address + first.offset, value);
        return;
      }
      case 'array':
        if (value.kind === 'aggregate') {
          this.memory.copy(value.address, address, Math.max(type.size, 1));
          return;
        }
        return;
      default:
        // An unknown/template type is stored by the actual value kind, so a
        // double does not get truncated to an integer on the way in.
        if (value.kind === 'float') this.memory.writeFloat64(address, toNumber(value));
        else this.memory.writeInt64(address, Math.trunc(toNumber(value)));
        return;
    }
  }

  private load(type: CType, address: number, binding?: Binding): Value {
    switch (type.kind) {
      case 'bool':
        return intValue(type, this.memory.readUint8(address));
      case 'char':
        return intValue(type, type.signed ? this.memory.readInt8(address) : this.memory.readUint8(address));
      case 'int':
      case 'enum': {
        if (this.uninitialized.has(address)) this.warnUninitialized(address, binding);
        if (type.size === 2) return intValue(type, type.signed ? this.memory.readInt16(address) : this.memory.readUint16(address));
        if (type.size === 1) return intValue(type, type.signed ? this.memory.readInt8(address) : this.memory.readUint8(address));
        if (type.size === 8) {
          return intValue(type, type.signed ? this.memory.readInt64(address) : this.memory.readUint64(address));
        }
        return intValue(type, type.signed ? this.memory.readInt32(address) : this.memory.readUint32(address));
      }
      case 'float':
        return floatValue(type, this.memory.readFloat32(address));
      case 'double':
        return floatValue(type, this.memory.readFloat64(address));
      case 'pointer': {
        const raw = this.memory.readUint64(address);
        return { kind: 'pointer', type, address: raw };
      }
      case 'array':
        return { kind: 'aggregate', type, address };
      case 'struct':
      case 'union':
        return { kind: 'aggregate', type, address };
      default:
        // Unknown/template type: zero reads as 0 whichever width it later takes.
        return this.memory.readFloat64(address) === 0
          ? intValue(longType(), 0)
          : floatValue(doubleType(), this.memory.readFloat64(address));
    }
  }

  private warnUninitialized(address: number, binding?: Binding): void {
    this.uninitialized.delete(address);
    if (this.warnedUninitialized.has(address)) return;
    this.warnedUninitialized.add(address);
    const position = binding?.declaredAt ?? this.unit.start;
    this.diagnostics.push(
      makeDiagnostic(
        'warning',
        `read of uninitialized variable${binding ? ` '${binding.name}'` : ''}`,
        position.file,
        position,
        position,
      ),
    );
  }

  private pointerAddressOf(value: Value): number | null {
    if (value.kind === 'pointer') return value.address;
    if (value.kind === 'aggregate') return value.address;
    if (value.kind === 'int' && value.value === 0) return 0;
    return null;
  }

  private lvalue(expression: Expression): { address: number; type: CType } | null {
    switch (expression.kind) {
      case 'identifier': {
        const binding = this.lookup(expression.name);
        if (!binding) return null;
        return { address: binding.address, type: binding.type };
      }
      case 'index':
        return this.resolveIndex(expression);
      case 'member':
        return this.memberTarget(expression);
      case 'unary': {
        if (expression.operator !== '*') return null;
        const pointer = this.decay(this.evaluate(expression.operand));
        const address = toPointerAddress(pointer);
        const pointee = pointer.type.pointee ?? UNKNOWN_TYPE;
        if (address === null) return null;
        return { address, type: pointee };
      }
      default:
        return null;
    }
  }

  private decay(value: Value): Value {
    if (value.kind === 'aggregate' && value.type.kind === 'array' && value.type.element) {
      return pointerValue(value.type.element, value.address);
    }
    return value;
  }

  private typeOf(expression: Expression): CType {
    switch (expression.kind) {
      case 'identifier': {
        const binding = this.lookup(expression.name);
        return binding?.type ?? intType();
      }
      case 'literal':
        return expression.literal === 'string' ? arrayOf(charType(), (expression.value ?? '').length + 1) : intType();
      case 'cast':
        return this.resolver.resolve(expression.type);
      case 'index': {
        const base = this.typeOf(expression.object);
        return base.element ?? base.pointee ?? intType();
      }
      case 'member': {
        const base = this.typeOf(expression.object);
        const target = expression.arrow ? base.pointee : base;
        return target?.members?.find((item) => item.name === expression.property)?.type ?? intType();
      }
      case 'unary':
        if (expression.operator === '&') return pointerTo(this.typeOf(expression.operand));
        if (expression.operator === '*') return this.typeOf(expression.operand).pointee ?? intType();
        return this.typeOf(expression.operand);
      case 'sizeof':
        return longType();
      case 'call': {
        if (expression.callee.kind === 'identifier') {
          const declaration = this.functions.get(expression.callee.name);
          if (declaration) return this.resolver.resolve(declaration.returnType);
        }
        return intType();
      }
      default:
        return intType();
    }
  }

  private readStringValue(value: Value | undefined): string {
    if (!value) return '';
    const address = toPointerAddress(value);
    if (address === null || address === 0) return '';
    return this.memory.readCString(address);
  }

  private streamOf(expression: Expression): 'cout' | 'cerr' | null {
    if (expression.kind === 'identifier') {
      if (expression.name === 'std::cout' || expression.name === 'cout') return 'cout';
      if (expression.name === 'std::cerr' || expression.name === 'cerr') return 'cerr';
      return null;
    }
    if (expression.kind === 'binary' && expression.operator === '<<') {
      return this.streamOf(expression.left);
    }
    return null;
  }

  private streamName(value: Value | undefined): string {
    if (!value) return '';
    return value.type.name.includes('cerr') ? 'cerr' : 'cout';
  }

  private streamText(value: Value): string {
    if (value.type.name === 'std::endl') return '\n';
    return this.plainText(value);
  }

  private appendOutput(text: string, toStderr: boolean): void {
    if (this.output.length + this.errorOutput.length + text.length > this.limits.maxOutputChars) {
      throw new BudgetFault('output', `program produced more than ${this.limits.maxOutputChars} characters of output`);
    }
    if (toStderr) this.errorOutput += text;
    else this.output += text;
    this.onOutput?.(text, toStderr ? 'stderr' : 'stdout');
  }

  private readStdinChar(): number {
    if (this.stdinCursor >= this.stdinText.length) return -1;
    const code = this.stdinText.charCodeAt(this.stdinCursor);
    this.stdinCursor += 1;
    return code;
  }

  // ------------------------------------------------------------ watch data

  private record(binding: Binding, position: SourcePos): void {
    if (!this.limits.collectWatch) return;
    if (this.history.length >= this.limits.maxSnapshots) {
      this.truncated = true;
      return;
    }
    this.history.push({
      step: this.steps,
      line: position.line,
      scope: binding.scopeName,
      name: binding.name,
      vars: this.collectWatch(),
    });
  }

  private tick(): void {
    this.steps += 1;
    if (this.steps - this.lastStepCheck < CHECK_INTERVAL) return;
    this.lastStepCheck = this.steps;

    if (this.steps > this.limits.maxSteps) {
      throw new BudgetFault('steps', `stopped after ${this.limits.maxSteps} steps (possible infinite loop)`);
    }
    if (Date.now() - this.startedAt > this.limits.maxMillis) {
      throw new BudgetFault('time', `stopped after ${this.limits.maxMillis} ms (possible infinite loop)`);
    }
  }

  /**
   * Captures the variable state the first time a line finishes running, which is
   * what the watch pane shows for the line the cursor is on. First arrival wins:
   * that is predictable (and matches what a breakpoint would show), whereas "the
   * last time the line ran" would report a loop's final counter value.
   */
  private recordLine(line: number): void {
    if (!this.limits.collectWatch) return;
    if (this.lineStates.has(line)) return;
    if (this.lineStates.size >= MAX_LINE_STATES) {
      this.truncated = true;
      return;
    }
    this.lineStates.set(line, this.collectWatch());
  }

  private collectWatch(): WatchVariable[] {
    const latest = new Map<string, Binding>();
    for (const binding of this.allBindings) {
      // Only the user's own file: `stdin`/`stdout`/`stderr` come from headers.
      if (binding.declaredAt.file !== this.mainFile && binding.declaredAt.file.startsWith('<')) {
        continue;
      }
      latest.set(`${binding.scopeName}::${binding.name}`, binding);
    }

    const vars: WatchVariable[] = [];
    for (const binding of latest.values()) {
      if (vars.length >= this.limits.maxVars) {
        this.truncated = true;
        break;
      }
      vars.push(this.describe(binding, 0));
    }
    return vars;
  }

  private describe(binding: Binding, depth: number): WatchVariable {
    const value = this.load(binding.type, binding.address);
    const children = depth >= 2 ? [] : this.childrenOf(binding.type, binding.address, depth);

    return {
      name: binding.name,
      type: binding.type.name,
      value: formatValue(value, this.memory),
      scope: binding.scopeName,
      changed: false,
      line: binding.declaredAt.line,
      ...(children.length > 0 ? { children } : {}),
    };
  }

  /**
   * Expands aggregates for the watch pane. Takes an ADDRESS rather than a value
   * so arrays, structs and pointers all resolve through the same path.
   */
  private childrenOf(type: CType, address: number, depth: number): WatchVariable[] {
    const children: WatchVariable[] = [];

    const push = (name: string, childType: CType, childAddress: number): void => {
      if (children.length >= MAX_CHILDREN) {
        this.truncated = true;
        return;
      }
      const childValue = this.load(childType, childAddress);
      const nested = depth >= 1 ? [] : this.childrenOf(childType, childAddress, depth + 1);
      children.push({
        name,
        type: childType.name,
        value: formatValue(childValue, this.memory),
        scope: '',
        changed: false,
        line: 0,
        ...(nested.length > 0 ? { children: nested } : {}),
      });
    };

    if (isVectorType(type)) {
      // Show the elements, not the control block: the pane is about the data.
      const element = this.vectorElement(address, type);
      const size = this.memory.readInt64(address + 8);
      const data = this.memory.readUint64(address);
      const stride = Math.max(element.size, 1);
      const length = Math.min(size, MAX_CHILDREN);
      for (let index = 0; index < length; index += 1) {
        push(`[${index}]`, element, data + index * stride);
      }
      if (size > length) this.truncated = true;
      return children;
    }

    if (isStringType(type)) return children;

    if (type.kind === 'array' && type.element) {
      const declared = type.length ?? 0;
      const length = Math.min(declared, MAX_CHILDREN);
      for (let index = 0; index < length; index += 1) {
        push(`[${index}]`, type.element, address + index * Math.max(type.element.size, 1));
      }
      if (declared > length) this.truncated = true;
      return children;
    }

    if ((type.kind === 'struct' || type.kind === 'union') && type.members) {
      for (const member of type.members) {
        push(member.name, member.type, address + member.offset);
      }
      return children;
    }

    if (type.kind === 'pointer' && type.pointee) {
      const target = this.memory.readUint64(address);
      const pointee = type.pointee;
      // A `char *` already renders as the string it points at.
      if (target !== 0 && pointee.kind !== 'char' && pointee.kind !== 'void' && pointee.size > 0) {
        push('*', pointee, target);
      }
      return children;
    }

    return children;
  }
}

interface SwitchSegment {
  readonly value?: Expression;
  readonly isDefault: boolean;
  readonly statements: (Statement | Declaration)[];
}

/** Flattens a switch body into fall-through segments, one per case label. */
function flattenSwitch(body: Statement): SwitchSegment[] {
  const segments: SwitchSegment[] = [];

  const startSegment = (value: Expression | undefined, isDefault: boolean): SwitchSegment => {
    const segment: SwitchSegment = {
      ...(value === undefined ? {} : { value }),
      isDefault,
      statements: [],
    };
    segments.push(segment);
    return segment;
  };

  const visit = (statement: Statement): void => {
    switch (statement.kind) {
      case 'compound':
        for (const item of statement.items) {
          if (item.kind === 'case' || item.kind === 'default') visit(item);
          else if (segments.length > 0) segments[segments.length - 1]?.statements.push(item);
        }
        return;
      case 'case': {
        startSegment(statement.value, false);
        visit(statement.body);
        return;
      }
      case 'default': {
        startSegment(undefined, true);
        visit(statement.body);
        return;
      }
      default:
        if (segments.length > 0) segments[segments.length - 1]?.statements.push(statement);
        return;
    }
  };

  visit(body);
  return segments;
}

export { BudgetFault, RuntimeFault };
