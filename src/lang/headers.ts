/**
 * Built-in headers.
 *
 * The fast engine has no filesystem, so `#include <...>` resolves against this
 * table instead of disk. The declarations here are exactly the surface the M2
 * interpreter implements, which keeps the two in sync: if a prototype is listed,
 * it is callable; if it is missing, the user gets a real "not declared" error
 * instead of a silent wrong answer.
 *
 * C++ standard-library headers are listed separately so a C++ file gets an
 * *informational* note ("Run uses clang-wasm") rather than a red error.
 */

/** Always injected before the user's file: the typedefs any header relies on. */
export const PRELUDE_LABEL = '<builtin>';
export const PRELUDE_SOURCE = `typedef unsigned long size_t;
typedef long ptrdiff_t;
typedef long ssize_t;
typedef long time_t;
typedef __builtin_va_list va_list;
typedef struct _IO_FILE FILE;
`;

const STDIO_H = `extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

int printf(const char *format, ...);
int fprintf(FILE *stream, const char *format, ...);
int sprintf(char *str, const char *format, ...);
int snprintf(char *str, size_t size, const char *format, ...);
int puts(const char *s);
int putchar(int c);
int getchar(void);
int scanf(const char *format, ...);
int sscanf(const char *str, const char *format, ...);
int fflush(FILE *stream);
void perror(const char *s);
`;

const STDLIB_H = `#define NULL ((void *)0)
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 32767

void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
void exit(int status) __attribute__((noreturn));
int atoi(const char *str);
long atol(const char *str);
double atof(const char *str);
long strtol(const char *str, char **endptr, int base);
unsigned long strtoul(const char *str, char **endptr, int base);
int abs(int value);
long labs(long value);
int rand(void);
void srand(unsigned int seed);
void qsort(void *base, size_t count, size_t size, int (*compare)(const void *, const void *));
`;

const STRING_H = `void *memcpy(void *dest, const void *src, size_t count);
void *memmove(void *dest, const void *src, size_t count);
void *memset(void *dest, int value, size_t count);
int memcmp(const void *left, const void *right, size_t count);
size_t strlen(const char *str);
char *strcpy(char *dest, const char *src);
char *strncpy(char *dest, const char *src, size_t count);
char *strcat(char *dest, const char *src);
int strcmp(const char *left, const char *right);
int strncmp(const char *left, const char *right, size_t count);
char *strchr(const char *str, int ch);
char *strrchr(const char *str, int ch);
char *strstr(const char *haystack, const char *needle);
char *strtok(char *str, const char *delimiters);
char *strdup(const char *str);
`;

const MATH_H = `#define M_PI 3.14159265358979323846
#define M_E 2.71828182845904523536

double sqrt(double x);
double pow(double base, double exponent);
double fabs(double x);
double floor(double x);
double ceil(double x);
double round(double x);
double fmod(double x, double y);
double exp(double x);
double log(double x);
double log10(double x);
double sin(double x);
double cos(double x);
double tan(double x);
double atan2(double y, double x);
double hypot(double x, double y);
int isnan(double x);
int isinf(double x);
`;

const CTYPE_H = `int isalnum(int ch);
int isalpha(int ch);
int isdigit(int ch);
int isspace(int ch);
int isupper(int ch);
int islower(int ch);
int ispunct(int ch);
int toupper(int ch);
int tolower(int ch);
`;

const STDBOOL_H = `#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
`;

const STDINT_H = `#define INT8_MIN (-128)
#define INT8_MAX 127
#define INT16_MAX 32767
#define INT32_MAX 2147483647
#define INT32_MIN (-2147483647 - 1)
#define INT64_MAX 9223372036854775807L
#define UINT32_MAX 4294967295U
#define UINT64_MAX 18446744073709551615UL
`;

const LIMITS_H = `#define CHAR_BIT 8
#define CHAR_MIN (-128)
#define CHAR_MAX 127
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-9223372036854775807L - 1)
#define LONG_MAX 9223372036854775807L
#define ULONG_MAX 18446744073709551615UL
#define LLONG_MAX 9223372036854775807LL
#define FLT_MAX 3.402823466e+38F
#define DBL_MAX 1.7976931348623157e+308
`;

const ASSERT_H = `void __assert_fail(const char *expression, const char *file, unsigned int line);
#define assert(expression) ((expression) ? (void)0 : __assert_fail(#expression, __FILE__, __LINE__))
`;

const TIME_H = `struct tm {
    int tm_sec;
    int tm_min;
    int tm_hour;
    int tm_mday;
    int tm_mon;
    int tm_year;
    int tm_wday;
    int tm_yday;
    int tm_isdst;
};

typedef long clock_t;
#define CLOCKS_PER_SEC 1000000L

clock_t clock(void);
time_t time(time_t *result);
struct tm *localtime(const time_t *timer);
`;

/**
 * C++ standard headers the fast engine resolves natively.
 *
 * These used to produce a "cannot run on the fast engine" note. They are now
 * real: the C wrappers map onto their C header, and the C++ library headers are
 * backed by the engine itself (`std::cout`, `std::vector`, `std::string`,
 * `std::sort`, range-based for), so no diagnostic is needed.
 */
const CPP_HEADER_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  // C library, C++ spelling.
  ['cstdio', 'stdio.h'],
  ['cstdlib', 'stdlib.h'],
  ['cstring', 'string.h'],
  ['cmath', 'math.h'],
  ['cctype', 'ctype.h'],
  ['climits', 'limits.h'],
  ['cstdint', 'stdint.h'],
  ['cassert', 'assert.h'],
  ['ctime', 'time.h'],
  ['cstddef', 'stddef.h'],
  ['cfloat', 'limits.h'],
  ['cerrno', ''],
  ['csignal', ''],
  // Streams, containers and algorithms implemented by the interpreter.
  ['iostream', ''],
  ['istream', ''],
  ['ostream', ''],
  ['ios', ''],
  ['sstream', ''],
  ['fstream', ''],
  ['iomanip', ''],
  ['vector', ''],
  ['string', ''],
  ['string_view', ''],
  ['algorithm', ''],
  ['utility', ''],
  ['functional', ''],
  ['numeric', ''],
  ['iterator', ''],
  ['memory', ''],
  ['map', ''],
  ['set', ''],
  ['unordered_map', ''],
  ['unordered_set', ''],
  ['queue', ''],
  ['stack', ''],
  ['deque', ''],
  ['list', ''],
  ['array', ''],
  ['bitset', ''],
  ['tuple', ''],
  ['limits', ''],
  ['type_traits', ''],
  ['optional', ''],
  ['variant', ''],
  ['ranges', ''],
  ['bit', ''],
  ['format', ''],
  ['random', ''],
  ['chrono', ''],
  ['thread', ''],
  ['mutex', ''],
  ['atomic', ''],
  ['regex', ''],
  ['complex', ''],
  ['valarray', ''],
  ['exception', ''],
  ['stdexcept', ''],
  ['typeinfo', ''],
  ['new', ''],
  ['numbers', ''],
  ['concepts', ''],
  ['coroutine', ''],
  ['compare', ''],
  ['span', ''],
  ['filesystem', ''],
  ['forward_list', ''],
  ['any', ''],
  ['charconv', ''],
  ['scoped_allocator', ''],
  ['typeindex', ''],
  ['system_error', ''],
  ['future', ''],
  ['condition_variable', ''],
  ['shared_mutex', ''],
  ['cstdbool', 'stdbool.h'],
  ['ciso646', ''],
  ['clocale', ''],
  ['csetjmp', ''],
  ['cstdarg', 'stdarg.h'],
  ['cuchar', ''],
  ['cwchar', ''],
  ['cwctype', ''],
]);

export const BITS_HEADER_NOTE =
  'bits/stdc++.h: the built-in C library and the engine\'s C++ surface (iostream, vector, string, algorithm) are available';

/**
 * `bits/stdc++.h`: the GCC/libstdc++ "everything" header competitive
 * programmers expect. It maps onto the whole built-in C surface, and the C++
 * library that the engine implements natively (streams, vector, string,
 * algorithm) needs no declaration at all.
 */
const BITS_STDC_H = `/* Built-in bundle: the C library surface of <bits/stdc++.h>. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include <assert.h>
#include <time.h>
`;

export function headerLabel(name: string): string {
  return `<${name}>`;
}

/** Recognised `#include <...>` names, keyed by the exact spelling used in source. */
export const BUILTIN_HEADERS: ReadonlyMap<string, string> = new Map<string, string>([
  ['stdio.h', STDIO_H],
  ['stdlib.h', STDLIB_H],
  ['string.h', STRING_H],
  ['math.h', MATH_H],
  ['ctype.h', CTYPE_H],
  ['stdbool.h', STDBOOL_H],
  ['stdint.h', STDINT_H],
  ['limits.h', LIMITS_H],
  ['assert.h', ASSERT_H],
  ['time.h', TIME_H],
  ['stddef.h', ''],
  ['stdarg.h', ''],
  ['bits/stdc++.h', BITS_STDC_H],
  ['stdc++.h', BITS_STDC_H],
]);

/**
 * C++ headers the engine serves natively (streams, containers, algorithms).
 * They have no source text: the interpreter implements their surface, so the
 * include is accepted silently instead of being reported as unsupported.
 */
export const CPP_NATIVE_HEADERS: ReadonlySet<string> = new Set<string>(
  [...CPP_HEADER_ALIASES].filter(([, target]) => target === '').map(([name]) => name),
);

/** Header names whose C surface is inlined by `<bits/stdc++.h>`. */
const BITS_TARGETS: readonly string[] = [
  'stdio.h',
  'stdlib.h',
  'string.h',
  'math.h',
  'ctype.h',
  'stdbool.h',
  'stdint.h',
  'limits.h',
  'assert.h',
  'time.h',
];

/** Every header name the engine recognises, for `#include <` completion. */
export function knownHeaderNames(): readonly string[] {
  return [...new Set([...BUILTIN_HEADERS.keys(), ...CPP_NATIVE_HEADERS])].sort();
}

/** True for a header whose content is an alias of another built-in header. */
export function headerAliasTarget(name: string): string | undefined {
  const target = CPP_HEADER_ALIASES.get(name);
  if (target === undefined) return undefined;
  return BITS_TARGETS.includes(target) ? target : undefined;
}

/**
 * Pre-included when `implicitHeaders` is on (the default): printf & friends work
 * without writing a single #include, which is how a scratchpad editor is
 * expected to behave. Every entry is registered in the include-once set, so a
 * later explicit `#include <stdio.h>` is a harmless no-op rather than a
 * duplicate declaration.
 */
export const IMPLICIT_HEADER_NAMES: readonly string[] = [
  'stddef.h',
  'stdbool.h',
  'stdint.h',
  'limits.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'math.h',
  'ctype.h',
  'assert.h',
  'time.h',
];

/** Every virtual document the editor can peek into, keyed by its label. */
export function builtinHeaderSources(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  map.set(PRELUDE_LABEL, PRELUDE_SOURCE);
  for (const [name, source] of BUILTIN_HEADERS) {
    map.set(headerLabel(name), source);
  }
  return map;
}
