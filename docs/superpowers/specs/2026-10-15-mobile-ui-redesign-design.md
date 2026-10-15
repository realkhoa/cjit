# Design Document: Mobile UI Redesign

**Date**: 2026-10-15  
**Topic**: Modern touch-first mobile interface for C/C++ Studio  
**Status**: Approved by User  

---

## 1. Overview & Goals

C/C++ Studio currently adapts to mobile screens (width <= 880px) by hiding side-by-side splitters and displaying a simple 4-tab bar (`Files`, `Code`, `Watch`, `Output`). However, the mobile experience currently displays the desktop `TitleBar`, a horizontally scrolling desktop `Toolbar` with desktop-centric labels (`▶ Run F5`, `⬇ .wasm`, `⬇ .o`, engine select dropdown), lacks mobile keyboard helpers for C++ syntax, and renders a desktop `StatusBar` that consumes valuable vertical space.

### Goals
1. **Modern Touch-First Mobile Header (`MobileHeader.tsx`)**: Replace `TitleBar` + `Toolbar` on mobile with a compact 48px header featuring active file name, quick engine pill, a prominent green `▶ Run` / red `■ Stop` action button, and an overflow `⋮` menu button.
2. **Overflow Action Sheet (`MobileMenu.tsx`)**: A sleek bottom-sheet modal triggered by `⋮` that groups secondary controls (Engine switcher, Download `.wasm` / `.o`, Share link, Clear console, Settings dialog trigger).
3. **Quick C++ Symbol Accessory Bar (`MobileAccessoryBar.tsx`)**: A horizontal toolbar placed right beneath the editor in the `code` tab providing 1-tap insertion for commonly needed C++ symbols (`Tab`, `{`, `}`, `(`, `)`, `;`, `::`, `->`, `<`, `>`, `"`, `=`).
4. **Enhanced Bottom Navigation Bar (`MobileTabs.tsx`)**: Modern bottom bar with crisp SVG icons (Files, Code, Watch, Output), active pill indicator, pulsing execution/analysis dots, and diagnostic error count badges.
5. **Zero Desktop Regression**: Desktop layout (`isMobile === false`) remains 100% identical and untouched. All existing 733 tests must continue to pass.

### Non-Goals
- Altering desktop Monaco editor keybindings or desktop toolbar layout.
- Introducing multi-touch swipe gesture libraries that could conflict with Monaco's text selection or horizontal scroll.

---

## 2. Architecture & Component Hierarchy

### Mobile Layout Tree (`src/App.tsx` when `isMobile === true`):
```tsx
<div className="app" data-layout="mobile">
  <MobileHeader onOpenMenu={() => setMenuOpen(true)} />

  <main className="workspace workspace--mobile">
    <aside className="pane" data-pane="files" data-active={mobilePane === 'files'}>
      <Explorer />
    </aside>
    <div className="pane pane--editor" data-pane="code" data-active={mobilePane === 'code'}>
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

  {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
</div>
```

---

## 3. Component Details

### 3.1 MobileHeader (`src/ui/MobileHeader.tsx`)
- **Height**: 48px, background `var(--vs-panel)`.
- **Left**:
  - Active file name (e.g. `main.cpp`) with monospace font and truncation.
  - Engine badge button: Clicking toggles between `fast` and `clang` or opens the menu.
- **Right**:
  - Primary Action Button:
    - Normal: Green button with `▶ Run` icon/label (touch target >= 44px).
    - Running: Red button with `■ Stop` icon/label with pulsing animation.
  - Overflow Menu Button: `⋮` icon (touch target 44x44px).

### 3.2 MobileMenu Bottom Sheet (`src/ui/MobileMenu.tsx`)
- Slide-up bottom sheet with backdrop overlay (`rgba(0, 0, 0, 0.6)`).
- Top drag handle pill.
- Menu sections:
  1. **Compiler Engine**: Segmented control or radio selector between `Fast Engine (Watch)` and `Clang WASM (Real Build)`.
  2. **Artifacts**: Buttons to download `.wasm` and `.o` files (active only when build artifacts are ready).
  3. **Share & Reset**: Copy shareable URL, Clear console output.
  4. **Preferences**: Trigger `SettingsDialog`.

### 3.3 MobileAccessoryBar (`src/ui/MobileAccessoryBar.tsx`)
- Fixed horizontal strip placed below the Monaco editor instance (or docked at the bottom of the editor pane).
- Horizontally scrollable list of key chips:
  - `Tab`, `{`, `}`, `(`, `)`, `;`, `::`, `->`, `<`, `>`, `"`, `=`, `&`, `*`, `!`
- Insertion Mechanism:
  - Accesses Monaco Editor instance via Monaco API or store callback.
  - Inserts the string at current selection using `editor.executeEdits('mobile-keys', [{ range: selection, text, forceMoveMarkers: true }])`.
  - Re-focuses editor smoothly.

### 3.4 Enhanced MobileTabs (`src/ui/MobileTabs.tsx`)
- Replaces text-only buttons with standard SVG icon + label pairs:
  - **Files**: Folder SVG icon + file count badge.
  - **Code**: Code brackets / file-code SVG icon + running dot badge.
  - **Watch**: Magnifying glass / pulse line SVG icon + analyzing dot.
  - **Output**: Terminal SVG icon + diagnostic error badge.
- Touch target: 54px total height, padding for `env(safe-area-inset-bottom, 0px)`.
- Active state: Rounded pill background with `var(--vs-accent)` subtle tint and crisp white icon.

---

## 4. CSS & Design System Polish (`src/ui/theme/app.css`)

1. **Scoped Mobile Rules**: All new styles scoped under `.app[data-layout="mobile"]` or `@media (max-width: 880px)`.
2. **Safe Area Insets**:
   - `padding-top: env(safe-area-inset-top, 0px)` on `MobileHeader`.
   - `padding-bottom: env(safe-area-inset-bottom, 0px)` on `MobileTabs` and `MobileMenu`.
3. **Touch Ergonomics**:
   - Touch targets >= 44px x 44px for all interactive elements.
   - `-webkit-tap-highlight-color: transparent`.
   - `touch-action: manipulation` on buttons to prevent double-tap delay.

---

## 5. Verification & Testing Plan

1. **Unit Tests**:
   - `tests/mobileHeader.test.tsx`: Verify rendering of active file name, Run/Stop toggling, engine pill, and menu opening.
   - `tests/mobileAccessoryBar.test.tsx`: Verify key rendering and text insertion.
   - `tests/mobileTabs.test.tsx`: Verify active tab state, icon presence, badge indicators.
   - `tests/mobileLayout.test.tsx`: Verify full mobile layout tree rendering and regression safety.
2. **Regression Gate**:
   - Run `npm run typecheck` (0 errors).
   - Run `npm test` (All 733+ tests pass).
   - Run `npm run build` (Clean production bundle build).
