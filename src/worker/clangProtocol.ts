import type { Diagnostic, RunOutcome, SourceFile } from '@/engine/types';

/**
 * Main-thread <-> clang worker protocol.
 *
 * The toolchain is ~58 MB of WebAssembly and compiles synchronously, so it runs
 * in its own worker: the editor stays responsive while clang works, and a
 * runaway program can be stopped by terminating that worker.
 */

export interface ClangRunRequest {
  readonly kind: 'run';
  readonly requestId: number;
  readonly code: string;
  readonly fileName: string;
  readonly stdin: string;
  /** Absolute URL of the directory holding clang/lld/sysroot. */
  readonly toolchainBase: string;
  /**
   * The rest of the workspace: written into the compiler's filesystem so quoted
   * includes resolve, and compiled + linked as further translation units.
   */
  readonly files?: readonly SourceFile[];
}

export type ClangRequest = ClangRunRequest;

export type ClangResponse =
  /** Progress the user should see, e.g. the first 58 MB download. */
  | { readonly kind: 'status'; readonly requestId: number; readonly message: string }
  | {
      readonly kind: 'output';
      readonly requestId: number;
      readonly phase: 'build' | 'run';
      readonly chunk: string;
    }
  | {
      readonly kind: 'done';
      readonly requestId: number;
      readonly outcome: RunOutcome & { readonly diagnostics: readonly Diagnostic[] };
    }
  | { readonly kind: 'failure'; readonly requestId: number; readonly message: string };
