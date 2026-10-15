import type { Expression, TypeRef } from '@/lang/ast';

/**
 * C type model for the interpreter.
 *
 * Types are resolved from the parser's `TypeRef` plus a registry of struct /
 * union / enum / typedef declarations, which is what makes `struct Point`,
 * `size_t` and `Point` all usable in the same program.
 *
 * Layout follows the x86-64 rules that matter here: members are aligned to
 * `min(sizeof, 8)`, and the struct is padded to its own alignment. That is why
 * `sizeof(struct { int x; int y; })` is 8 and not 4+4 by luck.
 */

export type CTypeKind =
  | 'void'
  | 'bool'
  | 'char'
  | 'int'
  | 'float'
  | 'double'
  | 'pointer'
  | 'array'
  | 'struct'
  | 'union'
  | 'enum'
  | 'function'
  | 'unknown';

export interface CTypeMember {
  readonly name: string;
  readonly type: CType;
  readonly offset: number;
  /**
   * Who may touch it.
   *
   * Carried on the layout because that is what a member access has in hand - the
   * struct's CType - and `class` is only `struct` with a different default.
   */
  readonly access?: 'public' | 'private' | 'protected';
}

export interface CType {
  readonly kind: CTypeKind;
  /** Display name, exactly as written in C where possible: `unsigned long`. */
  readonly name: string;
  readonly size: number;
  readonly signed: boolean;
  readonly bits: number;
  readonly pointee?: CType;
  readonly element?: CType;
  /** `undefined` for an incomplete array (`int a[]`). */
  readonly length?: number;
  readonly members?: readonly CTypeMember[];
  readonly returnType?: CType;
  readonly params?: readonly CType[];
  readonly variadic?: boolean;
}

export const VOID_TYPE: CType = { kind: 'void', name: 'void', size: 0, signed: false, bits: 0 };
export const UNKNOWN_TYPE: CType = {
  kind: 'unknown',
  name: 'unknown',
  size: 8,
  signed: false,
  bits: 64,
};

const POINTER_SIZE = 8;

function scalar(kind: CTypeKind, name: string, size: number, signed: boolean): CType {
  return { kind, name, size, signed, bits: size * 8 };
}

const SCALARS: readonly CType[] = [
  scalar('bool', 'bool', 1, false),
  scalar('char', 'char', 1, true),
  scalar('char', 'signed char', 1, true),
  scalar('char', 'unsigned char', 1, false),
  scalar('int', 'short', 2, true),
  scalar('int', 'short int', 2, true),
  scalar('int', 'unsigned short', 2, false),
  scalar('int', 'int', 4, true),
  scalar('int', 'signed', 4, true),
  scalar('int', 'signed int', 4, true),
  scalar('int', 'unsigned', 4, false),
  scalar('int', 'unsigned int', 4, false),
  scalar('int', 'long', 8, true),
  scalar('int', 'long int', 8, true),
  scalar('int', 'unsigned long', 8, false),
  scalar('int', 'long long', 8, true),
  scalar('int', 'long long int', 8, true),
  scalar('int', 'unsigned long long', 8, false),
  scalar('float', 'float', 4, true),
  scalar('double', 'double', 8, true),
  scalar('double', 'long double', 8, true),
];

const SCALAR_BY_NAME = new Map<string, CType>(SCALARS.map((type) => [type.name, type]));

/** Names that resolve to a scalar but are spelled differently on purpose. */
const SCALAR_ALIASES: ReadonlyMap<string, string> = new Map([
  ['_Bool', 'bool'],
  ['size_t', 'unsigned long'],
  ['uint8_t', 'unsigned char'],
  ['uint16_t', 'unsigned short'],
  ['uint32_t', 'unsigned int'],
  ['uint64_t', 'unsigned long'],
  ['uintptr_t', 'unsigned long'],
  ['int8_t', 'signed char'],
  ['int16_t', 'short'],
  ['int32_t', 'int'],
  ['int64_t', 'long'],
  ['ssize_t', 'long'],
  ['ptrdiff_t', 'long'],
  ['time_t', 'long'],
  ['clock_t', 'long'],
  ['wchar_t', 'int'],
  ['char16_t', 'unsigned short'],
  ['char32_t', 'unsigned int'],
]);

const POINTER_BYTES = POINTER_SIZE;

export function alignOf(type: CType): number {
  switch (type.kind) {
    case 'array':
      return type.element ? alignOf(type.element) : 1;
    case 'struct':
    case 'union':
      if (!type.members || type.members.length === 0) return 1;
      return Math.max(...type.members.map((member) => alignOf(member.type)));
    case 'void':
      return 1;
    default:
      return Math.min(Math.max(type.size, 1), 8);
  }
}

export function alignUp(value: number, alignment: number): number {
  if (alignment <= 1) return value;
  return Math.ceil(value / alignment) * alignment;
}

export function isIntegerType(type: CType): boolean {
  return type.kind === 'int' || type.kind === 'char' || type.kind === 'bool' || type.kind === 'enum';
}

export function isFloatType(type: CType): boolean {
  return type.kind === 'float' || type.kind === 'double';
}

export function isNumericType(type: CType): boolean {
  return isIntegerType(type) || isFloatType(type);
}

export function isPointerType(type: CType): boolean {
  return type.kind === 'pointer';
}

export function isAggregateType(type: CType): boolean {
  return type.kind === 'struct' || type.kind === 'union' || type.kind === 'array';
}

export function isScalarType(type: CType): boolean {
  return isNumericType(type) || isPointerType(type);
}

export function pointerTo(pointee: CType): CType {
  return {
    kind: 'pointer',
    name: `${pointee.name} *`,
    size: POINTER_BYTES,
    signed: false,
    bits: POINTER_BYTES * 8,
    pointee,
  };
}

export function arrayOf(element: CType, length: number | undefined): CType {
  const suffix = length === undefined ? '[]' : `[${length}]`;
  return {
    kind: 'array',
    name: `${element.name}${suffix}`,
    size: (element.size ?? 0) * (length ?? 0),
    signed: false,
    bits: 0,
    element,
    ...(length === undefined ? {} : { length }),
  };
}

export function functionType(
  returnType: CType,
  params: readonly CType[],
  variadic: boolean,
): CType {
  return {
    kind: 'function',
    name: `${returnType.name}(...)`,
    size: 0,
    signed: false,
    bits: 0,
    returnType,
    params,
    variadic,
  };
}

/**
 * C++ containers the engine implements natively.
 *
 * They are real memory layouts, not magic: a vector is `{data, size, capacity,
 * elementKind, elementSize}` and a string is `{data, length}`. That is what lets
 * `v[i]`, `v.push_back`, range-based for, `&v` and the watch pane all work
 * through the same code path as ordinary structs.
 *
 * `elementKind` exists because `std::vector<T>` inside a template has no
 * concrete element type at parse time; the vector carries its own descriptor at
 * runtime, which is exactly what a dynamically typed evaluator needs.
 */
export const VECTOR_CONTROL_SIZE = 32;
export const STRING_CONTROL_SIZE = 16;

function controlInteger(name: string, offset: number): CTypeMember {
  return {
    name,
    offset,
    type: { kind: 'int', name: 'long', size: 8, signed: true, bits: 64 },
  };
}

export function vectorType(element: CType): CType {
  return {
    kind: 'struct',
    name: `std::vector<${element.name}>`,
    size: VECTOR_CONTROL_SIZE,
    signed: false,
    bits: 0,
    element,
    members: [
      { name: '__data', offset: 0, type: pointerTo(element) },
      controlInteger('__size', 8),
      controlInteger('__capacity', 16),
      {
        name: '__elementKind',
        offset: 24,
        type: { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 },
      },
      {
        name: '__elementSize',
        offset: 28,
        type: { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 },
      },
    ],
  };
}

export function stringType(): CType {
  const character: CType = { kind: 'char', name: 'char', size: 1, signed: true, bits: 8 };
  return {
    kind: 'struct',
    name: 'std::string',
    size: STRING_CONTROL_SIZE,
    signed: false,
    bits: 0,
    element: character,
    members: [
      { name: '__data', offset: 0, type: pointerTo(character) },
      controlInteger('__length', 8),
    ],
  };
}

/**
 * The containers the engine simulates.
 *
 * All of them share the vector's control block, because that is what lets one set
 * of primitives - indexed access, range-based for, `.size()`, the watch pane's
 * element listing - work for every container instead of seven special cases.
 * `map` stores `std::pair<K, V>` elements kept ordered by key, which is what makes
 * `m[k]`, iteration and the `{key: value}` display fall out of the same machinery.
 */
export type ContainerKind =
  | 'vector'
  | 'set'
  | 'map'
  | 'queue'
  | 'stack'
  | 'deque'
  | 'priority-queue';

const CONTAINER_KINDS: readonly (readonly [string, ContainerKind])[] = [
  ['priority_queue', 'priority-queue'],
  ['unordered_map', 'map'],
  ['unordered_set', 'set'],
  ['vector', 'vector'],
  ['set', 'set'],
  ['map', 'map'],
  ['queue', 'queue'],
  ['stack', 'stack'],
  ['deque', 'deque'],
];

export function containerKindOf(type: CType): ContainerKind | null {
  if (type.kind !== 'struct') return null;
  for (const [name, kind] of CONTAINER_KINDS) {
    if (type.name === `std::${name}` || type.name.startsWith(`std::${name}<`)) return kind;
  }
  return null;
}

export function pairType(first: CType, second: CType): CType {
  const firstSize = Math.max(first.size, 1);
  const offset = alignUp(firstSize, alignOf(second));
  const size = alignUp(offset + Math.max(second.size, 1), Math.max(alignOf(first), alignOf(second)));
  return {
    kind: 'struct',
    name: `std::pair<${first.name}, ${second.name}>`,
    size,
    signed: false,
    bits: 0,

    members: [
      { name: 'first', offset: 0, type: first },
      { name: 'second', offset, type: second },
    ],
  };
}

export function isPairType(type: CType): boolean {
  return type.kind === 'struct' && type.name.startsWith('std::pair<');
}

/** Key and value of a map's element type, or null when it is not a pair. */
export function pairParts(type: CType): { readonly key: CType; readonly value: CType } | null {
  if (!isPairType(type)) return null;
  const first = type.members?.[0]?.type;
  const second = type.members?.[1]?.type;
  return first && second ? { key: first, value: second } : null;
}

function containerType(name: string, element: CType, displayName?: string): CType {
  const base = vectorType(element);
  return { ...base, name: `std::${name}<${displayName ?? element.name}>` };
}

export function isVectorType(type: CType): boolean {
  return type.kind === 'struct' && type.name.startsWith('std::vector<');
}

export function setType(element: CType): CType {
  return containerType('set', element);
}

export function mapType(key: CType, value: CType): CType {
  return containerType('map', pairType(key, value), `${key.name}, ${value.name}`);
}

export function queueType(element: CType): CType {
  return containerType('queue', element);
}

export function stackType(element: CType): CType {
  return containerType('stack', element);
}

export function dequeType(element: CType): CType {
  return containerType('deque', element);
}

export function priorityQueueType(element: CType): CType {
  return containerType('priority_queue', element);
}

/**
 * Splits `int, std::pair<int, int>` on the commas that separate template
 * arguments, leaving the ones nested inside further template arguments alone.
 */
export function splitTemplateArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of text) {
    if (character === '<') depth += 1;
    else if (character === '>') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim().length > 0 || parts.length > 0) parts.push(current);
  return parts;
}

export function isStringType(type: CType): boolean {
  return type.kind === 'struct' && type.name === 'std::string';
}

/** Encodes an element type for the vector's runtime descriptor. */
export function elementKindCode(type: CType): number {
  switch (type.kind) {
    case 'bool':
    case 'char':
      return 1;
    case 'float':
    case 'double':
      return 2;
    case 'pointer':
      return 3;
    case 'int':
    case 'enum':
      return 0;
    default:
      return 4;
  }
}

export function elementTypeFromCode(code: number, size: number): CType {
  switch (code) {
    case 0:
      return size === 8
        ? { kind: 'int', name: 'long', size: 8, signed: true, bits: 64 }
        : { kind: 'int', name: 'int', size: 4, signed: true, bits: 32 };
    case 1:
      return { kind: 'char', name: 'char', size: 1, signed: true, bits: 8 };
    case 2:
      return size === 4
        ? { kind: 'float', name: 'float', size: 4, signed: true, bits: 32 }
        : { kind: 'double', name: 'double', size: 8, signed: true, bits: 64 };
    case 3:
      return pointerTo(VOID_TYPE);
    default:
      return { kind: 'int', name: 'int', size: Math.max(size, 4), signed: true, bits: 32 };
  }
}

export function memberOf(type: CType, name: string): CTypeMember | undefined {
  return type.members?.find((member) => member.name === name);
}

/**
 * Array length from a declarator. Only literals are folded here; an array sized
 * by a constant expression or by its initializer gets its length at declaration
 * time inside the interpreter.
 */
function constantArrayLength(expression: Expression | undefined): number | undefined {
  if (!expression || expression.kind !== 'literal' || expression.literal !== 'number') {
    return undefined;
  }
  const value = Number.parseInt(expression.text.replace(/[uUlL]+$/, ''), 10);
  return Number.isNaN(value) || value < 0 ? undefined : value;
}

/** `struct Point` -> `Point`, so both spellings can hit the same registry entry. */
export function bareTagName(name: string): string {
  return name.replace(/^(struct|union|enum)\s+/, '').trim();
}

function stripQualifiers(name: string): string {
  return name
    .replace(/\b(const|volatile|restrict|static|extern|inline|register|auto|typedef|_Atomic)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export class TypeResolver {
  private readonly tags = new Map<string, CType>();
  private readonly typedefs = new Map<string, TypeRef>();
  private readonly enums = new Map<string, CType>();
  private readonly unknown = new Set<string>();

  /** Types that could not be resolved, reported once each by the caller. */
  get unknownTypes(): readonly string[] {
    return [...this.unknown];
  }

  registerStruct(
    tag: string | undefined,
    members: readonly {
      readonly name: string;
      readonly type: TypeRef;
      readonly access?: 'public' | 'private' | 'protected';
    }[],
    isUnion: boolean,
  ): CType {
    const laid = this.layout(members, isUnion, tag);
    if (tag !== undefined) {
      this.tags.set(tag, laid);
      this.tags.set(`${isUnion ? 'union' : 'struct'} ${tag}`, laid);
    }
    return laid;
  }

  registerTypedef(name: string, target: TypeRef): void {
    this.typedefs.set(name, target);
  }

  registerEnum(tag: string | undefined): CType {
    const type: CType = {
      kind: 'enum',
      name: tag ? `enum ${tag}` : 'enum',
      size: 4,
      signed: true,
      bits: 32,
    };
    if (tag !== undefined) {
      this.enums.set(tag, type);
      this.enums.set(`enum ${tag}`, type);
    }
    return type;
  }

  lookupTag(tag: string): CType | undefined {
    return this.tags.get(tag) ?? this.enums.get(tag);
  }

  private layout(
    members: readonly {
      readonly name: string;
      readonly type: TypeRef;
      readonly access?: 'public' | 'private' | 'protected';
    }[],
    isUnion: boolean,
    tag: string | undefined,
  ): CType {
    const laid: CTypeMember[] = [];
    let offset = 0;
    let maxAlign = 1;

    for (const member of members) {
      const memberType = this.resolve(member.type);
      const alignment = alignOf(memberType);
      maxAlign = Math.max(maxAlign, alignment);
      const memberOffset = isUnion ? 0 : alignUp(offset, alignment);
      laid.push({
        name: member.name,
        type: memberType,
        offset: memberOffset,
        ...(member.access ? { access: member.access } : {}),
      });
      offset = isUnion
        ? Math.max(offset, memberType.size)
        : memberOffset + memberType.size;
    }

    const size = members.length === 0 ? 0 : alignUp(offset, maxAlign);
    return {
      kind: isUnion ? 'union' : 'struct',
      name: tag ? `${isUnion ? 'union' : 'struct'} ${tag}` : isUnion ? 'union' : 'struct',
      size,
      signed: false,
      bits: 0,
      members: laid,
    };
  }

  resolve(ref: TypeRef, depth = 0): CType {
    if (depth > 16) return UNKNOWN_TYPE;

    switch (ref.kind) {
      case 'pointer': {
        const pointee = ref.pointee ? this.resolve(ref.pointee, depth + 1) : VOID_TYPE;
        return pointerTo(pointee);
      }
      case 'array': {
        const element = ref.element ? this.resolve(ref.element, depth + 1) : UNKNOWN_TYPE;
        return arrayOf(element, constantArrayLength(ref.arrayLength));
      }
      case 'function': {
        const returnType = ref.returnType ? this.resolve(ref.returnType, depth + 1) : VOID_TYPE;
        const params = (ref.params ?? []).map((param) => this.resolve(param.type, depth + 1));
        return functionType(returnType, params, ref.variadic === true);
      }
      default:
        break;
    }

    return this.resolveByName(ref.name, depth);
  }

  resolveByName(rawName: string, depth = 0): CType {
    /*
     * `auto` is not a type yet - the value it is given decides. Stripping the
     * keyword and falling through to the empty-name default returned `int`, the
     * guess the parser's own comment forbids, and it silently turned an `auto`
     * iterator into a number: `end() - begin()` then reported bytes, not elements.
     */
    if (/\bauto\b/.test(rawName)) return { ...UNKNOWN_TYPE, name: 'auto' };

    const name = stripQualifiers(rawName);
    if (name.length === 0) return SCALAR_BY_NAME.get('int') ?? UNKNOWN_TYPE;

    if (name.startsWith('struct ') || name.startsWith('union ') || name.startsWith('enum ')) {
      const found = this.tags.get(name) ?? this.enums.get(name);
      if (found) return found;
      const bare = bareTagName(name);
      const byBare = this.tags.get(bare) ?? this.enums.get(bare);
      if (byBare) return byBare;
      // A tag that is only ever used as a pointer is fine as an opaque type.
      return { kind: 'unknown', name, size: 1, signed: false, bits: 8 };
    }

    const direct = SCALAR_BY_NAME.get(name);
    if (direct) return direct;

    /*
     * A tag used without the `struct` keyword: `shapes::Point p;` rather than
     * `struct shapes::Point p;`. Both spellings name the same type, so the tagged
     * registrations are tried before giving up - a namespaced struct otherwise resolved
     * to an opaque type and its members became unreachable.
     */
    for (const prefix of ['struct ', 'union ', 'enum ']) {
      const tagged = this.tags.get(`${prefix}${name}`) ?? this.enums.get(`${prefix}${name}`);
      if (tagged) return tagged;
    }

    const alias = SCALAR_ALIASES.get(name);
    if (alias) {
      const aliased = SCALAR_BY_NAME.get(alias);
      if (aliased) return aliased;
    }

    const typedef = this.typedefs.get(name);
    if (typedef) {
      const resolved = this.resolve(typedef, depth + 1);
      /*
       * Keep the typedef's own spelling for display - except for the types whose name
       * decides how they behave. `using str = std::string;` must stay a string, and
       * renaming it to `str` made `isStringType` false: the value was then stored as
       * raw bytes and the pane showed an address instead of the text.
       */
      const behavioural =
        isStringType(resolved) ||
        isPairType(resolved) ||
        containerKindOf(resolved) !== null ||
        resolved.kind === 'array' ||
        resolved.kind === 'pointer';
      if (behavioural || resolved.name === name) return resolved;
      return { ...resolved, name };
    }

    const enumType = this.enums.get(name);
    if (enumType) return enumType;

    // C++ containers the engine resolves itself, so no diagnostic is needed.
    const containerMatch =
      /^(?:std::)?(vector|set|map|queue|stack|deque|priority_queue|unordered_set|unordered_map)\s*<(.+)>$/.exec(
        name,
      );
    if (containerMatch) {
      const containerName = containerMatch[1] ?? 'vector';
      const argumentText = containerMatch[2] ?? 'int';
      const args = splitTemplateArguments(argumentText);

      if (containerName === 'map' || containerName === 'unordered_map') {
        const key = this.resolveByName((args[0] ?? 'int').trim(), depth + 1);
        const value = this.resolveByName((args[1] ?? 'int').trim(), depth + 1);
        const type = mapType(key, value);
        /*
         * The unordered containers share the ordered layout deliberately: the
         * standard promises no iteration order, so showing a deterministic one is
         * conformant. Their bucket and hash APIs are not implemented, and a call to
         * one says so rather than returning something invented.
         */
        return containerName === 'unordered_map'
          ? { ...type, name: `std::unordered_map<${key.name}, ${value.name}>` }
          : type;
      }

      const resolved = this.resolveByName((args[0] ?? 'int').trim(), depth + 1);
      switch (containerName) {
        case 'set':
          return setType(resolved);
        case 'unordered_set':
          return { ...setType(resolved), name: `std::unordered_set<${resolved.name}>` };
        case 'queue':
          return queueType(resolved);
        case 'stack':
          return stackType(resolved);
        case 'deque':
          return dequeType(resolved);
        case 'priority_queue':
          return priorityQueueType(resolved);
        default:
          return vectorType(resolved);
      }
    }
    const pairMatch = /^(?:std::)?pair\s*<(.+)>$/.exec(name);    if (pairMatch) {
      const args = splitTemplateArguments(pairMatch[1] ?? 'int, int');
      const first = this.resolveByName((args[0] ?? 'int').trim(), depth + 1);
      const second = this.resolveByName((args[1] ?? 'int').trim(), depth + 1);
      return pairType(first, second);
    }

    /*
     * `std::function<int(int)>` is a callable held in a variable: eight bytes of closure,
     * which is what a lambda is here too. The name is kept for the watch pane, and what
     * it wraps is a call the engine makes itself.
     */
    if (/^(?:std::)?function\s*</.test(name)) {
      return { kind: 'pointer', name, size: 8, signed: false, bits: 64, pointee: VOID_TYPE };
    }

    if (name === 'std::string' || name === 'string') return stringType();
    if (name === 'std::ostream' || name === 'std::istream' || name === 'std::iostream') {
      return { kind: 'unknown', name, size: 1, signed: false, bits: 8 };
    }

    // Opaque handles the standard library exposes without a definition.
    if (name === 'FILE' || name === 'va_list' || name === 'struct _IO_FILE') {
      return { kind: 'unknown', name, size: 1, signed: false, bits: 8 };
    }

    this.unknown.add(name);
    return { ...UNKNOWN_TYPE, name };
  }
}
