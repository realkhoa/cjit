import { describe, expect, it } from 'vitest';
import { createClangEngine, defaultToolchainBase } from '@/engine/clangEngine';
import type { RunSink, WatchSnapshot } from '@/engine/types';
import type { ClangRequest, ClangResponse } from '@/worker/clangProtocol';

/**
 * A stand-in for the clang worker. It records what was asked and replays scripted
 * responses, so the engine's streaming, cancellation and outcome mapping are
 * verified without compiling anything.
 */
class FakeWorker {
  private listeners: Array<(event: { data: unknown }) => void> = [];
  readonly posted: ClangRequest[] = [];
  terminated = false;
  /** When set, requests are held instead of answered (for cancellation tests). */
  hold = false;
  script: ClangResponse[] = [];

  postMessage(message: unknown): void {
    const request = message as ClangRequest;
    this.posted.push(request);
    if (this.hold) return;
    for (const response of this.script) this.emit(response);
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

  private emit(response: ClangResponse): void {
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({ data: response });
    });
  }
}

function engineWith(worker: FakeWorker) {
  return createClangEngine({
    createWorker: () => worker as unknown as Worker,
    toolchainBase: 'https://example.test/toolchain/',
  });
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

const PROGRAM = 'int main() { return 0; }\n';

describe('clang engine: toolchain URL', () => {
  /**
   * The site is deployed under a sub-path with `base: './'`, so the toolchain must
   * be resolved against the document, not the worker script - otherwise clang
   * would be requested from /assets/ and Run would fail on the live site only.
   */
  it('resolves the toolchain next to the page, not the worker', () => {
    const original = (globalThis as { document?: unknown }).document;
    try {
      (globalThis as { document?: unknown }).document = {
        baseURI: 'https://realkhoa.github.io/cjit/',
      };
      expect(defaultToolchainBase()).toBe('https://realkhoa.github.io/cjit/toolchain/');

      (globalThis as { document?: unknown }).document = { baseURI: 'http://127.0.0.1:5173/' };
      expect(defaultToolchainBase()).toBe('http://127.0.0.1:5173/toolchain/');
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});

describe('clang engine: the realtime pane never uses clang', () => {
  it('serves watch() from the fast engine, not the compiler', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);

    const snapshot = await engine.watch({ code: PROGRAM, file: 'main.cpp' }, new AbortController().signal);

    // A clang build cannot run once per second, so watch must not touch the worker.
    expect(worker.posted).toEqual([]);
    expect(snapshot.engine).toBe('fast');
    expect(snapshot.status).toBe('ok');
  });
});

describe('clang engine: run', () => {
  it('sends the file and streams build output apart from program output', async () => {
    const worker = new FakeWorker();
    worker.script = [
      { kind: 'status', requestId: 1, message: 'loading toolchain' },
      { kind: 'output', requestId: 1, phase: 'build', chunk: 'clang: warning: unused\n' },
      { kind: 'output', requestId: 1, phase: 'run', chunk: 'hello from the program\n' },
      {
        kind: 'done',
        requestId: 1,
        outcome: {
          status: 'ok',
          detail: 'built with clang + lld (600 KB wasm)',
          exitCode: 0,
          elapsedMs: 0,
          steps: 0,
          diagnostics: [],
        },
      },
    ];

    const engine = engineWith(worker);
    const sink = collectingSink();
    const outcome = await engine.run(
      { code: PROGRAM, file: 'main.cpp' },
      'input\n',
      sink,
      new AbortController().signal,
    );

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({
      kind: 'run',
      fileName: 'main.cpp',
      code: PROGRAM,
      stdin: 'input\n',
      toolchainBase: 'https://example.test/toolchain/',
    });

    // Build chatter is not the program's stdout.
    expect(sink.err.join('')).toContain('clang: warning');
    expect(sink.out.join('')).toContain('loading toolchain');
    expect(sink.out.join('')).toContain('hello from the program');
    expect(outcome.status).toBe('ok');
    expect(outcome.exitCode).toBe(0);
  });

  it('carries real compiler diagnostics through to the outcome', async () => {
    const worker = new FakeWorker();
    worker.script = [
      {
        kind: 'done',
        requestId: 1,
        outcome: {
          status: 'compile-error',
          detail: 'error: use of undeclared identifier',
          exitCode: 1,
          elapsedMs: 0,
          steps: 0,
          diagnostics: [
            {
              severity: 'error',
              message: 'use of undeclared identifier',
              source: 'main.cpp',
              startLine: 1,
              startColumn: 12,
              endLine: 1,
              endColumn: 13,
            },
          ],
        },
      },
    ];

    const engine = engineWith(worker);
    const sink = collectingSink();
    const outcome = await engine.run(
      { code: PROGRAM, file: 'main.cpp' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(outcome.status).toBe('compile-error');
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.startLine).toBe(1);
  });

  it('reports a missing toolchain as unsupported, so the caller can fall back', async () => {
    const worker = new FakeWorker();
    worker.script = [
      {
        kind: 'done',
        requestId: 1,
        outcome: {
          status: 'unsupported',
          detail: 'toolchain not available: cannot fetch clang',
          exitCode: null,
          elapsedMs: 0,
          steps: 0,
          diagnostics: [],
        },
      },
    ];

    const engine = engineWith(worker);
    const outcome = await engine.run(
      { code: PROGRAM, file: 'main.cpp' },
      '',
      collectingSink(),
      new AbortController().signal,
    );

    expect(outcome.status).toBe('unsupported');
    expect(outcome.detail).toContain('toolchain');
  });

  it('does not reach the worker when the file does not parse', async () => {
    const worker = new FakeWorker();
    const engine = engineWith(worker);
    const sink = collectingSink();

    const outcome = await engine.run(
      { code: 'int main( { return 0; }\n', file: 'broken.cpp' },
      '',
      sink,
      new AbortController().signal,
    );

    expect(worker.posted).toEqual([]);
    expect(outcome.status).toBe('compile-error');
    expect(sink.snapshots[0]?.status).toBe('compile-error');
  });

  it('stops a runaway build by terminating the worker', async () => {
    const worker = new FakeWorker();
    worker.hold = true;
    const engine = engineWith(worker);

    const controller = new AbortController();
    const pending = engine.run(
      { code: PROGRAM, file: 'main.cpp' },
      '',
      collectingSink(),
      controller.signal,
    );
    controller.abort();

    const outcome = await pending;
    expect(outcome.status).toBe('idle');
    expect(outcome.detail).toContain('stopped');
    expect(worker.terminated).toBe(true);
  });

  it('rejects when the worker reports a failure', async () => {
    const worker = new FakeWorker();
    worker.script = [{ kind: 'failure', requestId: 1, message: 'toolchain exploded' }];

    await expect(
      engineWith(worker).run(
        { code: PROGRAM, file: 'main.cpp' },
        '',
        collectingSink(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('toolchain exploded');
  });
});
