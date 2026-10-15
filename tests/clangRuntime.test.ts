import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClangDiagnostics, stripAnsi } from '@/lang/clang/diagnostics';
import { createClangRuntime } from '@/lang/clang/runtime';

/**
 * These tests drive the real WebAssembly toolchain (`npm run toolchain`), so they
 * are the evidence that "Run compiles real C/C++" - no browser required. They are
 * skipped when the toolchain is not downloaded, so a fresh clone still passes.
 */

const TOOLCHAIN = path.resolve('public/toolchain');
const toolchainPresent = existsSync(path.join(TOOLCHAIN, 'clang'));

const localFiles = {
  readBytes: async (name: string) => new Uint8Array(await readFile(path.join(TOOLCHAIN, name))),
  readText: async (name: string) => readFileSync(path.join(TOOLCHAIN, name), 'utf8'),
};

const C_PROGRAM = `#include <stdio.h>

int main(void) {
    int total = 0;
    for (int i = 1; i <= 4; i++) {
        total += i * i;
    }
    printf("c: total=%d\\n", total);
    return 0;
}
`;

const CPP_PROGRAM = `#include <iostream>
#include <vector>
#include <string>
#include <algorithm>

template <typename T>
T sum(const std::vector<T>& values) {
    T total{};
    for (const auto& value : values) {
        total += value;
    }
    return total;
}

int main() {
    std::vector<int> numbers{5, 3, 9, 1};
    std::sort(numbers.begin(), numbers.end());

    std::string label = "sorted";
    std::cout << label << ": ";
    for (int number : numbers) {
        std::cout << number << ' ';
    }
    std::cout << "\\nsum = " << sum(numbers) << '\\n';
    return 0;
}
`;

describe('clang diagnostics parsing', () => {
  it('strips the colour codes clang emits', () => {
    expect(stripAnsi('\u001b[1mfile.cpp:1:2: \u001b[0merror: bad')).toBe('file.cpp:1:2: error: bad');
  });

  it('turns compiler output into positioned diagnostics', () => {
    const output = [
      '\u001b[1mmain.cpp:6:10: \u001b[0m\u001b[0;1;31merror: \u001b[0mno member named x',
      '    std::optional<int> maybe;',
      'main.cpp:7:5: warning: unused variable',
      '5 errors generated.',
    ].join('\n');

    const diagnostics = parseClangDiagnostics(output, 'main.cpp');

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      source: 'main.cpp',
      startLine: 6,
      startColumn: 10,
    });
    expect(diagnostics[0]?.message).toContain('no member named x');
    expect(diagnostics[1]?.severity).toBe('warning');
  });

  it('keeps a linker failure, which has no source position', () => {
    const diagnostics = parseClangDiagnostics(
      'wasm-ld: error: undefined symbol: __lttf2',
      'main.cpp',
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.message).toContain('__lttf2');
  });

  it('labels a system header instead of blaming the user file', () => {
    const diagnostics = parseClangDiagnostics(
      '/include/c++/v1/vector:123:4: error: something in the header',
      'main.cpp',
    );

    expect(diagnostics[0]?.source).toBe('<vector>');
  });
});

describe('clang runtime: toolchain missing', () => {
  it('reports it instead of throwing', async () => {
    const runtime = createClangRuntime({
      files: {
        readBytes: async () => {
          throw new Error('no such file');
        },
        readText: async () => {
          throw new Error('no such file');
        },
      },
    });

    const outcome = await runtime.build({ fileName: 'main.c', code: 'int main(void) { return 0; }' });

    expect(outcome.stage).toBe('load');
    expect(outcome.failure).toContain('toolchain not available');
  });
});

describe.skipIf(!toolchainPresent)('clang runtime: real toolchain', () => {
  it(
    'compiles and runs a C program',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({ fileName: 'main.c', code: C_PROGRAM });

      expect(outcome.stage).toBe('ok');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('c: total=30');
      expect(outcome.wasmBytes).toBeGreaterThan(10_000);
    },
    180_000,
  );

  it(
    'compiles and runs C++ with the STL and a function template',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({ fileName: 'main.cpp', code: CPP_PROGRAM });

      expect(outcome.stage).toBe('ok');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('sorted: 1 3 5 9');
      expect(outcome.output).toContain('sum = 18');
    },
    180_000,
  );

  it(
    'reports real compiler errors for broken C++',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'broken.cpp',
        code: 'int main() { return not_declared_anywhere(); }',
      });

      expect(outcome.stage).not.toBe('ok');
      const diagnostics = parseClangDiagnostics(outcome.output, 'broken.cpp');
      expect(
        diagnostics.some(
          (item) => item.severity === 'error' && item.message.includes('not_declared_anywhere'),
        ),
      ).toBe(true);
    },
    180_000,
  );

  it(
    'feeds stdin to the program',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'input.c',
        code: [
          '#include <stdio.h>',
          'int main(void) {',
          '    int value = 0;',
          '    scanf("%d", &value);',
          '    printf("doubled %d\\n", value * 2);',
          '    return 0;',
          '}',
        ].join('\n'),
        stdin: '21\n',
      });

      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('doubled 42');
    },
    180_000,
  );
});

/**
 * Multi-file projects. The workspace lets people create several files, so Run has
 * to compile them the way a desktop compiler would: quoted includes resolve to the
 * files that exist, and every translation unit is compiled and linked together.
 */
describe.skipIf(!toolchainPresent)('clang runtime: several workspace files', () => {
  const HEADER = [
    '#ifndef UTIL_H',
    '#define UTIL_H',
    'int helper(int value);',
    '#endif',
  ].join('\n');

  const UTIL = [
    '#include "util.h"',
    'int helper(int value) { return value * 3; }',
  ].join('\n');

  const MAIN = [
    '#include <iostream>',
    '#include "util.h"',
    'int main() {',
    '    std::cout << "helper(14) = " << helper(14) << \'\\n\';',
    '    return 0;',
    '}',
  ].join('\n');

  it(
    'resolves a quoted include and links two translation units',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'main.cpp',
        code: MAIN,
        files: [
          { path: 'util.h', code: HEADER },
          { path: 'util.cpp', code: UTIL },
        ],
      });

      expect(outcome.stage).toBe('ok');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('helper(14) = 42');
    },
    180_000,
  );

  it(
    'handles files in a subdirectory',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'src/main.cpp',
        code: MAIN,
        files: [
          { path: 'src/util.h', code: HEADER },
          { path: 'src/util.cpp', code: UTIL },
        ],
      });

      expect(outcome.stage).toBe('ok');
      expect(outcome.output).toContain('helper(14) = 42');
    },
    180_000,
  );

  it(
    'compiles a C project split across files',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'main.c',
        code: [
          '#include <stdio.h>',
          '#include "maths.h"',
          'int main(void) {',
          '    printf("triple(7) = %d\\n", triple(7));',
          '    return 0;',
          '}',
        ].join('\n'),
        files: [
          { path: 'maths.h', code: 'int triple(int value);\n' },
          {
            path: 'maths.c',
            code: '#include "maths.h"\nint triple(int value) { return value * 3; }\n',
          },
        ],
      });

      expect(outcome.stage).toBe('ok');
      expect(outcome.output).toContain('triple(7) = 21');
    },
    180_000,
  );

  it(
    'is not fooled by a header that does not exist',
    async () => {
      const runtime = createClangRuntime({ files: localFiles });
      const outcome = await runtime.build({
        fileName: 'main.cpp',
        code: '#include "nowhere.h"\nint main() { return 0; }\n',
        files: [{ path: 'util.h', code: HEADER }],
      });

      expect(outcome.stage).not.toBe('ok');
      const diagnostics = parseClangDiagnostics(outcome.output, 'main.cpp');
      expect(
        diagnostics.some((item) => item.severity === 'error' && item.message.includes('nowhere.h')),
      ).toBe(true);
    },
    180_000,
  );
});
