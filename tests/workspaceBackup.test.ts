import { describe, expect, it } from 'vitest';
import type { StoredFile } from '@/state/fileStore';
import { languageForPath, uniquePath } from '@/state/fileStore';
import type { Project } from '@/state/projectStore';
import {
  BACKUP_VERSION,
  backupFileName,
  mergeBackupFiles,
  parseWorkspaceJson,
  workspaceToJson,
} from '@/state/workspaceBackup';

/**
 * Backing up and restoring.
 *
 * The trash covers mistakes inside the app; this covers the browser dropping its
 * storage, which nothing inside the app can prevent. The rules that matter: a backup
 * round trips, a damaged one is refused with a reason, an *older* one is still read,
 * and importing never replaces what is already here.
 */

function file(id: string, path: string, code: string): StoredFile {
  return { id, path, language: languageForPath(path), code, updatedAt: 0 };
}

function project(id: string, name: string, files: StoredFile[]): Project {
  return { id, name, files, activeId: files[0]?.id ?? '' };
}

const PROJECTS = [
  project('p1', 'main', [file('1', 'main.cpp', 'int main() { return 0; }\n')]),
  project('p2', 'lab 2', [file('2', 'util.h', 'int f();\n'), file('3', 'a.c', 'int a;\n')]),
];

describe('writing a backup', () => {
  it('round trips every project and file', () => {
    const parsed = parseWorkspaceJson(workspaceToJson(PROJECTS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.backup.projects.map((entry) => entry.name)).toEqual(['main', 'lab 2']);
    expect(parsed.backup.projects[1]?.files.map((entry) => entry.path)).toEqual(['util.h', 'a.c']);
    expect(parsed.backup.projects[0]?.files[0]?.code).toBe('int main() { return 0; }\n');
    expect(parsed.backup.skipped).toBe(0);
  });

  it('includes the trash, since trashed work is still the user\u2019s', () => {
    const parsed = parseWorkspaceJson(
      workspaceToJson([], [{ ...file('t1', 'old.c', 'int old(void);\n'), deletedAt: 0 }], [
        { ...project('pt', 'deleted', [file('x', 'gone.cpp', 'gone')]), deletedAt: 0 },
      ]),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.trash.map((entry) => entry.path)).toEqual(['old.c']);
  });

  it('names the file by date so several backups can sit together', () => {
    const name = backupFileName(Date.UTC(2026, 1, 14, 12));
    expect(name).toMatch(/^cjit-workspace-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('reading a backup', () => {
  it('refuses anything that is not one, with a reason', () => {
    expect(parseWorkspaceJson('')).toMatchObject({ ok: false, error: 'file rỗng' });
    expect(parseWorkspaceJson('not json')).toMatchObject({ ok: false, error: 'không phải JSON hợp lệ' });
    expect(parseWorkspaceJson('[]')).toMatchObject({ ok: false });
    expect(parseWorkspaceJson(JSON.stringify({ version: 99, projects: [] }))).toMatchObject({
      ok: false,
    });
    expect(parseWorkspaceJson(JSON.stringify({ version: BACKUP_VERSION, projects: [] }))).toMatchObject({
      ok: false,
      error: 'backup không có project nào dùng được',
    });
  });

  it('still reads the old flat format, as one project', () => {
    // Backups written before projects existed must not become unreadable.
    const old = JSON.stringify({
      version: 1,
      exportedAt: 0,
      files: [{ path: 'main.cpp', code: 'int main(){}' }],
      trash: [{ path: 'old.c', code: 'int old;' }],
    });

    const parsed = parseWorkspaceJson(old);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.projects).toHaveLength(1);
    expect(parsed.backup.projects[0]?.name).toBe('imported');
    expect(parsed.backup.projects[0]?.files[0]?.path).toBe('main.cpp');
    expect(parsed.backup.trash.map((entry) => entry.path)).toEqual(['old.c']);
  });

  it('reads a format without a version at all, the same way', () => {
    const parsed = parseWorkspaceJson(JSON.stringify({ files: [{ path: 'a.c', code: 'int a;' }] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.projects[0]?.files[0]?.path).toBe('a.c');
  });

  it('drops entries whose names could not be used, and says how many', () => {
    const text = JSON.stringify({
      version: BACKUP_VERSION,
      projects: [
        {
          name: 'ok',
          files: [
            { path: 'good.c', code: 'int a;' },
            { path: '../escape.c', code: 'int b;' },
            { path: 'notes.txt', code: 'nope' },
          ],
        },
      ],
    });

    const parsed = parseWorkspaceJson(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.projects[0]?.files.map((entry) => entry.path)).toEqual(['good.c']);
    expect(parsed.backup.skipped).toBe(2);
  });

  it('replaces an unusable project name rather than refusing the project', () => {
    const parsed = parseWorkspaceJson(
      JSON.stringify({
        version: BACKUP_VERSION,
        projects: [{ name: 'a/b', files: [{ path: 'x.cpp', code: 'int x;' }] }],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.projects[0]?.name).toBe('imported');
  });

  it('survives a file that is huge rather than trying to load it', () => {
    const huge = JSON.stringify({
      version: BACKUP_VERSION,
      projects: [{ name: 'big', files: [{ path: 'big.c', code: 'x'.repeat(9 * 1024 * 1024) }] }],
    });
    expect(parseWorkspaceJson(huge).ok).toBe(false);
  });
});

describe('importing', () => {
  it('adds files under free names instead of overwriting', () => {
    const existing = [file('1', 'main.cpp', 'MINE')];
    const parsed = parseWorkspaceJson(
      workspaceToJson([project('p', 'other', [file('2', 'main.cpp', 'BACKUP')])]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const incoming = parsed.backup.projects[0];
    expect(incoming).toBeDefined();
    const files = mergeBackupFiles(
      incoming!,
      (index) => `imported-${index}`,
      (path) => uniquePath(existing, path),
      languageForPath,
      42,
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('main2.cpp');
    expect(files[0]?.code).toBe('BACKUP');
    // The file already here is untouched, which is the whole point.
    expect(existing[0]?.code).toBe('MINE');
  });

  it('derives the language from the restored name', () => {
    const parsed = parseWorkspaceJson(
      workspaceToJson([
        project('p', 'p', [file('1', 'tool.C', 'int main(){}'), file('2', 'thing.h', 'int x;')]),
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const files = mergeBackupFiles(
      parsed.backup.projects[0]!,
      (index) => `i${index}`,
      (path) => path,
      languageForPath,
      0,
    );
    expect(files.map((entry) => entry.language)).toEqual(['cpp', 'c']);
  });
});
