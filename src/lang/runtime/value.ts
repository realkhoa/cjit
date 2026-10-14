import type { CType } from '@/lang/ctype';
import { isFloatType, isIntegerType } from '@/lang/ctype';
import type { Memory } from '@/lang/memory';

/**
 * Runtime values.
 *
 * Scalars live in a JS field; aggregates (struct/union/array) live in `Memory`
 * and the value carries their address - which is what makes `&x`, pointer
 * arithmetic, `p->member` and struct assignment work like C rather than like
 * special cases.
 */

export type Value =
  | { readonly kind: 'int'; readonly type: CType; readonly value: number }
  | { readonly kind: 'float'; readonly type: CType; readonly value: number }
  | { readonly kind: 'pointer'; readonly type: CType; readonly address: number }
  | { readonly kind: 'aggregate'; readonly type: CType; readonly address: number }
  | { readonly kind: 'function'; readonly type: CType; readonly name: string }
  | { readonly kind: 'void'; readonly type: CType }
  | { readonly kind: 'uninit'; readonly type: CType };

/** Applies the type's width and signedness, so `int` really wraps at 32 bits. */
export function truncateInteger(type: CType, input: number): number {
  if (!Number.isFinite(input)) return 0;
  const truncated = Math.trunc(input);

  // 64-bit arithmetic keeps full double precision: documented limitation, and
  // exactly the kind of thing the clang engine (M7) exists to fix.
  if (type.bits === 0 || type.bits >= 64) return truncated;

  const modulus = 2 ** type.bits;
  let value = ((truncated % modulus) + modulus) % modulus;
  if (type.signed && value >= modulus / 2) value -= modulus;
  return value;
}

export function intValue(type: CType, input: number): Value {
  return { kind: 'int', type, value: truncateInteger(type, input) };
}

export function floatValue(type: CType, input: number): Value {
  return { kind: 'float', type, value: type.kind === 'float' ? Math.fround(input) : input };
}

export function pointerValue(pointee: CType, address: number): Value {
  const type: CType = {
    kind: 'pointer',
    name: `${pointee.name} *`,
    size: 8,
    signed: false,
    bits: 64,
    pointee,
  };
  return { kind: 'pointer', type, address };
}

export function aggregateValue(type: CType, address: number): Value {
  return { kind: 'aggregate', type, address };
}

export function voidValue(): Value {
  return { kind: 'void', type: { kind: 'void', name: 'void', size: 0, signed: false, bits: 0 } };
}

export function uninitValue(type: CType): Value {
  return { kind: 'uninit', type };
}

export function toNumber(value: Value): number {
  switch (value.kind) {
    case 'int':
    case 'float':
      return value.value;
    case 'pointer':
      return value.address;
    case 'aggregate':
      return value.address;
    default:
      return 0;
  }
}

export function toBoolean(value: Value): boolean {
  switch (value.kind) {
    case 'int':
    case 'float':
      return value.value !== 0;
    case 'pointer':
      return value.address !== 0;
    case 'aggregate':
      return true;
    default:
      return false;
  }
}

export function isNullPointer(value: Value): boolean {
  return value.kind === 'pointer' && value.address === 0;
}

/**
 * Address a value contributes when a pointer is required.
 * Arrays decay to a pointer to their first element, exactly like C.
 */
export function toPointerAddress(value: Value): number | null {
  switch (value.kind) {
    case 'pointer':
      return value.address;
    case 'aggregate':
      return value.type.kind === 'array' ? value.address : null;
    case 'int':
      return value.value === 0 ? 0 : null;
    default:
      return null;
  }
}

export function pointeeOf(value: Value): CType | undefined {
  return value.type.pointee;
}

/** Converts a value to `type`, as an assignment or a cast would. */
export function convertTo(type: CType, value: Value): Value {
  if (type.kind === 'void') return voidValue();

  if (type.kind === 'pointer') {
    const address = toPointerAddress(value);
    if (address === null) {
      // A cast of a number to a pointer is legal C; keep the address.
      return { kind: 'pointer', type, address: Math.trunc(toNumber(value)) };
    }
    return { kind: 'pointer', type, address };
  }

  if (isIntegerType(type)) {
    if (value.kind === 'float') return intValue(type, value.value);
    return intValue(type, toNumber(value));
  }

  if (isFloatType(type)) {
    if (value.kind === 'float') return floatValue(type, value.value);
    return floatValue(type, toNumber(value));
  }

  if (type.kind === 'array' && value.kind === 'aggregate') {
    return { kind: 'aggregate', type, address: value.address };
  }

  if ((type.kind === 'struct' || type.kind === 'union') && value.kind === 'aggregate') {
    return { kind: 'aggregate', type, address: value.address };
  }

  return value;
}

function isPrintableAscii(code: number): boolean {
  return code >= 32 && code < 127;
}

/** Human-readable value for the watch pane and hover. */
export function formatValue(value: Value, memory: Memory): string {
  switch (value.kind) {
    case 'int':
      if (value.type.kind === 'bool') return value.value === 0 ? 'false' : 'true';
      if (value.type.kind === 'char') {
        return isPrintableAscii(value.value)
          ? `'${String.fromCharCode(value.value)}' (${value.value})`
          : `${value.value}`;
      }
      return `${value.value}`;
    case 'float': {
      if (Number.isInteger(value.value)) return `${value.value}.0`;
      return `${value.value}`;
    }
    case 'pointer': {
      if (value.address === 0) return 'NULL';
      const address = `0x${value.address.toString(16)}`;
      const pointee = value.type.pointee;
      if (pointee?.kind === 'char' && memory.isValid(value.address, 1)) {
        const text = memory.readCString(value.address, 64);
        return `${address} -> "${text}"`;
      }
      return address;
    }
    case 'aggregate':
      if (value.type.name === 'std::string') {
        const data = memory.readUint64(value.address);
        return `"${data === 0 ? '' : memory.readCString(data, 256)}"`;
      }
      if (value.type.kind === 'array') {
        const length = value.type.length;
        return `${value.type.element?.name ?? '?'}${length === undefined ? '[]' : `[${length}]`} @ 0x${value.address.toString(16)}`;
      }
      return `${value.type.name} @ 0x${value.address.toString(16)}`;
    case 'function':
      return `&${value.name}`;
    case 'uninit':
      return '?';
    case 'void':
      return 'void';
  }
}

export function sameValue(left: Value, right: Value): boolean {
  if (left.kind === 'aggregate' || right.kind === 'aggregate') {
    return toNumber(left) === toNumber(right);
  }
  if (left.kind === 'float' || right.kind === 'float') {
    return toNumber(left) === toNumber(right);
  }
  return toNumber(left) === toNumber(right);
}
