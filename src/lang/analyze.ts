import type { Diagnostic } from '@/engine/types';
import type { TranslationUnit } from '@/lang/ast';
import { sortDiagnostics } from '@/lang/diagnostics';
import { parse } from '@/lang/parser';
import { preprocess } from '@/lang/preprocessor';
import type { MacroDefinition, PreprocessOptions } from '@/lang/preprocessor';
import { buildSymbolTable } from '@/lang/symbols';
import type { SymbolTable } from '@/lang/symbols';
import type { Token } from '@/lang/token';

/**
 * The fast engine's front-end pipeline: preprocess -> parse -> symbols.
 *
 * Synchronous and allocation-light on purpose: this runs 1 second after every
 * keystroke, so it has to stay in the low milliseconds and must never throw.
 */

export interface AnalysisResult {
  readonly file: string;
  readonly tokens: readonly Token[];
  readonly unit: TranslationUnit;
  readonly symbols: SymbolTable;
  readonly diagnostics: readonly Diagnostic[];
  readonly macros: ReadonlyMap<string, MacroDefinition>;
  /** Virtual documents (built-in headers) that go-to-definition can open. */
  readonly sources: ReadonlyMap<string, string>;
  readonly implicitHeaders: boolean;
  readonly tokenCount: number;
  readonly elapsedMs: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}

export function analyzeSource(
  code: string,
  file: string,
  options: PreprocessOptions = {},
): AnalysisResult {
  const startedAt = Date.now();

  const pre = preprocess(code, file, options);
  const parsed = parse(pre.tokens, file);
  const symbols = buildSymbolTable(parsed.unit, parsed.typedefs);

  const diagnostics = sortDiagnostics([...pre.diagnostics, ...parsed.diagnostics]);

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const item of diagnostics) {
    if (item.severity === 'error') errorCount += 1;
    else if (item.severity === 'warning') warningCount += 1;
    else infoCount += 1;
  }

  return {
    file,
    tokens: pre.tokens,
    unit: parsed.unit,
    symbols,
    diagnostics,
    macros: pre.macros,
    sources: pre.sources,
    implicitHeaders: pre.implicitHeaders,
    tokenCount: pre.tokens.length,
    elapsedMs: Date.now() - startedAt,
    errorCount,
    warningCount,
    infoCount,
  };
}
