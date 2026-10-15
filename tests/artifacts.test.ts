import { describe, expect, it } from 'vitest';
import { artifactName, artifactPath, isTranslationUnit } from '@/lang/clang/runtime';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';
import { formatBytes } from '@/util/download';

describe('artifact names', () => {
  it('drops the source extension in favour of the artifact one', () => {
    expect(artifactName('main.cpp', 'wasm')).toBe('main.wasm');
    expect(artifactName('main.cpp', 'object')).toBe('main.o');
    expect(artifactName('main.c', 'wasm')).toBe('main.wasm');
  });

  it('keeps only the file name, not the workspace path', () => {
    expect(artifactName('src/deep/util.cpp', 'wasm')).toBe('util.wasm');
    expect(artifactName('src/util.c', 'object')).toBe('util.o');
  });

  it('copes with a name that has no extension', () => {
    expect(artifactName('Makefile', 'wasm')).toBe('Makefile.wasm');
  });

  it('maps to the path the compiler actually wrote', () => {
    expect(artifactPath('main.cpp', 'wasm')).toBe('main.cpp.wasm');
    expect(artifactPath('src/util.c', 'object')).toBe('src/util.c.o');
  });

  it('knows which files are compiled on their own', () => {
    expect(isTranslationUnit('main.c')).toBe(true);
    expect(isTranslationUnit('src/util.cpp')).toBe(true);
    expect(isTranslationUnit('a.CC')).toBe(true);
    expect(isTranslationUnit('util.h')).toBe(false);
    expect(isTranslationUnit('README.md')).toBe(false);
  });
});

describe('formatBytes', () => {
  it('reads the way a person would say it', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(611 * 1024)).toBe('611 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('downloading artifacts', () => {
  it('says so instead of pretending when the engine has nothing to give', async () => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('fast');
    useAppStore.setState({ output: [] });

    await useAppStore.getState().downloadArtifact('wasm');

    const text = useAppStore.getState().output.map((entry) => entry.text).join('\n');
    expect(text).toContain('không tạo ra file để tải');
  });

  it('is offered only after a compiler run that produced a binary', async () => {
    useAppStore.setState({ artifactsReady: false });
    // The fast engine runs in-process, so this exercises the flag rather than clang.
    useAppStore.getState().setEngineId('fast');
    useAppStore.getState().setCodeFromEditor('int main(void) { return 0; }\n');
    await useAppStore.getState().run();

    expect(useAppStore.getState().artifactsReady).toBe(false);
  });
});
