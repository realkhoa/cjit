import { describe, expect, it } from 'vitest';
import type { RunOutcome, RunSink, WatchSnapshot } from '@/engine/types';
import { createWorkerEngine } from '@/engine/workerEngine';
import type { WorkerRequest, WorkerResponse } from '@/worker/protocol';
import { handleWorkerRequest } from '@/worker/workerHandler';

/**
 * A stand-in for a real Worker that routes every request through the *actual*
 * worker handler. That makes the whole protocol - requests, streaming chunks,
 * completion, cancellation - testable without a worker in the test runtime.
 */
class FakeWorker {
  private listeners: Array<(event: { data: unknown }) => void> = [];
  private queue: WorkerRequest[] = [];
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  /** When true, requests are held instead of executed (to test cancellation). */
  hold = false;
  /** When true, the worker answers with a failure response. */
  fail = false;

  postMessage(message: unknown): void {
    const request = message as WorkerRequest;
    this.posted.push(request);
    if (this.hold) {
      this.queue.push(request);
      return;
    }
    this.execute(request);
  }

  addEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers everything that was held while `hold` was true. */
  release(): void {
    const held = this.queue;
    this.queue = [];
    for (const request of held) this.execute(request);
  }

  private execute(request: WorkerRequest): void {
    if (this.fail) {
      this.emit({ kind: 'failure', requestId: request.requestId, message: 'worker exploded' });
      return;
    }
    handleWorkerRequest(request, (response) => this.emit(response));
  }

  private emit(response: WorkerResponse): void {
    // A real worker delivers messages asynchronously.
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({ data: response });
    });
  }
}

function engineWith(worker: FakeWorker) {
  return createWorkerEngine({ createWorker: () => worker as unknown as Worker });
}

function collectingSink(): RunSink & { out: string[]; err: string[]; snapshots: WatchSnapshot[] } {
  const out: string[] = [];
  const err: string[] = [];
  const snapshots: WatchSnapshot[] = [];
  return {
    out,
    err,
    snapshots,
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    watch: (snapshot) => snapshots.push(snapshot),
  };
}

const PROGRAM = [
  'int main(void) {',
  '    int total = 0;',
  '    for (int i = 1; i <= 3; i++) { total += i; }',
  '    printf("total=%d\\n", total);',
  '    return 0;',
  '}',
].join('\n');

describe('worker engine: watch', () => {
  it('returns the snapshot the worker produced, with real values', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);

    const snapshot = await engine.watch(
      { code: PROGRAM, file: 'main.c' },
      new AbortController().signal,
    );

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]?.kind).toBe('watch');
    expect(snapshot.status).toBe('ok');
    const total = snapshot.vars.find((item) => item.name === 'total');
    expect(total?.value).toBe('6');
  });

  it('does not reach the worker for code that does not compile', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);

    const snapshot = await engine.watch(
      { code: 'int main(void) { int a = ; }', file: 'main.c' },
      new AbortController().signal,
    );

    expect(worker.posted).toHaveLength(0);
    expect(snapshot.status).toBe('compile-error');
  });

  it('terminates the worker and reports idle when the pass is cancelled', async () => {
    const worker = new FakeWorker();
    worker.hold = true;
    const engine = engineWith(worker);

    const controller = new AbortController();
    const pending = engine.watch({ code: PROGRAM, file: 'main.c' }, controller.signal);
    controller.abort();

    const snapshot = await pending;
    expect(snapshot.status).toBe('idle');
    expect(snapshot.detail).toContain('cancelled');
    expect(worker.terminated).toBe(true);
  });

  it('rejects when the worker reports a failure', async () => {
    const worker = new FakeWorker();
    worker.fail = true;
    const engine = engineWith(worker);

    await expect(
      engine.watch({ code: PROGRAM, file: 'main.c' }, new AbortController().signal),
    ).rejects.toThrow('worker exploded');
  });
});

describe('worker engine: run', () => {
  it('streams stdout and resolves with the outcome', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);
    const sink = collectingSink();

    const outcome = await engine.run(
      { code: PROGRAM, file: 'main.c' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(sink.out.join('')).toBe('total=6\n');
    expect(outcome.status).toBe('ok');
    expect(outcome.exitCode).toBe(0);
    expect(sink.snapshots).toHaveLength(1);
  });

  it('passes stdin through to the program', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);
    const sink = collectingSink();

    const outcome = await engine.run(
      {
        code: 'int main(void) { int a = 0; scanf("%d", &a); printf("%d\\n", a * 2); return 0; }',
        file: 'main.c',
      },
      '21\n',
      sink,
      new AbortController().signal,
    );

    expect(outcome.status).toBe('ok');
    expect(sink.out.join('')).toBe('42\n');
  });

  it('reports a build failure without involving the worker', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);
    const sink = collectingSink();

    const outcome = await engine.run(
      { code: 'int main(void) { int a = ; }', file: 'main.c' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(worker.posted).toHaveLength(0);
    expect(outcome.status).toBe('compile-error');
    expect(sink.snapshots[0]?.status).toBe('compile-error');
  });

  it('stops a runaway run by terminating the worker', async () => {
    const worker = new FakeWorker();
    worker.hold = true;
    const engine = engineWith(worker);
    const sink = collectingSink();

    const controller = new AbortController();
    const pending = engine.run(
      { code: 'int main(void) { while (1) { } }', file: 'main.c' },
      '',
      sink,
      controller.signal,
    );
    controller.abort();

    const outcome: RunOutcome = await pending;
    expect(outcome.status).toBe('idle');
    expect(outcome.detail).toContain('stopped');
    expect(worker.terminated).toBe(true);
  });
});
