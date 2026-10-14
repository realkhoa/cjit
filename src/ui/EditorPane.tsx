import { useEffect, useMemo, useRef, Fragment } from 'react';
import type * as Monaco from 'monaco-editor';
import { registerKeywordCompletions, registerSymbolCompletions } from '@/editor/completion';
import { breadcrumbAt } from '@/editor/intelligence';
import { monaco } from '@/editor/monacoSetup';
import { bindEditor } from '@/editor/navigation';
import { registerIntelligenceProviders } from '@/editor/providers';
import { useIsMobile } from '@/ui/useIsMobile';
import { getPublishedAnalysis } from '@/lang/analysisCache';
import { useAppStore } from '@/state/store';
import { inlineDecorationSpecs } from '@/ui/inlineValues';
import { EDITOR_THEME_DARK } from '@/ui/theme/monacoTheme';

type Editor = Monaco.editor.IStandaloneCodeEditor;

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  const language = useAppStore((state) => state.language);
  const code = useAppStore((state) => state.code);
  const codeRevision = useAppStore((state) => state.codeRevision);
  const path = useAppStore((state) => state.path);
  const diagnostics = useAppStore((state) => state.watch.diagnostics);
  const watch = useAppStore((state) => state.watch);
  const inlineValuesEnabled = useAppStore((state) => state.settings.inlineValues);
  const fontSize = useAppStore((state) => state.settings.fontSize);
  const minimap = useAppStore((state) => state.settings.minimap);
  const mobilePane = useAppStore((state) => state.mobilePane);
  const isMobile = useIsMobile();
  const cursorLine = useAppStore((state) => state.cursor.line);
  const files = useAppStore((state) => state.files);
  const activeFileId = useAppStore((state) => state.activeFileId);
  const openFile = useAppStore((state) => state.openFile);
  const createFile = useAppStore((state) => state.createFile);

  // Symbol trail at the caret, from the document symbols the front-end produces.
  const breadcrumb = useMemo(() => {
    const analysis = getPublishedAnalysis();
    if (!analysis) return [] as string[];
    return breadcrumbAt(analysis, cursorLine);
  }, [watch, cursorLine]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    registerKeywordCompletions(monaco);
    registerSymbolCompletions(monaco);
    registerIntelligenceProviders(monaco);

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

    // Editor actions also appear in Monaco's own command palette (F1 /
    // Ctrl+Shift+P), which is why they are registered as actions and not as bare
    // key bindings.
    editor.addAction({
      id: 'cjit.run',
      label: 'C/C++ Studio: Run program',
      keybindings: [monaco.KeyCode.F5],
      run: () => void useAppStore.getState().run(),
    });
    editor.addAction({
      id: 'cjit.stop',
      label: 'C/C++ Studio: Stop program',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F5],
      run: () => useAppStore.getState().stop(),
    });
    editor.addAction({
      id: 'cjit.newFile',
      label: 'C/C++ Studio: New file',
      run: () => useAppStore.getState().createFile(),
    });
    editor.addAction({
      id: 'cjit.inlineValues',
      label: 'C/C++ Studio: Toggle inline values',
      run: () => useAppStore.getState().toggleInlineValues(),
    });
    editor.addAction({
      id: 'cjit.shareLink',
      label: 'C/C++ Studio: Copy share link',
      run: () => void useAppStore.getState().shareLink(),
    });
    editor.addAction({
      id: 'cjit.resetWorkspace',
      label: 'C/C++ Studio: Reset workspace to the default example',
      run: () => useAppStore.getState().resetWorkspace(),
    });

    editor.focus();

    return () => {
      contentSub.dispose();
      cursorSub.dispose();
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      bindEditor(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Settings that the editor itself applies.
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      // On a phone the minimap and sticky scroll cost width and height that the
      // code needs far more than the overview does.
      minimap: { enabled: minimap && !isMobile, renderCharacters: false, maxColumn: 90 },
      stickyScroll: { enabled: !isMobile },
      // Reading code on a phone means never scrolling sideways to find the end of
      // a line, so narrow screens wrap.
      wordWrap: isMobile ? 'on' : 'off',
    });
  }, [fontSize, minimap, isMobile]);

  // On narrow screens this pane is hidden with `display:none` while another tab is
  // active, which leaves Monaco with a zero-sized container. It has to re-measure
  // when it becomes visible again.
  useEffect(() => {
    if (!isMobile || mobilePane !== 'code') return;
    const frame = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(frame);
  }, [isMobile, mobilePane]);

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

  // Clear while the user is typing: a decoration anchored to text that moved would
  // otherwise show a value for the wrong line until the next pass lands.
  useEffect(() => {
    decorationsRef.current?.clear();
  }, [code]);

  // Inline value overlays: `// total = 6` rendered after each executed line.
  // They come from the interpreter's per-line states, so a line only shows values
  // if it actually ran, and only values that line produced.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    let collection = decorationsRef.current;
    if (!collection) {
      collection = editor.createDecorationsCollection([]);
      decorationsRef.current = collection;
    }

    if (!inlineValuesEnabled) {
      collection.clear();
      return;
    }

    collection.set(
      inlineDecorationSpecs(watch, (line) => model.getLineLength(line)).map((spec) => ({
        range: new monaco.Range(spec.line, spec.startColumn, spec.line, spec.endColumn),
        options: {
          after: { content: spec.content, inlineClassName: spec.className },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          description: 'cjit inline value',
        },
      })),
    );
  }, [watch, inlineValuesEnabled]);

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
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            className={file.id === activeFileId ? 'tab tab--active' : 'tab'}
            onClick={() => openFile(file.id)}
            title={file.path}
          >
            <span className="tab__dot" data-language={file.language} />
            <span>{file.path}</span>
          </button>
        ))}
        <button type="button" className="tab tab--add" onClick={createFile} title="File mới">
          ＋
        </button>
      </div>
      <div className="breadcrumb">
        <span>{path}</span>
        <span className="breadcrumb__sep">›</span>
        <span>{language === 'c' ? 'C' : 'C++'}</span>
        {breadcrumb.map((segment) => (
          <Fragment key={segment}>
            <span className="breadcrumb__sep">›</span>
            <span className="breadcrumb__symbol">{segment}</span>
          </Fragment>
        ))}
        <span className="breadcrumb__hint">
          {diagnostics.length > 0 ? `${diagnostics.length} diagnostics` : 'no diagnostics'}
        </span>
      </div>
      <div className="editor-host" ref={hostRef} />
    </>
  );
}
