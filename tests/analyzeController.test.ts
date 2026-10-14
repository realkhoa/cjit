import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebouncedAnalyzer } from '@/state/analyzeController';

afterEach(() => {
  vi.useRealTimers();
});

describe('DebouncedAnalyzer', () => {
  it('analyzes once, 1s after the last keystroke, using the newest code', async () => {
    vi.useFakeTimers();
    const analyzed: string[] = [];
    const analyzer = new DebouncedAnalyzer({
      delayMs: 1000,
      analyze: async (code) => {
        analyzed.push(code);
      },
    });

    analyzer.schedule('int');
    await vi.advanceTimersByTimeAsync(400);
    analyzer.schedule('int x');
    await vi.advanceTimersByTimeAsync(400);
    analyzer.schedule('int x = 1;');
    expect(analyzed).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(analyzed).toEqual(['int x = 1;']);

    analyzer.dispose();
  });

  it('aborts the in-flight pass as soon as new code arrives, so stale values cannot win', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];

    // Never resolves on its own: only an abort settles it, exactly like a real
    // long-running pass that must be cancelled mid-flight.
    const analyzer = new DebouncedAnalyzer({
      delayMs: 1000,
      analyze: (_code, signal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });

    analyzer.schedule('first');
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    analyzer.schedule('second');
    expect(signals[0]?.aborted).toBe(true);

    // The aborted pass settles, but the second one must wait out its own delay.
    await vi.advanceTimersByTimeAsync(500);
    expect(signals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);

    analyzer.dispose();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('reports busy while a pass is running and clears it when the pass settles', async () => {
    vi.useFakeTimers();
    const busy: boolean[] = [];
    const analyzer = new DebouncedAnalyzer({
      delayMs: 1000,
      analyze: async () => undefined,
      onBusyChange: (value) => busy.push(value),
    });

    analyzer.schedule('code');
    await vi.advanceTimersByTimeAsync(1000);
    expect(busy).toEqual([true, false]);

    analyzer.dispose();
  });

  it('drops a scheduled pass when cancelled, and ignores work after dispose', async () => {
    vi.useFakeTimers();
    const analyzed: string[] = [];
    const analyzer = new DebouncedAnalyzer({
      delayMs: 1000,
      analyze: async (code) => {
        analyzed.push(code);
      },
    });

    analyzer.schedule('code');
    analyzer.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(analyzed).toEqual([]);

    analyzer.dispose();
    analyzer.schedule('after dispose');
    await vi.advanceTimersByTimeAsync(2000);
    expect(analyzed).toEqual([]);
  });

  it('flush() runs the pending pass immediately without waiting for the delay', async () => {
    vi.useFakeTimers();
    const analyzed: string[] = [];
    const analyzer = new DebouncedAnalyzer({
      delayMs: 1000,
      analyze: async (code) => {
        analyzed.push(code);
      },
    });

    analyzer.schedule('code');
    await analyzer.flush();
    expect(analyzed).toEqual(['code']);

    analyzer.dispose();
  });
});
