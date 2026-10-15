import { describe, expect, it } from 'vitest';
import type { StoredFile, TrashedFile } from '@/state/fileStore';
import { uniquePath } from '@/state/fileStore';
import {
  BACKUP_VERSION,
  backupFileName,
  mergeBackup,
  parseWorkspaceJson,
  workspaceToJson,
} from '@/state/workspaceBackup';

/**
 * Backing up and restoring.
 *
 * The trash covers mistakes inside the app; this covers the browser dropping its
 * storage, which nothing inside the app can prevent. The rules that matter: a
 * backup round trips, a damaged one is refused with a reason, and importing never
 * replaces what is already here.
 */

function file(id: string, path: string, code: string): StoredFile {
  return { id, path, language: path.endsWith('.c') ? 'c' : 'cpp', code, updatedAt: 0 };
}

function trashed(id: string, path: string, code: string): TrashedFile {
  return { ...file(id, path, code), deletedAt: 0 };
}

describe('writing a backup', () => {
  it('round trips every file', () => {
    const files = [file('1', 'main.cpp', 'int main() { return 0; }\n'), file('2', 'util.h', 'int f();\n')];

    const parsed = parseWorkspaceJson(workspaceToJson(files));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.backup.files.map((entry) => entry.path)).toEqual(['main.cpp', 'util.h']);
    expect(parsed.backup.files[0]?.code).toBe('int main() { return 0; }\n');
    expect(parsed.backup.skipped).toBe(0);
  });

  it('includes trashed files, since they are still the user\u2019s work', () => {
    const parsed = parseWorkspaceJson(workspaceToJson([], [trashed('t1', 'old.c', 'int old(void);\n')]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.trash.map((entry) => entry.path)).toEqual(['old.c']);
  });

  it('names the file by date so several backups can sit together', () => {
    const name = backupFileName(Date.UTC(2026, 1, 14, 12));
    expect(name).toMatch(/^cjit-workspace-\d{4}-\d{2}-\d{2}\.json$/);
    expect(name.endsWith('.json')).toBe(true);
  });
});

describe('reading a backup', () => {
  it('refuses anything that is not one, with a reason', () => {
    expect(parseWorkspaceJson('')).toMatchObject({ ok: false, error: 'file rỗng' });
    expect(parseWorkspaceJson('not json')).toMatchObject({ ok: false, error: 'không phải JSON hợp lệ' });
    expect(parseWorkspaceJson('[]')).toMatchObject({ ok: false });
    expect(parseWorkspaceJson(JSON.stringify({ version: 99, files: [] }))).toMatchObject({
      ok: false,
    });
    expect(parseWorkspaceJson(JSON.stringify({ version: BACKUP_VERSION, files: [] }))).toMatchObject({
      ok: false,
      error: 'backup không có file nào dùng được',
    });
  });

  it('drops entries whose names could not be used, and says how many', () => {
    const text = JSON.stringify({
      version: BACKUP_VERSION,
      files: [
        { path: 'good.c', code: 'int a;' },
        { path: '../escape.c', code: 'int b;' },
        { path: 'notes.txt', code: 'nope' },
      ],
    });

    const parsed = parseWorkspaceJson(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.files.map((entry) => entry.path)).toEqual(['good.c']);
    expect(parsed.backup.skipped).toBe(2);
  });

  it('survives a file that is huge rather than trying to load it', () => {
    const huge = JSON.stringify({
      version: BACKUP_VERSION,
      files: [{ path: 'big.c', code: 'x'.repeat(5 * 1024 * 1024) }],
    });
    // Either refused outright or trimmed, but never silently accepted whole.
    const parsed = parseWorkspaceJson(huge);
    expect(parsed.ok).toBe(false);
  });
});

describe('importing', () => {
  it('adds the files under free names instead of overwriting', () => {
    const existing = [file('1', 'main.cpp', 'MINE')];
    const parsed = parseWorkspaceJson(workspaceToJson([file('2', 'main.cpp', 'BACKUP')]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const merged = mergeBackup(
      parsed.backup,
      (index) => `imported-${index}`,
      (path) => uniquePath(existing, path),
      42,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.path).toBe('main2.cpp');
    expect(merged[0]?.code).toBe('BACKUP');
    // The file already here is untouched, which is the whole point.
    expect(existing[0]?.code).toBe('MINE');
  });

  it('derives the language from the restored name', () => {
    const parsed = parseWorkspaceJson(
      workspaceToJson([file('1', 'tool.C', 'int main(){}'), file('2', 'thing.h', 'int x;')]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const merged = mergeBackup(parsed.backup, (index) => `i${index}`, (path) => path, 0);
    expect(merged.map((entry) => entry.language)).toEqual(['cpp', 'c']);
  });
});
