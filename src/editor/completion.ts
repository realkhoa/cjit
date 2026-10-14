import type * as Monaco from 'monaco-editor';
import { getPublishedAnalysis } from '@/lang/analysisCache';
import { membersOfType, visibleSymbolsAt } from '@/lang/symbols';
import type { SymbolInfo, SymbolKind } from '@/lang/symbols';

/**
 * Editor intelligence.
 *
 * Two layers:
 *  1. Keyword/snippet completion - always available, no analysis needed.
 *  2. Symbol completion / hover - driven by the fast engine's last published
 *     analysis, so it is *scope aware*: inside `main()` you get main's locals and
 *     parameters, and after `p.` you get the members of `p`'s real type.
 *
 * Everything degrades quietly when there is no analysis yet (empty file, engine
 * not run): the provider returns nothing instead of guessing.
 */

let keywordRegistered = false;
let symbolRegistered = false;

const KEYWORDS = [
  'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const',
  'constexpr', 'continue', 'decltype', 'default', 'delete', 'do', 'double', 'else', 'enum',
  'explicit', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long',
  'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected',
  'public', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'static_cast', 'struct',
  'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned',
  'using', 'virtual', 'void', 'volatile', 'while',
];

const TYPES = ['size_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint32_t', 'uint64_t', 'FILE'];

interface Snippet {
  readonly label: string;
  readonly detail: string;
  readonly body: string;
}

const SNIPPETS: readonly Snippet[] = [
  { label: 'main', detail: 'int main(int argc, char** argv)', body: 'int main(int argc, char** argv) {\n\t$0\n\treturn 0;\n}' },
  { label: 'main-void', detail: 'int main(void)', body: 'int main(void) {\n\t$0\n\treturn 0;\n}' },
  { label: 'for', detail: 'for loop (C style)', body: 'for (int i = 0; i < ${1:n}; i++) {\n\t$0\n}' },
  { label: 'while', detail: 'while loop', body: 'while (${1:condition}) {\n\t$0\n}' },
  { label: 'dowhile', detail: 'do/while loop', body: 'do {\n\t$0\n} while (${1:condition});' },
  { label: 'if', detail: 'if statement', body: 'if (${1:condition}) {\n\t$0\n}' },
  { label: 'ifelse', detail: 'if/else statement', body: 'if (${1:condition}) {\n\t$0\n} else {\n\t\n}' },
  { label: 'switch', detail: 'switch statement', body: 'switch (${1:value}) {\n\tcase ${2:0}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}' },
  { label: 'struct', detail: 'struct definition', body: 'struct ${1:Name} {\n\t$0\n};' },
  { label: 'include', detail: '#include <...>', body: '#include <${1:stdio.h}>' },
  { label: 'printf', detail: 'printf with newline', body: 'printf("${1:%d}\\n", ${2:value});' },
  { label: 'cout', detail: 'std::cout with newline', body: 'std::cout << ${1:value} << \'\\n\';' },
  { label: 'vector', detail: 'std::vector declaration', body: 'std::vector<${1:int}> ${2:values};' },
  { label: 'trycatch', detail: 'try/catch block', body: 'try {\n\t$0\n} catch (const std::exception& e) {\n\tstd::cerr << e.what() << \'\\n\';\n}' },
];

function completionKind(monaco: typeof Monaco, kind: SymbolKind): Monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'function':
      return monaco.languages.CompletionItemKind.Function;
    case 'struct':
    case 'union':
    case 'enum':
      return monaco.languages.CompletionItemKind.Class;
    case 'typedef':
      return monaco.languages.CompletionItemKind.TypeParameter;
    case 'enumerator':
      return monaco.languages.CompletionItemKind.EnumMember;
    case 'member':
      return monaco.languages.CompletionItemKind.Field;
    default:
      return monaco.languages.CompletionItemKind.Variable;
  }
}

function toSuggestion(
  monaco: typeof Monaco,
  symbol: SymbolInfo,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const description = symbol.detail ?? `${symbol.type} ${symbol.name}`;
  return {
    label: symbol.name,
    kind: completionKind(monaco, symbol.kind),
    detail: symbol.detail ?? symbol.type,
    documentation: { value: `\`${description}\`\n\nscope: ${symbol.scope}` },
    insertText: symbol.name,
    range,
  };
}

export function registerKeywordCompletions(monaco: typeof Monaco): void {
  if (keywordRegistered) return;
  keywordRegistered = true;

  monaco.languages.registerCompletionItemProvider(['c', 'cpp'], {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = [
        ...KEYWORDS.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
        })),
        ...TYPES.map((type) => ({
          label: type,
          kind: monaco.languages.CompletionItemKind.TypeParameter,
          insertText: type,
          range,
        })),
        ...SNIPPETS.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      ];

      return { suggestions };
    },
  });
}

export function registerSymbolCompletions(monaco: typeof Monaco): void {
  if (symbolRegistered) return;
  symbolRegistered = true;

  monaco.languages.registerCompletionItemProvider(['c', 'cpp'], {
    triggerCharacters: ['.', '>', ':'],
    provideCompletionItems(model, position) {
      const analysis = getPublishedAnalysis();
      if (!analysis) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const offset = model.getOffsetAt(position);

      // Member access: `p.` or `p->` - resolve the base symbol's real type.
      const prefix = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const memberMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*[A-Za-z0-9_]*$/.exec(prefix);
      if (memberMatch?.[1]) {
        const baseName = memberMatch[1];
        const base = visibleSymbolsAt(analysis.symbols, offset).find(
          (symbol) => symbol.name === baseName,
        );
        const members = base ? membersOfType(analysis.symbols, base.type) : undefined;
        if (!members) return { suggestions: [] };
        return { suggestions: members.map((member) => toSuggestion(monaco, member, range)) };
      }

      const typed = word.word;
      const visible = visibleSymbolsAt(analysis.symbols, offset).filter(
        (symbol) => symbol.kind !== 'member',
      );

      // With nothing typed, offer only what the caret's scope contributes; with a
      // prefix, search everything visible so `pri` still finds `printf`.
      const matches =
        typed.length === 0
          ? visible.filter((symbol) => symbol.scope !== 'global')
          : visible.filter((symbol) => symbol.name.startsWith(typed));

      return { suggestions: matches.map((symbol) => toSuggestion(monaco, symbol, range)) };
    },
  });

  monaco.languages.registerHoverProvider(['c', 'cpp'], {
    provideHover(model, position) {
      const analysis = getPublishedAnalysis();
      if (!analysis) return null;

      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return null;

      const symbol = visibleSymbolsAt(analysis.symbols, model.getOffsetAt(position)).find(
        (item) => item.name === wordInfo.word,
      );
      if (!symbol) return null;

      return {
        range: new monaco.Range(
          position.lineNumber,
          wordInfo.startColumn,
          position.lineNumber,
          wordInfo.endColumn,
        ),
        contents: [
          { value: `\`\`\`c\n${symbol.detail ?? `${symbol.type} ${symbol.name}`}\n\`\`\`` },
          { value: `**${symbol.kind}** · scope: \`${symbol.scope}\`` },
        ],
      };
    },
  });
}
