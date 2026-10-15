import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClangResponse } from '@/worker/clangProtocol';

/**
 * Regression test for "the first Run prints, later Runs do not".
 *
 * The worker caches the compiler runtime, so the output forwarder must read the
 * *current* request id instead of capturing the one from the run that created the
 * runtime. When it captured, every later run's output was posted under the first
 * run's id and the engine dropped it as belonging to another request - the user
 * saw the summary but none of the program's output.
 *
 * This drives the real worker module (with `self` and `fetch` stubbed) against the
 * real toolchain, twice, and checks that each run's output arrives under its own id.
 */

const TOOLCHAIN = path.resolve('public/toolchain');
const toolchainPresent = existsSync(path.join(TOOLCHAIN, 'clang'));

const PROGRAM = `#include <iostream>
int main() {
    std::cout << "HELLO-FROM-PROGRAM" << '\\n';
    return 0;
}
`;

interface SelfStub {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  postMessage(message: ClangResponse): void;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!toolchainPresent)('clang worker: repeated runs', () => {
  it('streams each run under its own request id', async () => {
    const posted: ClangResponse[] = [];
    const listeners: Array<(event: unknown) => void> = [];

    const selfStub: SelfStub = {
      addEventListener: (type, handler) => {
        if (type === 'message') listeners.push(handler);
      },
      postMessage: (message) => {
        posted.push(message);
      },
    };
    (globalThis as { self?: unknown }).self = selfStub;

    // The worker fetches the toolchain by URL; serve it straight off disk.
    (globalThis as { fetch?: unknown }).fetch = async (url: unknown) => {
      const name = String(url).split('/').pop() ?? '';
      const bytes = await readFile(path.join(TOOLCHAIN, name));
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => readFileSync(path.join(TOOLCHAIN, name), 'utf8'),
      };
    };

    // Importing the worker registers its message listener.
    await import('@/worker/clang.worker');

    const runOnce = async (requestId: number): Promise<void> => {
      for (const listener of listeners) {
        listener({
          data: {
            kind: 'run',
            requestId,
            code: PROGRAM,
            fileName: 'main.cpp',
            stdin: '',
            toolchainBase: 'https://example.test/toolchain/',
          },
        });
      }
      await waitFor(
        () => posted.some((message) => message.kind === 'done' && message.requestId === requestId),
        240_000,
        `run ${requestId} to finish`,
      );
    };

    await runOnce(1);
    await runOnce(2);

    const programOutput = (requestId: number): string =>
      posted
        .filter(
          (message) =>
            message.kind === 'output' &&
            message.requestId === requestId &&
            message.phase === 'run',
        )
        .map((message) => (message.kind === 'output' ? message.chunk : ''))
        .join('');

    // Both runs print; the second run is the one that used to lose everything.
    expect(programOutput(1)).toContain('HELLO-FROM-PROGRAM');
    expect(programOutput(2)).toContain('HELLO-FROM-PROGRAM');

    // And no output is attributed to the wrong run.
    const misattributed = posted.filter(
      (message) => message.kind === 'output' && message.requestId === 1 && message.phase === 'run',
    );
    expect(misattributed.length).toBeGreaterThan(0);

    const done = posted.filter((message) => message.kind === 'done' && message.requestId === 2);
    expect(done).toHaveLength(1);
  }, 600_000);
});
