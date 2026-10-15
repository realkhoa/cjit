import { describe, expect, it } from 'vitest';
import { analyzeSource } from '@/lang/analyze';
import { execute } from '@/lang/runtime/interpreter';
import { CORPUS, FAST_CASES, GAP_CASES } from './conformance/corpus';
import type { ConformanceCase } from './conformance/corpus';

/**
 * The fast engine against the conformance corpus.
 *
 * Two rules, and the second is the one that matters:
 *
 * - A `fast` case must produce exactly the output a native compiler produces. Not
 *   "similar", not "contains": equal.
 * - A `clang-only` case may be refused. What it may never do is print something else -
 *   a plausible wrong answer is the one outcome this engine must not have.
 *
 * When a gap closes, the fix is to move the case to `fast` and let the first rule hold
 * it: the corpus is the work list *and* the regression guard.
 */

function runCase(entry: ConformanceCase) {
  const analysis = analyzeSource(entry.code, entry.file);
  try {
    const result = execute(analysis.unit, { collectWatch: true });
    return {
      result,
      diagnostics: analysis.diagnostics.map((item) => `${item.severity}: ${item.message}`),
      crashed: null as string | null,
    };
  } catch (error) {
    /*
     * Some gaps end in an internal fault rather than a reported one - a reference that
     * is not modelled leaves a pointer to unmapped memory and the engine stops. That is
     * a loud failure, which is the honest half of the contract, so it is recorded here
     * rather than being allowed to look like a broken test.
     */
    return {
      result: { status: 'threw', stdout: '', stderr: '', detail: '' },
      diagnostics: analysis.diagnostics.map((item) => `${item.severity}: ${item.message}`),
      crashed: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('conformance: programs the fast engine must run exactly', () => {
  it.each(FAST_CASES.map((entry) => [entry.name, entry] as const))(
    '%s',
    (_name, entry) => {
      const { result, diagnostics } = runCase(entry);

      expect(result.status, `${entry.file}: ${result.detail} ${diagnostics.join(' | ')}`).toBe('ok');
      expect(result.stdout).toBe(entry.expect);
      // A program that runs cleanly is not allowed to carry warnings either: the pane
      // would be telling the user something is wrong with correct code.
      expect(diagnostics.filter((item) => item.startsWith('warning'))).toEqual([]);
      expect(diagnostics.filter((item) => item.startsWith('error'))).toEqual([]);
    },
    30_000,
  );
});

describe('conformance: known gaps, which must fail honestly', () => {
  it.each(GAP_CASES.map((entry) => [entry.name, entry] as const))(
    '%s',
    (_name, entry) => {
      const { result, diagnostics, crashed } = runCase(entry);

      if (crashed === null && result.status === 'ok' && result.stdout === entry.expect) {
        // The gap has closed: this case belongs in `fast` now.
        throw new Error(
          `"${entry.name}" now matches a native compiler - move it to support: 'fast' to lock it in`,
        );
      }

      // Anything else is fine, as long as it is *visible* and is not a wrong answer.
      expect(result.stdout).not.toBe(entry.expect);
      if (crashed !== null) {
        // Stopped with a message rather than printing something plausible.
        expect(crashed.length).toBeGreaterThan(0);
        return;
      }
      if (result.status === 'ok') {
        // Ran to the end but printed something else: only acceptable when it printed
        // nothing at all, which means it did not pretend to compute the answer.
        expect(result.stdout).toBe('');
      } else {
        const visible =
          diagnostics.length > 0 || result.detail.length > 0 || result.stderr.length > 0;
        expect(visible, `${entry.name} failed without saying anything`).toBe(true);
      }
    },
    30_000,
  );
});

describe('the corpus itself', () => {
  it('has no duplicate names, and every case says what it is for', () => {
    const names = CORPUS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);

    for (const entry of CORPUS) {
      expect(entry.code.length).toBeGreaterThan(0);
      // Each case must produce output, or it would not prove anything.
      expect(entry.expect.length).toBeGreaterThan(0);
      if (entry.support === 'clang-only') expect(entry.note?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('covers a useful share of C++ the engine claims to support', () => {
    expect(FAST_CASES.length).toBeGreaterThanOrEqual(15);
    expect(GAP_CASES.length).toBeGreaterThan(0);
  });
});
