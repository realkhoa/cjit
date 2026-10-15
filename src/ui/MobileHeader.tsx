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
 * @brief Compact top bar for mobile viewports.
 * @details Displays the current file name, an engine switch pill, a prominent Run/Stop
 * touch button, and an overflow menu button.
 *
 * @param props Component properties containing the menu toggle handler.
 * @return Mobile header JSX element.
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

  /**
   * @brief Toggles between 'fast' and 'clang-wasm' compiler engines.
   */
  const toggleEngine = () => {
    const nextEngine: EngineId = engineId === 'fast' ? 'clang-wasm' : 'fast';
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
