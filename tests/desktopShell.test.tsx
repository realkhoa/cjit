// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/ui/EditorPane', () => ({ EditorPane: () => <div data-pane-marker="editor" /> }));
vi.mock('@/ui/ConsolePanel', () => ({ ConsolePanel: () => <div data-pane-marker="console" /> }));
vi.mock('@/ui/WatchPane', () => ({ WatchPane: () => <div data-pane-marker="watch" /> }));

import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';

beforeEach(() => {
  registerDefaultEngines();
});

afterEach(() => {
  cleanup();
});

describe('Desktop Shell layout', () => {
  it('renders UnifiedHeader and does not render obsolete TitleBar or Toolbar', () => {
    render(<App />);

    expect(screen.getByRole('banner')).toBeTruthy(); // UnifiedHeader uses <header>
    expect(screen.getByText('C/C++ Studio')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /More actions/i })).toBeTruthy();
    expect(document.querySelector('.titlebar')).toBeNull();
    expect(document.querySelector('.toolbar')).toBeNull();
  });
});
