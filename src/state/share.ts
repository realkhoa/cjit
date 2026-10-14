import type { FilesWorkspace, StoredFile } from '@/state/fileStore';
import { languageForPath, validateFileName } from '@/state/fileStore';

/**
 * Share links: the whole workspace travelling in the URL fragment.
 *
 * The fragment never reaches a server (it is not sent in the HTTP request), so a
 * share link keeps working while the app itself stays client-only. The payload is
 * deflated when the browser supports `CompressionStream`, and stored as plain
 * base64url otherwise - the leading marker says which, so links stay readable by
 * whichever build opens them.
 *
 * Everything that arrives from a link is treated as untrusted input: names are
 * validated, and both the file count and the total size are capped.
 */

const SHARE_MARKER_COMPRESSED = '1';
const SHARE_MARKER_PLAIN = '0';
const MAX_ENCODED_LENGTH = 200_000;
const MAX_FILES = 50;
const MAX_TOTAL_CODE = 512 * 1024;

export interface SharePayload {
  readonly version: 1;
  readonly files: readonly { readonly path: string; readonly code: string }[];
  readonly activePath?: string;
}

export function toSharePayload(workspace: FilesWorkspace): SharePayload {
  const files = workspace.files.map((file) => ({ path: file.path, code: file.code }));
  const active = workspace.files.find((file) => file.id === workspace.activeId);
  return {
    version: 1,
    files,
    ...(active ? { activePath: active.path } : {}),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * `Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart` under the current
 * lib.dom typings (it could be backed by a SharedArrayBuffer). The value is
 * always a plain ArrayBuffer here, so the cast is safe.
 */
function asBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([asBlobPart(bytes)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([asBlobPart(bytes)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

export async function encodeShare(payload: SharePayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await deflate(bytes);
  if (compressed && compressed.length < bytes.length) {
    return `${SHARE_MARKER_COMPRESSED}${toBase64Url(compressed)}`;
  }
  return `${SHARE_MARKER_PLAIN}${toBase64Url(bytes)}`;
}

function validatePayload(value: unknown): SharePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { version?: unknown; files?: unknown; activePath?: unknown };
  if (candidate.version !== 1) return null;
  if (!Array.isArray(candidate.files)) return null;
  if (candidate.files.length === 0 || candidate.files.length > MAX_FILES) return null;

  const files: { path: string; code: string }[] = [];
  let total = 0;
  for (const entry of candidate.files) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as { path?: unknown; code?: unknown };
    if (typeof item.path !== 'string' || typeof item.code !== 'string') continue;
    if (validateFileName(item.path) !== undefined) continue;
    total += item.code.length;
    if (total > MAX_TOTAL_CODE) return null;
    files.push({ path: item.path, code: item.code });
  }

  if (files.length === 0) return null;
  return {
    version: 1,
    files,
    ...(typeof candidate.activePath === 'string' ? { activePath: candidate.activePath } : {}),
  };
}

export async function decodeShare(text: string): Promise<SharePayload | null> {
  if (text.length === 0 || text.length > MAX_ENCODED_LENGTH) return null;

  const marker = text.charAt(0);
  const body = text.slice(1);
  const bytes = fromBase64Url(body);
  if (!bytes) return null;

  const json =
    marker === SHARE_MARKER_COMPRESSED ? await inflate(bytes) : new TextDecoder().decode(bytes);
  if (json === null) return null;

  try {
    return validatePayload(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Rebuilds a workspace from a decoded payload, with fresh ids. */
export function workspaceFromShare(
  payload: SharePayload,
  makeId: (index: number) => string,
  now: number,
): FilesWorkspace {
  const files: StoredFile[] = payload.files.map((file, index) => ({
    id: makeId(index),
    path: file.path,
    language: languageForPath(file.path),
    code: file.code,
    updatedAt: now,
  }));

  const active =
    files.find((file) => file.path === payload.activePath) ?? files[0];

  return { files, activeId: active?.id ?? '' };
}

export function shareUrlFor(baseUrl: string, encoded: string): string {
  const withoutHash = baseUrl.split('#')[0] ?? baseUrl;
  return `${withoutHash}#s=${encoded}`;
}

/** Reads the share payload out of a location hash, if there is one. */
export function readShareFromHash(hash: string): string | null {
  const match = /(?:^#|&)s=([^&]+)/.exec(hash);
  return match?.[1] ?? null;
}
