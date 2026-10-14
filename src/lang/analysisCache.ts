import type { AnalysisResult } from '@/lang/analyze';

/**
 * Side channel from the fast engine to the editor.
 *
 * The engine contract (`Engine.watch`) returns a `WatchSnapshot`, which is what
 * the watch pane needs but not what completion needs: that requires the symbol
 * table with its scope ranges. Rather than widening the engine contract with
 * fast-engine internals, the engine publishes its last analysis here and the
 * editor reads it synchronously while building completions.
 *
 * Only the most recent analysis is kept, and only for the code that produced it.
 */

let latest: AnalysisResult | null = null;

export function publishAnalysis(result: AnalysisResult): void {
  latest = result;
}

export function getPublishedAnalysis(): AnalysisResult | null {
  return latest;
}

export function clearPublishedAnalysis(): void {
  latest = null;
}
