import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';
import { registerKeywordCompletions, registerSymbolCompletions } from '@/editor/completion';
import { monaco } from '@/editor/monacoSetup';
import { bindEditor } from '@/editor/navigation';
import { useAppStore } from '@/state/store';
import { EDITOR_THEME_DARK } from '@/ui/theme/monacoTheme';

type Editor = Monaco.editor.IStandaloneCodeEditor;

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const language = useAppStore((state) => state.language);
  const code = useAppStore((state) => state.code);
  const codeRevision = useAppStore((state) => state.codeRevision);
  const path = useAppStore((state) => state.path);
  const diagnostics = useAppStore((state) => state.watch.diagnostics);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    registerKeywordCompletions(monaco);
    registerSymbolCompletions(monaco);

    const editor = monaco.editor.create(host, {
      value: useAppStore.getState().code,
      language: useAppStore.getState().language,
      theme: EDITOR_THEME_DARK,
      automaticLayout: true,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 20,
      fontLigatures: true,
      minimap: { enabled: true, renderCharacters: false, maxColumn: 90 },
      renderLineHighlight: 'all',
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true },
      stickyScroll: { enabled: true },
      rulers: [80, 120],
      tabSize: 4,
      insertSpaces: true,
      detectIndentation: false,
      glyphMargin: true,
      lineNumbersMinChars: 4,
      wordWrap: 'off',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true },
      fixedOverflowWidgets: true,
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
    });

    editorRef.current = editor;
    bindEditor(editor);

    const contentSub = editor.onDidChangeModelContent(() => {
      useAppStore.getState().setCodeFromEditor(editor.getValue());
    });

    const cursorSub = editor.onDidChangeCursorPosition((event) => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      const selected = selection && model ? model.getValueInRange(selection).length : 0;
      useAppStore.getState().setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
        selected,
      });
    });

    // VS/VS Code muscle memory: F5 runs, Shift+F5 stops.
    editor.addCommand(monaco.KeyCode.F5, () => {
      void useAppStore.getState().run();
    });
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F5, () => {
      useAppStore.getState().stop();
    });

    editor.focus();

    return () => {
      contentSub.dispose();
      cursorSub.dispose();
      bindEditor(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;
    monaco.editor.setModelLanguage(model, language);
  }, [language]);

  // External code replacement (example switch, restored workspace) resyncs the
  // buffer. Typed input already matches, so the caret is never disturbed.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() !== code) editor.setValue(code);
  }, [code, codeRevision]);

  // Front-end diagnostics become Monaco markers, so errors are visible in place.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;

    // Only diagnostics from the open file may become markers: a diagnostic inside
    // <stdio.h> carries that header's line numbers, which would land on the wrong
    // lines if applied to main.c. They still show up in the Problems tab.
    const markers = diagnostics
      .filter((item) => item.source === path)
      .map((item) => ({
        severity:
          item.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : item.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: item.message,
        source: item.source,
        startLineNumber: item.startLine,
        startColumn: item.startColumn,
        endLineNumber: item.endLine,
        endColumn: item.endColumn,
      }));

    monaco.editor.setModelMarkers(model, 'cjit-front-end', markers);
  }, [diagnostics, path]);

  return (
    <>
      <div className="tabs">
        <div className="tab tab--active" title={path}>
          <span className="tab__dot" />
          <span>{path}</span>
        </div>
      </div>
      <div className="breadcrumb">
        <span>{path}</span>
        <span className="breadcrumb__sep">›</span>
        <span>{language === 'c' ? 'C' : 'C++'}</span>
        <span className="breadcrumb__hint">
          {diagnostics.length > 0 ? `${diagnostics.length} diagnostics` : 'no diagnostics'}
        </span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </>
  );
}
