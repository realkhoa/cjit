import { describe, expect, it } from 'vitest';
import type { FilesWorkspace } from '@/state/fileStore';
import {
  decodeShare,
  encodeShare,
  readShareFromHash,
  shareUrlFor,
  toSharePayload,
  workspaceFromShare,
} from '@/state/share';

function workspace(): FilesWorkspace {
  return {
    files: [
      { id: '1', path: 'main.cpp', language: 'cpp', code: 'int main() { return 0; }\n', updatedAt: 0 },
      { id: '2', path: 'util.c', language: 'c', code: 'int helper(void) { return 1; }\n', updatedAt: 0 },
    ],
    activeId: '2',
  };
}

describe('share links: round trip', () => {
  it('carries every file and the active one through the URL', async () => {
    const encoded = await encodeShare(toSharePayload(workspace()));
    const decoded = await decodeShare(encoded);

    expect(decoded?.files.map((file) => file.path)).toEqual(['main.cpp', 'util.c']);
    expect(decoded?.files[1]?.code).toContain('helper');
    expect(decoded?.activePath).toBe('util.c');
  });

  it('compresses repetitive code instead of storing it verbatim', async () => {
    const code = 'int counter = 0;\n'.repeat(300);
    const encoded = await encodeShare({ version: 1, files: [{ path: 'big.c', code }] });

    expect(encoded.startsWith('1')).toBe(true);
    expect(encoded.length).toBeLessThan(code.length / 2);
    // ...and it still decodes to exactly the same code.
    expect((await decodeShare(encoded))?.files[0]?.code).toBe(code);
  });

  it('survives unicode in strings', async () => {
    const code = 'const char *s = "xin chào 👋";\n';
    const encoded = await encodeShare({ version: 1, files: [{ path: 'u.c', code }] });
    expect((await decodeShare(encoded))?.files[0]?.code).toBe(code);
  });
});

describe('share links: untrusted input', () => {
  it('rejects anything that did not come from the encoder', async () => {
    expect(await decodeShare('')).toBeNull();
    expect(await decodeShare('1@@@not-base64@@@')).toBeNull();
    expect(await decodeShare(`0${btoa('{"version":2,"files":[]}')}`)).toBeNull();
    expect(await decodeShare(`0${btoa('not json at all')}`)).toBeNull();
  });

  it('drops invalid names but keeps the valid files', async () => {
    const encoded = await encodeShare({
      version: 1,
      files: [
        { path: 'ok.c', code: 'int a;' },
        { path: 'nope.txt', code: 'int b;' },
      ],
    });

    const decoded = await decodeShare(encoded);
    expect(decoded?.files.map((file) => file.path)).toEqual(['ok.c']);
  });

  it('is useless when every name is invalid', async () => {
    const encoded = await encodeShare({
      version: 1,
      files: [{ path: '../../etc/passwd.c', code: 'x' }],
    });
    expect(await decodeShare(encoded)).toBeNull();
  });

  it('refuses a workspace larger than the cap', async () => {
    const encoded = await encodeShare({
      version: 1,
      files: [{ path: 'huge.c', code: 'x'.repeat(700_000) }],
    });
    expect(await decodeShare(encoded)).toBeNull();
  });

  it('refuses an absurd number of files', async () => {
    const files = Array.from({ length: 200 }, (_, index) => ({
      path: `f${index}.c`,
      code: 'int a;',
    }));
    expect(await decodeShare(await encodeShare({ version: 1, files }))).toBeNull();
  });
});

describe('workspaceFromShare', () => {
  it('rebuilds files with fresh ids and derives the language', () => {
    const payload = {
      version: 1 as const,
      files: [
        { path: 'a.c', code: '1' },
        { path: 'b.cpp', code: '2' },
      ],
      activePath: 'b.cpp',
    };

    const rebuilt = workspaceFromShare(payload, (index) => `id-${index}`, 42);
    expect(rebuilt.files.map((file) => file.id)).toEqual(['id-0', 'id-1']);
    expect(rebuilt.files.map((file) => file.language)).toEqual(['c', 'cpp']);
    expect(rebuilt.files.every((file) => file.updatedAt === 42)).toBe(true);
    expect(rebuilt.activeId).toBe('id-1');
  });

  it('falls back to the first file when the active one is unknown', () => {
    const payload = {
      version: 1 as const,
      files: [{ path: 'a.c', code: '1' }],
      activePath: 'missing.c',
    };

    expect(workspaceFromShare(payload, (index) => `id-${index}`, 0).activeId).toBe('id-0');
  });
});

describe('share URLs', () => {
  it('replaces any existing fragment', () => {
    expect(shareUrlFor('https://user.github.io/cjit/#old', 'ABC')).toBe(
      'https://user.github.io/cjit/#s=ABC',
    );
  });

  it('reads the payload back out of a fragment', () => {
    expect(readShareFromHash('#s=ABC')).toBe('ABC');
    expect(readShareFromHash('#s=ABC&other=1')).toBe('ABC');
    expect(readShareFromHash('')).toBeNull();
    expect(readShareFromHash('#unrelated')).toBeNull();
  });
});
