/**
 * Keyword tables.
 *
 * The lexer only classifies; it never decides what the parser supports. C++-only
 * keywords are tracked separately so the parser can report "this is a C++ feature
 * the fast engine cannot execute yet" instead of a misleading syntax error.
 */

const C_KEYWORDS: readonly string[] = [
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic', '_Noreturn',
  '_Static_assert', '_Thread_local',
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
];

const CPP_KEYWORDS: readonly string[] = [
  'alignas', 'alignof', 'and', 'and_eq', 'bitand', 'bitor', 'bool', 'catch', 'char16_t',
  'char32_t', 'class', 'compl', 'concept', 'consteval', 'constexpr', 'constinit',
  'const_cast', 'co_await', 'co_return', 'co_yield', 'decltype', 'delete', 'dynamic_cast',
  'explicit', 'export', 'false', 'friend', 'mutable', 'namespace', 'new', 'noexcept',
  'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public',
  'reinterpret_cast', 'requires', 'static_assert', 'static_cast', 'template', 'this',
  'thread_local', 'throw', 'true', 'try', 'typeid', 'typename', 'using', 'virtual',
  'wchar_t', 'xor', 'xor_eq',
];

export const KEYWORDS: ReadonlySet<string> = new Set([...C_KEYWORDS, ...CPP_KEYWORDS]);

/** C++ constructs the fast engine deliberately does not execute (M2+ uses clang-wasm). */
export const CPP_ONLY_KEYWORDS: ReadonlySet<string> = new Set([
  'class', 'template', 'namespace', 'typename', 'using', 'public', 'private', 'protected',
  'virtual', 'friend', 'operator', 'explicit', 'mutable', 'constexpr', 'consteval',
  'decltype', 'noexcept', 'throw', 'try', 'catch', 'new', 'delete', 'this', 'nullptr',
  'dynamic_cast', 'static_cast', 'reinterpret_cast', 'const_cast', 'typeid', 'concept',
  'requires', 'co_await', 'co_return', 'co_yield', 'export',
]);

/** Type-ish names usable without a declaration in either language. */
export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'bool', '_Bool', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t', 'char16_t', 'char32_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'intptr_t', 'uintptr_t', 'NULL', 'FILE', 'va_list', 'time_t',
]);

/**
 * Standard library types the engine simulates, by their bare names.
 *
 * Used to recognise `string s;` once a `using namespace std;` has brought the name into
 * scope - the same thing a native compiler requires, which is why this set is separate
 * from the container list in the type resolver.
 */
export const STD_TYPE_NAMES: ReadonlySet<string> = new Set([
  'string', 'wstring',
  'vector', 'deque', 'list', 'forward_list',
  'set', 'multiset', 'unordered_set',
  'map', 'multimap', 'unordered_map',
  'stack', 'queue', 'priority_queue',
  'pair', 'tuple', 'array', 'optional', 'variant', 'complex',
  'ostream', 'istream', 'iostream', 'stringstream',
  'function', 'initializer_list',
]);

export function isKeyword(text: string): boolean {
  return KEYWORDS.has(text);
}

export function isCppOnlyKeyword(text: string): boolean {
  return CPP_ONLY_KEYWORDS.has(text);
}

export function isBuiltinTypeName(text: string): boolean {
  return BUILTIN_TYPE_NAMES.has(text);
}
