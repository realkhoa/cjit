import { useState } from 'react';
import { useAppStore } from '@/state/store';
import { ENGINE_ORDER, getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';
import { isTranslationUnit } from '@/lang/clang/runtime';
import { SettingsDialog } from '@/ui/SettingsDialog';

/**
 * @brief Properties for the MobileMenu component.
 */
export interface MobileMenuProps {
  /** Callback fired when the bottom sheet should close. */
  readonly onClose: () => void;
}

/**
 * @brief Bottom-sheet overflow menu for mobile viewports.
 * @details Groups engine switching, artifact downloads, share link, clear output,
 * and application settings into a convenient touch modal.
 *
 * @param props Component properties containing the close callback.
 * @return Mobile bottom sheet JSX element.
 */
export function MobileMenu(props: MobileMenuProps) {
  const { onClose } = props;
  const engineId = useAppStore((state) => state.engineId);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const artifactsReady = useAppStore((state) => state.artifactsReady);
  const downloadArtifact = useAppStore((state) => state.downloadArtifact);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const shareLink = useAppStore((state) => state.shareLink);
  const path = useAppStore((state) => state.path);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  /**
   * @brief Generates and copies a project share link to the clipboard.
   */
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
