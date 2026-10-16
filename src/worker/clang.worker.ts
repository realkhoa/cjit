import { parseClangDiagnostics, stripAnsi } from '@/lang/clang/diagnostics';
import { artifactName, createClangRuntime } from '@/lang/clang/runtime';
import type { ArtifactKind } from '@/lang/clang/runtime';
import {
  TOOLCHAIN_CACHE_VERSION,
  createCachedFiles,
  openToolchainStorage,
} from '@/lang/clang/toolchainCache';
import type {
  ClangArtifactRequest,
  ClangRequest,
  ClangResponse,
  ClangRunRequest,
} from '@/worker/clangProtocol';

/**
 * clang + lld + libc++ worker.
 *
 * It performs the whole "Run" path - compile, link, execute - and streams both
 * the build output and the program's output back to the main thread. The runtime
 * itself is shared with the Node tests, so what runs here is the code that is
 * already verified; this file is only the message plumbing.
 *
 * Output is de-coloured here: clang's diagnostics have already been captured for
 * the Problems tab, and escape sequences have no place in a console written by
 * hand.
 */

interface RuntimeLike {
  build(request: {
    fileName: string;
    code: string;
    stdin?: string;
    files?: readonly { readonly path: string; readonly code: string }[];
  }): Promise<{
    exitCode: number | null;
    stage: 'ok' | 'load' | 'compile' | 'link' | 'run';
    output: string;
    wasmBytes: number;
    failure?: string;
    notes?: readonly string[];
  }>;
  readArtifact(sourcePath: string, kind: ArtifactKind): Uint8Array | null;
}

function post(response: ClangResponse): void {
  (self as unknown as { postMessage(message: ClangResponse): void }).postMessage(response);
}

function networkBytes(base: string, name: string): Promise<Uint8Array> {
  const url = new URL(name, base).href;
  return (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot fetch ${name} (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  })();
}

/** Files read from the machine's IndexedDB cache, and files downloaded now. */
let fromCache = 0;
let fromNetwork = 0;
let reportedToolchain = false;

/**
 * The toolchain, read through the IndexedDB cache: 58 MB downloaded once, then
 * served from this machine on every later page load (see toolchainCache.ts).
 */
async function toolchainFiles(base: string) {
  const storage = await openToolchainStorage();
  return createCachedFiles({
    storage,
    version: TOOLCHAIN_CACHE_VERSION,
    onNote: () => {
      fromCache += 1;
    },
    fetchBytes: async (name) => {
      fromNetwork += 1;
      return networkBytes(base, name);
    },
  });
}

let cachedRuntime: RuntimeLike | null = null;
let cachedBase = '';
/**
 * The run whose output is being streamed.
 *
 * The runtime is created once and reused, so the output forwarder must not capture
 * a request id from whichever run happened to create it: that made every run after
 * the first post its output under the first run's id, which the engine then
 * discarded as belonging to another request. The symptom was a second Run that
 * showed the summary but none of the program's output.
 */
let activeRequestId = 0;

async function handleRun(request: ClangRunRequest): Promise<void> {
  const { requestId } = request;
  activeRequestId = requestId;

  try {
    if (!cachedRuntime || cachedBase !== request.toolchainBase) {
      post({
        kind: 'status',
        requestId,
        message: 'Loading...',
      });

      cachedRuntime = createClangRuntime({
        // Resolved here because it has to be awaited before the runtime reads files.
        files: await toolchainFiles(request.toolchainBase),
        onOutput: (text, phase) => {
          const clean = stripAnsi(text);
          if (clean.length > 0) {
            post({ kind: 'output', requestId: activeRequestId, phase, chunk: clean });
          }
        },
      }) as unknown as RuntimeLike;
      cachedBase = request.toolchainBase;
    }

    const outcome = await cachedRuntime.build({
      fileName: request.fileName,
      code: request.code,
      stdin: request.stdin,
      ...(request.files ? { files: request.files } : {}),
    });

    const diagnostics = parseClangDiagnostics(outcome.output, request.fileName);

    /*
     * Notes about the build itself - which file became the entry point, what was
     * skipped because a project runs one main - go down the build channel, where the
     * console already shows what the toolchain had to say. Prefixed, so it is clear
     * this is the tool talking and not the program.
     */
    for (const note of outcome.notes ?? []) {
      post({ kind: 'output', requestId, phase: 'build', chunk: `cjit: ${note}\n` });
    }

    // Tell the user once per worker whether the toolchain came off the machine or
    // off the network - this is the difference between a reload costing nothing and
    // costing 58 MB.
    if (!reportedToolchain) {
      reportedToolchain = true;
    }

    // `load` means the toolchain itself is missing, which is not the user's code
    // failing: it is reported as `unsupported` so the caller can fall back to the
    // fast engine and say why.
    const status =
      outcome.stage === 'ok'
        ? 'ok'
        : outcome.stage === 'load'
          ? 'unsupported'
          : outcome.stage === 'run'
            ? 'runtime-error'
            : 'compile-error';

    post({
      kind: 'done',
      requestId,
      outcome: {
        status,
        detail: outcome.failure ?? '',
        exitCode: outcome.exitCode,
        elapsedMs: 0,
        steps: 0,
        diagnostics,
      },
    });
  } catch (error) {
    post({
      kind: 'failure',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Reads a build artifact back out of the compiler's filesystem. */
function handleArtifact(request: ClangArtifactRequest): void {
  const { requestId } = request;

  if (!cachedRuntime) {
    post({
      kind: 'failure',
      requestId,
      message: 'chưa có gì được build — bấm Run trước rồi tải',
    });
    return;
  }

  try {
    const bytes = cachedRuntime.readArtifact(request.fileName, request.which);
    if (!bytes) {
      post({
        kind: 'failure',
        requestId,
        message:
          request.which === 'object'
            ? `không có object file cho ${request.fileName} (chỉ file .c/.cpp được compile)`
            : `không có .wasm cho ${request.fileName}`,
      });
      return;
    }

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    post({ kind: 'artifact', requestId, name: artifactName(request.fileName, request.which), bytes: buffer });
  } catch (error) {
    post({
      kind: 'failure',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.addEventListener('message', (event: MessageEvent<ClangRequest>) => {
  const request = event.data;
  if (request.kind === 'run') void handleRun(request);
  else if (request.kind === 'artifact') handleArtifact(request);
});
