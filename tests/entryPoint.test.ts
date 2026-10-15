import { describe, expect, it } from 'vitest';
import { definesMain } from '@/lang/clang/runtime';

/**
 * Which files are programs, for the one-entry-point rule.
 *
 * The bundled project ships `main.cpp` and `hello.c`, and both define `main`:
 * linking them together fails with a duplicate-symbol error that explains nothing.
 * This decides which files are offered as the entry point; the linker stays the
 * authority on whether the program is valid.
 */

describe('definesMain', () => {
  it('recognises the usual C and C++ spellings', () => {
    expect(definesMain('int main(void) { return 0; }')).toBe(true);
    expect(definesMain('int main() {\n    return 0;\n}')).toBe(true);
    expect(definesMain('int main(int argc, char** argv) { return argc; }')).toBe(true);
    expect(definesMain('void main()\n{\n}')).toBe(true);
  });

  it('does not mistake a declaration for a definition', () => {
    // A prototype, and a call, are not an entry point.
    expect(definesMain('int main(void);')).toBe(false);
    expect(definesMain('int helper(void) { return 0; }')).toBe(false);
    expect(definesMain('// int main() { return 0; }')).toBe(false);
    expect(definesMain('#pragma once\n\nvoid printAll(int value);\n')).toBe(false);
  });

  it('ignores a function whose name merely contains main', () => {
    expect(definesMain('int domain(void) { return 0; }')).toBe(false);
    expect(definesMain('int mainLoop(void) { return 0; }')).toBe(false);
  });

  it('handles a body written on the next line', () => {
    expect(definesMain('int main(void)\n{\n    return 0;\n}')).toBe(true);
  });
});
