/**
 * Debounce + cancellation for the realtime watch pass.
 *
 * Requirements this encodes:
 *  - a keystroke restarts the timer, so analysis runs 1s after typing stops;
 *  - an in-flight pass is aborted immediately when new input arrives, so stale
 *    values can never overwrite fresher ones;
 *  - `flush()` exists so a Run can force analysis without waiting out the timer.
 *
 * Pure timing/DOM-free logic on purpose: it is unit-tested with fake timers.
 */

export type AnalyzeFn = (code: string, signal: AbortSignal) => Promise<void>;

export interface DebouncedAnalyzerOptions {
  readonly delayMs: number;
  readonly analyze: AnalyzeFn;
  readonly onBusyChange?: (busy: boolean) => void;
}

export class DebouncedAnalyzer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private pendingCode: string | null = null;
  private disposed = false;
  private delayMs: number;

  constructor(private readonly options: DebouncedAnalyzerOptions) {
    this.delayMs = Math.max(0, options.delayMs);
  }

  /** Changes the delay for future passes; a scheduled pass keeps its own timer. */
  setDelay(delayMs: number): void {
    this.delayMs = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : this.delayMs;
  }

  get delay(): number {
    return this.delayMs;
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** Records the newest code and restarts the delay. */
  schedule(code: string): void {
    if (this.disposed) return;

    this.pendingCode = code;
    this.abortInFlight();

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Runs the pending analysis immediately, if there is one. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const code = this.pendingCode;
    this.pendingCode = null;
    if (this.disposed || code === null) return;

    const controller = new AbortController();
    this.controller = controller;
    this.options.onBusyChange?.(true);

    try {
      await this.options.analyze(code, controller.signal);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.options.onBusyChange?.(false);
      }
    }
  }

  /** Drops the pending pass and aborts the running one. The promise still settles. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingCode = null;
    this.abortInFlight();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private abortInFlight(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    this.options.onBusyChange?.(false);
  }
}
