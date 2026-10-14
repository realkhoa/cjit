/**
 * End-to-end smoke test for the WebAssembly C/C++ toolchain.
 *
 * It loads the vendored `shared.js` (the same runtime the browser worker uses)
 * and drives clang -> lld -> execute in Node, so the whole path is verified
 * without a browser: this is what proves "Run compiles real C/C++" before any UI
 * is wired to it.
 *
 *   node scripts/clang-smoke.mjs
 *
 * Requires `node scripts/fetch-toolchain.mjs` to have run first.
 */

import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const TOOLCHAIN = path.resolve(fileURLToPath(new URL('../public/toolchain', import.meta.url)));

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

const CPP14_PROGRAM = `#include <iostream>
#include <vector>
#include <string>
#include <utility>

int main() {
    std::vector<std::pair<std::string, int>> rows;
    rows.emplace_back("alpha", 1);
    rows.emplace_back("beta", 2);

    int total = 0;
    auto add = [&total](int value) { total += value; };
    for (const auto& row : rows) {
        add(row.second);
    }

    std::cout << "c++14: " << total << " rows=" << rows.size() << '\\n';
    return 0;
}
`;

async function readBytes(name) {
  const file = path.join(TOOLCHAIN, name);
  await stat(file);
  return new Uint8Array(await readFile(file));
}

let cachedApi = null;

function loadApi() {
  if (cachedApi) return cachedApi;
  const source = readFileSync(path.join(TOOLCHAIN, 'shared.js'), 'utf8');
  // shared.js defines `const API = (() => { ... })()`, so the script's own
  // completion value is undefined; evaluating `API` as a trailing expression
  // hands the class back. It can only be evaluated once per context, because the
  // script declares a lexical binding.
  cachedApi = vm.runInThisContext(`${source}\n;API`, { filename: 'shared.js' });
  return cachedApi;
}

function createApi(onOutput) {
  const api = new (loadApi())({
    readBuffer: (name) => readBytes(name).then((bytes) => bytes.buffer),
    compileStreaming: (name) => readBytes(name).then((bytes) => WebAssembly.compile(bytes)),
    hostWrite: (text) => onOutput(text),
  });
  // The demo runtime narrates its own progress; the app does not need that.
  api.hostLog = () => undefined;
  api.hostLogAsync = (_message, promise) => promise;
  return api;
}

async function compileAndRun(api, { name, language, code, stdin = '' }) {
  const object = `${name}.o`;
  const wasm = `${name}.wasm`;

  // The vendored runtime narrates rAF decisions on the console; that goes to the
  // browser's worker console, and is only noise here.
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    api.memfs.addFile(name, code);

    const clang = await api.getModule('clang');
    await api.run(
      clang,
      'clang',
      '-cc1',
      '-emit-obj',
      ...api.clangCommonArgs,
      '-O2',
      '-o',
      object,
      '-x',
      language,
      name,
    );

    const lld = await api.getModule('lld');
    const stackSize = 1024 * 1024;
    await api.run(
      lld,
      'wasm-ld',
      '--no-threads',
      '-z',
      `stack-size=${stackSize}`,
      '-Llib/wasm32-wasi',
      'lib/wasm32-wasi/crt1.o',
      object,
      // libc++ and libc++abi are built expecting compiler-rt builtins (for
      // example __lttf2). The clang driver adds this archive on its own; a direct
      // wasm-ld invocation has to name it, or any libc++ object that needs a
      // builtin fails to link.
      'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a',
      '-lc',
      '-lc++',
      '-lc++abi',
      '-o',
      wasm,
    );

    const binary = api.memfs.getFileContents(wasm);
    if (!binary || binary.byteLength === 0) {
      return { exitCode: null, wasmBytes: 0, stage: 'link', message: 'linker produced no output' };
    }

    if (stdin.length > 0) {
      api.memfs.stdinStr = stdin;
      api.memfs.stdinStrPos = 0;
    }

    const module = await WebAssembly.compile(binary);
    const stillRunning = await api.run(module, wasm);
    return { exitCode: stillRunning ? null : 0, wasmBytes: binary.byteLength, stage: 'run' };
  } catch (error) {
    // A ProcExit from clang/lld/program carries the status code; anything else is
    // a real failure and its message is what the toolchain printed.
    return {
      exitCode: typeof error?.code === 'number' ? error.code : null,
      wasmBytes: 0,
      stage: error?.code === undefined ? 'crash' : 'tool',
      message: error?.message ?? String(error),
    };
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  let failures = 0;
  const cases = [
    { name: 'main.c', language: 'c', code: C_PROGRAM, expect: ['c: total=30'] },
    {
      name: 'main.cpp',
      language: 'c++',
      code: CPP_PROGRAM,
      expect: ['sorted: 1 3 5 9', 'sum = 18'],
    },
    {
      name: 'modern.cpp',
      language: 'c++',
      code: CPP14_PROGRAM,
      expect: ['c++14: 3 rows=2'],
    },
  ];

  for (const testCase of cases) {
    let output = '';
    const api = createApi((text) => {
      output += text;
    });

    await api.ready;
    const result = await compileAndRun(api, testCase);

    const ok = testCase.expect.every((needle) => output.includes(needle));
    const status = ok && result.exitCode === 0 ? 'PASS' : 'FAIL';
    if (status === 'FAIL') failures += 1;

    process.stdout.write(
      `[${status}] ${testCase.name}: exit=${result.exitCode} stage=${result.stage} wasm=${(result.wasmBytes / 1024).toFixed(0)}KB\n`,
    );
    process.stdout.write(
      output
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => `        | ${line}`)
        .join('\n') + '\n',
    );
    if (result.message) process.stdout.write(`        tool: ${result.message}\n`);
    if (!ok) {
      process.stdout.write(`        expected: ${testCase.expect.join(' | ')}\n`);
    }
  }

  process.stdout.write(failures === 0 ? '\nToolchain smoke: all cases passed\n' : `\nToolchain smoke: ${failures} case(s) failed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`smoke run failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
