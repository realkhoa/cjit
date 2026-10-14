/**
 * Downloads the WebAssembly C/C++ toolchain (clang + lld + sysroot) into
 * `public/toolchain/`.
 *
 * Why a script instead of committing it: the files are ~60 MB. Keeping them out
 * of git means clones stay small, while CI fetches them before building so the
 * deployed site serves the toolchain from its own origin (no third-party CDN at
 * runtime, which matters because Run must keep working if a CDN does not).
 *
 * Idempotent: a file that is already present at its expected size is skipped.
 *
 *   node scripts/fetch-toolchain.mjs
 *
 * Source: https://github.com/binji/wasm-clang (Apache-2.0 / LLVM license; the
 * license files are fetched alongside the binaries).
 */

import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE_URL = 'https://raw.githubusercontent.com/binji/wasm-clang/master';
const OUTPUT_DIR = path.resolve(fileURLToPath(new URL('../public/toolchain', import.meta.url)));

/** `min` guards against a truncated or error-page download being accepted. */
const FILES = [
  { name: 'clang', min: 30_000_000 },
  { name: 'lld', min: 19_000_000 },
  { name: 'sysroot.tar', min: 9_000_000 },
  { name: 'memfs', min: 300_000 },
  { name: 'shared.js', min: 20_000 },
  { name: 'LICENSE.llvm', min: 10_000 },
  { name: 'LICENSE', min: 10_000 },
];

async function sizeOf(file) {
  try {
    const info = await stat(file);
    return info.size;
  } catch {
    return 0;
  }
}

async function download(name) {
  const target = path.join(OUTPUT_DIR, name);
  const existing = await sizeOf(target);
  const expected = FILES.find((file) => file.name === name);
  if (expected && existing >= expected.min) {
    process.stdout.write(`  ${name}: already present (${existing.toLocaleString()} bytes)\n`);
    return existing;
  }

  const url = `${BASE_URL}/${name}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${name}: HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));

  const written = await sizeOf(target);
  if (expected && written < expected.min) {
    throw new Error(`${name} looks truncated: ${written} bytes (expected at least ${expected.min})`);
  }
  process.stdout.write(`  ${name}: ${written.toLocaleString()} bytes\n`);
  return written;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  process.stdout.write(`Fetching toolchain into ${OUTPUT_DIR}\n`);

  let total = 0;
  for (const file of FILES) {
    total += await download(file.name);
  }

  process.stdout.write(`Toolchain ready: ${(total / 1024 / 1024).toFixed(1)} MB\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
