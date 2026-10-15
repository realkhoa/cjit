import type { Diagnostic } from '@/engine/types';
import type {
  CompoundStmt,
  Declaration,
  EnumeratorDecl,
  Expression,
  FunctionDeclNode,
  InitListExpr,
  MemberDecl,
  ParamDecl,
  Statement,
  StorageClass,
  TranslationUnit,
  TypeRef,
  UnknownDeclNode,
} from '@/lang/ast';
import { makeDiagnostic } from '@/lang/diagnostics';
import { BUILTIN_TYPE_NAMES, STD_TYPE_NAMES, isCppOnlyKeyword } from '@/lang/keywords';
import type { SourcePos, Token } from '@/lang/token';

/**
 * Recursive-descent parser for the C-family subset the fast engine executes.
 *
 * Two things matter more than coverage here:
 *
 *  1. **Error recovery.** This parser runs on every 1s debounce while the user is
 *     mid-edit, so it must always return a usable tree plus a bounded number of
 *     diagnostics. It never throws, always makes progress, and resyncs on `;`/`}`.
 *
 *  2. **Honest C++ handling.** The default sample uses `vector`, `iostream` and a
 *     function template. Those get *one* clear "not executable on the fast
 *     engine" note and a skipped node - not forty cascading syntax errors, and
 *     never a wrong success.
 */

const TYPE_QUALIFIERS: ReadonlySet<string> = new Set([
  'const', 'volatile', 'restrict', '_Atomic', 'constexpr', 'consteval', 'constinit',
]);

const STORAGE_CLASSES: ReadonlySet<string> = new Set([
  'static', 'extern', 'register', 'auto', 'inline', 'typedef', '_Thread_local', 'thread_local',
]);

const BUILTIN_TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  '_Bool', 'bool', 'wchar_t', 'char16_t', 'char32_t', '_Complex', '__builtin_va_list',
]);

const ASSIGN_OPERATORS: ReadonlySet<string> = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
]);

const PREFIX_OPERATORS: ReadonlySet<string> = new Set(['+', '-', '!', '~', '*', '&', '++', '--']);

const BINARY_PRECEDENCE: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

const MAX_DEPTH = 160;

export interface ParseResult {
  readonly unit: TranslationUnit;
  readonly diagnostics: readonly Diagnostic[];
  /** Names registered by `typedef`, needed to disambiguate later declarations. */
  readonly typedefs: ReadonlySet<string>;
}

interface Specifiers {
  readonly type: TypeRef;
  readonly storage: readonly StorageClass[];
  readonly consumed: boolean;
  readonly start: SourcePos;
  readonly elaborated: readonly Declaration[];
}

interface Declarator {
  readonly name?: string;
  readonly type: TypeRef;
}

export function parse(tokens: readonly Token[], file: string): ParseResult {
  return new Parser(tokens, file).parseTranslationUnit();
}

class Parser {
  private index = 0;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly typedefs = new Set<string>(BUILTIN_TYPE_NAMES);
  private readonly tags = new Set<string>();
  /** Set by `using namespace std;`, so bare standard type names parse. */
  private usingNamespaceStd = false;
  /** Names from `using std::string;` and friends. */
  private readonly usingNames = new Set<string>();
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly file: string,
  ) {}

  parseTranslationUnit(): ParseResult {
    const declarations: Declaration[] = [];
    const first = this.peek();
    const start = first.start;

    while (!this.atEnd()) {
      const before = this.index;
      const parsed = this.parseDeclarationList();
      for (const declaration of parsed) declarations.push(declaration);
      if (this.index === before) this.advance();
    }

    return {
      unit: {
        kind: 'translation-unit',
        declarations,
        start,
        end: this.peek().end,
      },
      diagnostics: this.diagnostics,
      typedefs: this.typedefs,
    };
  }

  // ---------------------------------------------------------------- tokens

  private peek(offset = 0): Token {
    const token = this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1];
    if (token) return token;
    const fallback: Token = {
      kind: 'eof',
      text: '',
      start: { offset: 0, line: 1, column: 1, file: this.file },
      end: { offset: 0, line: 1, column: 1, file: this.file },
      atLineStart: false,
      hasLeadingSpace: false,
      includeDepth: 0,
      file: this.file,
    };
    return fallback;
  }

  private tokenAt(index: number): Token | undefined {
    return this.tokens[index];
  }

  private atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  private advance(): Token {
    const token = this.peek();
    if (!this.atEnd()) this.index += 1;
    return token;
  }

  private check(text: string): boolean {
    return this.peek().text === text;
  }

  private previousEnd(): SourcePos {
    return (this.tokens[this.index - 1] ?? this.peek()).end;
  }

  private previousStart(): SourcePos {
    return (this.tokens[this.index - 1] ?? this.peek()).start;
  }

  private isNameToken(token: Token | undefined): boolean {
    return token !== undefined && (token.kind === 'identifier' || token.kind === 'keyword');
  }

  private error(token: Token, message: string): void {
    this.diagnostics.push(
      makeDiagnostic('error', message, token.file, token.start, token.end),
    );
  }

  private warn(token: Token, message: string): void {
    this.diagnostics.push(
      makeDiagnostic('warning', message, token.file, token.start, token.end),
    );
  }

  private expect(text: string, message: string): Token | undefined {
    if (this.check(text)) return this.advance();
    this.error(this.peek(), message);
    return undefined;
  }

  // ----------------------------------------------------------- type system

  private typeRef(kind: TypeRef['kind'], name: string, start: SourcePos, end: SourcePos): TypeRef {
    return { kind, name, qualifiers: [], start, end };
  }

  private wrapPointer(pointee: TypeRef, start: SourcePos, end: SourcePos): TypeRef {
    return {
      kind: 'pointer',
      name: `${pointee.name} *`,
      qualifiers: [],
      pointee,
      start,
      end,
    };
  }

  private isTypeSpecifierToken(token: Token | undefined): boolean {
    if (token === undefined) return false;
    if (token.kind === 'keyword') {
      return (
        BUILTIN_TYPE_KEYWORDS.has(token.text) ||
        TYPE_QUALIFIERS.has(token.text) ||
        STORAGE_CLASSES.has(token.text) ||
        token.text === 'struct' ||
        token.text === 'union' ||
        token.text === 'enum'
      );
    }
    if (token.kind === 'identifier') return this.typedefs.has(token.text);
    return false;
  }

  private isDeclarationStart(): boolean {
    // A leading `const`/`static`/... is always a declaration in C; so is a known
    // type name. `foo * bar;` only becomes a declaration when `foo` is a typedef,
    // which is exactly the classic C ambiguity and why typedefs are tracked.
    if (this.isTypeSpecifierToken(this.peek())) return true;
    // `using namespace std;` and `using std::cout;` change which names resolve, so
    // they are declarations rather than expressions - otherwise `using` is read as an
    // identifier and the line fails as a malformed expression.
    if (this.check('using')) return true;
    // C++ spellings the engine resolves itself: `std::vector<int> v;`, `std::string s;`.
    // An *unqualified* standard name only counts once a `using` has brought it into
    // scope, which is what a native compiler requires too.
    return (
      this.templateDeclarationAhead() || this.qualifiedTypeAhead() || this.importedTypeAhead()
    );
  }

  /**
   * `string s;`, `map<int, int> counts;` after `using namespace std;` - or after
   * `using std::string;` for that one name.
   */
  private importedTypeAhead(): boolean {
    const token = this.peek();
    if (token.kind !== 'identifier' && token.kind !== 'keyword') return false;
    if (!STD_TYPE_NAMES.has(token.text)) return false;
    if (!this.usingNamespaceStd && !this.usingNames.has(token.text)) return false;

    // A type name on its own is not a declaration: something has to be declared.
    const next = this.tokenAt(this.index + 1);
    return next !== undefined && (this.isNameToken(next) || next.text === '*' || next.text === '&');
  }

  /**
   * Consumes a `template <...>` header and registers its parameters as usable
   * type names, so the declaration that follows parses normally and the engine
   * can execute it with runtime types.
   */
  private parseTemplateHeader(): void {
    if (!this.check('template')) return;
    this.advance();
    if (!this.check('<')) return;
    this.advance();

    let depth = 1;
    let expectParameter = false;
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.text === '<') {
        depth += 1;
        this.advance();
        continue;
      }
      if (token.text === '>' || token.text === '>>') {
        depth -= token.text === '>>' ? 2 : 1;
        this.advance();
        if (depth <= 0) break;
        continue;
      }
      if (token.text === 'typename' || token.text === 'class') {
        expectParameter = true;
        this.advance();
        continue;
      }
      if (expectParameter && (token.kind === 'identifier' || token.kind === 'keyword')) {
        // The parameter is a type name from here on: `T total{};` must parse.
        this.typedefs.add(token.text);
        expectParameter = false;
        this.advance();
        continue;
      }
      this.advance();
    }
  }

  /** Consumes a `<...>` argument list and returns its canonical inner text. */
  private templateArgumentsText(): string {
    if (!this.check('<')) return '';
    this.advance();

    let depth = 1;
    const parts: string[] = [];
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.text === '<') {
        depth += 1;
        parts.push('<');
        this.advance();
        continue;
      }
      if (token.text === '>') {
        depth -= 1;
        this.advance();
        if (depth === 0) break;
        parts.push('>');
        continue;
      }
      if (token.text === '>>') {
        depth -= 2;
        this.advance();
        if (depth <= 0) break;
        parts.push('>>');
        continue;
      }
      if (token.text === ';' || token.text === '{' || token.kind === 'eof') break;
      parts.push(token.text);
      this.advance();
    }

    return parts
      .join(' ')
      .replace(/\s*(::|[<>,])\s*/g, '$1')
      .trim();
  }

  private parseDeclarationSpecifiers(): Specifiers {
    const qualifiers: string[] = [];
    const storage: StorageClass[] = [];
    const elaborated: Declaration[] = [];
    const parts: string[] = [];
    let consumed = false;
    let sawConcreteType = false;
    const start = this.peek().start;
    let kind: TypeRef['kind'] = 'builtin';

    for (;;) {
      const token = this.peek();

      if (token.kind === 'keyword' && TYPE_QUALIFIERS.has(token.text)) {
        qualifiers.push(token.text);
        parts.push(token.text);
        consumed = true;
        this.advance();
        continue;
      }

      if (token.kind === 'keyword' && STORAGE_CLASSES.has(token.text)) {
        if (token.text === 'auto') {
          // Keep `auto` visible as the declared type: claiming `int` here would be
          // a guess, and the watch pane must never show a guessed type.
          parts.push('auto');
        } else {
          storage.push(token.text as StorageClass);
        }
        consumed = true;
        this.advance();
        continue;
      }

      if (token.kind === 'keyword' && (token.text === 'struct' || token.text === 'union' || token.text === 'enum')) {
        consumed = true;
        sawConcreteType = true;
        const node =
          token.text === 'enum' ? this.parseEnumSpecifier() : this.parseStructSpecifier(token.text === 'union');
        if (node) {
          elaborated.push(node);
          parts.push('tag' in node && node.tag ? `${token.text} ${node.tag}` : token.text);
          kind = 'named';
        }
        continue;
      }

      // Built-in type names are lexed as identifiers, not keywords: they are not
      // reserved words in either language. `size_t`, `FILE`, `__builtin_va_list`.
      if (
        (token.kind === 'keyword' || token.kind === 'identifier') &&
        BUILTIN_TYPE_KEYWORDS.has(token.text) &&
        !(token.kind === 'identifier' && this.typedefs.has(token.text))
      ) {
        consumed = true;
        sawConcreteType = true;
        parts.push(token.text);
        this.advance();
        continue;
      }

      // Qualified or templated C++ type: `std::string`, `std::vector<int>`,
      // `vector<T>`. The engine resolves these at runtime, so they are parsed as
      // ordinary named types instead of being skipped.
      const nextText = this.tokenAt(this.index + 1)?.text;
      const qualifiedOrTemplated = nextText === '::' || nextText === '<';
      // A bare standard name, once a `using` has put it in scope: `string s;`. Without
      // that a native compiler rejects it too, and so does this.
      const importedStd =
        STD_TYPE_NAMES.has(token.text) &&
        (this.usingNamespaceStd || this.usingNames.has(token.text));

      if (
        (token.kind === 'identifier' || token.kind === 'keyword') &&
        (qualifiedOrTemplated || importedStd)
      ) {
        let name = token.text;
        this.advance();
        while (this.check('::')) {
          this.advance();
          const part = this.peek();
          if (this.isNameToken(part)) {
            name += `::${part.text}`;
            this.advance();
          }
        }
        if (this.check('<')) name += `<${this.templateArgumentsText()}>`;

        consumed = true;
        sawConcreteType = true;
        parts.length = 0;
        parts.push(name);
        kind = 'named';

        if (this.check('::')) continue;
        // More specifiers can follow (`unsigned long` already handled above).
        if (this.isTypeSpecifierToken(this.peek()) && this.peek().kind === 'keyword' && BUILTIN_TYPE_KEYWORDS.has(this.peek().text)) {
          continue;
        }
        // Otherwise stop: the next token is the declarator name.
        break;
      }

      if (token.kind === 'identifier' && this.typedefs.has(token.text)) {
        // Classic C ambiguity: in `typedef unsigned long size_t;` the last name is
        // the DECLARED name, not another type specifier. Once a concrete type has
        // been seen, a typedef name directly followed by a declarator terminator
        // is the declarator's name.
        const next = this.tokenAt(this.index + 1);
        const terminates = next !== undefined && [';', '=', ',', '[', ')'].includes(next.text);
        if (sawConcreteType && terminates) break;

        consumed = true;
        sawConcreteType = true;
        parts.push(token.text);
        kind = 'named';
        this.advance();
        continue;
      }

      break;
    }

    const name = parts.filter((part) => part !== 'typedef').join(' ') || 'int';
    const type: TypeRef = {
      kind,
      name,
      qualifiers,
      start,
      end: this.previousEnd(),
    };

    return { type, storage, consumed, start, elaborated };
  }

  private parseStructSpecifier(isUnion: boolean): Declaration | undefined {
    const keyword = this.advance();
    let tag: string | undefined;
    if (this.isNameToken(this.peek())) tag = this.advance().text;

    const members: MemberDecl[] = [];
    let isDefinition = false;

    if (this.check('{')) {
      isDefinition = true;
      this.advance();
      while (!this.atEnd() && !this.check('}')) {
        const before = this.index;

        /*
         * Every member goes through the normal specifier path, which already knows
         * how to read `struct X`, `struct X { ... }` and an anonymous `struct { ... }`.
         * Intercepting `struct` here treated `struct Node *next;` as a nested
         * definition and swallowed the member - which is why a self-referential
         * struct, the shape every linked list needs, failed to parse unless a
         * typedef happened to come first.
         */
        const spec = this.parseDeclarationSpecifiers();
        if (!spec.consumed) {
          this.error(this.peek(), `expected a member declaration, found "${this.peek().text}"`);
          this.skipToStatementEnd();
          continue;
        }

        // A nested definition is honest about not being laid out by this engine, and
        // says what to do instead: the program would otherwise fail later with a
        // message that does not explain itself.
        for (const node of spec.elaborated) {
          if ('isDefinition' in node && node.isDefinition) {
            this.warn(
              this.peek(),
              `nested ${node.kind} definition is not laid out by the fast engine — declare it at file scope (Run with clang handles it)`,
            );
          }
        }

        // `struct { int x; };` declares a type and no member.
        if (this.check(';')) {
          this.advance();
          if (this.index === before) this.advance();
          continue;
        }

        for (;;) {
          const declStart = this.peek().start;
          const declarator = this.parseDeclarator(spec.type);
          if (declarator.name !== undefined) {
            members.push({
              name: declarator.name,
              type: declarator.type,
              start: declStart,
              end: this.previousEnd(),
            });
          }
          if (this.check(',')) {
            this.advance();
            continue;
          }
          break;
        }

        if (!this.check(';')) {
          this.error(this.peek(), "expected ';' after member declaration");
          this.skipToStatementEnd();
        } else {
          this.advance();
        }

        if (this.index === before) this.advance();
      }
      this.expect('}', "expected '}' to close the struct body");
    }

    if (tag !== undefined) this.tags.add(`${isUnion ? 'union' : 'struct'} ${tag}`);

    return {
      kind: 'struct',
      tag,
      isUnion,
      isDefinition,
      members,
      start: keyword.start,
      end: this.previousEnd(),
    };
  }

  private parseEnumSpecifier(): Declaration | undefined {
    const keyword = this.advance();
    let tag: string | undefined;
    if (this.isNameToken(this.peek())) tag = this.advance().text;

    const enumerators: EnumeratorDecl[] = [];
    let isDefinition = false;

    if (this.check('{')) {
      isDefinition = true;
      this.advance();
      while (!this.atEnd() && !this.check('}')) {
        const nameToken = this.peek();
        if (!this.isNameToken(nameToken)) {
          this.advance();
          continue;
        }
        this.advance();
        let value: Expression | undefined;
        if (this.check('=')) {
          this.advance();
          value = this.parseAssignmentExpression();
        }
        enumerators.push({
          name: nameToken.text,
          value,
          start: nameToken.start,
          end: this.previousEnd(),
        });
        if (this.check(',')) {
          this.advance();
          continue;
        }
        break;
      }
      this.expect('}', "expected '}' to close the enum body");
    }

    if (tag !== undefined) this.tags.add(`enum ${tag}`);

    return {
      kind: 'enum',
      tag,
      isDefinition,
      enumerators,
      start: keyword.start,
      end: this.previousEnd(),
    };
  }

  private parseTypeName(): TypeRef {
    const spec = this.parseDeclarationSpecifiers();
    const declarator = this.parseDeclarator(spec.type);
    return declarator.type;
  }

  // ----------------------------------------------------------- declarators

  private parseDeclarator(base: TypeRef): Declarator {
    const start = this.peek().start;
    let pointerCount = 0;

    for (;;) {
      const token = this.peek();
      if (token.text === '*' || token.text === '&') {
        pointerCount += 1;
        this.advance();
        continue;
      }
      if (token.kind === 'keyword' && TYPE_QUALIFIERS.has(token.text)) {
        this.advance();
        continue;
      }
      break;
    }

    const next = this.tokenAt(this.index + 1);
    const parenthesized = this.check('(') && (next?.text === '*' || next?.text === '(');

    if (parenthesized) {
      this.advance(); // (
      let innerPointers = 0;
      while (this.check('*') || this.check('&')) {
        innerPointers += 1;
        this.advance();
      }
      let name: string | undefined;
      if (this.isNameToken(this.peek())) name = this.advance().text;
      this.expect(')', "expected ')' in declarator");

      // `int (*fp)(void)`: the OUTER pointer belongs to the return type, the
      // INNER one makes fp a pointer to the function. Getting this backwards
      // silently turns a function pointer into "function returning int *".
      let returnType = base;
      for (let count = 0; count < pointerCount; count += 1) {
        returnType = this.wrapPointer(returnType, start, this.previousEnd());
      }

      let type = returnType;
      if (this.check('(')) {
        this.advance();
        const params = this.parseParameterList();
        type = {
          kind: 'function',
          name: `${returnType.name}(...)`,
          qualifiers: [],
          returnType,
          params: params.params,
          variadic: params.variadic,
          start,
          end: params.end,
        };
      }

      for (let count = 0; count < innerPointers; count += 1) {
        type = this.wrapPointer(type, start, this.previousEnd());
      }

      return { name, type };
    }

    let name: string | undefined;
    if (this.isNameToken(this.peek())) {
      name = this.advance().text;
    }

    // Pointers bind first, then suffixes: `char *argv[]` is an array of pointers.
    let type = base;
    for (let count = 0; count < pointerCount; count += 1) {
      type = this.wrapPointer(type, start, this.previousEnd());
    }

    for (;;) {
      if (this.check('[')) {
        const open = this.advance();
        let length: Expression | undefined;
        if (!this.check(']')) length = this.parseAssignmentExpression();
        const close = this.expect(']', "expected ']' to close the array declarator");
        type = {
          kind: 'array',
          name: `${type.name}[]`,
          qualifiers: [],
          element: type,
          arrayLength: length,
          start: open.start,
          end: close?.end ?? this.previousEnd(),
        };
        continue;
      }

      if (this.check('(')) {
        const open = this.advance();
        const params = this.parseParameterList();
        type = {
          kind: 'function',
          name: `${type.name}(...)`,
          qualifiers: [],
          returnType: type,
          params: params.params,
          variadic: params.variadic,
          start: open.start,
          end: params.end,
        };
        continue;
      }

      // C++ trailing return type: `auto f() -> int`.
      if (this.check('->')) {
        this.advance();
        const trailing = this.parseTypeName();
        type = {
          kind: 'function',
          name: `${trailing.name}(...)`,
          qualifiers: [],
          returnType: trailing,
          params: type.params ?? [],
          variadic: type.variadic ?? false,
          start,
          end: this.previousEnd(),
        };
        continue;
      }

      break;
    }

    return { name, type };
  }

  private parseParameterList(): { params: ParamDecl[]; variadic: boolean; end: SourcePos } {
    const params: ParamDecl[] = [];
    let variadic = false;

    if (this.check(')')) {
      const close = this.advance();
      return { params, variadic, end: close.end };
    }

    if (this.check('void') && this.tokenAt(this.index + 1)?.text === ')') {
      this.advance();
      const close = this.advance();
      return { params, variadic, end: close.end };
    }

    for (;;) {
      if (this.check('...')) {
        variadic = true;
        this.advance();
        break;
      }

      const startToken = this.peek();
      const spec = this.parseDeclarationSpecifiers();
      if (!spec.consumed) {
        this.error(startToken, `expected a parameter declaration, found "${startToken.text}"`);
        this.advance();
        break;
      }
      const declarator = this.parseDeclarator(spec.type);
      params.push({
        ...(declarator.name === undefined ? {} : { name: declarator.name }),
        type: declarator.type,
        start: startToken.start,
        end: this.previousEnd(),
      });

      if (this.check(',')) {
        this.advance();
        continue;
      }
      break;
    }

    const close = this.expect(')', "expected ')' to close the parameter list");
    return { params, variadic, end: close?.end ?? this.previousEnd() };
  }

  // -------------------------------------------------------- declarations

  private parseDeclarationList(requireSemicolon = true): Declaration[] {
    const out: Declaration[] = [];

    // `extern "C" { ... }` is C linkage, not a C++ feature: parse the contents.
    if (this.check('extern') && this.tokenAt(this.index + 1)?.kind === 'string') {
      this.advance();
      this.advance();
      if (this.check('{')) {
        this.advance();
        while (!this.atEnd() && !this.check('}')) {
          const before = this.index;
          for (const declaration of this.parseDeclarationList()) out.push(declaration);
          if (this.index === before) this.advance();
        }
        this.expect('}', 'expected \'}\' to close extern "C"');
        return out;
      }
    }

    // `template <typename T>` is resolved by the engine: consume the header
    // first (it registers T as a type name), then parse the declaration that
    // follows. This must happen before the "unsupported construct" check, which
    // would otherwise skip the whole template as a C++-only feature.
    this.parseTemplateHeader();

    /*
     * `using` is handled before the unsupported-construct check, which would
     * otherwise skip it: `using namespace std;` decides which names resolve, so
     * skipping it means valid C++ fails to find `cout`.
     */
    if (this.check('using')) {
      const handled = this.parseUsing();
      if (handled) return handled;
    }

    const skipped = this.detectUnsupportedConstruct();
    if (skipped) return [skipped];

    // `_Static_assert(...)` / `static_assert(...)` carry no executable meaning.
    if (this.check('_Static_assert') || this.check('static_assert')) {
      this.advance();
      if (this.check('(')) this.skipBalanced('(', ')');
      this.consumeOptionalSemicolon();
      return out;
    }

    this.skipAttributes();
    const spec = this.parseDeclarationSpecifiers();
    if (!spec.consumed) {
      const token = this.peek();
      this.error(token, `expected a declaration, found "${token.text}"`);
      this.skipToStatementEnd();
      return out;
    }

    // A bare `struct Foo` reference is not a declaration of its own: the type is
    // carried by the declarator that uses it. Only real definitions are emitted.
    for (const node of spec.elaborated) {
      const isDefinition =
        (node.kind === 'struct' && node.isDefinition) || (node.kind === 'enum' && node.isDefinition);
      if (isDefinition) out.push(node);
    }

    if (this.check(';')) {
      this.advance();
      return out;
    }

    const isTypedef = spec.storage.includes('typedef');
    let bodyParsed = false;

    for (;;) {
      const declaratorStart = this.peek().start;
      const declarator = this.parseDeclarator(spec.type);
      const end = this.previousEnd();
      this.skipAttributes();

      if (isTypedef) {
        if (declarator.name !== undefined) {
          this.typedefs.add(declarator.name);
          out.push({
            kind: 'typedef',
            name: declarator.name,
            type: declarator.type,
            start: declaratorStart,
            end,
          });
        }
      } else if (declarator.type.kind === 'function' && declarator.name !== undefined) {
        let body: CompoundStmt | undefined;
        if (this.check('{')) {
          body = this.parseCompound();
          bodyParsed = true;
        }
        const node: FunctionDeclNode = {
          kind: 'function',
          name: declarator.name,
          returnType: declarator.type.returnType ?? spec.type,
          params: declarator.type.params ?? [],
          variadic: declarator.type.variadic ?? false,
          storage: spec.storage,
          ...(body === undefined ? {} : { body }),
          start: spec.start,
          end: body?.end ?? this.previousEnd(),
        };
        out.push(node);
      } else {
        const initializer = this.parseInitializer();
        out.push({
          kind: 'variable',
          name: declarator.name ?? '<anonymous>',
          type: declarator.type,
          storage: spec.storage,
          ...(initializer === undefined ? {} : { initializer }),
          start: declaratorStart,
          end: this.previousEnd(),
        });
      }

      if (this.check(',')) {
        this.advance();
        continue;
      }
      break;
    }

    // A function *definition* has no trailing semicolon.
    if (requireSemicolon && !bodyParsed) {
      if (!this.check(';')) {
        // Report and continue: mid-edit code is missing semicolons constantly, and
        // skipping ahead here would swallow the next, perfectly valid declaration.
        this.error(this.peek(), "expected ';' after declaration");
      } else {
        this.advance();
      }
    }

    return out;
  }

  private parseInitializer(): Expression | undefined {
    if (this.check('=')) {
      this.advance();
      if (this.check('{')) return this.parseInitList();
      return this.parseAssignmentExpression();
    }
    // C++ brace initialization: `int x{5};`
    if (this.check('{')) return this.parseInitList();
    return undefined;
  }

  private parseInitList(): InitListExpr {
    const open = this.advance();
    const items: Expression[] = [];
    while (!this.atEnd() && !this.check('}')) {
      const before = this.index;
      // Designated initializers: `.field = value` / `[index] = value`.
      if (this.check('.') || (this.check('[') && this.tokenAt(this.index + 2)?.text === ']')) {
        while (!this.atEnd() && !this.check('=') && !this.check(',') && !this.check('}')) {
          this.advance();
        }
        if (this.check('=')) this.advance();
      }
      items.push(this.parseAssignmentExpression());
      if (this.check(',')) {
        this.advance();
        continue;
      }
      if (this.index === before) this.advance();
      break;
    }
    this.expect('}', "expected '}' to close the initializer list");
    return { kind: 'init-list', items, start: open.start, end: this.previousEnd() };
  }

  // ----------------------------------------------------------- statements

  private parseCompound(): CompoundStmt {
    const open = this.expect('{', "expected '{'");
    const items: (Statement | Declaration)[] = [];

    while (!this.atEnd() && !this.check('}')) {
      const before = this.index;

      if (
        this.isDeclarationStart() ||
        this.templateDeclarationAhead() ||
        this.qualifiedTypeAhead()
      ) {
        for (const declaration of this.parseDeclarationList()) items.push(declaration);
      } else {
        const skipped = this.detectUnsupportedConstruct();
        if (skipped) items.push(skipped);
        else items.push(this.parseStatement());
      }

      if (this.index === before) this.advance();
    }

    const close = this.expect('}', "expected '}' to close the block");
    return {
      kind: 'compound',
      items,
      start: open?.start ?? this.previousStart(),
      end: close?.end ?? this.previousEnd(),
    };
  }

  private parseStatement(): Statement {
    const token = this.peek();
    const start = token.start;

    if (this.check('{')) return this.parseCompound();
    if (this.check(';')) {
      const semi = this.advance();
      return { kind: 'empty', start: semi.start, end: semi.end };
    }

    if (token.kind === 'keyword') {
      switch (token.text) {
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          return this.parseWhile();
        case 'do':
          return this.parseDoWhile();
        case 'switch':
          return this.parseSwitch();
        case 'case':
          return this.parseCase();
        case 'default':
          return this.parseDefault();
        case 'return':
          return this.parseReturn();
        case 'break': {
          const keyword = this.advance();
          this.expect(';', "expected ';' after break");
          return { kind: 'break', start: keyword.start, end: this.previousEnd() };
        }
        case 'continue': {
          const keyword = this.advance();
          this.expect(';', "expected ';' after continue");
          return { kind: 'continue', start: keyword.start, end: this.previousEnd() };
        }
        case 'goto': {
          const keyword = this.advance();
          const label = this.peek();
          if (this.isNameToken(label)) this.advance();
          else this.error(label, 'expected a label after goto');
          this.expect(';', "expected ';' after goto");
          return {
            kind: 'goto',
            label: label.text,
            start: keyword.start,
            end: this.previousEnd(),
          };
        }
        default:
          break;
      }
    }

    const skipped = this.detectUnsupportedConstruct();
    if (skipped) {
      return {
        kind: 'unknown',
        text: skipped.text,
        start: skipped.start,
        end: skipped.end,
      };
    }

    if (this.isDeclarationStart()) {
      const declarations = this.parseDeclarationList();
      const declaration = declarations[0];
      if (declaration) {
        return { kind: 'decl-stmt', declaration, start, end: declaration.end };
      }
      return { kind: 'empty', start, end: this.previousEnd() };
    }

    if (this.isNameToken(token) && this.tokenAt(this.index + 1)?.text === ':') {
      this.advance();
      this.advance();
      const body = this.parseStatement();
      return { kind: 'label', label: token.text, body, start, end: body.end };
    }

    if (this.depth > MAX_DEPTH) {
      this.error(token, 'expression nested too deeply; stopping');
      this.skipToStatementEnd();
      return { kind: 'unknown', text: 'too-deep', start, end: this.previousEnd() };
    }

    const expression = this.parseExpression();
    this.expect(';', "expected ';' after expression");
    return { kind: 'expr-stmt', expression, start, end: this.previousEnd() };
  }

  private parseIf(): Statement {
    const keyword = this.advance();
    this.expect('(', "expected '(' after if");
    const condition = this.parseExpression();
    this.expect(')', "expected ')' after the if condition");
    const thenBranch = this.parseStatement();
    let elseBranch: Statement | undefined;
    if (this.check('else')) {
      this.advance();
      elseBranch = this.parseStatement();
    }
    return {
      kind: 'if',
      condition,
      thenBranch,
      ...(elseBranch === undefined ? {} : { elseBranch }),
      start: keyword.start,
      end: (elseBranch ?? thenBranch).end,
    };
  }

  private parseFor(): Statement {
    const keyword = this.advance();
    this.expect('(', "expected '(' after for");

    let initializer: Statement | Declaration | undefined;

    if (!this.check(';')) {
      if (this.isDeclarationStart()) {
        const declarations = this.parseDeclarationList(false);
        const declaration = declarations[0];
        if (declaration) {
          initializer = declaration;
          if (this.check(':')) {
            // Range-based for: a first-class statement, executed by the engine.
            this.advance();
            const iterable = this.parseExpression();
            this.expect(')', "expected ')' after the range-for source expression");
            const body = this.parseStatement();
            return {
              kind: 'for-range',
              declaration,
              iterable,
              body,
              start: keyword.start,
              end: body.end,
            };
          }
        }
      } else {
        const expression = this.parseExpression();
        initializer = {
          kind: 'expr-stmt',
          expression,
          start: expression.start,
          end: expression.end,
        };
      }
    }

    this.expect(';', "expected ';' after the for initializer");
    let condition: Expression | undefined;
    if (!this.check(';')) condition = this.parseExpression();
    this.expect(';', "expected ';' after the for condition");

    let increment: Expression | undefined;
    if (!this.check(')')) increment = this.parseExpression();
    this.expect(')', "expected ')' to close the for header");

    const body = this.parseStatement();

    return {
      kind: 'for',
      ...(initializer === undefined ? {} : { initializer }),
      ...(condition === undefined ? {} : { condition }),
      ...(increment === undefined ? {} : { increment }),
      body,
      start: keyword.start,
      end: body.end,
    };
  }

  private parseWhile(): Statement {
    const keyword = this.advance();
    this.expect('(', "expected '(' after while");
    const condition = this.parseExpression();
    this.expect(')', "expected ')' after the while condition");
    const body = this.parseStatement();
    return { kind: 'while', condition, body, start: keyword.start, end: body.end };
  }

  private parseDoWhile(): Statement {
    const keyword = this.advance();
    const body = this.parseStatement();
    this.expect('while', "expected 'while' after the do body");
    this.expect('(', "expected '(' after while");
    const condition = this.parseExpression();
    this.expect(')', "expected ')' after the do/while condition");
    this.expect(';', "expected ';' after the do/while condition");
    return { kind: 'do-while', body, condition, start: keyword.start, end: this.previousEnd() };
  }

  private parseSwitch(): Statement {
    const keyword = this.advance();
    this.expect('(', "expected '(' after switch");
    const discriminant = this.parseExpression();
    this.expect(')', "expected ')' after the switch expression");
    const body = this.parseStatement();
    return { kind: 'switch', discriminant, body, start: keyword.start, end: body.end };
  }

  private parseCase(): Statement {
    const keyword = this.advance();
    const value = this.parseAssignmentExpression();
    this.expect(':', "expected ':' after the case value");
    const body = this.parseStatement();
    return { kind: 'case', value, body, start: keyword.start, end: body.end };
  }

  private parseDefault(): Statement {
    const keyword = this.advance();
    this.expect(':', "expected ':' after default");
    const body = this.parseStatement();
    return { kind: 'default', body, start: keyword.start, end: body.end };
  }

  private parseReturn(): Statement {
    const keyword = this.advance();
    if (this.check(';')) {
      this.advance();
      return { kind: 'return', start: keyword.start, end: this.previousEnd() };
    }
    const value = this.parseExpression();
    this.expect(';', "expected ';' after return");
    return { kind: 'return', value, start: keyword.start, end: this.previousEnd() };
  }

  // ---------------------------------------------------------- expressions

  private parseExpression(): Expression {
    const first = this.parseAssignmentExpression();
    if (!this.check(',')) return first;

    const items: Expression[] = [first];
    while (this.check(',')) {
      this.advance();
      items.push(this.parseAssignmentExpression());
    }
    return {
      kind: 'comma',
      items,
      start: first.start,
      end: items[items.length - 1]?.end ?? first.end,
    };
  }

  private parseAssignmentExpression(): Expression {
    const left = this.parseConditionalExpression();
    const token = this.peek();
    if (token.kind !== 'punctuator' || !ASSIGN_OPERATORS.has(token.text)) return left;

    this.advance();
    const value = this.parseAssignmentExpression();
    const node: Expression = {
      kind: 'assign',
      operator: token.text,
      target: left,
      value,
      start: left.start,
      end: value.end,
    };
    return node;
  }

  private parseConditionalExpression(): Expression {
    const condition = this.parseBinaryExpression(0);
    if (!this.check('?')) return condition;

    this.advance();
    const thenBranch = this.parseAssignmentExpression();
    this.expect(':', "expected ':' in the conditional expression");
    const elseBranch = this.parseConditionalExpression();
    return {
      kind: 'ternary',
      condition,
      thenBranch,
      elseBranch,
      start: condition.start,
      end: elseBranch.end,
    };
  }

  private parseBinaryExpression(level: number): Expression {
    const operators = BINARY_PRECEDENCE[level];
    if (operators === undefined) return this.parseUnaryExpression();

    let left = this.parseBinaryExpression(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'punctuator' || !operators.includes(token.text)) break;
      this.advance();
      const right = this.parseBinaryExpression(level + 1);
      left = {
        kind: 'binary',
        operator: token.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private isCastAhead(): boolean {
    if (!this.check('(')) return false;
    return this.isTypeSpecifierToken(this.tokenAt(this.index + 1));
  }

  private parseUnaryExpression(): Expression {
    if (this.depth > MAX_DEPTH) {
      const token = this.peek();
      this.error(token, 'expression nested too deeply; stopping');
      return {
        kind: 'unknown',
        text: token.text,
        start: token.start,
        end: token.end,
      };
    }

    this.depth += 1;
    try {
      return this.parseUnaryExpressionInner();
    } finally {
      this.depth -= 1;
    }
  }

  private parseUnaryExpressionInner(): Expression {
    const token = this.peek();

    if (token.kind === 'punctuator' && PREFIX_OPERATORS.has(token.text)) {
      this.advance();
      const operand = this.parseUnaryExpression();
      return {
        kind: 'unary',
        operator: token.text,
        operand,
        prefix: true,
        start: token.start,
        end: operand.end,
      };
    }

    if (this.isCastAhead()) {
      this.advance();
      const type = this.parseTypeName();
      this.expect(')', "expected ')' to close the cast");
      const value = this.parseUnaryExpression();
      return { kind: 'cast', type, value, start: token.start, end: value.end };
    }

    if (token.kind === 'keyword') {
      if (token.text === 'sizeof' || token.text === '_Alignof' || token.text === 'alignof') {
        return this.parseSizeof(token);
      }
      if (token.text === 'new' || token.text === 'delete') {
        this.warn(token, `C++ "${token.text}" is not executable on the fast engine`);
        this.skipToStatementEnd();
        return { kind: 'unknown', text: token.text, start: token.start, end: this.previousEnd() };
      }
      if (
        token.text === 'static_cast' ||
        token.text === 'dynamic_cast' ||
        token.text === 'reinterpret_cast' ||
        token.text === 'const_cast'
      ) {
        this.advance();
        this.skipBalancedAngles();
        this.expect('(', `expected '(' after ${token.text}`);
        const value = this.parseExpression();
        this.expect(')', `expected ')' to close ${token.text}`);
        return { kind: 'cast', type: this.typeRef('unknown', token.text, token.start, token.end), value, start: token.start, end: value.end };
      }
    }

    return this.parsePostfixExpression();
  }

  private parseSizeof(keyword: Token): Expression {
    this.advance();
    if (this.check('(') && this.isTypeSpecifierToken(this.tokenAt(this.index + 1))) {
      this.advance();
      const type = this.parseTypeName();
      this.expect(')', "expected ')' to close sizeof");
      return {
        kind: 'sizeof',
        ofType: type,
        start: keyword.start,
        end: this.previousEnd(),
      };
    }
    const expression = this.parseUnaryExpression();
    return {
      kind: 'sizeof',
      ofExpression: expression,
      start: keyword.start,
      end: expression.end,
    };
  }

  private parsePostfixExpression(): Expression {
    let expression = this.parsePrimaryExpression();

    for (;;) {
      const token = this.peek();

      if (token.text === '(') {
        this.advance();
        const args: Expression[] = [];
        if (!this.check(')')) {
          for (;;) {
            args.push(this.parseAssignmentExpression());
            if (this.check(',')) {
              this.advance();
              continue;
            }
            break;
          }
        }
        this.expect(')', "expected ')' to close the argument list");
        expression = {
          kind: 'call',
          callee: expression,
          args,
          start: expression.start,
          end: this.previousEnd(),
        };
        continue;
      }

      if (token.text === '[') {
        this.advance();
        const index = this.parseExpression();
        this.expect(']', "expected ']' to close the subscript");
        expression = {
          kind: 'index',
          object: expression,
          index,
          start: expression.start,
          end: this.previousEnd(),
        };
        continue;
      }

      if (token.text === '.' || token.text === '->') {
        const arrow = token.text === '->';
        this.advance();
        const property = this.peek();
        if (this.isNameToken(property)) this.advance();
        else this.error(property, 'expected a member name');
        expression = {
          kind: 'member',
          object: expression,
          property: property.text,
          arrow,
          start: expression.start,
          end: this.previousEnd(),
        };
        continue;
      }

      if (token.text === '++' || token.text === '--') {
        this.advance();
        expression = {
          kind: 'unary',
          operator: token.text,
          operand: expression,
          prefix: false,
          start: expression.start,
          end: this.previousEnd(),
        };
        continue;
      }

      break;
    }

    return expression;
  }

  private parsePrimaryExpression(): Expression {
    const token = this.peek();

    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'char') {
      this.advance();
      return {
        kind: 'literal',
        literal: token.kind,
        text: token.text,
        ...(token.value === undefined ? {} : { value: token.value }),
        start: token.start,
        end: token.end,
      };
    }

    if (token.kind === 'keyword') {
      if (token.text === 'true' || token.text === 'false') {
        this.advance();
        return {
          kind: 'literal',
          literal: 'number',
          text: token.text === 'true' ? '1' : '0',
          start: token.start,
          end: token.end,
        };
      }
      if (token.text === 'nullptr') {
        this.advance();
        return {
          kind: 'literal',
          literal: 'number',
          text: '0',
          start: token.start,
          end: token.end,
        };
      }
      if (token.text === 'this') {
        this.advance();
        return { kind: 'identifier', name: 'this', start: token.start, end: token.end };
      }
    }

    if (this.isNameToken(token)) {
      this.advance();
      let name = token.text;
      while (this.check('::')) {
        this.advance();
        const part = this.peek();
        if (this.isNameToken(part)) {
          name += `::${part.text}`;
          this.advance();
        }
      }
      if (this.check('<') && this.templateAhead()) this.skipBalancedAngles();
      return { kind: 'identifier', name, start: token.start, end: this.previousEnd() };
    }

    if (this.check('(')) {
      this.advance();
      const inner = this.parseExpression();
      this.expect(')', "expected ')'");
      return inner;
    }

    if (this.check('{')) return this.parseInitList();

    this.error(token, `unexpected token "${token.text}" in expression`);
    this.advance();
    return { kind: 'unknown', text: token.text, start: token.start, end: token.end };
  }

  // ----------------------------------------------------------- C++ guards

  /** `std::vector<int> v;` / `vector<int> v;` - a template type declaration. */
  private templateDeclarationAhead(): boolean {
    const first = this.peek();
    if (!this.isNameToken(first)) return false;
    const cursor = this.qualifiedNameEnd(this.index);
    if (this.tokenAt(cursor)?.text !== '<') return false;
    return this.templateCloses(cursor);
  }

  /**
   * `std::string label = "done";` - a qualified C++ type with no template.
   *
   * Must not swallow `std::cout << x;`, which is an expression: a qualified name
   * only starts a declaration when a declarator follows it.
   */
  private qualifiedTypeAhead(): boolean {
    const first = this.peek();
    if (!this.isNameToken(first)) return false;

    const cursor = this.qualifiedNameEnd(this.index);
    if (cursor === this.index + 1) return false;

    const after = this.tokenAt(cursor);
    if (after === undefined) return false;
    if (after.text === '<') return false; // handled by templateDeclarationAhead
    return this.isNameToken(after) || after.text === '*' || after.text === '&';
  }

  /** Index just past a `A::B::C` chain starting at `start` (unqualified: start + 1). */
  private qualifiedNameEnd(start: number): number {
    let cursor = start + 1;
    while (this.tokenAt(cursor)?.text === '::') {
      cursor += 1;
      if (this.isNameToken(this.tokenAt(cursor))) cursor += 1;
    }
    return cursor;
  }

  /** True when the `<` at `ltIndex` closes and is followed by something name-like. */
  private templateCloses(ltIndex: number): boolean {
    let depth = 0;
    for (let cursor = ltIndex; cursor < this.tokens.length; cursor += 1) {
      const token = this.tokenAt(cursor);
      if (token === undefined || token.kind === 'eof') return false;
      if (token.text === '<') depth += 1;
      else if (token.text === '>') {
        depth -= 1;
        if (depth === 0) {
          const after = this.tokenAt(cursor + 1);
          if (after === undefined) return false;
          return (
            this.isNameToken(after) ||
            after.text === '{' ||
            after.text === '&' ||
            after.text === '*' ||
            after.text === '('
          );
        }
      } else if (token.text === ';' || token.text === '{' || token.text === '}') {
        return false;
      }
    }
    return false;
  }

  /** `<...>` in expression position, e.g. `foo<int>(x)`. */
  private templateAhead(): boolean {
    return this.templateCloses(this.index);
  }

  private skipBalancedAngles(): void {
    if (!this.check('<')) return;
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.advance();
      if (token.text === '<') depth += 1;
      else if (token.text === '>') {
        depth -= 1;
        if (depth <= 0) return;
      } else if (token.text === ';' || token.text === '{') return;
    }
  }

  /**
   * `using namespace std;`, `using std::cout;` and `using ll = long long;`.
   *
   * These decide which names resolve, so skipping them means valid C++ fails to find
   * `cout` - the engine would be rejecting code a native compiler accepts, which is the
   * wrong way round. The first two become a `using` declaration the interpreter reads;
   * the third is an ordinary typedef under another spelling.
   */
  private parseUsing(): Declaration[] {
    const usingToken = this.advance();

    const readQualifiedName = (): string => {
      let text = this.advance().text;
      while (this.check('::')) {
        this.advance();
        const part = this.peek();
        if (!this.isNameToken(part)) break;
        text += `::${part.text}`;
        this.advance();
      }
      return text;
    };

    if (this.check('namespace')) {
      this.advance();
      const names: string[] = [];
      while (this.isNameToken(this.peek()) && !this.check(';')) {
        names.push(readQualifiedName());
        if (this.check(',')) {
          this.advance();
          continue;
        }
        break;
      }
      this.expect(';', "expected ';' after using namespace");
      // Remembered so later declarations can tell whether a bare `string` is in scope.
      if (names.includes('std')) this.usingNamespaceStd = true;
      return [
        { kind: 'using', isNamespace: true, names, start: usingToken.start, end: this.previousEnd() },
      ];
    }

    // `using ll = long long;` - a typedef, so the resolver learns the alias.
    if (this.isNameToken(this.peek()) && this.tokenAt(this.index + 1)?.text === '=') {
      const alias = this.advance();
      this.advance();
      const spec = this.parseDeclarationSpecifiers();
      const type = this.parseDeclarator(spec.type).type;
      this.typedefs.add(alias.text);
      this.expect(';', "expected ';' after the type alias");
      return [
        { kind: 'typedef', name: alias.text, type, start: usingToken.start, end: this.previousEnd() },
      ];
    }

    const names: string[] = [];
    while (this.isNameToken(this.peek()) && !this.check(';')) {
      names.push(readQualifiedName());
      if (this.check(',')) {
        this.advance();
        continue;
      }
      break;
    }
    this.expect(';', "expected ';' after using");
    for (const name of names) this.usingNames.add(name.replace(/^std::/, ''));
    return [
      { kind: 'using', isNamespace: false, names, start: usingToken.start, end: this.previousEnd() },
    ];
  }

  /**
   * Detects a construct the fast engine cannot execute, reports it once, skips
   * it, and returns a node so the UI can show what was skipped.
   */
  private detectUnsupportedConstruct(): UnknownDeclNode | undefined {
    const token = this.peek();
    if (!this.isNameToken(token)) return undefined;

    if (!isCppOnlyKeyword(token.text)) return undefined;

    // `template` is handled before this point; `constexpr`, `explicit`, `mutable`,
    // `inline`, `virtual` and `friend` are modifiers the engine can ignore.
    if (token.text === 'constexpr' || token.text === 'explicit' || token.text === 'mutable') {
      this.advance();
      return undefined;
    }

    if (token.text === 'inline' || token.text === 'virtual' || token.text === 'friend') {
      this.advance();
      return undefined;
    }

    const start = token.start;
    this.warn(
      token,
      `C++ "${token.text}" is not executable on the fast engine; Run (F5) uses clang-wasm`,
    );
    this.advance();
    this.skipConstruct();
    return { kind: 'unknown-decl', text: token.text, start, end: this.previousEnd() };
  }

  /** Skips to the end of the statement, or past a balanced brace block. */
  private skipConstruct(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.peek();

      if (token.text === '(') {
        this.skipBalanced('(', ')');
        continue;
      }
      if (token.text === '{') {
        depth += 1;
        this.advance();
        continue;
      }
      if (token.text === '}') {
        if (depth === 0) return;
        depth -= 1;
        this.advance();
        if (depth === 0) {
          this.consumeOptionalSemicolon();
          return;
        }
        continue;
      }
      if (token.text === ';' && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private consumeOptionalSemicolon(): void {
    if (this.check(';')) this.advance();
  }

  /**
   * `__attribute__((...))`, `__declspec(...)` and nullability annotations are
   * consumed silently: they appear in real system headers (including the
   * built-in ones here) and never change what the fast engine executes.
   */
  private skipAttributes(): void {
    for (;;) {
      const token = this.peek();
      if (
        token.text === '__attribute__' ||
        token.text === '__declspec' ||
        token.text === '_Nullable' ||
        token.text === '_Nonnull' ||
        token.text === '__extension__'
      ) {
        this.advance();
        if (this.check('(')) this.skipBalanced('(', ')');
        continue;
      }
      if (token.text === 'noexcept' || token.text === 'override' || token.text === 'final') {
        this.advance();
        if (this.check('(')) this.skipBalanced('(', ')');
        continue;
      }
      break;
    }
  }

  private skipBalanced(open: string, close: string): void {
    if (!this.check(open)) return;
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.advance();
      if (token.text === open) depth += 1;
      else if (token.text === close) {
        depth -= 1;
        if (depth <= 0) return;
      }
    }
  }

  /** Resync point for error recovery: the next `;` or the end of the block. */
  private skipToStatementEnd(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.text === '{') depth += 1;
      if (token.text === '}') {
        if (depth === 0) return;
        depth -= 1;
      }
      if (token.text === ';' && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }
}
