import type { CType } from '@/lang/ctype';
import type { Memory } from '@/lang/memory';
import { formatValue } from '@/lang/runtime/value';
import { intValue, pointerValue, toNumber } from '@/lang/runtime/value';
import type { Value } from '@/lang/runtime/value';

/**
 * The C library subset the interpreter implements.
 *
 * Everything here operates on the same `Memory` as user code, so `strlen` walks
 * the bytes the program actually wrote and `malloc` hands back a real address.
 * Functions that need the evaluator itself (`printf` needs the argument values,
 * `qsort` calls back into user code) live in the interpreter instead.
 */

export interface SimpleBuiltinContext {
  readonly memory: Memory;
  readonly types: {
    readonly int: CType;
    readonly long: CType;
    readonly double: CType;
    readonly char: CType;
    readonly voidPointer: CType;
    readonly charPointer: CType;
    readonly voidType: CType;
  };
  /** Deterministic LCG state, so `rand()` is reproducible in tests. */
  readonly rng: { state: number };
  alloc(size: number): number;
  free(address: number): void;
  allocationSize(address: number): number | undefined;
  readString(address: number): string;
  writeString(address: number, text: string): void;
  fail(message: string): never;
}

export type BuiltinReturn =
  | 'int'
  | 'long'
  | 'double'
  | 'void'
  | 'voidPointer'
  | 'charPointer';

export interface SimpleBuiltin {
  readonly returns: BuiltinReturn;
  call(args: readonly Value[], ctx: SimpleBuiltinContext): Value;
}

function intResult(ctx: SimpleBuiltinContext, value: number): Value {
  return intValue(ctx.types.int, value);
}

function longResult(ctx: SimpleBuiltinContext, value: number): Value {
  return intValue(ctx.types.long, value);
}

function doubleResult(ctx: SimpleBuiltinContext, value: number): Value {
  return { kind: 'float', type: ctx.types.double, value };
}

function voidPointer(ctx: SimpleBuiltinContext, address: number): Value {
  return pointerValue(ctx.types.voidType, address);
}

function charPointer(ctx: SimpleBuiltinContext, address: number): Value {
  return pointerValue(ctx.types.char, address);
}

function argument(args: readonly Value[], index: number): Value {
  const value = args[index];
  if (value === undefined) {
    return { kind: 'int', type: { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 }, value: 0 };
  }
  return value;
}

function numberArg(args: readonly Value[], index: number): number {
  return toNumber(argument(args, index));
}

function addressArg(args: readonly Value[], index: number): number {
  const value = argument(args, index);
  if (value.kind === 'aggregate') return value.address;
  return toNumber(value);
}

/** Turns a two-argument numeric function into a builtin call. */
const binaryDouble =
  (fn: (a: number, b: number) => number) =>
  (args: readonly Value[]): number =>
    fn(numberArg(args, 0), numberArg(args, 1));

const SIMPLE: Record<string, SimpleBuiltin> = {
  // ---------------------------------------------------------------- stdio
  puts: {
    returns: 'int',
    call: (args, ctx) => {
      const text = ctx.readString(addressArg(args, 0));
      ctx.memory; // memory access goes through readString
      return intResult(ctx, text.length + 1);
    },
  },
  fputs: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, ctx.readString(addressArg(args, 0)).length),
  },
  putchar: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, numberArg(args, 0) & 0xff),
  },
  strlen: {
    returns: 'long',
    call: (args, ctx) => longResult(ctx, ctx.readString(addressArg(args, 0)).length),
  },
  strcmp: {
    returns: 'int',
    call: (args, ctx) => {
      const left = ctx.readString(addressArg(args, 0));
      const right = ctx.readString(addressArg(args, 1));
      return intResult(ctx, left < right ? -1 : left > right ? 1 : 0);
    },
  },
  strncmp: {
    returns: 'int',
    call: (args, ctx) => {
      const count = numberArg(args, 2);
      const left = ctx.readString(addressArg(args, 0)).slice(0, count);
      const right = ctx.readString(addressArg(args, 1)).slice(0, count);
      return intResult(ctx, left < right ? -1 : left > right ? 1 : 0);
    },
  },
  strcpy: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const destination = addressArg(args, 0);
      ctx.writeString(destination, ctx.readString(addressArg(args, 1)));
      return charPointer(ctx, destination);
    },
  },
  strncpy: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const destination = addressArg(args, 0);
      const count = numberArg(args, 2);
      let text = ctx.readString(addressArg(args, 1));
      if (text.length > count) text = text.slice(0, count);
      while (text.length < count) text += '\0';
      ctx.writeString(destination, text);
      return charPointer(ctx, destination);
    },
  },
  strcat: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const destination = addressArg(args, 0);
      const merged = ctx.readString(destination) + ctx.readString(addressArg(args, 1));
      ctx.writeString(destination, merged);
      return charPointer(ctx, destination);
    },
  },
  strchr: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const address = addressArg(args, 0);
      const text = ctx.readString(address);
      const needle = String.fromCharCode(numberArg(args, 1) & 0xff);
      const found = text.indexOf(needle);
      return charPointer(ctx, found < 0 ? 0 : address + found);
    },
  },
  strrchr: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const address = addressArg(args, 0);
      const text = ctx.readString(address);
      const needle = String.fromCharCode(numberArg(args, 1) & 0xff);
      const found = text.lastIndexOf(needle);
      return charPointer(ctx, found < 0 ? 0 : address + found);
    },
  },
  strstr: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const address = addressArg(args, 0);
      const text = ctx.readString(address);
      const needle = ctx.readString(addressArg(args, 1));
      const found = text.indexOf(needle);
      return charPointer(ctx, found < 0 ? 0 : address + found);
    },
  },
  strdup: {
    returns: 'charPointer',
    call: (args, ctx) => {
      const text = ctx.readString(addressArg(args, 0));
      const address = ctx.alloc(text.length + 1);
      ctx.writeString(address, text);
      return charPointer(ctx, address);
    },
  },

  // --------------------------------------------------------------- memory
  malloc: {
    returns: 'voidPointer',
    call: (args, ctx) => voidPointer(ctx, ctx.alloc(numberArg(args, 0))),
  },
  calloc: {
    returns: 'voidPointer',
    call: (args, ctx) => {
      const count = numberArg(args, 0);
      const size = numberArg(args, 1);
      const total = Math.max(1, count * size);
      const address = ctx.alloc(total);
      ctx.memory.fill(address, 0, total);
      return voidPointer(ctx, address);
    },
  },
  realloc: {
    returns: 'voidPointer',
    call: (args, ctx) => {
      const previous = addressArg(args, 0);
      const size = Math.max(1, numberArg(args, 1));
      if (previous === 0) return voidPointer(ctx, ctx.alloc(size));
      const oldSize = ctx.allocationSize(previous) ?? size;
      const address = ctx.alloc(size);
      ctx.memory.copy(previous, address, Math.min(oldSize, size));
      ctx.free(previous);
      return voidPointer(ctx, address);
    },
  },
  free: {
    returns: 'void',
    call: (args, ctx) => {
      ctx.free(addressArg(args, 0));
      return { kind: 'void', type: ctx.types.voidType };
    },
  },
  memset: {
    returns: 'voidPointer',
    call: (args, ctx) => {
      const address = addressArg(args, 0);
      ctx.memory.fill(address, numberArg(args, 1), numberArg(args, 2));
      return voidPointer(ctx, address);
    },
  },
  memcpy: {
    returns: 'voidPointer',
    call: (args, ctx) => {
      const destination = addressArg(args, 0);
      ctx.memory.copy(addressArg(args, 1), destination, numberArg(args, 2));
      return voidPointer(ctx, destination);
    },
  },
  memmove: {
    returns: 'voidPointer',
    call: (args, ctx) => {
      const destination = addressArg(args, 0);
      const source = addressArg(args, 1);
      const count = numberArg(args, 2);
      const temporary = ctx.memory.readBytes(source, count);
      ctx.memory.writeBytes(destination, temporary);
      return voidPointer(ctx, destination);
    },
  },
  memcmp: {
    returns: 'int',
    call: (args, ctx) => {
      const count = numberArg(args, 2);
      const left = ctx.memory.readBytes(addressArg(args, 0), count);
      const right = ctx.memory.readBytes(addressArg(args, 1), count);
      for (let index = 0; index < count; index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        if (a !== b) return intResult(ctx, a - b);
      }
      return intResult(ctx, 0);
    },
  },

  // -------------------------------------------------------------- stdlib
  atoi: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, Number.parseInt(ctx.readString(addressArg(args, 0)).trim(), 10) || 0),
  },
  atol: {
    returns: 'long',
    call: (args, ctx) => longResult(ctx, Number.parseInt(ctx.readString(addressArg(args, 0)).trim(), 10) || 0),
  },
  atof: {
    returns: 'double',
    call: (args, ctx) => doubleResult(ctx, Number.parseFloat(ctx.readString(addressArg(args, 0)).trim()) || 0),
  },
  strtol: {
    returns: 'long',
    call: (args, ctx) => {
      const base = numberArg(args, 2) || 10;
      const parsed = Number.parseInt(ctx.readString(addressArg(args, 0)).trim(), base);
      return longResult(ctx, Number.isNaN(parsed) ? 0 : parsed);
    },
  },
  abs: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, Math.abs(Math.trunc(numberArg(args, 0)))),
  },
  labs: {
    returns: 'long',
    call: (args, ctx) => longResult(ctx, Math.abs(Math.trunc(numberArg(args, 0)))),
  },
  llabs: {
    returns: 'long',
    call: (args, ctx) => longResult(ctx, Math.abs(Math.trunc(numberArg(args, 0)))),
  },
  rand: {
    returns: 'int',
    call: (_args, ctx) => {
      // Numerical Recipes LCG: small, deterministic, good enough for demos.
      ctx.rng.state = (Math.imul(1664525, ctx.rng.state) + 1013904223) >>> 0;
      return intResult(ctx, (ctx.rng.state >>> 1) % 32768);
    },
  },
  srand: {
    returns: 'void',
    call: (args, ctx) => {
      ctx.rng.state = (Math.trunc(numberArg(args, 0)) >>> 0) || 1;
      return { kind: 'void', type: ctx.types.voidType };
    },
  },

  // ---------------------------------------------------------------- math
  sqrt: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.sqrt(numberArg(args, 0))) },
  pow: { returns: 'double', call: binaryDouble((a, b) => a ** b) as never },
  fabs: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.abs(numberArg(args, 0))) },
  floor: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.floor(numberArg(args, 0))) },
  ceil: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.ceil(numberArg(args, 0))) },
  round: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.round(numberArg(args, 0))) },
  fmod: { returns: 'double', call: binaryDouble((a, b) => (b === 0 ? Number.NaN : a % b)) as never },
  exp: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.exp(numberArg(args, 0))) },
  log: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.log(numberArg(args, 0))) },
  log10: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.log10(numberArg(args, 0))) },
  sin: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.sin(numberArg(args, 0))) },
  cos: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.cos(numberArg(args, 0))) },
  tan: { returns: 'double', call: (args, ctx) => doubleResult(ctx, Math.tan(numberArg(args, 0))) },
  atan2: { returns: 'double', call: binaryDouble((a, b) => Math.atan2(a, b)) as never },
  hypot: { returns: 'double', call: binaryDouble((a, b) => Math.hypot(a, b)) as never },
  isnan: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, Number.isNaN(numberArg(args, 0)) ? 1 : 0),
  },
  isinf: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, Number.isFinite(numberArg(args, 0)) ? 0 : 1),
  },

  // --------------------------------------------------------------- ctype
  isdigit: { returns: 'int', call: withChar((c) => c >= 48 && c <= 57) },
  isalpha: { returns: 'int', call: withChar((c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) },
  isalnum: {
    returns: 'int',
    call: withChar((c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)),
  },
  isspace: {
    returns: 'int',
    call: withChar((c) => c === 32 || (c >= 9 && c <= 13)),
  },
  isupper: { returns: 'int', call: withChar((c) => c >= 65 && c <= 90) },
  islower: { returns: 'int', call: withChar((c) => c >= 97 && c <= 122) },
  ispunct: {
    returns: 'int',
    call: withChar((c) => c > 32 && c < 127 && !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))),
  },
  toupper: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, String.fromCharCode(numberArg(args, 0) & 0xff).toUpperCase().charCodeAt(0)),
  },
  tolower: {
    returns: 'int',
    call: (args, ctx) => intResult(ctx, String.fromCharCode(numberArg(args, 0) & 0xff).toLowerCase().charCodeAt(0)),
  },
};

function withChar(predicate: (code: number) => boolean): SimpleBuiltin['call'] {
  return (args, ctx) => intResult(ctx, predicate(numberArg(args, 0) & 0xff) ? 1 : 0);
}

export const SIMPLE_BUILTINS: ReadonlyMap<string, SimpleBuiltin> = new Map(
  Object.entries(SIMPLE),
);

/** Builtins handled by the interpreter itself, with the reason why. */
export const INTERPRETER_BUILTINS: ReadonlySet<string> = new Set([
  'printf',   // needs the evaluated argument list
  'fprintf',  // writes to stderr instead of stdout
  'sprintf',  // formats into memory
  'snprintf', // formats into memory with a bound
  'scanf',    // writes through pointers, reads stdin
  'sscanf',   // writes through pointers, reads a string
  'qsort',    // calls back into user code
  'exit',     // unwinds the whole program
  '__assert_fail', // becomes a runtime diagnostic
  'getchar',  // consumes the shared stdin cursor
  'fflush',   // no buffering to flush
  'perror',   // writes to stderr
  'time',     // needs the clock, not memory
  'clock',
]);

/** Used by `qsort` and by hover output, kept here so both agree. */
export function describeArgument(value: Value, memory: Memory): string {
  return formatValue(value, memory);
}
