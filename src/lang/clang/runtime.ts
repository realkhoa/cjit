/**
 * The clang -> lld -> execute pipeline, with no DOM and no bundler-specific API.
 *
 * It drives the vendored runtime (`shared.js` from binji/wasm-clang) and is given
 * its file access, so the exact same code runs in the browser worker and in Node
 * tests - which is why the compiler path can be verified in CI without a browser.
 *
 * Two details matter and are easy to get wrong:
 *  - the runtime declares `const API = ...`, so it must be evaluated in a fresh
 *    scope every time (a bare eval in a shared scope throws on redeclaration);
 *  - a direct `wasm-ld` invocation must name the compiler-rt builtins archive,
 *    or linking any libc++ object fails with `undefined symbol: __lttf2`.
 */

export interface ClangFilesystem {
  readBytes(name: string): Promise<Uint8Array>;
  readText(name: string): Promise<string>;
}

export interface ClangRuntimeOptions {
  readonly files: ClangFilesystem;
  /**
   * Receives everything the tools print, as it is produced. `phase` says whether
   * it came from building (clang/lld) or from the program itself, so the console
   * can show a compiler error differently from the program's stdout.
   */
  readonly onOutput?: (text: string, phase: BuildPhase) => void;
}

/** Building, or running what was built. */
export type BuildPhase = 'build' | 'run';

export interface BuildRequest {
  readonly fileName: string;
  readonly code: string;
  readonly stdin?: string;
}

export type BuildStage = 'ok' | 'load' | 'compile' | 'link' | 'run';

export interface BuildOutcome {
  /** Process exit status, or null when it could not be determined. */
  readonly exitCode: number | null;
  readonly stage: BuildStage;
  /** Everything clang/lld/the program printed. */
  readonly output: string;
  readonly wasmBytes: number;
  readonly failure?: string;
}

export interface ClangRuntime {
  readonly ready: Promise<void>;
  build(request: BuildRequest): Promise<BuildOutcome>;
}

interface MemFs {
  addFile(name: string, contents: string): void;
  getFileContents(name: string): Uint8Array | null;
  stdinStr?: string;
  stdinStrPos?: number;
}

interface ClangApiInstance {
  readonly ready: Promise<void>;
  readonly memfs: MemFs;
  readonly clangCommonArgs: string[];
  hostLog(message: string): void;
  hostLogAsync(message: string, promise: Promise<unknown>): Promise<unknown>;
  getModule(name: string): Promise<unknown>;
  run(module: unknown, ...args: string[]): Promise<boolean | null>;
}

type ClangApiConstructor = new (options: {
  readBuffer: (name: string) => Promise<ArrayBuffer>;
  compileStreaming: (name: string) => Promise<WebAssembly.Module>;
  hostWrite: (text: string) => void;
}) => ClangApiInstance;

/** Where the sysroot keeps compiler-rt builtins; `wasm-ld` needs them by name. */
const BUILTINS_ARCHIVE = 'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a';
const STACK_SIZE = 1024 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function createClangRuntime(options: ClangRuntimeOptions): ClangRuntime {
  let api: ClangApiInstance | null = null;
  let output = '';
  let phase: BuildPhase = 'build';

  const write = (text: string): void => {
    output += text;
    options.onOutput?.(text, phase);
  };

  const ready = (async () => {
    const source = await options.files.readText('shared.js');
    // Fresh scope per evaluation: the script declares a lexical `const API`.
    const factory = new Function(`${source}\nreturn API;`) as () => ClangApiConstructor;
    const Api = factory();

    const instance = new Api({
      readBuffer: async (name) => toArrayBuffer(await options.files.readBytes(name)),
      // `WebAssembly.compile` wants a BufferSource backed by a plain ArrayBuffer;
      // the bytes come from a Uint8Array whose buffer type is generic.
      compileStreaming: async (name) =>
        WebAssembly.compile(toArrayBuffer(await options.files.readBytes(name))),
      hostWrite: write,
    });

    // The sample runtime narrates its own progress; that is not the user's output.
    instance.hostLog = () => undefined;
    instance.hostLogAsync = (_message, promise) => promise;

    await instance.ready;
    api = instance;
  })();

  async function build(request: BuildRequest): Promise<BuildOutcome> {
    output = '';
    phase = 'build';

    try {
      await ready;
    } catch (error) {
      return {
        exitCode: null,
        stage: 'load',
        output,
        wasmBytes: 0,
        failure: `toolchain not available: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const instance = api;
    if (!instance) {
      return { exitCode: null, stage: 'load', output, wasmBytes: 0, failure: 'toolchain not loaded' };
    }

    const language = request.fileName.toLowerCase().endsWith('.c') ? 'c' : 'c++';
    const object = `${request.fileName}.o`;
    const wasm = `${request.fileName}.wasm`;

    // Colour codes would end up as escape sequences in the console; the parser
    // strips them anyway, but plain text is what belongs in front of a user.
    const commonArgs = instance.clangCommonArgs.filter(
      (argument) => argument !== '-fcolor-diagnostics',
    );

    const consoleLog = console.log;
    console.log = () => undefined;
    try {
      instance.memfs.addFile(request.fileName, request.code);

      const clang = await instance.getModule('clang');
      await instance.run(
        clang,
        'clang',
        '-cc1',
        '-emit-obj',
        ...commonArgs,
        '-fno-color-diagnostics',
        '-O2',
        '-o',
        object,
        '-x',
        language,
        request.fileName,
      );

      const lld = await instance.getModule('lld');
      await instance.run(
        lld,
        'wasm-ld',
        '--no-threads',
        '-z',
        `stack-size=${STACK_SIZE}`,
        '-Llib/wasm32-wasi',
        'lib/wasm32-wasi/crt1.o',
        object,
        BUILTINS_ARCHIVE,
        '-lc',
        '-lc++',
        '-lc++abi',
        '-o',
        wasm,
      );

      const binary = instance.memfs.getFileContents(wasm);
      if (!binary || binary.byteLength === 0) {
        return {
          exitCode: null,
          stage: 'link',
          output,
          wasmBytes: 0,
          failure: 'the linker produced no output',
        };
      }

      if (request.stdin && request.stdin.length > 0) {
        instance.memfs.stdinStr = request.stdin;
        instance.memfs.stdinStrPos = 0;
      }

      const module = await WebAssembly.compile(toArrayBuffer(binary));
      // Everything after this point is the program talking, not the toolchain.
      phase = 'run';
      const stillRunning = await instance.run(module, wasm);

      return {
        exitCode: stillRunning ? null : 0,
        stage: 'ok',
        output,
        wasmBytes: binary.byteLength,
      };
    } catch (error) {
      // clang/lld exit through a thrown ProcExit that carries the status code; a
      // real trap or a missing module does not.
      const code = (error as { code?: unknown })?.code;
      const exitCode = typeof code === 'number' ? code : null;
      return {
        exitCode,
        stage: exitCode === null ? 'run' : 'compile',
        output,
        wasmBytes: 0,
        failure: error instanceof Error ? error.message : String(error),
      };
    } finally {
      console.log = consoleLog;
    }
  }

  return { ready, build };
}
