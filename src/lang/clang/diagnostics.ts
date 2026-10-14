import type { Diagnostic, Severity } from '@/engine/types';

/**
 * Parsing clang's own diagnostics.
 *
 * The compiler runs inside a worker and prints human-readable text; turning that
 * text into structured diagnostics is what puts real compiler errors in the
 * Problems tab and as markers in the editor - instead of just dumping them into
 * the console.
 */

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** `file:line:col: error: message` */
const LOCATED = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note|remark):\s*(.*)$/;
/** `wasm-ld: error: message` or `clang: error: message` */
const TOOL_LEVEL = /^([\w./+-]+):\s*(fatal error|error|warning):\s*(.+)$/;
const MAX_DIAGNOSTICS = 200;

function severityOf(word: string): Severity {
  if (word === 'warning') return 'warning';
  if (word === 'note' || word === 'remark') return 'info';
  return 'error';
}

/**
 * A path inside the sysroot (starting with `/`) belongs to a system header, not
 * to the file the user is editing. It is reported with the header's label so the
 * editor does not place a marker on the wrong line.
 */
function sourceLabel(file: string): string {
  if (!file.startsWith('/')) return file;
  const name = file.slice(file.lastIndexOf('/') + 1);
  return `<${name}>`;
}

export function parseClangDiagnostics(text: string, userFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const located = LOCATED.exec(line);
    if (located) {
      const file = located[1] ?? userFile;
      const lineNumber = Number.parseInt(located[2] ?? '1', 10);
      const column = Number.parseInt(located[3] ?? '1', 10);
      diagnostics.push({
        severity: severityOf(located[4] ?? 'error'),
        message: (located[5] ?? '').trim(),
        source: sourceLabel(file),
        startLine: Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : 1,
        startColumn: Number.isFinite(column) && column > 0 ? column : 1,
        endLine: Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : 1,
        endColumn: (Number.isFinite(column) && column > 0 ? column : 1) + 1,
      });
      continue;
    }

    // Tool-level failures (linker, driver) have no position of their own.
    const toolLevel = TOOL_LEVEL.exec(line);
    if (toolLevel) {
      diagnostics.push({
        severity: severityOf(toolLevel[2] ?? 'error'),
        message: (toolLevel[3] ?? '').trim(),
        source: userFile,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 2,
      });
    }
  }

  return diagnostics;
}

/** `5 errors generated.` and similar summaries are not diagnostics. */
export function isSummaryLine(line: string): boolean {
  return /^\d+ (errors?|warnings?) generated\.?$/.test(line.trim());
}
