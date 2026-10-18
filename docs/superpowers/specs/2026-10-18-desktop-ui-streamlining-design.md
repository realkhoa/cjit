# Design Document: Desktop UI Streamlining & Unified Header

**Date**: 2026-10-18  
**Topic**: Streamlining Desktop Shell with Unified Header and Clean Status Bar  
**Status**: In Review  

---

## 1. Overview & Goals

C/C++ Studio currently renders two separate horizontal bars on desktop: `<TitleBar />` (30px) and `<Toolbar />` (34px), consuming 64px of vertical screen real estate. The desktop toolbar contains multiple secondary buttons (`⬇ .wasm`, `⬇ .o`, `Clear console`) and duplicate status pills (`watch: fast · debounce 1000 ms`), while `<StatusBar />` displays static, non-actionable editor settings (`Spaces: 4`, `UTF-8`, `LF`, and redundant `watch: fast`).

### Goals
1. **Unified Header (`UnifiedHeader.tsx`)**:
   - Merge `TitleBar` and `Toolbar` into a single, sleek 38px top bar (VS Code / Zed standard).
   - Reclaim 26px of vertical height for code editing and inspection panels.
   - Organize into three distinct visual clusters:
     - **Left (Brand & Breadcrumb)**: `C+` logo brand and current active file path breadcrumb.
     - **Center (Execution Group)**: Prominent `▶ Run` (F5) button, adjacent compact compiler engine selector (`fast` vs `clang-wasm`), and `■ Stop` (Shift+F5) button.
     - **Right (Tools & Overflow Action Menu)**: `Inline values` toggle, `Share link`, `⚙ Settings`, and a clean `···` (More Actions) dropdown menu housing secondary actions (`.wasm` download, `.o` download, `Clear console`, and `client-only · no backend` indicator).
2. **Clean Status Bar (`StatusBar.tsx`)**:
   - Remove static read-only indicators (`Spaces: 4`, `UTF-8`, `LF`, and duplicate `watch: fast`).
   - Retain all dynamic, high-value indicators: overall tone dot + label, cursor `Ln X, Col Y` / `Sel N`, language indicator (`C` / `C++`), storage warnings, trash count, and PWA install / update action buttons.
3. **Zero Regression for Mobile & Existing Workflows**:
   - Mobile shell (`isMobile === true`) continues using its dedicated `MobileHeader`, `MobileTabs`, and `MobileMenu`.
   - Preserve all existing keyboard shortcuts (F5 Run, Shift+F5 Stop) and store state subscriptions.
   - All 733+ unit and conformance tests must pass.

### Non-Goals
- Altering the Monaco editor core configuration or keybindings.
- Modifying the mobile-specific UI components or touch ergonomics.
- Changing compiler engine execution semantics or debounce timings.

---

## 2. Architecture & Component Hierarchy

### Component Tree Comparison

#### Previous Desktop Shell:
```tsx
<div className="app">
  <TitleBar />   {/* 30px */}
  <Toolbar />    {/* 34px */}
  <main className="workspace">...</main>
  <StatusBar />  {/* 22px */}
</div>
```

#### Streamlined Desktop Shell:
```tsx
<div className="app">
  <UnifiedHeader />  {/* 38px */}
  <main className="workspace">...</main>
  <StatusBar />      {/* 22px */}
</div>
```

---

## 3. Detailed Component Specifications

### 3.1 UnifiedHeader (`src/ui/UnifiedHeader.tsx`)

#### Layout & Dimensions:
- Fixed height: 38px (`--vs-unified-header-height: 38px`).
- Background: `var(--vs-shell)` with bottom border `1px solid var(--vs-border)`.
- Display: Flexbox (`display: flex; align-items: center; justify-content: space-between; padding: 0 10px; gap: 8px`).

#### Left Group: Branding & Breadcrumb
- Brand Logo: `C+` badge (`background: var(--vs-accent); color: #fff; font-weight: 700; border-radius: 3px; font-size: 11px`).
- Brand Name: `C/C++ Studio` (`font-weight: 600; font-size: 12px`).
- Breadcrumb: Active file path (`host · path`) with subtle muted text styling and ellipsis overflow handling.

#### Center Group: Execution Controls
- **`▶ Run` Button**:
  - Primary button styling (`btn btn--primary` or accent background).
  - Label: `▶ Run` with keyboard shortcut badge `<span className="btn__key">F5</span>`.
  - Disabled when `runState === 'running'`.
- **Engine Selector**:
  - Compact dropdown select attached next to Run button.
  - Options: `Fast Engine (Watch)` and `Clang WASM (Real Build)`.
  - Bound to `useAppStore(state => state.engineId)` and `setEngineId`.
- **`■ Stop` Button**:
  - Standard button styling (`btn btn--stop`).
  - Active/enabled only when `runState === 'running'`, disabled otherwise.
  - Shortcut title: `Shift+F5`.

#### Right Group: Tools & Overflow Menu
- **Inline Values Toggle**:
  - Button with toggled active state when `inlineValues === true`.
  - Toggles variable inline value decorations in Monaco editor.
- **Share Link Button**:
  - Encodes workspace into URL hash and copies to clipboard.
  - Displays transient state: `Share link` -> `Copied` -> `Share link`.
- **Settings Button**:
  - `⚙ Settings` button triggering `SettingsDialog` modal.
- **More Actions Dropdown (`···`)**:
  - Popup menu triggered by clicking `···`.
  - Closes on outside click or item selection.
  - Items:
    1. `⬇ Download .wasm` (disabled unless `artifactsReady === true`).
    2. `⬇ Download .o` (disabled unless `artifactsReady && isTranslationUnit(path)`).
    3. `⌫ Clear console` (calls `clearOutput()`).
    4. Separator divider.
    5. Info item: `Client-only · No backend` pill.

---

### 3.2 Streamlined StatusBar (`src/ui/StatusBar.tsx`)

#### Cleaned Layout:
- Height: 22px (`background: var(--vs-statusbar)`).
- **Left Cluster**:
  - Tone dot: green/yellow/red/blue status indicator.
  - Overall status label (`Ready`, `Analyzing...`, `Running...`).
  - Storage failure warning badge (`⚠ storageWarning`) if active.
  - Execution/watch detail string (`watch.detail`).
  - File trash count badge (`trash: N`) if `trash.length > 0`.
- **Right Cluster**:
  - PWA Reload button (`⟳ Có bản mới — Reload`) when service worker update is ready.
  - PWA Install button (`⬇ Cài đặt app`) when `beforeinstallprompt` event is available.
  - Offline badge (`offline`) when network is disconnected.
  - Cursor position: `Ln {cursor.line}, Col {cursor.column}`.
  - Selection size: `Sel {cursor.selected}` (rendered only when `cursor.selected > 0`).
  - Active language tag: `C` or `C++`.

---

## 4. Styling & CSS Token Integration (`src/ui/theme/app.css`)

1. **Height variable**:
   ```css
   :root {
     --vs-unified-header-height: 38px;
   }
   ```
2. **Unified Header styles**:
   - `.unified-header`: flexbox container, height 38px, clean border-bottom.
   - `.unified-header__brand`, `.unified-header__exec`, `.unified-header__tools`.
   - `.unified-header__menu`: absolute positioned dropdown menu for overflow actions with dark background `var(--vs-panel)`, elevation shadow, and accessible hover states.
3. **Status Bar cleanup**:
   - Removal of unused wide label selectors while preserving responsive and interactive action styling.

---

## 5. Verification & Testing Plan

### 5.1 Unit Tests
1. **`tests/unifiedHeader.test.tsx`**:
   - Verify rendering of brand logo and file path breadcrumb.
   - Verify Run button triggers `run()` and shows F5 badge.
   - Verify Engine selector switches between `fast` and `clang-wasm`.
   - Verify Stop button is disabled when idle, enabled when running.
   - Verify `···` overflow menu toggles, displays download buttons, clear console, and triggers actions.
   - Verify Settings dialog opens when clicking `⚙ Settings`.
2. **`tests/statusBar.test.tsx` / `tests/installPrompt.test.tsx`**:
   - Verify status label, cursor coordinates, and dynamic badges render correctly.
   - Verify PWA install and update prompt flows continue working without regression.
3. **`tests/mobileLayout.test.tsx`**:
   - Verify mobile layout still activates when `isMobile === true` without any regression.

### 5.2 Build & Regression Suite
- Run `npm run typecheck` to verify 0 TypeScript diagnostic errors.
- Run `npm test` to verify all 733+ tests pass cleanly.
- Run `npm run build` to verify production bundle and service worker compile with exit code 0.
