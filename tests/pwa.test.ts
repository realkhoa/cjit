import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The installable-app surface, checked against the real files.
 *
 * A manifest that promises icons which do not exist, or declares a size the PNG is
 * not, is how an app silently fails to install - and nothing in the UI would say so.
 * These tests read the files that ship.
 */

const root = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

/** Width and height from a PNG's IHDR chunk: the first bytes after the signature. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(join(root, path));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) throw new Error(`${path} is not a PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly { readonly src: string; readonly sizes: string; readonly purpose?: string }[];
}

describe('the web manifest', () => {
  const manifest = readJson<Manifest>('public/manifest.webmanifest');

  it('says what the app is, and opens as an app', () => {
    expect(manifest.name).toBe('C/C++ Studio');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.display).toBe('standalone');
    // A relative start_url and scope are what make one build work under
    // https://<user>.github.io/<repo>/ as well as at a domain root.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });

  it('wears the editor\u2019s dark colours', () => {
    expect(manifest.theme_color).toBe('#1e1e1e');
    expect(manifest.background_color).toBe('#1e1e1e');
  });

  it('declares icons that exist and are the size it claims', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of manifest.icons) {
      const path = join('public', icon.src.replace('./', ''));
      expect(existsSync(join(root, path)), `${icon.src} is missing`).toBe(true);

      const [width, height] = icon.sizes.split('x').map((value) => Number.parseInt(value, 10));
      expect(pngSize(path)).toEqual({ width, height });
    }
  });

  it('ships the sizes a launcher asks for, including a maskable one', () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });
});

describe('the page that hosts it', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');

  it('links the manifest and sets the theme colour', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('manifest.webmanifest');
    expect(html).toContain('name="theme-color" content="#1e1e1e"');
  });

  it('gives iOS the tags it needs instead of the manifest', () => {
    expect(html).toContain('apple-touch-icon');
    expect(html).toContain('apple-mobile-web-app-capable');
  });
});
