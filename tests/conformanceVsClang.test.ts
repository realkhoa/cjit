import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClangRuntime } from '@/lang/clang/runtime';
import { FAST_CASES } from './conformance/corpus';

/**
 * The corpus, checked against the real compiler.
 *
 * The tests next door say the fast engine produces what the corpus claims. This one
 * says the corpus claims what clang produces - which is the half that catches a wrong
 * expectation. It caught three while the corpus was being written: the expected output
 * for `values[1]`, for `binary_search` and for a set's size were all guesses, and the
 * engine was right each time.
 *
 * Skipped when the toolchain is not downloaded, so a fresh clone and CI still pass.
 */

const TOOLCHAIN = path.resolve('public/toolchain');
const toolchainPresent = existsSync(path.join(TOOLCHAIN, 'clang'));

const localFiles = {
  readBytes: async (name: string) => new Uint8Array(await readFile(path.join(TOOLCHAIN, name))),
  readText: async (name: string) => readFileSync(path.join(TOOLCHAIN, name), 'utf8'),
};

describe.skipIf(!toolchainPresent)('conformance: what clang actually prints', () => {
  it.each(FAST_CASES.map((entry) => [entry.name, entry] as const))(
    '%s',
    async (_name, entry) => {
      const runOutput: string[] = [];
      const runtime = createClangRuntime({
        files: localFiles,
        onOutput: (text, phase) => {
          // Only what the program printed: the build channel carries clang's chatter.
          if (phase === 'run') runOutput.push(text);
        },
      });

      const outcome = await runtime.build({ fileName: entry.file, code: entry.code });

      expect(outcome.stage, `${entry.name}: ${outcome.failure ?? outcome.output}`).toBe('ok');

      /*
       * The runtime writes a newline of its own once the program has finished, so the
       * run channel ends with one more than the program printed. Comparing the program's
       * own output means dropping exactly that one; every case here differs by it and by
       * nothing else, which is what makes this comparison worth having.
       */
      const runOutputText = runOutput.join('').replace(/\n$/, '');
      expect(runOutputText).toBe(entry.expect);
    },
    60_000,
  );
});
