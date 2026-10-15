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
  /** The file the user is editing: its diagnostics are the ones shown in place. */
  readonly fileName: string;
  readonly code: string;
  readonly stdin?: string;
  /**
   * The rest of the workspace. They are written into the compiler's filesystem so
   * `#include "util.h"` resolves, and every translation unit among them is compiled
   * and linked together - which is what makes a project split across files behave
   * the way it does on a desktop.
   */
  readonly files?: readonly WorkspaceFile[];
}

export interface WorkspaceFile {
  readonly path: string;
  readonly code: string;
}

/** Extensions that are compiled into an object file (headers are not). */
const TRANSLATION_UNIT_EXTENSIONS = ['.c', '.cc', '.cpp', '.cxx', '.c++'];

export function isTranslationUnit(path: string): boolean {
  const lower = path.toLowerCase();
  return TRANSLATION_UNIT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** What a run can hand back to the user besides its output. */
export type ArtifactKind = 'wasm' | 'object';

/**
 * The name a downloaded artifact gets: the source stem plus the artifact's own
 * extension (`main.cpp` -> `main.wasm`), because `.cpp.o` is not what anyone
 * expects in their downloads folder. For a header the name is only ever produced
 * if the object exists - and it does not, since headers are not compiled on their
 * own, which the worker reports as a failure before naming anything.
 */
export function artifactName(sourcePath: string, kind: ArtifactKind): string {
  const slash = sourcePath.lastIndexOf('/');
  const base = slash >= 0 ? sourcePath.slice(slash + 1) : sourcePath;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return kind === 'wasm' ? `${stem}.wasm` : `${stem}.o`;
}

/** The internal memfs path of an artifact, which is what the compiler wrote. */
export function artifactPath(sourcePath: string, kind: ArtifactKind): string {
  return kind === 'wasm' ? `${sourcePath}.wasm` : `${sourcePath}.o`;
}

function languageOf(path: string): 'c' | 'c++' {
  return path.toLowerCase().endsWith('.c') ? 'c' : 'c++';
}

/**
 * Creates the parent directories of `filePath` in the compiler's filesystem.
 *
 * Without this, adding `src/util.h` makes clang trap with `unreachable`: the
 * filesystem has no directories unless they are created explicitly. Each directory
 * is created once per build.
 */
function ensureDirectories(memfs: MemFs, filePath: string, created: Set<string>): void {
  const parts = filePath.split('/').filter((part) => part.length > 0);
  parts.pop();

  let prefix = '';
  for (const part of parts) {
    prefix = prefix.length > 0 ? `${prefix}/${part}` : part;
    if (created.has(prefix)) continue;
    created.add(prefix);
    try {
      memfs.addDirectory(prefix);
    } catch {
      // Already present (or rejected): writing the file reports the real problem.
    }
  }
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
  /**
   * Reads back something the last build produced (`the linked .wasm`, or the
   * object file of one translation unit). Returns null when it does not exist -
   * for example the object of a header, or before anything has been built.
   */
  readArtifact(sourcePath: string, kind: ArtifactKind): Uint8Array | null;
}

interface MemFs {
  addFile(name: string, contents: string): void;
  /** `memfs` has no implicit directories: parents must be created first. */
  addDirectory(name: string): void;
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
  /**
   * Artifacts the last build actually produced.
   *
   * Asking the filesystem for a path that does not exist does not return nothing:
   * `memfs` traps with `unreachable`, which would look like a crash. Remembering
   * what was written is both cheaper and honest.
   */
  let produced = new Set<string>();

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

    const wasm = `${request.fileName}.wasm`;

    // Colour codes would end up as escape sequences in the console; the parser
    // strips them anyway, but plain text is what belongs in front of a user.
    const commonArgs = instance.clangCommonArgs.filter(
      (argument) => argument !== '-fcolor-diagnostics',
    );

    // The active file first, so its diagnostics are the first ones reported.
    const others = (request.files ?? []).filter((file) => file.path !== request.fileName);
    const sources: WorkspaceFile[] = [{ path: request.fileName, code: request.code }, ...others];
    const units = sources.filter((file) => isTranslationUnit(file.path));

    const consoleLog = console.log;
    console.log = () => undefined;
    // Tracked so a failure is reported against the step that actually failed: a
    // clang crash while compiling used to be reported as a runtime error.
    let stage: BuildStage = 'compile';
    produced = new Set<string>();
    try {
      // Every workspace file goes into the compiler's filesystem: that is what
      // makes `#include "util.h"` resolve to the file the user actually wrote.
      const created = new Set<string>();
      for (const file of sources) {
        ensureDirectories(instance.memfs, file.path, created);
        instance.memfs.addFile(file.path, file.code);
      }

      const clang = await instance.getModule('clang');
      const objects: string[] = [];
      for (const unit of units) {
        const object = `${unit.path}.o`;
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
          languageOf(unit.path),
          unit.path,
        );
        objects.push(object);
        produced.add(object);
      }

      stage = 'link';
      const lld = await instance.getModule('lld');
      await instance.run(
        lld,
        'wasm-ld',
        '--no-threads',
        '-z',
        `stack-size=${STACK_SIZE}`,
        '-Llib/wasm32-wasi',
        'lib/wasm32-wasi/crt1.o',
        ...objects,
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
      produced.add(wasm);

      if (request.stdin && request.stdin.length > 0) {
        instance.memfs.stdinStr = request.stdin;
        instance.memfs.stdinStrPos = 0;
      }

      const module = await WebAssembly.compile(toArrayBuffer(binary));
      // Everything after this point is the program talking, not the toolchain.
      phase = 'run';
      stage = 'run';
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
        stage,
        output,
        wasmBytes: 0,
        failure: error instanceof Error ? error.message : String(error),
      };
    } finally {
      console.log = consoleLog;
    }
  }

  function readArtifact(sourcePath: string, kind: ArtifactKind): Uint8Array | null {
    const path = artifactPath(sourcePath, kind);
    if (!produced.has(path)) return null;

    try {
      const contents = api?.memfs.getFileContents(path);
      if (!contents || contents.byteLength === 0) return null;
      // memfs hands back a view over the compiler's memory, which is reused by the
      // next build: copy before returning it.
      return new Uint8Array(contents);
    } catch {
      // Belt and braces: a filesystem that traps must not look like a crash.
      return null;
    }
  }

  return { ready, build, readArtifact };
}
