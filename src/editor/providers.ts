import type * as Monaco from 'monaco-editor';
import { definitionAt, documentSymbolsFor, signatureAt } from '@/editor/intelligence';
import type { OutlineKind } from '@/editor/intelligence';
import { getPublishedAnalysis } from '@/lang/analysisCache';
import { knownHeaderNames } from '@/lang/headers';
import { visibleSymbolsAt } from '@/lang/symbols';
import { useAppStore } from '@/state/store';
import { lineStateAt } from '@/ui/inlineValues';

/**
 * Monaco adapters for the analysis-backed intelligence.
 *
 * All decisions live in `intelligence.ts` (pure, unit tested); this file only
 * translates them into Monaco's provider shapes. Everything degrades to "no
 * answer" when there is no analysis yet - providers never guess.
 */

const HEADER_SCHEME = 'cjit-header';
let registered = false;

function headerUri(monaco: typeof Monaco, label: string): Monaco.Uri {
  return monaco.Uri.parse(`${HEADER_SCHEME}:/${encodeURIComponent(label)}`);
}

function symbolKind(monaco: typeof Monaco, kind: OutlineKind): Monaco.languages.SymbolKind {
  switch (kind) {
    case 'function':
      return monaco.languages.SymbolKind.Function;
    case 'variable':
      return monaco.languages.SymbolKind.Variable;
    case 'struct':
      return monaco.languages.SymbolKind.Struct;
    case 'enum':
      return monaco.languages.SymbolKind.Enum;
    case 'typedef':
      return monaco.languages.SymbolKind.Interface;
    case 'member':
      return monaco.languages.SymbolKind.Field;
    case 'enumerator':
      return monaco.languages.SymbolKind.EnumMember;
  }
}

/**
 * Opens a built-in header as a document.
 *
 * Monaco's standalone build has no `registerTextModelContentProvider`, so the
 * model is created on demand here. Models are cached by URI and reused, so the
 * header opens once and behaves like any other document afterwards.
 */
function ensureHeaderModel(monaco: typeof Monaco, label: string): Monaco.editor.ITextModel | null {
  const uri = headerUri(monaco, label);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;

  const analysis = getPublishedAnalysis();
  const source = analysis?.sources.get(label);
  if (source === undefined || source.length === 0) return null;

  return monaco.editor.createModel(source, 'c', uri);
}

export function registerIntelligenceProviders(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerSignatureHelpProvider(['c', 'cpp'], {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const analysis = getPublishedAnalysis();
      if (!analysis) return null;

      const info = signatureAt(analysis, model.getOffsetAt(position));
      if (!info) return null;

      return {
        value: {
          signatures: [
            {
              label: info.label,
              parameters: info.parameters.map((parameter) => ({ label: parameter })),
            },
          ],
          activeSignature: 0,
          activeParameter: info.activeParameter,
        },
        dispose: () => undefined,
      };
    },
  });

  monaco.languages.registerDefinitionProvider(['c', 'cpp'], {
    provideDefinition(model, position) {
      const analysis = getPublishedAnalysis();
      const word = model.getWordAtPosition(position);
      if (!analysis || !word) return null;

      const target = definitionAt(analysis, model.getOffsetAt(position), word.word);
      if (!target) return null;

      const isHeader = target.file.startsWith('<');
      if (isHeader && !ensureHeaderModel(monaco, target.file)) return null;

      return {
        uri: isHeader ? headerUri(monaco, target.file) : model.uri,
        range: new monaco.Range(
          target.line,
          target.column,
          target.line,
          target.column + Math.max(target.length, 1),
        ),
      };
    },
  });

  monaco.languages.registerDocumentSymbolProvider(['c', 'cpp'], {
    provideDocumentSymbols() {
      const analysis = getPublishedAnalysis();
      if (!analysis) return [];

      const toSymbol = (symbol: ReturnType<typeof documentSymbolsFor>[number]): Monaco.languages.DocumentSymbol => ({
        name: symbol.name,
        detail: symbol.detail,
        kind: symbolKind(monaco, symbol.kind),
        range: new monaco.Range(symbol.line, symbol.column, Math.max(symbol.endLine, symbol.line), 1),
        selectionRange: new monaco.Range(
          symbol.line,
          symbol.column,
          symbol.line,
          symbol.column + Math.max(symbol.name.length, 1),
        ),
        tags: [],
        ...(symbol.children && symbol.children.length > 0
          ? { children: symbol.children.map(toSymbol) }
          : {}),
      });

      return documentSymbolsFor(analysis).map(toSymbol);
    },
  });

  // Hover: the declaration plus, when the program has run, the value at this line.
  monaco.languages.registerHoverProvider(['c', 'cpp'], {
    provideHover(model, position) {
      const analysis = getPublishedAnalysis();
      const word = model.getWordAtPosition(position);
      if (!analysis || !word) return null;

      const offset = model.getOffsetAt(position);
      const symbol = visibleSymbolsAt(analysis.symbols, offset).find(
        (item) => item.name === word.word,
      );
      if (!symbol) return null;

      const contents: Monaco.IMarkdownString[] = [
        { value: `\`\`\`c\n${symbol.detail ?? `${symbol.type} ${symbol.name}`}\n\`\`\`` },
        { value: `**${symbol.kind}** · scope: \`${symbol.scope}\`` },
      ];

      const watch = useAppStore.getState().watch;
      const state = lineStateAt(watch, position.lineNumber);
      const value = state?.find((item) => item.name === word.word);
      if (value) {
        contents.push({ value: `at line ${position.lineNumber}: \`${value.value}\`` });
      }

      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents,
      };
    },
  });

  // Every header the engine knows, offered after `#include <`.
  monaco.languages.registerCompletionItemProvider(['c', 'cpp'], {
    triggerCharacters: ['<', '/', '"'],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const match = /#\s*include\s*[<"]([A-Za-z0-9_./+]*)$/.exec(before);
      if (!match) return { suggestions: [] };

      const typed = match[1] ?? '';
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endColumn: position.column,
      };

      return {
        suggestions: knownHeaderNames()
          .filter((name) => name.startsWith(typed))
          .map((name) => ({
            label: name,
            kind: monaco.languages.CompletionItemKind.File,
            detail: 'built-in header',
            insertText: name,
            range,
          })),
      };
    },
  });
}
