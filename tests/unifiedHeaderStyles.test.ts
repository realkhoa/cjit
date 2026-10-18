import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * @file Tests verifying unified desktop header CSS token integration and invariant safety.
 */

describe('unified header styles', () => {
  it('contains css rules and height definition for the unified header', () => {
    const css = readFileSync('src/ui/theme/app.css', 'utf8');
    expect(css).toContain('--vs-unified-header-height: 38px;');
    expect(css).toContain('.unified-header');
    expect(css).toContain('.unified-header__exec');
    expect(css).toContain('.unified-header__menu');
  });

  it('preserves mobile touch and safe-area invariants', () => {
    const css = readFileSync('src/ui/theme/app.css', 'utf8');
    expect(css).toMatch(/@media \(hover: none\)[\s\S]{0,240}\.explorer__actions/);
    expect(css).toContain('env(safe-area-inset-bottom');
    expect(css).toContain('touch-action: manipulation');
    expect(css).toContain('overscroll-behavior: contain');
  });
});
