# Mobile UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modern, touch-first mobile UI shell with dedicated header, overflow bottom sheet, C++ accessory keyboard bar, and SVG bottom navigation bar while preserving 100% of the desktop layout and test suite.

**Architecture:** Conditional mobile shell in `src/App.tsx` (`isMobile === true`) rendering `MobileHeader`, `MobileTabs`, `MobileAccessoryBar`, and `MobileMenu`, styled via scoped CSS rules under `.app[data-layout="mobile"]`. Desktop components remain completely intact and active when `isMobile === false`.

**Tech Stack:** React 18, TypeScript, Zustand (`useAppStore`), Monaco Editor API, Vitest, Testing Library.

## Global Constraints
- Preserve 100% desktop functionality and layout (`TitleBar`, `Toolbar`, `Splitter`, `StatusBar`).
- Zero build errors (`npm run typecheck`).
- All 733 existing unit and conformance tests must pass.
- Every function/component must have complete Doxygen/TSDoc comments (Rule 5).
- All code and comments in English; user reports in Vietnamese (Rule 7).

---

### Task 1: Create `MobileHeader` Component

**Files:**
- Create: `src/ui/MobileHeader.tsx`
- Test: `tests/mobileHeader.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export interface MobileHeaderProps {
    readonly onOpenMenu: () => void;
  }
  export function MobileHeader(props: MobileHeaderProps): JSX.Element;
  ```
- Consumes:
  - `useAppStore`: `path`, `engineId`, `setEngineId`, `runState`, `run`, `stop`.

- [ ] **Step 1: Write the failing unit tests for MobileHeader**

Create `tests/mobileHeader.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileHeader } from '@/ui/MobileHeader';
import { useAppStore } from '@/state/store';

describe('MobileHeader component', () => {
  beforeEach(() => {
    useAppStore.setState({
      path: 'src/main.cpp',
      engineId: 'fast',
      runState: 'idle',
    });
  });

  it('renders active file name and engine badge', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    expect(screen.getByText('main.cpp')).toBeDefined();
    expect(screen.getByText('Fast')).toBeDefined();
  });

  it('toggles engine when clicking the engine badge', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    const badge = screen.getByText('Fast');
    fireEvent.click(badge);
    expect(useAppStore.getState().engineId).toBe('clang');
  });

  it('triggers run when clicking the Run button in idle state', () => {
    const runSpy = vi.fn();
    useAppStore.setState({ run: runSpy });
    render(<MobileHeader onOpenMenu={vi.fn()} />);
    const runBtn = screen.getByRole('button', { name: /run/i });
    fireEvent.click(runBtn);
    expect(runSpy).toHaveBeenCalled();
  });

  it('renders Stop button when running and triggers stop', () => {
    const stopSpy = vi.fn();
    useAppStore.setState({ runState: 'running', stop: stopSpy });
    render(<MobileHeader onOpenMenu={vi.fn()} />);
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopBtn);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('triggers onOpenMenu when clicking the overflow button', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    const menuBtn = screen.getByRole('button', { name: /more actions/i });
    fireEvent.click(menuBtn);
    expect(onOpenMenu).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mobileHeader.test.tsx`
Expected: FAIL (Cannot find module `@/ui/MobileHeader`)

- [ ] **Step 3: Implement `MobileHeader.tsx`**

Create `src/ui/MobileHeader.tsx`:
```tsx
import { useAppStore } from '@/state/store';
import { getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';

/**
 * Props for the MobileHeader component.
 */
export interface MobileHeaderProps {
  /** Callback fired when the user taps the overflow menu button. */
  readonly onOpenMenu: () => void;
}

/**
 * Compact top bar for mobile viewports.
 *
 * Displays the current file name, an engine switch pill, a prominent Run/Stop
 * touch button, and an overflow menu button.
 *
 * @param props Component properties containing the menu toggle handler.
 * @returns Mobile header JSX element.
 */
export function MobileHeader({ onOpenMenu }: MobileHeaderProps) {
  const path = useAppStore((state) => state.path);
  const engineId = useAppStore((state) => state.engineId);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const runState = useAppStore((state) => state.runState);
  const run = useAppStore((state) => state.run);
  const stop = useAppStore((state) => state.stop);

  const running = runState === 'running';
  const fileName = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const engine = getEngine(engineId);

  const toggleEngine = () => {
    const nextEngine: EngineId = engineId === 'fast' ? 'clang' : 'fast';
    setEngineId(nextEngine);
  };

  return (
    <header className="mobile-header" role="banner" aria-label="Mobile Navigation Bar">
      <div className="mobile-header__file-info">
        <span className="mobile-header__icon" aria-hidden="true">📄</span>
        <span className="mobile-header__name" title={path}>{fileName}</span>
        <button
          type="button"
          className="mobile-header__engine-pill"
          onClick={toggleEngine}
          title={`Đổi engine (đang dùng: ${engine.label})`}
        >
          {engineId === 'fast' ? 'Fast' : 'Clang'}
        </button>
      </div>

      <div className="mobile-header__actions">
        {running ? (
          <button
            type="button"
            className="mobile-btn mobile-btn--stop"
            onClick={stop}
            aria-label="Stop program execution"
            title="Dừng chương trình (Shift+F5)"
          >
            <span className="mobile-btn__icon" aria-hidden="true">■</span>
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="mobile-btn mobile-btn--run"
            onClick={() => void run()}
            aria-label="Run program"
            title="Chạy chương trình (F5)"
          >
            <span className="mobile-btn__icon" aria-hidden="true">▶</span>
            <span>Run</span>
          </button>
        )}

        <button
          type="button"
          className="mobile-icon-btn"
          onClick={onOpenMenu}
          aria-label="More actions"
          title="Tùy chọn khác"
        >
          ⋮
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mobileHeader.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/MobileHeader.tsx tests/mobileHeader.test.tsx
git commit -m "feat(mobile): add MobileHeader component with touch-friendly run button"
```

---

### Task 2: Create `MobileMenu` Bottom Sheet Component

**Files:**
- Create: `src/ui/MobileMenu.tsx`
- Test: `tests/mobileMenu.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export interface MobileMenuProps {
    readonly onClose: () => void;
    readonly onOpenSettings?: () => void;
  }
  export function MobileMenu(props: MobileMenuProps): JSX.Element;
  ```
- Consumes:
  - `useAppStore`: `engineId`, `setEngineId`, `artifactsReady`, `downloadArtifact`, `clearOutput`, `shareLink`, `path`.

- [ ] **Step 1: Write the failing unit tests for MobileMenu**

Create `tests/mobileMenu.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileMenu } from '@/ui/MobileMenu';
import { useAppStore } from '@/state/store';

describe('MobileMenu bottom sheet', () => {
  beforeEach(() => {
    useAppStore.setState({
      engineId: 'fast',
      artifactsReady: true,
      path: 'main.cpp',
    });
  });

  it('renders menu options and closes when clicking close button or backdrop', () => {
    const onClose = vi.fn();
    render(<MobileMenu onClose={onClose} />);

    expect(screen.getByText(/compiler engine/i)).toBeDefined();
    expect(screen.getByText(/tải \.wasm/i)).toBeDefined();

    const closeBtn = screen.getByRole('button', { name: /đóng/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('changes engine via segmented radio buttons', () => {
    render(<MobileMenu onClose={vi.fn()} />);
    const clangRadio = screen.getByLabelText(/clang/i);
    fireEvent.click(clangRadio);
    expect(useAppStore.getState().engineId).toBe('clang');
  });

  it('clears console output when clicking clear output button', () => {
    const clearSpy = vi.fn();
    useAppStore.setState({ clearOutput: clearSpy });
    render(<MobileMenu onClose={vi.fn()} />);
    const clearBtn = screen.getByRole('button', { name: /xóa màn hình console/i });
    fireEvent.click(clearBtn);
    expect(clearSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mobileMenu.test.tsx`
Expected: FAIL (Cannot find module `@/ui/MobileMenu`)

- [ ] **Step 3: Implement `MobileMenu.tsx`**

Create `src/ui/MobileMenu.tsx`:
```tsx
import { useState } from 'react';
import { useAppStore } from '@/state/store';
import { ENGINE_ORDER, getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';
import { isTranslationUnit } from '@/lang/clang/runtime';
import { SettingsDialog } from '@/ui/SettingsDialog';

/**
 * Properties for the MobileMenu component.
 */
export interface MobileMenuProps {
  /** Callback fired when the bottom sheet should close. */
  readonly onClose: () => void;
}

/**
 * Bottom-sheet overflow menu for mobile viewports.
 *
 * Groups engine switching, artifact downloads, share link, clear output,
 * and application settings into a convenient touch modal.
 *
 * @param props Component properties containing the close callback.
 * @returns Mobile bottom sheet JSX element.
 */
export function MobileMenu({ onClose }: MobileMenuProps) {
  const engineId = useAppStore((state) => state.engineId);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const artifactsReady = useAppStore((state) => state.artifactsReady);
  const downloadArtifact = useAppStore((state) => state.downloadArtifact);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const shareLink = useAppStore((state) => state.shareLink);
  const path = useAppStore((state) => state.path);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleShare = () => {
    void shareLink().then((res) => {
      setShareStatus(res.ok ? 'copied' : 'failed');
      setTimeout(() => setShareStatus('idle'), 2000);
    });
  };

  return (
    <>
      <div className="mobile-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Tùy chọn Mobile">
        <div className="mobile-sheet__handle" aria-hidden="true" />

        <div className="mobile-sheet__header">
          <h2 className="mobile-sheet__title">Tùy chọn C/C++ Studio</h2>
          <button
            type="button"
            className="mobile-icon-btn"
            onClick={onClose}
            aria-label="Đóng"
          >
            ✕
          </button>
        </div>

        <div className="mobile-sheet__body">
          {/* Engine Selection */}
          <section className="mobile-sheet__section">
            <h3 className="mobile-sheet__section-title">Compiler Engine</h3>
            <div className="mobile-sheet__engine-grid">
              {ENGINE_ORDER.map((id) => {
                const engine = getEngine(id);
                const active = engineId === id;
                return (
                  <label
                    key={id}
                    className={`mobile-sheet__engine-option ${active ? 'mobile-sheet__engine-option--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="mobile-engine-choice"
                      value={id}
                      checked={active}
                      onChange={() => setEngineId(id as EngineId)}
                    />
                    <div className="mobile-sheet__engine-text">
                      <strong>{engine.label}</strong>
                      <small>{id === 'fast' ? 'Watch pane & tốc độ cao' : 'WebAssembly clang + lld'}</small>
                    </div>
                  </label>
                );
              })}
            </div>
          </section>

          {/* Artifacts Download */}
          <section className="mobile-sheet__section">
            <h3 className="mobile-sheet__section-title">Artifacts</h3>
            <div className="mobile-sheet__row">
              <button
                type="button"
                className="btn mobile-sheet__btn"
                disabled={!artifactsReady}
                onClick={() => void downloadArtifact('wasm')}
              >
                ⬇ Tải .wasm
              </button>
              <button
                type="button"
                className="btn mobile-sheet__btn"
                disabled={!artifactsReady || !isTranslationUnit(path)}
                onClick={() => void downloadArtifact('object')}
              >
                ⬇ Tải .o
              </button>
            </div>
          </section>

          {/* Utilities */}
          <section className="mobile-sheet__section">
            <h3 className="mobile-sheet__section-title">Tiện ích</h3>
            <div className="mobile-sheet__grid">
              <button
                type="button"
                className="btn mobile-sheet__btn"
                onClick={handleShare}
              >
                🔗 {shareStatus === 'copied' ? 'Đã sao chép link!' : shareStatus === 'failed' ? 'Lỗi tạo link' : 'Chia sẻ project'}
              </button>
              <button
                type="button"
                className="btn mobile-sheet__btn"
                onClick={() => {
                  clearOutput();
                  onClose();
                }}
              >
                🧹 Xóa màn hình console
              </button>
              <button
                type="button"
                className="btn mobile-sheet__btn"
                onClick={() => setSettingsOpen(true)}
              >
                ⚙️ Cài đặt (Settings)
              </button>
            </div>
          </section>
        </div>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mobileMenu.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/MobileMenu.tsx tests/mobileMenu.test.tsx
git commit -m "feat(mobile): add MobileMenu bottom sheet component"
```

---

### Task 3: Create `MobileAccessoryBar` Component

**Files:**
- Create: `src/ui/MobileAccessoryBar.tsx`
- Test: `tests/mobileAccessoryBar.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export interface MobileAccessoryBarProps {
    readonly onInsertText?: (text: string) => void;
  }
  export function MobileAccessoryBar(props: MobileAccessoryBarProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing unit tests for MobileAccessoryBar**

Create `tests/mobileAccessoryBar.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileAccessoryBar, C_PLUS_PLUS_QUICK_KEYS } from '@/ui/MobileAccessoryBar';

describe('MobileAccessoryBar component', () => {
  it('renders standard C++ quick keys', () => {
    render(<MobileAccessoryBar />);
    for (const item of C_PLUS_PLUS_QUICK_KEYS) {
      expect(screen.getByText(item.label)).toBeDefined();
    }
  });

  it('calls onInsertText callback when a symbol button is clicked', () => {
    const onInsert = vi.fn();
    render(<MobileAccessoryBar onInsertText={onInsert} />);
    const semiBtn = screen.getByText(';');
    fireEvent.click(semiBtn);
    expect(onInsert).toHaveBeenCalledWith(';');
  });

  it('inserts Tab symbol when Tab is clicked', () => {
    const onInsert = vi.fn();
    render(<MobileAccessoryBar onInsertText={onInsert} />);
    const tabBtn = screen.getByText('Tab');
    fireEvent.click(tabBtn);
    expect(onInsert).toHaveBeenCalledWith('  ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mobileAccessoryBar.test.tsx`
Expected: FAIL (Cannot find module `@/ui/MobileAccessoryBar`)

- [ ] **Step 3: Implement `MobileAccessoryBar.tsx`**

Create `src/ui/MobileAccessoryBar.tsx`:
```tsx
/**
 * Quick symbol descriptor.
 */
export interface QuickKey {
  readonly label: string;
  readonly text: string;
}

/**
 * Standard list of quick C++ syntax keys for mobile touch typing.
 */
export const C_PLUS_PLUS_QUICK_KEYS: readonly QuickKey[] = [
  { label: 'Tab', text: '  ' },
  { label: '{', text: '{' },
  { label: '}', text: '}' },
  { label: '(', text: '(' },
  { label: ')', text: ')' },
  { label: ';', text: ';' },
  { label: '::', text: '::' },
  { label: '->', text: '->' },
  { label: '<', text: '<' },
  { label: '>', text: '>' },
  { label: '"', text: '"' },
  { label: '=', text: '=' },
  { label: '&', text: '&' },
  { label: '*', text: '*' },
  { label: '!', text: '!' },
];

/**
 * Properties for the MobileAccessoryBar component.
 */
export interface MobileAccessoryBarProps {
  /** Optional custom insert callback. */
  readonly onInsertText?: (text: string) => void;
}

/**
 * Horizontal quick-key accessory bar docked under the mobile code editor.
 *
 * Allows single-tap insertion of common C++ symbols that are otherwise
 * awkward to reach on standard on-screen smartphone keyboards.
 *
 * @param props Component properties.
 * @returns Accessory bar JSX element.
 */
export function MobileAccessoryBar({ onInsertText }: MobileAccessoryBarProps) {
  const handleKeyClick = (key: QuickKey) => {
    if (onInsertText) {
      onInsertText(key.text);
      return;
    }
    // Fallback: Dispatch synthetic key event or custom event for Monaco
    window.dispatchEvent(new CustomEvent('cjit-insert-key', { detail: { text: key.text } }));
  };

  return (
    <div className="mobile-accessory-bar" role="toolbar" aria-label="C++ Quick Keys">
      <div className="mobile-accessory-bar__scroll">
        {C_PLUS_PLUS_QUICK_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="mobile-accessory-btn"
            onClick={() => handleKeyClick(key)}
            title={`Chèn ${key.label}`}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mobileAccessoryBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/MobileAccessoryBar.tsx tests/mobileAccessoryBar.test.tsx
git commit -m "feat(mobile): add MobileAccessoryBar C++ quick keys component"
```

---

### Task 4: Upgrade `MobileTabs` with SVG Icons and Active State

**Files:**
- Modify: `src/ui/MobileTabs.tsx`
- Test: `tests/mobileTabs.test.tsx`

**Interfaces:**
- Produces: `export function MobileTabs(): JSX.Element;`
- Consumes:
  - `useAppStore`: `mobilePane`, `setMobilePane`, `analysisState`, `runState`, `watch.diagnostics`.
  - `PANE_LABELS`, `PANE_ORDER` from `@/ui/responsive`.

- [ ] **Step 1: Write unit tests for enhanced MobileTabs**

Create `tests/mobileTabs.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { MobileTabs } from '@/ui/MobileTabs';
import { useAppStore } from '@/state/store';

describe('Enhanced MobileTabs', () => {
  beforeEach(() => {
    useAppStore.setState({
      mobilePane: 'code',
      analysisState: 'idle',
      runState: 'idle',
      watch: {
        variables: [],
        diagnostics: [],
        history: [],
        timelineIndex: 0,
        timelineCount: 0,
        iterations: {},
      },
    });
  });

  it('renders all 4 tabs with icons and text labels', () => {
    render(<MobileTabs />);
    expect(screen.getByRole('tab', { name: /files/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /code/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /watch/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /output/i })).toBeDefined();
  });

  it('highlights the active tab', () => {
    render(<MobileTabs />);
    const codeTab = screen.getByRole('tab', { name: /code/i });
    expect(codeTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switches tab on click', () => {
    render(<MobileTabs />);
    const watchTab = screen.getByRole('tab', { name: /watch/i });
    fireEvent.click(watchTab);
    expect(useAppStore.getState().mobilePane).toBe('watch');
  });

  it('displays problem badge when diagnostics exist', () => {
    useAppStore.setState({
      watch: {
        variables: [],
        diagnostics: [{ line: 1, column: 1, message: 'syntax error', severity: 'error' }],
        history: [],
        timelineIndex: 0,
        timelineCount: 0,
        iterations: {},
      },
    });
    render(<MobileTabs />);
    expect(screen.getByTitle(/1 problem\(s\)/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run tests/mobileTabs.test.tsx`

- [ ] **Step 3: Update `src/ui/MobileTabs.tsx` with SVG icons**

Update `src/ui/MobileTabs.tsx` to include inline crisp SVG icons for Files, Code, Watch, and Output tabs:
```tsx
import { useAppStore } from '@/state/store';
import { PANE_LABELS, PANE_ORDER, type PaneId } from '@/ui/responsive';

function TabIcon({ id }: { readonly id: PaneId }) {
  switch (id) {
    case 'files':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10l-.5-.5zm-.5 10H2V3h4.29l.86.85.35.15H14v9z"/>
        </svg>
      );
    case 'code':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M4.7 4.3L1.4 7.6v.8l3.3 3.3.7-.7L2.8 8.4l2.6-2.6-.7-.7zm6.6 0l-.7.7 2.6 2.6-2.6 2.6.7.7 3.3-3.3v-.8l-3.3-3.3zM9.3 2.5L6.1 13.5h1.2l3.2-11H9.3z"/>
        </svg>
      );
    case 'watch':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.39l3.46 3.46.71-.71-3.46-3.46a5.5 5.5 0 1 0-.71.71z"/>
        </svg>
      );
    case 'console':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M14.5 2h-13l-.5.5v11l.5.5h13l.5-.5v-11l-.5-.5zm-.5 11H2V3h12v10zM4.15 5.15l2.5 2.5v.7l-2.5 2.5-.7-.7L5.59 8 3.45 5.85l.7-.7zM8 10h4v1H8v-1z"/>
        </svg>
      );
  }
}

/**
 * Pane switcher for the narrow mobile layout.
 *
 * Renders touch-optimized bottom tabs with SVG icons, real-time analysis/run
 * status dots, and problem count badges.
 */
export function MobileTabs() {
  const pane = useAppStore((state) => state.mobilePane);
  const setMobilePane = useAppStore((state) => state.setMobilePane);
  const analyzing = useAppStore((state) => state.analysisState === 'analyzing');
  const runState = useAppStore((state) => state.runState);
  const diagnostics = useAppStore((state) => state.watch.diagnostics.length);

  return (
    <nav className="mobile-tabs" role="tablist" aria-label="Panes">
      {PANE_ORDER.map((id) => {
        const active = pane === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? 'mobile-tab mobile-tab--active' : 'mobile-tab'}
            onClick={() => setMobilePane(id)}
          >
            <span className="mobile-tab__icon-wrapper">
              <TabIcon id={id} />
              {id === 'watch' && analyzing ? (
                <span className="mobile-tab__dot" title="Đang phân tích" />
              ) : null}
              {id === 'code' && runState === 'running' ? (
                <span className="mobile-tab__dot mobile-tab__dot--busy" title="Đang chạy" />
              ) : null}
              {id === 'console' && diagnostics > 0 ? (
                <span className="mobile-tab__badge" title={`${diagnostics} problem(s)`}>
                  {diagnostics > 99 ? '99+' : diagnostics}
                </span>
              ) : null}
            </span>

            <span className="mobile-tab__label">{PANE_LABELS[id]}</span>
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mobileTabs.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/MobileTabs.tsx tests/mobileTabs.test.tsx
git commit -m "feat(mobile): upgrade MobileTabs with SVG icons and active state"
```

---

### Task 5: Integrate Mobile Shell in `src/App.tsx` and Add Scoped Styles

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/ui/theme/app.css`
- Test: `tests/mobileLayout.test.tsx`

**Interfaces:**
- Ensures `src/App.tsx` conditionally uses `MobileHeader`, `MobileAccessoryBar`, and `MobileMenu` when `isMobile === true`, while desktop branch remains 100% untouched.

- [ ] **Step 1: Update `src/App.tsx`**

Integrate `MobileHeader`, `MobileMenu`, and `MobileAccessoryBar` into the `if (isMobile)` block in `src/App.tsx`.

- [ ] **Step 2: Add CSS rules for mobile in `src/ui/theme/app.css`**

Add styles for:
- `.mobile-header`
- `.mobile-sheet`, `.mobile-sheet-backdrop`
- `.mobile-accessory-bar`, `.mobile-accessory-btn`
- Touch targets >= 44px, safe area insets.

- [ ] **Step 3: Update `tests/mobileLayout.test.tsx` to verify new mobile shell structure**

Run: `npx vitest run tests/mobileLayout.test.tsx`
Expected: PASS

- [ ] **Step 4: Run full project tests and typecheck**

Run:
```bash
npm run typecheck
npm test
npm run build
```
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/ui/theme/app.css tests/mobileLayout.test.tsx
git commit -m "feat(mobile): integrate touch-first mobile shell and responsive styles"
```

---

### Task 6: Final Verification & Smoke Testing

- [ ] **Step 1: Run full regression test suite**
Run: `npm test`
Expected: All 733+ tests pass cleanly.

- [ ] **Step 2: Run production build verification**
Run: `npm run build`
Expected: Exit code 0, dist artifacts created.

- [ ] **Step 3: Verify git status is clean**
Run: `git status`
Expected: Working tree clean.
