// Granular Monaco assembly.
//
// The package entry (`monaco-editor`) pulls in every basic language (php, ruby,
// abap, solidity, ...) plus the TypeScript/CSS/HTML/JSON language services, none
// of which this app uses. `edcore.main` is exactly the full editor feature set -
// find, suggest, hover, format, bracket matching, quick access - *without* any
// language contribution, so only C/C++ is registered afterwards.
//
// Types come from `editor.api` (the only ESM entry with a .d.ts); the side-effect
// imports below reuse the same module instance at runtime.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/edcore.main';
// Registers both language ids: "c" (.c) and "cpp" (.cpp, .cc, .hxx, ...).
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { defineEditorThemes } from '@/ui/theme/monacoTheme';

let configured = false;

/**
 * Vite bundles the Monaco core worker itself, so no CDN and no
 * `MonacoEnvironment.getWorkerUrl` path juggling is needed - which also keeps
 * the app working when served from a GitHub Pages sub-path.
 */
export function setupMonacoEnvironment(): void {
  if (configured) return;
  configured = true;

  (globalThis as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  defineEditorThemes(monaco);
}

export { monaco };
