import type { Severity, WatchStatus } from '@/engine/types';
import type { AnalysisState, RunState } from '@/state/store';

export type Tone = 'idle' | 'busy' | 'ok' | 'error' | 'warning';

export function overallLabel(runState: RunState, analysisState: AnalysisState): string {
  if (runState === 'running') return 'Running';
  if (analysisState === 'analyzing') return 'Analyzing';
  return 'Ready';
}

export function overallTone(
  runState: RunState,
  analysisState: AnalysisState,
  status: WatchStatus,
): Tone {
  if (runState === 'running' || analysisState === 'analyzing') return 'busy';
  switch (status) {
    case 'compile-error':
    case 'runtime-error':
      return 'error';
    case 'timeout':
    case 'budget':
      return 'warning';
    case 'ok':
      return 'ok';
    default:
      return 'idle';
  }
}
export function dotClass(tone: Tone): string {
  switch (tone) {
    case 'busy':
      return 'statusbar__dot statusbar__dot--busy';
    case 'ok':
      return 'statusbar__dot statusbar__dot--ok';
    case 'error':
    case 'warning':
      return 'statusbar__dot statusbar__dot--error';
    default:
      return 'statusbar__dot';
  }
}

export function pillClass(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'pill pill--ok';
    case 'error':
      return 'pill pill--error';
    case 'warning':
      return 'pill pill--warning';
    case 'busy':
      return 'pill pill--busy';
    default:
      return 'pill';
  }
}

export function watchStatusLabel(status: WatchStatus): string {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'ok':
      return 'values available';
    case 'front-end-only':
      return 'front-end only';
    case 'compile-error':
      return 'build failed';
    case 'runtime-error':
      return 'runtime error';
    case 'timeout':
      return 'timeout';
    case 'budget':
      return 'step budget hit';
    case 'unsupported':
      return 'engine not wired';
  }
}

export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'idle';
  }
}
