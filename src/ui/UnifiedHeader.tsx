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
 * @brief Custom hook to detect clicks outside of a referenced element.
 * @param ref React ref object referencing the target DOM element.
 * @param onOutsideClick Callback invoked when a click occurs outside the ref element.
 * @return void
 */
function useOutsideClick(
  ref: React.RefObject<HTMLElement | null>,
  onOutsideClick: () => void,
): void {
  useEffect(() => {
    /**
     * @brief Event listener for mousedown to trigger outside click handler.
     * @param event The mouse event.
     * @return void
     */
    const handleMousedown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutsideClick();
      }
    };
    document.addEventListener('mousedown', handleMousedown);
    return () => {
      document.removeEventListener('mousedown', handleMousedown);
    };
  }, [ref, onOutsideClick]);
}

interface UnifiedBrandProps {
  path: string;
}

/**
 * @brief Renders the brand logo, title, and current file path breadcrumb.
 * @param props Component properties containing the active file path.
 * @return Rendered brand section element.
 */
function UnifiedBrand(props: UnifiedBrandProps): JSX.Element {
  return (
    <div className="unified-header__brand">
      <span className="unified-header__logo" aria-hidden="true">C+</span>
      <span className="unified-header__title">C/C++ Studio</span>
      <span className="unified-header__path" title={`${hostLabel()} · ${props.path}`}>
        · {props.path}
      </span>
    </div>
  );
}

interface UnifiedExecProps {
  running: boolean;
  engineId: EngineId;
  onRun: () => void;
  onStop: () => void;
  onSelectEngine: (engine: EngineId) => void;
}

/**
 * @brief Renders execution controls including run button, engine selector, and stop button.
 * @param props Component properties containing execution states and handlers.
 * @return Rendered execution controls section.
 */
function UnifiedExec(props: UnifiedExecProps): JSX.Element {
  return (
    <div className="unified-header__exec">
      <button
        type="button"
        className="btn btn--primary"
        onClick={props.onRun}
        disabled={props.running}
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
        value={props.engineId}
        onChange={(event) => props.onSelectEngine(event.target.value as EngineId)}
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
        onClick={props.onStop}
        disabled={!props.running}
        title="Dừng chương trình đang chạy (Shift+F5)"
      >
        ■ Stop
      </button>
    </div>
  );
}

interface UnifiedOverflowMenuProps {
  artifactsReady: boolean;
  path: string;
  onDownloadWasm: () => void;
  onDownloadObject: () => void;
  onClearOutput: () => void;
}

/**
 * @brief Renders the overflow action popup menu.
 * @param props Component properties containing artifact status and action callbacks.
 * @return Rendered overflow menu element.
 */
function UnifiedOverflowMenu(props: UnifiedOverflowMenuProps): JSX.Element {
  return (
    <div className="unified-header__menu" role="menu">
      <button
        type="button"
        className="unified-header__menu-item"
        disabled={!props.artifactsReady}
        onClick={props.onDownloadWasm}
        title="Tải file .wasm (chỉ bật sau khi Run thành công)"
      >
        ⬇ Tải .wasm
      </button>
      <button
        type="button"
        className="unified-header__menu-item"
        disabled={!props.artifactsReady || !isTranslationUnit(props.path)}
        onClick={props.onDownloadObject}
        title={
          isTranslationUnit(props.path)
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
        onClick={props.onClearOutput}
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
  );
}

interface UnifiedOverflowDropdownProps {
  path: string;
}

/**
 * @brief Renders the overflow dropdown trigger button and manages outside clicks.
 * @param props Component properties containing the active file path.
 * @return Rendered overflow dropdown element.
 */
function UnifiedOverflowDropdown(props: UnifiedOverflowDropdownProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const artifactsReady = useAppStore((state) => state.artifactsReady);
  const downloadArtifact = useAppStore((state) => state.downloadArtifact);
  const clearOutput = useAppStore((state) => state.clearOutput);

  useOutsideClick(menuRef, () => setMenuOpen(false));

  return (
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
        <UnifiedOverflowMenu
          artifactsReady={artifactsReady}
          path={props.path}
          onDownloadWasm={() => {
            setMenuOpen(false);
            void downloadArtifact('wasm');
          }}
          onDownloadObject={() => {
            setMenuOpen(false);
            void downloadArtifact('object');
          }}
          onClearOutput={() => {
            setMenuOpen(false);
            clearOutput();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * @brief Renders the workspace share button with feedback state.
 * @return Rendered share button element.
 */
function UnifiedShareButton(): JSX.Element {
  const shareLink = useAppStore((state) => state.shareLink);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /**
   * @brief Handles workspace sharing by generating and copying the encoded URL.
   * @return void
   */
  const handleShare = (): void => {
    void shareLink().then((outcome) => {
      setShareState(outcome.ok ? 'copied' : 'failed');
      setTimeout(() => setShareState('idle'), 2500);
    });
  };

  return (
    <button
      type="button"
      className={shareState === 'copied' ? 'btn btn--toggled' : 'btn'}
      onClick={handleShare}
      title="Copy link chia sẻ toàn bộ workspace (mã hoá trong URL, không gửi lên server)"
    >
      {shareState === 'copied' ? 'Link copied' : shareState === 'failed' ? 'Link too long' : 'Share link'}
    </button>
  );
}

interface UnifiedToolsProps {
  path: string;
}

/**
 * @brief Renders the right-hand workspace tools and overflow actions dropdown.
 * @param props Component properties containing the active file path.
 * @return Rendered tools section element.
 */
function UnifiedTools(props: UnifiedToolsProps): JSX.Element {
  const inlineValues = useAppStore((state) => state.settings.inlineValues);
  const toggleInlineValues = useAppStore((state) => state.toggleInlineValues);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
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
      <UnifiedShareButton />
      <button
        type="button"
        className={settingsOpen ? 'btn btn--toggled' : 'btn'}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-expanded={settingsOpen}
        title="Cài đặt cấu hình editor"
      >
        ⚙ Settings
      </button>
      <UnifiedOverflowDropdown path={props.path} />
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
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
  const setEngineId = useAppStore((state) => state.setEngineId);

  return (
    <header className="unified-header">
      <UnifiedBrand path={path} />
      <UnifiedExec
        running={runState === 'running'}
        engineId={engineId}
        onRun={() => void run()}
        onStop={stop}
        onSelectEngine={setEngineId}
      />
      <UnifiedTools path={path} />
    </header>
  );
}
