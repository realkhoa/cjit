# Desktop UI Streamlining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streamline the desktop UI by replacing the separate TitleBar and Toolbar with a single 38px UnifiedHeader, decluttering the StatusBar, and organizing secondary actions into a clean overflow menu.

**Architecture:** Create `UnifiedHeader.tsx` which integrates branding, execution controls (Run, Stop, Engine selector), workspace tools (Inline values, Share, Settings), and a More Actions overflow dropdown (`.wasm`, `.o`, clear console). Clean static non-actionable labels from `StatusBar.tsx` while retaining dynamic state indicators and PWA actions. Update `App.tsx` to mount `UnifiedHeader` in the desktop tree.

**Tech Stack:** React 18, TypeScript 5.7, Zustand 5, Vite 6, Vitest 3, React Testing Library.

## Global Constraints

- Fixed height for UnifiedHeader: 38px (`--vs-unified-header-height: 38px`).
- Preserves 100% of mobile shell isolation (`isMobile === true` uses `MobileHeader`, `MobileTabs`, `MobileAccessoryBar`, `MobileMenu`).
- Preserves all mobile CSS touch guards (`@media (hover: none)...explorer__actions`, `env(safe-area-inset-bottom)`, `touch-action: manipulation`, `overscroll-behavior: contain`).
- All Doxygen / TSDoc docstrings for components, exported functions, and helper types.
- English for all code, comments, and commit messages; Vietnamese for user reporting.
- All 733+ tests must pass; 0 TypeScript errors on `npm run typecheck`.

---

### Task 1: CSS Styling & Token Setup for UnifiedHeader

**Files:**
- Modify: `src/ui/theme/app.css:86-120`
- Test: `tests/unifiedHeaderStyles.test.ts`

**Interfaces:**
- Produces: CSS class selectors `.unified-header`, `.unified-header__brand`, `.unified-header__exec`, `.unified-header__tools`, `.unified-header__menu`, and variable `--vs-unified-header-height: 38px`.

- [ ] **Step 1: Write the failing test for style tokens**

Create `tests/unifiedHeaderStyles.test.ts`:
```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unifiedHeaderStyles.test.ts`
Expected: FAIL with missing `--vs-unified-header-height: 38px;` and `.unified-header`.

- [ ] **Step 3: Implement minimal CSS in `src/ui/theme/app.css`**

Add the root variable and `.unified-header` styling rules in `src/ui/theme/app.css`:
```css
:root {
  --vs-unified-header-height: 38px;
}

/* ---------- unified header ---------- */

.unified-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--vs-unified-header-height);
  padding: 0 10px;
  background: var(--vs-shell);
  border-bottom: 1px solid var(--vs-border);
  flex: 0 0 auto;
  user-select: none;
  gap: 8px;
  position: relative;
  z-index: 10;
}

.unified-header__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 0 1 auto;
}

.unified-header__logo {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--vs-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.unified-header__title {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.2px;
  color: var(--vs-text);
  white-space: nowrap;
}

.unified-header__path {
  color: var(--vs-text-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.unified-header__exec {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.unified-header__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  justify-content: flex-end;
}

.unified-header__menu-wrap {
  position: relative;
}

.unified-header__menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--vs-panel);
  border: 1px solid var(--vs-border);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  padding: 4px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 100;
}

.unified-header__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--vs-text);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  text-align: left;
}

.unified-header__menu-item:hover:not(:disabled) {
  background: var(--vs-accent);
  color: #fff;
}

.unified-header__menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.unified-header__menu-sep {
  height: 1px;
  background: var(--vs-border);
  margin: 3px 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unifiedHeaderStyles.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme/app.css tests/unifiedHeaderStyles.test.ts
git -c core.safecrlf=false commit -m "style(ui): add styling tokens for unified desktop header"
```

---

### Task 2: Implement `UnifiedHeader` Component

**Files:**
- Create: `src/ui/UnifiedHeader.tsx`
- Create: `tests/unifiedHeader.test.tsx`

**Interfaces:**
- Consumes:
  - `useAppStore` from `@/state/store`
  - `SettingsDialog` from `@/ui/SettingsDialog`
  - `ENGINE_ORDER`, `getEngine`, `EngineId` from `@/engine/registry`
  - `isTranslationUnit` from `@/lang/clang/runtime`
- Produces:
  - `export function UnifiedHeader(): JSX.Element`

- [ ] **Step 1: Write the failing unit tests for `UnifiedHeader`**

Create `tests/unifiedHeader.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UnifiedHeader } from '@/ui/UnifiedHeader';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';

beforeEach(() => {
  registerDefaultEngines();
  useAppStore.setState({
    path: 'main.cpp',
    runState: 'idle',
    engineId: 'fast',
    artifactsReady: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UnifiedHeader', () => {
  it('renders brand name, logo and active file path', () => {
    render(<UnifiedHeader />);
    expect(screen.getByText('C+')).toBeTruthy();
    expect(screen.getByText('C/C++ Studio')).toBeTruthy();
    expect(screen.getByText(/main\.cpp/)).toBeTruthy();
  });

  it('renders Run button with F5 badge and triggers run', () => {
    const runMock = vi.fn();
    useAppStore.setState({ run: runMock });
    render(<UnifiedHeader />);

    const runBtn = screen.getByRole('button', { name: /Run/i });
    expect(runBtn).toBeTruthy();
    expect(screen.getByText('F5')).toBeTruthy();
    fireEvent.click(runBtn);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('allows switching compiler engine via selector', () => {
    render(<UnifiedHeader />);
    const select = screen.getByLabelText(/Compiler engine/i) as HTMLSelectElement;
    expect(select.value).toBe('fast');

    fireEvent.change(select, { target: { value: 'clang-wasm' } });
    expect(useAppStore.getState().engineId).toBe('clang-wasm');
  });

  it('enables Stop button when running and triggers stop', () => {
    const stopMock = vi.fn();
    useAppStore.setState({ runState: 'running', stop: stopMock });
    render(<UnifiedHeader />);

    const stopBtn = screen.getByRole('button', { name: /Stop/i });
    expect(stopBtn.getAttribute('disabled')).toBeNull();
    fireEvent.click(stopBtn);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('toggles overflow action menu and handles actions', () => {
    const clearMock = vi.fn();
    useAppStore.setState({ clearOutput: clearMock });
    render(<UnifiedHeader />);

    const menuBtn = screen.getByRole('button', { name: /More actions/i });
    expect(screen.queryByText(/Clear console/i)).toBeNull();

    fireEvent.click(menuBtn);
    expect(screen.getByText(/Clear console/i)).toBeTruthy();

    fireEvent.click(screen.getByText(/Clear console/i));
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Clear console/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unifiedHeader.test.tsx`
Expected: FAIL with "Cannot find module '@/ui/UnifiedHeader'".

- [ ] **Step 3: Write implementation in `src/ui/UnifiedHeader.tsx`**

Create `src/ui/UnifiedHeader.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { ENGINE_ORDER, getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';
import { isTranslationUnit } from '@/lang/clang/runtime';
import { useAppStore } from '@/state/store';
import { SettingsDialog } from '@/ui/SettingsDialog';

/**
 * @brief Helper to generate host and path breadcrumb string.
 * @return Formatted host and path or empty string when window is undefined.
 */
function hostLabel(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.host}${window.location.pathname}`;
}

/**
 * @brief Streamlined unified desktop header combining TitleBar and Toolbar.
 * @details Hosts branding, file breadcrumb, execution controls, and workspace tools.
 * @return Rendered UnifiedHeader JSX element.
 */
export function UnifiedHeader(): JSX.Element {
  const path = useAppStore((state) => state.path);
  const runState = useAppStore((state) => state.runState);
  const engineId = useAppStore((state) => state.engineId);
  const run = useAppStore((state) => state.run);
  const stop = useAppStore((state) => state.stop);
  const artifactsReady = useAppStore((state) => state.artifactsReady);
  const downloadArtifact = useAppStore((state) => state.downloadArtifact);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const inlineValues = useAppStore((state) => state.settings.inlineValues);
  const toggleInlineValues = useAppStore((state) => state.toggleInlineValues);
  const shareLink = useAppStore((state) => state.shareLink);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const menuRef = useRef<HTMLDivElement>(null);

  const running = runState === 'running';

  const handleShare = (): void => {
    void shareLink().then((outcome) => {
      setShareState(outcome.ok ? 'copied' : 'failed');
      setTimeout(() => setShareState('idle'), 2500);
    });
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutsideClick = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [menuOpen]);

  return (
    <header className="unified-header">
      {/* Left Group: Brand & Path */}
      <div className="unified-header__brand">
        <span className="unified-header__logo" aria-hidden="true">C+</span>
        <span className="unified-header__title">C/C++ Studio</span>
        <span className="unified-header__path" title={`${hostLabel()} · ${path}`}>
          · {path}
        </span>
      </div>

      {/* Center Group: Execution controls */}
      <div className="unified-header__exec">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={running}
          title="Build và chạy chương trình (F5)"
        >
          ▶ Run <span className="btn__key">F5</span>
        </button>

        <label className="sr-only" htmlFor="unified-engine-select">
          Compiler engine
        </label>
        <select
          id="unified-engine-select"
          className="select"
          value={engineId}
          onChange={(event) => setEngineId(event.target.value as EngineId)}
          title="Chọn engine cho nút Run/F5"
        >
          {ENGINE_ORDER.map((id) => (
            <option key={id} value={id}>
              {getEngine(id).label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn"
          onClick={stop}
          disabled={!running}
          title="Dừng chương trình đang chạy (Shift+F5)"
        >
          ■ Stop
        </button>
      </div>

      {/* Right Group: Tools & Overflow Menu */}
      <div className="unified-header__tools">
        <button
          type="button"
          className={inlineValues ? 'btn btn--toggled' : 'btn'}
          onClick={toggleInlineValues}
          aria-pressed={inlineValues}
          title="Hiện/ẩn giá trị biến ngay sau mỗi dòng code đã chạy"
        >
          Inline values
        </button>

        <button
          type="button"
          className={shareState === 'copied' ? 'btn btn--toggled' : 'btn'}
          onClick={handleShare}
          title="Copy link chia sẻ toàn bộ workspace (mã hoá trong URL, không gửi lên server)"
        >
          {shareState === 'copied' ? 'Link copied' : shareState === 'failed' ? 'Link too long' : 'Share link'}
        </button>

        <button
          type="button"
          className={settingsOpen ? 'btn btn--toggled' : 'btn'}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          title="Cài đặt cấu hình editor"
        >
          ⚙ Settings
        </button>

        {/* Overflow Menu */}
        <div className="unified-header__menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={menuOpen ? 'btn btn--toggled' : 'btn'}
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="More actions"
            aria-expanded={menuOpen}
            title="Thao tác khác"
          >
            ···
          </button>

          {menuOpen ? (
            <div className="unified-header__menu" role="menu">
              <button
                type="button"
                className="unified-header__menu-item"
                disabled={!artifactsReady}
                onClick={() => {
                  setMenuOpen(false);
                  void downloadArtifact('wasm');
                }}
                title="Tải file .wasm (chỉ bật sau khi Run thành công)"
              >
                ⬇ Tải .wasm
              </button>
              <button
                type="button"
                className="unified-header__menu-item"
                disabled={!artifactsReady || !isTranslationUnit(path)}
                onClick={() => {
                  setMenuOpen(false);
                  void downloadArtifact('object');
                }}
                title={
                  isTranslationUnit(path)
                    ? 'Tải object file của file đang mở'
                    : 'File đang mở là header — chỉ file .c/.cpp mới có object file'
                }
              >
                ⬇ Tải .o
              </button>
              <div className="unified-header__menu-sep" />
              <button
                type="button"
                className="unified-header__menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  clearOutput();
                }}
                title="Xoá nội dung console"
              >
                ⌫ Clear console
              </button>
              <div className="unified-header__menu-sep" />
              <div
                className="pill"
                style={{ margin: '4px', textAlign: 'center', fontSize: '10px' }}
                title="Toàn bộ quá trình biên dịch và thực thi chạy trong browser"
              >
                client-only · no backend
              </div>
            </div>
          ) : null}
        </div>

        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unifiedHeader.test.tsx`
Expected: PASS (5 tests passed)

- [ ] **Step 5: Commit**

```bash
git add src/ui/UnifiedHeader.tsx tests/unifiedHeader.test.tsx
git -c core.safecrlf=false commit -m "feat(ui): implement UnifiedHeader component with overflow actions"
```

---

### Task 3: Streamline `StatusBar.tsx`

**Files:**
- Modify: `src/ui/StatusBar.tsx:68-84`
- Test: `tests/statusBar.test.tsx`
- Test: `tests/installPrompt.test.tsx`

**Interfaces:**
- Consumes: `useAppStore`, `useInstall`, `dotClass`, `overallLabel`, `overallTone`
- Produces: Streamlined `StatusBar` JSX element with clean dynamic items and no static `Spaces: 4`, `UTF-8`, `LF`.

- [ ] **Step 1: Write test verifying streamlined StatusBar items**

Create `tests/statusBar.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBar } from '@/ui/StatusBar';
import { useAppStore } from '@/state/store';

beforeEach(() => {
  useAppStore.setState({
    runState: 'idle',
    analysisState: 'idle',
    cursor: { line: 1, column: 1, selected: 0 },
    language: 'cpp',
    trash: [],
    storageWarning: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('streamlined StatusBar', () => {
  it('does not display static non-actionable labels (Spaces, UTF-8, LF)', () => {
    render(<StatusBar />);
    expect(screen.queryByText(/Spaces: 4/i)).toBeNull();
    expect(screen.queryByText(/UTF-8/i)).toBeNull();
    expect(screen.queryByText(/LF/i)).toBeNull();
  });

  it('renders dynamic cursor, language, and status indicators', () => {
    useAppStore.setState({
      cursor: { line: 42, column: 7, selected: 5 },
      language: 'cpp',
    });
    render(<StatusBar />);

    expect(screen.getByText(/Ln 42, Col 7/)).toBeTruthy();
    expect(screen.getByText(/Sel 5/)).toBeTruthy();
    expect(screen.getByText('C++')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/statusBar.test.tsx`
Expected: FAIL because `Spaces: 4`, `UTF-8`, and `LF` are currently present.

- [ ] **Step 3: Update `src/ui/StatusBar.tsx`**

Modify `src/ui/StatusBar.tsx` lines 68-84 to remove the static elements while keeping cursor, selection, language, and watch engine:
```tsx
        <span className="statusbar__item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        {cursor.selected > 0 ? <span className="statusbar__item">Sel {cursor.selected}</span> : null}
        <span className="statusbar__item">{language === 'c' ? 'C' : 'C++'}</span>
        <span
          className="statusbar__item statusbar__item--wide"
          title="Engine đã tạo ra giá trị trong pane Watch"
        >
          watch: {watch.engineLabel}
        </span>
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/statusBar.test.tsx tests/installPrompt.test.tsx`
Expected: PASS (All tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/ui/StatusBar.tsx tests/statusBar.test.tsx
git -c core.safecrlf=false commit -m "refactor(ui): streamline StatusBar by removing static read-only indicators"
```

---

### Task 4: Integrate `UnifiedHeader` into `src/App.tsx`

**Files:**
- Modify: `src/App.tsx:1-154`
- Create: `tests/desktopShell.test.tsx`

**Interfaces:**
- Consumes: `UnifiedHeader` from `@/ui/UnifiedHeader`, `StatusBar`, `Explorer`, `Splitter`, `EditorPane`, `WatchPane`, `ConsolePanel`
- Produces: Updated root `App` component with 38px `UnifiedHeader`.

- [ ] **Step 1: Write integration test for the desktop shell**

Create `tests/desktopShell.test.tsx`:
```tsx
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
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/desktopShell.test.tsx`
Expected: FAIL because `.titlebar` and `.toolbar` are currently present.

- [ ] **Step 3: Update `src/App.tsx`**

Replace `TitleBar` and `Toolbar` imports with `UnifiedHeader`, and update the desktop JSX return block:
```tsx
import { useCallback, useState } from 'react';
import { ConsolePanel } from '@/ui/ConsolePanel';
import { EditorPane } from '@/ui/EditorPane';
import { Explorer } from '@/ui/Explorer';
import { MobileAccessoryBar } from '@/ui/MobileAccessoryBar';
import { MobileHeader } from '@/ui/MobileHeader';
import { MobileMenu } from '@/ui/MobileMenu';
import { MobileTabs } from '@/ui/MobileTabs';
import { Splitter } from '@/ui/Splitter';
import { StatusBar } from '@/ui/StatusBar';
import { UnifiedHeader } from '@/ui/UnifiedHeader';
import { WatchPane } from '@/ui/WatchPane';
import { useIsMobile } from '@/ui/useIsMobile';
import { useTimelinePlayback } from '@/ui/useTimelinePlayback';
import { useAppStore } from '@/state/store';
import {
  MAX_BOTTOM_PERCENT,
  MAX_RIGHT_PERCENT,
  MIN_BOTTOM_PERCENT,
  MIN_RIGHT_PERCENT,
  percentFromDelta,
} from '@/util/layout';

function viewportExtent(axis: 'width' | 'height'): number {
  if (typeof window === 'undefined') return 0;
  return axis === 'width' ? window.innerWidth : window.innerHeight;
}

export function App() {
  const rightPercent = useAppStore((state) => state.rightPercent);
  const bottomPercent = useAppStore((state) => state.bottomPercent);
  const explorerWidth = useAppStore((state) => state.explorerWidth);
  const mobilePane = useAppStore((state) => state.mobilePane);
  const setRightPercent = useAppStore((state) => state.setRightPercent);
  const setBottomPercent = useAppStore((state) => state.setBottomPercent);
  const setExplorerWidth = useAppStore((state) => state.setExplorerWidth);
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Playback is driven from the shell, so it keeps running whichever pane is shown.
  useTimelinePlayback();

  // Negative sign: dragging the divider right/up makes the fixed pane smaller.
  const handleRightDelta = useCallback(
    (deltaPx: number) => {
      const current = useAppStore.getState().rightPercent;
      setRightPercent(
        percentFromDelta(current, -deltaPx, viewportExtent('width'), MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT),
      );
    },
    [setRightPercent],
  );

  const handleBottomDelta = useCallback(
    (deltaPx: number) => {
      const current = useAppStore.getState().bottomPercent;
      setBottomPercent(
        percentFromDelta(
          current,
          -deltaPx,
          viewportExtent('height'),
          MIN_BOTTOM_PERCENT,
          MAX_BOTTOM_PERCENT,
        ),
      );
    },
    [setBottomPercent],
  );

  // The explorer is a fixed width in pixels, so the delta applies directly.
  const handleExplorerDelta = useCallback(
    (deltaPx: number) => {
      setExplorerWidth(useAppStore.getState().explorerWidth + deltaPx);
    },
    [setExplorerWidth],
  );

  // Narrow layout: dedicated touch-first mobile shell with compact MobileHeader,
  // C++ quick accessory bar under the editor, modern bottom tabs, and overflow sheet.
  if (isMobile) {
    return (
      <div className="app" data-layout="mobile">
        <MobileHeader onOpenMenu={() => setMobileMenuOpen(true)} />

        <main className="workspace workspace--mobile">
          <aside className="pane" data-pane="files" data-active={mobilePane === 'files'}>
            <Explorer />
          </aside>
          <div
            className="pane pane--editor"
            data-pane="code"
            data-active={mobilePane === 'code'}
          >
            <EditorPane />
            <MobileAccessoryBar />
          </div>
          <div className="pane" data-pane="watch" data-active={mobilePane === 'watch'}>
            <WatchPane />
          </div>
          <div className="pane" data-pane="console" data-active={mobilePane === 'console'}>
            <ConsolePanel />
          </div>
        </main>

        <MobileTabs />

        {mobileMenuOpen && <MobileMenu onClose={() => setMobileMenuOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="app">
      <UnifiedHeader />

      <main className="workspace">
        <div
          className="workspace__row"
          style={{ height: `calc(${100 - bottomPercent}% - var(--vs-splitter))` }}
        >
          <aside className="pane" style={{ flex: `0 0 ${explorerWidth}px` }}>
            <Explorer />
          </aside>

          <Splitter orientation="vertical" label="Resize explorer" onDelta={handleExplorerDelta} />

          <div className="workspace__split">
            <div
              className="pane pane--editor"
              style={{ flex: `0 0 calc(${100 - rightPercent}% - var(--vs-splitter))` }}
            >
              <EditorPane />
            </div>

            <Splitter orientation="vertical" label="Resize watch pane" onDelta={handleRightDelta} />

            <div className="pane" style={{ flex: '1 1 auto' }}>
              <WatchPane />
            </div>
          </div>
        </div>

        <Splitter orientation="horizontal" label="Resize console" onDelta={handleBottomDelta} />

        <div className="pane" style={{ height: `${bottomPercent}%`, flex: '0 0 auto' }}>
          <ConsolePanel />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify it passes**

Run: `npx vitest run tests/desktopShell.test.tsx tests/mobileLayout.test.tsx tests/exampleSafety.test.tsx`
Expected: PASS (All tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx tests/desktopShell.test.tsx
git -c core.safecrlf=false commit -m "feat(ui): mount UnifiedHeader in desktop application shell"
```

---

### Task 5: Full Regression Testing & Production Build Gate

**Files:**
- All files across the repository

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: 0 diagnostic errors (exit code 0).

- [ ] **Step 2: Run complete test suite**

Run: `npm test`
Expected: 100% tests passing across all test files with 0 failures.

- [ ] **Step 3: Run full production build**

Run: `npm run build`
Expected: App bundle and service worker bundle built cleanly into `dist/` with exit code 0.

- [ ] **Step 4: Commit any documentation updates**

```bash
git add docs/superpowers/plans/2026-10-18-desktop-ui-streamlining.md
git -c core.safecrlf=false commit -m "docs: finalize desktop UI streamlining implementation plan"
```
