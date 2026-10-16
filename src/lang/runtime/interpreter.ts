import type { Diagnostic } from '@/engine/types';
import type {
  CompoundStmt,
  Declaration,
  Expression,
  FunctionDeclNode,
  LambdaExpr,
  Statement,
  StructDeclNode,
  TranslationUnit,
  TypeRef,
  VarDecl,
} from '@/lang/ast';
import {
  TypeResolver,
  UNKNOWN_TYPE,
  VOID_TYPE,
  alignOf,
  arrayOf,
  bareTagName,
  containerKindOf,
  elementKindCode,
  elementTypeFromCode,
  isBitsetType,
  isFloatType,
  isIntegerType,
  isNumericType,
  isPointerType,
  isPairType,
  pairType,
  isStreamBuffer,
  isStringType,
  isVectorType,
  pairParts,
  pointerTo,
} from '@/lang/ctype';
import type { CType, CTypeMember } from '@/lang/ctype';
import { makeDiagnostic } from '@/lang/diagnostics';
import { Memory, MemoryError } from '@/lang/memory';
import {
  CONTAINER_PREVIEW_LIMIT,
  MAX_SEQUENCE_DEPTH,
  VECTOR_CAPACITY_OFFSET,
  VECTOR_COUNT_OFFSET,
  VECTOR_DATA_OFFSET,
  VECTOR_ELEMENT_KIND_OFFSET,
  VECTOR_ELEMENT_SIZE_OFFSET,
  readVectorLayout,
} from '@/lang/runtime/container';
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
import type { MemoryView, PointerChain, PointerNode, SafetyEvent, SafetyKind } from '@/engine/types';

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
  /** An assignment/declaration, or the completion of one loop iteration. */
  readonly kind: 'assignment' | 'loop-iteration';
  /** Interpreter step at which this state was captured. */
  readonly step: number;
  readonly line: number;
  readonly scope: string;
  /** The variable whose assignment produced this state ('' for an iteration). */
  readonly name: string;
  /** 1-based iteration number of its own loop, for `loop-iteration` entries. */
  readonly iteration?: number;
  /** Loop nesting depth (1 = outermost), so the innermost loop can be picked. */
  readonly depth?: number;
  /** Source lines this iteration executed, used to find the loop at the caret. */
  readonly lines?: readonly number[];
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
  /**
   * Runtime safety events: uninitialised reads, division by zero, null
   * dereferences, memory faults, and allocations never freed. Collected so they
   * can be listed together, including the ones that did not stop the program.
   */
  readonly safety: readonly SafetyEvent[];
  /** Live memory blocks and pointer chains, for the memory view. */
  readonly memory: MemoryView;
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
/** Ceiling on collected runtime safety events. */
const MAX_SAFETY_EVENTS = 50;

/** Memory view limits: enough to see a structure, bounded so it cannot flood the UI. */
const MAX_MEMORY_BLOCKS = 8;
const MEMORY_BYTES_PER_BLOCK = 96;
const MAX_POINTER_CHAINS = 4;
const MAX_CHAIN_NODES = 8;
/** Cap on the fields shown per node, matching the watch pane's children cap. */
const MAX_NODE_FIELDS = 6;

/** How a safety event should be presented, by kind. */
const SAFETY_SEVERITY: Readonly<Record<SafetyKind, SafetyEvent['severity']>> = {
  'uninitialized-read': 'warning',
  'division-by-zero': 'error',
  'null-dereference': 'error',
  'out-of-bounds': 'error',
  leak: 'info',
  'runtime-error': 'error',
};

/**
 * Classifies a runtime fault by what it says.
 *
 * The interpreter is the only place that knows which fault it just raised, so the
 * mapping lives here next to the messages rather than in the UI.
 */
export function safetyKindForFault(message: string): SafetyKind {
  if (message.includes('division by zero')) return 'division-by-zero';
  if (message.includes('null pointer')) return 'null-dereference';
  if (message.includes('invalid memory') || message.includes('out of bounds')) return 'out-of-bounds';
  return 'runtime-error';
}

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
  /** `T&`: the slot holds an address and every use goes through it. */
  readonly reference?: boolean;
  /** A reference to const: readable, not writable. */
  readonly readonly?: boolean;
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

/**
 * @brief Constructs the descriptor for the 32-bit single-precision floating point type.
 * @return CType descriptor for float.
 */
function floatType(): CType {
  return { kind: 'float', name: 'float', size: 4, signed: true, bits: 32 };
}

/**
 * @brief Constructs the descriptor for the 1-byte boolean type.
 * @return CType descriptor for bool.
 */
function boolType(): CType {
  return { kind: 'bool', name: 'bool', size: 1, signed: false, bits: 8 };
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

/**
 * How `std::cout <<` writes a floating point number.
 *
 * C++'s default is `defaultfloat` with a precision of six significant digits: `2.5`
 * stays `2.5`, `10.0 / 3.0` prints `3.33333`, and very large or very small values
 * switch to scientific notation with a two-digit exponent. Printing the full double
 * instead was a visible difference from a native compiler on the most ordinary code.
 */
export function formatDefaultFloat(value: number, precision = 6): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return '0';

  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= precision) {
    return value
      .toExponential(precision - 1)
      .replace(/e([+-])(\d)$/, 'e$10$2');
  }
  // `toPrecision` pads with zeros; `Number` drops them, as the stream does.
  return String(Number(value.toPrecision(precision)));
}

function isDeclarationKind(kind: string): boolean {
  return (
    kind === 'variable' ||
    kind === 'typedef' ||
    kind === 'struct' ||
    kind === 'enum' ||
    kind === 'function' ||
    kind === 'using' ||
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
  /** Allocations the program itself asked for (`malloc`, `new`, and their friends). */
  private readonly userAllocations = new Map<number, number>();
  /**
   * The type actually stored in a slot whose declared type is a template parameter.
   *
   * `T` has no width until something is written through it, and reading eight bytes
   * out of a four-byte write is how a template's `int` return came back as a double.
   */
  private readonly slotTypes = new Map<number, CType>();
  /** Set by `using namespace std;`, which the parser records as a declaration. */
  private stdNamespaceImported = false;
  /** Bare names from `using std::cout;` and friends. */
  private readonly importedNames = new Set<string>();
  /** Namespaces brought in with `using namespace X;`, applied once everything exists. */
  private readonly importedNamespaces = new Set<string>();
  /** Qualified names imported one at a time, kept for diagnostics. */
  private readonly importedFrom = new Set<string>();
  /** Overloaded function declarations by name. */
  private readonly functionOverloads = new Map<string, FunctionDeclNode[]>();
  /** Access of each registered method, keyed by its qualified name. */
  private readonly methodAccess = new Map<string, 'public' | 'private' | 'protected'>();
  /** Constructors by class tag and parameter count. */
  private readonly constructors = new Map<string, Map<number, FunctionDeclNode>>();
  /** Destructor by class tag. */
  private readonly destructors = new Map<string, FunctionDeclNode>();
  /** Locals waiting to be destroyed, with the scope they belong to. */
  private readonly pendingDestruction: Array<{
    readonly depth: number;
    readonly address: number;
    readonly type: CType;
    readonly tag: string;
  }> = [];
  /**
   * Lambdas that have been created: what they run, and what they captured.
   *
   * The value is an address, so a closure can be stored in a variable, passed to a
   * function and held by `std::function` - and this map is what turns that address back
   * into code and captured state.
   */
  private readonly closures = new Map<
    number,
    {
      readonly node: LambdaExpr;
      readonly byValue: Map<string, Value>;
      readonly byRef: Map<string, number>;
    }
  >();
  private closureSeq = 0;
  private readonly rng = { state: 1 };
  private stdinText: string;
  private stdinCursor = 0;
  private readonly callStack: Array<{ name: string; position: SourcePos }> = [];
  private lastStackSnapshot: StackFrameInfo[] = [];
  private readonly history: HistoryEntry[] = [];
  private readonly lineStates = new Map<number, WatchVariable[]>();
  /** Runtime safety events, collected for the "Runtime issues" view. */
  private readonly safetyEvents: SafetyEvent[] = [];
  /** Line of the statement being executed, for events that have no position. */
  private currentLine = 0;
  /** One line-set per active loop iteration (a stack: loops nest). */
  private readonly iterationLineStack: Array<Set<number>> = [];
  private readonly iterationCounters = new Map<number, number>();
  private loopDepth = 0;
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
        this.recordSafety(safetyKindForFault(error.message), error.message, error.position);
        return this.finish('runtime-error', null, error.message);
      }
      if (error instanceof MemoryError) {
        // A memory fault has an address but no line of its own: report where the
        // run was rather than inventing a position.
        this.recordSafety(safetyKindForFault(error.message), error.message);
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

    // Reported as information, not as a bug: a program that ends immediately has
    // no reason to free anything, but a growing allocation count is worth seeing.
    // Only the program's own allocations count; the interpreter's buffers are not
    // leaks.
    const unfreed = [...this.userAllocations.values()].reduce((total, size) => total + size, 0);
    if (unfreed > 0) {
      this.recordSafety(
        'leak',
        `${unfreed} byte cấp phát chưa được free khi chương trình kết thúc`,
      );
    }

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
      safety: [...this.safetyEvents],
      memory: this.buildMemoryView(),
    };
  }

  /**
   * What the program's memory holds, and where its pointers lead.
   *
   * A linked list is the thing every C course draws on a whiteboard, and the pane
   * that shows variables cannot show it: `next` is just an address there. Walking
   * it here, with a cycle and a depth limit reported rather than hidden, is the
   * difference between "0x1040" and the shape of the data.
   */
  private buildMemoryView(): MemoryView {
    // The heap the program sees: what it asked for, not what the interpreter keeps
    // for itself.
    const live = [...this.userAllocations.entries()]
      .map(([address, size]) => ({ address, size }))
      .sort((left, right) => left.address - right.address);

    const blocks = live.slice(0, MAX_MEMORY_BLOCKS).map((block) => {
      const bytes = this.memory.slice(block.address, Math.min(block.size, MEMORY_BYTES_PER_BLOCK));
      return {
        address: block.address,
        size: block.size,
        bytes: [...bytes],
        truncated: block.size > bytes.length,
      };
    });

    const chains: PointerChain[] = [];
    for (const binding of this.allBindings) {
      if (chains.length >= MAX_POINTER_CHAINS) break;
      if (binding.type.kind !== 'pointer') continue;

      const chain = this.followPointer(binding);
      if (chain) chains.push(chain);
    }

    return {
      blocks,
      chains,
      truncated: live.length > blocks.length || chains.length >= MAX_POINTER_CHAINS,
    };
  }

  /**
   * Follows a pointer through a chain of structs, the way a linked list is walked.
   *
   * Follows the first pointer-valued member of each node (the conventional `next`),
   * stopping at null, at a repeat (a cycle), or at the depth limit.
   */
  private followPointer(binding: Binding): PointerChain | null {
    const start = this.memory.readUint64(binding.address);
    const nodes: PointerNode[] = [];
    const seen = new Set<number>();
    let address = start;
    let end: PointerChain['end'] = 'unknown';

    while (nodes.length < MAX_CHAIN_NODES) {
      if (address === 0) {
        end = 'null';
        break;
      }
      if (seen.has(address)) {
        end = 'cycle';
        break;
      }
      if (!this.memory.isValid(address, 1)) {
        end = 'unknown';
        break;
      }
      seen.add(address);

      const type = binding.type.pointee;
      if (!type) break;

      const fields: { name: string; value: string }[] = [];
      let nextAddress = 0;
      const members = type.kind === 'struct' || type.kind === 'union' ? (type.members ?? []) : [];

      for (const member of members) {
        if (fields.length >= MAX_NODE_FIELDS) break;
        const memberAddress = address + member.offset;
        const value = this.load(member.type, memberAddress, undefined, false);
        fields.push({ name: member.name, value: formatValue(value, this.memory) });
        if (nextAddress === 0 && member.type.kind === 'pointer') {
          const raw = this.memory.readUint64(memberAddress);
          if (raw !== 0) nextAddress = raw;
        }
      }

      nodes.push({ address, fields });
      if (nextAddress === 0) {
        end = 'null';
        break;
      }
      address = nextAddress;
    }

    if (nodes.length === MAX_CHAIN_NODES && end === 'unknown') end = 'limit';
    return nodes.length > 0 ? { name: binding.name, nodes, end } : null;
  }

  private prepare(): void {
    // Types first: globals and parameters need sizes before anything is allocated.
    this.prepareTypes(this.unit.declarations);

    /*
     * `using` comes next, and before anything is executed: it decides which names
     * resolve, so a global that mentions `cout` must already see it. File-scope
     * declarations are not executed as statements, which is why this is here rather
     * than only in the statement path.
     */
    for (const declaration of this.unit.declarations) {
      if (declaration.kind === 'using') this.applyUsing(declaration);
    }

    for (const declaration of this.unit.declarations) {
      if (declaration.kind === 'function') this.registerFunction(declaration);
    }

    for (const declaration of this.unit.declarations) {
      if (declaration.kind === 'variable') this.declareVariable(declaration, 'global', 'global');
    }

    // Last, because it adds the bare spelling of names that now exist.
    this.applyNamespaceImports();
  }

  private prepareTypes(declarations: readonly Declaration[]): void {
    for (const declaration of declarations) {
      if (declaration.kind === 'struct' && declaration.isDefinition) {
        /*
         * A class template is registered as a template, not as a type: nothing has a
         * layout until `Box<int>` asks for one. Its methods are not registered either -
         * they belong to each instantiation, which is not supported yet.
         */
        if (declaration.templateParams && declaration.tag) {
          /*
           * Methods of a class template belong to each instantiation, which is not
           * implemented: saying so once is better than an object that silently lacks the
           * method its class declares.
           */
          if ((declaration.methods ?? []).some((method) => method.body)) {
            this.diagnostics.push(
              makeDiagnostic(
                'warning',
                `methods of the class template '${declaration.tag}' are not supported by the fast engine; Run (F5) uses clang-wasm`,
                declaration.start.file,
                declaration.start,
                declaration.end,
              ),
            );
          }

          this.resolver.registerClassTemplate(
            declaration.tag,
            declaration.templateParams,
            declaration.members,
          );
          continue;
        }

        this.resolver.registerStruct(declaration.tag, declaration.members, declaration.isUnion);
        this.registerMethods(declaration);
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

  /**
   * @brief Generates a canonical parameter type signature string for a function declaration.
   * @details Encodes qualifiers, pointers, references, and parameter type names to identify overloads.
   * @param declaration The function declaration node.
   * @return A comma-separated parameter signature string.
   */
  private functionSignature(declaration: FunctionDeclNode): string {
    return declaration.params
      .map((param) => {
        const ref = param.type.reference ? '&' : '';
        const ptr = param.type.pointee ? '*' : '';
        const constQual = param.type.qualifiers?.includes('const') ? 'const ' : '';
        return `${constQual}${param.type.name}${ptr}${ref}`;
      })
      .join(',');
  }

  /**
   * @brief Registers a function declaration or definition.
   * @details If a function with the same name and parameter signature exists, a definition
   * updates the earlier prototype. If the signature is distinct, it is registered as an overload.
   * @param declaration The function AST node to register.
   */
  private registerFunction(declaration: FunctionDeclNode): void {
    const list = this.functionOverloads.get(declaration.name) ?? [];
    const signature = this.functionSignature(declaration);
    const existingIndex = list.findIndex((item) => this.functionSignature(item) === signature);

    if (existingIndex >= 0) {
      if (declaration.body || !list[existingIndex]?.body) {
        list[existingIndex] = declaration;
      }
    } else {
      list.push(declaration);
    }
    this.functionOverloads.set(declaration.name, list);

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
    /*
     * A local object with a destructor is destroyed on the way out, most recent first -
     * which is what makes a destructor that prints, or that releases something, behave
     * the way the program says it should.
     */
    const depth = this.scopes.length;
    for (let index = this.pendingDestruction.length - 1; index >= 0; index -= 1) {
      const entry = this.pendingDestruction[index];
      if (!entry || entry.depth !== depth) continue;
      this.pendingDestruction.splice(index, 1);

      const destructor = this.destructors.get(entry.tag);
      if (destructor) this.callFunction(destructor, [], entry.address, entry.type);
    }

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

    /*
     * A class with a constructor: the storage is zeroed and then the constructor runs, so
     * `Counter counter;` and `Counter counter{5};` build the object the class describes.
     * A class with a destructor has the object recorded, to be destroyed at scope exit.
     *
     * A class with *neither* keeps the ordinary path below, where members start
     * indeterminate and reading one is reported - as C and C++ both have it.
     */
    const classTag = bareTagName(type.name);
    const constructorSet = this.constructors.get(classTag);
    const destructor = this.destructors.get(classTag);

    if (constructorSet || destructor) {
      address = this.allocateFor(type);
      this.memory.fill(address, 0, Math.max(type.size, 1));

      // `Counter counter{5};` passes arguments; `Counter counter;` passes none.
      const initializer = declaration.initializer;
      const argumentExpressions = initializer?.kind === 'init-list' ? initializer.items : [];
      const constructor = constructorSet?.get(argumentExpressions.length);

      if (constructorSet && !constructor) {
        throw new RuntimeFault(
          `'${classTag}' has no constructor taking ${argumentExpressions.length} argument(s)`,
          declaration.start,
        );
      }

      if (constructor) {
        this.callFunction(
          constructor,
          this.callArguments(argumentExpressions, constructor),
          address,
          type,
        );
      }

      const built: Binding = {
        name: declaration.name,
        type,
        address,
        storage,
        scopeName,
        declaredAt: declaration.start,
      };
      this.bind(built);

      /*
       * No constructor but a destructor: the object is still an aggregate, so an
       * initializer fills it the ordinary way - `Noisy outer{"outer"};` must set the
       * member, destructor or not.
       */
      if (!constructor && initializer) this.initialize(built, initializer);

      // Only a local object is destroyed by the engine; a global lives to the end.
      if (destructor && storage === 'local') {
        this.pendingDestruction.push({ depth: this.scopes.length, address, type, tag: classTag });
      }
      return;
    }

    /*
     * `int& total = sum;` and `const int& limit = other;` bind the initializer itself
     * rather than copying it: the slot holds an address and every use reads through.
     * `total += 1` then changes `sum`, as a native compiler does.
     */
    if (declaration.type.reference) {
      const referent = type.pointee ?? intType();
      const initializer = declaration.initializer;
      const bound = initializer ? this.lvalue(initializer) : null;

      if (bound) {
        address = this.allocateFor(type);
        this.memory.writeUint64(address, bound.address);
      } else if (initializer && this.isConstReference(declaration.type)) {
        // A const reference may bind a temporary, whose storage lives as long as the
        // reference needs it.
        address = this.allocateFor(type);
        const temporary = this.allocateFor(referent);
        this.store(referent, temporary, this.valueForType(referent, this.evaluate(initializer)));
        this.memory.writeUint64(address, temporary);
      } else {
        this.diagnostics.push(
          makeDiagnostic(
            'error',
            `reference '${declaration.name}' must be initialised with something that exists`,
            declaration.start.file,
            declaration.start,
            declaration.end,
          ),
        );
        const nil = this.allocateFor(type);
        this.memory.writeUint64(nil, 0);
        this.bind({
          name: declaration.name,
          type,
          address: nil,
          storage,
          scopeName,
          declaredAt: declaration.start,
          reference: true,
          readonly: this.isConstReference(declaration.type),
        });
        return;
      }

      this.bind({
        name: declaration.name,
        type,
        address,
        storage,
        scopeName,
        declaredAt: declaration.start,
        reference: true,
        readonly: this.isConstReference(declaration.type),
      });
      return;
    }

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
      } else if (declaration.initializer && declaration.initializer.kind === 'init-list') {
        const count = Math.max(declaration.initializer.items.length, 1);
        address = this.allocateFor({ ...type, size: count * 8 });
        this.memory.fill(address, 0, count * 8);
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
    } else if (containerKindOf(type) !== null) {
      this.uninitialized.delete(address);
      this.createContainer(type, address, []);
      this.record(binding, declaration.start);
    } else if (isStringType(type) || isStreamBuffer(type)) {
      this.uninitialized.delete(address);
      this.createString(address, '');
      this.record(binding, declaration.start);
    }

    if (declaration.structuredBindings) {
      const bindingType = binding.type;
      declaration.structuredBindings.forEach((subName, i) => {
        if (bindingType.members && bindingType.members[i]) {
          const member = bindingType.members[i];
          const subBinding: Binding = {
            name: subName,
            type: member.type,
            address: address + member.offset,
            storage: binding.storage,
            scopeName,
            declaredAt: declaration.start,
          };
          this.bind(subBinding);
          this.record(subBinding, declaration.start);
        } else if (bindingType.kind === 'array' && bindingType.element) {
          const stride = Math.max(bindingType.element.size, 1);
          const subBinding: Binding = {
            name: subName,
            type: bindingType.element,
            address: address + i * stride,
            storage: binding.storage,
            scopeName,
            declaredAt: declaration.start,
          };
          this.bind(subBinding);
          this.record(subBinding, declaration.start);
        }
      });
    }
  }

  private initialize(binding: Binding, initializer: Expression): void {
    // C++ containers have their own construction rules.
    if (containerKindOf(binding.type) !== null) {
      if (initializer.kind === 'init-list') {
        this.createContainer(binding.type, binding.address, initializer.items);
      } else {
        const source = this.evaluate(initializer);
        if (isVectorType(source.type) && source.kind === 'aggregate') {
          this.copyVector(source.address, source.type, binding.address, binding.type);
        } else {
          this.createContainer(binding.type, binding.address, []);
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

    if (isBitsetType(binding.type)) {
      let val = 0;
      if (initializer.kind === 'init-list') {
        const first = initializer.items[0];
        if (first) val = toNumber(this.evaluate(first));
      } else {
        val = toNumber(this.evaluate(initializer));
      }
      this.memory.writeUint32(binding.address, val >>> 0);
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

    const evaluated = this.evaluate(initializer);
    // A declaration with `auto` learns its type from the value it is given, the
    // same way a later assignment does.
    if (binding.type.kind === 'unknown' && evaluated.kind !== 'uninit' && evaluated.kind !== 'void') {
      binding.type = evaluated.type;
    }

    const value = this.valueForType(binding.type, evaluated);
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
        this.store(member.type, memberAddress, this.valueForType(member.type, this.evaluate(item)));
      });
      return;
    }

    const first = items[0];
    if (first) this.store(type, address, convertTo(type, this.evaluate(first)));
  }

  // ------------------------------------------------------------ statements

  private executeStatement(statement: Statement): void {
    this.tick();
    // Where execution is, for anything that has to report a position without one
    // of its own (a fault from deep inside the memory layer, a safety event).
    this.currentLine = statement.start.line;
    // Remember which lines each active loop iteration touched, so the pane can
    // find the loop a caret line belongs to.
    this.trackIterationLine(statement.start.line);

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
        // Each loop counts its own iterations from 1 (reset per execution, so a
        // recursive call does not continue the caller's numbering).
        this.iterationCounters.set(statement.start.offset, 0);
        while (toBoolean(this.evaluate(statement.condition))) {
          this.tick();
          const lines = this.beginIteration();
          let breaking = false;
          try {
            this.executeStatement(statement.body);
          } catch (flow) {
            if (flow instanceof ControlFlow) {
              if (flow.flow === 'break') breaking = true;
              else if (flow.flow !== 'continue') {
                this.abortIteration();
                throw flow;
              }
            } else {
              this.abortIteration();
              throw flow;
            }
          }
          if (breaking) {
            this.abortIteration();
            break;
          }
          this.endIteration(statement, lines);
        }
        return;
      case 'do-while':
        this.iterationCounters.set(statement.start.offset, 0);
        for (;;) {
          this.tick();
          const lines = this.beginIteration();
          let breaking = false;
          try {
            this.executeStatement(statement.body);
          } catch (flow) {
            if (flow instanceof ControlFlow) {
              if (flow.flow === 'break') breaking = true;
              else if (flow.flow !== 'continue') {
                this.abortIteration();
                throw flow;
              }
            } else {
              this.abortIteration();
              throw flow;
            }
          }
          if (breaking) {
            this.abortIteration();
            break;
          }
          this.endIteration(statement, lines);
          if (!toBoolean(this.evaluate(statement.condition))) break;
        }
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
      // Declarations have their own path, so execution position is tracked here as
      // well as in `executeStatement`.
      this.currentLine = item.start.line;
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

      this.iterationCounters.set(statement.start.offset, 0);
      for (;;) {
        this.tick();
        if (statement.condition && !toBoolean(this.evaluate(statement.condition))) break;

        const lines = this.beginIteration();
        let breaking = false;
        try {
          this.executeStatement(statement.body);
        } catch (flow) {
          if (flow instanceof ControlFlow) {
            if (flow.flow === 'break') breaking = true;
            else if (flow.flow !== 'continue') {
              this.abortIteration();
              throw flow;
            }
          } else {
            this.abortIteration();
            throw flow;
          }
        }
        if (breaking) {
          this.abortIteration();
          break;
        }

        if (statement.increment) this.evaluate(statement.increment);
        // Recorded after the increment: the row shows what the pass left behind.
        this.endIteration(statement, lines);
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
      case 'using':
        this.applyUsing(declaration);
        /*
         * A `using namespace X;` inside a function is applied while that function runs,
         * by which time the file-scope pass has already been and gone - so the aliases
         * are added here too. The pass skips names that already exist, so repeating it
         * costs nothing.
         */
        this.applyNamespaceImports();
        return;
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

  /**
   * `using namespace std;` and `using std::cout;`.
   *
   * They decide which bare names resolve. The engine already resolves the container
   * *types* unqualified (`vector<int>`), but streams and manipulators are global
   * objects, so `cout` has to be brought into scope the way C++ does it - otherwise a
   * program that compiles with clang fails here, which is the wrong way round.
   */
  private applyUsing(declaration: Extract<Declaration, { kind: 'using' }>): void {
    for (const name of declaration.names) {
      if (declaration.isNamespace) {
        if (name === 'std') this.stdNamespaceImported = true;
        else this.importedNamespaces.add(name);
        continue;
      }
      // A qualified name brings in that one name; a bare one is already visible.
      const bare = name.replace(/^.*::/, '');
      this.importedNames.add(bare);
      if (name.includes('::')) this.importedFrom.add(`${name} -> ${bare}`);
    }
  }

  /**
   * `using namespace outer::inner;` makes that namespace's names visible unqualified.
   *
   * Runs after the functions and globals exist, because it works by adding the bare
   * name alongside the qualified one - the same object, so a write through either
   * spelling reaches the same memory.
   */
  private applyNamespaceImports(): void {
    if (this.importedNamespaces.size === 0) return;

    for (const namespace of this.importedNamespaces) {
      const prefix = `${namespace}::`;

      for (const [name, declaration] of [...this.definitions]) {
        if (!name.startsWith(prefix)) continue;
        const bare = name.slice(prefix.length);
        if (this.definitions.has(bare)) continue;
        this.definitions.set(bare, { ...declaration, name: bare });
        this.functions.set(bare, { ...declaration, name: bare });
        if (!this.functionTable.includes(bare)) this.functionTable.push(bare);
      }

      for (const [name, overloads] of [...this.functionOverloads]) {
        if (!name.startsWith(prefix)) continue;
        const bare = name.slice(prefix.length);
        const existing = this.functionOverloads.get(bare) ?? [];
        for (const decl of overloads) {
          const sig = this.functionSignature(decl);
          if (!existing.some((item) => this.functionSignature(item) === sig)) {
            existing.push({ ...decl, name: bare });
          }
        }
        this.functionOverloads.set(bare, existing);
      }

      for (const binding of [...this.allBindings]) {
        if (!binding.name.startsWith(prefix)) continue;
        const bare = binding.name.slice(prefix.length);
        if (this.lookup(bare)) continue;
        // The same binding under its bare name, so a write through either spelling
        // reaches the same memory. Globals live in their own map, not in a scope.
        if (this.globals.has(binding.name)) {
          this.globals.set(bare, { ...binding, name: bare });
          continue;
        }
        const scope = this.scopes[this.scopes.length - 1];
        scope?.bindings.set(bare, { ...binding, name: bare });
      }
    }
  }

  /** Whether a bare standard name is visible: `cout`, `endl`, ... */
  private hasBareName(name: string): boolean {
    return this.stdNamespaceImported || this.importedNames.has(name);
  }

  // ----------------------------------------------------------- expressions

  private evaluate(expression: Expression): Value {
    this.tick();

    switch (expression.kind) {
      case 'literal':
        return this.literalValue(expression);
      case 'lambda':
        return this.makeClosure(expression);
      case 'new':
        return this.evaluateNew(expression);
      case 'delete':
        return this.evaluateDelete(expression);
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
      case 'init-list': {
        let result: Value = voidValue();
        for (const item of expression.items) {
          result = this.evaluate(item);
        }
        return result;
      }
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
    let body = text.replace(/[uUlL]+$/, '');
    let value = 0;

    if (/^0[xX]/.test(body)) value = Number.parseInt(body.slice(2), 16);
    else if (/^0[bB]/.test(body)) value = Number.parseInt(body.slice(2), 2);
    else if (body.length > 1 && body.startsWith('0')) value = Number.parseInt(body.slice(1), 8);
    else value = Number.parseInt(body, 10);

    if (Number.isNaN(value)) value = 0;

    /*
     * The type follows the value, as it does in C++: a decimal literal with no suffix
     * is an `int` if it fits, otherwise a `long`. Typing them all as `int` truncated
     * them - `9000000000` read back as 410065408, which is the value modulo 2^32, and a
     * wrong number that looks like a number is the worst thing this engine can show.
     */
    const fitsInt = value >= -2147483648 && value <= 2147483647;
    const wide = /l/i.test(text) || !fitsInt;

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

    /*
     * The bare spellings, once `using namespace std;` or `using std::cout;` has said
     * they are in scope. Deliberately not accepted without that: `cout << x` on its own
     * does not compile with clang, and the fast engine must not teach otherwise.
     */
    if (
      (name === 'cout' || name === 'cerr' || name === 'endl' || name === 'cin') &&
      this.hasBareName(name)
    ) {
      if (name === 'cerr') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream:cerr' } };
      if (name === 'endl') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::endl' } };
      if (name === 'cin') return { kind: 'void', type: { ...VOID_TYPE, name: 'std::istream' } };
      return { kind: 'void', type: { ...VOID_TYPE, name: 'std::ostream' } };
    }

    if (name === 'NULL' || name === 'nullptr') return pointerValue(VOID_TYPE, 0);

    const binding = this.lookup(name);
    if (binding) {
      // A reference reads through to its referent: `value` in `void bump(int& value)`
      // is the caller's int, not an address.
      if (binding.reference) {
        const target = this.memory.readUint64(binding.address);
        return this.load(binding.type.pointee ?? binding.type, target, binding);
      }
      return this.load(binding.type, binding.address, binding);
    }

    // A bare data member inside a method reads through `this`.
    const member = this.implicitThisMember(name);
    if (member) return this.load(member.type, member.address);

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
      const target = this.streamTargetOf(expression.left);
      if (target && operator === '<<') {
        // Evaluate the left link FIRST: in `cout << a << b` the left side carries
        // the earlier insertions, so skipping it would silently drop them.
        this.evaluate(expression.left);
        const right = this.evaluate(expression.right);
        const streamValue =
          target.kind === 'stderr'
            ? { kind: 'void' as const, type: { ...VOID_TYPE, name: 'std::ostream:cerr' } }
            : { kind: 'void' as const, type: { ...VOID_TYPE, name: 'std::ostream' } };

        /*
         * A class that defines its own `operator<<` decides what it looks like when
         * printed: `std::cout << point` calls `operator<<(std::ostream&, const Point&)`.
         */
        const userOperator = this.definitions.get('operator<<');
        if (userOperator && this.isUserStreamOperand(right)) {
          if (target.kind === 'buffer') {
            // The buffer's identity cannot travel inside a stream value, so writing a
            // custom type into one is refused rather than sent to the wrong place.
            throw new RuntimeFault(
              'writing a custom type into a stringstream is not supported; use std::cout',
              expression.start,
            );
          }
          this.callFunction(userOperator, [streamValue, right]);
          return streamValue;
        }

        const text = this.streamText(right);
        if (target.kind === 'buffer') {
          // `out << "n=" << 12` builds the text in the stream's own buffer.
          this.stringAppend(target.binding.address, text);
        } else {
          this.appendOutput(text, target.kind === 'stderr');
        }
        return streamValue;
      }
    }

    const leftRaw = this.evaluate(expression.left);
    const rightRaw = this.evaluate(expression.right);
    const left = this.decay(leftRaw);
    const right = this.decay(rightRaw);

    /*
     * A user-defined operator, declared as the free function C++ allows:
     * `Number operator+(Number a, Number b)`. It is consulted before the built-in
     * arithmetic, because a class that defines `+` means it - and the engine must not
     * quietly add the two objects' bytes instead.
     */
    const overloaded = this.definitions.get(`operator${operator}`);
    if (
      overloaded &&
      (leftRaw.kind === 'aggregate' || left.kind === 'aggregate' ||
        rightRaw.kind === 'aggregate' || right.kind === 'aggregate')
    ) {
      return this.callFunction(
        overloaded,
        this.callArguments([expression.left, expression.right], overloaded),
      );
    }

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
            const elementSize = Math.max(
              // Either side can be the one carrying the pointee: `end() - begin()`
              // and `begin() - end()` both have to divide by the element size, and
              // an index computed as a byte difference is simply wrong.
              left.type.pointee?.size ?? right.type.pointee?.size ?? 1,
              1,
            );
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
        // `valueForType` rather than `convertTo`: a `std::string` target must be
        // built from the text, and `convertTo` would decay a char array into a
        // pointer read out of its own bytes.
        value = this.valueForType(target.type, raw);
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

  /**
   * @brief Scores conversion rank between an argument expression and parameter type according to C++ rules.
   * @details Ranks:
   * 0: Exact match or reference binding without conversion.
   * 1: Promotion (integral promotion e.g. char/bool/short -> int, or float -> double).
   * 2: Standard conversion (numeric conversions, pointer conversions, array-to-pointer decay).
   * 3: User conversion (e.g. const char* / string literal to std::string).
   * -1: Incompatible.
   * @param arg The argument expression AST node.
   * @param argType The deduced type of the argument.
   * @param paramRef The AST type reference of the parameter.
   * @param paramType The resolved CType of the parameter.
   * @return Numeric rank (0..3) or -1 if incompatible.
   */
  private matchConversionRank(
    arg: Expression,
    argType: CType,
    paramRef: TypeRef,
    paramType: CType,
  ): number {
    const isParamRef = Boolean(paramRef.reference);
    const targetType = isParamRef && paramType.pointee ? paramType.pointee : paramType;

    // Check for exact match
    if (
      argType.kind === targetType.kind &&
      (argType.name === targetType.name ||
        (isIntegerType(argType) &&
          isIntegerType(targetType) &&
          argType.size === targetType.size &&
          argType.signed === targetType.signed))
    ) {
      if (isParamRef && !this.isConstReference(paramRef)) {
        const bound = this.lvalue(arg);
        if (!bound) return -1;
      }
      return 0;
    }

    // Array-to-pointer decay for exact element types
    if (
      argType.kind === 'array' &&
      targetType.kind === 'pointer' &&
      targetType.pointee &&
      argType.element &&
      (targetType.pointee.name === argType.element.name || targetType.pointee.kind === argType.element.kind)
    ) {
      return 0;
    }

    // std::string compatibility
    if (isStringType(targetType)) {
      if (isStringType(argType)) return 0;
      if (arg.kind === 'literal' && arg.literal === 'string') return 3;
      if (argType.kind === 'array' && argType.element?.kind === 'char') return 3;
      if (argType.kind === 'pointer' && argType.pointee?.kind === 'char') return 3;
    }

    // Reference binding constraints
    if (isParamRef) {
      if (!this.isConstReference(paramRef)) {
        const bound = this.lvalue(arg);
        if (!bound) return -1;
        if (argType.name !== targetType.name) return -1;
        return 0;
      }
    }

    // Integral promotions: char / bool / short -> int (or unsigned int)
    if (
      (argType.kind === 'char' || argType.kind === 'bool' || argType.name.includes('short')) &&
      targetType.kind === 'int' &&
      targetType.size >= 4
    ) {
      return 1;
    }

    // Floating-point promotion: float -> double
    if (argType.kind === 'float' && targetType.kind === 'double') {
      return 1;
    }

    // Standard numeric conversions
    if (isNumericType(argType) && isNumericType(targetType)) {
      return 2;
    }

    // Pointer conversions
    if (targetType.kind === 'pointer') {
      if (arg.kind === 'literal' && arg.literal === 'number' && Number(arg.text) === 0) {
        return 2;
      }
      if (argType.kind === 'array' && targetType.pointee?.kind === 'void') {
        return 2;
      }
      if (argType.kind === 'pointer' && targetType.pointee?.kind === 'void') {
        return 2;
      }
    }

    return -1;
  }

  /**
   * @brief Selects the best matching function overload for a set of call arguments.
   * @details Evaluates candidates by viability (arity and parameter constraints), ranks conversions,
   * and selects a strictly best candidate. Throws RuntimeFault on ambiguity or no match.
   * @param candidates Viable function declarations sharing a name.
   * @param args The call argument expressions.
   * @param callSite Source position of the call for error reporting.
   * @return The best matching FunctionDeclNode.
   */
  private resolveOverload(
    candidates: readonly FunctionDeclNode[],
    args: readonly Expression[],
    callSite: SourcePos,
  ): FunctionDeclNode {
    if (candidates.length === 1 && candidates[0]) {
      return candidates[0];
    }

    const viable: Array<{ candidate: FunctionDeclNode; ranks: number[] }> = [];

    for (const candidate of candidates) {
      const minArgs = candidate.params.filter((param) => !param.defaultValue).length;
      const maxArgs = candidate.variadic ? Infinity : candidate.params.length;
      if (args.length < minArgs || args.length > maxArgs) {
        continue;
      }

      const ranks: number[] = [];
      let isViable = true;

      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const param = candidate.params[i];
        if (!param) {
          if (candidate.variadic) {
            ranks.push(4);
            continue;
          }
          isViable = false;
          break;
        }

        const paramType = this.resolver.resolve(param.type);
        const argType = this.typeOf(arg);
        const rank = this.matchConversionRank(arg, argType, param.type, paramType);
        if (rank === -1) {
          isViable = false;
          break;
        }
        ranks.push(rank);
      }

      if (isViable) {
        viable.push({ candidate, ranks });
      }
    }

    if (viable.length === 0) {
      const name = candidates[0]?.name ?? 'function';
      throw new RuntimeFault(`no matching function for call to '${name}'`, callSite);
    }

    if (viable.length === 1) {
      return viable[0]!.candidate;
    }

    const isBetter = (a: { ranks: number[] }, b: { ranks: number[] }): boolean => {
      let atLeastOneBetter = false;
      const count = Math.min(a.ranks.length, b.ranks.length);
      for (let k = 0; k < count; k++) {
        if (a.ranks[k]! > b.ranks[k]!) return false;
        if (a.ranks[k]! < b.ranks[k]!) atLeastOneBetter = true;
      }
      return atLeastOneBetter;
    };

    const winner = viable.find((cand) =>
      viable.every((other) => other === cand || isBetter(cand, other)),
    );

    if (!winner) {
      const name = candidates[0]?.name ?? 'function';
      throw new RuntimeFault(`call of overloaded '${name}' is ambiguous`, callSite);
    }

    return winner.candidate;
  }

  /**
   * `counter.add(3)` - a method on a class or struct.
   *
   * The object is passed as `this` rather than copied, so a method that changes a
   * member changes the object it was called on. Access is checked here: a private
   * method called from outside its class is an error, as a native compiler reports.
   */
  private resolveMethodCall(
    callee: Extract<Expression, { kind: 'member' }>,
    args: readonly Expression[],
    position: SourcePos,
  ): { declaration: FunctionDeclNode; thisAddress: number; thisType: CType } | null {
    let baseAddress: number;
    let baseType: CType;

    if (callee.arrow) {
      const pointer = this.decay(this.evaluate(callee.object));
      const address = toPointerAddress(pointer);
      if (address === null || address === 0) {
        throw new RuntimeFault('null pointer dereference', callee.start);
      }
      baseAddress = address;
      baseType = pointer.type.pointee ?? UNKNOWN_TYPE;
    } else {
      const aggregate = this.evaluate(callee.object);
      if (aggregate.kind !== 'aggregate') return null;
      baseAddress = aggregate.address;
      baseType = aggregate.type;
    }

    const tag = bareTagName(baseType.name);
    if (tag.length === 0) return null;

    const qualified = `${tag}::${callee.property}`;
    const overloads = this.functionOverloads.get(qualified);
    const declaration =
      overloads && overloads.length > 0
        ? this.resolveOverload(overloads, args, position)
        : this.definitions.get(qualified);
    if (!declaration) return null;

    const access = this.methodAccess.get(qualified) ?? 'public';
    if (!this.mayTouch(access, tag)) {
      throw new RuntimeFault(
        `'${callee.property}' is ${access} in '${tag}'`,
        position,
      );
    }

    return { declaration, thisAddress: baseAddress, thisType: baseType };
  }

  /**
   * Whether the code being run is allowed to touch a member or method of `owner`.
   *
   * Inside `Counter::add`, the private members of `Counter` are fair game; anywhere
   * else they are not. Derived classes are not modelled, so `protected` is treated as
   * private - the stricter reading, which cannot quietly allow something.
   */
  private mayTouch(access: string | undefined, owner: string): boolean {
    if (access === undefined || access === 'public') return true;
    const current = this.callStack[this.callStack.length - 1]?.name ?? '';
    return current.startsWith(`${owner}::`);
  }

  /**
   * A member function becomes an ordinary function under its qualified name.
   *
   * `Counter::add` is then a definition like any other, which is what lets the call
   * path, the recursion budget and the watch pane treat it the same way. Its `this`
   * arrives as an extra argument rather than a parameter, because it is not written in
   * the parameter list.
   */
  private registerMethods(declaration: StructDeclNode): void {
    const tag = declaration.tag;
    if (!tag) return;

    for (const method of declaration.methods ?? []) {
      // Only a definition can be called; `int add(int);` inside the class with the body
      // outside is not supported yet, and is reported when it is called.
      if (!method.body) continue;

      const qualified = `${tag}::${method.name}`;
      this.methodAccess.set(
        qualified,
        method.access ?? (declaration.isClass ? 'private' : 'public'),
      );
      const declared: FunctionDeclNode = {
        kind: 'function',
        name: qualified,
        returnType: method.returnType,
        params: method.params,
        variadic: false,
        storage: [],
        body: method.body,
        start: method.start,
        end: method.end,
      };
      this.registerFunction(declared);

      if (method.isConstructor) {
        // Overloaded constructors are told apart by how many arguments they take, which
        // is as much as this engine needs to pick the right one.
        const byArity = this.constructors.get(tag) ?? new Map<number, FunctionDeclNode>();
        byArity.set(method.params.length, declared);
        this.constructors.set(tag, byArity);
      }
      if (method.isDestructor) this.destructors.set(tag, declared);
    }
  }

  /**
   * A data member named without `this->` inside a method.
   *
   * `void add(int amount) { value = value + amount; }` is the ordinary way to write it,
   * and the member is only reachable through the object the method was called on.
   */
  private implicitThisMember(name: string): { address: number; type: CType } | null {
    const self = this.lookup('this');
    if (!self) return null;

    const owner = self.type.pointee;
    const member = owner?.members?.find((item) => item.name === name);
    if (!owner || !member) return null;

    this.checkMemberAccess(member, bareTagName(owner.name), name, this.unit.start);
    return { address: this.memory.readUint64(self.address) + member.offset, type: member.type };
  }

  /** The same check for a data member, from the layout the value carries. */
  private checkMemberAccess(
    member: CTypeMember,
    owner: string,
    name: string,
    position: SourcePos,
  ): void {
    if (this.mayTouch(member.access, owner)) return;
    throw new RuntimeFault(`'${name}' is ${member.access} in '${owner}'`, position);
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

    // A private member is private outside its own class, exactly as clang has it.
    this.checkMemberAccess(member, bareTagName(baseType.name), expression.property, expression.start);

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

    // A map is indexed by key, not by position: `m[k]` finds the entry or inserts
    // a zero value for it, which is what makes `m[k] = v` and `m[k]++` work.
    if (base.kind === 'aggregate' && containerKindOf(base.type) === 'map') {
      const element = this.vectorElement(base.address, base.type);
      const parts = pairParts(element);
      const valueOffset = element.members?.[1]?.offset ?? 0;
      if (!parts) throw new RuntimeFault('std::map without a pair element type', expression.start);

      const key = this.valueForType(parts.key, this.evaluate(expression.index));
      const at = this.sequenceFindKey(base.address, base.type, key);
      if (at.found) {
        const entry = this.sequenceElement(base.address, base.type, at.index);
        if (entry.kind !== 'aggregate') {
          throw new RuntimeFault('malformed std::map entry', expression.start);
        }
        return { address: entry.address + valueOffset, type: parts.value };
      }

      const pair = this.createPair(
        element,
        key,
        this.valueForType(parts.value, intValue(intType(), 0)),
      );
      this.sequenceInsertAt(base.address, base.type, at.index, pair);

      // The entry has been copied into the sequence, so the address handed back
      // must be the one *in* the sequence - not the temporary pair's.
      const inserted = this.sequenceElement(base.address, base.type, at.index);
      if (inserted.kind !== 'aggregate') {
        throw new RuntimeFault('malformed std::map entry', expression.start);
      }
      return { address: inserted.address + valueOffset, type: parts.value };
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

      const overloads = this.functionOverloads.get(name);
      const withBody = overloads?.filter((fn) => fn.body !== undefined) ?? [];

      if (withBody.length > 0) {
        const resolved = this.resolveOverload(withBody, expression.args, expression.start);
        return this.callFunction(resolved, this.callArguments(expression.args, resolved));
      }

      const definition = this.definitions.get(name);
      if (definition) return this.callFunction(definition, this.callArguments(expression.args, definition));

      if (INTERPRETER_BUILTINS.has(name) || SIMPLE_BUILTINS.has(name)) {
        return this.callBuiltin(name, expression.args, expression.start);
      }

      // C++ helpers the engine implements itself: std::sort, std::min, std::swap…
      const helper = this.callCppHelper(name, expression.args, expression.start);
      if (helper !== undefined) return helper;

      // C++ struct constructor call: Person{"Alice", 30} or IsEven{}
      const resolvedType = this.resolver.resolveByName(name);
      if (resolvedType.kind === 'struct' || resolvedType.kind === 'union') {
        const address = this.allocateFor(resolvedType);
        const constructor = this.constructors.get(name)?.get(expression.args.length);
        if (constructor) {
          this.callFunction(constructor, this.callArguments(expression.args, constructor), address, resolvedType);
        } else if (expression.args.length > 0) {
          this.initializeAggregate(resolvedType, address, expression.args);
        }
        return { kind: 'aggregate', type: resolvedType, address };
      }

      // A prototype with no body: report it as such rather than as "unknown".
      const prototype = overloads?.[0] ?? this.functions.get(name);
      if (prototype) {
        throw new RuntimeFault(
          `function '${name}' has no body (only a prototype was declared)`,
          expression.start,
        );
      }
      // Otherwise fall through: the name may be a variable holding a function
      // pointer, which the generic path below resolves.
    }

    /*
     * A method of the same class, called without `this->`: inside `Counter::add`,
     * `reset()` means `this->reset()`.
     */
    if (callee.kind === 'identifier') {
      const current = this.callStack[this.callStack.length - 1]?.name ?? '';
      const owner = current.includes('::') ? current.slice(0, current.lastIndexOf('::')) : '';
      const qualified = `${owner}::${callee.name}`;
      const overloads = owner.length > 0 ? this.functionOverloads.get(qualified) : undefined;
      const sameClass =
        overloads && overloads.length > 0
          ? this.resolveOverload(overloads, expression.args, expression.start)
          : owner.length > 0
            ? this.definitions.get(qualified)
            : undefined;
      if (sameClass) {
        if (!sameClass.body) {
          throw new RuntimeFault(
            `method '${callee.name}' has no body (only a prototype was declared)`,
            expression.start,
          );
        }
        const self = this.lookup('this');
        const target = self ? this.memory.readUint64(self.address) : undefined;
        return this.callFunction(
          sameClass,
          this.callArguments(expression.args, sameClass),
          target,
          self?.type.pointee,
        );
      }
    }

    // Container member calls: v.size(), v.push_back(x), s.substr(1, 2)…
    if (callee.kind === 'member') {
      // A method of a class or struct comes first: `counter.add(3)`.
      const method = this.resolveMethodCall(callee, expression.args, expression.start);
      if (method) {
        const args = this.callArguments(expression.args, method.declaration);
        return this.callFunction(method.declaration, args, method.thisAddress, method.thisType);
      }

      const container = this.callContainerMethod(callee, expression.args, expression.start);
      if (container !== undefined) return container;
    }

    // Calling through a function pointer.
    const value = this.evaluate(callee);
    const address = toPointerAddress(value);
    if (value.kind === 'pointer' && address !== null && address > 0) {
      // A lambda or a `std::function` holding one: the address is a closure.
      const closure = this.closures.get(address);
      if (closure) {
        return this.callClosure(
          closure,
          this.evaluateArguments(expression.args, closure.node.params.length),
        );
      }

      const name = this.functionTable[address];
      const target = name ? this.functions.get(name) : undefined;
      if (target) return this.callFunction(target, this.callArguments(expression.args, target));
    }

    // Calling an object that overrides operator()
    const functorTag = value.type.name ? bareTagName(value.type.name) : undefined;
    if (functorTag) {
      const opName = `${functorTag}::operator()`;
      const target = this.definitions.get(opName);
      if (target) {
        const thisAddr = value.kind === 'aggregate' || value.kind === 'pointer' ? value.address : undefined;
        return this.callFunction(target, this.callArguments(expression.args, target), thisAddr, value.type);
      }
    }

    throw new RuntimeFault('call of a value that is not a function', expression.start);
  }

  /**
   * Arguments for a closure, whose parameter list comes from the lambda itself.
   *
   * Separate from `callArguments` because a lambda has no `FunctionDeclNode` - and
   * because a lambda parameter is always by value unless the lambda says otherwise.
   */
  private evaluateArguments(
    args: readonly Expression[],
    arity: number,
  ): Value[] {
    const values: Value[] = [];
    for (let index = 0; index < Math.max(args.length, arity); index += 1) {
      const argument = args[index];
      if (!argument) {
        throw new RuntimeFault(`too few arguments for the lambda: expected ${arity}`, this.unit.start);
      }
      values.push(this.evaluateRaw(argument));
    }
    return values;
  }

  private callArguments(args: readonly Expression[], target: FunctionDeclNode): Value[] {
    const params = target.params;
    const values: Value[] = [];

    /*
     * Iterating the parameters rather than the arguments is what makes a default
     * argument work: a call that leaves one out gets the expression written in the
     * declaration, evaluated here at the call site as C++ does.
     */
    const count = Math.max(args.length, params.length);
    for (let index = 0; index < count; index += 1) {
      const argument = args[index];
      const param = params[index];

      if (!argument && param?.defaultValue) {
        const fallback = param.defaultValue;
        if (param.type.reference) {
          const referent = this.resolver.resolve(param.type).pointee ?? intType();
          if (!this.isConstReference(param.type)) {
            throw new RuntimeFault(
              'a non-const reference cannot bind a temporary value',
              fallback.start,
            );
          }
          const temporary = this.allocateFor(referent);
          this.store(referent, temporary, this.valueForType(referent, this.evaluateRaw(fallback)));
          values.push({
            kind: 'pointer',
            type: { ...pointerTo(referent), name: `const ${referent.name} &` },
            address: temporary,
          });
          continue;
        }
        const paramType = this.resolver.resolve(param.type);
        values.push(this.valueForType(paramType, this.evaluateRaw(fallback)));
        continue;
      }

      if (!argument) {
        if (params.length > args.length && index >= args.length) {
          // Fewer arguments than parameters, with no default to fill the gap: that is
          // a mistake in the call, and C++ refuses it too.
          throw new RuntimeFault(
            `too few arguments for '${target.name}': expected ${params.length}`,
            target.start,
          );
        }
        continue;
      }

      /*
       * A reference parameter is bound to the caller's object, not to a copy - so what
       * is passed is the argument's address. Passing its *value* is what made
       * `bump(x)` with x = 4 dereference address 4 and stop the program.
       */
      if (param?.type.reference) {
        const referent = this.resolver.resolve(param.type).pointee ?? intType();
        const bound = this.lvalue(argument);

        if (bound) {
          values.push({
            kind: 'pointer',
            type: { ...pointerTo(referent), name: `${referent.name} &` },
            address: bound.address,
          });
          continue;
        }

        // `const T&` may bind a temporary; a plain `T&` may not, and C++ says so.
        if (!this.isConstReference(param.type)) {
          throw new RuntimeFault(
            'a non-const reference cannot bind a temporary value',
            argument.start,
          );
        }

        const temporary = this.allocateFor(referent);
        this.store(referent, temporary, this.valueForType(referent, this.evaluateRaw(argument)));
        values.push({
          kind: 'pointer',
          type: { ...pointerTo(referent), name: `const ${referent.name} &` },
          address: temporary,
        });
        continue;
      }

      const raw = this.evaluateRaw(argument);
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

  /** `const T&` - the pointee carries the qualifier the parser recorded. */
  private isConstReference(type: { readonly pointee?: { readonly qualifiers: readonly string[] } }): boolean {
    return type.pointee?.qualifiers.includes('const') ?? false;
  }

  /** Evaluates without decaying arrays, so `sizeof`/`&` see the real thing. */
  private evaluateRaw(expression: Expression): Value {
    return this.evaluate(expression);
  }

  /**
   * Builds a closure: the code, plus what the capture list says to keep.
   *
   * A by-value capture is a copy taken now, so a later change to the original is not
   * seen - and a by-reference capture is the address, so it is. `[=]` and `[&]` capture
   * everything visible, which behaves the same for the reads a lambda can make.
   */
  private makeClosure(expression: LambdaExpr): Value {
    this.closureSeq += 1;
    const address = this.memory.alloc(8, 8);
    this.memory.writeInt64(address, this.closureSeq);

    const byValue = new Map<string, Value>();
    const byRef = new Map<string, number>();

    const capture = (name: string, byReference: boolean): void => {
      const binding = this.lookup(name);
      if (!binding || byValue.has(name) || byRef.has(name)) return;

      if (byReference) {
        byRef.set(name, binding.address);
        return;
      }

      const value = this.load(binding.type, binding.address, binding);
      /*
       * A by-value capture of an aggregate needs its own storage, or the "copy" and the
       * original are the same object: capturing a `std::string` and then reassigning the
       * original printed the new text, where C++ prints the text as it was.
       */
      if (value.kind === 'aggregate' && value.type.size > 0) {
        const copy = this.memory.alloc(Math.max(value.type.size, 1), 8);
        this.memory.copy(value.address, copy, Math.max(value.type.size, 1));
        byValue.set(name, { ...value, address: copy });
        return;
      }

      byValue.set(name, value);
    };

    if (expression.captureAll) {
      const byReference = expression.captureAll === 'reference';
      for (const scope of this.scopes) {
        for (const name of [...scope.bindings.keys()]) capture(name, byReference);
      }
    }
    for (const entry of expression.captures) capture(entry.name, entry.byRef);

    this.closures.set(address, { node: expression, byValue, byRef });

    return {
      kind: 'pointer',
      type: { kind: 'pointer', name: 'lambda', size: 8, signed: false, bits: 64, pointee: VOID_TYPE },
      address,
    };
  }

  /** Runs a closure: captures first, then the parameters, then the body. */
  private callClosure(
    closure: {
      readonly node: LambdaExpr;
      readonly byValue: Map<string, Value>;
      readonly byRef: Map<string, number>;
    },
    args: readonly Value[],
  ): Value {
    const node = closure.node;
    this.pushScope('lambda');
    this.callStack.push({ name: 'lambda', position: node.start });
    this.refreshStackSnapshot();

    try {
      for (const [name, value] of closure.byValue) {
        const address = this.allocateFor(value.type);
        this.store(value.type, address, value);
        this.bind({
          name,
          type: value.type,
          address,
          storage: 'local',
          scopeName: 'lambda',
          declaredAt: node.start,
        });
      }
      for (const [name, referent] of closure.byRef) {
        /*
         * The slot holds the referent's address, as a reference parameter's does - the
         * read path dereferences the slot, not the binding's own address.
         */
        const referentType = this.typeOfBindingAt(referent);
        const type: CType = {
          ...pointerTo(referentType),
          name: `${referentType.name} &`,
        };
        const slot = this.allocateFor(type);
        this.memory.writeUint64(slot, referent);
        this.bind({
          name,
          type,
          address: slot,
          storage: 'local',
          scopeName: 'lambda',
          declaredAt: node.start,
          reference: true,
        });
      }

      node.params.forEach((param, index) => {
        if (param.name === undefined) return;
        const type = this.resolver.resolve(param.type);
        const address = this.allocateFor(type);
        const argument = args[index] ?? intValue(intType(), 0);
        this.store(type, address, this.valueForType(type, argument));
        this.bind({
          name: param.name,
          type,
          address,
          storage: 'param',
          scopeName: 'lambda',
          declaredAt: param.start,
        });
      });

      try {
        this.executeStatement(node.body);
      } catch (flow) {
        if (flow instanceof ControlFlow && flow.flow === 'return') {
          return flow.value ?? voidValue();
        }
        throw flow;
      }
      return voidValue();
    } finally {
      this.callStack.pop();
      this.popScope();
    }
  }

  /**
   * `new T(42)`, `new T`, `new T[n]`.
   *
   * The allocator is the one `malloc` already uses; this is the C++ spelling, and a
   * program that fails on `new` fails on most real C++. An object of a class runs its
   * constructor here, which is what makes `new Counter()` a built object rather than
   * eight bytes.
   */
  private evaluateNew(expression: Extract<Expression, { kind: 'new' }>): Value {
    const type = this.resolver.resolve(expression.ofType);
    const size = Math.max(type.size, 1);
    const tag = bareTagName(type.name);

    if (expression.arrayLength) {
      const count = Math.max(Math.trunc(toNumber(this.evaluate(expression.arrayLength))), 0);
      const address = this.memory.alloc(Math.max(count * size, 1), alignOf(type));

      // `new Counter[3]` builds three objects, so their constructors run.
      const constructor = this.constructors.get(tag)?.get(0);
      if (constructor) {
        for (let index = 0; index < count; index += 1) {
          this.callFunction(constructor, [], address + index * size, type);
        }
      }
      return pointerValue(type, address);
    }

    const address = this.memory.alloc(size, alignOf(type));
    const constructors = this.constructors.get(tag);

    if (constructors) {
      const constructor = constructors.get(expression.args.length);
      if (!constructor) {
        throw new RuntimeFault(
          `'${tag}' has no constructor taking ${expression.args.length} argument(s)`,
          expression.start,
        );
      }
      this.callFunction(constructor, this.callArguments(expression.args, constructor), address, type);
    } else if (expression.args.length > 0) {
      // `new int(42)`: one value initialises the object, as C++ writes it.
      const first = expression.args[0] as Expression | undefined;
      if (first) this.store(type, address, this.valueForType(type, this.evaluateRaw(first)));
    }

    return pointerValue(type, address);
  }

  /** `delete p`, `delete[] p`. Deleting a null pointer does nothing, as C++ says. */
  private evaluateDelete(expression: Extract<Expression, { kind: 'delete' }>): Value {
    const pointer = this.decay(this.evaluate(expression.operand));
    const address = toPointerAddress(pointer);
    if (address === null || address === 0) return voidValue();

    const type = pointer.type.pointee;
    const destructor = type ? this.destructors.get(bareTagName(type.name)) : undefined;
    if (destructor && type) this.callFunction(destructor, [], address, type);

    try {
      this.memory.free(address);
      this.allocations.delete(address);
      this.userAllocations.delete(address);
      this.slotTypes.delete(address);
    } catch {
      throw new RuntimeFault('delete of a pointer that was not allocated with new', expression.start);
    }
    return voidValue();
  }

  /** The declared type of whatever lives at an address, for a by-reference capture. */
  private typeOfBindingAt(address: number): CType {
    for (const binding of this.allBindings) {
      if (binding.address === address) return binding.type;
    }
    return UNKNOWN_TYPE;
  }

  private callFunction(
    declaration: FunctionDeclNode,
    args: readonly Value[],
    thisAddress?: number,
    thisType?: CType,
  ): Value {
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
      /*
       * `this` is the object the method was called on, passed as an address rather than
       * a copy so `this->value = 3` changes the caller's object.
       */
      if (thisAddress !== undefined && thisType !== undefined) {
        const type = pointerTo(thisType);
        const address = this.allocateFor(type);
        this.memory.writeUint64(address, thisAddress);
        this.bind({
          name: 'this',
          type,
          address,
          storage: 'param',
          scopeName: declaration.name,
          declaredAt: body.start,
        });
      }

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
          // A reference parameter is the caller's object: mark the slot so every read
          // and write in the body goes through to it.
          ...(param.type.reference
            ? { reference: true, readonly: this.isConstReference(param.type) }
            : {}),
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
      alloc: (size) => {
        const address = this.builtinAlloc(size);
        /*
         * Tracked separately from `allocations`, because that map also holds the
         * interpreter's own buffers - string literals, vector storage, argv. Those
         * are not the program's allocations, and counting them made every program
         * look like it leaked.
         */
        this.userAllocations.set(address, Math.max(Math.trunc(size), 1));
        return address;
      },
      free: (address) => {
        this.userAllocations.delete(address);
        this.builtinFree(address);
      },
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
    // The slot is gone, so what was written through it must not describe whatever
    // is allocated there next.
    this.slotTypes.delete(address);
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

    /*
     * A lambda is an address too, which is what makes
     * `std::sort(v.begin(), v.end(), [](int a, int b) { return a > b; })` work: the
     * comparator arrives here and is a closure rather than a named function.
     */
    const closure = address !== null ? this.closures.get(address) : undefined;
    if (closure) return this.callClosure(closure, args);

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
    const code = this.memory.readInt32(address + VECTOR_ELEMENT_KIND_OFFSET);
    const size = this.memory.readInt32(address + VECTOR_ELEMENT_SIZE_OFFSET);
    return elementTypeFromCode(code, size);
  }

  private createVector(type: CType, address: number, items: readonly Expression[]): void {
    const declared = type.element;
    const element = declared && declared.kind !== 'unknown' ? declared : intType();
    const elementSize = Math.max(element.size, 1);
    const capacity = Math.max(items.length, 4);
    const data = this.builtinAlloc(capacity * elementSize);

    items.forEach((item, index) => {
      const slot = data + index * elementSize;
      if (item.kind === 'init-list') {
        if (isPairType(element)) {
          const firstExpr = item.items[0];
          const secondExpr = item.items[1];
          const firstMember = element.members?.[0];
          const secondMember = element.members?.[1];
          if (firstMember && firstExpr) {
            const k = this.valueForType(firstMember.type, this.evaluate(firstExpr));
            this.store(firstMember.type, slot + firstMember.offset, k);
          }
          if (secondMember && secondExpr) {
            const v = this.valueForType(secondMember.type, this.evaluate(secondExpr));
            this.store(secondMember.type, slot + secondMember.offset, v);
          }
          return;
        }
        if (element.kind === 'struct' || element.kind === 'union') {
          this.initializeAggregate(element, slot, item.items);
          return;
        }
        return;
      }
      // A `std::string` element is a string object, not the characters of the
      // literal: storing the bytes would later be read back as a data pointer,
      // which is exactly what made `vector<string>` unreadable.
      if (isStringType(element)) {
        this.createString(slot, this.stringTextOf(this.evaluate(item)));
        return;
      }
      const value = convertTo(element, this.evaluate(item));
      this.store(element, slot, value);
    });

    this.memory.writeUint64(address + VECTOR_DATA_OFFSET, data);
    this.memory.writeInt64(address + VECTOR_COUNT_OFFSET, items.length);
    this.memory.writeInt64(address + VECTOR_CAPACITY_OFFSET, capacity);
    this.memory.writeInt32(address + VECTOR_ELEMENT_KIND_OFFSET, elementKindCode(element));
    this.memory.writeInt32(address + VECTOR_ELEMENT_SIZE_OFFSET, elementSize);
  }

  /**
   * Builds any of the simulated containers.
   *
   * They all start as a vector, then take on the shape their contract requires:
   * a set is sorted and uniqued, a map is sorted by key, a priority_queue is a
   * heap. That is what lets the watch pane, range-based for and indexed access go
   * on working unchanged.
   */
  private createContainer(type: CType, address: number, items: readonly Expression[]): void {
    this.createVector(type, address, items);

    switch (containerKindOf(type)) {
      case 'set':
        this.sequenceSort(address, type, true);
        return;
      case 'map':
        this.sequenceSort(address, type, false);
        return;
      case 'priority-queue':
        this.heapifySequence(address, type);
        return;
      default:
        return;
    }
  }

  /**
   * Converts a value for storing as `type`.
   *
   * Two cases need care. A `std::string` needs a real string object built for it:
   * storing the bytes of a literal instead is the bug that made `vector<string>`
   * unreadable, and map keys hit exactly the same trap. And a not-yet-deduced
   * type (`auto`) must keep the value's own type - coercing a pointer to a number
   * there silently turns `end() - begin()` into a byte count.
   */
  private valueForType(type: CType, value: Value): Value {
    if (type.kind === 'unknown') return value;
    if (isStringType(type)) return this.makeString(this.stringTextOf(value));
    return convertTo(type, value);
  }

  /** Builds a `std::pair` value in memory, for `m.insert({k, v})` and friends. */
  private createPair(
    pairType: CType,
    key: Value,
    value: Value,
  ): Extract<Value, { kind: 'aggregate' }> {
    const address = this.builtinAlloc(Math.max(pairType.size, 1));
    const first = pairType.members?.[0];
    const second = pairType.members?.[1];
    if (first) this.store(first.type, address + first.offset, key);
    if (second) this.store(second.type, address + second.offset, value);
    return { kind: 'aggregate', type: pairType, address };
  }

  /** Ordering used by the associative containers and the heap. */
  private compareValues(left: Value, right: Value): number {
    if (
      left.kind === 'aggregate' &&
      isStringType(left.type) &&
      right.kind === 'aggregate' &&
      isStringType(right.type)
    ) {
      const a = this.stringText(left.address);
      const b = this.stringText(right.address);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    const a = toNumber(left);
    const b = toNumber(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Reads element `index` of a sequence container. */
  private sequenceElement(address: number, type: CType, index: number): Value {
    const element = this.vectorElement(address, type);
    const data = this.memory.readUint64(address);
    return this.load(element, data + index * Math.max(element.size, 1));
  }

  private sequenceSize(address: number): number {
    return this.memory.readInt64(address + VECTOR_COUNT_OFFSET);
  }

  /** Sorts in place (by key for a map, by value otherwise); `unique` for a set. */
  private sequenceSort(address: number, type: CType, unique: boolean): void {
    const element = this.vectorElement(address, type);
    const count = this.sequenceSize(address);
    if (count < 2) return;

    const items: Value[] = [];
    for (let index = 0; index < count; index += 1) items.push(this.sequenceElement(address, type, index));

    // A map's element is a pair: ordering by key is what `m[k]` relies on.
    const parts = pairParts(element);
    const keyOf = (value: Value): Value =>
      parts && value.kind === 'aggregate' ? this.load(parts.key, value.address) : value;

    items.sort((left, right) => this.compareValues(keyOf(left), keyOf(right)));

    const kept: Value[] = [];
    for (const item of items) {
      const previous = kept[kept.length - 1];
      if (unique && previous && this.compareValues(keyOf(previous), keyOf(item)) === 0) continue;
      if (
        !unique &&
        previous &&
        parts &&
        this.compareValues(keyOf(previous), keyOf(item)) === 0
      ) {
        // `m[k] = v` written twice keeps the last value; inserting the same key
        // again in C++ leaves the first. Keeping the first matches the standard.
        continue;
      }
      kept.push(item);
    }

    this.sequenceTruncate(address, 0);
    for (const item of kept) this.vectorPush(address, type, item);
  }

  /** Empties a sequence without freeing it: the control block keeps its buffer. */
  private sequenceTruncate(address: number, keep: number): void {
    this.memory.writeInt64(address + VECTOR_COUNT_OFFSET, Math.max(keep, 0));
  }

  /** Inserts at `index`, shifting the rest right. */
  private sequenceInsertAt(address: number, type: CType, index: number, value: Value): void {
    const element = this.vectorElement(address, type);
    const stride = Math.max(element.size, 1);
    const size = this.sequenceSize(address);

    this.vectorPush(address, type, value);
    const data = this.memory.readUint64(address);

    for (let position = size - 1; position >= index; position -= 1) {
      this.memory.copy(data + position * stride, data + (position + 1) * stride, stride);
    }
    this.store(element, data + index * stride, value);
  }

  /** Removes element `index`, shifting the rest left. */
  private sequenceRemoveAt(address: number, type: CType, index: number): void {
    const element = this.vectorElement(address, type);
    const stride = Math.max(element.size, 1);
    const size = this.sequenceSize(address);
    if (index < 0 || index >= size) return;

    const data = this.memory.readUint64(address);
    for (let position = index; position < size - 1; position += 1) {
      this.memory.copy(data + (position + 1) * stride, data + position * stride, stride);
    }
    this.memory.writeInt64(address + VECTOR_COUNT_OFFSET, size - 1);
  }

  /**
   * Where `key` belongs among the elements: the index of a match, or the index a
   * new key should be inserted at to keep the order.
   */
  private sequenceFindKey(
    address: number,
    type: CType,
    key: Value,
  ): { readonly index: number; readonly found: boolean } {
    const element = this.vectorElement(address, type);
    const parts = pairParts(element);
    const count = this.sequenceSize(address);

    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = this.sequenceElement(address, type, middle);
      const candidateKey = parts && candidate.kind === 'aggregate' ? this.load(parts.key, candidate.address) : candidate;
      const order = this.compareValues(candidateKey, key);
      if (order === 0) return { index: middle, found: true };
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return { index: low, found: false };
  }

  /** Restores the max-heap property over a sequence. */
  private heapifySequence(address: number, type: CType): void {
    const count = this.sequenceSize(address);
    for (let start = Math.floor(count / 2) - 1; start >= 0; start -= 1) {
      this.siftDown(address, type, start, count);
    }
  }

  private siftDown(address: number, type: CType, start: number, count: number): void {
    const element = this.vectorElement(address, type);
    const stride = Math.max(element.size, 1);
    const data = this.memory.readUint64(address);

    let root = start;
    for (;;) {
      const left = root * 2 + 1;
      if (left >= count) return;
      let largest = left;
      const right = left + 1;
      if (right < count && this.compareValues(
        this.load(element, data + right * stride),
        this.load(element, data + left * stride),
      ) > 0) {
        largest = right;
      }
      if (
        this.compareValues(
          this.load(element, data + largest * stride),
          this.load(element, data + root * stride),
        ) <= 0
      ) {
        return;
      }
      // Swapped through values, not through a scratch slot: writing past the live
      // elements would be outside the allocation.
      const parent = this.load(element, data + root * stride);
      const child = this.load(element, data + largest * stride);
      this.store(element, data + root * stride, child);
      this.store(element, data + largest * stride, parent);
      root = largest;
    }
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

    const slot = data + size * elementSize;
    if (isStringType(element)) {
      this.createString(slot, this.stringTextOf(argument));
    } else {
      this.store(element, slot, convertTo(element, argument));
    }
    this.memory.writeInt64(address + VECTOR_COUNT_OFFSET, size + 1);
  }

  /** The text a value carries, for building a `std::string` element. */
  private stringTextOf(value: Value): string {
    if (value.kind === 'aggregate' && isStringType(value.type)) {
      return this.stringText(value.address);
    }
    return this.readStringValue(value);
  }

  private createString(address: number, text: string): void {
    const data = this.builtinAlloc(Math.max(text.length + 1, 1));
    this.writeStringAt(data, text);
    this.memory.writeUint64(address, data);
    this.memory.writeInt64(address + 8, text.length);
  }

  private stringText(address: number): string {
    const ptr = this.memory.readUint64(address);
    if (ptr === 0) return '';
    return this.memory.readCString(ptr, 1 << 16);
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
      if (isBitsetType(value.type)) {
        const bits = value.type.bits > 0 ? value.type.bits : 8;
        const val = this.memory.readUint32(value.address);
        return (val >>> 0).toString(2).padStart(bits, '0');
      }
      if (value.type.kind === 'array' && value.type.element?.kind === 'char') {
        return this.memory.readCString(value.address, 1 << 16);
      }
    }
    if (value.kind === 'int' && value.type.kind === 'char') {
      return String.fromCharCode(value.value & 0xff);
    }
    // A stream formats a floating point value the way C++ does by default: six
    // significant digits, switching to scientific notation at the edges. Printing the
    // full double made `10.0 / 3.0` read 3.3333333333333335 where a native compiler
    // prints 3.33333.
    if (value.kind === 'float') return formatDefaultFloat(value.value);
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

    // Every simulated container shares the vector's layout, so range-based for
    // walks a map or a queue exactly the way it walks a vector.
    if (value.kind === 'aggregate' && containerKindOf(value.type) !== null) {
      const element = this.vectorElement(value.address, value.type);
      return {
        length: this.sequenceSize(value.address),
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

  /**
   * @brief Executes a range-based `for` loop statement.
   * @details Iterates over arrays, standard containers, strings, or braced initializer lists
   * (e.g. `for (int v : {1, 2, 3})`), binding the loop variable across each element step.
   * @param statement The AST node for the range-for statement.
   */
  private executeForRange(statement: Extract<Statement, { kind: 'for-range' }>): void {
    let sequence: { length: number; element: CType; data: number; stride: number } | null = null;

    if (statement.iterable.kind === 'init-list') {
      const items = statement.iterable.items;
      const values = items.map((item) => this.evaluate(item));
      const declaredType =
        statement.declaration.kind === 'variable'
          ? this.resolver.resolve(statement.declaration.type)
          : UNKNOWN_TYPE;
      const elemType =
        declaredType.kind !== 'unknown' && declaredType.name !== 'auto'
          ? (declaredType.kind === 'pointer' && statement.declaration.kind === 'variable' && statement.declaration.type.reference
              ? (declaredType.pointee ?? intType())
              : declaredType)
          : (values[0]?.type ?? intType());
      const stride = Math.max(elemType.size, 1);
      const data = this.memory.alloc(Math.max(stride * items.length, 1), alignOf(elemType));
      for (let i = 0; i < values.length; i++) {
        this.store(elemType, data + i * stride, convertTo(elemType, values[i]!));
      }
      sequence = { length: values.length, element: elemType, data, stride };
    } else {
      const iterable = this.evaluateRaw(statement.iterable);
      sequence = this.sequenceOf(iterable);
    }

    if (!sequence) {
      throw new RuntimeFault(
        'range-based for needs an array, std::vector, std::string or initializer list',
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

      const subBindings: Binding[] = [];
      if (declaration.structuredBindings) {
        declaration.structuredBindings.forEach((subName, i) => {
          if (elementType.members && elementType.members[i]) {
            const member = elementType.members[i];
            const sub: Binding = {
              name: subName,
              type: member.type,
              address: address + member.offset,
              storage: 'local',
              scopeName: this.currentScopeName(),
              declaredAt: declaration.start,
            };
            this.bind(sub);
            subBindings.push(sub);
          } else if (elementType.kind === 'array' && elementType.element) {
            const stride = Math.max(elementType.element.size, 1);
            const sub: Binding = {
              name: subName,
              type: elementType.element,
              address: address + i * stride,
              storage: 'local',
              scopeName: this.currentScopeName(),
              declaredAt: declaration.start,
            };
            this.bind(sub);
            subBindings.push(sub);
          }
        });
      }

      this.iterationCounters.set(statement.start.offset, 0);
      for (let index = 0; index < sequence.length; index += 1) {
        this.tick();
        const value = this.load(sequence.element, sequence.data + index * sequence.stride);
        this.store(elementType, address, convertTo(elementType, value));
        this.record(binding, declaration.start);
        for (const sub of subBindings) {
          this.record(sub, declaration.start);
        }

        const lines = this.beginIteration();
        let breaking = false;
        try {
          this.executeStatement(statement.body);
        } catch (flow) {
          if (flow instanceof ControlFlow) {
            if (flow.flow === 'break') breaking = true;
            else if (flow.flow !== 'continue') {
              this.abortIteration();
              throw flow;
            }
          } else {
            this.abortIteration();
            throw flow;
          }
        }
        if (breaking) {
          this.abortIteration();
          break;
        }
        this.endIteration(statement, lines);
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
        case 'rbegin':
          return pointerValue(element, size > 0 ? data + (size - 1) * stride : data);
        case 'rend':
          return pointerValue(element, data - stride);
        case 'erase': {
          const firstVal = toPointerAddress(this.decay(argumentAt(0)));
          const secondVal = args[1] ? toPointerAddress(this.decay(argumentAt(1))) : undefined;
          if (firstVal !== null) {
            const firstIndex = Math.floor((firstVal - data) / stride);
            if (secondVal !== undefined && secondVal !== null) {
              const lastIndex = Math.floor((secondVal - data) / stride);
              const removeCount = Math.max(lastIndex - firstIndex, 0);
              if (removeCount > 0 && firstIndex >= 0 && lastIndex <= size) {
                for (let i = lastIndex; i < size; i++) {
                  const src = data + i * stride;
                  const dst = data + (i - removeCount) * stride;
                  this.memory.copy(src, dst, stride);
                }
                const newSize = size - removeCount;
                this.memory.writeInt64(address + 8, newSize);
              }
            } else if (firstIndex >= 0 && firstIndex < size) {
              for (let i = firstIndex + 1; i < size; i++) {
                const src = data + i * stride;
                const dst = data + (i - 1) * stride;
                this.memory.copy(src, dst, stride);
              }
              this.memory.writeInt64(address + 8, size - 1);
            }
          }
          return pointerValue(element, firstVal ?? data);
        }
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

    const containerKind = object.kind === 'aggregate' ? containerKindOf(object.type) : null;
    if (object.kind === 'aggregate' && containerKind && containerKind !== 'vector') {
      const address = object.address;
      const type = object.type;
      const element = this.vectorElement(address, type);
      const size = this.sequenceSize(address);

      const argumentAt = (index: number): Value =>
        args[index] ? this.evaluateRaw(args[index] as Expression) : intValue(intType(), 0);

      switch (property) {
        case 'size':
        case 'length':
          return intValue(longType(), size);
        case 'empty':
          return intValue(intType(), size === 0 ? 1 : 0);
        case 'clear':
          this.sequenceTruncate(address, 0);
          return voidValue();
        case 'begin':
          return pointerValue(element, this.memory.readUint64(address));
        case 'end':
          return pointerValue(element, this.memory.readUint64(address) + size * Math.max(element.size, 1));
        case 'rbegin':
          return pointerValue(element, size > 0 ? this.memory.readUint64(address) + (size - 1) * Math.max(element.size, 1) : this.memory.readUint64(address));
        case 'rend':
          return pointerValue(element, this.memory.readUint64(address) - Math.max(element.size, 1));
        default:
          break;
      }

      // ---- set<K> and map<K, V>
      if (containerKind === 'set' || containerKind === 'map') {
        const parts = pairParts(element);
        const keyType = parts?.key ?? element;
        const keyOfArgument = (value: Value): Value =>
          parts && value.kind === 'aggregate' && value.type.kind === 'struct' && value.type.name === element.name
            ? this.load(parts.key, value.address)
            : this.valueForType(keyType, value);

        switch (property) {
          case 'insert': {
            const value = argumentAt(0);
            if (containerKind === 'map') {
              if (value.kind === 'aggregate' && parts) {
                const key = this.load(parts.key, value.address);
                const mapped = this.load(parts.value, value.address);
                const at = this.sequenceFindKey(address, type, key);
                if (!at.found) this.sequenceInsertAt(address, type, at.index, value);
                else {
                  const existing = this.sequenceElement(address, type, at.index);
                  if (existing.kind === 'aggregate') this.store(parts.value, existing.address + (parts.value ? 0 : 0), mapped);
                }
              } else if (args[1]) {
                const key = this.valueForType(keyType, value);
                const mapped = this.valueForType(parts?.value ?? intType(), argumentAt(1));
                const pair = this.createPair(element, key, mapped);
                const at = this.sequenceFindKey(address, type, key);
                if (!at.found) this.sequenceInsertAt(address, type, at.index, pair);
              }
              return voidValue();
            }
            const key = keyOfArgument(value);
            const at = this.sequenceFindKey(address, type, key);
            if (!at.found) this.sequenceInsertAt(address, type, at.index, convertTo(element, value));
            return voidValue();
          }
          case 'emplace': {
            if (containerKind === 'map' && args[1]) {
              const key = this.valueForType(keyType, argumentAt(0));
              const mapped = this.valueForType(parts?.value ?? intType(), argumentAt(1));
              const pair = this.createPair(element, key, mapped);
              const at = this.sequenceFindKey(address, type, key);
              if (!at.found) this.sequenceInsertAt(address, type, at.index, pair);
              return voidValue();
            }
            const key = keyOfArgument(argumentAt(0));
            const at = this.sequenceFindKey(address, type, key);
            if (!at.found) this.sequenceInsertAt(address, type, at.index, this.valueForType(element, argumentAt(0)));
            return voidValue();
          }
          case 'count': {
            const at = this.sequenceFindKey(address, type, keyOfArgument(argumentAt(0)));
            return intValue(longType(), at.found ? 1 : 0);
          }
          case 'contains': {
            const at = this.sequenceFindKey(address, type, keyOfArgument(argumentAt(0)));
            return intValue(intType(), at.found ? 1 : 0);
          }
          case 'find': {
            const at = this.sequenceFindKey(address, type, keyOfArgument(argumentAt(0)));
            const data = this.memory.readUint64(address);
            const stride = Math.max(element.size, 1);
            return pointerValue(element, at.found ? data + at.index * stride : data + size * stride);
          }
          case 'at': {
            const at = this.sequenceFindKey(address, type, keyOfArgument(argumentAt(0)));
            if (!at.found) throw new RuntimeFault('std::map::at: key not found', position);
            if (containerKind === 'map' && parts) {
              const found = this.sequenceElement(address, type, at.index);
              // The value lives at the pair's second member offset, not at the
              // pair's start - reading from the start hands back the key.
              return found.kind === 'aggregate'
                ? this.load(parts.value, found.address + (element.members?.[1]?.offset ?? 0))
                : found;
            }
            return this.sequenceElement(address, type, at.index);
          }
          case 'erase': {
            const at = this.sequenceFindKey(address, type, keyOfArgument(argumentAt(0)));
            if (at.found) this.sequenceRemoveAt(address, type, at.index);
            return intValue(longType(), at.found ? 1 : 0);
          }
          default:
            throw new RuntimeFault(`std::${containerKind} has no member '${property}'`, position);
        }
      }

      // ---- queue<T>, stack<T>, deque<T>
      if (containerKind === 'queue' || containerKind === 'stack' || containerKind === 'deque') {
        const stride = Math.max(element.size, 1);
        const first = (): Value => this.sequenceElement(address, type, 0);
        const last = (): Value => this.sequenceElement(address, type, this.sequenceSize(address) - 1);
        void stride;

        switch (property) {
          case 'push':
          case 'push_back':
            this.vectorPush(address, type, this.valueForType(element, argumentAt(0)));
            return voidValue();
          case 'push_front':
            this.sequenceInsertAt(address, type, 0, this.valueForType(element, argumentAt(0)));
            return voidValue();
          case 'pop':
            if (containerKind === 'queue') {
              if (size > 0) this.sequenceRemoveAt(address, type, 0);
              return voidValue();
            }
            if (size > 0) this.sequenceRemoveAt(address, type, size - 1);
            return voidValue();
          case 'pop_back':
            if (size > 0) this.sequenceRemoveAt(address, type, size - 1);
            return voidValue();
          case 'pop_front':
            if (size > 0) this.sequenceRemoveAt(address, type, 0);
            return voidValue();
          case 'front':
            return size > 0 ? first() : voidValue();
          case 'back':
            return size > 0 ? last() : voidValue();
          case 'top':
            return size > 0 ? last() : voidValue();
          case 'at': {
            const index = Math.trunc(toNumber(argumentAt(0)));
            if (index < 0 || index >= size) {
              throw new RuntimeFault(`std::${containerKind} index ${index} is out of range`, position);
            }
            return this.sequenceElement(address, type, index);
          }
          default:
            throw new RuntimeFault(`std::${containerKind} has no member '${property}'`, position);
        }
      }

      // ---- priority_queue<T>
      if (containerKind === 'priority-queue') {
        const stride = Math.max(element.size, 1);
        switch (property) {
          case 'push': {
            this.vectorPush(address, type, this.valueForType(element, argumentAt(0)));
            // Sift the new element up to restore the heap.
            let child = this.sequenceSize(address) - 1;
            const data = this.memory.readUint64(address);
            while (child > 0) {
              const parent = (child - 1) >> 1;
              const childValue = this.load(element, data + child * stride);
              const parentValue = this.load(element, data + parent * stride);
              if (this.compareValues(childValue, parentValue) <= 0) break;
              this.store(element, data + parent * stride, childValue);
              this.store(element, data + child * stride, parentValue);
              child = parent;
            }
            return voidValue();
          }
          case 'pop': {
            if (size === 0) return voidValue();
            const data = this.memory.readUint64(address);
            const lastValue = this.load(element, data + (size - 1) * stride);
            this.store(element, data, lastValue);
            this.sequenceRemoveAt(address, type, size - 1);
            this.siftDown(address, type, 0, this.sequenceSize(address));
            return voidValue();
          }
          case 'top':
            return size > 0 ? this.sequenceElement(address, type, 0) : voidValue();
          default:
            throw new RuntimeFault(`std::priority_queue has no member '${property}'`, position);
        }
      }
    }

    if (object.kind === 'aggregate' && (isStringType(object.type) || isStreamBuffer(object.type))) {
      const address = object.address;
      const text = this.stringText(address);

      const argumentAt = (index: number): Value =>
        args[index] ? this.evaluateRaw(args[index] as Expression) : intValue(intType(), 0);

      switch (property) {
        case 'str':
          return this.makeString(text);
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
        case 'begin':
          return pointerValue(charType(), this.memory.readUint64(address));
        case 'end':
          return pointerValue(charType(), this.memory.readUint64(address) + text.length);
        case 'rbegin':
          return pointerValue(charType(), text.length > 0 ? this.memory.readUint64(address) + text.length - 1 : this.memory.readUint64(address));
        case 'rend':
          return pointerValue(charType(), this.memory.readUint64(address) - 1);
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

    if (object.kind === 'aggregate' && isBitsetType(object.type)) {
      const address = object.address;
      const bits = object.type.bits > 0 ? object.type.bits : 8;
      switch (property) {
        case 'count': {
          const num = this.memory.readUint32(address);
          let c = 0;
          let v = num >>> 0;
          while (v > 0) {
            c += v & 1;
            v >>>= 1;
          }
          return intValue(intType(), c);
        }
        case 'size':
          return intValue(longType(), bits);
        default:
          throw new RuntimeFault(`std::bitset has no member '${property}'`, position);
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
      'lower_bound', 'upper_bound', 'binary_search', 'accumulate', 'iota',
      'min_element', 'max_element', 'minmax_element', 'fill',
      'find', 'find_if', 'find_if_not',
      'count', 'count_if',
      'all_of', 'any_of', 'none_of',
      'for_each', 'transform',
      'partition', 'unique', 'copy',
      'partial_sum', 'adjacent_difference', 'inner_product',
      'gcd', 'lcm', 'back_inserter', 'make_pair',
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
      case 'lower_bound':
      case 'upper_bound':
      case 'binary_search': {
        const range = this.rangeOf(args, position);
        const wanted = this.decay(argumentAt(2));
        // The range is assumed sorted, as the standard requires; the search is a
        // real binary search rather than a scan, so behaviour matches the library.
        let low = 0;
        let high = range.count;
        let found = false;

        while (low < high) {
          const middle = (low + high) >> 1;
          const current = this.load(range.element, range.address + middle * this.strideOf(range.element));
          const order = this.compareValues(current, wanted);
          if (order === 0 && base === 'binary_search') found = true;
          const goRight = base === 'upper_bound' ? order <= 0 : order < 0;
          if (goRight) low = middle + 1;
          else high = middle;
        }

        if (base === 'binary_search') return intValue(intType(), found ? 1 : 0);
        return pointerValue(range.element, range.address + low * this.strideOf(range.element));
      }
      case 'min_element':
      case 'max_element': {
        const range = this.rangeOf(args, position);
        if (range.count === 0) {
          return pointerValue(range.element, range.address);
        }

        let best = 0;
        for (let index = 1; index < range.count; index += 1) {
          const candidate = this.load(range.element, range.address + index * this.strideOf(range.element));
          const champion = this.load(range.element, range.address + best * this.strideOf(range.element));
          const order = this.compareValues(candidate, champion);
          if (base === 'min_element' ? order < 0 : order > 0) best = index;
        }
        return pointerValue(range.element, range.address + best * this.strideOf(range.element));
      }
      case 'accumulate': {
        const range = this.rangeOf(args, position);
        // `accumulate(begin, end, init)`; a custom operation would be the fourth
        // argument. Index 2 is the initial value, not an operation.
        if (args[3]) {
          throw new RuntimeFault('accumulate with a custom operation is not implemented', position);
        }
        if (!isIntegerType(range.element) && !isFloatType(range.element)) {
          // Summing pairs or strings numerically would quietly produce a wrong
          // number, which is worse than saying no.
          throw new RuntimeFault(
            `accumulate only supports numeric elements, not '${range.element.name}'`,
            position,
          );
        }

        let total = toNumber(this.decay(argumentAt(2)));
        for (let index = 0; index < range.count; index += 1) {
          total += toNumber(
            this.load(range.element, range.address + index * this.strideOf(range.element)),
          );
        }
        const initial = this.decay(argumentAt(2));
        return isFloatType(initial.type)
          ? floatValue(initial.type, total)
          : intValue(initial.type, total);
      }
      case 'iota': {
        const range = this.rangeOf(args, position);
        let next = toNumber(this.decay(argumentAt(2)));
        for (let index = 0; index < range.count; index += 1) {
          this.store(
            range.element,
            range.address + index * this.strideOf(range.element),
            convertTo(range.element, intValue(intType(), next)),
          );
          next += 1;
        }
        return voidValue();
      }
      case 'fill': {
        const range = this.rangeOf(args, position);
        const value = this.valueForType(range.element, this.decay(argumentAt(2)));
        for (let index = 0; index < range.count; index += 1) {
          this.store(range.element, range.address + index * this.strideOf(range.element), value);
        }
        return voidValue();
      }
      case 'find': {
        const range = this.rangeOf(args, position);
        const wanted = this.decay(argumentAt(2));
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (this.compareValues(current, wanted) === 0) {
            return pointerValue(range.element, range.address + index * stride);
          }
        }
        return pointerValue(range.element, range.address + range.count * stride);
      }
      case 'find_if': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (toBoolean(this.invokeCallable(predicate, [current], position))) {
            return pointerValue(range.element, range.address + index * stride);
          }
        }
        return pointerValue(range.element, range.address + range.count * stride);
      }
      case 'find_if_not': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (!toBoolean(this.invokeCallable(predicate, [current], position))) {
            return pointerValue(range.element, range.address + index * stride);
          }
        }
        return pointerValue(range.element, range.address + range.count * stride);
      }
      case 'count': {
        const range = this.rangeOf(args, position);
        const wanted = this.decay(argumentAt(2));
        const stride = this.strideOf(range.element);
        let count = 0;
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (this.compareValues(current, wanted) === 0) count += 1;
        }
        return intValue(longType(), count);
      }
      case 'count_if': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        let count = 0;
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (toBoolean(this.invokeCallable(predicate, [current], position))) count += 1;
        }
        return intValue(longType(), count);
      }
      case 'all_of': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (!toBoolean(this.invokeCallable(predicate, [current], position))) return intValue(intType(), 0);
        }
        return intValue(intType(), 1);
      }
      case 'any_of': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (toBoolean(this.invokeCallable(predicate, [current], position))) return intValue(intType(), 1);
        }
        return intValue(intType(), 0);
      }
      case 'none_of': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          if (toBoolean(this.invokeCallable(predicate, [current], position))) return intValue(intType(), 0);
        }
        return intValue(intType(), 1);
      }
      case 'for_each': {
        const range = this.rangeOf(args, position);
        const fn = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          this.invokeCallable(fn, [current], position);
        }
        return fn;
      }
      case 'transform': {
        if (args.length >= 5) {
          const range1 = this.rangeOf([args[0]!, args[1]!], position);
          const first2 = this.decay(argumentAt(2));
          const dest = argumentAt(3);
          const op = argumentAt(4);
          const first2Addr = toPointerAddress(first2) ?? 0;
          const elem2 = first2.type.pointee ?? first2.type.element ?? range1.element;
          const stride1 = this.strideOf(range1.element);
          const stride2 = this.strideOf(elem2);
          for (let index = 0; index < range1.count; index += 1) {
            const in1 = this.load(range1.element, range1.address + index * stride1);
            const in2 = this.load(elem2, first2Addr + index * stride2);
            const res = this.invokeCallable(op, [in1, in2], position);
            this.writeToDestination(dest, index, res, position);
          }
          return this.advanceDestination(dest, range1.count, range1.element);
        }
        const range = this.rangeOf([args[0]!, args[1]!], position);
        const dest = argumentAt(2);
        const op = argumentAt(3);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const input = this.load(range.element, range.address + index * stride);
          const res = this.invokeCallable(op, [input], position);
          this.writeToDestination(dest, index, res, position);
        }
        return this.advanceDestination(dest, range.count, range.element);
      }
      case 'minmax_element': {
        const range = this.rangeOf(args, position);
        const stride = this.strideOf(range.element);
        let minIndex = 0;
        let maxIndex = 0;
        if (range.count > 0) {
          for (let index = 1; index < range.count; index += 1) {
            const current = this.load(range.element, range.address + index * stride);
            const minVal = this.load(range.element, range.address + minIndex * stride);
            const maxVal = this.load(range.element, range.address + maxIndex * stride);
            if (this.compareValues(current, minVal) < 0) minIndex = index;
            if (this.compareValues(current, maxVal) > 0) maxIndex = index;
          }
        }
        const minPtr = pointerValue(range.element, range.address + minIndex * stride);
        const maxPtr = pointerValue(range.element, range.address + maxIndex * stride);
        const pairT = pairType(minPtr.type, maxPtr.type);
        return this.createPair(pairT, minPtr, maxPtr);
      }
      case 'make_pair': {
        const first = argumentAt(0);
        const second = argumentAt(1);
        const pairT = pairType(first.type, second.type);
        return this.createPair(pairT, first, second);
      }
      case 'partition': {
        const range = this.rangeOf(args, position);
        const predicate = argumentAt(2);
        const stride = this.strideOf(range.element);
        const temporary = this.builtinAlloc(stride);
        let firstIndex = 0;
        let lastIndex = range.count;

        while (firstIndex < lastIndex) {
          while (firstIndex < lastIndex) {
            const current = this.load(range.element, range.address + firstIndex * stride);
            if (!toBoolean(this.invokeCallable(predicate, [current], position))) break;
            firstIndex += 1;
          }
          while (firstIndex < lastIndex) {
            const current = this.load(range.element, range.address + (lastIndex - 1) * stride);
            if (toBoolean(this.invokeCallable(predicate, [current], position))) break;
            lastIndex -= 1;
          }
          if (firstIndex < lastIndex) {
            lastIndex -= 1;
            const leftAddr = range.address + firstIndex * stride;
            const rightAddr = range.address + lastIndex * stride;
            this.memory.copy(leftAddr, temporary, stride);
            this.memory.copy(rightAddr, leftAddr, stride);
            this.memory.copy(temporary, rightAddr, stride);
            firstIndex += 1;
          }
        }
        this.builtinFree(temporary);
        return pointerValue(range.element, range.address + firstIndex * stride);
      }
      case 'unique': {
        const range = this.rangeOf(args, position);
        if (range.count <= 1) {
          return pointerValue(range.element, range.address + range.count * this.strideOf(range.element));
        }
        const stride = this.strideOf(range.element);
        let writeIndex = 1;
        for (let readIndex = 1; readIndex < range.count; readIndex += 1) {
          const current = this.load(range.element, range.address + readIndex * stride);
          const previous = this.load(range.element, range.address + (writeIndex - 1) * stride);
          if (this.compareValues(current, previous) !== 0) {
            if (writeIndex !== readIndex) {
              const src = range.address + readIndex * stride;
              const dst = range.address + writeIndex * stride;
              this.memory.copy(src, dst, stride);
            }
            writeIndex += 1;
          }
        }
        return pointerValue(range.element, range.address + writeIndex * stride);
      }
      case 'copy': {
        const range = this.rangeOf(args, position);
        const dest = argumentAt(2);
        const stride = this.strideOf(range.element);
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          this.writeToDestination(dest, index, current, position);
        }
        return this.advanceDestination(dest, range.count, range.element);
      }
      case 'back_inserter': {
        let target = args[0] ? this.lvalue(args[0]) : null;
        if (!target && args[0]) {
          const raw = this.evaluateRaw(args[0]);
          if (raw.kind === 'aggregate') target = { address: raw.address, type: raw.type };
        }
        if (!target) throw new RuntimeFault('back_inserter needs a container', position);
        return {
          kind: 'pointer',
          type: {
            kind: 'pointer',
            name: 'std::back_insert_iterator',
            size: 8,
            signed: false,
            bits: 64,
            pointee: target.type,
          },
          address: target.address,
        };
      }
      case 'partial_sum': {
        const range = this.rangeOf(args, position);
        const dest = argumentAt(2);
        const stride = this.strideOf(range.element);
        let sum = 0;
        for (let index = 0; index < range.count; index += 1) {
          const current = this.load(range.element, range.address + index * stride);
          sum += toNumber(current);
          const sumVal = isFloatType(range.element)
            ? floatValue(range.element, sum)
            : intValue(range.element, sum);
          this.writeToDestination(dest, index, sumVal, position);
        }
        return this.advanceDestination(dest, range.count, range.element);
      }
      case 'adjacent_difference': {
        const range = this.rangeOf(args, position);
        const dest = argumentAt(2);
        const stride = this.strideOf(range.element);
        if (range.count > 0) {
          let prev = this.load(range.element, range.address);
          this.writeToDestination(dest, 0, prev, position);
          for (let index = 1; index < range.count; index += 1) {
            const current = this.load(range.element, range.address + index * stride);
            const diff = toNumber(current) - toNumber(prev);
            const diffVal = isFloatType(range.element)
              ? floatValue(range.element, diff)
              : intValue(range.element, diff);
            this.writeToDestination(dest, index, diffVal, position);
            prev = current;
          }
        }
        return this.advanceDestination(dest, range.count, range.element);
      }
      case 'inner_product': {
        const range1 = this.rangeOf([args[0]!, args[1]!], position);
        const first2 = this.decay(argumentAt(2));
        const init = this.decay(argumentAt(3));
        const first2Addr = toPointerAddress(first2) ?? 0;
        const elem2 = first2.type.pointee ?? first2.type.element ?? range1.element;
        const stride1 = this.strideOf(range1.element);
        const stride2 = this.strideOf(elem2);
        let total = toNumber(init);
        for (let index = 0; index < range1.count; index += 1) {
          const v1 = toNumber(this.load(range1.element, range1.address + index * stride1));
          const v2 = toNumber(this.load(elem2, first2Addr + index * stride2));
          total += v1 * v2;
        }
        return isFloatType(init.type)
          ? floatValue(init.type, total)
          : intValue(init.type, total);
      }
      case 'gcd': {
        let a = Math.abs(Math.trunc(toNumber(argumentAt(0))));
        let b = Math.abs(Math.trunc(toNumber(argumentAt(1))));
        while (b !== 0) {
          const t = b;
          b = a % b;
          a = t;
        }
        return intValue(intType(), a);
      }
      case 'lcm': {
        const rawA = Math.abs(Math.trunc(toNumber(argumentAt(0))));
        const rawB = Math.abs(Math.trunc(toNumber(argumentAt(1))));
        if (rawA === 0 || rawB === 0) return intValue(intType(), 0);
        let a = rawA;
        let b = rawB;
        while (b !== 0) {
          const t = b;
          b = a % b;
          a = t;
        }
        const lcmVal = Math.trunc((rawA / a) * rawB);
        return intValue(intType(), lcmVal);
      }
      default:
        return undefined;
    }
  }

  /**
   * @brief Invokes a callable target such as a lambda closure, function pointer, or functor object.
   * @details Dispatches invocation according to the callable kind: inspecting closure tables for lambdas,
   * definition tables for free function pointers, and checking for struct operator() overloads on aggregate instances.
   * @param callable The Value representing the callable target.
   * @param args Arguments to pass to the callable.
   * @param position Source position of the call site for fault reporting.
   * @return The Value produced by the callable execution.
   */
  private invokeCallable(
    callable: Value,
    args: readonly Value[],
    _position: SourcePos,
  ): Value {
    const address = toPointerAddress(callable);
    if (address !== null) {
      const closure = this.closures.get(address);
      if (closure) {
        return this.callClosure(closure, args);
      }
      const name = this.functionTable[address];
      if (name) {
        const decl = this.definitions.get(name);
        if (decl) return this.callFunction(decl, args);
      }
    }

    const typeName = callable.type.name ? bareTagName(callable.type.name) : undefined;
    if (typeName) {
      const opName = `${typeName}::operator()`;
      const decl = this.definitions.get(opName);
      if (decl) {
        const thisAddr = callable.kind === 'aggregate' || callable.kind === 'pointer' ? callable.address : undefined;
        return this.callFunction(decl, args, thisAddr, callable.type);
      }
    }

    if (callable.kind === 'aggregate') {
      const decl = this.definitions.get('operator()');
      if (decl) return this.callFunction(decl, args, callable.address, callable.type);
    }

    return this.callFunctionPointer(callable, args);
  }

  /**
   * @brief Writes a computed value to an output iterator or container inserter destination.
   * @details If the destination is a back_insert_iterator, pushes the value to the underlying vector container;
   * otherwise stores the value through pointer offset in memory.
   * @param dest The destination iterator or back_insert_iterator Value.
   * @param index The zero-based offset relative to destination start.
   * @param value The Value to write.
   * @param position Source position for fault reporting.
   */
  private writeToDestination(
    dest: Value,
    index: number,
    value: Value,
    position: SourcePos,
  ): void {
    if (dest.type.name === 'std::back_insert_iterator' && dest.kind === 'pointer') {
      this.vectorPush(dest.address, dest.type.pointee ?? dest.type, value);
      return;
    }
    const destAddr = toPointerAddress(dest);
    if (destAddr === null) {
      throw new RuntimeFault('destination must be an iterator or container inserter', position);
    }
    const destElement = dest.type.pointee ?? dest.type.element ?? value.type;
    const stride = this.strideOf(destElement);
    this.store(destElement, destAddr + index * stride, convertTo(destElement, value));
  }

  /**
   * @brief Advances an output destination iterator by a specified element count.
   * @param dest The destination iterator Value.
   * @param count Number of elements written to advance the iterator.
   * @param element The element type determining stride.
   * @return Advanced iterator pointer Value or the inserter itself.
   */
  private advanceDestination(dest: Value, count: number, element: CType): Value {
    if (dest.type.name === 'std::back_insert_iterator') {
      return dest;
    }
    const destAddr = toPointerAddress(dest);
    if (destAddr === null) return dest;
    const destElement = dest.type.pointee ?? dest.type.element ?? element;
    const stride = this.strideOf(destElement);
    return pointerValue(destElement, destAddr + count * stride);
  }

  private strideOf(element: CType): number {
    return Math.max(element.size, 1);
  }

  /**
   * The `[begin, end)` range an algorithm works on.
   *
   * The algorithms take iterators, which this engine models as pointers - the same
   * thing `.begin()` and `.end()` hand back for every container.
   */
  private rangeOf(
    args: readonly Expression[],
    position: SourcePos,
  ): { readonly address: number; readonly count: number; readonly element: CType } {
    const first = args[0];
    const second = args[1];
    if (!first || !second) {
      throw new RuntimeFault('this algorithm needs a begin and an end', position);
    }

    const fromValue = this.decay(this.evaluateRaw(first));
    const toValue = this.decay(this.evaluateRaw(second));
    const element =
      fromValue.type.pointee ?? toValue.type.pointee ?? fromValue.type.element ?? toValue.type.element;
    if (!element) {
      throw new RuntimeFault('cannot tell what this range holds', position);
    }

    const from = toPointerAddress(fromValue) ?? 0;
    const to = toPointerAddress(toValue) ?? 0;
    const stride = Math.max(element.size, 1);
    return { address: from, count: Math.max(Math.floor((to - from) / stride), 0), element };
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
    /*
     * Storing into a `std::string` always builds the string object.
     *
     * Writing the bytes of a literal instead produced the same bug in three places
     * (vector elements, map keys, pair members): the bytes are later read back as a
     * data pointer. Handling it here means every store site is correct instead of
     * each caller having to remember.
     */
    if (isStringType(type)) {
      this.createString(address, this.stringTextOf(value));
      return;
    }

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
        /*
         * An unknown/template type is stored by the actual value kind, so a double
         * does not get truncated to an integer on the way in - and the kind is
         * remembered, because reading such a slot without knowing what went into it
         * is what turned a template function's `int` return into a double read from
         * eight bytes: bigger(3, 9) printed 4.4e-323.
         */
        if (value.kind === 'float') {
          this.slotTypes.set(address, value.type);
          this.memory.writeFloat64(address, toNumber(value));
        } else {
          this.slotTypes.set(address, value.type);
          this.memory.writeInt64(address, Math.trunc(toNumber(value)));
        }
        return;
    }
  }

  /**
   * Reads a value out of memory.
   *
   * `reportUninitialized` is false for the reads the *display* does: the watch pane
   * reads every variable to show its value, and counting that as the program
   * reading an uninitialised variable produced warnings for code that assigns a
   * variable before ever using it.
   */
  private load(type: CType, address: number, binding?: Binding, reportUninitialized = true): Value {
    switch (type.kind) {
      case 'bool':
        return intValue(type, this.memory.readUint8(address));
      case 'char':
        return intValue(type, type.signed ? this.memory.readInt8(address) : this.memory.readUint8(address));
      case 'int':
      case 'enum': {
        if (reportUninitialized && this.uninitialized.has(address)) {
          this.warnUninitialized(address, binding);
        }
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
      default: {
        /*
         * A template type has no width of its own, so the width of the value that
         * was stored decides. Without this, an `int` written into a `T` slot was read
         * back as a float64 - eight bytes of which four were zero - and
         * `template <typename T> T bigger(T, T)` printed 4.4e-323 for bigger(3, 9).
         */
        const stored = this.slotTypes.get(address);
        if (stored) return this.load(stored, address);

        // Nothing has been written there yet: zero reads as 0 whichever width it
        // later takes.
        return intValue(longType(), 0);
      }
    }
  }

  private warnUninitialized(address: number, binding?: Binding): void {
    this.uninitialized.delete(address);
    if (this.warnedUninitialized.has(address)) return;
    this.warnedUninitialized.add(address);
    const position = binding?.declaredAt ?? this.unit.start;
    const message = `read of uninitialized variable${binding ? ` '${binding.name}'` : ''}`;
    this.diagnostics.push(
      makeDiagnostic('warning', message, position.file, position, position),
    );
    // The diagnostic points at the declaration (that is the marker worth having in
    // the editor); the safety event points at the read, which is where the program
    // actually was, and names the declaration line in its message.
    this.recordSafety(
      'uninitialized-read',
      binding ? `${message} (declared at line ${position.line})` : message,
    );
  }

  /**
   * Records a runtime safety event.
   *
   * These are the things a C compiler accepts and a debugger would stop on:
   * reading an uninitialised variable, dividing by zero, dereferencing null,
   * walking off an allocation, or never freeing one.
   */
  private recordSafety(kind: SafetyKind, message: string, position?: SourcePos): void {
    if (this.safetyEvents.length >= MAX_SAFETY_EVENTS) return;
    this.safetyEvents.push({
      kind,
      severity: SAFETY_SEVERITY[kind],
      message,
      // The statement being executed is a better answer than "the top of the file"
      // when the fault came from inside the memory layer.
      line: position?.line ?? this.currentLine,
    });
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
        if (!binding) {
          // Inside a method a bare name may be a data member of `this`.
          const member = this.implicitThisMember(expression.name);
          if (member) return member;
          return null;
        }

        /*
         * A reference *is* its referent, so an assignment through one writes to the
         * object that was bound - which is the whole point of `void bump(int&)`. A
         * `const T&` refers to something this scope may not change, and saying so is
         * better than quietly writing through it.
         */
        if (binding.reference) {
          if (binding.readonly) {
            throw new RuntimeFault(
              `cannot assign through '${binding.name}': it is a reference to const`,
              expression.start,
            );
          }
          const target = this.memory.readUint64(binding.address);
          return { address: target, type: binding.type.pointee ?? binding.type };
        }

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

  /**
   * @brief Statically evaluates the CType of an expression without side effects.
   * @details Resolves variables, literals, operators, and return types for overload resolution.
   * @param expression The expression AST node.
   * @return The deduced CType.
   */
  private typeOf(expression: Expression): CType {
    switch (expression.kind) {
      case 'identifier': {
        const binding = this.lookup(expression.name);
        return binding?.type ?? intType();
      }
      case 'literal': {
        if (expression.literal === 'string') {
          return arrayOf(charType(), (expression.value ?? '').length + 1);
        }
        if (expression.literal === 'char') {
          return charType();
        }
        const text = expression.text;
        const isFloat =
          text.includes('.') ||
          (!/^0[xXbB]/.test(text) && /[eE][-+]?\d/.test(text)) ||
          (/[fF]$/.test(text) && text.includes('.'));
        if (isFloat) {
          return text.toLowerCase().endsWith('f') ? floatType() : doubleType();
        }
        if (/u/i.test(text)) {
          return { kind: 'int', name: 'unsigned int', size: 4, signed: false, bits: 32 };
        }
        if (/l/i.test(text)) {
          return longType();
        }
        return intType();
      }
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
      case 'binary': {
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expression.operator)) {
          return boolType();
        }
        const leftType = this.typeOf(expression.left);
        const rightType = this.typeOf(expression.right);
        if (leftType.kind === 'double' || rightType.kind === 'double') return doubleType();
        if (leftType.kind === 'float' || rightType.kind === 'float') return floatType();
        if (leftType.size >= 8 || rightType.size >= 8) return longType();
        return intType();
      }
      case 'unary':
        if (expression.operator === '!') return boolType();
        if (expression.operator === '&') return pointerTo(this.typeOf(expression.operand));
        if (expression.operator === '*') return this.typeOf(expression.operand).pointee ?? intType();
        return this.typeOf(expression.operand);
      case 'sizeof':
        return longType();
      case 'call': {
        if (expression.callee.kind === 'identifier') {
          const overloads = this.functionOverloads.get(expression.callee.name);
          if (overloads && overloads.length > 0) {
            try {
              const matched = this.resolveOverload(overloads, expression.args, expression.start);
              return this.resolver.resolve(matched.returnType);
            } catch {
              return this.resolver.resolve(overloads[0]!.returnType);
            }
          }
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

    /*
     * An aggregate carries its text itself.
     *
     * `toPointerAddress` on a char array reads its first bytes as an address -
     * which for "seven" is 0x6e65766573, the ASCII of "seve" - and dereferencing
     * that is how a `std::string` member ended up crashing the whole program.
     */
    if (value.kind === 'aggregate') {
      if (isStringType(value.type)) return this.stringText(value.address);
      if (value.type.kind === 'array' && value.type.element?.kind === 'char') {
        return this.memory.readCString(value.address, 1 << 16);
      }
    }

    const address = toPointerAddress(value);
    if (address === null || address === 0) return '';
    return this.memory.readCString(address);
  }

  /**
   * @brief Determines the output destination of a stream insertion operation (`<<`).
   * @details Resolves `std::cout`, `std::cerr`, or an in-memory stringstream buffer.
   * Recognizes bindings passed by reference (e.g., `std::ostream&`) within custom `operator<<`.
   * @param expression The AST expression representing the stream destination.
   * @return A descriptor indicating standard output, standard error, a stringstream buffer binding, or null.
   */
  private streamTargetOf(
    expression: Expression,
  ):
    | { readonly kind: 'stdout' }
    | { readonly kind: 'stderr' }
    | { readonly kind: 'buffer'; readonly binding: Binding }
    | null {
    if (expression.kind === 'identifier') {
      if (expression.name === 'std::cout' || expression.name === 'cout') return { kind: 'stdout' };
      if (expression.name === 'std::cerr' || expression.name === 'cerr') return { kind: 'stderr' };

      const binding = this.lookup(expression.name);
      if (!binding) return null;
      if (binding.type.name.includes('cerr')) return { kind: 'stderr' };
      if (binding.type.name.includes('ostream')) return { kind: 'stdout' };
      if (isStreamBuffer(binding.type)) return { kind: 'buffer', binding };
      return null;
    }
    if (expression.kind === 'binary' && expression.operator === '<<') {
      return this.streamTargetOf(expression.left);
    }
    return null;
  }

  /**
   * @brief Determines whether a runtime value is a user-defined class eligible for custom `operator<<`.
   * @details Checks that the value is an aggregate struct that is not a standard container,
   * standard string, pair, or stringstream buffer.
   * @param value The evaluated runtime value.
   * @return True if the value is a user-defined class instance, false otherwise.
   */
  private isUserStreamOperand(value: Value): boolean {
    return (
      value.kind === 'aggregate' &&
      value.type.kind === 'struct' &&
      !isStringType(value.type) &&
      !isStreamBuffer(value.type) &&
      !isPairType(value.type) &&
      containerKindOf(value.type) === null
    );
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
      kind: 'assignment',
      step: this.steps,
      line: position.line,
      scope: binding.scopeName,
      name: binding.name,
      vars: this.collectWatch(),
    });
  }

  // ----------------------------------------------------------- iterations

  /** Starts tracking one loop iteration; returns the line set to fill in. */
  private beginIteration(): Set<number> | null {
    if (!this.limits.collectWatch) return null;
    const lines = new Set<number>();
    this.iterationLineStack.push(lines);
    this.loopDepth += 1;
    return lines;
  }

  /**
   * Closes an iteration and records its variable state.
   *
   * The state is captured after the body *and* the increment, so a row in the
   * iteration table shows what that pass left behind - including the advanced
   * loop counter.
   */
  private endIteration(loop: Statement, lines: Set<number> | null): void {
    if (lines === null) return;

    this.iterationLineStack.pop();
    this.loopDepth -= 1;

    const key = loop.start.offset;
    const iteration = (this.iterationCounters.get(key) ?? 0) + 1;
    this.iterationCounters.set(key, iteration);
    lines.add(loop.start.line);

    if (this.history.length >= this.limits.maxSnapshots) {
      this.truncated = true;
      return;
    }

    this.history.push({
      kind: 'loop-iteration',
      step: this.steps,
      line: loop.start.line,
      scope: this.currentScopeName(),
      name: '',
      iteration,
      depth: this.loopDepth + 1,
      lines: [...lines],
      vars: this.collectWatch(),
    });
  }

  /** Undoes an iteration that ended in break/return/goto: nothing is recorded. */
  private abortIteration(): void {
    if (this.iterationLineStack.length === 0) return;
    this.iterationLineStack.pop();
    this.loopDepth -= 1;
  }

  /** Records every line a statement runs on, for loop-iteration lookup. */
  private trackIterationLine(line: number): void {
    if (this.iterationLineStack.length === 0) return;
    for (const lines of this.iterationLineStack) lines.add(line);
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
    /*
     * Innermost scope first.
     *
     * A name can be live twice at once - the caller's `int total = sum(nums);` and
     * the `T total{}` accumulating inside the template. Keying by
     * `scopeName::name` kept both and the pane showed the outer one, so the
     * iteration table reported `total = 0` for every pass while the interpreter was
     * summing correctly. Reading the active scope stack from the top resolves a
     * shadowed name to the binding that is actually live.
     */
    const ordered: Binding[] = [];
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index];
      if (scope) ordered.push(...scope.bindings.values());
    }

    const inActiveScope = new Set(ordered);
    for (const binding of this.allBindings) {
      // Globals (declared with no scope on the stack) are not in any active scope.
      if (!inActiveScope.has(binding)) ordered.push(binding);
    }

    const seen = new Set<string>();
    const vars: WatchVariable[] = [];
    for (const binding of ordered) {
      // Only the user's own file: `stdin`/`stdout`/`stderr` come from headers.
      if (binding.declaredAt.file !== this.mainFile && binding.declaredAt.file.startsWith('<')) {
        continue;
      }
      // An inner binding hides an outer one with the same name.
      if (seen.has(binding.name)) continue;
      seen.add(binding.name);

      if (vars.length >= this.limits.maxVars) {
        this.truncated = true;
        break;
      }
      vars.push(this.describe(binding, 0));
    }
    return vars;
  }

  private describe(binding: Binding, depth: number): WatchVariable {
    // Display read: showing an uninitialised variable is not the program reading it.
    const value = this.load(binding.type, binding.address, undefined, false);
    const children = depth >= 2 ? [] : this.childrenOf(binding.type, binding.address, depth);

    return {
      name: binding.name,
      type: binding.type.name,
      value: this.describeValue(value),
      scope: binding.scopeName,
      changed: false,
      line: binding.declaredAt.line,
      ...(children.length > 0 ? { children } : {}),
    };
  }

  /**
   * The one-line summary of a value for the watch pane, the inline overlay and the
   * iteration table.
   *
   * Sequences render as `[1, 2, 3]` instead of a type name and an address: the
   * address is an implementation detail of this interpreter and tells the reader
   * nothing about the data. At most CONTAINER_PREVIEW_LIMIT elements are shown and
   * the remainder is counted, so a long vector never looks like it ended early.
   */
  private describeValue(value: Value, depth = MAX_SEQUENCE_DEPTH): string {
    if (value.kind === 'aggregate' && depth > 0) {
      const containerKind = containerKindOf(value.type);
      if (containerKind !== null) {
        const layout = readVectorLayout(this.memory, value.address, value.type.element);
        return this.describeContainer(
          containerKind,
          layout.data,
          layout.count,
          layout.element,
          depth,
        );
      }

      if (isPairType(value.type)) {
        const first = value.type.members?.[0];
        const second = value.type.members?.[1];
        const left = first
          ? this.describeValue(this.load(first.type, value.address + first.offset), depth - 1)
          : '?';
        const right = second
          ? this.describeValue(this.load(second.type, value.address + second.offset), depth - 1)
          : '?';
        return `(${left}, ${right})`;
      }

      if (value.type.kind === 'array' && value.type.element) {
        // `char[N]` is how C spells a string, and `"abc"` reads far better than
        // three separate characters.
        if (value.type.element.kind === 'char') {
          return `"${this.memory.readCString(value.address, 256)}"`;
        }
        if (value.type.length !== undefined) {
          return this.describeElements(
            value.address,
            value.type.length,
            value.type.element,
            depth,
          );
        }
      }
    }

    return formatValue(value, this.memory);
  }

  /**
   * How each container reads at a glance: `[..]` for sequences, `{..}` for a set,
   * `{key: value}` for a map - always with the 20-element cap and the count of
   * what was left out, the same rule the vector preview follows.
   */
  private describeContainer(
    kind: string,
    data: number,
    count: number,
    element: CType,
    depth: number,
  ): string {
    const braces = kind === 'map' || kind === 'set';
    if (count <= 0) return braces ? '{}' : '[]';

    const shown = Math.min(count, CONTAINER_PREVIEW_LIMIT);
    const stride = Math.max(element.size, 1);
    const parts: string[] = [];

    for (let index = 0; index < shown; index += 1) {
      const value = this.load(element, data + index * stride);
      const pair = kind === 'map' ? pairParts(element) : null;

      if (pair && value.kind === 'aggregate') {
        const valueOffset = element.members?.[1]?.offset ?? 0;
        const key = this.describeValue(this.load(pair.key, value.address), depth - 1);
        const mapped = this.describeValue(
          this.load(pair.value, value.address + valueOffset),
          depth - 1,
        );
        parts.push(`${key}: ${mapped}`);
        continue;
      }

      parts.push(this.describeElement(value, depth - 1));
    }

    const hidden = count - shown;
    if (hidden > 0) parts.push(`+${hidden} more`);
    return braces ? `{${parts.join(', ')}}` : `[${parts.join(', ')}]`;
  }

  private describeElements(
    data: number,
    count: number,
    element: CType,
    depth: number,
  ): string {
    if (count <= 0) return '[]';

    const shown = Math.min(count, CONTAINER_PREVIEW_LIMIT);
    const stride = Math.max(element.size, 1);
    const parts: string[] = [];
    for (let index = 0; index < shown; index += 1) {
      parts.push(this.describeElement(this.load(element, data + index * stride), depth - 1));
    }

    const hidden = count - shown;
    if (hidden > 0) parts.push(`+${hidden} more`);
    return `[${parts.join(', ')}]`;
  }

  /** Inside a sequence, `'a' (97)` is noise; the character alone reads better. */
  private describeElement(value: Value, depth: number): string {
    if (value.kind === 'int' && value.type.kind === 'char') {
      const code = value.value & 0xff;
      return code >= 32 && code < 127 ? `'${String.fromCharCode(code)}'` : `${value.value}`;
    }
    return this.describeValue(value, depth);
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
      // Display read, like `describe`: expanding an aggregate for the pane must not
      // be mistaken for the program reading an uninitialised member.
      const childValue = this.load(childType, childAddress, undefined, false);
      const nested = depth >= 1 ? [] : this.childrenOf(childType, childAddress, depth + 1);
      children.push({
        name,
        type: childType.name,
        value: this.describeValue(childValue),
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
