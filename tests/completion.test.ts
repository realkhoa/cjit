import { beforeEach, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { registerKeywordCompletions, registerSymbolCompletions } from '@/editor/completion';
import { clearPublishedAnalysis, publishAnalysis } from '@/lang/analysisCache';
import { analyzeSource } from '@/lang/analyze';

describe('editor completion & hover intelligence', () => {
  interface MockCompletionProvider {
    triggerCharacters?: string[];
    provideCompletionItems: (
      model: any,
      position: { lineNumber: number; column: number },
    ) => { suggestions: any[] };
  }

  interface MockHoverProvider {
    provideHover: (
      model: any,
      position: { lineNumber: number; column: number },
    ) => any;
  }

  const completionProviders: MockCompletionProvider[] = [];
  const hoverProviders: MockHoverProvider[] = [];

  const mockMonaco = {
    Range: class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    languages: {
      CompletionItemKind: {
        Function: 2,
        Field: 4,
        Variable: 5,
        Class: 7,
        Keyword: 17,
        EnumMember: 19,
        TypeParameter: 24,
        Snippet: 27,
      },
      CompletionItemInsertTextRule: {
        InsertAsSnippet: 4,
      },
      registerCompletionItemProvider: (_languages: string[], provider: MockCompletionProvider) => {
        completionProviders.push(provider);
        return { dispose: () => {} };
      },
      registerHoverProvider: (_languages: string[], provider: MockHoverProvider) => {
        hoverProviders.push(provider);
        return { dispose: () => {} };
      },
    },
  } as unknown as typeof Monaco;

  beforeEach(() => {
    clearPublishedAnalysis();
  });

  it('registers keyword completions and provides keywords, types, and snippets', () => {
    registerKeywordCompletions(mockMonaco);
    // Idempotent: second call does not register a second provider
    registerKeywordCompletions(mockMonaco);

    const keywordProvider = completionProviders[0];
    expect(keywordProvider).toBeDefined();

    const mockModel = {
      getWordUntilPosition: () => ({ word: 'whi', startColumn: 1, endColumn: 4 }),
    };

    const result = keywordProvider!.provideCompletionItems(mockModel as any, { lineNumber: 1, column: 4 });
    expect(result.suggestions.length).toBeGreaterThan(50);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('while');
    expect(labels).toContain('constexpr');
    expect(labels).toContain('size_t');
    expect(labels).toContain('for');
    expect(labels).toContain('printf');
    expect(labels).toContain('cout');
  });

  it('registers symbol completions and hover provider', () => {
    registerSymbolCompletions(mockMonaco);
    // Idempotency check
    registerSymbolCompletions(mockMonaco);

    // The second completion provider registered is the symbol completion provider
    const symbolProvider = completionProviders[1];
    expect(symbolProvider).toBeDefined();
    expect(symbolProvider!.triggerCharacters).toEqual(['.', '>', ':']);

    const hoverProvider = hoverProviders[0];
    expect(hoverProvider).toBeDefined();
  });

  it('returns empty suggestions and null hover when no analysis is published', () => {
    const symbolProvider = completionProviders[1]!;
    const hoverProvider = hoverProviders[0]!;

    const mockModel = {
      getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
      getOffsetAt: () => 0,
      getLineContent: () => '',
      getWordAtPosition: () => ({ word: 'x', startColumn: 1, endColumn: 2 }),
    };

    const completion = symbolProvider.provideCompletionItems(mockModel as any, { lineNumber: 1, column: 1 });
    expect(completion.suggestions).toEqual([]);

    const hover = hoverProvider.provideHover(mockModel as any, { lineNumber: 1, column: 1 });
    expect(hover).toBeNull();
  });

  it('provides member completions for structs after dot or arrow', () => {
    const code = [
      'struct Point {',
      '    int x;',
      '    int y;',
      '};',
      'int main(void) {',
      '    struct Point pt;',
      '    pt.',
      '    return 0;',
      '}',
    ].join('\n');

    const analysis = analyzeSource(code, 'main.c');
    publishAnalysis(analysis);

    const symbolProvider = completionProviders[1]!;
    const lineContent = '    pt.';
    const dotIndex = code.indexOf('pt.') + 3;

    const mockModel = {
      getWordUntilPosition: () => ({ word: '', startColumn: 8, endColumn: 8 }),
      getOffsetAt: () => dotIndex,
      getLineContent: () => lineContent,
    };

    const result = symbolProvider.provideCompletionItems(mockModel as any, { lineNumber: 7, column: 8 });
    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });

  it('provides scoped symbol completions when typing a prefix', () => {
    const code = [
      'int globalVar = 10;',
      'int computeSum(int a, int b) {',
      '    int localResult = a + b;',
      '    return localResult;',
      '}',
    ].join('\n');

    const analysis = analyzeSource(code, 'main.c');
    publishAnalysis(analysis);

    const symbolProvider = completionProviders[1]!;
    const mockModel = {
      getWordUntilPosition: () => ({ word: 'local', startColumn: 5, endColumn: 10 }),
      getOffsetAt: () => code.indexOf('return localResult'),
      getLineContent: () => '    return localResult;',
    };

    const result = symbolProvider.provideCompletionItems(mockModel as any, { lineNumber: 4, column: 10 });
    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain('localResult');
  });

  it('provides hover documentation for visible symbols', () => {
    const code = [
      'int myValue = 42;',
      'int main(void) {',
      '    return myValue;',
      '}',
    ].join('\n');

    const analysis = analyzeSource(code, 'main.c');
    publishAnalysis(analysis);

    const hoverProvider = hoverProviders[0]!;
    const mockModel = {
      getWordAtPosition: () => ({ word: 'myValue', startColumn: 12, endColumn: 19 }),
      getOffsetAt: () => code.indexOf('myValue;'),
    };

    const hover = hoverProvider.provideHover(mockModel as any, { lineNumber: 3, column: 15 });
    expect(hover).not.toBeNull();
    expect(hover.contents[0].value).toContain('myValue');
    expect(hover.contents[1].value).toContain('variable');
  });
});
