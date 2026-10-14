import { useState } from 'react';
import { MAX_DEBOUNCE_MS, MAX_FONT_SIZE, MIN_DEBOUNCE_MS, MIN_FONT_SIZE } from '@/state/settings';
import { useAppStore } from '@/state/store';

/**
 * Settings dialog. Small on purpose: everything here is something the editor
 * genuinely applies immediately, and everything is persisted with the workspace.
 */
export function SettingsDialog({ onClose }: { readonly onClose: () => void }) {
  const settings = useAppStore((state) => state.settings);
  const setFontSize = useAppStore((state) => state.setFontSize);
  const setDebounceMs = useAppStore((state) => state.setDebounceMs);
  const toggleMinimap = useAppStore((state) => state.toggleMinimap);
  const toggleInlineValues = useAppStore((state) => state.toggleInlineValues);
  const resetWorkspace = useAppStore((state) => state.resetWorkspace);
  const files = useAppStore((state) => state.files);

  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div className="modal modal--settings" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">Settings</span>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal__body">
          <label className="setting">
            <span className="setting__label">Editor font size</span>
            <input
              type="range"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={1}
              value={settings.fontSize}
              onChange={(event) => setFontSize(Number.parseInt(event.target.value, 10))}
            />
            <span className="setting__value">{settings.fontSize}px</span>
          </label>

          <label className="setting">
            <span className="setting__label">Watch debounce</span>
            <input
              type="range"
              min={MIN_DEBOUNCE_MS}
              max={MAX_DEBOUNCE_MS}
              step={100}
              value={settings.debounceMs}
              onChange={(event) => setDebounceMs(Number.parseInt(event.target.value, 10))}
            />
            <span className="setting__value">{settings.debounceMs} ms</span>
          </label>

          <label className="setting setting--check">
            <input type="checkbox" checked={settings.minimap} onChange={toggleMinimap} />
            <span className="setting__label">Show minimap</span>
          </label>

          <label className="setting setting--check">
            <input type="checkbox" checked={settings.inlineValues} onChange={toggleInlineValues} />
            <span className="setting__label">Inline values after each executed line</span>
          </label>

          <div className="setting setting--stacked">
            <span className="setting__label">Workspace</span>
            <span className="setting__hint">
              {files.length} file{files.length === 1 ? '' : 's'} · lưu tự động trong browser
              (localStorage), không gửi đi đâu cả.
            </span>
            {confirmReset ? (
              <span className="setting__actions">
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    resetWorkspace();
                    setConfirmReset(false);
                  }}
                >
                  Xoá hết và về ví dụ mặc định
                </button>
                <button type="button" className="btn" onClick={() => setConfirmReset(false)}>
                  Huỷ
                </button>
              </span>
            ) : (
              <span className="setting__actions">
                <button type="button" className="btn" onClick={() => setConfirmReset(true)}>
                  Reset workspace…
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="modal__footer">
          Mọi thay đổi áp dụng ngay và được lưu cùng workspace. Nhấn Ctrl+Shift+P để mở command
          palette.
        </div>
      </div>
    </div>
  );
}
