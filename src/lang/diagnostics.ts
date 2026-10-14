import type { Diagnostic, Severity } from '@/engine/types';
import type { SourcePos, Token } from '@/lang/token';

/**
 * Diagnostic construction. The shape is the engine contract's `Diagnostic`
 * (1-based line/column), so front-end output can be handed to Monaco markers or
 * to the Problems tab without translation.
 */

export function makeDiagnostic(
  severity: Severity,
  message: string,
  file: string,
  start: SourcePos,
  end: SourcePos = start,
): Diagnostic {
  return {
    severity,
    message,
    source: file,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: Math.max(end.column, start.column + 1),
  };
}

export function fromToken(severity: Severity, message: string, token: Token): Diagnostic {
  return makeDiagnostic(severity, message, token.file, token.start, token.end);
}

export function atOffset(
  severity: Severity,
  message: string,
  file: string,
  pos: SourcePos,
): Diagnostic {
  return makeDiagnostic(severity, message, file, pos);
}

/** Stable order: by file, then position, then severity. */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const weight: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...list].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
    return weight[a.severity] - weight[b.severity];
  });
}

export function countSeverity(list: readonly Diagnostic[]): {
  error: number;
  warning: number;
  info: number;
} {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const item of list) {
    if (item.severity === 'error') error += 1;
    else if (item.severity === 'warning') warning += 1;
    else info += 1;
  }
  return { error, warning, info };
}

export function hasErrors(list: readonly Diagnostic[]): boolean {
  return list.some((item) => item.severity === 'error');
}

/** One-line summary used by the status bar and engine detail. */
export function summarize(list: readonly Diagnostic[]): string {
  const { error, warning, info } = countSeverity(list);
  if (error === 0 && warning === 0 && info === 0) return 'no diagnostics';
  const parts: string[] = [];
  if (error > 0) parts.push(`${error} error${error === 1 ? '' : 's'}`);
  if (warning > 0) parts.push(`${warning} warning${warning === 1 ? '' : 's'}`);
  if (info > 0) parts.push(`${info} note${info === 1 ? '' : 's'}`);
  return parts.join(', ');
}
